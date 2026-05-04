// GET /api/edi/envelopes  ?direction=&message_type=&limit=
// GET /api/edi/envelopes?id=...   single envelope detail with raw payload.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: { message: "Method not allowed" } }); }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const id = url.searchParams.get("id");
    if (id) {
      const r = await svc.from("edi_envelopes").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return json(res, 404, { error: { message: "envelope not found" } });
      return json(res, 200, { envelope: r.data });
    }
    const direction = url.searchParams.get("direction");
    const messageType = url.searchParams.get("message_type");
    const limit = Math.min(200, Number(url.searchParams.get("limit") || 50));
    let q = svc.from("edi_envelopes")
      .select("id, partner_id, direction, format, message_type, control_number, status, order_id, invoice_id, error, created_at, acknowledged_at")
      .eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (direction) q = q.eq("direction", direction);
    if (messageType) q = q.eq("message_type", messageType);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    return json(res, 200, { envelopes: r.data || [] });
  } catch (err) { sendError(res, err); }
}
