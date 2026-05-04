// POST /api/netsuite/push
// Body: { orderId }
//
// Translates an Anvil order to a NetSuite Sales Order and POSTs it
// via the Record API. Records the round-trip on the order so the
// audit log shows the result; the operator can re-push idempotently
// because the API returns the same NetSuite id when a duplicate is
// detected.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { netsuiteIsConfigured, netsuiteFetch } from "../_lib/netsuite-client.js";

const buildSalesOrderPayload = (order, customer) => {
  const so = order.result?.salesOrder || {};
  const items = (so.lineItems || []).map((li) => ({
    item: { externalid: li.partNumber || li.itemName },
    quantity: Number(li.quantity || li.qty || 1),
    rate: Number(li.rate || li.unitPrice || 0),
    description: li.description || li.itemName || null,
  }));
  return {
    entity: { externalid: customer?.customer_key || ("ns:" + (customer?.id || "")) },
    tranid: order.po_number || order.quote_number || null,
    memo: "Anvil order " + order.id,
    item: { items },
    custbody_anvil_order_id: order.id,
    currency: { refName: so.currency || "USD" },
  };
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
    const settings = await tenantSettings(svc, ctx.tenantId);
    if (!netsuiteIsConfigured(settings)) {
      return json(res, 409, { error: { code: "NETSUITE_NOT_CONFIGURED", message: "NetSuite credentials missing for this tenant. Configure them in Admin > NetSuite." } });
    }

    const orderQ = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).maybeSingle();
    if (orderQ.error) throw new Error("orders read: " + orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });

    let customer = null;
    if (orderQ.data.customer_id) {
      const c = await svc.from("customers").select("id, customer_name, customer_key, external_ref").eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.customer_id).maybeSingle();
      customer = c.data || null;
    }

    const payload = buildSalesOrderPayload(orderQ.data, customer);
    const resp = await netsuiteFetch(settings, {
      method: "POST",
      path: "/services/rest/record/v1/salesorder",
      body: payload,
    });
    const ok = resp.ok;
    const externalId = resp.body?.id || null;

    // Persist a small footprint on the order so the UI can show
    // "pushed to NetSuite" + the external id.
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        netsuite: {
          id: externalId,
          status: ok ? "exported" : "failed",
          last_attempt_at: new Date().toISOString(),
          last_status_code: resp.status,
          last_error: ok ? null : (resp.body?.["o:errorDetails"] || resp.body?.error || resp.body?.raw || null),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.id);

    await recordAudit(ctx, {
      action: ok ? "netsuite_push" : "netsuite_push_failed",
      objectType: "order",
      objectId: orderQ.data.id,
      detail: ok ? ("ns_id=" + externalId) : ("status=" + resp.status),
    });

    if (!ok) {
      return json(res, 502, {
        ok: false,
        status: resp.status,
        error: resp.body?.["o:errorDetails"] || resp.body?.error || resp.body?.raw || null,
      });
    }
    return json(res, 200, {
      ok: true,
      netsuite_id: externalId,
      status: resp.status,
    });
  } catch (err) {
    sendError(res, err);
  }
}
