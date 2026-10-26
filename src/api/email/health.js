// GET /api/email/health: the module's health and cost for the tenant's admin.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.1 and 6.7.
//
// Per mailbox: state, last success, checkpoint resets, failures, quota
// errors, requests today against the budget. For the tenant: totals, the
// cron heartbeats, open evidence that waits for a person, failed notices,
// actions by state, what observe mode would make, and the effective policy.
// email.rules (admin). Read only.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, requireAction } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { SAFE_COLUMNS } from "../_lib/mail/connections.js";
import { tenantPolicy } from "../_lib/email-accountability/policy.js";

const WORKERS = ["email/sync", "email/sweep", "email/sweep_daily", "email/purge", "cron/tick", "cron/daily"];
// shortcut: counts read up to this many rows; switch to count queries when a
// tenant passes it.
const CAP = 10_000;

const rows = (what, r) => { if (r.error) throw new Error(what + ": " + r.error.message); return r.data || []; };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") return json(res, 405, { error: { message: "method not allowed" } });
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    requireAction(ctx, "email.rules");
    const svc = serviceClient();
    const s = await tenantSettings(svc, ctx.tenantId);
    const [mailboxes, crons, evidence, notices, items] = await Promise.all([
      svc.from("mailbox_connections").select(SAFE_COLUMNS).eq("tenant_id", ctx.tenantId),
      svc.from("cron_health").select("worker, last_run_at, last_status, consecutive_failures").in("worker", WORKERS),
      svc.from("email_action_evidence").select("id").eq("tenant_id", ctx.tenantId).in("status", ["ambiguous", "claimed"]).limit(CAP),
      svc.from("email_action_notices").select("id").eq("tenant_id", ctx.tenantId).eq("status", "failed").limit(CAP),
      svc.from("work_items").select("status").eq("tenant_id", ctx.tenantId).eq("subject_type", "email_action").limit(CAP),
    ]);
    const mb = rows("mailboxes", mailboxes);
    const today = new Date().toISOString().slice(0, 10);
    const count = (f) => mb.filter(f).length;
    const byStatus = {};
    for (const w of rows("actions", items)) byStatus[w.status] = (byStatus[w.status] || 0) + 1;
    const sum = (k) => mb.reduce((n, m) => n + (Number(m.last_sync_stats?.[k]) || 0), 0);
    return json(res, 200, {
      ok: true,
      settings: {
        enabled: !!s?.email_accountability_enabled,
        actions_mode: s?.email_actions_mode === "create" ? "create" : "observe",
        retention_days: s?.email_content_retention_days ?? 30,
      },
      totals: {
        mailboxes: mb.length,
        active: count((m) => m.status === "active" && !m.pause_reason),
        paused: count((m) => m.status === "paused" || !!m.pause_reason),
        reauth_required: count((m) => m.status === "reauth_required"),
        disconnected: count((m) => m.status === "disconnected"),
        requests_today: mb.reduce((n, m) => n + (m.requests_date === today ? m.requests_today || 0 : 0), 0),
        budget_today: mb.filter((m) => m.status !== "disconnected").reduce((n, m) => n + (m.daily_request_budget || 0), 0),
        quota_errors: mb.reduce((n, m) => n + (m.quota_errors || 0), 0),
        checkpoint_resets: mb.reduce((n, m) => n + (m.checkpoint_resets || 0), 0),
      },
      waiting_for_a_person: rows("evidence", evidence).length,
      failed_notices: rows("notices", notices).length,
      actions_by_status: byStatus,
      last_sync_counts: { would_create: sum("would_create"), would_verify: sum("would_verify"), created: sum("created"), verified: sum("verified") },
      crons: rows("crons", crons),
      policy: tenantPolicy(s?.email_policy),
      mailboxes: mb,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
