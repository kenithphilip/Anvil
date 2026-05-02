// /api/service/closure_reports
// Service-side closure reports (CAR resolution + 5-Why + permanent countermeasure).
// Source: Services Object Model. Linked to car_reports via car_report_id.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("closure_reports").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.car_report_id) q = q.eq("car_report_id", req.query.car_report_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { closure_reports: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const row = {
        tenant_id: ctx.tenantId,
        car_report_id: body.car_report_id || null,
        customer_id: body.customer_id || null,
        issue_date: body.issue_date || null,
        equipment_part_no: body.equipment_part_no || null,
        investigation: body.investigation || null,
        root_cause: body.root_cause || null,
        temporary_countermeasure: body.temporary_countermeasure || null,
        permanent_countermeasure: body.permanent_countermeasure || null,
        signed_off_by: ctx.user ? ctx.user.id : null,
      };
      if (body.signed_off) row.closed_at = new Date().toISOString();
      const { data, error } = await svc.from("closure_reports").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      if (body.car_report_id && body.signed_off) {
        await svc.from("car_reports").update({ status: "CLOSED" }).eq("tenant_id", ctx.tenantId).eq("id", body.car_report_id);
      }
      await recordAudit(ctx, { action: "closure_create", objectType: "closure_report", objectId: data.id, after: data });
      return json(res, 201, { closure_report: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      for (const k of ["investigation", "root_cause", "temporary_countermeasure", "permanent_countermeasure"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      if (body.signed_off) {
        patch.closed_at = new Date().toISOString();
        patch.signed_off_by = ctx.user ? ctx.user.id : null;
      }
      const { data, error } = await svc.from("closure_reports").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "closure_update", objectType: "closure_report", objectId: body.id, after: patch });
      return json(res, 200, { closure_report: data });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
