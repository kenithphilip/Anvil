// GET /api/documents/<id>/evidence
//
// Returns every OCR evidence row for the document, in page +
// creation order. Used by the documents-detail screen to render the
// per-token bbox overlay on top of the source image. The Mistral
// OCR endpoint (/api/documents/ocr) populates these rows; this
// endpoint just reads them back.
//
// Audit P13.B.3 follow-up. The bbox overlay was deferred at the
// time PR #47 (Stage B.3) shipped because we believed the OCR
// engine did not emit per-token coordinates. On a re-audit it
// turned out Mistral OCR already produces bboxes (see
// /api/documents/ocr.js) and the evidence table already persists
// them; the only missing piece was a read endpoint and the
// frontend overlay component.
//
// Migration 077_evidence_document_scope.sql relaxes
// evidence.order_id to allow NULL so OCR can be run on a document
// before an order exists, which is the natural workflow for the
// documents-detail review screen.
//
// Response: { rows: Array<{
//   id, page_number, bbox: { x0, y0, x1, y1, page_width, page_height },
//   value, confidence, field_path, extraction_method, created_at,
// }> }

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const id = req.query.id || req.url.split("/").slice(-2, -1)[0];
    if (!id) return json(res, 400, { error: { message: "Document id required" } });
    const svc = serviceClient();
    // Confirm the document exists in this tenant before returning
    // any evidence rows. Cheaper than relying on RLS to filter the
    // join, and lets us emit a clean 404 instead of an empty list
    // when the id is wrong.
    const { data: doc, error: docErr } = await svc.from("documents")
      .select("id, page_count, mime_type")
      .eq("tenant_id", ctx.tenantId)
      .eq("id", id)
      .single();
    if (docErr || !doc) return json(res, 404, { error: { message: "Document not found" } });

    const { data: rows, error: evErr } = await svc.from("evidence")
      .select("id, page_number, bbox, value, confidence, field_path, extraction_method, created_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("document_id", id)
      .order("page_number", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    if (evErr) throw new Error(evErr.message);

    return json(res, 200, {
      document_id: id,
      page_count: doc.page_count || null,
      mime_type: doc.mime_type || null,
      rows: rows || [],
    });
  } catch (err) { sendError(res, err); }
}
