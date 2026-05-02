// GET  /api/customers/profile_versions?customerId=
// POST /api/customers/profile_versions  body: { profileVersionId }   (rollback)

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
      const customerId = req.query.customerId;
      if (!customerId) return json(res, 400, { error: { message: "customerId required" } });
      const { data, error } = await svc.from("customer_format_profile_versions")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("customer_id", customerId)
        .order("version", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return json(res, 200, { versions: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      const versionId = body && body.profileVersionId;
      if (!versionId) return json(res, 400, { error: { message: "profileVersionId required" } });
      const versionRow = await svc.from("customer_format_profile_versions").select("*").eq("tenant_id", ctx.tenantId).eq("id", versionId).single();
      if (versionRow.error || !versionRow.data) return json(res, 404, { error: { message: "Version not found" } });
      const v = versionRow.data;
      // Mark all current profiles for this customer as not current.
      await svc.from("customer_format_profiles").update({ is_current: false }).eq("tenant_id", ctx.tenantId).eq("customer_id", v.customer_id).eq("is_current", true);
      // Insert a new current profile copying the chosen version.
      const inserted = await svc.from("customer_format_profiles").insert({
        tenant_id: ctx.tenantId,
        customer_id: v.customer_id,
        version: (v.version || 0) + 1000, // bump to indicate rollback
        fingerprint: v.fingerprint || {},
        recipe: v.recipe || {},
        learned_rules: v.learned_rules || {},
        format_change_summary: "Rollback to version " + v.version,
        trusted: false,
        is_current: true,
      }).select("*").single();
      if (inserted.error) throw new Error(inserted.error.message);
      await recordAudit(ctx, { action: "profile_rollback", objectType: "customer", objectId: v.customer_id, detail: "rolled back to version " + v.version });
      return json(res, 200, { profile: inserted.data });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
