// POST /api/marketplace/revoke
//   { global_id, reason? }
//
// Publisher-initiated revoke. Marks the global template as revoked
// and reverts any consumer imports referencing it. Increment of
// the publisher's revoke_count is reserved for super-admin
// revocations (i.e. confirmed abuse); a publisher revoking their
// own template should not damage their reputation.
//
// RBAC: admin only. Publisher must own the row.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { revokeTemplate } from "../_lib/docai/marketplace.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const body = await readBody(req);
    if (!body.global_id) {
      return json(res, 400, { error: { message: "global_id required" } });
    }
    const svc = serviceClient();
    // Verify publisher ownership before allowing revoke.
    const tpl = await svc.from("customer_format_templates_global")
      .select("publisher_tenant_id")
      .eq("id", body.global_id).maybeSingle();
    if (tpl.error) throw new Error(tpl.error.message);
    if (!tpl.data) return json(res, 404, { error: { message: "not_found" } });
    if (tpl.data.publisher_tenant_id !== ctx.tenantId) {
      return json(res, 403, { error: { message: "only publisher can revoke" } });
    }
    const r = await revokeTemplate(svc, {
      globalId: body.global_id,
      reason: body.reason || "publisher_revoked",
      by_user_id: ctx.user?.id || null,
      super_admin: false,
    });
    await recordAudit(ctx, {
      action: "marketplace.publish.revoked",
      objectType: "customer_format_templates_global",
      objectId: body.global_id,
      detail: { reason: body.reason, super_admin: false },
    });
    return json(res, 200, r);
  } catch (err) { sendError(res, err); }
}
