// /api/tally/reconcile
//
// Phase F.6 completion. Two modes:
//
//   POST { mode: 'mark', orderId, status, tally_voucher_id? }
//     Legacy path: operator manually flips an order's tally_status.
//     Used by the existing tally-reconcile.tsx "Mark reconciled"
//     button. Preserved for back-compat.
//
//   POST { mode: 'drift_check', scope, scopeValue?, autoFix?, trigger? }
//     New: walks pushed vouchers in the scope, compares against
//     tally_voucher_state mirror, persists drift findings,
//     optionally auto-remediates. Returns the run summary.
//     scope = 'all' | 'tenant_recent' (default) | 'order'
//
//   GET ?run_id=<uuid>            -> returns run + its findings
//   GET ?order_id=<uuid>          -> returns latest run findings for an order
//   GET ?scope=runs&limit=N       -> recent runs list (history)
//   GET ?scope=findings&limit=N   -> recent unresolved findings
//   GET (no query)                -> tenant's most recent run summary
//
//   PATCH ?finding_id=<uuid>      -> mark a finding resolved

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { driftCheck, markStatus } from "../_lib/tally-reconciler.js";

const handlePost = async (req, res, ctx, svc, body) => {
  const mode = body?.mode || (body?.orderId && body?.status ? "mark" : "drift_check");

  if (mode === "mark") {
    requirePermission(ctx, "approve");
    if (!body?.orderId || !body?.status) {
      return json(res, 400, { error: { message: "orderId + status required for mark mode" } });
    }
    const allowed = new Set(["reconciled", "failed", "imported"]);
    if (!allowed.has(body.status)) {
      return json(res, 400, { error: { message: "status must be reconciled | failed | imported" } });
    }
    const out = await markStatus(svc, {
      tenantId: ctx.tenantId,
      orderId: body.orderId,
      status: body.status,
      tallyVoucherId: body.tally_voucher_id || null,
      triggeredBy: ctx.userId || null,
    });
    await recordAudit(ctx, {
      action: "tally_reconciled",
      objectType: "order",
      objectId: body.orderId,
      detail: body.status,
    });
    await recordEvent(ctx, {
      eventType: "tally_reconciled",
      objectType: "order",
      objectId: body.orderId,
      caseId: body.orderId,
      detail: { status: body.status, tally_voucher_id: body.tally_voucher_id || null },
    });
    return json(res, 200, { mode: "mark", ...out });
  }

  if (mode === "drift_check") {
    requirePermission(ctx, "write");
    // Bet 5: gate the drift-check endpoint on the paid add-on flag.
    // The legacy 'mark' mode (manual status flip) stays ungated;
    // it's part of base Tally functionality.
    const settingsResp = await svc.from("tenant_settings")
      .select("tally_drift_addon_enabled")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    const addonEnabled = !!settingsResp?.data?.tally_drift_addon_enabled;
    if (!addonEnabled) {
      return json(res, 402, { error: {
        code: "addon_required",
        message: "Tally drift reconciliation requires the Drift add-on. Enable it from Admin > Subscription.",
        upgrade_url: "/admin?tab=subscription&addon=drift",
      } });
    }
    const scope = body?.scope || "tenant_recent";
    const scopeValue = body?.scopeValue || body?.orderId || null;
    const autoFix = body?.autoFix;
    const trigger = body?.trigger || "manual";
    const result = await driftCheck(svc, {
      tenantId: ctx.tenantId,
      scope,
      scopeValue,
      autoFix,
      trigger,
      triggeredBy: ctx.userId || null,
    });
    await recordAudit(ctx, {
      action: result.vouchers_drifted > 0 ? "tally_drift_detected" : "tally_recon_run",
      objectType: "tally_reconciliation_run",
      objectId: result.run_id,
      detail: result.status + "::considered=" + result.vouchers_considered
        + "::drifted=" + result.vouchers_drifted
        + "::auto_fixes=" + result.auto_fixes_applied,
    });
    await recordEvent(ctx, {
      eventType: result.vouchers_drifted > 0 ? "tally_drift_detected" : "tally_recon_run",
      objectType: "tally_reconciliation_run",
      objectId: result.run_id,
      caseId: scopeValue || null,
      detail: result,
    });
    return json(res, 200, { mode: "drift_check", ...result });
  }

  return json(res, 400, { error: { message: "unknown mode: " + mode } });
};

const handleGet = async (req, res, ctx, svc) => {
  requirePermission(ctx, "read");
  const url = new URL(req.url || "", "http://x");
  const runId = url.searchParams.get("run_id");
  const orderId = url.searchParams.get("order_id");
  const scope = url.searchParams.get("scope");
  const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);

  if (runId) {
    const run = await svc.from("tally_reconciliation_runs").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", runId).maybeSingle();
    if (run.error) throw new Error(run.error.message);
    if (!run.data) return json(res, 404, { error: { message: "run not found" } });
    const findings = await svc.from("tally_reconciliation_findings")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("reconciliation_run_id", runId)
      .order("created_at", { ascending: true });
    return json(res, 200, { run: run.data, findings: findings.data || [] });
  }

  if (orderId) {
    const findings = await svc.from("tally_reconciliation_findings")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (findings.error) throw new Error(findings.error.message);
    const vrec = await svc.from("tally_voucher_records")
      .select("id, voucher_no, status, last_reconciled_at, last_drift_at, drift_summary")
      .eq("tenant_id", ctx.tenantId).eq("order_id", orderId).maybeSingle();
    return json(res, 200, {
      voucher_record: vrec.data || null,
      findings: findings.data || [],
    });
  }

  if (scope === "runs") {
    const runs = await svc.from("tally_reconciliation_runs")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .order("started_at", { ascending: false })
      .limit(limit);
    return json(res, 200, { runs: runs.data || [] });
  }

  if (scope === "findings") {
    const findings = await svc.from("tally_reconciliation_findings")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .is("resolved_at", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    return json(res, 200, { findings: findings.data || [] });
  }

  // Default GET (no params): latest run + add-on enablement state
  // so the frontend can render the upsell card or the live data.
  // Bet 5.
  const [latest, settings] = await Promise.all([
    svc.from("tally_reconciliation_runs")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.from("tenant_settings")
      .select("tally_drift_addon_enabled, tally_drift_addon_started_at, tally_drift_addon_billing_plan, tally_recon_total_tolerance_pct, tally_recon_auto_fix_enabled")
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle(),
  ]);
  return json(res, 200, {
    latest_run: latest.data || null,
    addon_enabled: !!settings?.data?.tally_drift_addon_enabled,
    addon_started_at: settings?.data?.tally_drift_addon_started_at || null,
    addon_billing_plan: settings?.data?.tally_drift_addon_billing_plan || null,
    tolerance_pct: settings?.data?.tally_recon_total_tolerance_pct ?? null,
    auto_fix_enabled: !!settings?.data?.tally_recon_auto_fix_enabled,
  });
};

const handlePatch = async (req, res, ctx, svc, body) => {
  requirePermission(ctx, "approve");
  const url = new URL(req.url || "", "http://x");
  const findingId = body?.finding_id || url.searchParams.get("finding_id");
  if (!findingId) return json(res, 400, { error: { message: "finding_id required" } });
  const upd = await svc.from("tally_reconciliation_findings").update({
    resolved_at: new Date().toISOString(),
    resolved_by: ctx.userId || null,
  }).eq("tenant_id", ctx.tenantId).eq("id", findingId).select("*").single();
  if (upd.error) throw new Error(upd.error.message);
  await recordAudit(ctx, {
    action: "tally_drift_resolved",
    objectType: "tally_reconciliation_finding",
    objectId: findingId,
    detail: upd.data?.finding_kind || "unknown",
  });
  return json(res, 200, { finding: upd.data });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "POST") {
      const body = await readBody(req);
      return handlePost(req, res, ctx, svc, body);
    }
    if (req.method === "GET") {
      return handleGet(req, res, ctx, svc);
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      return handlePatch(req, res, ctx, svc, body);
    }
    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
