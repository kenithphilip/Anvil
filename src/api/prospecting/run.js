// /api/prospecting/run
//
// Cron-driven (or admin-triggered) sender. Picks up approved targets,
// renders the campaign template, hands the draft to
// `_lib/communications/send.js` (which speaks SendGrid). Respects:
//   - send window (campaign-local hours)
//   - daily send cap
//   - global + tenant suppressions
//   - sent_at idempotency
//
// Phase 6 (C.6). Heavy lifting (lead-scoring providers, ZoomInfo /
// Apollo) lives in `_lib/prospecting-providers.js`; this endpoint
// is the dispatch loop.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { commsRow } from "../_lib/comms-row.js";

const CRON_SECRET = process.env.CRON_SECRET;

const renderTemplate = (template, target) => {
  if (!template) return "";
  return String(template)
    .replace(/\{\{name\}\}/gi, target.display_name || "there")
    .replace(/\{\{company\}\}/gi, target.company || "your company")
    .replace(/\{\{title\}\}/gi, target.title || "");
};

const inSendWindow = (campaign) => {
  if (!campaign.send_window_local_start || !campaign.send_window_local_end) return true;
  const now = new Date();
  const hh = now.getUTCHours();
  const mm = now.getUTCMinutes();
  const cur = hh * 60 + mm;
  const [sh, sm] = String(campaign.send_window_local_start).split(":").map(Number);
  const [eh, em] = String(campaign.send_window_local_end).split(":").map(Number);
  const startM = (sh || 0) * 60 + (sm || 0);
  const endM = (eh || 0) * 60 + (em || 0);
  return cur >= startM && cur <= endM;
};

const runForCampaign = async (svc, tenantId, campaign) => {
  if (campaign.status !== "active") return { campaign_id: campaign.id, skipped: "not_active" };
  if (!inSendWindow(campaign)) return { campaign_id: campaign.id, skipped: "outside_send_window" };

  // Count today's sends to enforce the daily cap.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const sentToday = await svc.from("prospecting_targets")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId).eq("campaign_id", campaign.id)
    .eq("status", "sent")
    .gte("sent_at", dayStart.toISOString());
  const sentCount = sentToday?.count || 0;
  const remaining = Math.max(0, (campaign.daily_send_cap || 100) - sentCount);
  if (remaining === 0) return { campaign_id: campaign.id, skipped: "daily_cap" };

  const due = await svc.from("prospecting_targets").select("*")
    .eq("tenant_id", tenantId).eq("campaign_id", campaign.id)
    .eq("status", "approved")
    .order("score", { ascending: false })
    .limit(remaining);
  if (due.error) throw new Error("targets read: " + due.error.message);

  let sent = 0;
  for (const target of due.data || []) {
    // Re-check suppression at send time.
    const supp = await svc.from("prospecting_suppressions").select("id")
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .eq("email", target.email).limit(1);
    if (supp.data?.length) {
      await svc.from("prospecting_targets").update({ status: "unsubscribed" }).eq("id", target.id);
      continue;
    }
    const subject = renderTemplate(campaign.template_subject, target);
    const body = renderTemplate(campaign.template_body, target);
    // Draft + dispatch via the existing communications surface.
    await svc.from("communications").insert(commsRow({
      tenant_id: tenantId,
      to_address: target.email,
      to_name: target.display_name || null,
      subject,
      body,
      channel: "email",
      status: "queued",
      origin: "prospecting",
      origin_ref: { campaign_id: campaign.id, target_id: target.id },
    }));
    await svc.from("prospecting_targets").update({
      status: "sent",
      sent_at: new Date().toISOString(),
    }).eq("id", target.id);
    sent += 1;
  }
  return { campaign_id: campaign.id, sent, remaining };
};

const runForTenant = async (svc, tenantId) => {
  const camps = await svc.from("prospecting_campaigns").select("*")
    .eq("tenant_id", tenantId).eq("status", "active");
  if (camps.error) throw new Error("campaigns read: " + camps.error.message);
  const out = [];
  for (const c of camps.data || []) out.push(await runForCampaign(svc, tenantId, c));
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    if (isCron) {
      const tenants = await svc.from("prospecting_campaigns").select("tenant_id").eq("status", "active");
      const uniq = Array.from(new Set((tenants.data || []).map((r) => r.tenant_id)));
      const out = [];
      for (const tid of uniq) {
        try { out.push({ tenant_id: tid, results: await runForTenant(svc, tid) }); }
        catch (err) { out.push({ tenant_id: tid, error: err.message }); }
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: { message: "Method not allowed" } });
    }
    const results = await runForTenant(svc, ctx.tenantId);
    await recordAudit(ctx, {
      action: "prospecting_run",
      objectType: "tenant",
      objectId: ctx.tenantId,
      detail: "campaigns=" + results.length,
    });
    return json(res, 200, { ok: true, results });
  } catch (err) {
    return sendError(res, err);
  }
}
