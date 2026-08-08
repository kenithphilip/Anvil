// GET /api/communications?order_id=...
//
// Lists communications (email / WhatsApp / Slack drafts and sends)
// for an order or source PO. Powers the ThreadDrawer's
// communications timeline. The client called
// `ObaraBackend.communications.list(orderId)` but no endpoint
// existed, so the drawer's comms panel was silently empty.
//
// Query params:
//   ?order_id=...       filter by order_id
//   ?source_po_id=...   filter by source_po_id
//   ?limit=...          page size (default 100, max 500)

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
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));

    let q = svc.from("communications")
      .select("id, order_id, source_po_id, object_type, object_id, customer_id, document_type, direction, channel, thread_id, from_addr, to_addr, cc_addrs, subject, body, status, provider, sent_at, created_at, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (req.query.order_id) q = q.eq("order_id", req.query.order_id);
    if (req.query.source_po_id) q = q.eq("source_po_id", req.query.source_po_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return json(res, 200, { communications: data || [] });
  } catch (err) { sendError(res, err); }
}
