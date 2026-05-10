// POST /api/documents/ocr
// Body: { documentId, orderId? }
// Downloads the document via signed URL, runs Mistral OCR, persists evidence rows,
// and (if orderId is supplied) attaches the highest-confidence matches to that order.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { ocrDocument } from "../_lib/mistral.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const isPdfMime = (mime) => /pdf/i.test(mime || "");
const isImageMime = (mime) => /^image\//i.test(mime || "");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  let runId = null;
  let ctx = null;
  try {
    ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.documentId) return json(res, 400, { error: { message: "documentId required" } });
    const svc = serviceClient();
    const { data: doc, error: docErr } = await svc.from("documents").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.documentId).single();
    if (docErr || !doc) return json(res, 404, { error: { message: "Document not found" } });
    // Audit L4 (May 2026): generic message; never echo internal
    // mime_type back to the client.
    if (!isPdfMime(doc.mime_type) && !isImageMime(doc.mime_type)) {
      return json(res, 400, { error: { code: "UNSUPPORTED_MIME", message: "OCR currently supports PDFs and images only." } });
    }
    // Audit H9 + follow-up (May 2026): refuse to OCR documents
    // whose ClamAV / ZIP scan has not been run or has been
    // quarantined. The follow-up audit caught that the migration
    // 059 backfill default `'unverified'` was bypassing this gate;
    // we now treat unverified as not-yet-scanned.
    if (doc.scan_status === "quarantined" || doc.scan_status === "rejected") {
      return json(res, 409, { error: { code: "DOCUMENT_QUARANTINED", message: "Document failed scan; cannot OCR." } });
    }
    if (doc.scan_status === "pending" || doc.scan_status === "unverified" || !doc.scan_status) {
      return json(res, 409, { error: { code: "DOCUMENT_NOT_SCANNED", message: "Document must be scanned before OCR. Run /api/documents/scan first." } });
    }
    const { data: signed, error: signErr } = await svc.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, 60 * 5);
    if (signErr) {
      const msg = String(signErr.message || "");
      const friendly = /not.*exist|not.*found|404/i.test(msg)
        ? "Document storage bucket `" + doc.storage_bucket + "` not found. The document may have been moved; ask an admin to verify Supabase Storage."
        : "Signed URL error: " + msg;
      throw new Error(friendly);
    }
    const { data: runRow, error: runErr } = await svc.from("ocr_runs").insert({
      tenant_id: ctx.tenantId,
      document_id: doc.id,
      provider: "mistral",
      status: "running",
    }).select("id").single();
    if (runErr) throw new Error("OCR run insert: " + runErr.message);
    runId = runRow.id;
    const upstream = await safeFetch(signed.signedUrl);
    if (!upstream.ok) throw new Error("Storage download failed: " + upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    const ocrResult = await ocrDocument({ buffer: buf, filename: doc.filename, mimeType: doc.mime_type });
    const evidenceRows = [];
    let evidenceTotal = 0;
    ocrResult.pages.forEach((page) => {
      page.blocks.forEach((block, blockIdx) => {
        if (!block.text || block.text.length < 2) return;
        evidenceTotal++;
        evidenceRows.push({
          tenant_id: ctx.tenantId,
          order_id: body.orderId || null,
          field_path: "ocr.page[" + page.index + "].block[" + blockIdx + "]",
          value: block.text.slice(0, 1024),
          document_id: doc.id,
          page_number: page.index,
          bbox: block.bbox ? { x0: block.bbox[0], y0: block.bbox[1], x1: block.bbox[2], y1: block.bbox[3], page_width: page.width, page_height: page.height } : null,
          snippet: block.text.slice(0, 4000),
          extraction_method: "mistral_ocr",
          confidence: block.confidence != null ? block.confidence : null,
          validator_status: "captured",
        });
      });
    });
    if (evidenceRows.length) {
      // Insert in chunks to stay under request size limits.
      const chunkSize = 500;
      for (let i = 0; i < evidenceRows.length; i += chunkSize) {
        const slice = evidenceRows.slice(i, i + chunkSize);
        const { error: evErr } = await svc.from("evidence").insert(slice);
        if (evErr) throw new Error("Evidence insert: " + evErr.message);
      }
    }
    await svc.from("ocr_runs").update({
      status: "completed",
      page_count: ocrResult.pages.length,
      evidence_count: evidenceTotal,
      completed_at: new Date().toISOString(),
      raw: { model: ocrResult.model, page_count: ocrResult.pages.length },
    }).eq("id", runId);
    if (body.orderId) {
      await recordEvent(ctx, { caseId: body.orderId, eventType: "ocr_completed", objectType: "document", objectId: doc.id, detail: { pages: ocrResult.pages.length, blocks: evidenceTotal } });
    }
    // Standalone document-scoped OCR runs (no orderId) write
    // evidence rows with order_id = null. Migration 077 relaxed the
    // NOT NULL constraint so this works; previously these inserts
    // would have raised a constraint violation. The documents-detail
    // bbox-overlay screen drives this code path.
    await recordAudit(ctx, { action: "ocr_run", objectType: "document", objectId: doc.id, detail: "pages=" + ocrResult.pages.length + " blocks=" + evidenceTotal });
    return json(res, 200, { runId, pageCount: ocrResult.pages.length, evidenceCount: evidenceTotal, pages: ocrResult.pages.map((p) => ({ index: p.index, width: p.width, height: p.height, blockCount: p.blocks.length })) });
  } catch (err) {
    if (runId && ctx) {
      try {
        const updateRes = await serviceClient().from("ocr_runs").update({
          status: "failed",
          error: String(err.message || err).slice(0, 1000),
          completed_at: new Date().toISOString(),
        }).eq("id", runId);
        if (updateRes.error) {
          // eslint-disable-next-line no-console
          console.error("[documents/ocr] failed-status update failed for run " + runId + ": " + updateRes.error.message);
        }
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error("[documents/ocr] failed-status update threw for run " + runId + ": " + (logErr.message || logErr));
      }
    }
    // Bug fix May 2026: OCR failures only updated ocr_runs.status and
    // returned the error to the caller. Nothing wrote a
    // processing_event keyed to the order, so the workspace's
    // Activity stream had no breadcrumb of the failure and orders
    // sat in DRAFT looking healthy. Surface the failure so the
    // operator sees it in the timeline.
    if (ctx) {
      try {
        // We need the body again for orderId; re-parse defensively.
        // If body parsing fails or the caller didn't send orderId,
        // we still write a tenant-scoped event without case_id so
        // the failure is at least visible in the global processing-
        // events feed.
        let orderId = null;
        try {
          const reparsed = await readBody(req);
          orderId = reparsed?.orderId || null;
        } catch (_) { /* ignore */ }
        await recordEvent(ctx, {
          eventType: "ocr_failed",
          objectType: "ocr_run",
          objectId: runId,
          caseId: orderId,
          detail: { error: String(err.message || err).slice(0, 500) },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error("[documents/ocr] failure event write failed: " + (logErr.message || logErr));
      }
    }
    sendError(res, err);
  }
}
