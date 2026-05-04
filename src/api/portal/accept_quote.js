// POST /api/portal/accept_quote
// Body: { token, order_id, signature_name, signature_email? }
//
// Customer-side quote acceptance. We persist a portal_quote_acceptances
// row (IP, UA, signature, payload_hash snapshot), advance the order's
// status to APPROVED, and record an audit + outcome event.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";

const validateToken = async (svc, token) => {
  if (!token) return { error: { code: 401, message: "token required" } };
  const r = await svc.from("portal_tokens").select("*").eq("token", token).maybeSingle();
  if (r.error || !r.data) return { error: { code: 404, message: "token not found" } };
  const t = r.data;
  if (t.revoked_at) return { error: { code: 401, message: "token revoked" } };
  if (t.expires_at && new Date(t.expires_at) < new Date()) return { error: { code: 401, message: "token expired" } };
  if (!t.scopes.includes("accept_quote")) {
    return { error: { code: 403, message: "accept_quote not in token scopes" } };
  }
  return { token: t };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    if (!body?.token || !body?.order_id || !body?.signature_name) {
      return json(res, 400, { error: { message: "token, order_id, signature_name required" } });
    }
    const svc = serviceClient();
    const v = await validateToken(svc, body.token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    const t = v.token;

    const orderQ = await svc.from("orders").select("*")
      .eq("tenant_id", t.tenant_id).eq("id", body.order_id).maybeSingle();
    if (orderQ.error) throw new Error(orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "order not found" } });
    if (orderQ.data.customer_id !== t.customer_id) {
      return json(res, 403, { error: { message: "order doesn't match token" } });
    }

    const ins = await svc.from("portal_quote_acceptances").insert({
      tenant_id: t.tenant_id,
      token_id: t.id,
      order_id: orderQ.data.id,
      customer_id: t.customer_id,
      ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
      user_agent: req.headers["user-agent"] || null,
      signature_name: body.signature_name,
      signature_email: body.signature_email || t.email || null,
      payload_hash: orderQ.data.payload_hash || orderQ.data.approval?.payloadHash || null,
      raw: { remote_addr: req.headers["x-forwarded-for"], host: req.headers.host },
    }).select("id, accepted_at").single();
    if (ins.error) throw new Error(ins.error.message);

    // Advance order state. Customer acceptance maps to APPROVED in
    // the existing state machine.
    await svc.from("orders").update({
      status: "APPROVED",
      approval: {
        ...(orderQ.data.approval || {}),
        decided_by: "portal:" + t.id,
        decided_at: ins.data.accepted_at,
        decision: "accepted",
        signature_name: body.signature_name,
      },
    }).eq("tenant_id", t.tenant_id).eq("id", orderQ.data.id);

    await svc.from("audit_events").insert({
      tenant_id: t.tenant_id,
      actor_id: null,
      action: "portal_quote_accepted",
      object_type: "order",
      object_id: orderQ.data.id,
      detail: "by=" + body.signature_name,
    });

    await svc.from("portal_access_log").insert({
      tenant_id: t.tenant_id, token_id: t.id,
      ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
      user_agent: req.headers["user-agent"] || null,
      path: "accept_quote", status: 200,
    });

    return json(res, 200, {
      ok: true,
      acceptance_id: ins.data.id,
      accepted_at: ins.data.accepted_at,
    });
  } catch (err) { sendError(res, err); }
}
