// Tally reconciliation engine.
//
// Phase F.6 completion. Compares what we pushed to Tally against
// what Tally reports back via tally_voucher_state (mirror) +
// optional bridge call, produces structured findings, optionally
// auto-remediates.
//
// Two modes:
//
//   driftCheck(svc, { tenantId, scope, scopeValue, runId })
//     -- The reconciliation flow. Walks pushed vouchers, pulls
//     tally_voucher_state for each, compares totals + line counts +
//     voucher numbers + cancelled/altered flags, persists findings,
//     applies auto-fix when enabled, updates per-voucher rollup.
//
//   markStatus(svc, { tenantId, orderId, status, voucherId })
//     -- The legacy /api/tally/reconcile semantic: operator
//     manually flips an order's tally_status. Kept for back-compat
//     with the existing UI button.
//
// Both modes write a tally_reconciliation_runs row at start +
// finish. driftCheck additionally writes tally_reconciliation_findings
// rows + updates tally_voucher_records.{last_reconciled_at,
// last_drift_at, drift_summary}.
//
// Pure orchestration: this module never returns HTTP responses;
// callers handle that.

import { tallyResolveCompany } from "./tally-client.js";

const DEFAULT_TOLERANCE_PCT = 0.50;
const MAX_BATCH = 100;                       // per-run cap so a stuck cron doesn't burn

// ---------- comparison helpers ------------------------------------

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Best-effort total extraction from the order's result blob. Falls
// back to grand_total / total / amount as a chain so v1 and v2 row
// shapes both work.
const expectedTotalFromOrder = (order) => {
  const r = order?.result?.salesOrder || order?.result || {};
  const t = r.grand_total ?? r.total ?? r.amount ?? r.line_total_sum ?? null;
  if (t == null) return null;
  return Number(t);
};

const expectedLineCount = (order) => {
  const lines = order?.result?.salesOrder?.lineItems
    || order?.result?.lineItems
    || order?.result?.lines
    || [];
  return Array.isArray(lines) ? lines.length : 0;
};

const expectedGstin = (order) => {
  const c = order?.result?.salesOrder?.customer || order?.result?.customer || {};
  return c.gstin || null;
};

const expectedVoucherDate = (order) => {
  const r = order?.result?.salesOrder || order?.result || {};
  return r.po_date || r.voucher_date || r.date || null;
};

// ---------- finding builders --------------------------------------

const totalMismatchFinding = ({ tenantId, runId, vrec, expected, actual, tolerancePct }) => {
  const diffPct = expected > 0 ? ((actual - expected) / expected) * 100 : null;
  const within = diffPct == null ? false : Math.abs(diffPct) <= tolerancePct;
  if (within) return null;
  return {
    tenant_id: tenantId,
    reconciliation_run_id: runId,
    tally_voucher_record_id: vrec.id,
    order_id: vrec.order_id,
    voucher_no: vrec.voucher_no,
    finding_kind: "total_mismatch",
    severity: Math.abs(diffPct || 0) > 5 ? "error" : "warn",
    expected: { total: round2(expected) },
    actual: { total: round2(actual) },
    diff_pct: round2(diffPct || 0),
  };
};

const lineCountMismatchFinding = ({ tenantId, runId, vrec, expected, actual }) => {
  if (expected == null || actual == null || Number(expected) === Number(actual)) return null;
  return {
    tenant_id: tenantId,
    reconciliation_run_id: runId,
    tally_voucher_record_id: vrec.id,
    order_id: vrec.order_id,
    voucher_no: vrec.voucher_no,
    finding_kind: "line_count_mismatch",
    severity: "warn",
    expected: { line_count: Number(expected) },
    actual: { line_count: Number(actual) },
  };
};

const voucherCancelledFinding = ({ tenantId, runId, vrec }) => ({
  tenant_id: tenantId,
  reconciliation_run_id: runId,
  tally_voucher_record_id: vrec.id,
  order_id: vrec.order_id,
  voucher_no: vrec.voucher_no,
  finding_kind: "voucher_cancelled_in_tally",
  severity: "critical",
  expected: { state: "active" },
  actual: { state: "cancelled" },
});

const voucherAlteredFinding = ({ tenantId, runId, vrec }) => ({
  tenant_id: tenantId,
  reconciliation_run_id: runId,
  tally_voucher_record_id: vrec.id,
  order_id: vrec.order_id,
  voucher_no: vrec.voucher_no,
  finding_kind: "voucher_altered_in_tally",
  severity: "warn",
  expected: { state: "as_pushed" },
  actual: { state: "altered" },
});

const missingInTallyFinding = ({ tenantId, runId, vrec }) => ({
  tenant_id: tenantId,
  reconciliation_run_id: runId,
  tally_voucher_record_id: vrec.id,
  order_id: vrec.order_id,
  voucher_no: vrec.voucher_no,
  finding_kind: "missing_in_tally",
  severity: "error",
  expected: { exists: true },
  actual: { exists: false },
});

const gstinMismatchFinding = ({ tenantId, runId, vrec, expected, actual }) => {
  if (!expected || !actual || expected === actual) return null;
  return {
    tenant_id: tenantId,
    reconciliation_run_id: runId,
    tally_voucher_record_id: vrec.id,
    order_id: vrec.order_id,
    voucher_no: vrec.voucher_no,
    finding_kind: "gstin_mismatch",
    severity: "warn",
    expected: { gstin: expected },
    actual: { gstin: actual },
  };
};

// ---------- core: compare one voucher -----------------------------

const compareOne = ({ tenantId, runId, vrec, order, tallyState, tolerancePct }) => {
  const findings = [];

  if (!tallyState) {
    findings.push(missingInTallyFinding({ tenantId, runId, vrec }));
    return findings;
  }
  if (tallyState.cancelled) {
    findings.push(voucherCancelledFinding({ tenantId, runId, vrec }));
  }
  if (tallyState.altered && !tallyState.cancelled) {
    findings.push(voucherAlteredFinding({ tenantId, runId, vrec }));
  }

  const expectedTotal = expectedTotalFromOrder(order);
  const actualTotal = tallyState.total != null ? Number(tallyState.total) : null;
  if (expectedTotal != null && actualTotal != null) {
    const f = totalMismatchFinding({
      tenantId, runId, vrec,
      expected: expectedTotal,
      actual: actualTotal,
      tolerancePct,
    });
    if (f) findings.push(f);
  }

  const expectedLines = expectedLineCount(order);
  const actualLines = tallyState.line_count != null
    ? Number(tallyState.line_count)
    : (tallyState.raw?.lines?.length ?? null);
  const lineFinding = lineCountMismatchFinding({
    tenantId, runId, vrec,
    expected: expectedLines,
    actual: actualLines,
  });
  if (lineFinding) findings.push(lineFinding);

  const expectedG = expectedGstin(order);
  const actualG = tallyState.party_gstin || tallyState.raw?.party_gstin || null;
  const gFinding = gstinMismatchFinding({
    tenantId, runId, vrec, expected: expectedG, actual: actualG,
  });
  if (gFinding) findings.push(gFinding);

  return findings;
};

// ---------- auto-fix paths ----------------------------------------

const applyAutoFix = async (svc, finding, vrec) => {
  if (finding.finding_kind === "voucher_cancelled_in_tally") {
    // Mark the order as failed so the operator sees it on the
    // tally-reconcile screen + the SO workspace banner.
    if (vrec.order_id) {
      await svc.from("orders").update({
        tally_status: "failed",
        status: "FAILED_TALLY_IMPORT",
      }).eq("id", vrec.order_id).eq("tenant_id", finding.tenant_id);
    }
    await svc.from("tally_voucher_records").update({
      status: "failed",
      error: "voucher cancelled in Tally; reconciler flagged",
    }).eq("id", vrec.id);
    return "order_failed";
  }
  if (finding.finding_kind === "missing_in_tally") {
    // Re-enqueue for retry. The retry queue's existing logic
    // re-pushes the voucher.
    await svc.from("tally_retry_queue").insert({
      tenant_id: finding.tenant_id,
      tally_voucher_record_id: vrec.id,
      attempt: 0,
      next_attempt_at: new Date().toISOString(),
      reason: "reconciler_missing_in_tally",
    });
    return "re_pushed";
  }
  // For total_mismatch and line_count_mismatch we don't auto-fix
  // (could have legitimate causes like partial deliveries). The
  // operator reviews on the workspace.
  return "none";
};

// ---------- per-voucher rollup update -----------------------------

const updateVoucherRollup = async (svc, vrec, findings, now) => {
  const summary = {};
  let driftAt = null;
  for (const f of findings) {
    summary[f.finding_kind] = (summary[f.finding_kind] || 0) + 1;
    driftAt = now;
  }
  await svc.from("tally_voucher_records").update({
    last_reconciled_at: now,
    last_drift_at: driftAt,
    drift_summary: summary,
  }).eq("id", vrec.id);
};

// ---------- public: driftCheck ------------------------------------

// Walks pushed vouchers in scope, runs comparison, persists
// findings, optionally auto-fixes. Returns the run summary.
//
// scope:
//   'all'            every pushed voucher for this tenant
//   'tenant_recent'  pushed in last 7 days
//   'order'          one specific order_id (scopeValue = order_id)
//   'order_id'       legacy alias for 'order'
export const driftCheck = async (svc, params) => {
  const {
    tenantId,
    scope = "tenant_recent",
    scopeValue = null,
    triggeredBy = null,
    trigger = "manual",
    autoFix,                                      // optional bool override
  } = params;

  const t0 = Date.now();
  const tolerancePct = await loadTolerance(svc, tenantId);
  const autoFixEnabled = autoFix == null
    ? await loadAutoFix(svc, tenantId)
    : !!autoFix;

  const runIns = await svc.from("tally_reconciliation_runs").insert({
    tenant_id: tenantId,
    trigger,
    scope: scope === "order_id" ? "order" : scope,
    scope_value: scopeValue,
    triggered_by: triggeredBy,
  }).select("*").single();
  if (runIns.error) throw new Error(runIns.error.message);
  const runId = runIns.data.id;

  // Pull candidate voucher records.
  let q = svc.from("tally_voucher_records")
    .select("id, order_id, voucher_no, voucher_type, status, payload_hash, external_voucher_no, tally_voucher_id")
    .eq("tenant_id", tenantId)
    .eq("status", "exported")
    .limit(MAX_BATCH);
  if (scope === "order" || scope === "order_id") {
    q = q.eq("order_id", scopeValue);
  } else if (scope === "tenant_recent") {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    q = q.gte("created_at", since);
  }
  const vrecs = await q;
  if (vrecs.error) throw new Error(vrecs.error.message);

  const candidates = vrecs.data || [];
  let driftedCount = 0;
  let cleanCount = 0;
  let autoFixCount = 0;
  let bridgeCalls = 0;
  let findingsTotal = 0;
  let runErr = null;

  const now = new Date().toISOString();

  for (const vrec of candidates) {
    try {
      // Fetch the order and the Tally-side state in parallel.
      const [orderResp, stateResp] = await Promise.all([
        vrec.order_id
          ? svc.from("orders")
              .select("id, tenant_id, status, result, tally_status")
              .eq("id", vrec.order_id)
              .eq("tenant_id", tenantId)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        svc.from("tally_voucher_state")
          .select("voucher_no, total, line_count, party_gstin, altered, cancelled, raw, last_seen_at")
          .eq("tenant_id", tenantId)
          .eq("voucher_no", vrec.voucher_no)
          .maybeSingle(),
      ]);

      const order = orderResp?.data || null;
      const tallyState = stateResp?.data || null;
      const findings = compareOne({
        tenantId,
        runId,
        vrec,
        order,
        tallyState,
        tolerancePct,
      });

      if (findings.length === 0) {
        cleanCount++;
        await svc.from("tally_voucher_records").update({
          last_reconciled_at: now,
          last_drift_at: null,
          drift_summary: {},
        }).eq("id", vrec.id);
        continue;
      }

      driftedCount++;
      findingsTotal += findings.length;

      // Optional auto-fix on the highest-severity finding only.
      if (autoFixEnabled) {
        const sevOrder = ["critical", "error", "warn", "info"];
        findings.sort((a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity));
        const target = findings[0];
        const fix = await applyAutoFix(svc, target, vrec);
        if (fix !== "none") {
          target.auto_fix_applied = fix;
          autoFixCount++;
        }
      }

      const ins = await svc.from("tally_reconciliation_findings").insert(findings);
      if (ins.error) {
        /* eslint-disable no-console */
        console.warn("[tally-reconciler] findings insert failed: " + ins.error.message);
      }

      await updateVoucherRollup(svc, vrec, findings, now);
    } catch (e) {
      runErr = e?.message || String(e);
      /* eslint-disable no-console */
      console.warn("[tally-reconciler] vrec " + vrec.id + " failed: " + runErr);
    }
  }

  const status = runErr
    ? (driftedCount + cleanCount > 0 ? "partial_failure" : "failed")
    : "ok";

  await svc.from("tally_reconciliation_runs").update({
    vouchers_considered: candidates.length,
    vouchers_drifted: driftedCount,
    vouchers_clean: cleanCount,
    findings_persisted: findingsTotal,
    auto_fixes_applied: autoFixCount,
    bridge_calls: bridgeCalls,
    latency_ms: Date.now() - t0,
    status,
    error: runErr ? runErr.slice(0, 1000) : null,
    finished_at: new Date().toISOString(),
  }).eq("id", runId);

  return {
    run_id: runId,
    status,
    vouchers_considered: candidates.length,
    vouchers_drifted: driftedCount,
    vouchers_clean: cleanCount,
    findings_persisted: findingsTotal,
    auto_fixes_applied: autoFixCount,
    latency_ms: Date.now() - t0,
    error: runErr,
  };
};

// ---------- legacy: markStatus ------------------------------------

// Preserves the v1 /api/tally/reconcile semantic where the operator
// flips an order's tally_status manually.
export const markStatus = async (svc, params) => {
  const { tenantId, orderId, status, tallyVoucherId, triggeredBy } = params;
  if (!orderId || !status) throw new Error("orderId + status required");
  const orderUpdate = await svc.from("orders").update({
    tally_status: status,
    status: status === "reconciled" ? "TALLY_RECONCILED"
      : status === "failed" ? "FAILED_TALLY_IMPORT"
      : status === "imported" ? "TALLY_IMPORTED"
      : null,
  }).eq("id", orderId).eq("tenant_id", tenantId).select("*").single();
  if (orderUpdate.error) throw new Error(orderUpdate.error.message);

  if (tallyVoucherId) {
    await svc.from("tally_voucher_records").update({
      tally_voucher_id: tallyVoucherId,
      status: status === "failed" ? "failed" : "exported",
    }).eq("tenant_id", tenantId).eq("order_id", orderId);
  }

  // Audit the manual flip via a minimal reconciliation_runs row so
  // the diagnostics tab can show "user X manually marked Y on date Z".
  await svc.from("tally_reconciliation_runs").insert({
    tenant_id: tenantId,
    trigger: "manual",
    scope: "order",
    scope_value: orderId,
    vouchers_considered: 1,
    vouchers_clean: status === "reconciled" || status === "imported" ? 1 : 0,
    vouchers_drifted: status === "failed" ? 1 : 0,
    findings_persisted: 0,
    auto_fixes_applied: 0,
    bridge_calls: 0,
    triggered_by: triggeredBy,
    status: "ok",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });

  return { order: orderUpdate.data };
};

// ---------- helpers -----------------------------------------------

const loadTolerance = async (svc, tenantId) => {
  try {
    const r = await svc.from("tenant_settings")
      .select("tally_recon_total_tolerance_pct")
      .eq("tenant_id", tenantId).maybeSingle();
    const v = Number(r?.data?.tally_recon_total_tolerance_pct);
    if (Number.isFinite(v) && v >= 0) return v;
  } catch (_e) { /* fall through */ }
  return DEFAULT_TOLERANCE_PCT;
};

const loadAutoFix = async (svc, tenantId) => {
  try {
    const r = await svc.from("tenant_settings")
      .select("tally_recon_auto_fix_enabled")
      .eq("tenant_id", tenantId).maybeSingle();
    return !!r?.data?.tally_recon_auto_fix_enabled;
  } catch (_e) { return false; }
};

// Exported for tests + future drilldowns.
export const __test__ = {
  compareOne,
  expectedTotalFromOrder,
  expectedLineCount,
  expectedGstin,
  totalMismatchFinding,
  lineCountMismatchFinding,
  voucherCancelledFinding,
  voucherAlteredFinding,
  missingInTallyFinding,
  gstinMismatchFinding,
  DEFAULT_TOLERANCE_PCT,
};

// Re-export used by callers that want to fetch a tenant's company on demand.
export { tallyResolveCompany };
