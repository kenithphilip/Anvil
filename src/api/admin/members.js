// /api/admin/members
//   GET    list current tenant members with email, role, last sign-in
//   POST   { email, role } invite a new member by email; sends magic link
//   PATCH  { user_id, role } change role
//   DELETE ?user_id=  revoke membership
// All admin actions require admin role.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ALLOWED_ROLES = new Set(["sales_engineer", "sales_manager", "approver", "viewer", "admin", "operator", "finance"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data: members, error } = await svc.from("tenant_members").select("user_id, role, created_at").eq("tenant_id", ctx.tenantId);
      if (error) throw new Error(error.message);
      const userIds = (members || []).map((m) => m.user_id);
      let users = [];
      if (userIds.length) {
        const { data: usersData } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
        users = (usersData && usersData.users) || [];
      }
      const usersById = new Map(users.map((u) => [u.id, u]));
      const rows = (members || []).map((m) => {
        const u = usersById.get(m.user_id) || {};
        const meta = u.user_metadata || {};
        return {
          user_id: m.user_id,
          email: u.email || "",
          display_name: meta.name || meta.full_name || null,
          role: m.role,
          created_at: m.created_at,
          last_sign_in_at: u.last_sign_in_at || null,
        };
      });
      return json(res, 200, { members: rows });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.email) return json(res, 400, { error: { message: "email required" } });

      // Resend path: regenerate an invite link without touching tenant_members.
      // Used when the original invite email never landed (SMTP misconfigured)
      // and an admin needs to copy-paste the magic link to the invitee.
      if (body.resend === true) {
        const link = await svc.auth.admin.generateLink({ type: "invite", email: body.email });
        if (link.error) throw new Error(link.error.message);
        const action_link = link.data && link.data.properties && link.data.properties.action_link;
        await recordAudit(ctx, { action: "member_invite_resend", objectType: "tenant_members", objectId: body.email, after: { email: body.email } });
        return json(res, 200, { resent: true, action_link: action_link || null });
      }

      const role = ALLOWED_ROLES.has(body.role) ? body.role : "sales_engineer";
      const invite = await svc.auth.admin.inviteUserByEmail(body.email);
      if (invite.error) throw new Error(invite.error.message);
      const userId = invite.data && invite.data.user && invite.data.user.id;
      if (!userId) throw new Error("Auth invite returned no user id");
      const upsert = await svc.from("tenant_members").upsert({ tenant_id: ctx.tenantId, user_id: userId, role }, { onConflict: "tenant_id,user_id" }).select("*").single();
      if (upsert.error) throw new Error(upsert.error.message);
      await recordAudit(ctx, { action: "member_invite", objectType: "tenant_members", objectId: userId, after: { email: body.email, role } });
      // Surface the action_link so the UI can offer a copy-link fallback when
      // SMTP isn't configured. Supabase returns it on the invite payload when
      // the project is configured to surface it (which is always for the
      // service-role admin path).
      const action_link = invite.data && invite.data.properties && invite.data.properties.action_link;
      return json(res, 200, {
        member: { user_id: userId, email: body.email, role, created_at: upsert.data.created_at },
        action_link: action_link || null,
      });
    }
    if (req.method === "PATCH") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.user_id || !ALLOWED_ROLES.has(body.role)) return json(res, 400, { error: { message: "user_id and valid role required" } });
      const { data, error } = await svc.from("tenant_members").update({ role: body.role }).eq("tenant_id", ctx.tenantId).eq("user_id", body.user_id).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "member_role_change", objectType: "tenant_members", objectId: body.user_id, after: { role: body.role } });
      return json(res, 200, { member: data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const userId = req.query.user_id;
      if (!userId) return json(res, 400, { error: { message: "user_id required" } });
      const { error } = await svc.from("tenant_members").delete().eq("tenant_id", ctx.tenantId).eq("user_id", userId);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "member_revoke", objectType: "tenant_members", objectId: userId });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
