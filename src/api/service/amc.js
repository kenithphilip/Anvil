// /api/service/amc
// AMC schedule CRUD plus the auto-generation step that turns scheduled rows
// into service_visits when their date arrives. Cron at /api/service/amc/cron
// runs daily and generates visits for any AMC schedule due in the next N days
// (default 7).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const STATUSES = new Set(["SCHEDULED", "VISIT_CREATED", "COMPLETED", "SKIPPED", "CANCELLED"]);
const VISIT_TYPES = new Set(["PREVENTIVE", "EMERGENCY", "TRAINING", "AUDIT"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("amc_schedules").select("*").eq("tenant_id", ctx.tenantId).order("scheduled_date", { ascending: true }).limit(500);
      if (req.query.contract_id) q = q.eq("contract_id", req.query.contract_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      if (req.query.from) q = q.gte("scheduled_date", req.query.from);
      if (req.query.to) q = q.lte("scheduled_date", req.query.to);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { amc_schedules: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      // Bulk seed support: { contract_id, frequency: "QUARTERLY"|"MONTHLY"|"BIANNUAL"|"ANNUAL", start_date, count }
      if (body.bulk_seed) {
        const { contract_id, frequency, start_date, count = 4, visit_label } = body.bulk_seed;
        if (!contract_id || !frequency || !start_date) {
          return json(res, 400, { error: { message: "bulk_seed requires contract_id, frequency, start_date" } });
        }
        const c = await svc.from("contracts").select("customer_id").eq("tenant_id", ctx.tenantId).eq("id", contract_id).single();
        if (c.error || !c.data) return json(res, 404, { error: { message: "contract not found" } });
        const stepDays = frequency === "MONTHLY" ? 30 : frequency === "QUARTERLY" ? 91 : frequency === "BIANNUAL" ? 182 : 365;
        const start = new Date(start_date);
        const rows = [];
        for (let i = 0; i < Math.min(Math.max(count, 1), 24); i++) {
          const d = new Date(start.getTime() + i * stepDays * 86400 * 1000);
          rows.push({
            tenant_id: ctx.tenantId,
            contract_id,
            customer_id: c.data.customer_id,
            scheduled_date: d.toISOString().slice(0, 10),
            visit_label: visit_label ? (visit_label + " #" + (i + 1)) : (frequency + " #" + (i + 1)),
            visit_type: "PREVENTIVE",
            status: "SCHEDULED",
          });
        }
        const ins = await svc.from("amc_schedules").insert(rows).select("*");
        if (ins.error) throw new Error(ins.error.message);
        await recordAudit(ctx, { action: "amc_bulk_seed", objectType: "contract", objectId: contract_id, detail: "rows=" + rows.length + " freq=" + frequency });
        return json(res, 201, { amc_schedules: ins.data || [] });
      }
      // Single insert.
      const row = {
        tenant_id: ctx.tenantId,
        contract_id: body.contract_id,
        customer_id: body.customer_id,
        customer_location_id: body.customer_location_id || null,
        visit_label: body.visit_label || null,
        scheduled_date: body.scheduled_date,
        duration_days: body.duration_days || 1,
        visit_type: VISIT_TYPES.has(body.visit_type) ? body.visit_type : "PREVENTIVE",
        status: STATUSES.has(body.status) ? body.status : "SCHEDULED",
        remarks: body.remarks || null,
      };
      const ins = await svc.from("amc_schedules").insert(row).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, { action: "amc_create", objectType: "amc_schedule", objectId: ins.data.id, after: ins.data });
      return json(res, 201, { amc_schedule: ins.data });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      for (const k of ["scheduled_date", "duration_days", "visit_label", "remarks", "status", "customer_location_id"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      // generate_visit: turn a SCHEDULED row into a service_visits row.
      if (body.generate_visit) {
        const before = await svc.from("amc_schedules").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).single();
        if (before.error || !before.data) return json(res, 404, { error: { message: "amc not found" } });
        if (before.data.status !== "SCHEDULED") return json(res, 409, { error: { message: "only SCHEDULED rows can generate a visit" } });
        const visitIns = await svc.from("service_visits").insert({
          tenant_id: ctx.tenantId,
          customer_id: before.data.customer_id,
          customer_location_id: before.data.customer_location_id,
          visit_date: before.data.scheduled_date,
          purpose: before.data.visit_label || "AMC preventive maintenance",
          status: "PLANNED",
          field_engineer: ctx.user ? ctx.user.id : null,
        }).select("*").single();
        if (visitIns.error) throw new Error(visitIns.error.message);
        patch.status = "VISIT_CREATED";
        patch.generated_visit_id = visitIns.data.id;
        patch.generated_at = new Date().toISOString();
      }
      const out = await svc.from("amc_schedules").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (out.error) throw new Error(out.error.message);
      await recordAudit(ctx, { action: "amc_update", objectType: "amc_schedule", objectId: body.id, after: patch });
      return json(res, 200, { amc_schedule: out.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("amc_schedules").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "amc_delete", objectType: "amc_schedule", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
