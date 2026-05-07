// POST /api/portal/accept_quote
// Body: { token, quote_id?, order_id?, signature_name, signature_email? }
//
// Customer-side quote acceptance. Two paths:
//
//   Audit P6.6 (preferred): the operator sent a quote via
//   /api/quotes/send. The customer clicks the portal URL, types
//   their name, posts to this endpoint with quote_id. We:
//
//     1. Validate the token (scope=accept_quote).
//     2. Validate the quote (status SENT, not expired, customer
//        matches token).
//     3. Persist a portal_quote_acceptances row (signature, IP,
//        UA, payload_hash snapshot from the quote).
//     4. Flip the quote to ACCEPTED with accepted_at +
//        accepted_by_email + accepted_signature_name.
//
//   Legacy: the operator created an order directly + issued a
//   portal token bound to that order. The customer clicks accept
//   with order_id; we flip the order to APPROVED. This path
//   stays so existing tokens remain valid; it's the original
//   shape this endpoint handled before P6.

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

const acceptQuotePath = async (req, res, svc, t, body) => {
  // Quote lookup gated by tenant + customer match.
  const qQ = await svc.from("quotes").select("*").eq("tenant_id", t.tenant_id).eq("id", body.quote_id).maybeSingle();
  if (qQ.error) throw new Error(qQ.error.message);
  if (!qQ.data) return json(res, 404, { error: { message: "quote not found" } });
  const q = qQ.data;
  if (q.customer_id && q.customer_id !== t.customer_id) {
    return json(res, 403, { error: { message: "quote doesn't match token" } });
  }
  if (q.status !== "SENT") {
    return json(res, 409, { error: { message: "quote is not in SENT status (current: " + q.status + ")" } });
  }
  if (q.expires_at && new Date(q.expires_at) < new Date()) {
    return json(res, 410, { error: { message: "quote has expired" } });
  }

  const acceptedAt = new Date().toISOString();
  const ins = await svc.from("portal_quote_acceptances").insert({
    tenant_id: t.tenant_id,
    token_id: t.id,
    quote_id: q.id,
    order_id: null,
    customer_id: t.customer_id,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
    user_agent: req.headers["user-agent"] || null,
    signature_name: body.signature_name,
    signature_email: body.signature_email || t.email || null,
    payload_hash: q.payload_hash || null,
    accepted_at: acceptedAt,
    raw: { remote_addr: req.headers["x-forwarded-for"], host: req.headers.host },
  }).select("id, accepted_at").single();
  if (ins.error) throw new Error(ins.error.message);

  // Flip the quote to ACCEPTED. The operator (or an autonomous
  // followup) calls /api/quotes/convert to create the sales
  // order from this point.
  const upd = await svc.from("quotes").update({
    status: "ACCEPTED",
    accepted_at: acceptedAt,
    accepted_by_email: body.signature_email || t.email || null,
    accepted_signature_name: body.signature_name,
    updated_at: acceptedAt,
  }).eq("tenant_id", t.tenant_id).eq("id", q.id).select("*").single();
  if (upd.error) throw new Error(upd.error.message);

  await svc.from("audit_events").insert({
    tenant_id: t.tenant_id,
    actor_id: null,
    action: "portal_quote_accepted",
    object_type: "quote",
    object_id: q.id,
    detail: "by=" + body.signature_name + " v" + q.version,
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
    quote: upd.data,
  });
};

const acceptOrderPath = async (req, res, svc, t, body) => {
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
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    if (!body?.token || !body?.signature_name) {
      return json(res, 400, { error: { message: "token and signature_name required" } });
    }
    if (!body?.quote_id && !body?.order_id) {
      return json(res, 400, { error: { message: "Either quote_id or order_id required" } });
    }
    const svc = serviceClient();
    const v = await validateToken(svc, body.token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    const t = v.token;

    // Prefer the new quote_id path when both are supplied.
    if (body.quote_id) return acceptQuotePath(req, res, svc, t, body);
    return acceptOrderPath(req, res, svc, t, body);
  } catch (err) { sendError(res, err); }
}
