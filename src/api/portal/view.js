// GET /api/portal/view?token=<...>&kind=<quotes|orders|invoices|summary>
//
// Public-facing endpoint: no auth header required, the token is the
// auth. Validates the token, logs the access, and returns the
// corresponding read-only data scoped to that customer.
//
// `summary` is always returned so the portal landing page can show
// "Hi <customer>, you have N open quotes / orders / invoices".

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";

const logAccess = async (svc, tokenRow, req, status, path) => {
  await svc.from("portal_access_log").insert({
    tenant_id: tokenRow.tenant_id,
    token_id: tokenRow.id,
    ip: req.headers["x-forwarded-for"]?.split(",")[0] || null,
    user_agent: req.headers["user-agent"] || null,
    path,
    status,
  });
};

const validateToken = async (svc, token) => {
  if (!token) return { error: { code: 401, message: "token required" } };
  const r = await svc.from("portal_tokens").select("*").eq("token", token).maybeSingle();
  if (r.error) return { error: { code: 500, message: r.error.message } };
  const t = r.data;
  if (!t) return { error: { code: 404, message: "token not found" } };
  if (t.revoked_at) return { error: { code: 401, message: "token revoked" } };
  if (t.expires_at && new Date(t.expires_at) < new Date()) {
    return { error: { code: 401, message: "token expired" } };
  }
  return { token: t };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
    const url = new URL(req.url, "http://x");
    const token = url.searchParams.get("token");
    const kind = url.searchParams.get("kind") || "summary";
    const svc = serviceClient();
    const v = await validateToken(svc, token);
    if (v.error) return json(res, v.error.code, { error: { message: v.error.message } });
    const t = v.token;
    if (!t.scopes.includes(kind === "summary" ? "quotes" : kind)) {
      await logAccess(svc, t, req, 403, kind);
      return json(res, 403, { error: { message: "scope not allowed" } });
    }

    let payload = null;
    if (kind === "summary") {
      const [q, o, i] = await Promise.all([
        svc.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id),
        svc.from("orders").select("id", { count: "exact", head: true }).eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id).in("status", ["APPROVED", "EXPORTED_TO_TALLY", "SCHEDULED", "DISPATCHED"]),
        svc.from("invoices").select("id", { count: "exact", head: true }).eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id).in("status", ["sent", "partial", "overdue"]),
      ]);
      const cust = t.customer_id ? await svc.from("customers").select("customer_name, contact_email").eq("id", t.customer_id).maybeSingle() : { data: null };
      payload = {
        customer: cust.data || null,
        scopes: t.scopes,
        counts: { quotes: q.count || 0, orders: o.count || 0, open_invoices: i.count || 0 },
      };
    } else if (kind === "quotes") {
      const r = await svc.from("orders")
        .select("id, quote_number, po_number, status, payload_hash, result, created_at")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .order("created_at", { ascending: false }).limit(50);
      payload = { quotes: r.data || [] };
    } else if (kind === "orders") {
      const r = await svc.from("orders")
        .select("id, quote_number, po_number, status, tally_status, result, created_at")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .in("status", ["APPROVED", "EXPORTED_TO_TALLY", "SCHEDULED", "DISPATCHED", "RECONCILED"])
        .order("created_at", { ascending: false }).limit(50);
      payload = { orders: r.data || [] };
    } else if (kind === "invoices") {
      const r = await svc.from("invoices")
        .select("id, invoice_number, issue_date, due_date, currency, grand_total, paid_amount, status")
        .eq("tenant_id", t.tenant_id).eq("customer_id", t.customer_id)
        .order("issue_date", { ascending: false }).limit(50);
      payload = { invoices: r.data || [] };
    } else {
      return json(res, 400, { error: { message: "unknown kind" } });
    }

    await svc.from("portal_tokens").update({
      last_used_at: new Date().toISOString(),
      use_count: (t.use_count || 0) + 1,
    }).eq("id", t.id);
    await logAccess(svc, t, req, 200, kind);
    return json(res, 200, payload);
  } catch (err) { sendError(res, err); }
}
