// /api/sales/opportunities
//   GET    list (filter by stage, customer, close_from/to). Each row also
//          carries customer_name and owner_name. probability is a percent,
//          0 to 100 (column default 50).
//   POST   create
//   PATCH  update (stage transitions logged). owner_id: a rep may claim an
//          unowned opportunity for themselves; any other owner change needs
//          the opportunity.assign action (sales_manager, admin), and the new
//          owner must be an approved member of the tenant. Moving to
//          CLOSE_LOST needs a lost_reason code from lost_reason_taxonomy.
//   DELETE soft delete

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordAudits } from "../_lib/audit.js";
import { recordStageEvent } from "../_lib/funnel-analytics.js";
import { resolveAssignee, userDisplayNames } from "../_lib/assignee.js";
import { chunk } from "../_lib/customer-owner.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID_RE.test(s);

const bad = (res, code, message) => json(res, 400, { error: { code, message } });

// Is `code` a lost reason this tenant may use? The taxonomy (migration 006)
// holds global rows (tenant_id null, the seeded defaults) and the tenant's own
// rows. Only those two are read, never another tenant's. A tenant row with the
// same code wins over the global one, so a tenant can retire a default by
// saving it inactive.
const isLostReasonCode = async (svc, tenantId, code) => {
  const { data, error } = await svc.from("lost_reason_taxonomy")
    .select("tenant_id, code, active")
    .eq("code", code)
    .or("tenant_id.eq." + tenantId + ",tenant_id.is.null");
  if (error) throw new Error("could not read the lost reasons: " + error.message);
  const rows = data || [];
  const row = rows.find((r) => r.tenant_id === tenantId) || rows.find((r) => r.tenant_id == null);
  return !!row && row.active !== false;
};

// The opportunities screen names each row's customer and owner, and a row
// carries only their ids. Without the names the screen had nothing to show
// but a uuid. Two lookups rather than a PostgREST embed, so the list does not
// depend on the relationship being in the schema cache (the pattern
// quotes/index.js uses). The customer read is scoped to the tenant, so a
// customer id that belongs to another tenant gets no name. Best-effort: a
// failed lookup leaves the name null and the list still loads.
const attachNames = async (svc, tenantId, rows) => {
  const customerNames = new Map();
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
  for (const part of chunk(customerIds)) {
    const r = await svc.from("customers").select("id, customer_name").eq("tenant_id", tenantId).in("id", part);
    if (r.error) {
      console.warn("[opportunities] customer names not loaded:", r.error.message);
      continue;
    }
    for (const c of r.data || []) customerNames.set(c.id, c.customer_name);
  }
  const ownerNames = await userDisplayNames(svc, rows.map((r) => r.owner_id));
  for (const r of rows) {
    r.customer_name = customerNames.get(r.customer_id) || null;
    r.owner_name = r.owner_id ? (ownerNames.get(r.owner_id) || null) : null;
  }
  return rows;
};

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
      return json(res, 200, { opportunities: await attachNames(svc, ctx.tenantId, data || []) });
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
      const allowed = ["stage","order_mode","amount_inr","amount_currency","amount_native","fx_rate_used","close_date","probability","product_summary","competitor_name","related_quote_id","related_contract_id","customer_location_id"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (patch.stage && !STAGES.has(patch.stage)) return json(res, 400, { error: { message: "invalid stage" } });
      const before = await svc.from("opportunities").select("stage, owner_id, lost_reason").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
      if (before.error) throw new Error(before.error.message);
      // Not this tenant's opportunity (or no such id): say so, rather than
      // let the update match nothing and fail as a 500.
      if (!before.data) return json(res, 404, { error: { code: "OPPORTUNITY_NOT_FOUND", message: "opportunity not found" } });
      // Audit P7.4: enforce stage transitions instead of letting
      // an operator jump from QUALIFICATION to CLOSE_WON in one
      // PATCH.
      if (patch.stage && patch.stage !== before.data.stage
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

      // Lost reason. A lost deal with no reason is a hole in the win/loss
      // report, so moving to CLOSE_LOST needs one, and so does any edit that
      // would clear the reason of a lost deal. Whatever is sent must be a code
      // from the taxonomy, so the report groups by codes, not free text.
      const nextStage = patch.stage || before.data.stage;
      const reasonSent = body.lost_reason !== undefined;
      const reason = typeof body.lost_reason === "string" ? body.lost_reason.trim() : (body.lost_reason || null);
      if (reasonSent && reason) {
        if (typeof reason !== "string" || !(await isLostReasonCode(svc, ctx.tenantId, reason))) {
          return bad(res, "INVALID_LOST_REASON", "lost_reason must be a code from the lost-reason list");
        }
      }
      if (reasonSent) patch.lost_reason = reason || null;
      const movingToLost = nextStage === "CLOSE_LOST" && before.data.stage !== "CLOSE_LOST";
      if ((movingToLost || (reasonSent && nextStage === "CLOSE_LOST"))
          && !(reasonSent ? reason : before.data.lost_reason)) {
        return bad(res, "LOST_REASON_REQUIRED", "A lost opportunity needs a lost_reason");
      }

      // Owner. Absent leaves the owner alone; null clears it. A rep may claim
      // an unowned opportunity for themselves on the coarse write verb. Every
      // other change (reassigning an owned deal, giving an unowned one to
      // someone else, clearing it) is a manager's call: opportunity.assign.
      // Either way the new owner must be an approved member of THIS tenant,
      // so a deal cannot be handed to another tenant's user or to someone
      // who has left.
      const beforeOwner = before.data.owner_id || null;
      let ownerChanged = false;
      if (Object.prototype.hasOwnProperty.call(body, "owner_id")) {
        const want = body.owner_id === "" ? null : body.owner_id;
        if (want !== beforeOwner) {
          const isClaim = !beforeOwner && !!want && !!ctx.user && want === ctx.user.id;
          if (!isClaim) requireAction(ctx, "opportunity.assign");
          if (want === null) {
            patch.owner_id = null;
          } else {
            const assignable = isUuid(want) ? await resolveAssignee(svc, ctx.tenantId, want) : null;
            if (!assignable) return bad(res, "INVALID_OWNER", "owner_id must be an approved member of this tenant");
            patch.owner_id = assignable;
          }
          ownerChanged = true;
        }
      }

      const { data, error } = await svc.from("opportunities").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      const stageChanged = patch.stage && patch.stage !== before.data.stage;
      const audits = [{ action: stageChanged ? "opp_stage_change" : "opp_update", objectType: "opportunity", objectId: body.id, before: before.data, after: data }];
      // Its own row too, with the same action the account-owner move writes
      // (customers/owner.js), so an opportunity's owner history reads as one
      // list whichever screen changed it.
      if (ownerChanged) {
        audits.push({ action: "opp_owner_change", objectType: "opportunity", objectId: body.id, before: { owner_id: beforeOwner }, after: { owner_id: data.owner_id } });
      }
      await recordAudits(ctx, audits);
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
