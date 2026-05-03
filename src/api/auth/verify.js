// POST /api/auth/verify
// Body: { access_token }
// Validates the token, lists tenant memberships, and returns the resolved profile.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { serviceClient, userClient } from "../_lib/supabase.js";
import { ensureMembership } from "../_lib/tenancy.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const body = await readBody(req);
    const token = String(body && body.access_token || "").trim();
    if (!token) return json(res, 400, { error: { message: "access_token required" } });
    const supa = userClient(token);
    const { data, error } = await supa.auth.getUser();
    if (error || !data || !data.user) return json(res, 401, { error: { message: "Invalid token" } });
    const svc = serviceClient();

    // Auto-onboard: every signed-in user gets a tenant_members row in
    // the default tenant. Without this, every API call after sign-in
    // throws 403 and the UI shows zeros, which is exactly the symptom
    // we were seeing on the live deploy.
    await ensureMembership(svc, data.user);

    const memberships = await svc
      .from("tenant_members")
      .select("tenant_id, role, tenants:tenant_id(slug, display_name)")
      .eq("user_id", data.user.id);
    if (memberships.error) throw new Error(memberships.error.message);
    return json(res, 200, {
      user: { id: data.user.id, email: data.user.email, app_metadata: data.user.app_metadata },
      memberships: memberships.data || [],
    });
  } catch (err) {
    sendError(res, err);
  }
}
