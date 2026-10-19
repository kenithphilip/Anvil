// SO cycle and rework baseline (plan C-7, audit PR 1).
//
// The numbers the SO plan is judged against: how long an order takes to
// become an SO, how long the engineer takes to send it, how long it waits on
// the approver, how often it comes back, and how many actions a person takes
// on it. They are measured BEFORE any UX change, so the later PRs have a
// baseline to beat.
//
// Every number is rebuilt from audit_events, which is append-only (migration
// 058). orders.approved_at is NOT read: each approval overwrites it, so an
// order approved, returned and approved again would report its last approval
// as its first. Each PATCH to an order writes one audit row carrying the full
// row before and after (orders/[id].js), so the two statuses on that row are a
// status transition. processing_events carries the same transitions with
// neither the old status nor the actor, so it is not read: reading both would
// count each transition twice.
//
// Pure: no I/O. The catalog fetches the rows and calls these.

import { median, percentile } from "./ops-kpis.js";

const HOUR = 3600000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const RETURN_ACTION = "manager_requested_correction";

// The audit rows that carry the full order before and after, so a status
// transition can be read from them.
export const TRANSITION_ACTIONS = new Set(["create_order", "update_order", "approve_order", RETURN_ACTION]);

// The audit actions a person takes on an order on its way to an SO. A read,
// a download, a share or an export is not here. Neither is a row that one
// request writes beside its main row (order_identity_changed,
// item_customer_part_confirmed, approval_thresholds_evaluated,
// order_reconcile_quotes), so one request counts once. The ERP push and the
// handoff are the next stage and are measured there.
export const ORDER_ACTIONS = Object.freeze([
  "create_order", "update_order", "approve_order", RETURN_ACTION,
  "order_finding_resolved", "order_quote_attached", "order_quote_detached",
  "order_term_decided", "schedule_lines_insert", "schedule_lines_clear",
]);
const ORDER_ACTION_SET = new Set(ORDER_ACTIONS);

const byTimeThenId = (a, b) => {
  const d = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (d) return d;
  return Number(a.id || 0) - Number(b.id || 0);
};

// One timeline per order created in the window. `orders` is [{ id, created_at }]
// and `events` the order audit rows, each with from_status and to_status read
// from before_payload and after_payload. A row for an order outside the
// cohort is dropped, so another order's history can never attach.
export const buildTimelines = (orders, events) => {
  const byId = new Map();
  for (const o of orders || []) {
    const createdMs = Date.parse(o?.created_at);
    if (!o?.id || !Number.isFinite(createdMs)) continue;
    byId.set(String(o.id), { id: String(o.id), createdMs, transitions: [], returns: 0, actions: [] });
  }
  for (const e of [...(events || [])].sort(byTimeThenId)) {
    const t = byId.get(String(e?.object_id || ""));
    const at = Date.parse(e?.created_at);
    if (!t || !Number.isFinite(at)) continue;
    if (e.action === RETURN_ACTION) t.returns += 1;
    // A person's action. A row with no actor was written by the system.
    if (e.actor && ORDER_ACTION_SET.has(e.action)) t.actions.push({ action: e.action, role: e.actor_role || "unknown", at });
    if (TRANSITION_ACTIONS.has(e.action) && e.to_status && e.to_status !== e.from_status) {
      t.transitions.push({ at, from: e.from_status || null, to: e.to_status, action: e.action });
    }
  }
  for (const t of byId.values()) {
    const first = (status) => t.transitions.findIndex((x) => x.to === status);
    const submitIdx = first("PENDING_REVIEW");
    const approveIdx = first("APPROVED");
    const cancelIdx = first("CANCELLED");
    t.submittedMs = submitIdx >= 0 ? t.transitions[submitIdx].at : null;
    t.approvedMs = approveIdx >= 0 ? t.transitions[approveIdx].at : null;
    t.cancelledMs = cancelIdx >= 0 ? t.transitions[cancelIdx].at : null;
    // The LAST move to APPROVED ends the order's way to an SO, with any
    // re-work after a return. What happens after it is the next stage.
    let lastApproveIdx = -1;
    t.transitions.forEach((x, i) => { if (x.to === "APPROVED") lastApproveIdx = i; });
    t.lastApprovedMs = lastApproveIdx >= 0 ? t.transitions[lastApproveIdx].at : null;
    // The first decision: the first time the order leaves review after it
    // first entered it, whatever the exit.
    const exit = submitIdx >= 0 ? t.transitions[submitIdx + 1] : null;
    t.decision = exit
      ? { at: exit.at, outcome: exit.action === RETURN_ACTION ? "returned" : String(exit.to).toLowerCase() }
      : null;
  }
  return [...byId.values()];
};

const hoursBetween = (fromMs, toMs) => round2((toMs - fromMs) / HOUR);

// P50 and P90 of a list of durations in hours. Negative durations (a clock
// skew between two writers) are dropped, as ops-kpis does.
export const spread = (hours) => {
  const clean = (hours || []).filter((n) => Number.isFinite(n) && n >= 0);
  return { p50: median(clean), p90: percentile(clean, 90), n: clean.length };
};

// Order created to its FIRST approval. An order cancelled before it was ever
// approved never became an SO and is left out; one still open is pending.
export const timeToSo = (timelines) => {
  const hours = [], ids = [];
  let pending = 0, cancelled = 0;
  for (const t of timelines || []) {
    if (t.approvedMs != null) { hours.push(hoursBetween(t.createdMs, t.approvedMs)); ids.push(t.id); }
    else if (t.cancelledMs != null) cancelled += 1;
    else pending += 1;
  }
  return { ...spread(hours), ids, pending, cancelled };
};

// Order created to its FIRST submission for review.
export const timeToSubmit = (timelines) => {
  const hours = [], ids = [];
  let pending = 0, cancelled = 0;
  for (const t of timelines || []) {
    if (t.submittedMs != null) { hours.push(hoursBetween(t.createdMs, t.submittedMs)); ids.push(t.id); }
    else if (t.cancelledMs != null) cancelled += 1;
    else pending += 1;
  }
  return { ...spread(hours), ids, pending, cancelled };
};

// The exits from review that are an approver's decision. A recall to DRAFT
// with no reason, or a move to BLOCKED, is not.
export const DECISION_OUTCOMES = Object.freeze(["approved", "returned", "cancelled"]);
const DECISION_SET = new Set(DECISION_OUTCOMES);

// First submission to the first decision, split by what the decision was.
// Every first exit from review is in by_outcome. Only the approver's
// decisions are in the P50 and P90; the other exits are `excluded`.
export const approvalWait = (timelines) => {
  const hours = [], ids = [];
  const byOutcome = {};
  let waiting = 0, excluded = 0;
  for (const t of timelines || []) {
    if (t.submittedMs == null) continue;
    if (!t.decision) { waiting += 1; continue; }
    byOutcome[t.decision.outcome] = (byOutcome[t.decision.outcome] || 0) + 1;
    if (!DECISION_SET.has(t.decision.outcome)) { excluded += 1; continue; }
    hours.push(hoursBetween(t.submittedMs, t.decision.at));
    ids.push(t.id);
  }
  return { ...spread(hours), ids, by_outcome: byOutcome, waiting, excluded };
};

// Returns over the orders that were sent for review. An order with a return
// counts as sent even when its submission row is missing.
export const rework = (timelines) => {
  const submitted = (timelines || []).filter((t) => t.submittedMs != null || t.returns > 0);
  const reworked = submitted.filter((t) => t.returns > 0);
  const returns = submitted.reduce((s, t) => s + t.returns, 0);
  return {
    submitted: submitted.length,
    reworked: reworked.length,
    returns,
    max_returns: submitted.reduce((m, t) => Math.max(m, t.returns), 0),
    rate: submitted.length ? Math.round((reworked.length / submitted.length) * 1000) / 10 : null,
    returns_per_order: submitted.length ? round2(returns / submitted.length) : null,
    ids: reworked.map((t) => t.id),
  };
};

// A person's actions per order, over the orders that reached an SO (a full
// cycle), with the share each role took. Only the actions up to the order's
// last approval count. An edit, a schedule or a cancel after it belongs to
// the next stage; counting it would make one cohort's number grow with age.
export const actionsPerOrder = (timelines) => {
  const done = (timelines || []).filter((t) => t.approvedMs != null);
  const byRole = {}, byAction = {};
  const perOrder = [];
  let actions = 0;
  for (const t of done) {
    const counted = t.actions.filter((a) => a.at <= t.lastApprovedMs);
    perOrder.push(counted.length);
    for (const a of counted) {
      actions += 1;
      byRole[a.role] = (byRole[a.role] || 0) + 1;
      byAction[a.action] = (byAction[a.action] || 0) + 1;
    }
  }
  const n = done.length;
  return {
    orders: n,
    actions,
    mean: n ? round2(actions / n) : null,
    median: median(perOrder),
    by_role: Object.entries(byRole)
      .map(([role, count]) => ({ label: role, value: round2(count / n), count }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)),
    by_action: byAction,
    ids: done.map((t) => t.id),
  };
};
