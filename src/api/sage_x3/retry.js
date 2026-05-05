// /api/sage_x3/retry
// Drain the Sage X3 retry queue with exponential backoff.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { sagex3DecryptCreds, sagex3IsConfigured, sagex3PushSalesOrder } from "../_lib/sage-x3-client.js";
import { drainRetryQueue, httpIsRecoverable } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;

const replayFor = (svc, settings, ctx) => async (row) => {
  // The retry payload only carries source_order; we look up the
  // current Anvil order to rebuild a fresh push (so any operator
  // edits between the original push and the retry are reflected).
  if (!row.order_id) return { ok: false, status: 0, error: "no order_id on retry row" };
  const orderQ = await svc.from("orders").select("*").eq("id", row.order_id).maybeSingle();
  if (!orderQ.data) return { ok: false, status: 0, error: "order not found" };
  let customer = null;
  if (orderQ.data.customer_id) {
    const c = await svc.from("customers").select("*").eq("id", orderQ.data.customer_id).maybeSingle();
    customer = c.data || null;
  }
  let resp;
  try {
    resp = await sagex3PushSalesOrder(settings, { ...orderQ.data, customer }, settings.sagex3_field_map || {});
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
  if (resp.ok) {
    const externalId = resp.external_id || null;
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        sage_x3: {
          id: externalId,
          external_id: externalId,
          status: "exported",
          last_attempt_at: new Date().toISOString(),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("id", row.order_id);
    if (ctx) await recordAudit(ctx, {
      action: "sagex3_push",
      objectType: "order",
      objectId: row.order_id,
      detail: "retry_ok::id=" + externalId,
    });
    return { ok: true, externalId };
  }
  return { ok: false, status: resp.status, error: JSON.stringify(resp.response).slice(0, 800) };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const tenants = await svc.from("sagex3_retry_queue").select("tenant_id")
        .eq("status", "pending")
        .lte("next_attempt_at", new Date().toISOString());
      const uniq = Array.from(new Set((tenants.data || []).map((r) => r.tenant_id)));
      const out = [];
      for (const tid of uniq) {
        const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", tid).maybeSingle();
        if (!sRow.data) continue;
        const settings = sagex3DecryptCreds({ ...sRow.data, tenant_id: tid });
        if (!sagex3IsConfigured(settings)) continue;
        out.push({
          tenant_id: tid,
          ...await drainRetryQueue(svc, "sagex3", {
            tenantId: tid,
            opts: {},
            replay: replayFor(svc, settings, null),
            isRecoverable: httpIsRecoverable,
          }),
        });
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!sRow.data) return json(res, 404, { error: { message: "no settings" } });
    const settings = sagex3DecryptCreds({ ...sRow.data, tenant_id: ctx.tenantId });
    if (!sagex3IsConfigured(settings)) {
      return json(res, 409, { error: { code: "SAGEX3_NOT_CONFIGURED", message: "Sage X3 not configured" } });
    }
    const r = await drainRetryQueue(svc, "sagex3", {
      tenantId: ctx.tenantId,
      opts: { id: body?.id || null, limit: Math.min(100, body?.limit || 50) },
      replay: replayFor(svc, settings, ctx),
      isRecoverable: httpIsRecoverable,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...r });
  } catch (err) {
    return sendError(res, err);
  }
}
