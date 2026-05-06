// POST /api/netsuite/push
// Body: { orderId, dry_run?: false }
//
// Translates an Anvil order to a NetSuite Sales Order and POSTs it
// via the Record API. v2 changes:
//   - Decrypts credentials before signing the request.
//   - Honours per-tenant netsuite_field_map overrides on
//     tenant_settings (jsonb). Operators can rename / remap fields
//     without a code change.
//   - Recoverable failures (5xx, 429, network) enqueue a retry row
//     in netsuite_retry_queue with exponential backoff.
//   - dry_run=true returns the rendered payload without sending,
//     for the new push-preview UI.
//   - Audits success and failure separately so the outcome meter
//     can map only successes to `order_pushed`.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { netsuiteIsConfigured, netsuiteFetch } from "../_lib/netsuite-client.js";
import { decryptNetsuiteCreds } from "../_lib/secrets.js";

// Tiny dot-path get/set for field-map overrides. Map shape:
// { "<source.path>": "<target.path>" } where source is read from the
// rendered payload and target is the position to swap it to. We
// don't try to be JSON Patch; this is the 95% case.
const dotGet = (obj, p) => p.split(".").reduce((a, k) => (a ? a[k] : undefined), obj);
const dotSet = (obj, p, v) => {
  const parts = p.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
};

export const buildSalesOrderPayload = (order, customer, settings) => {
  const so = order.result?.salesOrder || {};
  const map = settings?.netsuite_field_map || {};
  const items = (so.lineItems || []).map((li) => ({
    item: { externalid: li.partNumber || li.itemName },
    quantity: Number(li.quantity || li.qty || 1),
    rate: Number(li.rate || li.unitPrice || 0),
    description: li.description || li.itemName || null,
  }));
  const payload = {
    entity: { externalid: customer?.customer_key || ("ns:" + (customer?.id || "")) },
    tranid: order.po_number || order.quote_number || null,
    memo: "Anvil order " + order.id,
    item: { items },
    custbody_anvil_order_id: order.id,
    currency: { refName: so.currency || "USD" },
  };
  if (settings?.netsuite_subsidiary_id) {
    payload.subsidiary = { id: settings.netsuite_subsidiary_id };
  }
  if (settings?.netsuite_default_location_id) {
    payload.location = { id: settings.netsuite_default_location_id };
  }

  // Apply field-map overrides. Map keys reference the rendered
  // payload (source); values are the target path. Allows e.g.
  // moving "memo" -> "custbody_my_memo" without touching code.
  for (const [src, tgt] of Object.entries(map)) {
    const v = dotGet(payload, src);
    if (v !== undefined) {
      dotSet(payload, tgt, v);
    }
  }
  return payload;
};

const isRecoverable = (status) =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

const enqueueRetry = async (svc, tenantId, orderId, payload, status, errorMsg) => {
  // Exponential backoff: first attempt waits 1 minute, then 5, 15,
  // 60, 240. After max_attempts the runner flips status to gave_up.
  const next = new Date(Date.now() + 60_000).toISOString();
  await svc.from("netsuite_retry_queue").insert({
    tenant_id: tenantId,
    order_id: orderId,
    payload,
    attempt_count: 1,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: next,
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
    const settings = decryptNetsuiteCreds(settingsRaw);
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

    const payload = buildSalesOrderPayload(orderQ.data, customer, settings);
    if (body.dry_run) {
      return json(res, 200, { ok: true, dry_run: true, payload });
    }

    let resp = null;
    try {
      resp = await netsuiteFetch(settings, {
        method: "POST",
        path: "/services/rest/record/v1/salesorder",
        body: payload,
      });
    } catch (err) {
      // Network-level failure. Treat as recoverable.
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, 0, err.message);
      await recordAudit(ctx, {
        action: "netsuite_push_failed",
        objectType: "order",
        objectId: orderQ.data.id,
        detail: "network::" + (err.message || "").slice(0, 200),
      });
      return json(res, 502, { ok: false, queued_for_retry: true, error: err.message });
    }

    const ok = resp.ok;
    const externalId = resp.body?.id || null;
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        netsuite: {
          id: externalId,
          external_id: externalId,
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

    // Smartbase parity: auto-print a traveler PDF when the tenant
    // opted in. Best-effort (failure here doesn't fail the push).
    if (ok) {
      const { enqueueTravelerForOrder } = await import("../orders/traveler.js");
      enqueueTravelerForOrder(svc, {
        tenantId: ctx.tenantId, orderId: orderQ.data.id, triggeredBy: "erp_push",
      }).then(() => undefined, () => undefined);
    }

    if (!ok && isRecoverable(resp.status)) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, payload, resp.status,
        JSON.stringify(resp.body).slice(0, 800));
    }

    if (!ok) {
      return json(res, 502, {
        ok: false,
        status: resp.status,
        queued_for_retry: isRecoverable(resp.status),
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
