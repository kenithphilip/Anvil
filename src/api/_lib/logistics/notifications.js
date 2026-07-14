// Logistics exception notifications (P1). Mirrors the inventory dispatcher
// (_lib/inventory/notifications.js): fans open high-severity or SLA-breached
// `logistics_exceptions` out to the admin bell (notifyAdmins) + a queued email
// (communications rail), tracking what was sent in detail.notified so re-runs of
// the cron don't dupe. Recipients come from the rule's escalate_roles (the
// "recipients from responsibility" requirement); a breach fires a distinct,
// higher-urgency notification even if first detection already notified.

import { notifyAdmins } from "../notifications.js";

const RANK = { info: 1, warn: 2, bad: 3, critical: 4 };

const KIND_LABEL = {
  po_source_country: "Foreign PO unacknowledged",
  po_local_supplier: "Domestic PO unacknowledged",
  work_order_manufacturing: "Work order not dispatched to mfg",
  ready_date_missing: "Ack'd PO missing ready date / ETA",
  ready_date_orphan: "Supplier ETA on no shipment plan",
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

  const open = await svc.from("logistics_exceptions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(500);

  let bellSent = 0;
  let emailQueued = 0;
  let breachSent = 0;

  for (const e of (open.data || [])) {
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
        await svc.from("communications").insert({
          tenant_id: tenantId,
          direction: "outbound",
          channel: "email",
          template: "logistics_alert",
          subject: label(e),
          body: buildBody(e),
          status: "queued",
          object_type: "logistics_exception",
          object_id: e.id,
        });
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

  return { bellSent, emailQueued, breachSent };
};
