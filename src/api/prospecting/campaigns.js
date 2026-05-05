// /api/prospecting/campaigns
//
//   GET   list campaigns for the calling tenant.
//   POST  body: { name, description?, template_subject, template_body,
//                 send_window_local_start?, send_window_local_end?,
//                 daily_send_cap? }
//   PATCH body: { id, status?, ...patch }
//
// Phase 6 (C.6).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ALLOWED_STATUSES = new Set(["draft","active","paused","archived"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    const svc = serviceClient();

    if (req.method === "GET") {
      const r = await svc.from("prospecting_campaigns")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false });
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { campaigns: r.data || [] });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (!body?.name || !body?.template_subject || !body?.template_body) {
        return json(res, 400, { error: { message: "name, template_subject, template_body required" } });
      }
      const ins = await svc.from("prospecting_campaigns").insert({
        tenant_id: ctx.tenantId,
        name: body.name,
        description: body.description || null,
        template_subject: body.template_subject,
        template_body: body.template_body,
        send_window_local_start: body.send_window_local_start || "09:00",
        send_window_local_end: body.send_window_local_end || "17:00",
        daily_send_cap: Number(body.daily_send_cap || 100),
        created_by: ctx.userId || null,
      }).select("id").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "prospecting_campaign_created",
        objectType: "prospecting_campaign",
        objectId: ins.data?.id || null,
        detail: body.name,
      });
      return json(res, 200, { ok: true, id: ins.data?.id });
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (!body?.id) return json(res, 400, { error: { message: "id required" } });
      const patch = { updated_at: new Date().toISOString() };
      for (const k of ["name","description","template_subject","template_body","send_window_local_start","send_window_local_end","daily_send_cap"]) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      if (body.status !== undefined) {
        if (!ALLOWED_STATUSES.has(body.status)) {
          return json(res, 400, { error: { message: "status must be one of " + [...ALLOWED_STATUSES].join(", ") } });
        }
        patch.status = body.status;
      }
      const upd = await svc.from("prospecting_campaigns").update(patch)
        .eq("tenant_id", ctx.tenantId).eq("id", body.id).select("id, status").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "prospecting_campaign_updated",
        objectType: "prospecting_campaign",
        objectId: body.id,
        detail: "status=" + (patch.status || "unchanged"),
      });
      return json(res, 200, { ok: true, id: upd.data?.id, status: upd.data?.status });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
