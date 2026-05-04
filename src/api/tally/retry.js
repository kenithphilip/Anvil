// POST or GET /api/tally/retry
//
// Drains tally_retry_queue. Two trigger modes:
//   1. Cron (Bearer CRON_SECRET): walks every tenant, every pending
//      retry row whose next_attempt_at <= now().
//   2. Manual (admin user): scoped to caller's tenant.
//
// Backoff schedule mirrors the NetSuite runner: 1m, 5m, 15m, 60m,
// 240m, 720m. After 5 attempts the row flips to status='gave_up'.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { tallyPush, tallyResolveCompany, tallyIsRecoverable } from "../_lib/tally-client.js";

const CRON_SECRET = process.env.CRON_SECRET;
const BACKOFF_MIN = [1, 5, 15, 60, 240, 720];

const extractVoucherId = (xml) => {
  if (!xml) return null;
  const m = String(xml).match(/<VOUCHERID>([^<]+)<\/VOUCHERID>/i)
    || String(xml).match(/<MASTERID>([^<]+)<\/MASTERID>/i);
  return m ? m[1] : null;
};

const markFailure = async (svc, row, status, err) => {
  const nextAttempt = (row.attempt_count || 0) + 1;
  if (nextAttempt >= (row.max_attempts || 5)) {
    return await markGaveUp(svc, row, status, err);
  }
  const minutes = BACKOFF_MIN[Math.min(nextAttempt, BACKOFF_MIN.length - 1)];
  await svc.from("tally_retry_queue").update({
    attempt_count: nextAttempt,
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    last_error: err,
  }).eq("id", row.id);
  return { id: row.id, ok: false, attempt: nextAttempt, retry_in_min: minutes, error: err };
};

const markGaveUp = async (svc, row, status, err) => {
  await svc.from("tally_retry_queue").update({
    status: "gave_up",
    attempt_count: (row.attempt_count || 0) + 1,
    last_attempt_at: new Date().toISOString(),
    last_error: "gave_up::status=" + status + "::" + (err || ""),
  }).eq("id", row.id);
  if (row.voucher_record_id) {
    await svc.from("tally_voucher_records").update({
      status: "failed",
      error: "gave_up::status=" + status + "::" + (err || ""),
    }).eq("id", row.voucher_record_id);
  }
  return { id: row.id, gave_up: true, status, error: err };
};

const replay = async (svc, row, ctx) => {
  const company = await tallyResolveCompany(svc, row.tenant_id, row.company_id);
  if (!company || !company.bridge_url) {
    return await markFailure(svc, row, 0, "bridge URL missing");
  }
  let resp = null;
  try {
    resp = await tallyPush(company, row.payload_xml);
  } catch (err) {
    return await markFailure(svc, row, 0, err.message);
  }
  if (resp.ok) {
    const externalId = extractVoucherId(resp.body);
    await svc.from("tally_retry_queue").update({
      status: "succeeded",
      attempt_count: (row.attempt_count || 0) + 1,
      last_attempt_at: new Date().toISOString(),
      last_error: null,
    }).eq("id", row.id);
    if (row.voucher_record_id) {
      await svc.from("tally_voucher_records").update({
        status: "exported",
        imported_at: new Date().toISOString(),
        external_voucher_no: externalId,
        tally_voucher_id: externalId,
        last_attempt_at: new Date().toISOString(),
        attempt_count: (row.attempt_count || 0) + 1,
        error: null,
      }).eq("id", row.voucher_record_id);
    }
    if (row.order_id) {
      await svc.from("orders").update({
        tally_status: "exported",
        status: "EXPORTED_TO_TALLY",
      }).eq("id", row.order_id);
    }
    if (ctx) {
      await recordAudit(ctx, {
        action: "tally_push",
        objectType: "order",
        objectId: row.order_id,
        detail: "retry_ok::voucher=" + externalId,
      });
    }
    return { id: row.id, ok: true, voucher_id: externalId };
  }
  if (!tallyIsRecoverable(resp.status)) {
    return await markGaveUp(svc, row, resp.status, String(resp.body).slice(0, 800));
  }
  return await markFailure(svc, row, resp.status, String(resp.body).slice(0, 800));
};

const drainTenant = async (svc, tenantId, opts) => {
  const q = svc.from("tally_retry_queue").select("*")
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
    out.push(await replay(svc, row, opts?.ctx || null));
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
      const tenants = await svc.from("tally_retry_queue")
        .select("tenant_id")
        .eq("status", "pending")
        .lte("next_attempt_at", new Date().toISOString());
      if (tenants.error) throw new Error("retry tenants: " + tenants.error.message);
      const uniq = Array.from(new Set((tenants.data || []).map((r) => r.tenant_id)));
      const out = [];
      for (const tid of uniq) {
        out.push(await drainTenant(svc, tid, {}));
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = req.method === "POST" ? await readBody(req) : {};
    const result = await drainTenant(svc, ctx.tenantId, {
      id: body?.id || null,
      limit: Math.min(100, body?.limit || 50),
      ctx,
    });
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) {
    sendError(res, err);
  }
}
