// /api/sales/opportunities
//   GET    list (filter by stage, customer, close_from/to)
//   POST   create
//   PATCH  update (stage transitions logged)
//   DELETE soft delete

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { recordStageEvent } from "../_lib/funnel-analytics.js";

// Append a funnel stage event without ever failing the request it
// rides on — the opportunity write + audit have already committed.
const safeStageEvent = async (svc, evt) => {
  try {
    const r = await recordStageEvent(svc, evt);
    if (!r.ok) console.warn("[opportunities] stage-event capture failed:", r.error);
  } catch (err) {
    console.warn("[opportunities] stage-event capture threw:", err?.message || err);
  }
};

const STAGES = new Set(["QUALIFICATION","STRATEGY_CHECK","NEEDS_ANALYSIS","FOLLOW_UP","RFQ","INTERNAL_PROPOSAL","PROPOSAL_PRICE_QUOTE","NEGOTIATION_REVIEW","CLOSE_WON","CLOSE_LOST","REGRETTED"]);

// Audit P7.4. The audit flagged that opportunities.PATCH let an
// operator move from any stage to any stage (e.g.,
// QUALIFICATION -> CLOSE_WON in one PATCH). Forward-progression
// is the typical funnel; close-state transitions are allowed
// from any open stage; same-state is a no-op. CLOSE_WON /
// CLOSE_LOST / REGRETTED are terminal.
const PIPELINE_ORDER = [
  "QUALIFICATION", "STRATEGY_CHECK", "NEEDS_ANALYSIS", "FOLLOW_UP",
  "RFQ", "INTERNAL_PROPOSAL", "PROPOSAL_PRICE_QUOTE", "NEGOTIATION_REVIEW",
];
const TERMINAL_STAGES = new Set(["CLOSE_WON", "CLOSE_LOST", "REGRETTED"]);

const isStageTransitionAllowed = (from, to) => {
  if (!from || !to) return true;
  if (from === to) return true;
  if (TERMINAL_STAGES.has(from)) return false;
  if (TERMINAL_STAGES.has(to)) return true;
  // Otherwise forward progression only (within the pipeline).
  const fromIdx = PIPELINE_ORDER.indexOf(from);
  const toIdx = PIPELINE_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  // Allow one-step backward (operator says "we mis-staged this").
  return toIdx >= fromIdx - 1;
};

// Audit P10. Test-only export for unit tests at
// src/v3-app/api-state-machines.test.js. Public surface is the
// PATCH 409 + INVALID_STAGE_TRANSITION error code; this lets us
// lock the table without standing up Supabase.
export const __test = { isStageTransitionAllowed, PIPELINE_ORDER, TERMINAL_STAGES };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("opportunities").select("*").eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(500);
      if (req.query.stage && STAGES.has(req.query.stage)) q = q.eq("stage", req.query.stage);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.close_from) q = q.gte("close_date", req.query.close_from);
      if (req.query.close_to) q = q.lte("close_date", req.query.close_to);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { opportunities: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.opportunity_name || !body.customer_id) return json(res, 400, { error: { message: "opportunity_name and customer_id required" } });
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        customer_location_id: body.customer_location_id || null,
        opportunity_name: body.opportunity_name,
        stage: STAGES.has(body.stage) ? body.stage : "QUALIFICATION",
        order_mode: body.order_mode || null,
        amount_inr: body.amount_inr || null,
        amount_currency: body.amount_currency || "INR",
        amount_native: body.amount_native || null,
        fx_rate_used: body.fx_rate_used || null,
        close_date: body.close_date || null,
        probability: body.probability != null ? body.probability : 50,
        product_summary: body.product_summary || null,
        related_lead_id: body.related_lead_id || null,
        owner_id: ctx.user ? ctx.user.id : null,
      };
      const { data, error } = await svc.from("opportunities").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "opp_create", objectType: "opportunity", objectId: data.id, after: data });
      // Funnel: creation is the opp's entry into the pipeline (from_stage null).
      await safeStageEvent(svc, {
        tenantId: ctx.tenantId, opportunityId: data.id,
        fromStage: null, toStage: data.stage,
        changedBy: ctx.user ? ctx.user.id : null, ownerId: data.owner_id,
        amountInr: data.amount_inr, probability: data.probability,
        changedAt: data.created_at,
      });
      return json(res, 201, { opportunity: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = { updated_at: new Date().toISOString() };
      const allowed = ["stage","order_mode","amount_inr","amount_currency","amount_native","fx_rate_used","close_date","probability","product_summary","lost_reason","competitor_name","related_quote_id","related_contract_id","customer_location_id"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (patch.stage && !STAGES.has(patch.stage)) return json(res, 400, { error: { message: "invalid stage" } });
      const before = await svc.from("opportunities").select("stage").eq("tenant_id", ctx.tenantId).eq("id", body.id).single();
      // Audit P7.4: enforce stage transitions instead of letting
      // an operator jump from QUALIFICATION to CLOSE_WON in one
      // PATCH.
      if (patch.stage && before.data && patch.stage !== before.data.stage
          && !isStageTransitionAllowed(before.data.stage, patch.stage)) {
        return json(res, 409, {
          error: {
            code: "INVALID_STAGE_TRANSITION",
            message: "Cannot move opportunity from " + before.data.stage + " to " + patch.stage + " directly.",
            from: before.data.stage,
            to: patch.stage,
          },
        });
      }
      const { data, error } = await svc.from("opportunities").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      const stageChanged = before.data && patch.stage && patch.stage !== before.data.stage;
      await recordAudit(ctx, { action: stageChanged ? "opp_stage_change" : "opp_update", objectType: "opportunity", objectId: body.id, before: before.data, after: data });
      // Funnel: capture the transition as a first-class event so the
      // analytics layer can measure conversion / velocity / aging.
      if (stageChanged) {
        await safeStageEvent(svc, {
          tenantId: ctx.tenantId, opportunityId: body.id,
          fromStage: before.data.stage, toStage: data.stage,
          changedBy: ctx.user ? ctx.user.id : null, ownerId: data.owner_id,
          amountInr: data.amount_inr, probability: data.probability,
        });
      }
      return json(res, 200, { opportunity: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("opportunities").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "opp_delete", objectType: "opportunity", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
