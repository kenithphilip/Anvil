// The engineer's decision on a terms flag
// (docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 6).
//
// Four decisions, each with a required reason:
//   accept             we accept the PO's term; the flag closes
//   request_amendment  we ask the customer to amend; the flag stays open
//   reject_term        we do not accept the term; the flag closes as rejected
//   not_a_deviation    the flag is wrong; the flag closes (counts toward
//                      precision)
//
// Who may decide (owner decision 2, 2026-10-13):
//   - anyone with order.terms_decide (sales_engineer, sales_manager, admin)
//     may request an amendment or reject a term at any severity, and may
//     accept an info or warn flag;
//   - accepting, or calling not_a_deviation on, a high or critical flag also
//     needs order.terms_accept_high (sales_manager, admin);
//   - a tenant policy may also require order.terms_accept_high to accept a
//     clause at any severity (accept_requires). It can only tighten.
//
// Append-only: order_term_decisions is only ever inserted. A changed mind is
// a new row, and the newest row per flag is the current decision.

import { hasAction, hasPermission } from "../auth.js";
import { ACCEPT_HIGH_ACTION } from "./compare.js";
import { termsDbError } from "./errors.js";

export const DECISIONS = Object.freeze(["accept", "request_amendment", "reject_term", "not_a_deviation"]);
export const DECIDE_ACTION = "order.terms_decide";
export { ACCEPT_HIGH_ACTION };
export const MIN_REASON_LENGTH = 10;

// The decisions that close a flag as fine for us.
const ACCEPT_LIKE = new Set(["accept", "not_a_deviation"]);
const HIGH_SEVERITIES = new Set(["high", "critical"]);
// The decisions that leave a flag open.
export const OPEN_DECISIONS = new Set(["request_amendment"]);

// The actions one decision on one flag needs.
export const actionsFor = (decision, severity, clausePolicy = null) => {
  const out = [DECIDE_ACTION];
  if (ACCEPT_LIKE.has(decision)
    && (HIGH_SEVERITIES.has(severity) || (clausePolicy && clausePolicy.accept_requires === ACCEPT_HIGH_ACTION))) {
    out.push(ACCEPT_HIGH_ACTION);
  }
  return out;
};

// May this caller make this decision on this flag? Write first, then the
// actions (section 6.2: both are checked after write).
export const mayDecide = (ctx, decision, severity, clausePolicy = null) =>
  DECISIONS.includes(decision) && hasPermission(ctx, "write")
  && actionsFor(decision, severity, clausePolicy).every((a) => hasAction(ctx, a));

// The decisions this caller may make on a flag. The Terms tab offers these
// and only these; the server checks again on every decision.
export const allowedDecisions = (ctx, flag, policy) => {
  if (!flag || flag.superseded_at) return [];
  const clausePolicy = flag.clause && policy?.clauses ? policy.clauses[flag.clause] : null;
  return DECISIONS.filter((d) => mayDecide(ctx, d, flag.severity, clausePolicy));
};

// A reason, trimmed, or null when it is too short to say why.
export const validReason = (reason) => {
  const r = typeof reason === "string" ? reason.trim() : "";
  return r.length >= MIN_REASON_LENGTH ? r : null;
};

// ── reads ───────────────────────────────────────────────────────────────────

const CHUNK = 200;

// Every decision on these flags, in this tenant.
export const readDecisions = async (svc, tenantId, flagIds) => {
  const ids = [...new Set((flagIds || []).filter(Boolean))];
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const r = await svc.from("order_term_decisions").select("*")
      .eq("tenant_id", tenantId).in("flag_id", ids.slice(i, i + CHUNK));
    if (r.error) throw termsDbError("order_term_decisions", r.error);
    out.push(...(r.data || []));
  }
  return out;
};

const newestFirst = (a, b) => String(b.decided_at || "").localeCompare(String(a.decided_at || ""));

// flag id -> its decisions, newest first. The first is the current one.
export const historyByFlag = (rows) => {
  const map = new Map();
  for (const r of rows || []) {
    if (!map.has(r.flag_id)) map.set(r.flag_id, []);
    map.get(r.flag_id).push(r);
  }
  for (const list of map.values()) list.sort(newestFirst);
  return map;
};

// A decision time that sorts after every earlier decision on the flag, so
// "the newest row is current" holds even for two decisions in the same
// millisecond.
export const nextDecidedAt = (history, now = new Date()) => {
  const latest = (history || []).reduce((m, r) => {
    const t = Date.parse(r.decided_at || "");
    return Number.isFinite(t) && t > m ? t : m;
  }, -Infinity);
  const t = Math.max(now.getTime(), latest + 1);
  return new Date(t).toISOString();
};

// A decision as the API returns it.
export const decisionView = (d) => (d ? {
  id: d.id,
  decision: d.decision,
  reason: d.reason,
  decided_by: d.decided_by || null,
  decided_role: d.decided_role || null,
  decided_at: d.decided_at || null,
  carried_from: d.carried_from || null,
} : null);
