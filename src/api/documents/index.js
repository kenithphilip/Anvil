// GET /api/documents
//
// Lists every document row for the tenant. Powers the Documents
// library screen (src/v3-app/screens/documents.tsx) which has been
// silently empty because the client called documents.list() but
// no endpoint or client method existed.
//
// Optional query params:
//   ?classification=...   filter by classification (e.g. purchase_order)
//   ?customer_id=...      filter by linked customer
//   ?linked_so_id=...     filter by linked sales order
//   ?limit=...            page size (default 200, max 500)

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 200)));

    let q = svc.from("documents")
      .select("id, filename, mime_type, size_bytes, sha256, classification, doc_type, customer_id, linked_so_id, source, ocr_confidence, scan_status, page_count, uploader_email, email_msg_id, uploaded_at, created_at, updated_at, metadata")
      .eq("tenant_id", ctx.tenantId)
      .order("uploaded_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (req.query.classification) q = q.eq("classification", req.query.classification);
    if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
    if (req.query.linked_so_id) q = q.eq("linked_so_id", req.query.linked_so_id);
    const { data: documents, error } = await q;
    if (error) throw new Error(error.message);

    // Best-effort: join customer_name onto each row so the library
    // table renders something useful in the "Customer" column.
    const ids = [...new Set((documents || []).map((d) => d.customer_id).filter(Boolean))];
    let customerById = {};
    if (ids.length) {
      const { data: customers } = await svc.from("customers")
        .select("id, customer_name")
        .eq("tenant_id", ctx.tenantId)
        .in("id", ids);
      (customers || []).forEach((c) => { customerById[c.id] = c.customer_name; });
    }
    const rows = (documents || []).map((d) => ({
      ...d,
      customer_name: customerById[d.customer_id] || null,
    }));

    return json(res, 200, { documents: rows });
  } catch (err) { sendError(res, err); }
}
