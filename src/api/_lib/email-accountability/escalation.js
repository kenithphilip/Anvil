// Reminders and escalation for open email actions.
// docs/EMAIL_ACCOUNTABILITY_SCOPE.md 6.7.
//
// noticesFor() is pure: the notices one action is due now, by the policy.
// runSweep() sends them. A notice is sent only after its ledger row
// (email_action_notices, unique per action and key) is inserted, so repeated
// or overlapping sweeps never send one twice. A failed send is retried on the
// next sweeps, up to 3 attempts.
//
// Keys: the kind, the reopen count (a cycle), the level, the owner (for the
// notices to the owner) and the due time. A new owner, a new due time or a
// reopen re-arms the notices; nothing else does.
//
// Privacy: a notice to the owner names the mail subject (the owner can open
// the action). An escalation to the backup or to roles names no subject: a
// role in the policy may not be allowed to open the action.

import { addBusinessMinutes } from "./business-time.js";
import { tenantPolicy, policyFor } from "./policy.js";
import { OPEN_CATEGORIES } from "./store.js";
import { notify } from "../notifications.js";
import { recordAudit } from "../audit.js";

const LABEL = { 1: "critical", 2: "high", 3: "normal", 4: "informational" };
const MAX_ATTEMPTS = 3;
const MINUTE = 60_000;

const short = (s, n = 90) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));

// row: { ea, wi, ownerActive }. Returns [{ key, kind, level, users, roles, title, body }].
export const noticesFor = ({ ea, wi, ownerActive }, policy, now) => {
  const priority = LABEL[wi.priority];
  if (!priority || priority === "informational" || !OPEN_CATEGORIES.includes(wi.status_category)) return [];
  const tz = policy.timezone;
  const hours = policy.business_hours;
  const cycle = ea.reopen_count || 0;
  const owner = ownerActive ? wi.assignee_user_id : null;
  const backup = ea.backup_user_id && ea.backup_user_id !== owner ? ea.backup_user_id : null;
  // With no active owner, the backup and the policy roles are told instead.
  const toOwner = owner ? { users: [owner], roles: [] } : { users: backup ? [backup] : [], roles: policy.unowned_roles || [] };
  const who = owner || "none";
  const title = short(wi.title);
  const out = [];
  const created = Date.parse(wi.created_at || ea.created_at);

  if ((policy.notify_on_create || []).includes(priority) && now - created < 24 * 60 * MINUTE) {
    out.push({ key: "created:" + cycle + ":" + who, kind: "created", level: 0, ...toOwner, title: "New " + priority + " email action: " + title });
  }
  const ack = policy.ack_minutes?.[priority];
  if (ack != null && ["pending", "detected"].includes(wi.status)
    && addBusinessMinutes(new Date(created), ack, tz, hours).getTime() <= now) {
    out.push({ key: "ack:" + cycle + ":" + who, kind: "ack", level: 0, ...toOwner, title: "Not started yet: " + title });
  }
  if (!wi.due_at) return out;
  const due = Date.parse(wi.due_at);
  const soon = policy.due_soon_minutes?.[priority];
  if (soon != null && now < due && addBusinessMinutes(new Date(now), soon, tz, hours).getTime() >= due) {
    out.push({ key: "due_soon:" + cycle + ":" + wi.due_at + ":" + who, kind: "due_soon", level: 0, ...toOwner, title: "Due soon: " + title });
  }
  (policy.escalation?.[priority] || []).forEach((step, i) => {
    if (now < due + step.after_minutes * MINUTE) return;
    const level = i + 1;
    const late = Math.max(0, Math.round((now - due) / (60 * MINUTE)));
    out.push({
      key: "overdue:" + cycle + ":" + level + ":" + wi.due_at + ":" + who, kind: "overdue", level, ...toOwner,
      title: "Overdue " + late + " h: " + title,
    });
    const users = step.backup && backup ? [backup] : [];
    const roles = [...(step.roles || []), ...(owner ? [] : policy.unowned_roles || [])];
    if (users.length || roles.length) {
      out.push({
        key: "escalation:" + cycle + ":" + level + ":" + wi.due_at, kind: "escalation", level, users, roles: [...new Set(roles)],
        title: "Escalation level " + level + ": a " + priority + " email action is " + late + " h overdue" + (owner ? "" : " and has no owner"),
      });
    }
  });
  return out;
};

const fail = (what, r) => { if (r.error) throw new Error(what + ": " + r.error.message); return r.data || []; };

const sweepTenant = async (svc, settings, now, sendFn) => {
  const tenantId = settings.tenant_id;
  const policy = tenantPolicy(settings.email_policy);
  const items = fail("items", await svc.from("work_items").select("*")
    .eq("tenant_id", tenantId).eq("subject_type", "email_action").in("status_category", OPEN_CATEGORIES)
    .order("due_at", { ascending: true }).limit(1000));
  if (!items.length) return { tenant_id: tenantId, sent: 0, failed: 0, waiting: 0 };
  const actions = fail("actions", await svc.from("email_actions").select("*")
    .eq("tenant_id", tenantId).in("work_item_id", items.map((w) => w.id)));
  const byItem = new Map(actions.map((a) => [a.work_item_id, a]));
  const members = new Set(fail("members", await svc.from("tenant_members").select("user_id")
    .eq("tenant_id", tenantId).eq("status", "approved")).map((m) => m.user_id));
  const ledger = new Map(fail("ledger", await svc.from("email_action_notices").select("id, email_action_id, notice_key, status, attempts")
    .eq("tenant_id", tenantId).in("email_action_id", actions.map((a) => a.id))).map((n) => [n.email_action_id + "|" + n.notice_key, n]));

  const cap = policy.max_notices_per_run;
  let sent = 0;
  let failed = 0;
  let waiting = 0;
  for (const wi of items) {
    const ea = byItem.get(wi.id);
    if (!ea) continue;
    const p = policyFor(policy, { priority: LABEL[wi.priority], action_type: ea.action_type, mailbox_id: ea.connection_id });
    const due = noticesFor({ ea, wi, ownerActive: members.has(wi.assignee_user_id) }, p, now.getTime());
    let level = ea.escalation_level || 0;
    for (const n of due) {
      const prior = ledger.get(ea.id + "|" + n.key);
      if (prior && (prior.status !== "failed" || prior.attempts >= MAX_ATTEMPTS)) continue;
      if (sent + failed >= cap) { waiting += 1; continue; }
      let rowId = prior?.id;
      if (!prior) {
        const ins = await svc.from("email_action_notices").insert({
          tenant_id: tenantId, email_action_id: ea.id, notice_key: n.key, kind: n.kind, level: n.level,
          recipients: { users: n.users, roles: n.roles }, status: "claimed", attempts: 0,
        }).select("id");
        // 23505: another sweep claimed this notice first.
        if (ins.error?.code === "23505") continue;
        if (ins.error) throw new Error("notice claim: " + ins.error.message);
        rowId = ins.data?.[0]?.id;
      }
      const result = await sendFn(svc, tenantId, {
        kind: "email_action_" + n.kind, title: n.title,
        body: n.kind === "escalation" ? null : ea.from_address ? "From " + ea.from_address : null,
        link_route: "email_actions", link_params: { id: ea.id },
        object_type: "email_action", object_id: ea.id,
      }, { users: n.users, roles: n.roles });
      const ok = !result?.error && !result?.skipped;
      const up = await svc.from("email_action_notices").update({
        status: ok ? "sent" : "failed", attempts: (prior?.attempts || 0) + 1, delivered: result?.notified || 0,
        error: ok ? null : String(result?.error || result?.skipped).slice(0, 200), sent_at: ok ? now.toISOString() : null,
      }).eq("tenant_id", tenantId).eq("id", rowId);
      if (up.error) throw new Error("notice update: " + up.error.message);
      if (!ok) { failed += 1; continue; }
      sent += 1;
      if (n.level > level) {
        level = n.level;
        const e = await svc.from("email_actions").update({ escalation_level: level, updated_at: now.toISOString() })
          .eq("tenant_id", tenantId).eq("id", ea.id).lt("escalation_level", level);
        if (e.error) throw new Error("escalation level: " + e.error.message);
      }
      if (n.kind === "escalation" || n.kind === "overdue") {
        await recordAudit({ tenantId, user: null, role: "system" }, {
          action: n.kind === "escalation" ? "email_action_escalated" : "email_action_overdue_notice",
          objectType: "email_action", objectId: ea.id,
          after: { level: n.level, users: n.users, roles: n.roles, notice_key: n.key },
        });
      }
    }
  }
  return { tenant_id: tenantId, sent, failed, waiting };
};

// Every tenant with the module on and actions in 'create' mode.
export const runSweep = async (svc, { now = new Date(), send = notify } = {}) => {
  const tenants = fail("tenants", await svc.from("tenant_settings") // audit-allow: cross-tenant (cron sweep)
    .select("*").eq("email_accountability_enabled", true));
  const results = [];
  for (const s of tenants) {
    if (s.email_actions_mode !== "create") continue;
    try {
      results.push(await sweepTenant(svc, s, now, send));
    } catch (err) {
      results.push({ tenant_id: s.tenant_id, error: String(err?.message || err).slice(0, 300) });
    }
  }
  return { tenants: results.length, results };
};
