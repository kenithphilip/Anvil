// POST or GET /api/push/send
//
// POST (admin):  { user_id?, title, body, url?, data? } - enqueues a
//                push notification for one user (or all current
//                user's tenant if user_id is omitted).
// GET (cron):    drains the push_notifications queue (status=queued)
//                via Bearer CRON_SECRET. Sends via web-push to each
//                active subscription, marks success / failure.
//                Expired subscriptions (404/410) flip to is_active=false.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { sendWebPush, webPushIsConfigured } from "../_lib/web-push.js";

const CRON_SECRET = process.env.CRON_SECRET;

const drain = async (svc) => {
  const rows = await svc.from("push_notifications").select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(50);
  if (rows.error) throw new Error(rows.error.message);
  const out = [];
  for (const n of rows.data || []) {
    let subs = [];
    if (n.subscription_id) {
      const r = await svc.from("push_subscriptions").select("*").eq("id", n.subscription_id).eq("is_active", true);
      subs = r.data || [];
    } else if (n.user_id) {
      const r = await svc.from("push_subscriptions").select("*")
        .eq("tenant_id", n.tenant_id).eq("user_id", n.user_id).eq("is_active", true);
      subs = r.data || [];
    } else {
      const r = await svc.from("push_subscriptions").select("*")
        .eq("tenant_id", n.tenant_id).eq("is_active", true);
      subs = r.data || [];
    }
    if (!subs.length) {
      await svc.from("push_notifications").update({ status: "failed", error: "no active subscriptions" }).eq("id", n.id);
      out.push({ id: n.id, ok: false, reason: "no_subs" });
      continue;
    }
    let allOk = true;
    for (const s of subs) {
      if (s.channel !== "web") continue; // FCM/APNs deferred
      const result = await sendWebPush(s, {
        title: n.title, body: n.body, url: n.url, data: n.data,
      }).catch((err) => ({ ok: false, status: 0, error: err.message }));
      if (!result.ok) {
        allOk = false;
        if (result.expired) {
          await svc.from("push_subscriptions").update({ is_active: false }).eq("id", s.id);
        }
      }
    }
    await svc.from("push_notifications").update({
      status: allOk ? "sent" : "failed",
      sent_at: allOk ? new Date().toISOString() : null,
      attempt_count: (n.attempt_count || 0) + 1,
      error: allOk ? null : "one or more sends failed",
    }).eq("id", n.id);
    out.push({ id: n.id, ok: allOk });
  }
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron && req.method === "GET") {
      const out = await drain(svc);
      return json(res, 200, { ran_at: new Date().toISOString(), processed: out.length, results: out, web_push_configured: webPushIsConfigured() });
    }
    if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.title) return json(res, 400, { error: { message: "title required" } });
    const ins = await svc.from("push_notifications").insert({
      tenant_id: ctx.tenantId,
      user_id: body.user_id || null,
      subscription_id: body.subscription_id || null,
      title: body.title,
      body: body.body || null,
      url: body.url || null,
      data: body.data || {},
    }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);
    await recordAudit(ctx, {
      action: "push_notification_queued",
      objectType: "push_notification",
      objectId: ins.data.id,
      detail: body.title.slice(0, 60),
    });
    return json(res, 200, { ok: true, id: ins.data.id });
  } catch (err) { sendError(res, err); }
}
