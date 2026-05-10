// /api/inventory/forecast_runs
//
// Read-only history of forecast generation runs. Each row is a
// run by inventory-planning-weekly cron (or manual replan) that
// produces demand_forecasts for every active item. The model
// evaluator picks the best WAPE-scoring model and stamps it on
// each item; the run-level wape_summary jsonb holds the
// distribution.
//
// GET /api/inventory/forecast_runs?limit=50
//   -> { runs: [{ id, started_at, finished_at, status,
//         items_count, models_evaluated, wape_summary, notes }] }
//
// GET /api/inventory/forecast_runs?id=<uuid>
//   -> { run, forecasts_sample }   (last run's first 50 forecasts)

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

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
    const url = new URL(req.url || "", "http://x");
    const id = url.searchParams.get("id");
    const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);

    if (id) {
      const r = await svc.from("forecast_runs")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .maybeSingle();
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return json(res, 404, { error: { message: "forecast run not found" } });
      // Pull a sample of forecasts produced by this run (best-effort:
      // demand_forecasts has run_id linkage when migration 087 added it).
      let sample = [];
      try {
        const sampleResp = await svc.from("demand_forecasts")
          .select("part_no, week_start, forecast_total, quantile_90, model_name, wape_8w")
          .eq("tenant_id", ctx.tenantId)
          .eq("forecast_run_id", id)
          .order("week_start", { ascending: true })
          .limit(50);
        sample = sampleResp.data || [];
      } catch (_e) { /* legacy schema without run_id linkage */ }
      return json(res, 200, { run: r.data, forecasts_sample: sample });
    }

    const r = await svc.from("forecast_runs")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .order("started_at", { ascending: false })
      .limit(limit);
    if (r.error) throw new Error(r.error.message);
    return json(res, 200, { runs: r.data || [] });
  } catch (err) { sendError(res, err); }
}
