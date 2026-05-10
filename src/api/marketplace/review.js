// GET  /api/marketplace/review              super-admin review queue
// POST /api/marketplace/review              { global_id, decision, reason? }
//                                          decision: approve | reject
// POST /api/marketplace/review/revoke       { global_id, reason? }
//                                          super-admin revoke from confirmed
//                                          abuse report
//
// RBAC: super-admin only. We treat the platform-admin (env var
// SUPER_ADMIN_USER_IDS) or any tenant-admin in the special
// "platform" tenant as the super-admin set. The check is conservative:
// when no super-admin is configured, the endpoint returns 403.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { revokeTemplate } from "../_lib/docai/marketplace.js";

const SUPER_ADMIN_IDS = (process.env.SUPER_ADMIN_USER_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const isSuperAdmin = (ctx) => {
  if (!ctx.user?.id) return false;
  if (SUPER_ADMIN_IDS.length === 0) return false;
  return SUPER_ADMIN_IDS.includes(ctx.user.id);
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    if (!isSuperAdmin(ctx)) {
      return json(res, 403, { error: { message: "super_admin_only" } });
    }
    const svc = serviceClient();
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    const action = segments[3];

    if (req.method === "GET") {
      const r = await svc.from("customer_format_templates_global")
        .select("*")
        .eq("status", "pending_review")
        .order("created_at", { ascending: true })
        .limit(200);
      if (r.error) throw new Error(r.error.message);
      // Also fetch any unresolved reports.
      const reports = await svc.from("template_reports")
        .select("*")
        .is("resolved_at", null)
        .order("created_at", { ascending: false })
        .limit(200);
      return json(res, 200, {
        queue: r.data || [],
        reports: reports.data || [],
      });
    }

    if (req.method === "POST" && action === "revoke") {
      const body = await readBody(req);
      if (!body.global_id) {
        return json(res, 400, { error: { message: "global_id required" } });
      }
      const r = await revokeTemplate(svc, {
        globalId: body.global_id,
        reason: body.reason || "super_admin_revoked",
        by_user_id: ctx.user?.id || null,
        super_admin: true,
      });
      await recordAudit(ctx, {
        action: "marketplace.super_admin.revoked",
        objectType: "customer_format_templates_global",
        objectId: body.global_id,
        detail: { reason: body.reason || "super_admin_revoked" },
      });
      return json(res, 200, r);
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body.global_id || !body.decision) {
        return json(res, 400, { error: { message: "global_id + decision required" } });
      }
      if (!["approve", "reject"].includes(body.decision)) {
        return json(res, 400, { error: { message: "decision must be approve or reject" } });
      }
      const existing = await svc.from("customer_format_templates_global")
        .select("*").eq("id", body.global_id).maybeSingle();
      if (existing.error) throw new Error(existing.error.message);
      if (!existing.data) return json(res, 404, { error: { message: "not_found" } });
      if (existing.data.status !== "pending_review") {
        return json(res, 409, { error: { message: "not_in_pending_review_status_=_" + existing.data.status } });
      }
      const nextStatus = body.decision === "approve" ? "approved" : "rejected";
      const upd = await svc.from("customer_format_templates_global").update({
        status: nextStatus,
        approval_kind: "human",
        reviewed_by: ctx.user?.id || null,
        reviewed_at: new Date().toISOString(),
        rejection_reason: body.decision === "reject" ? (body.reason || null) : null,
      }).eq("id", body.global_id).select("*").maybeSingle();
      if (upd.error) throw new Error(upd.error.message);
      // If approving the publisher's first-ever submission, stamp
      // the verified_at flag so subsequent publications auto-approve.
      if (body.decision === "approve" && existing.data.publisher_tenant_id) {
        await svc.from("tenant_settings").update({
          template_marketplace_publisher_verified_at: new Date().toISOString(),
        }).eq("tenant_id", existing.data.publisher_tenant_id);
      }
      // Update the publication audit row.
      await svc.from("template_publications").update({
        status: nextStatus === "approved" ? "approved" : "rejected",
        rejection_reason: body.decision === "reject" ? (body.reason || null) : null,
      }).eq("global_id", body.global_id);
      await recordAudit(ctx, {
        action: "marketplace.super_admin." + body.decision,
        objectType: "customer_format_templates_global",
        objectId: body.global_id,
        detail: { reason: body.reason },
      });
      return json(res, 200, { template: upd.data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
