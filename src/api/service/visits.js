// /api/service/visits  - service visit reports (check-in/out, observation, action)

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const STATUSES = new Set(["PLANNED","CHECKED_IN","CHECKED_OUT","REPORT_SUBMITTED","CLOSED"]);

// Who a visit may be assigned to.
//
// field_engineer used to be hardcoded to whoever created the row and was absent
// from the PATCH allow-list, so a visit could never be assigned to anybody --
// Anvil RECORDED field work but could not ROUTE it. Assignment is the smallest
// thing that turns the former into the latter.
//
// The assignee must be an APPROVED member of this tenant. A raw user id off the
// request body would otherwise let a visit be assigned to a member of another
// tenant, which is the same class of hole as any caller-supplied FK; and an
// unapproved / removed member cannot be given work. Returns the id when it is
// assignable, otherwise null.
const resolveAssignee = async (svc, tenantId, userId) => {
  if (!userId) return null;
  const { data, error } = await svc.from("tenant_members")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .maybeSingle();
  // A read failure is not "not a member": say so, so the caller reports a
  // transient fault instead of accusing a real colleague of not existing.
  if (error) throw new Error("could not verify the assignee: " + error.message);
  if (!data) return null;
  return data.user_id;
};

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
      // Absent => the creator (previous behaviour). PRESENT but unresolvable =>
      // refuse, exactly as PATCH does. Falling back silently meant a dispatcher
      // who picked a deactivated or stale engineer got a visit assigned to
      // THEMSELVES, with a 201 and no warning -- so nobody was dispatched and
      // the record asserted the dispatcher did the field work.
      let assignee = ctx.user ? ctx.user.id : null;
      if (body.field_engineer !== undefined) {
        // Naming someone else is dispatch; the coarse write verb is too broad.
        requireAction(ctx, "service.assign");
        if (body.field_engineer === null) {
          assignee = null;
        } else {
          assignee = await resolveAssignee(svc, ctx.tenantId, body.field_engineer);
          if (!assignee) {
            return json(res, 400, { error: { message: "field_engineer must be an approved member of this tenant" } });
          }
        }
      }
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
        field_engineer: assignee,
        status: STATUSES.has(body.status) ? body.status : "PLANNED",
        notes: body.notes || null,
        // Service-report fields (migration 191). report_number + support_type
        // are cross-cutting columns; everything form-specific goes in
        // report_fields (a template describes it) so a new field needs no
        // migration and the report adapts per tenant + per customer.
        report_number: body.report_number || null,
        support_type: body.support_type || null,
        report_fields: (body.report_fields && typeof body.report_fields === "object") ? body.report_fields : {},
        customer_contact_id: body.customer_contact_id || null,
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
      const allowed = ["status","check_in_at","check_out_at","observation","possible_cause","action_taken","followup_action","notes","line_or_station","purpose","report_number","support_type","report_fields","customer_contact_id"];
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      // Reassignment. Not in `allowed` because it is the one field that must be
      // validated rather than copied: an unchecked id would assign a visit to
      // another tenant's user. Explicit null unassigns.
      if (body.field_engineer !== undefined) {
        requireAction(ctx, "service.assign");
        if (body.field_engineer === null) {
          patch.field_engineer = null;
        } else {
          const assignee = await resolveAssignee(svc, ctx.tenantId, body.field_engineer);
          if (!assignee) {
            return json(res, 400, { error: { message: "field_engineer must be an approved member of this tenant" } });
          }
          patch.field_engineer = assignee;
        }
      }
      if (body.checkin) { patch.status = "CHECKED_IN"; patch.check_in_at = new Date().toISOString(); }
      if (body.checkout) { patch.status = "CHECKED_OUT"; patch.check_out_at = new Date().toISOString(); }
      // Reassignment is the one patch where the PREVIOUS value matters: "who
      // took this visit off me, and from whom" is unanswerable from a delta.
      let before = null;
      if (patch.field_engineer !== undefined) {
        const prev = await svc.from("service_visits").select("field_engineer")
          .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
        if (!prev.error && prev.data) before = { field_engineer: prev.data.field_engineer };
      }
      const { data, error } = await svc.from("service_visits").update(patch).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "visit_update", objectType: "service_visit", objectId: body.id, ...(before ? { before } : {}), after: patch });
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
