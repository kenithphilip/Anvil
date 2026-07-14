// Logistics monitor — the configuration-driven detector + SLA spine (P1).
//
// This does NOT re-implement the delay rules: it reuses the exact, unit-tested
// rule logic in src/api/delays/scan.js (which already accepts an `slas`
// override), feeds it the tenant's configured thresholds, and then PERSISTS the
// resulting flags as idempotent, fingerprint-deduped `logistics_exceptions`
// rows — each carrying its own SLA clock. A per-tenant cron
// (/api/cron/logistics-monitor-tick) drives detect -> markBreaches -> notify.
//
// Config lives in `logistics_monitor_rules`; when a tenant has no row for a
// kind, DEFAULT_MONITOR_RULES (below) supplies the playbook default, so the
// monitor works out of the box. An explicit row with active=false disables a
// kind. Pure helpers (mergeRules/rulesToSlas/severityFor/flagToException) are
// exported for unit tests; the I/O functions take the service client.
//
// New rule kinds (grn_overdue, dispatch_overdue, delivery_at_risk, qc_overdue,
// customs_delay) land in later phases as their data becomes available; the
// schema + this detector accept them without change.

import { scan } from "../../delays/scan.js";

const HOURS_MS = 60 * 60 * 1000;

// Playbook defaults, mirroring delays/scan.js DEFAULT_SLAS. threshold_days feeds
// the scan() SLA override; sla_hours sets the exception's SLA clock; severity is
// the configured floor; escalate_roles receive the bell + email.
export const DEFAULT_MONITOR_RULES = [
  { rule_kind: "po_source_country",       label: "Foreign PO unacknowledged",        active: true, severity: "warn", threshold_days: 14,   sla_hours: 48, escalate_roles: ["procurement", "admin"] },
  { rule_kind: "po_local_supplier",       label: "Domestic PO unacknowledged",       active: true, severity: "warn", threshold_days: 7,    sla_hours: 24, escalate_roles: ["procurement", "admin"] },
  { rule_kind: "work_order_manufacturing", label: "Work order not dispatched to mfg", active: true, severity: "warn", threshold_days: 5,    sla_hours: 24, escalate_roles: ["procurement", "admin"] },
  { rule_kind: "ready_date_missing",      label: "Ack'd PO without ready date / ETA", active: true, severity: "info", threshold_days: 7,    sla_hours: 48, escalate_roles: ["procurement", "admin"] },
  { rule_kind: "ready_date_orphan",       label: "Supplier ETA on no shipment plan",  active: true, severity: "info", threshold_days: null, sla_hours: 72, escalate_roles: ["procurement", "admin"] },
];

const SEVERITIES = ["info", "warn", "bad", "critical"];
const RANK = { info: 1, warn: 2, bad: 3, critical: 4 };
// scan() severity (elapsed-based) mapped onto the 4-level scale.
const SCAN_SEV_BASE = { high: "bad", medium: "warn", low: "info" };
const bumpOne = (sev) => SEVERITIES[Math.min(3, RANK[sev] || 1)];

// Overlay the tenant's rule rows onto the defaults, keyed by rule_kind. A row
// with active=false disables that kind; a row for a novel kind is included too.
export const mergeRules = (rows) => {
  const map = {};
  for (const d of DEFAULT_MONITOR_RULES) map[d.rule_kind] = { ...d };
  for (const r of (rows || [])) {
    if (!r || !r.rule_kind) continue;
    map[r.rule_kind] = { ...(map[r.rule_kind] || {}), ...r };
  }
  return map;
};

// Build the `slas` override scan() expects from the resolved rule map. scan()
// keys the ready-date wait as `ready_date_wait`.
export const rulesToSlas = (ruleMap) => {
  const slas = {};
  const put = (kind, slaKey) => {
    const t = ruleMap?.[kind]?.threshold_days;
    if (t != null && t !== "") slas[slaKey] = Number(t);
  };
  put("po_source_country", "po_source_country");
  put("po_local_supplier", "po_local_supplier");
  put("work_order_manufacturing", "work_order_manufacturing");
  put("ready_date_missing", "ready_date_wait");
  return slas;
};

// Exception severity = worse of (configured floor, mapped scan severity), then
// escalated one notch when the item is past 2x SLA (scan 'high'). This is what
// makes an exception get more severe as it ages.
export const severityFor = (flag, rule) => {
  let sev = SCAN_SEV_BASE[flag?.severity] || "warn";
  const floor = rule?.severity;
  if ((RANK[floor] || 0) > (RANK[sev] || 0)) sev = floor;
  if (flag?.severity === "high") sev = bumpOne(sev);
  return sev;
};

// Map a scan() flag + its rule into a logistics_exceptions row, or null when the
// rule is disabled. Pure: `nowIso` is injected so tests are deterministic.
export const flagToException = (flag, rule, tenantId, nowIso) => {
  if (!rule || rule.active === false) return null;
  const slaHours = rule.sla_hours != null && rule.sla_hours !== "" ? Number(rule.sla_hours) : null;
  const sla_target_at = slaHours != null
    ? new Date(new Date(nowIso).getTime() + slaHours * HOURS_MS).toISOString()
    : null;
  return {
    tenant_id: tenantId,
    rule_kind: flag.kind,
    severity: severityFor(flag, rule),
    object_type: flag.ref_type,
    object_id: flag.ref_id,
    ref_label: flag.ref_label,
    status: "open",
    sla_target_at,
    detail: {
      // One open exception per (kind, object) until it is resolved — no date in
      // the fingerprint, so a persisting delay is not re-raised every tick.
      fingerprint: flag.kind + ":" + flag.ref_id,
      elapsed_days: flag.elapsed_days,
      sla_days: flag.sla_days,
      detail_text: flag.detail,
      supplier: flag.supplier || null,
      order_id: flag.order_id || null,
    },
  };
};

// Insert only if no open row with the same (rule_kind, fingerprint) exists;
// when one does, ratchet its severity UP if this tick computed a higher band
// (so an exception that ages past 2x SLA actually escalates — the persisted
// severity is what the notifier reads). Concurrency: a partial unique index
// (migration 162) backs the dedup, so a racing tick that loses gets 23505 and
// is treated as skipped rather than inserting a duplicate.
const upsertException = async (svc, row) => {
  const fingerprint = row.detail?.fingerprint;
  if (fingerprint) {
    const existing = await svc.from("logistics_exceptions")
      .select("id, severity")
      .eq("tenant_id", row.tenant_id)
      .eq("rule_kind", row.rule_kind)
      .eq("status", "open")
      .filter("detail->>fingerprint", "eq", fingerprint)
      .order("created_at", { ascending: true })
      .limit(1);
    if (existing.error) return { error: existing.error.message };
    const cur = existing.data && existing.data[0];
    if (cur) {
      // Aging escalation: never downgrade; bump only when strictly higher.
      if ((RANK[row.severity] || 0) > (RANK[cur.severity] || 0)) {
        const upd = await svc.from("logistics_exceptions")
          .update({ severity: row.severity, updated_at: new Date().toISOString() })
          .eq("tenant_id", row.tenant_id)
          .eq("id", cur.id);
        if (upd.error) return { error: upd.error.message };
        return { skipped: true, escalated: true, id: cur.id };
      }
      return { skipped: true, id: cur.id };
    }
  }
  const ins = await svc.from("logistics_exceptions").insert(row).select("id").single();
  if (ins.error) {
    // Lost the race with a concurrent tick against the partial unique index.
    if (ins.error.code === "23505") return { skipped: true, id: null };
    return { error: ins.error.message };
  }
  return { id: ins.data.id };
};

// Run every active rule for one tenant: reuse scan() with the configured SLAs,
// persist each flag as a deduped exception.
export const detectAllLogistics = async (svc, tenantId) => {
  const rulesRes = await svc.from("logistics_monitor_rules")
    .select("*").eq("tenant_id", tenantId);
  const ruleMap = mergeRules(rulesRes.data || []);
  const slas = rulesToSlas(ruleMap);

  const [poRes, isoRes, shRes] = await Promise.all([
    svc.from("source_pos")
      .select("id, order_id, reference, supplier, country, status, acknowledged_eta, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .in("status", ["SENT_TO_SUPPLIER", "SUPPLIER_ACK", "PRICE_CHANGED", "ETA_CONFIRMED", "DELAYED", "RECEIVED"])
      .order("updated_at", { ascending: true })
      .limit(500),
    svc.from("internal_sales_orders")
      .select("id, iso_number, status, customer_id, vendor_name, approved_at, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["APPROVED", "DISPATCHED"])
      .order("approved_at", { ascending: true })
      .limit(500),
    svc.from("shipments")
      .select("id, source_po_id, ready_date, status")
      .eq("tenant_id", tenantId)
      .limit(1000),
  ]);
  if (poRes.error) throw new Error("source_pos: " + poRes.error.message);
  if (isoRes.error) throw new Error("internal_sales_orders: " + isoRes.error.message);
  if (shRes.error) throw new Error("shipments: " + shRes.error.message);

  const { delays } = scan({
    sourcePos: poRes.data || [],
    internalSos: isoRes.data || [],
    shipments: shRes.data || [],
    slas,
  });

  const nowIso = new Date().toISOString();
  let created = 0;
  let skipped = 0;
  for (const flag of delays) {
    const row = flagToException(flag, ruleMap[flag.kind], tenantId, nowIso);
    if (!row) { skipped += 1; continue; }
    const r = await upsertException(svc, row);
    if (r.error) continue;
    if (r.skipped) skipped += 1; else created += 1;
  }
  return { tenant_id: tenantId, detected: delays.length, created, skipped };
};

// Flip open exceptions whose SLA target has passed to breached (once). Returns
// the newly-breached rows so the caller can escalate them.
export const markBreaches = async (svc, tenantId) => {
  const nowIso = new Date().toISOString();
  const open = await svc.from("logistics_exceptions")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .is("breached_at", null)
    .not("sla_target_at", "is", null)
    .lte("sla_target_at", nowIso)
    .limit(500);
  const rows = open.data || [];
  const breachedRows = [];
  for (const e of rows) {
    const upd = await svc.from("logistics_exceptions")
      .update({ breached_at: nowIso, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      .eq("id", e.id);
    if (!upd.error) breachedRows.push({ ...e, breached_at: nowIso });
  }
  return { breached: breachedRows.length, rows: breachedRows };
};

export const __test = { upsertException };
