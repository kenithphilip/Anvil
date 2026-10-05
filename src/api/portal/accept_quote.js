// POST /api/portal/accept_quote
// Body: { token, quote_id, signature_name, signature_email? }
//
// Customer-side quote acceptance through a legacy portal link (Audit P6.6):
// the operator sent a quote via /api/quotes/send, the customer types their
// name, and posts here with quote_id. We:
//
//   1. Validate the token (scope=accept_quote).
//   2. Validate the quote: it belongs to the token's customer, is SENT, and
//      has not expired. A quote with no customer is refused: the customer
//      check used to be skipped for it, so any accept_quote token in the
//      tenant could accept it.
//   3. Persist a portal_quote_acceptances row (signature, IP, UA,
//      payload_hash snapshot from the quote).
//   4. Flip the quote to ACCEPTED with accepted_at + accepted_by_email +
//      accepted_signature_name.
//
// The old order path is retired (410). It took an order_id and set ANY order
// of the token's customer to APPROVED, at any status and with no payload
// check, which let a link bypass the approval gate. Nothing in the app sends
// order_id here; the route stays so an old link gets a clear answer.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

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
  if (!q.customer_id || !t.customer_id || q.customer_id !== t.customer_id) {
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

  // audit_events has `actor` (uuid, references auth.users), not `actor_id`.
  // The old raw insert named a column that does not exist, so every
  // acceptance audit row was rejected and, because supabase-js returns the
  // error instead of throwing, silently lost. A token has no auth user, so
  // the actor is null; recordAudit logs any failure to audit_failures.
  await recordAudit({ tenantId: t.tenant_id, user: null, role: null }, {
    action: "portal_quote_accepted",
    objectType: "quote",
    objectId: q.id,
    detail: "by=" + body.signature_name + " v" + q.version + " token=" + t.id,
  });
  await svc.from("portal_access_log").insert({
    tenant_id: t.tenant_id, token_id: t.id,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
    user_agent: req.headers["user-agent"] || null,
    path: "accept_quote", status: 200,
  });

  // Return what the customer needs, not the whole quotes row: it carries
  // created_by (a staff user id), field_sources, fx snapshots and ingest
  // details. A token holder is not staff.
  return json(res, 200, {
    ok: true,
    acceptance_id: ins.data.id,
    accepted_at: ins.data.accepted_at,
    quote: { id: upd.data.id, quote_number: upd.data.quote_number || null, version: upd.data.version, status: upd.data.status },
  });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    if (!body?.quote_id && body?.order_id) {
      // Retired before any token lookup, so the answer does not depend on
      // whether the token is valid.
      return json(res, 410, { error: { code: "ORDER_ACCEPT_RETIRED", message: "Accepting an order through a portal link is no longer supported. Please confirm the order with your contact at the supplier." } });
    }
    if (!body?.token || !body?.signature_name) {
      return json(res, 400, { error: { message: "token and signature_name required" } });
    }
    if (!body?.quote_id) {
      return json(res, 400, { error: { message: "quote_id required" } });
    }
    const svc = serviceClient();
    const v = await validateToken(svc, body.token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    return acceptQuotePath(req, res, svc, v.token, body);
  } catch (err) { sendError(res, err); }
}
