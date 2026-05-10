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
import { estimateLeadTime } from "../_lib/inventory/lead-time.js";
import {
  computePipelineDemand, isoWeekStart, STAGE_PROBABILITY_DEFAULTS,
} from "../_lib/inventory/pipeline-demand.js";
import { planForItem, addWeeks } from "../_lib/inventory/net-req.js";

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
// Pipeline demand: read opportunities + opportunity_line_items.
const buildPipeline = async (svc, tenantId, weeks) => {
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
  return computePipelineDemand({ pairs });
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
    .select("part_no, item_type, default_supplier_id, service_level, holding_cost_pct_override, coverage_period_weeks, default_lead_days, moq, pack_size, rounding_rule, purchase_price, demand_class, pinned_model")
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

  // History + pipeline.
  const horizonWeeks = cfg.inventory_forecast_horizon_weeks || DEFAULT_HORIZON;
  const today = isoWeekStart(new Date());
  const weeks = Array.from({ length: horizonWeeks }, (_, i) => addWeeks(today, i));
  const history = await buildHistory(svc, tenantId, parts);
  const pipeline = await buildPipeline(svc, tenantId, weeks);

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

  // Per-item planning loop.
  const forecastRows = [];
  const planRows = [];
  let modelsEvaluated = {};
  let waperSum = 0;
  let waperCount = 0;
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
    const alpha = item.service_level || cfg.inventory_default_service_level || 0.95;
    const ss = safetyStock({
      alpha,
      demandMean: baselineMean,
      demandSigma: sigmaResid,
      leadTimeMean: leadTimeWeeks,
      leadTimeSigma: leadTimeSigmaWeeks,
      demandClass: cls.class,
      avg4w: histArr.slice(-4).reduce((s, v) => s + v, 0) / 4,
      projectEquivalentQty: 1,    // TODO: read from equipment_installed_parts
    });

    // Persist computed columns back to item_master so the operator
    // can see and override them.
    await svc.from("item_master").update({
      demand_class: cls.class,
      safety_stock: ss.ss,
      reorder_point: ss.ss + leadTimeWeeks * baselineMean,
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
      });
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
      safetyStockQty: ss.ss,
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
      planResult.plan.tenant_id = tenantId;
      planRows.push(planResult.plan);
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
    wape_summary: { mean_wape_4w: waperCount ? waperSum / waperCount : null },
    notes: "Weekly cron run; plans_created=" + plansCreated,
  }).eq("id", runId);

  await recordAudit({ tenantId, role: "service" }, {
    action: "inventory.replan.cron_completed",
    objectType: "forecast_run",
    objectId: runId,
    detail: { items: parts.length, plans_created: plansCreated },
  });

  return { tenant_id: tenantId, items_planned: parts.length, plans_created: plansCreated, run_id: runId };
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
