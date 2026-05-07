// POST /api/acumatica/push  Body: { orderId, dry_run? }

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { acuDecryptCreds, acuFetch, acuIsConfigured } from "../_lib/acumatica-client.js";
import { httpIsRecoverable, requireApprovedOrder } from "../_lib/erp-runner.js";

// Acumatica's contract-based REST expects { Field: { value: X } } shape.
const v = (x) => ({ value: x });

const buildPayload = (order, customer, settings) => {
  const so = order.result?.salesOrder || {};
  const lineItems = (so.lineItems || []).map((li) => ({
    InventoryID: v(li.partNumber || li.itemName || ""),
    OrderQty: v(Number(li.quantity || li.qty || 1)),
    UnitPrice: v(Number(li.rate || li.unitPrice || 0)),
    WarehouseID: v(settings?.acumatica_default_warehouse || ""),
  }));
  return {
    OrderType: v("SO"),
    CustomerID: v(customer?.external_ref?.acumatica_id || customer?.customer_key || ""),
    Date: v(new Date().toISOString().slice(0, 10)),
    Description: v(order.po_number || order.quote_number || ("Anvil " + order.id)),
    CurrencyID: v(so.currency || "USD"),
    Details: lineItems,
  };
};

const enqueueRetry = async (svc, tenantId, orderId, payload, status, err) => {
  await svc.from("acu_retry_queue").insert({
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
    const settings = acuDecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!acuIsConfigured(settings)) {
      return json(res, 409, { error: { code: "ACUMATICA_NOT_CONFIGURED", message: "Acumatica not configured" } });
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
    const ep = settings.acumatica_endpoint_name || "Default";
    const ver = settings.acumatica_endpoint_version || "20.200.001";
    let resp = null;
    try {
      resp = await acuFetch(settings, {
        method: "PUT",
        path: `/entity/${ep}/${ver}/SalesOrder`,
        body: payload,
      });
    } catch (err) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, 0, err.message);
      return json(res, 502, { ok: false, queued_for_retry: true, error: err.message });
    }
    const ok = resp.ok;
    const externalId = resp.body?.OrderNbr?.value || null;
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        acumatica: {
          id: externalId, external_id: externalId,
          status: ok ? "exported" : "failed",
          last_attempt_at: new Date().toISOString(),
          last_status_code: resp.status,
          last_error: ok ? null : (resp.body?.message || resp.body?.error || null),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.id);
    await recordAudit(ctx, {
      action: ok ? "acumatica_push" : "acumatica_push_failed",
      objectType: "order", objectId: orderQ.data.id,
      detail: ok ? ("acu_id=" + externalId) : ("status=" + resp.status),
    });
    if (!ok && httpIsRecoverable(resp.status)) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, resp.status, JSON.stringify(resp.body).slice(0, 800));
    }
    if (!ok) return json(res, 502, {
      ok: false, status: resp.status,
      queued_for_retry: httpIsRecoverable(resp.status),
      error: resp.body?.message || resp.body?.error || resp.body?.raw,
    });
    return json(res, 200, { ok: true, acumatica_id: externalId, status: resp.status });
  } catch (err) { sendError(res, err); }
}
