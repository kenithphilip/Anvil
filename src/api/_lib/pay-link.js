// Shared portal-token issuer for AR dunning + any other surface
// that needs to substitute the [PAY_LINK] placeholder in an
// outbound email body with a real per-invoice payment URL.
//
// Audit P8.1. ar_collect.js used to leave [PAY_LINK] visible in
// the rendered body because the AR thread didn't carry a token.
// invoices/send.js issues a token at first send (P2.7) but that
// token's TTL is shorter than the AR cycle, and a draft invoice
// reaching the dunning agent might never have been sent at all.
// This helper lets every dunning send issue a fresh per-invoice
// token with scope ['invoices', 'pay'] and returns the URL the
// caller substitutes into the body.

import crypto from "node:crypto";

const PORTAL_TOKEN_TTL_DAYS = 30;

const portalBaseUrl = () => {
  const base = process.env.PORTAL_BASE_URL || process.env.PUBLIC_APP_URL || "";
  return base ? base.replace(/\/+$/, "") : "";
};

const generatePortalToken = () => crypto.randomBytes(24).toString("hex");

// Issue a portal token for an invoice and build the public pay
// URL. Returns { id, token, url } on success, null on insertion
// failure (caller logs + falls back to leaving [PAY_LINK] visible).
export const issuePayLinkForInvoice = async (svc, tenantId, invoice, opts) => {
  if (!invoice || !invoice.id) return null;
  const ttlDays = (opts && opts.ttl_days) || PORTAL_TOKEN_TTL_DAYS;
  const token = generatePortalToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000).toISOString();
  const ins = await svc.from("portal_tokens").insert({
    tenant_id: tenantId,
    customer_id: invoice.customer_id || null,
    email: (opts && opts.email) || null,
    token,
    scopes: (opts && opts.scopes) || ["invoices", "pay"],
    expires_at: expiresAt,
    created_by: (opts && opts.created_by) || null,
  }).select("id, token, expires_at").single();
  if (ins.error) {
    // eslint-disable-next-line no-console
    console.warn("[pay-link] portal_tokens insert failed: " + ins.error.message);
    return null;
  }
  const base = portalBaseUrl();
  const url = base ? base + "/portal/" + ins.data.token : null;
  return { id: ins.data.id, token: ins.data.token, expires_at: ins.data.expires_at, url };
};

// Substitute the [PAY_LINK] placeholder in `body` with the URL,
// or with a fallback string when the URL isn't available (no
// PORTAL_BASE_URL configured, token issuance failed). The
// fallback is loud enough that the operator notices, but doesn't
// dump a literal placeholder onto the customer.
export const substitutePayLink = (body, url) => {
  if (!body) return body;
  const replacement = url || "(payment link unavailable; reply to this email and we will send one)";
  return String(body).replace(/\[PAY_LINK\]/g, replacement);
};
