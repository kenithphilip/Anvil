// POST /api/receipts/extract
// Body: { text? , bytes_base64? , mime? , document_id? | source_id? }
//
// Runs GRN/SRN extraction over an emailed/uploaded receipt and returns the parsed
// receipt. It does NOT persist — the operator (or a follow-up flow) confirms via
// POST /api/receipts, mirroring the PO extract -> reconcile human-in-the-loop.
// See docs/DELIVERY_TO_CASH_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { safeFetch } from "../_lib/safe-fetch.js";
import { extractGrn } from "../_lib/grn-extract.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const svc = serviceClient();

    const text = typeof body?.text === "string" && body.text.trim() ? body.text : null;
    let bytes = body?.bytes_base64 ? Buffer.from(body.bytes_base64, "base64") : null;
    let mime = body?.mime || null;
    let evidenceDocId = body?.document_id || body?.source_id || null;

    // Resolve a stored document server-side (same pattern as docai/extract).
    if (!text && !bytes && evidenceDocId) {
      const { data: doc } = await svc.from("documents")
        .select("storage_bucket, storage_path, mime_type")
        .eq("tenant_id", ctx.tenantId).eq("id", evidenceDocId).maybeSingle();
      if (doc?.storage_bucket && doc?.storage_path) {
        mime = mime || doc.mime_type || null;
        const { data: signed, error: signErr } = await svc.storage
          .from(doc.storage_bucket).createSignedUrl(doc.storage_path, 60 * 5);
        if (!signErr && signed?.signedUrl) {
          try {
            const upstream = await safeFetch(signed.signedUrl);
            if (upstream.ok) bytes = Buffer.from(await upstream.arrayBuffer());
          } catch (_) { /* fall through */ }
        }
      }
    }

    if (!text && !bytes) {
      return json(res, 400, { error: { message: "provide text, bytes_base64, or a resolvable document_id" } });
    }

    const out = await extractGrn({ text, bytes, mime, settings: { tenant_id: ctx.tenantId } });
    if (!out.ok) {
      return json(res, 422, { error: { message: out.error || "GRN extraction failed", reason: out.reason } });
    }
    // Echo the evidence doc so the client can attach it when confirming.
    return json(res, 200, { receipt: out.receipt, confidence: out.confidence, evidence_doc_id: evidenceDocId });
  } catch (err) { sendError(res, err); }
}
