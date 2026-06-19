// POST /api/sage_x3/push  Body: { orderId, dry_run? }
//
// Pushes a single Anvil sales order into Sage X3 as an SOH
// (Sales Order Header). Recoverable failures land in the retry
// queue; permanent failures return 502.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { sagex3DecryptCreds, sagex3PushSalesOrder, sagex3IsConfigured } from "../_lib/sage-x3-client.js";
import { httpIsRecoverable, requireApprovedOrder } from "../_lib/erp-runner.js";
import { checkExportIdempotency, recordExport, orderPayloadHash } from "../_lib/erp-export-ledger.js";

const enqueueRetry = async (svc, tenantId, orderId, payload, status, err) => {
  await svc.from("sagex3_retry_queue").insert({
    tenant_id: tenantId,
    order_id: orderId,
    payload,
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.orderId) return json(res, 400, { error: { message: "orderId required" } });

    const svc = serviceClient();
    const settingsRaw = await tenantSettings(svc, ctx.tenantId);
    const settings = sagex3DecryptCreds({ ...settingsRaw, tenant_id: ctx.tenantId });
    if (!sagex3IsConfigured(settings)) {
      return json(res, 409, { error: { code: "SAGEX3_NOT_CONFIGURED", message: "Sage X3 not configured" } });
    }

    const orderQ = await svc.from("orders").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", body.orderId).maybeSingle();
    if (orderQ.error) throw new Error(orderQ.error.message);
    if (!orderQ.data) return json(res, 404, { error: { message: "Order not found" } });
    // Audit P1.6: refuse to push unless approved + payload-hash bound.
    const approvalGuard = requireApprovedOrder(orderQ.data, body.payloadHash);
    if (approvalGuard) return json(res, approvalGuard.status, approvalGuard.body);

    let customer = null;
    if (orderQ.data.customer_id) {
      const c = await svc.from("customers").select("*")
        .eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.customer_id).maybeSingle();
      customer = c.data || null;
    }
    // Normalise the order shape so the client builder finds customer + result.
    const orderForPush = { ...orderQ.data, customer };

    if (body.dry_run) {
      // Build a preview payload without firing.
      const preview = {
        customer: customer?.customer_key || customer?.id,
        ref: orderQ.data.po_number || orderQ.data.quote_number,
        lines: (orderQ.data.result?.salesOrder?.lineItems || []).length,
        currency: orderQ.data.result?.salesOrder?.currency || "USD",
      };
      return json(res, 200, { ok: true, dry_run: true, preview });
    }

    const payloadHash = orderPayloadHash(orderQ.data);
    const idem = await checkExportIdempotency(svc, {
      tenantId: ctx.tenantId, orderId: orderQ.data.id, connector: "sage_x3",
      payloadHash, allowReexport: body.reexport === true,
    });
    if (idem.idempotent) return json(res, 200, { ok: true, idempotent: true, external_id: idem.external_id, sage_x3_id: idem.external_id });
    if (idem.blocked) return json(res, idem.status, idem.body);

    let resp = null;
    try {
      resp = await sagex3PushSalesOrder(settings, orderForPush, settings.sagex3_field_map || {});
    } catch (err) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id, { source_order: orderQ.data.id }, 0, err.message);
      return json(res, 502, { ok: false, queued_for_retry: true, error: err.message });
    }

    const ok = resp.ok;
    const externalId = resp.external_id || null;
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        sage_x3: {
          id: externalId,
          external_id: externalId,
          status: ok ? "exported" : "failed",
          last_attempt_at: new Date().toISOString(),
          last_status_code: resp.status,
          last_error: ok ? null : (resp.response?.error || resp.response?.message || null),
        },
      },
    };
    await svc.from("orders").update({ result: newResult })
      .eq("tenant_id", ctx.tenantId).eq("id", orderQ.data.id);

    await recordAudit(ctx, {
      action: ok ? "sagex3_push" : "sagex3_push_failed",
      objectType: "order",
      objectId: orderQ.data.id,
      detail: ok ? ("sagex3_id=" + externalId) : ("status=" + resp.status),
    });

    if (!ok && httpIsRecoverable(resp.status)) {
      await enqueueRetry(svc, ctx.tenantId, orderQ.data.id,
        { source_order: orderQ.data.id }, resp.status,
        JSON.stringify(resp.response).slice(0, 800));
    }
    if (!ok) {
      return json(res, 502, {
        ok: false,
        status: resp.status,
        queued_for_retry: httpIsRecoverable(resp.status),
        error: resp.response?.error || resp.response?.message || null,
      });
    }
    await recordExport(svc, { tenantId: ctx.tenantId, orderId: orderQ.data.id, connector: "sage_x3", payloadHash, externalId });
    return json(res, 200, { ok: true, sage_x3_id: externalId, status: resp.status });
  } catch (err) {
    return sendError(res, err);
  }
}
