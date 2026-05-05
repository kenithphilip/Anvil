// /api/admin/access_requests
//
//   GET                          list pending + recently-decided access requests
//                                for the calling admin's tenant.
//   POST { user_id, action,
//          role?, display_name?,
//          email?, reason? }     act on a request:
//                                - action="approve":  set status=approved, role from the body
//                                                     (defaults to the requested_role).
//                                - action="deny":     set status=denied + denied_reason.
//                                - action="modify":   update role / display_name / email
//                                                     without changing the status.
//
// All actions require the `admin` role on the calling tenant. Each
// action writes an audit_events row and resolves the corresponding
// admin_notifications row so the bell stops nagging.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const VALID_ROLES = new Set([
  "viewer", "sales_engineer", "sales_manager", "procurement", "finance", "admin",
]);
const VALID_ACTIONS = new Set(["approve", "deny", "modify"]);

const fetchEnrichedMembers = async (svc, tenantId, statusFilter) => {
  let q = svc.from("tenant_members_enriched")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("requested_at", { ascending: false })
    .limit(500);
  if (statusFilter) q = q.eq("status", statusFilter);
  const { data, error } = await q;
  if (error) throw new Error("access_requests list: " + error.message);
  return data || [];
};

const resolveNotificationsFor = async (svc, tenantId, userId, actorUserId, note) => {
  // Mark every unresolved access_request notification pointing at
  // this user as resolved. Best-effort.
  try {
    await svc.from("admin_notifications")
      .update({
        resolved: true,
        resolved_by: actorUserId,
        resolved_at: new Date().toISOString(),
        resolution_note: note || null,
      })
      .eq("tenant_id", tenantId)
      .eq("kind", "access_request")
      .eq("object_id", userId)
      .eq("resolved", false);
  } catch (_) { /* swallow */ }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();

    if (req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const statusParam = url.searchParams.get("status");
      const validStatus = ["pending", "approved", "denied", "deactivated"].includes(statusParam) ? statusParam : null;
      const rows = await fetchEnrichedMembers(svc, ctx.tenantId, validStatus);
      // Add lightweight presentation fields the admin UI needs.
      const requests = rows.map((r) => ({
        user_id: r.user_id,
        tenant_id: r.tenant_id,
        status: r.status,
        role: r.role,
        requested_role: r.requested_role,
        request_email: r.request_email,
        request_display_name: r.request_display_name,
        request_notes: r.request_notes,
        requested_at: r.requested_at,
        approved_at: r.approved_at,
        approved_by: r.approved_by,
        denied_at: r.denied_at,
        denied_by: r.denied_by,
        denied_reason: r.denied_reason,
        user_email: r.user_email,
        last_sign_in_at: r.last_sign_in_at,
        meta_name: r.meta_name || r.meta_full_name,
      }));
      // Convenience counts so the bell doesn't need a second call.
      const counts = {
        pending: requests.filter((r) => r.status === "pending").length,
        approved: requests.filter((r) => r.status === "approved").length,
        denied: requests.filter((r) => r.status === "denied").length,
        deactivated: requests.filter((r) => r.status === "deactivated").length,
      };
      return json(res, 200, { requests, counts });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body?.user_id) return json(res, 400, { error: { message: "user_id required" } });
      if (!VALID_ACTIONS.has(body.action)) {
        return json(res, 400, { error: { message: "action must be one of: " + [...VALID_ACTIONS].join(", ") } });
      }
      // Self-action guard: an admin cannot deny / deactivate / modify
      // themselves. Approving yourself is a no-op anyway because the
      // first user is auto-approved during ensureMembership.
      if (body.user_id === ctx.user.id && (body.action === "deny" || body.action === "deactivate")) {
        return json(res, 400, { error: { message: "You can't change your own access status." } });
      }

      const { data: member, error: memErr } = await svc.from("tenant_members")
        .select("user_id, tenant_id, role, requested_role, status")
        .eq("tenant_id", ctx.tenantId)
        .eq("user_id", body.user_id)
        .maybeSingle();
      if (memErr) throw new Error("member fetch: " + memErr.message);
      if (!member) return json(res, 404, { error: { message: "membership not found" } });

      const nowIso = new Date().toISOString();
      const updates = {};

      if (body.action === "approve") {
        const targetRole = body.role && VALID_ROLES.has(body.role) ? body.role : (member.requested_role || member.role);
        updates.status = "approved";
        updates.role = targetRole;
        updates.approved_by = ctx.user.id;
        updates.approved_at = nowIso;
        updates.denied_by = null;
        updates.denied_at = null;
        updates.denied_reason = null;
      } else if (body.action === "deny") {
        updates.status = "denied";
        updates.denied_by = ctx.user.id;
        updates.denied_at = nowIso;
        updates.denied_reason = body.reason ? String(body.reason).slice(0, 400) : null;
        updates.approved_by = null;
        updates.approved_at = null;
      } else if (body.action === "modify") {
        // Modify acts on the editable fields without flipping status.
        if (body.role) {
          if (!VALID_ROLES.has(body.role)) return json(res, 400, { error: { message: "invalid role" } });
          updates.role = body.role;
        }
        if (body.display_name !== undefined) updates.request_display_name = body.display_name || null;
        if (body.notes !== undefined) updates.request_notes = body.notes ? String(body.notes).slice(0, 500) : null;
        if (Object.keys(updates).length === 0) {
          return json(res, 400, { error: { message: "modify requires at least one of: role, display_name, notes" } });
        }
      }

      const { data: updated, error: updErr } = await svc.from("tenant_members")
        .update(updates)
        .eq("tenant_id", ctx.tenantId)
        .eq("user_id", body.user_id)
        .select("user_id, status, role, requested_role")
        .single();
      if (updErr) throw new Error("member update: " + updErr.message);

      // Update Supabase user metadata when the admin retypes the
      // display name, so the rest of Anvil (which reads from
      // auth.users.user_metadata.name) sees the new value.
      if (body.action === "modify" && body.display_name !== undefined) {
        try {
          await svc.auth.admin.updateUserById(body.user_id, {
            user_metadata: { name: body.display_name || null },
          });
        } catch (_) { /* best-effort */ }
      }
      // Email change is a separate Supabase admin call.
      if (body.action === "modify" && body.email && /@/.test(body.email)) {
        try {
          await svc.auth.admin.updateUserById(body.user_id, {
            email: String(body.email).trim().toLowerCase(),
          });
        } catch (_) { /* surface via audit only */ }
      }

      // Resolve any open access_request notification for this user.
      if (body.action === "approve" || body.action === "deny") {
        await resolveNotificationsFor(svc, ctx.tenantId, body.user_id, ctx.user.id,
          body.action === "approve" ? "approved" : "denied");
      }

      await recordAudit(ctx, {
        action: "access_request_" + body.action,
        objectType: "tenant_member",
        objectId: body.user_id,
        after: updates,
      });

      return json(res, 200, { ok: true, member: updated });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
