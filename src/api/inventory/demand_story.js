// /api/inventory/demand_story?opportunity_id=...
//
// The "Buy Before the Shortage" hero read (moat Bet 1): for ONE opportunity,
// tell the causal story the forecast→BOM engine already computes but never
// surfaced together —
//   the opportunity  →  its finished-good line items (× win-probability)
//                     →  the raw materials its BOM explodes into
//                     →  the draft procurement plans it contributed to.
//
// Reuses the SAME engine functions as the weekly planner (explodePipeline
// ThroughBom, buildBomAttributionIndex, resolveOpportunityProbability), so the
// numbers reconcile with the plans; the contributing plans are matched by
// rationale.top_opps (stamped by the cron's BOM-traced attribution). Read-only.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { buildDemandStory } from "../_lib/inventory/pipeline-demand.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const oppId = req.query?.opportunity_id;
    if (!oppId) return json(res, 400, { error: { message: "opportunity_id required" } });
    const svc = serviceClient();

    const oppQ = await svc.from("opportunities")
      .select("id, opportunity_name, stage, probability, ai_probability, close_date, customer_id")
      .eq("tenant_id", ctx.tenantId).eq("id", oppId).maybeSingle();
    if (oppQ.error) throw new Error("opportunity: " + oppQ.error.message);
    if (!oppQ.data) return json(res, 404, { error: { message: "Opportunity not found" } });

    const [linesQ, bomQ, buyQ, plansQ] = await Promise.all([
      svc.from("opportunity_line_items").select("part_no, qty, product_family, product_category")
        .eq("tenant_id", ctx.tenantId).eq("opportunity_id", oppId),
      svc.from("bill_of_materials").select("parent_part_no, child_part_no, qty").eq("tenant_id", ctx.tenantId),
      svc.from("item_master").select("part_no").eq("tenant_id", ctx.tenantId).eq("procurement_type", "buy"),
      svc.from("procurement_plans").select("id, part_no, recommended_qty, status, expected_arrival_date, rationale")
        .eq("tenant_id", ctx.tenantId),
    ]);
    if (linesQ.error) throw new Error("lines: " + linesQ.error.message);

    const story = buildDemandStory({
      opp: oppQ.data,
      lines: linesQ.data || [],
      bomRows: bomQ.data || [],
      buyParts: new Set((buyQ.data || []).map((r) => r.part_no).filter(Boolean)),
      plans: plansQ.data || [],
    });
    return json(res, 200, { ok: true, ...story });
  } catch (err) {
    return sendError(res, err);
  }
}
