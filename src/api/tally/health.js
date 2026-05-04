// GET /api/tally/health
//
// Per-tenant Tally state. Returns:
//   - companies: list of configured tally_companies (token redacted)
//   - retry_pending / retry_gave_up counts
//   - recent_runs: last 20 sync_runs across companies
//   - voucher_state_count: number of mirrored vouchers
//   - payment_count + payment_total
//
// Pairs with /api/tally/diagnostics (real probe) for the Admin UI.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { isSecretsConfigured } from "../_lib/secrets.js";

const stripToken = (row) => {
  if (!row) return row;
  const { bridge_token, bridge_token_enc, bridge_iv, ...rest } = row;
  return { ...rest, bridge_token_set: !!(bridge_token || bridge_token_enc) };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();

    const [companies, runs, queued, gaveUp, voucherState, payments] = await Promise.all([
      svc.from("tally_companies").select("*").eq("tenant_id", ctx.tenantId)
        .order("is_default", { ascending: false }),
      svc.from("tally_sync_runs")
        .select("entity, status, run_started_at, run_finished_at, rows_pulled, rows_inserted, rows_updated, rows_errored, triggered_by, error, company_id")
        .eq("tenant_id", ctx.tenantId)
        .order("run_started_at", { ascending: false })
        .limit(20),
      svc.from("tally_retry_queue")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "pending"),
      svc.from("tally_retry_queue")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .eq("status", "gave_up"),
      svc.from("tally_voucher_state").select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId),
      svc.from("tally_payment_receipts")
        .select("amount")
        .eq("tenant_id", ctx.tenantId)
        .limit(2000),
    ]);

    const totalPayments = (payments.data || []).reduce(
      (s, r) => s + Number(r.amount || 0), 0);

    return json(res, 200, {
      companies: (companies.data || []).map(stripToken),
      configured: (companies.data || []).some((c) => !!c.bridge_url) || !!process.env.TALLY_BRIDGE_URL,
      secrets_key_present: isSecretsConfigured(),
      retry_pending: queued.count || 0,
      retry_gave_up: gaveUp.count || 0,
      voucher_state_count: voucherState.count || 0,
      payment_count: (payments.data || []).length,
      payment_total: totalPayments,
      recent_runs: runs.data || [],
    });
  } catch (err) {
    sendError(res, err);
  }
}
