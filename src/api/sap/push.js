// POST /api/sap/push
// Body: { orderId, dry_run? }
//
// Translates an Anvil order to a SAP A_SalesOrder POST. SAP creates
// the SalesOrder entity with deep-insert children: to_Item.
// Recoverable failures (5xx, 429, network) enqueue a retry. Permanent
// failures (4xx) bubble up.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { sapDecryptCreds, sapFetch, sapIsConfigured } from "../_lib/sap-client.js";
import { httpIsRecoverable, requireApprovedOrder } from "../_lib/erp-runner.js";

const dotGet = (obj, p) => p.split(".").reduce((a, k) => (a ? a[k] : undefined), obj);
const dotSet = (obj, p, v) => {
  const parts = p.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
  cur[parts[parts.length - 1]] = v;
};

export const buildSalesOrderPayload = (order, customer, settings) => {
  const so = order.result?.salesOrder || {};
  const map = settings?.sap_field_map || {};
  const items = (so.lineItems || []).map((li, idx) => ({
    SalesOrderItem: String((idx + 1) * 10).padStart(6, "0"),
    Material: li.partNumber || li.itemName || "",
    RequestedQuantity: Number(li.quantity || li.qty || 1),
    NetAmount: Number(li.rate || li.unitPrice || 0) * Number(li.quantity || 1),
    ItemGrossWeight: 0,
  }));
  const payload = {
    SalesOrderType: "OR",
    SalesOrganization: settings?.sap_sales_org || "",
    DistributionChannel: settings?.sap_distribution_channel || "",
    OrganizationDivision: settings?.sap_division || "",
    SoldToParty: customer?.external_ref?.sap_id || customer?.customer_key || "",
    PurchaseOrderByCustomer: order.po_number || order.quote_number || "",
    TransactionCurrency: so.currency || "USD",
    to_Item: items,
  };
  for (const [src, tgt] of Object.entries(map)) {
    const v = dotGet(payload, src);
    if (v !== undefined) dotSet(payload, tgt, v);
  }
  return payload;
};

const enqueueRetry = async (svc, tenantId, orderId, payload, status, errorMsg) => {
  await svc.from("sap_retry_queue").insert({
    tenant_id: tenantId,
    order_id: orderId,
    payload,
    attempt_count: 1,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
    last_error: ((errorMsg && String(errorMsg).slice(0, 800)) || ("status=" + status)),
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
    const settings = sapDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!sapIsConfigured(settings)) {
      return json(res, 409, { error: { code: "SAP_NOT_CONFIGURED", message: "SAP not configured for this tenant" } });
    }
    const orderQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    // Audit P1.6: refuse to push unless the order has a payload-
    // hash-bound approval. Tally has done this since the start;
    // every other ERP push used to skip the gate.
    const approvalGuard = requireApprovedOrder(orderQ.data, body.payloadHash);
    if (approvalGuard) return json(res, approvalGuard.status, approvalGuard.body);
    let customer = null;
    if (orderQ.data.customer_id) {
      const c = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.customer_id).maybeSingle();
      customer = c.data || null;
    }
    const payload = buildSalesOrderPayload(orderQ.data, customer, settings);
    if (body.dry_run) return json(res, 200, { ok: true, dry_run: true, payload });
    let resp = null;
    try {
      resp = await sapFetch(settings, {
        method: "POST",
        path: "/sap/opu/odata4/sap/api_sales_order_srv/srvd_a2x/sap/salesorder/0001/A_SalesOrder",
        body: payload,
      });
    } catch (err) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, 0, err.message);
      await recordAudit(ctx, { action: "sap_push_failed", objectType: "order", objectId: orderQ.data.id, detail: "network::" + (err.message || "").slice(0, 200) });
      return json(res, 502, { ok: false, queued_for_retry: true, error: err.message });
    }
    const ok = resp.ok;
    const externalId = resp.body?.SalesOrder || null;
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        sap: {
          id: externalId,
          external_id: externalId,
          status: ok ? "exported" : "failed",
          last_attempt_at: new Date().toISOString(),
          last_status_code: resp.status,
          last_error: ok ? null : (resp.body?.error?.message || resp.body?.error || null),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.id);
    await recordAudit(ctx, {
      action: ok ? "sap_push" : "sap_push_failed",
      objectType: "order",
      objectId: orderQ.data.id,
      detail: ok ? ("sap_id=" + externalId) : ("status=" + resp.status),
    });
    if (!ok && httpIsRecoverable(resp.status)) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, resp.status,
        JSON.stringify(resp.body).slice(0, 800));
    }
    if (!ok) {
      return json(res, 502, {
        ok: false,
        status: resp.status,
        queued_for_retry: httpIsRecoverable(resp.status),
        error: resp.body?.error?.message || resp.body?.error || resp.body?.raw,
      });
    }
    return json(res, 200, { ok: true, sap_id: externalId, status: resp.status });
  } catch (err) { sendError(res, err); }
}
