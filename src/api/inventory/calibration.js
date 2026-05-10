// GET /api/inventory/calibration
//
// Stage-probability calibration data for the planning dashboard's
// Calibration tab (S1.4 in docs/INVENTORY_PLANNING_DESIGN.md). For
// each opportunity stage we report:
//   raw          : the design's default probability (STAGE_PROBABILITY_DEFAULTS).
//   calibrated   : probability derived from the last 365d of actual
//                  CLOSE_WON / CLOSE_LOST conversions.
//   sample_size  : how many opportunities reached the stage.
//   wins         : how many closed won.
//
// Stages with sample_size < 10 are returned with the raw default
// (calibration is not yet trustworthy at low volume).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import {
  STAGE_PROBABILITY_DEFAULTS, calibrateStageProbabilities,
} from "../_lib/inventory/pipeline-demand.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const sinceISO = new Date(Date.now() - 365 * 86400_000).toISOString();
    const closed = await svc.from("opportunities")
      .select("stage")
      .eq("tenant_id", ctx.tenantId)
      .in("stage", ["CLOSE_WON", "CLOSE_LOST", "REGRETTED"])
      .gte("updated_at", sinceISO);
    if (closed.error) throw new Error(closed.error.message);
    const history = (closed.data || []).map((o) => ({
      final_stage: o.stage,
      max_stage: o.stage,
    }));
    const calibrated = calibrateStageProbabilities(history);
    // Per-stage sample counts.
    const counts = {};
    for (const h of history) {
      const m = h.max_stage;
      if (!counts[m]) counts[m] = { reached: 0, won: 0 };
      counts[m].reached += 1;
      if (h.final_stage === "CLOSE_WON") counts[m].won += 1;
    }
    const rows = Object.keys(STAGE_PROBABILITY_DEFAULTS).map((stage) => ({
      stage,
      raw_probability: STAGE_PROBABILITY_DEFAULTS[stage],
      calibrated_probability: calibrated[stage] != null
        ? calibrated[stage]
        : STAGE_PROBABILITY_DEFAULTS[stage],
      sample_size: counts[stage]?.reached || 0,
      wins: counts[stage]?.won || 0,
    }));
    return json(res, 200, { calibration: rows });
  } catch (err) { sendError(res, err); }
}
