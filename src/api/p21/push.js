// POST /api/p21/push  Body: { orderId, dry_run? }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { p21DecryptCreds, p21Fetch, p21IsConfigured } from "../_lib/p21-client.js";
import { httpIsRecoverable, requireApprovedOrder } from "../_lib/erp-runner.js";

const dotGet = (obj, p) => p.split(".").reduce((a, k) => (a ? a[k] : undefined), obj);
const dotSet = (obj, p, v) => { const parts = p.split("."); let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = v; };

const buildPayload = (order, customer, settings) => {
  const so = order.result?.salesOrder || {};
  const map = settings?.p21_field_map || {};
  const lines = (so.lineItems || []).map((li, idx) => ({
    line_no: idx + 1,
    item_id: li.partNumber || li.itemName || "",
    qty_ordered: Number(li.quantity || li.qty || 1),
    unit_price: Number(li.rate || li.unitPrice || 0),
  }));
  const payload = {
    customer_id: customer?.external_ref?.p21_id || customer?.customer_key || "",
    branch_id: settings?.p21_default_branch || null,
    location_id: settings?.p21_default_warehouse || null,
    salesrep_id: settings?.p21_default_salesrep || null,
    po_no_customer: order.po_number || null,
    currency_id: so.currency || "USD",
    lines,
  };
  for (const [src, tgt] of Object.entries(map)) {
    const v = dotGet(payload, src); if (v !== undefined) dotSet(payload, tgt, v);
  }
  return payload;
};

const enqueueRetry = async (svc, tenantId, orderId, payload, status, err) => {
  await svc.from("p21_retry_queue").insert({
    tenant_id: tenantId, order_id: orderId, payload,
    attempt_count: 1,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    last_error: ((err && String(err).slice(0, 800)) || ("status=" + status)),
    status: "pending",
  });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.orderId) return json(res, 400, { error: { message: "orderId required" } });
    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = p21DecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!p21IsConfigured(settings)) {
      return json(res, 409, { error: { code: "P21_NOT_CONFIGURED", message: "Prophet 21 not configured" } });
    }
    const orderQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).maybeSingle();
    if (orderQ.error) throw new Error(orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    // Audit P1.6: refuse to push unless approved + payload-hash bound.
    const approvalGuard = requireApprovedOrder(orderQ.data, body.payloadHash);
    if (approvalGuard) return json(res, approvalGuard.status, approvalGuard.body);
    let customer = null;
    if (orderQ.data.customer_id) {
      const c = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.customer_id).maybeSingle();
      customer = c.data || null;
    }
    const payload = buildPayload(orderQ.data, customer, settings);
    if (body.dry_run) return json(res, 200, { ok: true, dry_run: true, payload });
    let resp = null;
    try {
      resp = await p21Fetch(settings, { method: "POST", path: "/api/v2/data/OrderHeader", body: payload });
    } catch (err) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, 0, err.message);
      return json(res, 502, { ok: false, queued_for_retry: true, error: err.message });
    }
    const ok = resp.ok;
    const externalId = resp.body?.order_no || resp.body?.OrderId || null;
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        p21: {
          id: externalId, external_id: externalId,
          status: ok ? "exported" : "failed",
          last_attempt_at: new Date().toISOString(),
          last_status_code: resp.status,
          last_error: ok ? null : (resp.body?.error || resp.body?.message || null),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.id);
    await recordAudit(ctx, {
      action: ok ? "p21_push" : "p21_push_failed",
      objectType: "order", objectId: orderQ.data.id,
      detail: ok ? ("p21_id=" + externalId) : ("status=" + resp.status),
    });
    if (!ok && httpIsRecoverable(resp.status)) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, resp.status, JSON.stringify(resp.body).slice(0, 800));
    }
    if (!ok) return json(res, 502, {
      ok: false, status: resp.status,
      queued_for_retry: httpIsRecoverable(resp.status),
      error: resp.body?.error || resp.body?.message || resp.body?.raw,
    });
    return json(res, 200, { ok: true, p21_id: externalId, status: resp.status });
  } catch (err) { sendError(res, err); }
}
