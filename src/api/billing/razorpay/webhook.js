// POST /api/billing/razorpay/webhook
//
// Razorpay POSTs payment events here. We verify the
// X-Razorpay-Signature HMAC over the raw body using
// razorpay_webhook_secret per tenant, BEFORE any business-logic
// state lookup. Hardened May 2026 (security audit H4).
//
// Tenant resolution.
//   1. Preferred: caller passes `?tenant=<id>` in the URL (the
//      operator configures the webhook URL with their own tenant_id;
//      Razorpay forwards the URL verbatim).
//   2. Legacy fallback: if no tenant query param, iterate
//      tenant_settings rows that have a non-null
//      razorpay_webhook_secret and try each. First HMAC match wins.
//      This is bounded (one row per tenant; verify is sub-millisecond)
//      and lets existing webhooks continue to work without operator
//      reconfiguration.
// In either path, the signature MUST verify before we read
// razorpay_payments. Previously the code read the order row first
// and only then verified, which was an enumeration oracle (404 vs
// 401 leaked tenant existence) and a fragile order-of-operations
// hazard for any future bypass code added between the two reads.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { razorpayVerifyWebhookSignature } from "../../_lib/razorpay-client.js";
import { webhookIpRateLimit } from "../../_lib/rate-limit.js";

const readRaw = (req) => new Promise((resolve, reject) => {
  let data = ""; req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { data += c; });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});

const tenantFromQuery = (req) => {
  try {
    const url = new URL(req.url || "/", "http://x");
    const t = url.searchParams.get("tenant");
    if (t && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return t;
  } catch (_) { /* fall through */ }
  return null;
};

// Verify against a single tenant's secret. Returns true if the HMAC
// matches AND the secret is set; false otherwise.
const verifyAgainstTenant = async (svc, tenantId, raw, signature) => {
  const r = await svc.from("tenant_settings").select("razorpay_webhook_secret").eq("tenant_id", tenantId).maybeSingle();
  const secret = r.data?.razorpay_webhook_secret;
  if (!secret) return false;
  return razorpayVerifyWebhookSignature(raw, signature, secret);
};

const findVerifyingTenant = async (svc, raw, signature) => {
  const r = await svc.from("tenant_settings")
    .select("tenant_id, razorpay_webhook_secret")
    .not("razorpay_webhook_secret", "is", null);
  if (r.error) return null;
  for (const row of r.data || []) {
    if (razorpayVerifyWebhookSignature(raw, signature, row.razorpay_webhook_secret)) {
      return row.tenant_id;
    }
  }
  return null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  // Audit L5: cheap in-process rate limit before signature work.
  const rl = webhookIpRateLimit(req, "razorpay", { maxPerMinute: 120 });
  if (!rl.allowed) return json(res, 429, { error: { message: "rate limited" } });
  try {
    const raw = await readRaw(req);
    const signature = req.headers["x-razorpay-signature"] || req.headers["X-Razorpay-Signature"];
    if (!signature) return json(res, 401, { error: { message: "missing signature" } });

    const svc = serviceClient();

    // Step 1: verify signature. No DB read of business state yet.
    let tenantId = tenantFromQuery(req);
    if (tenantId) {
      const ok = await verifyAgainstTenant(svc, tenantId, raw, signature);
      if (!ok) return json(res, 401, { error: { message: "invalid signature" } });
    } else {
      tenantId = await findVerifyingTenant(svc, raw, signature);
      if (!tenantId) return json(res, 401, { error: { message: "invalid signature" } });
    }

    // Step 2: parse body. Only happens after signature verifies.
    let body = null;
    try { body = JSON.parse(raw || "{}"); } catch (_e) { return json(res, 400, { error: { message: "invalid json" } }); }
    const orderId = body?.payload?.payment?.entity?.order_id || body?.payload?.order?.entity?.id;
    if (!orderId) return json(res, 400, { error: { message: "no order_id in payload" } });

    // Step 3: load the matching payment row, scoped to the verified
    // tenant. If no row exists for this tenant, the webhook was
    // signed by a tenant that doesn't own the order — treat as
    // misrouted and return 404.
    const rpQ = await svc.from("razorpay_payments").select("*")
      .eq("tenant_id", tenantId)
      .eq("razorpay_order_id", orderId)
      .maybeSingle();
    if (rpQ.error) throw new Error(rpQ.error.message);
    if (!rpQ.data) {
      return json(res, 404, { error: { message: "no matching razorpay_payments row for this tenant" } });
    }

    const event = body.event || "";
    const payment = body.payload?.payment?.entity || null;
    let nextStatus = rpQ.data.status;
    let invoiceUpdate = null;
    if (event === "payment.captured" || event === "order.paid") {
      nextStatus = "captured";
      invoiceUpdate = { status: "paid", paid_at: new Date().toISOString() };
    } else if (event === "payment.authorized") {
      nextStatus = "authorized";
    } else if (event === "payment.failed") {
      nextStatus = "failed";
    } else if (event === "refund.processed") {
      nextStatus = "refunded";
      invoiceUpdate = { status: "void" };
    }
    await svc.from("razorpay_payments").update({
      status: nextStatus,
      razorpay_payment_id: payment?.id || rpQ.data.razorpay_payment_id,
      method: payment?.method || rpQ.data.method,
      email: payment?.email || rpQ.data.email,
      contact: payment?.contact || rpQ.data.contact,
      raw: body,
    }).eq("id", rpQ.data.id);
    if (invoiceUpdate && rpQ.data.invoice_id) {
      const inv = await svc.from("invoices").select("grand_total, paid_amount").eq("id", rpQ.data.invoice_id).maybeSingle();
      if (inv.data) {
        // Audit M9 (May 2026): integer-cents arithmetic. JS double
        // precision drops cents on certain inputs (0.1+0.2=0.30000…4).
        // Money columns are numeric(14,2); we round each input to
        // cents, sum as int, divide back to decimal at the boundary.
        const cents = (n) => Math.round(Number(n || 0) * 100);
        const paid = (cents(rpQ.data.amount) + cents(inv.data.paid_amount)) / 100;
        await svc.from("invoices").update({
          ...invoiceUpdate,
          paid_amount: paid,
        }).eq("id", rpQ.data.invoice_id);
      }
    }
    // Lightweight audit (no ctx since this is webhook-driven).
    await svc.from("audit_events").insert({
      tenant_id: tenantId,
      actor_id: null,
      action: "razorpay_webhook::" + event,
      object_type: "razorpay_payments",
      object_id: rpQ.data.id,
      detail: "status=" + nextStatus,
    });
    return json(res, 200, { ok: true });
  } catch (err) { sendError(res, err); }
}
