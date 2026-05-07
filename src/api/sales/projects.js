// /api/sales/projects
//   GET    list (filter by phase, customer)
//   POST   create
//   PATCH  update (phase advance logged)
//   DELETE remove

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const PHASES = new Set(["INITIAL_INFO","STRATEGY","PROMOTIONAL","RFQ_PREP","BUDGETARY_QUOTATION","PRICE_NEGOTIATION","LB_FINALIZATION","KICKOFF","DESIGN","APPROVAL_PROCESSING","MANUFACTURING","SHIPPING","INSTALLATION_COMMISSIONING","PAYMENT_FOLLOWUP","CLOSED"]);
const STATUSES = new Set(["ACTIVE","ON_HOLD","COMPLETED","CANCELLED"]);

// Audit P7.4. Project phases used to allow any-to-any
// transitions including INITIAL_INFO -> CLOSED. Each phase is
// real work; you can't ship installation before manufacturing.
// Allow forward progression with one-step backward (operator
// "we mis-phased this"). CLOSED is terminal.
const PHASE_ORDER = [
  "INITIAL_INFO", "STRATEGY", "PROMOTIONAL", "RFQ_PREP",
  "BUDGETARY_QUOTATION", "PRICE_NEGOTIATION", "LB_FINALIZATION",
  "KICKOFF", "DESIGN", "APPROVAL_PROCESSING", "MANUFACTURING",
  "SHIPPING", "INSTALLATION_COMMISSIONING", "PAYMENT_FOLLOWUP",
  "CLOSED",
];
const isPhaseTransitionAllowed = (from, to) => {
  if (!from || !to) return true;
  if (from === to) return true;
  if (from === "CLOSED") return false;
  const fromIdx = PHASE_ORDER.indexOf(from);
  const toIdx = PHASE_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  // Allow CLOSED from any phase (operator wraps a stalled project).
  if (to === "CLOSED") return true;
  return toIdx >= fromIdx - 1;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("projects").select("*").eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(500);
      if (req.query.phase && PHASES.has(req.query.phase)) q = q.eq("current_phase", req.query.phase);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const ids = (data || []).map((p) => p.id);
      const { data: phaseLog } = ids.length
        ? await svc.from("project_phase_log").select("*").eq("tenant_id", ctx.tenantId).in("project_id", ids).order("started_at")
        : { data: [] };
      const byProject = {};
      (phaseLog || []).forEach((pl) => { (byProject[pl.project_id] = byProject[pl.project_id] || []).push(pl); });
      return json(res, 200, { projects: (data || []).map((p) => ({ ...p, phase_log: byProject[p.id] || [] })) });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.project_code || !body.project_name) return json(res, 400, { error: { message: "project_code and project_name required" } });
      const row = {
        tenant_id: ctx.tenantId,
        project_code: body.project_code,
        project_name: body.project_name,
        customer_id: body.customer_id || null,
        customer_location_id: body.customer_location_id || null,
        customer_segment: body.customer_segment || null,
        end_user: body.end_user || null,
        related_opportunity_id: body.related_opportunity_id || null,
        total_value_inr: body.total_value_inr || null,
        currency: body.currency || "INR",
        current_phase: PHASES.has(body.current_phase) ? body.current_phase : "INITIAL_INFO",
        budgeted_design_mandays: body.budgeted_design_mandays || null,
        budgeted_install_mandays: body.budgeted_install_mandays || null,
        budgeted_travel_mandays: body.budgeted_travel_mandays || null,
        budgeted_warranty_pct: body.budgeted_warranty_pct || null,
        shipping_mode: body.shipping_mode || null,
        expected_po_release_date: body.expected_po_release_date || null,
        expected_design_final_date: body.expected_design_final_date || null,
        expected_ready_date: body.expected_ready_date || null,
        expected_shipping_etd: body.expected_shipping_etd || null,
        expected_delivery_date: body.expected_delivery_date || null,
        expected_sop_date: body.expected_sop_date || null,
        status: STATUSES.has(body.status) ? body.status : "ACTIVE",
      };
      const ins = await svc.from("projects").upsert(row, { onConflict: "tenant_id,project_code" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await svc.from("project_phase_log").insert({ tenant_id: ctx.tenantId, project_id: ins.data.id, phase: row.current_phase });
      await recordAudit(ctx, { action: "project_create", objectType: "project", objectId: ins.data.id, after: ins.data });
      return json(res, 201, { project: ins.data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const before = await svc.from("projects").select("current_phase").eq("tenant_id", ctx.tenantId).eq("id", body.id).single();
      const patch = { updated_at: new Date().toISOString() };
      const allowed = ["current_phase","status","total_value_inr","budgeted_design_mandays","budgeted_install_mandays","budgeted_travel_mandays","budgeted_warranty_pct","shipping_mode","expected_po_release_date","expected_design_final_date","expected_ready_date","expected_shipping_etd","expected_delivery_date","expected_sop_date","customer_location_id","end_user"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (patch.current_phase && !PHASES.has(patch.current_phase)) return json(res, 400, { error: { message: "invalid phase" } });
      // Audit P7.4: enforce phase transitions instead of letting
      // a project skip from INITIAL_INFO to CLOSED in one PATCH.
      if (patch.current_phase && before.data && patch.current_phase !== before.data.current_phase
          && !isPhaseTransitionAllowed(before.data.current_phase, patch.current_phase)) {
        return json(res, 409, {
          error: {
            code: "INVALID_PHASE_TRANSITION",
            message: "Cannot move project from " + before.data.current_phase + " to " + patch.current_phase + " directly.",
            from: before.data.current_phase,
            to: patch.current_phase,
          },
        });
      }
      const { data, error } = await svc.from("projects").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      if (patch.current_phase && before.data && patch.current_phase !== before.data.current_phase) {
        await svc.from("project_phase_log").update({ completed_at: new Date().toISOString() }).eq("tenant_id", ctx.tenantId).eq("project_id", body.id).eq("phase", before.data.current_phase).is("completed_at", null);
        await svc.from("project_phase_log").insert({ tenant_id: ctx.tenantId, project_id: body.id, phase: patch.current_phase, responsible_user: ctx.user ? ctx.user.id : null, remarks: body.phase_remark || null });
      }
      await recordAudit(ctx, { action: "project_update", objectType: "project", objectId: body.id, after: patch });
      return json(res, 200, { project: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("projects").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "project_delete", objectType: "project", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
