// POST /api/portal/reorder
// Body: { token, source_order_id, line_overrides? }
//
// Customer-facing reorder. Given a past order, clones the line items
// into a new draft order and links the two via portal_reorders. Sets
// the new order's status to NEW so the existing intake / approval
// flow takes over from there.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";

const validateToken = async (svc, token) => {
  if (!token) return { error: { code: 401, message: "token required" } };
  const r = await svc.from("portal_tokens").select("*").eq("token", token).maybeSingle();
  if (r.error || !r.data) return { error: { code: 404, message: "token not found" } };
  const t = r.data;
  if (t.revoked_at) return { error: { code: 401, message: "token revoked" } };
  if (t.expires_at && new Date(t.expires_at) < new Date()) return { error: { code: 401, message: "token expired" } };
  if (!t.scopes.includes("reorder")) return { error: { code: 403, message: "reorder not in token scopes" } };
  return { token: t };
};

const logAccess = async (svc, t, req, status, path) => {
  await svc.from("portal_access_log").insert({
    tenant_id: t.tenant_id,
    token_id: t.id,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
    user_agent: req.headers["user-agent"] || null,
    path, status,
  });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    if (!body?.token || !body?.source_order_id) {
      return json(res, 400, { error: { message: "token and source_order_id required" } });
    }
    const svc = serviceClient();
    const v = await validateToken(svc, body.token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    const t = v.token;

    // Look up the source order. Must belong to this token's customer.
    const src = await svc.from("orders").select("*")
      .eq("tenant_id", t.tenant_id)
      .eq("id", body.source_order_id)
      .maybeSingle();
    if (src.error) throw new Error(src.error.message);
    if (!src.data) {
      await logAccess(svc, t, req, 404, "reorder");
      return json(res, 404, { error: { message: "source order not found" } });
    }
    if (src.data.customer_id !== t.customer_id) {
      await logAccess(svc, t, req, 403, "reorder");
      return json(res, 403, { error: { message: "order doesn't match token" } });
    }

    // Clone. We deliberately don't carry the source's status, approval,
    // payment_records, or external_systems forward; the new draft starts
    // clean and walks the normal intake/approval flow.
    const sourceResult = src.data.result || {};
    const newSalesOrder = sourceResult.salesOrder
      ? JSON.parse(JSON.stringify(sourceResult.salesOrder))
      : null;
    if (newSalesOrder && Array.isArray(body.line_overrides)) {
      // Allow the buyer to bump qty per line. Map by partNumber.
      for (const ov of body.line_overrides) {
        const li = newSalesOrder.lineItems?.find((l) =>
          (ov.partNumber && l.partNumber === ov.partNumber)
          || (ov.itemName && l.itemName === ov.itemName));
        if (li && Number.isFinite(ov.quantity)) li.quantity = Number(ov.quantity);
      }
    }

    const ins = await svc.from("orders").insert({
      tenant_id: t.tenant_id,
      customer_id: t.customer_id,
      status: "NEW",
      quote_number: null,
      po_number: "REORDER-" + (src.data.po_number || src.data.quote_number || src.data.id.slice(0, 8)),
      result: { salesOrder: newSalesOrder, source_reorder_of: src.data.id },
    }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);

    await svc.from("portal_reorders").insert({
      tenant_id: t.tenant_id,
      token_id: t.id,
      source_order_id: src.data.id,
      new_order_id: ins.data.id,
      raw: { line_overrides: body.line_overrides || null },
    });
    // Bump the token's counters.
    await svc.from("portal_tokens").update({
      last_used_at: new Date().toISOString(),
      use_count: (t.use_count || 0) + 1,
    }).eq("id", t.id);
    await logAccess(svc, t, req, 200, "reorder");

    // Audit (service-role insert so we don't need ctx).
    await svc.from("audit_events").insert({
      tenant_id: t.tenant_id,
      actor_id: null,
      action: "portal_reorder",
      object_type: "order",
      object_id: ins.data.id,
      detail: "from=" + src.data.id,
    });
    return json(res, 200, { ok: true, new_order_id: ins.data.id });
  } catch (err) { sendError(res, err); }
}
