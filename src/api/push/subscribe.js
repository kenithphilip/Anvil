// POST /api/push/subscribe
// Body: { endpoint, p256dh, auth, channel?: 'web' | 'fcm' | 'apns', device_token?, user_agent? }
//
// Stores or updates a push subscription for the current user. Idempotent
// on (tenant_id, user_id, endpoint|device_token); a re-subscription
// flips is_active back to true and bumps last_seen_at.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (!ctx.userId) return json(res, 401, { error: { message: "must be signed in" } });
    const body = await readBody(req);
    const channel = body?.channel || "web";
    if (channel === "web" && (!body?.endpoint || !body?.p256dh || !body?.auth)) {
      return json(res, 400, { error: { message: "endpoint, p256dh, auth required for web push" } });
    }
    if ((channel === "fcm" || channel === "apns") && !body?.device_token) {
      return json(res, 400, { error: { message: "device_token required" } });
    }
    const svc = serviceClient();
    const existing = await svc.from("push_subscriptions").select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("user_id", ctx.userId)
      .or(channel === "web"
        ? `endpoint.eq.${body.endpoint}`
        : `device_token.eq.${body.device_token}`)
      .maybeSingle();
    if (existing.data) {
      await svc.from("push_subscriptions").update({
        channel,
        endpoint: body.endpoint || null,
        p256dh: body.p256dh || null,
        auth: body.auth || null,
        device_token: body.device_token || null,
        user_agent: body.user_agent || null,
        is_active: true,
        last_seen_at: new Date().toISOString(),
      }).eq("id", existing.data.id);
      return json(res, 200, { ok: true, id: existing.data.id, updated: true });
    }
    const ins = await svc.from("push_subscriptions").insert({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      channel,
      endpoint: body.endpoint || null,
      p256dh: body.p256dh || null,
      auth: body.auth || null,
      device_token: body.device_token || null,
      user_agent: body.user_agent || null,
      is_active: true,
    }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);
    return json(res, 200, { ok: true, id: ins.data.id, updated: false });
  } catch (err) { sendError(res, err); }
}
