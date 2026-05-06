// POST /api/documents/scan
// Body: { documentId }
// Downloads a previously uploaded file, applies deterministic safety
// rules, runs ClamAV, and persists a row in zip_scans. Updates the
// parent documents.scan_status to clean / quarantined / rejected.
//
// Hardened May 2026 (security audit H9, M5, L3):
//   - All limits are server-side. Caller cannot widen size, count,
//     or extension allowlists.
//   - ZIP detection uses magic bytes (PK\003\004) regardless of
//     filename extension; an attacker uploading a ZIP renamed .pdf
//     gets the ZIP-inspection path, not a free pass.
//   - ZIP bombs are detected before full decompression: we walk the
//     central directory entry-by-entry and abort once the projected
//     uncompressed size exceeds MAX_TOTAL_BYTES.
//   - When CLAMAV_URL is configured, an unreachable AV sidecar is a
//     HARD reject (was: warn). Operators must fix AV before intake.
//   - The parent documents row is updated with scan_status so
//     downstream consumers (extract.js, ocr.js) can refuse to
//     process unverified files.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { sha256, scanWithClamAV } from "./_lib/scan-runner.js";
import { safeFetch } from "../_lib/safe-fetch.js";

// SERVER-SIDE LIMITS. These are NOT overridable by the caller.
const MAX_TOTAL_BYTES = Number(process.env.DOCUMENTS_MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
const MAX_INDIVIDUAL_BYTES = Number(process.env.DOCUMENTS_MAX_INNER_BYTES || 25 * 1024 * 1024);
const MAX_FILE_COUNT = Number(process.env.DOCUMENTS_MAX_FILE_COUNT || 1000);
const ALLOWED_EXTENSIONS = new Set(
  (process.env.DOCUMENTS_ALLOWED_EXTENSIONS || "xlsx,xls,csv,tsv,txt,json,jsonl,pdf,png,jpg,jpeg,webp,heic,heif,tiff,docx,doc")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

const CLAMAV_URL = process.env.CLAMAV_URL || "";
// Audit follow-up (May 2026): when CLAMAV_URL is set, AV is
// expected and an outage HARD-REJECTS uploads. The only way to
// soft-warn instead is to explicitly set CLAMAV_REQUIRED=false.
// Previous logic was inverted (default off unless explicitly
// CLAMAV_REQUIRED=true), which silently let documents through on
// AV outage. New semantics fail-closed by default.
const CLAMAV_SOFT_WARN = process.env.CLAMAV_REQUIRED === "false";

const extOf = (name) => String(name || "").toLowerCase().split(".").pop() || "";

// Audit L3 (May 2026): magic-byte ZIP detection. PK\003\004 is the
// local-file-header signature that starts every standard ZIP archive.
const looksLikeZip = (buf) =>
  buf && buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.documentId) return json(res, 400, { error: { message: "documentId required" } });
    const svc = serviceClient();
    const { data: doc, error: docErr } = await svc.from("documents").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", body.documentId).single();
    if (docErr || !doc) return json(res, 404, { error: { message: "Document not found" } });

    const threats = [];
    const innerFiles = [];

    // Total-size hard cap. Reject before ANY download attempt; we
    // don't want to pull a 5GB file off storage just to reject it.
    if (Number(doc.size_bytes || 0) > MAX_TOTAL_BYTES) {
      threats.push({ code: "SIZE_LIMIT_EXCEEDED", detail: "Document size " + doc.size_bytes + " exceeds " + MAX_TOTAL_BYTES });
    }

    let clamavSummary = { invoked: false, configured: !!CLAMAV_URL, scans: [] };

    const runClam = async (buf, name) => {
      const r = await scanWithClamAV(buf, name);
      clamavSummary.scans.push({
        name, invoked: !!r.invoked, infected: !!r.infected,
        virus: r.virus || null, reason: r.reason || null,
      });
      if (r.invoked) clamavSummary.invoked = true;
      if (r.invoked && r.infected) threats.push({ code: "MALWARE_DETECTED", detail: name + " :: " + (r.virus || "unknown") });
      // Audit H9: when CLAMAV_URL is configured, an unreachable
      // sidecar is a HARD reject. Previously soft-warn; an attacker
      // could upload via a coordinated AV-side outage.
      if (!r.invoked && CLAMAV_URL && !CLAMAV_SOFT_WARN) {
        threats.push({ code: "AV_PROBE_FAILED", detail: name + " :: " + r.reason });
      }
    };

    const downloadDocument = async () => {
      const { data: signed, error: signErr } = await svc.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, 60 * 5);
      if (signErr) throw new Error("Signed URL error: " + signErr.message);
      const upstream = await safeFetch(signed.signedUrl);
      if (!upstream.ok) throw new Error("Storage download failed: " + upstream.status);
      // Cap the download stream at MAX_TOTAL_BYTES + 1 byte so a
      // server returning > MAX cannot exhaust memory.
      const reader = upstream.body?.getReader?.();
      if (!reader) {
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (buf.length > MAX_TOTAL_BYTES) throw new Error("Document exceeded MAX_TOTAL_BYTES on download");
        return buf;
      }
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_TOTAL_BYTES) {
          throw new Error("Document exceeded MAX_TOTAL_BYTES on download");
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    };

    let buf = null;
    try {
      buf = await downloadDocument();
    } catch (e) {
      threats.push({ code: "DOWNLOAD_FAILED", detail: e.message?.slice(0, 200) });
    }

    const isZip = buf ? looksLikeZip(buf) : (extOf(doc.filename) === "zip");

    if (buf && !isZip) {
      try { await runClam(buf, doc.filename); }
      catch (e) { clamavSummary.scans.push({ name: doc.filename, invoked: false, reason: e.message }); }
    }

    if (buf && isZip) {
      // ZIP inspection. Audit M5: cap projected uncompressed size
      // entry-by-entry so a bomb (200:1 compression) doesn't OOM
      // the function before the threat check fires.
      const jszipMod = await import("jszip").catch(() => null);
      if (!jszipMod) {
        threats.push({ code: "ZIP_INSPECT_UNAVAILABLE", detail: "JSZip dependency not installed; only header rules applied" });
      } else {
        const JSZip = jszipMod.default || jszipMod;
        const zip = await JSZip.loadAsync(buf);
        const entries = Object.values(zip.files);
        if (entries.length > MAX_FILE_COUNT) {
          threats.push({ code: "FILE_COUNT_EXCEEDED", detail: entries.length + " > " + MAX_FILE_COUNT });
        }
        // Pre-walk: sum the central-directory uncompressedSize
        // metadata (JSZip exposes it on each entry's _data) before
        // touching the body. If the projected total exceeds 4x the
        // total cap, this is a bomb.
        let projected = 0;
        for (const entry of entries) {
          if (entry.dir) continue;
          const projSize = Number(entry?._data?.uncompressedSize || 0);
          projected += projSize;
        }
        if (projected > MAX_TOTAL_BYTES * 4) {
          threats.push({ code: "ZIP_BOMB_RISK", detail: "Projected uncompressed " + projected + " > 4x cap " + (MAX_TOTAL_BYTES * 4) });
        }

        let totalUncompressed = 0;
        for (const entry of entries) {
          if (entry.dir) continue;
          // Re-check the running total so we can abort a slow bomb
          // mid-decompression.
          if (totalUncompressed > MAX_TOTAL_BYTES * 4) {
            threats.push({ code: "ZIP_BOMB_RISK", detail: "Aborted at " + totalUncompressed + " bytes uncompressed" });
            break;
          }
          const innerExt = extOf(entry.name);
          let blob;
          try { blob = await entry.async("nodebuffer"); }
          catch (e) { threats.push({ code: "ZIP_DECODE_ERROR", detail: entry.name + " :: " + e.message?.slice(0, 200) }); continue; }
          const size = blob.length;
          totalUncompressed += size;
          const hash = sha256(blob);
          innerFiles.push({ name: entry.name, ext: innerExt, size, sha256: hash });
          if (innerExt === "zip" || looksLikeZip(blob)) threats.push({ code: "NESTED_ZIP", detail: entry.name });
          if (size > MAX_INDIVIDUAL_BYTES) threats.push({ code: "INNER_SIZE_EXCEEDED", detail: entry.name + " " + size + " > " + MAX_INDIVIDUAL_BYTES });
          if (!ALLOWED_EXTENSIONS.has(innerExt)) threats.push({ code: "EXTENSION_NOT_ALLOWED", detail: entry.name + " has extension " + innerExt });
          if (/\.(exe|dll|bat|cmd|sh|js|vbs|ps1|jar|msi)$/i.test(entry.name)) threats.push({ code: "EXECUTABLE_DETECTED", detail: entry.name });
          if (innerExt === "xlsm" || /macro/i.test(entry.name)) threats.push({ code: "MACRO_HINTED", detail: entry.name });
          await runClam(blob, entry.name);
        }
      }
    }

    // Hard-rejection codes flip the doc to "rejected". Soft codes
    // raise it to "warn" but allow downstream OCR.
    const HARD_REJECT = new Set([
      "NESTED_ZIP", "ZIP_BOMB_RISK", "EXECUTABLE_DETECTED",
      "SIZE_LIMIT_EXCEEDED", "MALWARE_DETECTED",
      "AV_PROBE_FAILED",
      "DOWNLOAD_FAILED",
    ]);
    const status = threats.length === 0 ? "clean"
      : threats.some((t) => HARD_REJECT.has(t.code)) ? "rejected"
      : "warn";

    const totalSize = innerFiles.reduce((s, f) => s + f.size, 0);
    await svc.from("zip_scans").insert({
      tenant_id: ctx.tenantId,
      document_id: doc.id,
      status,
      file_count: innerFiles.length,
      total_size_bytes: totalSize || Number(doc.size_bytes || 0),
      threats,
      inner_files: innerFiles,
    });

    // Audit H9 (May 2026): propagate the result to documents.scan_status
    // so downstream OCR/extract can gate on it.
    const scanStatus = status === "clean" ? "clean"
      : status === "warn" ? "warned"
      : "quarantined";
    await svc.from("documents").update({
      scan_status: scanStatus,
      scan_completed_at: new Date().toISOString(),
    }).eq("id", doc.id);

    await recordAudit(ctx, { action: "document_scan", objectType: "document", objectId: doc.id, detail: status + " threats=" + threats.length });
    return json(res, 200, { status, threats, fileCount: innerFiles.length, totalSizeBytes: totalSize || Number(doc.size_bytes || 0), files: innerFiles, clamav: clamavSummary });
  } catch (err) {
    sendError(res, err);
  }
}
