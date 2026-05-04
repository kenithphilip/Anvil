// POST /api/documents/scan
// Body: { documentId, maxFileBytes?, maxFileCount?, allowedExtensions? }
// Downloads a previously uploaded file, applies deterministic safety rules, and persists
// a row in zip_scans. Returns { status, threats, fileCount, totalSizeBytes, files }.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { sha256, scanWithClamAV } from "./_lib/scan-runner.js";

const DEFAULT_MAX_TOTAL = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE = 25 * 1024 * 1024;
const DEFAULT_MAX_COUNT = 1000;
const DEFAULT_EXTENSIONS = new Set(["xlsx", "xls", "csv", "tsv", "txt", "json", "jsonl", "pdf", "png", "jpg", "jpeg", "webp"]);

const extOf = (name) => String(name || "").toLowerCase().split(".").pop() || "";

const CLAMAV_URL = process.env.CLAMAV_URL || "";

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
    const { data: doc, error: docErr } = await svc.from("documents").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.documentId).single();
    if (docErr || !doc) return json(res, 404, { error: { message: "Document not found" } });
    const maxTotal = Number(body.maxTotalBytes || body.maxFileBytes || DEFAULT_MAX_TOTAL);
    const maxFile = Number(body.maxIndividualBytes || body.maxFileBytes || DEFAULT_MAX_FILE);
    const maxCount = Number(body.maxFileCount || DEFAULT_MAX_COUNT);
    const extWhitelist = body.allowedExtensions ? new Set(body.allowedExtensions.map((e) => String(e).toLowerCase())) : DEFAULT_EXTENSIONS;
    const ext = extOf(doc.filename);
    const threats = [];
    const innerFiles = [];

    if (Number(doc.size_bytes || 0) > maxTotal) {
      threats.push({ code: "SIZE_LIMIT_EXCEEDED", detail: "Document size " + doc.size_bytes + " exceeds " + maxTotal });
    }
    let clamavSummary = { invoked: false, configured: !!CLAMAV_URL, scans: [] };
    const runClam = async (buf, name) => {
      const r = await scanWithClamAV(buf, name);
      clamavSummary.scans.push({
        name,
        invoked: !!r.invoked,
        infected: !!r.infected,
        virus: r.virus || null,
        reason: r.reason || null,
      });
      if (r.invoked) clamavSummary.invoked = true;
      if (r && r.invoked && r.infected) threats.push({ code: "MALWARE_DETECTED", detail: name + " :: " + (r.virus || "unknown") });
      if (!r.invoked && CLAMAV_URL) {
        // AV is configured but we could not reach it. Surface as a warning,
        // never a rejection: we don't want a flaky AV sidecar to bring intake
        // down. The dock + diagnostics already report the integration state.
        threats.push({ code: "AV_PROBE_FAILED", detail: name + " :: " + r.reason });
      }
    };
    if (ext !== "zip") {
      try {
        const { data: signed, error: signErr } = await svc.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, 60 * 5);
        if (!signErr && signed) {
          const upstream = await fetch(signed.signedUrl);
          if (upstream.ok) {
            const buf = Buffer.from(await upstream.arrayBuffer());
            await runClam(buf, doc.filename);
          }
        }
      } catch (e) {
        clamavSummary.scans.push({ name: doc.filename, invoked: false, reason: e.message });
      }
    }
    if (ext === "zip") {
      // Need JSZip for nested inspection. Lazy require so the function still works
      // for non-ZIP artifacts without bundling JSZip into every cold start.
      const jszipMod = await import("jszip").catch(() => null);
      if (!jszipMod) {
        threats.push({ code: "ZIP_INSPECT_UNAVAILABLE", detail: "JSZip dependency not installed in backend; only header rules applied" });
      } else {
        const JSZip = jszipMod.default || jszipMod;
        const { data: signed, error: signErr } = await svc.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, 60 * 5);
        if (signErr) throw new Error("Signed URL error: " + signErr.message);
        const upstream = await fetch(signed.signedUrl);
        if (!upstream.ok) throw new Error("Storage download failed: " + upstream.status);
        const buf = Buffer.from(await upstream.arrayBuffer());
        const zip = await JSZip.loadAsync(buf);
        const entries = Object.values(zip.files);
        if (entries.length > maxCount) threats.push({ code: "FILE_COUNT_EXCEEDED", detail: entries.length + " > " + maxCount });
        let totalUncompressed = 0;
        for (const entry of entries) {
          if (entry.dir) continue;
          const innerExt = extOf(entry.name);
          const blob = await entry.async("nodebuffer");
          const size = blob.length;
          totalUncompressed += size;
          const hash = sha256(blob);
          innerFiles.push({ name: entry.name, ext: innerExt, size, sha256: hash });
          if (innerExt === "zip") threats.push({ code: "NESTED_ZIP", detail: entry.name });
          if (size > maxFile) threats.push({ code: "INNER_SIZE_EXCEEDED", detail: entry.name + " " + size + " > " + maxFile });
          if (!extWhitelist.has(innerExt)) threats.push({ code: "EXTENSION_NOT_ALLOWED", detail: entry.name + " has extension " + innerExt });
          if (/\.(exe|dll|bat|cmd|sh|js|vbs|ps1|jar|msi)$/i.test(entry.name)) threats.push({ code: "EXECUTABLE_DETECTED", detail: entry.name });
          if (innerExt === "xlsm" || /macro/i.test(entry.name)) threats.push({ code: "MACRO_HINTED", detail: entry.name });
          await runClam(blob, entry.name);
        }
        if (totalUncompressed > maxTotal * 4) threats.push({ code: "ZIP_BOMB_RISK", detail: "Uncompressed size " + totalUncompressed + " is more than 4x cap" });
      }
    }
    // Hard-rejection codes flip the doc to "rejected". Soft codes
    // (extension warning, macro hint, AV reachability issues, file count
    // overrun) only raise it to "warn"; the doc still moves through OCR.
    const HARD_REJECT = new Set([
      "NESTED_ZIP", "ZIP_BOMB_RISK", "EXECUTABLE_DETECTED",
      "SIZE_LIMIT_EXCEEDED", "MALWARE_DETECTED",
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
    await recordAudit(ctx, { action: "document_scan", objectType: "document", objectId: doc.id, detail: status + " threats=" + threats.length });
    return json(res, 200, { status, threats, fileCount: innerFiles.length, totalSizeBytes: totalSize || Number(doc.size_bytes || 0), files: innerFiles, clamav: clamavSummary });
  } catch (err) {
    sendError(res, err);
  }
}
