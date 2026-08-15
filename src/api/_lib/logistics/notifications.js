// Logistics exception notifications (P1). Mirrors the inventory dispatcher
// (_lib/inventory/notifications.js): fans open high-severity or SLA-breached
// `logistics_exceptions` out to the admin bell (notifyAdmins) + a queued email
// (communications rail), tracking what was sent in detail.notified so re-runs of
// the cron don't dupe. Recipients come from the rule's escalate_roles (the
// "recipients from responsibility" requirement); a breach fires a distinct,
// higher-urgency notification even if first detection already notified.

import { notifyAdmins } from "../notifications.js";
import { commsRow } from "../comms-row.js";

const RANK = { info: 1, warn: 2, bad: 3, critical: 4 };
// Only these can ever notify (the loop's own isHigh gate is `>= bad`), so the
// query filters on them server-side rather than fetching info/warn rows that
// will be discarded — those were a large part of what crowded the old window.
const HIGH_SEVERITIES = ["bad", "critical"];
const isHighSev = (e) => (RANK[e?.severity] || 0) >= RANK.bad;

/** Notification sends per run. The remainder is picked up on the next tick. */
const MAX_NOTIFY_PER_RUN = Number(process.env.LOGISTICS_MAX_NOTIFY_PER_RUN || 25);
/** Above this many first-time bells in one run, send a single digest instead. */
const DIGEST_THRESHOLD = Number(process.env.LOGISTICS_DIGEST_THRESHOLD || 10);

// One bell summarising a backlog, in place of one bell per exception.
//
// Returns true ONLY if the bell actually reached someone. notifyAdmins does not
// throw — it catches internally and returns { notified: 0 } when, for example,
// the rule's escalate_roles name a role with no approved tenant_members row.
// Deciding success by "it didn't throw" meant a digest that reached nobody still
// stamped bell_at on every exception it covered, which removed them from the
// query forever: the alerts were not delayed, they were destroyed.
const sendDigest = async (svc, tenantId, rows, rolesFor) => {
  const byKind = {};
  for (const e of rows) byKind[e.rule_kind] = (byKind[e.rule_kind] || 0) + 1;
  const parts = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} × ${KIND_LABEL[k] || k}`);
  const roles = [...new Set(rows.flatMap((e) => rolesFor(e)))];
  try {
    const res = await notifyAdmins(svc, tenantId, {
      kind: "logistics_exception_digest",
      title: `${rows.length} logistics exceptions need attention`,
      body: parts.join(" · ").slice(0, 500),
      object_type: "logistics_exception",
      object_id: null,
      link_route: "delays",
    }, { roles, dedupKey: "logistics_digest:" + new Date().toISOString().slice(0, 10) });
    return Number(res?.notified) > 0;
  } catch (_) {
    return false;
  }
};

const KIND_LABEL = {
  po_source_country: "Foreign PO unacknowledged",
  po_local_supplier: "Domestic PO unacknowledged",
  work_order_manufacturing: "Work order not dispatched to mfg",
  ready_date_missing: "Ack'd PO missing ready date / ETA",
  ready_date_orphan: "Supplier ETA on no shipment plan",
  // The P3 outbound families were missing, so a customer-delivery alert reached
  // the operator titled "customer_delivery_overdue" — the raw rule key.
  dispatch_overdue: "Order approved, no shipment booked",
  customer_delivery_at_risk: "Customer delivery at risk",
  customer_delivery_overdue: "Customer delivery overdue",
};

const label = (e) => KIND_LABEL[e.rule_kind] || e.rule_kind;
const buildBody = (e) => {
  const ref = e.ref_label ? " · " + e.ref_label : "";
  const dt = e.detail?.detail_text ? " — " + e.detail.detail_text : "";
  return (label(e) + ref + dt).slice(0, 500);
};

export const dispatchLogisticsNotifications = async (svc, tenantId) => {
  // Rule → escalate_roles map (defaults to procurement + admin when unset).
  const rulesRes = await svc.from("logistics_monitor_rules")
    .select("rule_kind, escalate_roles").eq("tenant_id", tenantId);
  const rolesByKind = {};
  for (const r of (rulesRes.data || [])) {
    if (Array.isArray(r.escalate_roles) && r.escalate_roles.length) rolesByKind[r.rule_kind] = r.escalate_roles;
  }
  const rolesFor = (e) => rolesByKind[e.rule_kind] || ["procurement", "admin"];

  // Two TARGETED queries instead of "newest 500 open, then filter in JS".
  //
  // The old query took the newest 500 open exceptions regardless of whether they
  // needed anything. Once a tenant held more than 500 open — and a first run on
  // real history opened thousands — the newest 500 occupied the window on every
  // tick forever and the older ones were NEVER notified, including their SLA
  // breaches. The rows most likely to matter were the ones permanently skipped.
  //
  // Asking for exactly the rows with work outstanding cannot starve: a row
  // leaves the result set precisely when it has been dealt with.
  const [firstRes, breachRes] = await Promise.all([
    svc.from("logistics_exceptions")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .in("severity", HIGH_SEVERITIES)
      .or("detail->notified->>bell_at.is.null,detail->notified->>email_at.is.null")
      .order("created_at", { ascending: true })
      .limit(MAX_NOTIFY_PER_RUN * 4),
    svc.from("logistics_exceptions")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("status", "open")
      .not("breached_at", "is", null)
      .filter("detail->notified->>breach_bell_at", "is", null)
      .order("breached_at", { ascending: true })
      .limit(MAX_NOTIFY_PER_RUN * 4),
  ]);
  if (firstRes.error) throw new Error("logistics_exceptions: " + firstRes.error.message);
  if (breachRes.error) throw new Error("logistics_exceptions: " + breachRes.error.message);

  const pending = [];
  const seen = new Set();
  for (const e of [...(firstRes.data || []), ...(breachRes.data || [])]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    pending.push(e);
  }

  let bellSent = 0;
  let emailQueued = 0;
  let breachSent = 0;
  let digested = 0;

  // Enabling the monitor on a tenant with history opens a large backlog at once,
  // and every one of those would otherwise ring its own bell. One bell per
  // exception is right for a steady trickle and useless for a backlog: the
  // operator gets a screenful of notifications, learns nothing they could not
  // read on the delays screen, and stops trusting the bell.
  //
  // Past the threshold, send ONE digest and mark the batch as belled. The
  // exceptions themselves are unaffected — they are all on the delays screen,
  // with their severities and SLA clocks intact.
  const needFirstBell = pending.filter((e) => isHighSev(e) && !e.detail?.notified?.bell_at);
  if (needFirstBell.length > DIGEST_THRESHOLD) {
    const digestOk = await sendDigest(svc, tenantId, needFirstBell, rolesFor);
    if (digestOk) {
      const stampedAt = new Date().toISOString();
      for (let i = 0; i < needFirstBell.length; i += 100) {
        const batch = needFirstBell.slice(i, i + 100);
        await Promise.all(batch.map((e) => svc.from("logistics_exceptions")
          .update({
            detail: { ...(e.detail || {}), notified: { ...(e.detail?.notified || {}), bell_at: stampedAt, via: "digest" } },
            updated_at: stampedAt,
          })
          .eq("tenant_id", tenantId)
          .eq("id", e.id)
          .then((r) => {
            if (r.error) return;
            e.detail = { ...(e.detail || {}), notified: { ...(e.detail?.notified || {}), bell_at: stampedAt, via: "digest" } };
            digested += 1;   // count what PERSISTED, not what was attempted
          })
          .catch(() => {})));
      }
    }
  }

  let acted = 0;
  for (const e of pending) {
    // Bound the work per run so one tick cannot spend its whole budget here and
    // leave markBreaches' output unnotified. The rest are picked up next tick —
    // they stay in the query because they still have work outstanding.
    if (acted >= MAX_NOTIFY_PER_RUN) break;
    const already = { ...(e.detail?.notified || {}) };
    const isHigh = (RANK[e.severity] || 0) >= RANK.bad;
    const isBreach = !!e.breached_at;
    let touched = false;

    // 1. Bell on first detection of a high-severity exception.
    if (!already.bell_at && isHigh) {
      try {
        await notifyAdmins(svc, tenantId, {
          kind: "logistics_exception",
          title: label(e),
          body: buildBody(e),
          object_type: "logistics_exception",
          object_id: e.id,
          link_route: "delays",
        }, { roles: rolesFor(e), dedupKey: "exc:" + e.id });
        already.bell_at = new Date().toISOString();
        bellSent += 1;
        touched = true;
      } catch (_) { /* best-effort */ }
    }

    // 2. Email on first detection of a high-severity exception.
    if (!already.email_at && isHigh) {
      try {
        await svc.from("communications").insert(commsRow({
          tenant_id: tenantId,
          direction: "outbound",
          channel: "email",
          template: "logistics_alert",
          subject: label(e),
          body: buildBody(e),
          status: "queued",
          object_type: "logistics_exception",
          object_id: e.id,
        }));
        already.email_at = new Date().toISOString();
        emailQueued += 1;
        touched = true;
      } catch (_) { /* best-effort */ }
    }

    // 3. SLA breach: a distinct, higher-urgency escalation, fired once even if
    //    first detection already notified.
    if (isBreach && !already.breach_bell_at) {
      try {
        await notifyAdmins(svc, tenantId, {
          kind: "logistics_sla_breach",
          title: "SLA breach · " + label(e),
          body: buildBody(e),
          object_type: "logistics_exception",
          object_id: e.id,
          link_route: "delays",
        }, { roles: rolesFor(e), dedupKey: "breach:" + e.id });
        already.breach_bell_at = new Date().toISOString();
        breachSent += 1;
        touched = true;
      } catch (_) { /* best-effort */ }
    }

    if (touched) acted += 1;

    if (touched) {
      // Best-effort like the notify calls above: a persist failure must not
      // abort the remaining exceptions for this tenant. (Not persisting the
      // notified flags risks a duplicate alert next tick, which is preferable
      // to dropping every later exception in the loop.)
      try {
        const { error: persistErr } = await svc.from("logistics_exceptions")
          .update({ detail: { ...(e.detail || {}), notified: already }, updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId)
          .eq("id", e.id);
        if (persistErr) console.warn("[logistics-notify] persist failed for", e.id, persistErr.message);
      } catch (err) {
        console.warn("[logistics-notify] persist threw for", e.id, err?.message || err);
      }
    }
  }

  return { bellSent, emailQueued, breachSent, digested, pending: pending.length };
};
