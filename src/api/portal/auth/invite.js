// /api/portal/auth/invite  (internal — admin / customer_support)
//   GET  ?customer_id=...                     list a customer's portal users
//   POST { customer_id, email, display_name?, role?, require_mfa? }  invite a user
//   POST { user_id, action: 'suspend'|'activate' }                   manage a user
//
// Creates a Supabase auth user (invite email -> they set their own password) and
// a portal_users row (status=invited) bound to the customer. Segregated from
// internal staff onboarding.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";

const ROLES = new Set(["portal_admin", "portal_member"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("portal_users")
        .select("id, customer_id, email, display_name, role, status, require_mfa, auth_provider, last_login_at, created_at")
        .eq("tenant_id", ctx.tenantId);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return json(res, 200, { portal_users: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);

      // Manage an existing user (suspend / re-activate).
      if (body.user_id && body.action) {
        const status = body.action === "suspend" ? "suspended" : body.action === "activate" ? "active" : null;
        if (!status) return json(res, 400, { error: { message: "action must be suspend|activate" } });
        const upd = await svc.from("portal_users").update({ status })
          .eq("tenant_id", ctx.tenantId).eq("id", body.user_id).select("*").single();
        if (upd.error) throw new Error(upd.error.message);
        await recordAudit(ctx, { action: "portal_user_" + body.action, objectType: "portal_user", objectId: body.user_id });
        return json(res, 200, { portal_user: upd.data });
      }

      // Invite a new portal user.
      const email = String(body.email || "").trim().toLowerCase();
      const customerId = body.customer_id;
      const role = ROLES.has(body.role) ? body.role : "portal_member";
      if (!email || !customerId) return json(res, 400, { error: { message: "customer_id and email required" } });

      const cust = await svc.from("customers").select("id").eq("tenant_id", ctx.tenantId).eq("id", customerId).maybeSingle();
      if (cust.error) throw new Error(cust.error.message);
      if (!cust.data) return json(res, 404, { error: { message: "customer not found" } });

      const invite = await svc.auth.admin.inviteUserByEmail(email);
      if (invite.error) throw new Error(invite.error.message);
      const authUserId = invite.data && invite.data.user && invite.data.user.id;
      if (!authUserId) throw new Error("Auth invite returned no user id");

      const ins = await svc.from("portal_users").upsert({
        tenant_id: ctx.tenantId,
        customer_id: customerId,
        auth_user_id: authUserId,
        email,
        display_name: body.display_name || null,
        role,
        status: "invited",
        require_mfa: body.require_mfa === true,
        invited_by: (ctx.user && ctx.user.id) || null,
      }, { onConflict: "tenant_id,customer_id,email" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);

      await recordAudit(ctx, { action: "portal_user_invited", objectType: "portal_user", objectId: ins.data.id, detail: { customer_id: customerId, email } });
      return json(res, 200, { portal_user: ins.data });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
