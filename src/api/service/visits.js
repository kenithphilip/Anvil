// /api/service/visits  - service visit reports (check-in/out, observation, action)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const STATUSES = new Set(["PLANNED","CHECKED_IN","CHECKED_OUT","REPORT_SUBMITTED","CLOSED"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("service_visits").select("*").eq("tenant_id", ctx.tenantId).order("visit_date", { ascending: false }).limit(500);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.status && STATUSES.has(req.query.status)) q = q.eq("status", req.query.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { visits: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.visit_date) return json(res, 400, { error: { message: "visit_date required" } });
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id || null,
        customer_location_id: body.customer_location_id || null,
        visit_date: body.visit_date,
        line_or_station: body.line_or_station || null,
        purpose: body.purpose || null,
        observation: body.observation || null,
        possible_cause: body.possible_cause || null,
        action_taken: body.action_taken || null,
        followup_action: body.followup_action || null,
        check_in_at: body.check_in_at || null,
        check_out_at: body.check_out_at || null,
        field_engineer: ctx.user ? ctx.user.id : null,
        status: STATUSES.has(body.status) ? body.status : "PLANNED",
        notes: body.notes || null,
      };
      const { data, error } = await svc.from("service_visits").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "visit_create", objectType: "service_visit", objectId: data.id, after: data });
      return json(res, 201, { visit: data });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.id) return json(res, 400, { error: { message: "id required" } });
      const patch = {};
      const allowed = ["status","check_in_at","check_out_at","observation","possible_cause","action_taken","followup_action","notes","line_or_station","purpose"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      if (body.checkin) { patch.status = "CHECKED_IN"; patch.check_in_at = new Date().toISOString(); }
      if (body.checkout) { patch.status = "CHECKED_OUT"; patch.check_out_at = new Date().toISOString(); }
      const { data, error } = await svc.from("service_visits").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "visit_update", objectType: "service_visit", objectId: body.id, after: patch });
      return json(res, 200, { visit: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("service_visits").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "visit_delete", objectType: "service_visit", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
