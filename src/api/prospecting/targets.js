// /api/prospecting/targets
//
//   GET   ?campaign_id=...&status=...   list targets for the campaign.
//   POST  body: { campaign_id, targets: [{ email, display_name?, company?, title?, source?, score?, metadata? }, ...] }
//                 add candidate targets to the campaign in pending state.
//   PATCH body: { id, action: 'approve' | 'deny' | 'unsubscribe', notes? }
//                 admin gate: nothing sends until a target is approved.
//
// Phase 6 (C.6).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const isSuppressed = async (svc, tenantId, email) => {
  const r = await svc.from("prospecting_suppressions").select("id")
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .eq("email", email)
    .limit(1);
  return !!(r.data && r.data.length);
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();

    if (req.method === "GET") {
      const url = new URL(req.url || "/", "http://x");
      const campaignId = url.searchParams.get("campaign_id");
      const status = url.searchParams.get("status");
      let q = svc.from("prospecting_targets")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("score", { ascending: false })
        .limit(500);
      if (campaignId) q = q.eq("campaign_id", campaignId);
      if (status) q = q.eq("status", status);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { targets: r.data || [], count: (r.data || []).length });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body?.campaign_id || !Array.isArray(body?.targets)) {
        return json(res, 400, { error: { message: "campaign_id and targets[] required" } });
      }
      let added = 0;
      let suppressed = 0;
      for (const t of body.targets) {
        if (!t?.email) continue;
        const email = String(t.email).trim().toLowerCase();
        if (await isSuppressed(svc, ctx.tenantId, email)) { suppressed += 1; continue; }
        const ins = await svc.from("prospecting_targets").upsert({
          tenant_id: ctx.tenantId,
          campaign_id: body.campaign_id,
          email,
          display_name: t.display_name || null,
          company: t.company || null,
          title: t.title || null,
          source: t.source || null,
          score: t.score == null ? null : Number(t.score),
          metadata: t.metadata || {},
          status: "pending",
        }, { onConflict: "tenant_id,campaign_id,email", ignoreDuplicates: true });
        if (!ins.error) added += 1;
      }
      await recordAudit(ctx, {
        action: "prospecting_targets_added",
        objectType: "prospecting_campaign",
        objectId: body.campaign_id,
        detail: "added=" + added + "::suppressed=" + suppressed,
      });
      return json(res, 200, { ok: true, added, suppressed });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (!body?.id || !body?.action) {
        return json(res, 400, { error: { message: "id and action required" } });
      }
      const patch = {};
      if (body.action === "approve") {
        patch.status = "approved";
        patch.approved_by = ctx.userId || null;
        patch.approved_at = new Date().toISOString();
      } else if (body.action === "deny") {
        patch.status = "denied";
      } else if (body.action === "unsubscribe") {
        patch.status = "unsubscribed";
        // Add to suppression list so we never email this address again.
        const t = await svc.from("prospecting_targets").select("email")
          .eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
        if (t.data?.email) {
          await svc.from("prospecting_suppressions").upsert({
            tenant_id: ctx.tenantId,
            email: t.data.email,
            reason: body.notes || "explicit unsubscribe",
          }, { onConflict: "tenant_id,email", ignoreDuplicates: true });
        }
      } else {
        return json(res, 400, { error: { message: "action must be approve | deny | unsubscribe" } });
      }
      const upd = await svc.from("prospecting_targets").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).select("id, status").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "prospecting_target_" + body.action,
        objectType: "prospecting_target",
        objectId: body.id,
        detail: "status=" + (upd.data?.status || ""),
      });
      return json(res, 200, { ok: true, id: upd.data?.id, status: upd.data?.status });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
