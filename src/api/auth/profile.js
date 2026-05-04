// GET  /api/auth/profile     -> current user profile (email, display name, memberships)
// PATCH /api/auth/profile    -> update display name in user_metadata
//
// The "Edit profile" UX in Admin Center talks to this endpoint. The
// signed-in user can update their own display name; nothing here
// allows editing other users' profiles (that would be admin-only on a
// separate route).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    if (!ctx.user) return json(res, 401, { error: { message: "Sign in to access your profile" } });
    const svc = serviceClient();

    if (req.method === "GET") {
      const memberships = await svc
        .from("tenant_members")
        .select("tenant_id, role, tenants:tenant_id(slug, display_name)")
        .eq("user_id", ctx.user.id);
      if (memberships.error) throw new Error(memberships.error.message);
      const meta = ctx.user.user_metadata || {};
      return json(res, 200, {
        user: {
          id: ctx.user.id,
          email: ctx.user.email,
          display_name: meta.name || meta.full_name || null,
          last_sign_in_at: ctx.user.last_sign_in_at || null,
          created_at: ctx.user.created_at || null,
        },
        memberships: memberships.data || [],
      });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const display_name = String(body?.display_name || "").trim();
      if (!display_name) return json(res, 400, { error: { message: "display_name required" } });
      const merged = { ...(ctx.user.user_metadata || {}), name: display_name };
      const upd = await svc.auth.admin.updateUserById(ctx.user.id, { user_metadata: merged });
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "user_profile_update",
        objectType: "auth.users",
        objectId: ctx.user.id,
        after: { display_name },
      });
      return json(res, 200, {
        user: {
          id: ctx.user.id,
          email: ctx.user.email,
          display_name,
        },
      });
    }

    res.setHeader("Allow", "GET, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
