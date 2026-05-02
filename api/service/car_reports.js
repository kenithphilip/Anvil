// /api/service/car_reports - Concern Analysis Reports (5-Why with countermeasures)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const STATUSES = new Set(["OPEN","UNDER_REVIEW","CLOSED","REOPENED"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("car_reports").select("*").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { car_reports: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id || null,
        original_po_no: body.original_po_no || null,
        original_so_no: body.original_so_no || null,
        part_no: body.part_no || null,
        qty_rejected: body.qty_rejected != null ? Number(body.qty_rejected) : null,
        root_cause: body.root_cause || null,
        five_why_analysis: body.five_why_analysis || null,
        temporary_countermeasure: body.temporary_countermeasure || null,
        permanent_countermeasure: body.permanent_countermeasure || null,
        analysis_date: body.analysis_date || null,
        prepared_by: ctx.user ? ctx.user.id : null,
        status: STATUSES.has(body.status) ? body.status : "OPEN",
      };
      const { data, error } = await svc.from("car_reports").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "car_create", objectType: "car_report", objectId: data.id, after: data });
      return json(res, 201, { car_report: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      for (const k of ["status","root_cause","five_why_analysis","temporary_countermeasure","permanent_countermeasure"]) if (body[k] !== undefined) patch[k] = body[k];
      const { data, error } = await svc.from("car_reports").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "car_update", objectType: "car_report", objectId: body.id, after: patch });
      return json(res, 200, { car_report: data });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
