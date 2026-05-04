// /api/sxe/retry

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { sxeDecryptCreds, sxeFetch, sxeIsConfigured } from "../_lib/sxe-client.js";
import { drainRetryQueue, httpIsRecoverable } from "../_lib/erp-runner.js";

const CRON_SECRET = process.env.CRON_SECRET;

const replayFor = (svc, settings, ctx) => async (row) => {
  let resp;
  try { resp = await sxeFetch(settings, { method: "POST", path: "/M3/m3api-rest/v2/customer-order", body: row.payload }); }
  catch (err) { return { ok: false, status: 0, error: err.message }; }
  if (resp.ok) {
    const externalId = resp.body?.orderNumber || resp.body?.OrderNumber || null;
    if (row.order_id) {
      const orderQ = await svc.from("orders").select("*").eq("id", row.order_id).maybeSingle();
      if (orderQ.data) {
        const newResult = {
          ...(orderQ.data.result || {}),
          external_systems: {
            ...(orderQ.data.result?.external_systems || {}),
            sxe: { id: externalId, external_id: externalId, status: "exported", last_attempt_at: new Date().toISOString() },
          },
        };
        await svc.from("orders").update({ result: newResult }).eq("id", orderQ.data.id);
      }
    }
    if (ctx) await recordAudit(ctx, { action: "sxe_push", objectType: "order", objectId: row.order_id, detail: "retry_ok::id=" + externalId });
    return { ok: true, externalId };
  }
  return { ok: false, status: resp.status, error: JSON.stringify(resp.body).slice(0, 800) };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const tenants = await svc.from("sxe_retry_queue").select("tenant_id").eq("status", "pending")
        .lte("next_attempt_at", new Date().toISOString());
      const uniq = Array.from(new Set((tenants.data || []).map((r) => r.tenant_id)));
      const out = [];
      for (const tid of uniq) {
        const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", tid).maybeSingle();
        if (!sRow.data) continue;
        const settings = sxeDecryptCreds({ ...sRow.data, tenant_id: tid });
        if (!sxeIsConfigured(settings)) continue;
        out.push({ tenant_id: tid, ...await drainRetryQueue(svc, "sxe", { tenantId: tid, opts: {}, replay: replayFor(svc, settings, null), isRecoverable: httpIsRecoverable }) });
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!sRow.data) return json(res, 404, { error: { message: "no settings" } });
    const settings = sxeDecryptCreds({ ...sRow.data, tenant_id: ctx.tenantId });
    if (!sxeIsConfigured(settings)) return json(res, 409, { error: { code: "SXE_NOT_CONFIGURED", message: "Infor SX.e not configured" } });
    const r = await drainRetryQueue(svc, "sxe", {
      tenantId: ctx.tenantId,
      opts: { id: body?.id || null, limit: Math.min(100, body?.limit || 50) },
      replay: replayFor(svc, settings, ctx),
      isRecoverable: httpIsRecoverable,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...r });
  } catch (err) { sendError(res, err); }
}
