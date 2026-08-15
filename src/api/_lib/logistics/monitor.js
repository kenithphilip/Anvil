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
import {
  lookbackCutoff, lookbackDays, resolvableExceptions, raiseDecision, pickExisting,
  maxRaisePerRun, isTerminal, KIND_SOURCE,
  PO_SCAN_STATUSES, ISO_SCAN_STATUSES, ORDER_SCAN_STATUSES,
} from "./scope.js";

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
  // Outbound (customer-facing) families (P3). Owned by sales, so escalate there.
  { rule_kind: "dispatch_overdue",          label: "Order approved, no shipment booked", active: true, severity: "warn", threshold_days: 3,    sla_hours: 24, escalate_roles: ["sales_manager", "admin"] },
  { rule_kind: "customer_delivery_at_risk", label: "Customer delivery at risk",          active: true, severity: "warn", threshold_days: 3,    sla_hours: 24, escalate_roles: ["sales_manager", "admin"] },
  { rule_kind: "customer_delivery_overdue", label: "Customer delivery overdue",          active: true, severity: "bad",  threshold_days: null, sla_hours: 8,  escalate_roles: ["sales_manager", "admin"] },
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
  put("dispatch_overdue", "dispatch_overdue");
  put("customer_delivery_at_risk", "delivery_risk_window");
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

// Insert only if no row with the same (rule_kind, fingerprint) already governs
// it; when an OPEN one does, ratchet its severity UP if this tick computed a
// higher band and refresh the detail so the text does not go stale.
//
// `existing` is the prior row for this fingerprint, already in hand — the caller
// reads every exception for the tenant ONCE and looks up here, rather than
// issuing a select per flag. At ~2,000 flags that was ~4,000 round-trips inside
// a 20s handler budget, so detection was killed mid-run and the phases after it
// (markBreaches, notifications) never executed at all.
//
// Acknowledged and suppressed rows are respected, not re-raised — see
// raiseDecision in ./scope.js for why that is the difference between a workable
// queue and one that resets every five minutes.
//
// Concurrency: a partial unique index (migration 206) backs the dedup, so a
// racing tick that loses gets 23505 and is treated as skipped.
const upsertException = async (svc, row, existing) => {
  const decision = raiseDecision(existing);
  if (decision.action === "skip") return { skipped: true, reason: decision.reason, id: existing.id };

  if (decision.action === "update") {
    const patch = { updated_at: new Date().toISOString() };
    // Aging escalation: never downgrade; bump only when strictly higher.
    const escalated = (RANK[row.severity] || 0) > (RANK[existing.severity] || 0);
    if (escalated) patch.severity = row.severity;
    // Refresh the age-dependent copy. Without this an exception opened weeks ago
    // still reads "sent 14d ago" while the real figure climbs — the operator is
    // triaging by a number that stopped moving. `notified` is carried over so a
    // refresh never re-sends what was already sent.
    patch.detail = { ...(row.detail || {}), notified: existing.detail?.notified || undefined };
    const upd = await svc.from("logistics_exceptions")
      .update(patch)
      .eq("tenant_id", row.tenant_id)
      .eq("id", existing.id);
    if (upd.error) return { error: upd.error.message };
    return { skipped: true, escalated, id: existing.id };
  }

  const ins = await svc.from("logistics_exceptions").insert(row).select("id").single();
  if (ins.error) {
    // Lost the race with a concurrent tick against the partial unique index.
    if (ins.error.code === "23505") return { skipped: true, id: null };
    return { error: ins.error.message };
  }
  return { id: ins.data.id };
};

const PAGE = 500;

// Run every active rule for one tenant: reuse scan() with the configured SLAs,
// persist each flag as a deduped exception, and close the ones that cleared.
export const detectAllLogistics = async (svc, tenantId, opts = {}) => {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowIso = now.toISOString();
  const cutoff = lookbackCutoff(now);

  const rulesRes = await svc.from("logistics_monitor_rules")
    .select("*").eq("tenant_id", tenantId);
  const ruleMap = mergeRules(rulesRes.data || []);
  const slas = rulesToSlas(ruleMap);

  // NEWEST-FIRST inside a lookback window.
  //
  // These were `ascending: true` — the OLDEST 500 rows, which is the one cohort
  // guaranteed to be past 2x SLA and therefore guaranteed `critical`. The
  // ordering was not a detail; it decided the severity of the entire burst. It
  // also meant a genuinely urgent PO raised yesterday could never be reached
  // while 500 older ones held the window.
  //
  // Terminal statuses are gone from the populations too — see ./scope.js.
  const [poRes, isoRes, ordRes] = await Promise.all([
    svc.from("source_pos")
      .select("id, order_id, reference, supplier, country, status, acknowledged_eta, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .in("status", PO_SCAN_STATUSES)
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(PAGE),
    // Windowed on approved_at, which is the clock scan.js rule 3 actually
    // measures from. Filtering on created_at instead excluded an ISO created
    // 200d ago and approved four days ago — live, about to breach — while
    // admitting one created and approved 80d ago as critical.
    // `or` because approved_at is null until approval; created_at carries those.
    svc.from("internal_sales_orders")
      .select("id, iso_number, status, customer_id, vendor_name, approved_at, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ISO_SCAN_STATUSES)
      .or(`approved_at.gte.${cutoff},and(approved_at.is.null,created_at.gte.${cutoff})`)
      .order("approved_at", { ascending: false, nullsFirst: false })
      .limit(PAGE),
    svc.from("orders")
      .select("id, po_number, customer_id, status, committed_delivery_date, created_at, updated_at")
      .eq("tenant_id", tenantId)
      .in("status", ORDER_SCAN_STATUSES)
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: false })
      .limit(PAGE),
  ]);
  if (poRes.error) throw new Error("source_pos: " + poRes.error.message);
  if (isoRes.error) throw new Error("internal_sales_orders: " + isoRes.error.message);
  if (ordRes.error) throw new Error("orders: " + ordRes.error.message);

  const sourcePos = poRes.data || [];
  const internalSos = isoRes.data || [];
  const orders = ordRes.data || [];

  // Shipments SCOPED to the records in play, not an arbitrary sample.
  //
  // This was `.limit(1000)` with no ORDER BY — an unstable slice of the table.
  // scan.js builds shippedOrderIds / deliveredOrderIds / sourceWithShipment from
  // it, so for any tenant with more than 1,000 shipments an order whose shipment
  // fell outside the slice was reported as "no shipment booked" when one existed.
  // Those were not late orders; they were wrong alerts, and which ones were wrong
  // changed between runs.
  const poIds = sourcePos.map((p) => p.id).filter(Boolean);
  const orderIds = orders.map((o) => o.id).filter(Boolean);
  // Deduped by id: a shipment carrying both a scanned source_po_id and a scanned
  // order_id matches both passes. scan() builds Sets from these so a duplicate
  // is harmless to the result, but there is no reason to carry it twice.
  const shipmentById = new Map();
  const collectShipments = async (column, ids) => {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await svc.from("shipments")
        .select("id, source_po_id, order_id, ready_date, customer_delivery_date, status")
        .eq("tenant_id", tenantId)
        .in(column, ids.slice(i, i + 200));
      if (error) throw new Error("shipments: " + error.message);
      for (const sh of (data || [])) shipmentById.set(sh.id, sh);
    }
  };
  if (poIds.length) await collectShipments("source_po_id", poIds);
  if (orderIds.length) await collectShipments("order_id", orderIds);
  const shipments = [...shipmentById.values()];

  const { delays } = scan({ sourcePos, internalSos, shipments, orders, slas });

  // Every exception for this tenant, read ONCE. Replaces a select per flag.
  const existingRows = [];
  for (let page = 0; ; page += 1) {
    const { data, error } = await svc.from("logistics_exceptions")
      .select("id, rule_kind, severity, status, object_id, detail, created_at")
      .eq("tenant_id", tenantId)
      .in("status", ["open", "acknowledged", "suppressed"])
      .order("created_at", { ascending: true })
      .range(page * 1000, page * 1000 + 999);
    if (error) throw new Error("logistics_exceptions: " + error.message);
    existingRows.push(...(data || []));
    if ((data || []).length < 1000 || page >= 9) break;
  }
  const byFingerprint = new Map();
  for (const r of existingRows) {
    const fp = r.detail?.fingerprint || `${r.rule_kind}:${r.object_id}`;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, []);
    byFingerprint.get(fp).push(r);
  }

  let created = 0;
  let skipped = 0;
  let deferred = 0;
  let writeErrors = 0;
  const raiseCap = maxRaisePerRun();
  const flagged = new Set();
  // scan() returns its flags sorted by severity then elapsed, so when the cap
  // bites it keeps the worst and defers the tail.
  for (const flag of delays) {
    const row = flagToException(flag, ruleMap[flag.kind], tenantId, nowIso);
    if (!row) { skipped += 1; continue; }
    const fp = row.detail.fingerprint;
    // Recorded as flagged BEFORE the cap: this fingerprint is still detected, so
    // it must not look "cleared" to the auto-resolve pass below just because
    // this run ran out of room to raise it.
    flagged.add(fp);
    const existing = pickExisting(byFingerprint.get(fp));
    // THE BOUND ON THE BURST. Only NEW raises are capped — an existing exception
    // still gets its severity ratcheted and its text refreshed, which is cheap
    // and is what keeps the queue honest while the backlog drains.
    if (!existing && created >= raiseCap) { deferred += 1; continue; }
    const r = await upsertException(svc, row, existing);
    // Was `if (r.error) continue` with no counter, so a persistently failing
    // write was invisible in the run summary.
    if (r.error) { writeErrors += 1; continue; }
    if (r.skipped) skipped += 1; else created += 1;
  }

  // Close what cleared. Only for objects this run actually examined, and only
  // from populations that were not truncated — see resolvableExceptions.
  const examined = {
    source_po: new Set(poIds),
    internal_so: new Set(internalSos.map((i) => i.id).filter(Boolean)),
    order: new Set(orderIds),
  };
  const truncated = new Set();
  if (sourcePos.length >= PAGE) truncated.add("source_po");
  if (internalSos.length >= PAGE) truncated.add("internal_so");
  if (orders.length >= PAGE) truncated.add("order");

  const stillOpen = existingRows.filter((r) => r.status === "open");
  const toResolve = resolvableExceptions(stillOpen, { examined, flagged });

  // Objects that left the scan population entirely.
  //
  // The dominant way a procurement exception clears is the PO reaching RECEIVED
  // — which is exactly the transition that drops it out of PO_SCAN_STATUSES, so
  // it is never examined again and `resolvableExceptions` can never close it.
  // Without this pass the open queue only ever grows, and the very records an
  // operator has finished are the ones that keep breaching SLA at them.
  //
  // Bounded: one lookup per object type, over the ids of open exceptions this
  // run did not examine, chunked.
  const unexamined = { source_po: [], internal_so: [], order: [] };
  for (const e of stillOpen) {
    const source = KIND_SOURCE[e.rule_kind];
    if (!source || !unexamined[source]) continue;
    if (examined[source]?.has(e.object_id)) continue;
    if (e.object_id) unexamined[source].push(e);
  }
  const TABLE = { source_po: "source_pos", internal_so: "internal_sales_orders", order: "orders" };
  for (const [type, rows] of Object.entries(unexamined)) {
    if (!rows.length) continue;
    const ids = [...new Set(rows.map((e) => e.object_id))];
    const statusById = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await svc.from(TABLE[type])
        .select("id, status")
        .eq("tenant_id", tenantId)
        .in("id", ids.slice(i, i + 200));
      if (error) { console.warn(`[logistics-monitor] ${type} status lookup failed:`, error.message); break; }
      for (const r of (data || [])) statusById.set(r.id, r.status);
    }
    for (const e of rows) {
      // Only close on a status we actually READ. A missing row means the lookup
      // was cut short or the object was deleted; neither is evidence of "done".
      if (!statusById.has(e.object_id)) continue;
      if (isTerminal(type, statusById.get(e.object_id))) toResolve.push(e);
    }
  }

  let resolved = 0;
  const resolveIds = [...new Set(toResolve.map((e) => e.id))];
  for (let i = 0; i < resolveIds.length; i += 100) {
    const batch = resolveIds.slice(i, i + 100);
    const { error } = await svc.from("logistics_exceptions")
      .update({ status: "resolved", resolved_at: nowIso, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      // Guarded on status: `existingRows` was read at the top of this run, so an
      // operator who acknowledged or suppressed a row in the meantime would
      // otherwise have it overwritten to `resolved` — and since a resolved row
      // is treated as a recurrence, the next tick would re-raise the very thing
      // they had just suppressed.
      .eq("status", "open")
      .in("id", batch);
    if (error) { console.warn("[logistics-monitor] auto-resolve failed:", error.message); break; }
    resolved += batch.length;
  }

  return {
    tenant_id: tenantId,
    detected: delays.length,
    created, skipped, resolved, deferred, write_errors: writeErrors,
    raise_cap: raiseCap,
    scanned: { source_po: sourcePos.length, internal_so: internalSos.length, order: orders.length },
    truncated: [...truncated],
    lookback_days: lookbackDays(),
  };
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
    // Longest-breached first. Without an ORDER BY this took an arbitrary 500 of
    // the eligible rows each tick, so with a backlog the same rows could be
    // re-picked while others waited indefinitely.
    .order("sla_target_at", { ascending: true })
    .limit(500);
  if (open.error) throw new Error("logistics_exceptions: " + open.error.message);
  const rows = open.data || [];
  const breachedRows = [];
  // One update per batch rather than per row: a 500-row breach wave was 500
  // sequential round-trips inside a shared handler budget.
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const upd = await svc.from("logistics_exceptions")
      .update({ breached_at: nowIso, updated_at: nowIso })
      .eq("tenant_id", tenantId)
      .in("id", batch.map((e) => e.id));
    if (upd.error) {
      // Was dropped silently: a row only joined the result when !upd.error, with
      // no log and no accounting, so a persistently failing update was invisible.
      console.warn("[logistics-monitor] breach update failed:", upd.error.message);
      continue;
    }
    for (const e of batch) breachedRows.push({ ...e, breached_at: nowIso });
  }
  return { breached: breachedRows.length, rows: breachedRows };
};

export const __test = { upsertException };
