// POST or GET /api/netsuite/retry
//
// Drains the netsuite_retry_queue, replaying queued sales-order
// pushes against NetSuite. Two trigger modes mirror /sync:
//   1. Cron (Bearer CRON_SECRET): walks every tenant, every pending
//      retry row whose next_attempt_at <= now().
//   2. Manual (admin user): scoped to caller's tenant. Body
//      { id?: <retry_row_id> } targets a single row, otherwise
//      drains the tenant's queue.
//
// Backoff schedule: 1m, 5m, 15m, 60m, 240m. After 5 attempts the
// row flips to status='gave_up' and the runner stops touching it.
// Successful retries flip the originating order's
// external_systems.netsuite.status to 'exported' and write
// audit + outcome events identical to a first-attempt push.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { netsuiteFetch, netsuiteIsConfigured } from "../_lib/netsuite-client.js";
import { decryptNetsuiteCreds } from "../_lib/secrets.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BACKOFF_MIN = [1, 5, 15, 60, 240, 720]; // minutes per attempt

const isRecoverable = (status) =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

const replayRow = async (svc, settings, row, ctx) => {
  const start = Date.now();
  let resp = null;
  try {
    resp = await netsuiteFetch(settings, {
      method: "POST",
      path: "/services/rest/record/v1/salesorder",
      body: row.payload,
    });
  } catch (err) {
    return await markFailure(svc, row, 0, err.message);
  }
  if (resp.ok) {
    const externalId = resp.body?.id || null;
    // Mark the queue row succeeded.
    await svc.from("netsuite_retry_queue").update({
      status: "succeeded",
      attempt_count: (row.attempt_count || 0) + 1,
      last_attempt_at: new Date().toISOString(),
      netsuite_id: externalId,
      last_error: null,
    }).eq("id", row.id);
    // Update the originating order.
    const orderQ = await svc.from("orders").select("*").eq("id", row.order_id).maybeSingle();
    if (orderQ.data) {
      const newResult = {
        ...(orderQ.data.result || {}),
        external_systems: {
          ...(orderQ.data.result?.external_systems || {}),
          netsuite: {
            id: externalId,
            external_id: externalId,
            status: "exported",
            last_attempt_at: new Date().toISOString(),
            last_status_code: resp.status,
            last_error: null,
          },
        },
      };
      await svc.from("orders").update({ result: newResult }).eq("id", orderQ.data.id);
    }
    if (ctx) {
      await recordAudit(ctx, {
        action: "netsuite_push",
        objectType: "order",
        objectId: row.order_id,
        detail: "retry_ok::ns_id=" + externalId + "::ms=" + (Date.now() - start),
      });
    }
    return { id: row.id, ok: true, netsuite_id: externalId };
  }
  if (!isRecoverable(resp.status)) {
    // Permanent failure: stop retrying.
    return await markGaveUp(svc, row, resp.status, JSON.stringify(resp.body).slice(0, 800));
  }
  return await markFailure(svc, row, resp.status, JSON.stringify(resp.body).slice(0, 800));
};

const markFailure = async (svc, row, status, error) => {
  const nextAttempt = (row.attempt_count || 0) + 1;
  if (nextAttempt >= (row.max_attempts || 5)) {
    return await markGaveUp(svc, row, status, error);
  }
  const minutes = BACKOFF_MIN[Math.min(nextAttempt, BACKOFF_MIN.length - 1)];
  await svc.from("netsuite_retry_queue").update({
    attempt_count: nextAttempt,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    last_error: error,
  }).eq("id", row.id);
  return { id: row.id, ok: false, attempt: nextAttempt, retry_in_min: minutes, error };
};

const markGaveUp = async (svc, row, status, error) => {
  await svc.from("netsuite_retry_queue").update({
    status: "gave_up",
    attempt_count: (row.attempt_count || 0) + 1,
    last_attempt_at: new Date().toISOString(),
    last_error: "gave_up::status=" + status + "::" + (error || ""),
  }).eq("id", row.id);
  // Flip the order so the UI shows we stopped trying.
  const orderQ = await svc.from("orders").select("*").eq("id", row.order_id).maybeSingle();
  if (orderQ.data) {
    const newResult = {
      ...(orderQ.data.result || {}),
      external_systems: {
        ...(orderQ.data.result?.external_systems || {}),
        netsuite: {
          ...(orderQ.data.result?.external_systems?.netsuite || {}),
          status: "gave_up",
          last_status_code: status,
          last_error: error,
          last_attempt_at: new Date().toISOString(),
        },
      },
    };
    await svc.from("orders").update({ result: newResult }).eq("id", orderQ.data.id);
  }
  return { id: row.id, gave_up: true, status, error };
};

const drainTenant = async (svc, tenantId, settingsRow, opts) => {
  const settings = decryptNetsuiteCreds(settingsRow);
  if (!netsuiteIsConfigured(settings)) {
    return { tenant_id: tenantId, skipped: true, reason: "not_configured" };
  }
  const q = svc.from("netsuite_retry_queue").select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(opts?.limit || 50);
  if (opts?.id) q.eq("id", opts.id);
  const rows = await q;
  if (rows.error) throw new Error("retry queue read: " + rows.error.message);
  const out = [];
  for (const row of rows.data || []) {
    out.push(await replayRow(svc, settings, row, opts?.ctx || null));
  }
  return { tenant_id: tenantId, processed: out.length, results: out };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    if (isCron) {
      // Find every tenant with pending retries and drain each.
      const tenants = await svc
        .from("netsuite_retry_queue")
        .select("tenant_id")
        .eq("status", "pending")
        .lte("next_attempt_at", new Date().toISOString());
      if (tenants.error) throw new Error("retry queue tenants: " + tenants.error.message);
      const uniq = Array.from(new Set((tenants.data || []).map((r) => r.tenant_id)));
      const out = [];
      for (const tid of uniq) {
        const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", tid).maybeSingle();
        if (!sRow.data) continue;
        out.push(await drainTenant(svc, tid, sRow.data, {}));
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }

    // Manual trigger.
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const sRow = await svc.from("tenant_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!sRow.data) return json(res, 404, { error: { message: "tenant has no settings row" } });
    const result = await drainTenant(svc, ctx.tenantId, sRow.data, {
      id: body?.id || null,
      limit: Math.min(100, body?.limit || 50),
      ctx,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) {
    sendError(res, err);
  }
}
