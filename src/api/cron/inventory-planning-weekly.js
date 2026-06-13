// GET /api/cron/inventory-planning-weekly
//
// Weekly cron (default Monday 02:00 IST). Per tenant + per
// planning-enabled item:
//
//   1. Pull last 104 weeks of demand history.
//   2. Classify the demand shape.
//   3. Pick a forecaster from the model menu.
//   4. Compute decomposed forecast: committed + pipeline + baseline.
//   5. Estimate lead-time mean + sigma (gamma fit).
//   6. Compute safety stock + reorder point.
//   7. Compute the net-requirement curve.
//   8. If a shortage is found, draft a procurement_plans row.
//   9. Persist demand_forecasts + procurement_plans + forecast_runs.
//
// Idempotent on second-run: the demand_forecasts unique key catches
// duplicates; procurement_plans rows are draft and the operator can
// decline existing drafts before approval.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordCronHeartbeat } from "../_lib/cron-mux.js";
import { recordAudit } from "../_lib/audit.js";
import { classifyDemand } from "../_lib/inventory/classify.js";
import { pickForecaster, residualSigma, wape } from "../_lib/inventory/forecast.js";
import { safetyStock } from "../_lib/inventory/safety-stock.js";
import {
  selectAndComputeCP, intervalForForecast, safetyStockFromInterval,
  scaleIntervalToLTD,
} from "../_lib/inventory/conformal.js";
import { estimateLeadTime } from "../_lib/inventory/lead-time.js";
import {
  computePipelineDemand, isoWeekStart, STAGE_PROBABILITY_DEFAULTS,
  calibrateStageProbabilities, explodePipelineThroughBom,
} from "../_lib/inventory/pipeline-demand.js";
import { planForItem, addWeeks } from "../_lib/inventory/net-req.js";

// Phase 3.5: per-class default service level when item.service_level
// is null. Mirrors docs/INVENTORY_PLANNING_DESIGN.md section 2.9.
const SL_BY_TYPE = {
  ATD: 0.99, TIMER: 0.99,                   // critical bundled
  GUN: 0.95, GUN_COMPONENT: 0.95,           // standard
  RAW_MATERIAL: 0.95,                        // P2: production inputs
  SPARE: 0.85, CONSUMABLE: 0.85,            // long tail
  OTHER: 0.95,
};
const defaultServiceLevel = (itemType, tenantDefault) =>
  (itemType && SL_BY_TYPE[itemType]) || tenantDefault || 0.95;

// Phase 3.5: project-equivalent floor (doc 2.3.3). Read from
// equipment_installed_parts.recommended_qty_180d for the modal gun
// model, falling back to BOM walk for an item type that ships
// bundled with a parent (ATD / TIMER ride along with a Gun).
//
// We pick the median of recommended_qty_180d across installed
// instances; if the item isn't tracked in equipment_installed_parts
// we fall back to BOM walk via v_bom_walk_recursive.
const projectEquivalentForPart = async (svc, tenantId, partNo) => {
  const eip = await svc.from("equipment_installed_parts")
    .select("recommended_qty_180d")
    .eq("tenant_id", tenantId)
    .eq("part_no", partNo)
    .not("recommended_qty_180d", "is", null);
  const values = (eip.data || []).map((r) => Number(r.recommended_qty_180d)).filter((v) => v > 0);
  if (values.length) {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }
  // BOM-walk fallback: how many of `partNo` does the modal gun
  // consume? Read v_bom_walk_recursive for any root that pulls in
  // this child and take the max as the project-equivalent.
  const walk = await svc.from("v_bom_walk_recursive")
    .select("total_qty")
    .eq("child_part_no", partNo)
    .order("total_qty", { ascending: false })
    .limit(1);
  const walkRow = walk.data?.[0];
  if (walkRow?.total_qty) return Number(walkRow.total_qty);
  return 1;     // safest non-zero fallback
};

// Phase 3.5: hysteresis. The plan-emit signal must be stable across
// N consecutive weekly runs (default 2 per tenant_settings) before
// we draft a new procurement_plans row. We read the most recent N
// forecast_runs and check whether each contained the part among
// its plans (via models_evaluated.shortages or wape_summary; the
// latter rolls up only WAPE so we use a small lookup table on
// procurement_plans for the "did this part show a shortage in the
// previous run" signal).
const hysteresisOK = async (svc, tenantId, partNo, requiredStreak) => {
  if (requiredStreak <= 1) return { ok: true, streak: 1 };
  // We use the existence of any DRAFT/APPROVED plan for this part
  // in the last (requiredStreak * 7) days as evidence of a prior
  // shortage detection. This is approximate (a part could have
  // had a plan for a different week) but is good enough for
  // hysteresis: persistent shortages produce persistent plans.
  const sinceISO = new Date(Date.now() - requiredStreak * 7 * 86400_000).toISOString();
  const r = await svc.from("procurement_plans")
    .select("id, created_at")
    .eq("tenant_id", tenantId)
    .eq("part_no", partNo)
    .in("status", ["draft", "approved", "released"])
    .gte("created_at", sinceISO);
  const streak = (r.data || []).length + 1;
  return { ok: streak >= requiredStreak, streak };
};

const CRON_SECRET = process.env.CRON_SECRET;
const HISTORY_WEEKS = 104;
const DEFAULT_HORIZON = 12;

// -------------------------------------------------------------------
// History assembly: walk orders + order_schedule_lines and bucket
// the consumed qty per (part_no, week_start). Returns
// Map<part_no, Map<weekKey, qty>>.
const buildHistory = async (svc, tenantId, parts) => {
  const out = new Map(parts.map((p) => [p, new Map()]));
  // Use schedule_lines (relational, structured) when present;
  // otherwise the engine treats the order's line_items JSONB.
  const sched = await svc.from("order_schedule_lines")
    .select("part_no, scheduled_qty, scheduled_date")
    .eq("tenant_id", tenantId)
    .gte("scheduled_date", addWeeks(isoWeekStart(new Date()), -HISTORY_WEEKS))
    .in("part_no", parts);
  if (sched.error) throw new Error("history/schedule_lines: " + sched.error.message);
  for (const row of (sched.data || [])) {
    const wk = isoWeekStart(row.scheduled_date);
    if (!wk) continue;
    const map = out.get(row.part_no);
    if (!map) continue;
    map.set(wk, (map.get(wk) || 0) + (Number(row.scheduled_qty) || 0));
  }
  return out;
};

// -------------------------------------------------------------------
// Phase 3.5: stage-probability calibration. Walks closed opps from
// the last 365 days, computes win-rate per max_stage, and returns
// the calibration map for `computePipelineDemand`.
const buildStageCalibration = async (svc, tenantId) => {
  const sinceISO = new Date(Date.now() - 365 * 86400_000).toISOString();
  const closed = await svc.from("opportunities")
    .select("stage")
    .eq("tenant_id", tenantId)
    .in("stage", ["CLOSE_WON", "CLOSE_LOST", "REGRETTED"])
    .gte("updated_at", sinceISO);
  if (closed.error) return null;
  // The opportunities schema doesn't track max_stage history, so we
  // use the final stage as the max stage proxy (close_won/_lost) and
  // the calibrator's defaults for everything else. The full stage
  // history calibration is a Phase 4 follow-up that requires either
  // an opp_stage_history table or a CDC stream.
  const history = (closed.data || []).map((o) => ({
    final_stage: o.stage,
    max_stage: o.stage,
  }));
  return calibrateStageProbabilities(history);
};

// -------------------------------------------------------------------
// Pipeline demand: read opportunities + opportunity_line_items.
const buildPipeline = async (svc, tenantId, weeks, calibration) => {
  const opps = await svc.from("opportunities")
    .select("id, stage, probability, close_date")
    .eq("tenant_id", tenantId)
    .not("stage", "in", "(CLOSE_LOST,REGRETTED)");
  if (opps.error) throw new Error("pipeline/opportunities: " + opps.error.message);
  if (!(opps.data || []).length) return new Map();
  const oppIds = opps.data.map((o) => o.id);
  const lines = await svc.from("opportunity_line_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("opportunity_id", oppIds);
  if (lines.error) throw new Error("pipeline/lines: " + lines.error.message);
  const linesByOpp = new Map();
  for (const ln of (lines.data || [])) {
    if (!linesByOpp.has(ln.opportunity_id)) linesByOpp.set(ln.opportunity_id, []);
    linesByOpp.get(ln.opportunity_id).push(ln);
  }
  const pairs = opps.data.map((opp) => ({ opp, lines: linesByOpp.get(opp.id) || [] }));
  return computePipelineDemand({ pairs, calibration });
};

// -------------------------------------------------------------------
// Lead-time samples for a supplier from source_pos + source_po_lines.
// Returns deltas in days between acknowledged_eta and received_at.
const buildLeadTimeSamples = async (svc, tenantId, supplierId) => {
  if (!supplierId) return [];
  const r = await svc.from("source_po_lines")
    .select("acknowledged_eta, received_at, source_po_id, source_pos:source_po_id(supplier_id)")
    .eq("tenant_id", tenantId)
    .not("received_at", "is", null);
  if (r.error || !r.data) return [];
  const deltas = [];
  for (const row of r.data) {
    if (row.source_pos?.supplier_id !== supplierId) continue;
    if (!row.acknowledged_eta || !row.received_at) continue;
    const a = new Date(row.acknowledged_eta);
    const b = new Date(row.received_at);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) continue;
    const days = (b.getTime() - a.getTime()) / 86400000;
    deltas.push(days);
  }
  return deltas;
};

// -------------------------------------------------------------------
// Top-N opportunity contributions for the rationale jsonb.
const topOppsForPart = (pairs, partNo, n = 3) => {
  const contrib = [];
  for (const { opp, lines } of pairs) {
    const totalQty = (lines || []).reduce((s, l) => s + (l.part_no === partNo ? (Number(l.qty) || 0) : 0), 0);
    if (totalQty <= 0) continue;
    const prob = typeof opp.probability === "number" ? opp.probability : (STAGE_PROBABILITY_DEFAULTS[opp.stage] || 0);
    contrib.push({
      opp_id: opp.id,
      opportunity_name: opp.opportunity_name,
      stage: opp.stage,
      qty: totalQty,
      probability: prob,
      expected_qty: totalQty * prob,
    });
  }
  contrib.sort((a, b) => b.expected_qty - a.expected_qty);
  return contrib.slice(0, n);
};

// -------------------------------------------------------------------
// Plan one tenant. Returns a summary suitable for the cron heartbeat.
const planTenant = async (svc, tenantId) => {
  const settings = await svc.from("tenant_settings").select("*")
    .eq("tenant_id", tenantId).single();
  if (settings.error) throw new Error("settings: " + settings.error.message);
  const cfg = settings.data;
  if (!cfg.inventory_planning_enabled) return { tenant_id: tenantId, skipped: true };

  const items = await svc.from("item_master")
    .select("part_no, item_type, default_supplier_id, service_level, holding_cost_pct_override, coverage_period_weeks, default_lead_days, moq, pack_size, rounding_rule, purchase_price, demand_class, pinned_model, conformal_coverage, conformal_method_override")
    .eq("tenant_id", tenantId)
    .eq("planning_enabled", true);
  if (items.error) throw new Error("items: " + items.error.message);
  if (!(items.data || []).length) return { tenant_id: tenantId, items_planned: 0 };
  const parts = items.data.map((i) => i.part_no);

  // Open the run row.
  const runIns = await svc.from("forecast_runs").insert({
    tenant_id: tenantId,
    status: "running",
    items_count: parts.length,
  }).select("id").single();
  if (runIns.error) throw new Error("forecast_runs/insert: " + runIns.error.message);
  const runId = runIns.data.id;

  // Latest position per item.
  const positions = await svc.from("inventory_positions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("source", "union")
    .in("part_no", parts)
    .order("as_of", { ascending: false })
    .limit(parts.length * 5);
  if (positions.error) throw new Error("positions: " + positions.error.message);
  const positionByPart = new Map();
  for (const p of (positions.data || [])) {
    if (!positionByPart.has(p.part_no)) positionByPart.set(p.part_no, p);
  }

  // History + pipeline (with calibrated stage probabilities).
  const horizonWeeks = cfg.inventory_forecast_horizon_weeks || DEFAULT_HORIZON;
  const today = isoWeekStart(new Date());
  const weeks = Array.from({ length: horizonWeeks }, (_, i) => addWeeks(today, i));
  const history = await buildHistory(svc, tenantId, parts);
  const calibration = await buildStageCalibration(svc, tenantId);
  const pipeline = await buildPipeline(svc, tenantId, weeks, calibration);

  // P2: BOM-explode demand. Cascade finished-good pipeline demand down
  // the tenant's bill of materials into the raw materials / components
  // it consumes, so RAW_MATERIAL (and any planning-enabled child) parts
  // receive procurement plans driven by upstream sales pipeline. Read
  // bill_of_materials directly (tenant-scoped column) rather than the
  // v_bom_walk_recursive view, which has no tenant_id to filter on.
  // Inert for tenants without a BOM.
  const bomRows = await svc.from("bill_of_materials")
    .select("parent_part_no, child_part_no, qty")
    .eq("tenant_id", tenantId);
  if (bomRows.error) throw new Error("bom: " + bomRows.error.message);
  const bomExplosion = explodePipelineThroughBom(pipeline, bomRows.data || []);

  // Pre-fetch the opportunity pairs for top-opp attribution.
  const oppsForAttribution = await svc.from("opportunities")
    .select("id, opportunity_name, stage, probability")
    .eq("tenant_id", tenantId)
    .not("stage", "in", "(CLOSE_LOST,REGRETTED)");
  const oppIds = (oppsForAttribution.data || []).map((o) => o.id);
  const linesAttribution = oppIds.length ? await svc.from("opportunity_line_items")
    .select("*").eq("tenant_id", tenantId).in("opportunity_id", oppIds) : { data: [] };
  const linesByOppId = new Map();
  for (const ln of (linesAttribution.data || [])) {
    if (!linesByOppId.has(ln.opportunity_id)) linesByOppId.set(ln.opportunity_id, []);
    linesByOppId.get(ln.opportunity_id).push(ln);
  }
  const oppPairs = (oppsForAttribution.data || []).map((opp) => ({
    opp, lines: linesByOppId.get(opp.id) || [],
  }));

  // Bet 3: pull rolling residuals per part for CP. Done as one
  // round trip outside the loop so we don't fire N queries when N
  // is large. The residuals table is RLS-scoped to the tenant.
  // Residuals come back oldest -> newest (NEXCP requires
  // time-ordered input). We cap at 156 weeks (3 years) to keep
  // weight decay meaningful.
  const conformalOn = !!cfg.inventory_conformal_enabled;
  const cohortResiduals = {};
  const residualsByPart = new Map();
  if (conformalOn) {
    const r = await svc.from("conformal_calibration_residuals")
      .select("part_no, week_start, residual")
      .eq("tenant_id", tenantId)
      .in("part_no", parts)
      .order("week_start", { ascending: true })
      .limit(parts.length * 156);
    for (const row of (r.data || [])) {
      const v = Number(row.residual);
      if (!Number.isFinite(v)) continue;
      const list = residualsByPart.get(row.part_no) || [];
      list.push(v);
      residualsByPart.set(row.part_no, list);
    }
    // Build cohort pools keyed by item_type for cold-start.
    for (const it of items.data) {
      const key = it.item_type || "OTHER";
      cohortResiduals[key] = cohortResiduals[key] || [];
      const own = residualsByPart.get(it.part_no) || [];
      cohortResiduals[key].push(...own);
    }
  }

  // Per-item planning loop.
  const forecastRows = [];
  const planRows = [];
  let modelsEvaluated = {};
  let waperSum = 0;
  let waperCount = 0;
  let conformalUsed = 0;
  for (const item of items.data) {
    // Convert history map to chronological array.
    const histMap = history.get(item.part_no) || new Map();
    const histKeys = Array.from(histMap.keys()).sort();
    const histArr = histKeys.map((k) => histMap.get(k) || 0);
    // Pad to HISTORY_WEEKS if shorter (zeros fill).
    while (histArr.length < HISTORY_WEEKS) histArr.unshift(0);

    const cls = classifyDemand(histArr);
    const forecaster = item.pinned_model
      ? pickForecaster(item.pinned_model.toLowerCase())
      : pickForecaster(cls.class);
    const wapeNow = wape(histArr, forecaster, 4);
    if (wapeNow != null) { waperSum += wapeNow; waperCount += 1; }
    modelsEvaluated[forecaster.name || cls.class] = (modelsEvaluated[forecaster.name || cls.class] || 0) + 1;

    const baselineMean = forecaster(histArr).mean;
    const sigmaResid = residualSigma(histArr, forecaster);

    // Lead-time fit. We sample from past PO receipts where available.
    const ltSamples = await buildLeadTimeSamples(svc, tenantId, item.default_supplier_id);
    const lt = estimateLeadTime({
      receiptDeltas: ltSamples,
      itemDefaultDays: item.default_lead_days,
      supplierPrior: null,
    });
    const leadTimeWeeks = (lt.lead_time_days || (item.default_lead_days || 0)) / 7;
    const leadTimeSigmaWeeks = (lt.lead_time_stddev_days || 0) / 7;

    // Safety stock + reorder point.
    // Phase 3.5: per-class default service level (doc 2.9).
    // item.service_level overrides everything; otherwise we route
    // through SL_BY_TYPE based on item_type and fall back to the
    // tenant default.
    const alpha = item.service_level
      || defaultServiceLevel(item.item_type, cfg.inventory_default_service_level);
    // Phase 3.5: project-equivalent floor reads from
    // equipment_installed_parts.recommended_qty_180d (doc 2.3.3).
    const projectEquivalentQty = await projectEquivalentForPart(svc, tenantId, item.part_no);
    const ss = safetyStock({
      alpha,
      demandMean: baselineMean,
      demandSigma: sigmaResid,
      leadTimeMean: leadTimeWeeks,
      leadTimeSigma: leadTimeSigmaWeeks,
      demandClass: cls.class,
      avg4w: histArr.slice(-4).reduce((s, v) => s + v, 0) / 4,
      projectEquivalentQty,
    });

    // Bet 3: conformal-prediction safety stock. Replaces the
    // parametric value above when:
    //
    //   - tenant_settings.inventory_conformal_enabled = true
    //   - the part has >= 12 nonzero residuals (else cold-start)
    //
    // Coverage target priority: item_master.conformal_coverage ->
    // item_master.service_level (legacy synonym) ->
    // tenant_settings.inventory_conformal_default_coverage.
    //
    // Hard floor: ss = max(CP_band, ssGamma) for SKUs with fewer
    // than 26 residuals (math is less stable on short series).
    // Project floor stays as outermost lower bound (preserves
    // doc 2.3.3 invariant).
    let cpInfo = null;
    let cpSafetyStock = null;
    if (conformalOn) {
      const cpAlpha = Number(item.conformal_coverage)
        || Number(item.service_level)
        || Number(cfg.inventory_conformal_default_coverage)
        || 0.95;
      const cpMethod = item.conformal_method_override
        || cfg.inventory_conformal_method
        || "nexcp";
      const ownResiduals = residualsByPart.get(item.part_no) || [];
      cpInfo = selectAndComputeCP({
        residuals: ownResiduals,
        alpha: cpAlpha,
        method: cpMethod,
        cohortResiduals,
        cohortKey: item.item_type || "OTHER",
      });
      // Scale per-period band to the lead-time window so the
      // safety-stock add-on covers the full horizon between
      // order-placed and order-received.
      const ltdBand = scaleIntervalToLTD({
        interval_lo: cpInfo.qLo + baselineMean,
        interval_hi: cpInfo.qHi + baselineMean,
        leadTimeWeeks,
        leadTimeSigmaWeeks,
      });
      const cpBand = safetyStockFromInterval({
        interval_hi: ltdBand.interval_hi_ltd,
        ltdMean: leadTimeWeeks * baselineMean,
      });
      // Stability floor: SKUs with < 26 residuals use the larger of
      // (CP band, parametric gamma) so a sparse calibration window
      // can't under-stock a part we previously safe-stocked.
      cpSafetyStock = cpInfo.calibration_residuals_count < 26
        ? Math.max(cpBand, ss.breakdown.stat_ss)
        : cpBand;
      // Always retain the project floor as outermost lower bound.
      cpSafetyStock = Math.max(cpSafetyStock, ss.breakdown.project_floor);
      // Stamp the per-period interval on the forecast rows. The
      // band on the forecast chart should be per-period, not
      // LTD-cumulative.
      cpInfo.coverage_target = cpAlpha;
      cpInfo.interval_lo = Math.max(0, baselineMean + cpInfo.qLo);
      cpInfo.interval_hi = Math.max(cpInfo.interval_lo, baselineMean + cpInfo.qHi);
      conformalUsed += 1;
    }

    const effectiveSS = (cpSafetyStock != null) ? cpSafetyStock : ss.ss;

    // Persist computed columns back to item_master so the operator
    // can see and override them.
    await svc.from("item_master").update({
      demand_class: cls.class,
      safety_stock: effectiveSS,
      reorder_point: effectiveSS + leadTimeWeeks * baselineMean,
    }).eq("tenant_id", tenantId).eq("part_no", item.part_no);

    // Forecast decomposition by week.
    const pipelineByWeek = pipeline.get(item.part_no) || new Map();
    const forecastByWeek = new Map();
    const forecastDecompByWeek = new Map();
    // Committed = upcoming order_schedule_lines (we treat any
    // future schedule_line qty as committed demand).
    const committedScan = await svc.from("order_schedule_lines")
      .select("scheduled_qty, scheduled_date")
      .eq("tenant_id", tenantId)
      .eq("part_no", item.part_no)
      .gte("scheduled_date", today);
    const committedByWeek = new Map();
    for (const row of (committedScan.data || [])) {
      const wk = isoWeekStart(row.scheduled_date);
      if (!wk) continue;
      committedByWeek.set(wk, (committedByWeek.get(wk) || 0) + (Number(row.scheduled_qty) || 0));
    }
    for (const wk of weeks) {
      const c = committedByWeek.get(wk) || 0;
      const p = pipelineByWeek.get(wk) || 0;
      const b = baselineMean;     // flat baseline; Phase 2.5 adds seasonality
      forecastByWeek.set(wk, c + p + b);
      forecastDecompByWeek.set(wk, { committed: c, pipeline: p, baseline: b });
      // Bet 3: per-period CP band. The interval is centred on the
      // baseline; committed + pipeline are deterministic additions
      // so we add them to both bounds.
      const cpRow = cpInfo
        ? {
            conformal_method: cpInfo.method,
            coverage_target: cpInfo.coverage_target,
            interval_lo: Math.max(0, (c + p) + cpInfo.interval_lo),
            interval_hi: Math.max(
              (c + p) + cpInfo.interval_lo,
              (c + p) + cpInfo.interval_hi,
            ),
            calibration_residuals_count: cpInfo.calibration_residuals_count,
          }
        : {
            conformal_method: conformalOn ? "parametric_legacy" : null,
            coverage_target: null,
            interval_lo: null,
            interval_hi: null,
            calibration_residuals_count: null,
          };
      forecastRows.push({
        tenant_id: tenantId,
        part_no: item.part_no,
        week_start: wk,
        forecast_committed: c,
        forecast_pipeline: p,
        forecast_baseline: b,
        quantile_50: c + p + b,
        quantile_90: (c + p + b) + 1.28 * sigmaResid,
        quantile_95: (c + p + b) + 1.65 * sigmaResid,
        quantile_99: (c + p + b) + 2.33 * sigmaResid,
        model_name: forecaster.name || cls.class,
        model_version: "v1",
        wape_4w: wape(histArr, forecaster, 4),
        wape_8w: wape(histArr, forecaster, 8),
        wape_12w: wape(histArr, forecaster, 12),
        ...cpRow,
      });
    }

    // Bet 3: capture this run's most-recent (actual, forecast)
    // pair into conformal_calibration_residuals so the NEXT run
    // has a fresh residual to learn from. We use the latest
    // history week as the "actual" and the engine's baseline as the
    // "forecast" (this is the closed-loop walk-forward residual,
    // which is what NEXCP / Split CP need). Idempotent on the
    // (tenant, part, week_start) unique key.
    if (conformalOn && histArr.length > 0) {
      const lastWeekKey = histKeys[histKeys.length - 1];
      const lastActual = histArr[histArr.length - 1];
      if (lastWeekKey) {
        await svc.from("conformal_calibration_residuals").upsert(
          {
            tenant_id: tenantId,
            part_no: item.part_no,
            forecast_run_id: runId,
            week_start: lastWeekKey,
            forecast_value: baselineMean,
            actual_value: lastActual,
            weight: 1.0,
          },
          { onConflict: "tenant_id,part_no,week_start" },
        );
      }
    }

    // Net-req + plan.
    const inTransitByWeek = new Map();
    const allocatedByWeek = new Map();
    const inTransit = await svc.from("source_po_lines")
      .select("qty, received_qty, acknowledged_eta")
      .eq("tenant_id", tenantId)
      .eq("part_no", item.part_no);
    for (const row of (inTransit.data || [])) {
      const open = (Number(row.qty) || 0) - (Number(row.received_qty) || 0);
      if (open <= 0 || !row.acknowledged_eta) continue;
      const wk = isoWeekStart(row.acknowledged_eta);
      if (!wk) continue;
      inTransitByWeek.set(wk, (inTransitByWeek.get(wk) || 0) + open);
    }
    const alloc = await svc.from("inventory_allocations")
      .select("qty, required_by, status")
      .eq("tenant_id", tenantId)
      .eq("part_no", item.part_no)
      .eq("status", "reserved");
    for (const row of (alloc.data || [])) {
      const wk = isoWeekStart(row.required_by);
      if (!wk) continue;
      allocatedByWeek.set(wk, (allocatedByWeek.get(wk) || 0) + (Number(row.qty) || 0));
    }
    const position = positionByPart.get(item.part_no) || { on_hand_qty: 0 };
    const planResult = planForItem({
      partNo: item.part_no,
      position,
      forecastByWeek,
      forecastDecompByWeek,
      inTransitByWeek,
      allocatedByWeek,
      weeks,
      safetyStockQty: effectiveSS,
      leadTimeWeeks,
      weeklyForecastMean: baselineMean,
      coverageWeeks: item.coverage_period_weeks || 12,
      unitCost: Number(item.purchase_price) || 0,
      orderingCost: cfg.inventory_ordering_cost_inr || 5000,
      holdingCostPct: item.holding_cost_pct_override || cfg.inventory_holding_cost_pct || 0.22,
      moq: item.moq || 1,
      packSize: item.pack_size || 1,
      roundingRule: item.rounding_rule || "ceil",
      serviceLevel: alpha,
      topOpps: topOppsForPart(oppPairs, item.part_no),
      hysteresisStreak: 1,
    });
    if (planResult.plan) {
      // Phase 3.5: hysteresis check (doc R4 + 11.3). Only emit a
      // new draft plan if the shortage signal has persisted across
      // the configured number of consecutive runs. The `streak`
      // value is recorded on the plan's rationale so the operator
      // can see the engine waited.
      const requiredStreak = cfg.inventory_hysteresis_runs || 2;
      const hyst = await hysteresisOK(svc, tenantId, item.part_no, requiredStreak);
      if (hyst.ok) {
        planResult.plan.tenant_id = tenantId;
        // Bet 3: stamp CP fields directly + record the legacy
        // parametric value on the rationale so the dashboard can
        // A/B the two policies without losing audit info.
        if (cpInfo) {
          planResult.plan.conformal_method = cpInfo.method;
          planResult.plan.coverage_target = cpInfo.coverage_target;
          planResult.plan.interval_lo = cpInfo.interval_lo;
          planResult.plan.interval_hi = cpInfo.interval_hi;
          planResult.plan.calibration_residuals_count = cpInfo.calibration_residuals_count;
        }
        planResult.plan.rationale = {
          ...(planResult.plan.rationale || {}),
          hysteresis_streak: hyst.streak,
          hysteresis_required: requiredStreak,
          legacy_safety_stock: ss.ss,
          legacy_formula: ss.breakdown.formula,
          conformal_used: !!cpInfo,
          conformal_method: cpInfo?.method || null,
          coverage_target: cpInfo?.coverage_target || null,
          calibration_residuals_count: cpInfo?.calibration_residuals_count || 0,
        };
        planRows.push(planResult.plan);
      } else {
        // Hysteresis short-circuit: still flag a low-severity
        // exception so the operator knows the engine is watching
        // this part but not yet committing.
        await svc.from("inventory_exceptions").insert({
          tenant_id: tenantId,
          part_no: item.part_no,
          exception_kind: "below_reorder_point",
          severity: "info",
          detail: {
            fingerprint: "hyst:" + item.part_no + ":" + today,
            note: "Shortage detected; hysteresis " + hyst.streak + "/" + requiredStreak,
            net_requirement: planResult.plan.net_requirement,
          },
          status: "open",
        });
      }
    }
  }

  // Persist forecasts.
  if (forecastRows.length) {
    const up = await svc.from("demand_forecasts").upsert(
      forecastRows, { onConflict: "tenant_id,part_no,week_start,model_name" }
    );
    if (up.error) throw new Error("forecasts/upsert: " + up.error.message);
  }
  // Persist plans (only ones whose part_no doesn't already have a
  // draft / approved plan for the same for_week to keep the queue
  // dedup'd).
  let plansCreated = 0;
  for (const plan of planRows) {
    const existing = await svc.from("procurement_plans")
      .select("id, status").eq("tenant_id", tenantId).eq("part_no", plan.part_no)
      .eq("for_week", plan.for_week).in("status", ["draft", "approved"]).maybeSingle();
    if (existing.data) continue;
    const ins = await svc.from("procurement_plans").insert(plan);
    if (!ins.error) plansCreated += 1;
  }

  await svc.from("forecast_runs").update({
    status: "ok",
    finished_at: new Date().toISOString(),
    items_count: parts.length,
    models_evaluated: modelsEvaluated,
    wape_summary: {
      mean_wape_4w: waperCount ? waperSum / waperCount : null,
      conformal_enabled: conformalOn,
      conformal_used_count: conformalUsed,
      conformal_used_ratio: parts.length ? conformalUsed / parts.length : 0,
    },
    notes: "Weekly cron run; plans_created=" + plansCreated
      + "; bom_edges_exploded=" + (bomExplosion?.exploded || 0)
      + (conformalOn ? "; cp_used=" + conformalUsed : ""),
  }).eq("id", runId);

  await recordAudit({ tenantId, role: "service" }, {
    action: "inventory.replan.cron_completed",
    objectType: "forecast_run",
    objectId: runId,
    detail: { items: parts.length, plans_created: plansCreated },
  });

  return {
    tenant_id: tenantId,
    items_planned: parts.length,
    plans_created: plansCreated,
    run_id: runId,
    conformal_enabled: conformalOn,
    conformal_used: conformalUsed,
    bom_edges_exploded: bomExplosion?.exploded || 0,
  };
};

// -------------------------------------------------------------------
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (CRON_SECRET) {
    const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
                  || req.headers["x-cron-secret"]
                  || "";
    if (provided !== CRON_SECRET) {
      return json(res, 401, { error: { message: "Cron auth required" } });
    }
  }
  const t0 = Date.now();
  try {
    const svc = serviceClient();
    const tenants = await svc.from("tenant_settings")
      .select("tenant_id")
      .eq("inventory_planning_enabled", true);
    if (tenants.error) throw new Error("tenants: " + tenants.error.message);
    const summaries = [];
    for (const row of (tenants.data || [])) {
      try {
        summaries.push(await planTenant(svc, row.tenant_id));
      } catch (err) {
        summaries.push({
          tenant_id: row.tenant_id,
          error: String(err?.message || err).slice(0, 400),
        });
      }
    }
    await recordCronHeartbeat("inventory-planning-weekly", {
      status: summaries.every((s) => !s.error) ? "ok" : "partial_failure",
      durationMs: Date.now() - t0,
      metadata: { tenants: summaries.length },
    });
    return json(res, 200, { ok: true, tenants: summaries });
  } catch (err) {
    await recordCronHeartbeat("inventory-planning-weekly", {
      status: "failed",
      durationMs: Date.now() - t0,
      metadata: { error: String(err?.message || err).slice(0, 400) },
    });
    sendError(res, err);
  }
}

// Export the planTenant helper for unit testing.
export { planTenant };
