// One list of what needs a decision on a sales order: the work queue.
//
// Before this, the flags on one order were spread over eight places in the SO
// workspace: the quote strip's verdict, the quote-check banner, the -MOD
// banner, the collapsed extraction-quality card, the grid's Issues column,
// the Why tab, the Terms tab and the intake mismatch banner. Nothing listed
// them together, so an engineer had to visit each one, and an approver could
// not tell what had been looked at.
//
// buildOrderExceptions gathers every source into ONE list. The same list is
// what GET /api/orders/exceptions returns and what the workspace renders, so
// a person and an agent read the same queue (docs/AGENT_READY_SO_FLOW.md).
//
// Each row:
//   key                 stable id: the type and the subject. The same issue
//                       keeps its key across re-reads (a re-run terms check
//                       gives new flag ids; the key uses the clause).
//   type                a machine type from EXCEPTION_TYPES (documented below)
//   source, sources     where it comes from (SOURCES); every source that
//                       reported it when two did
//   severity            critical, high, warn or info (the terms vocabulary)
//   blocks              "approval" when the server refuses approval until it
//                       is cleared; "send" when the order should not go for
//                       approval with it open; null otherwise
//   status              open, or decided elsewhere (kept, so nothing is lost)
//   title, detail       words for a person
//   payload             the same evidence as data: the subject, the field,
//                       the PO value, the quote value, evidence refs
//   action              where in the EXISTING screen it is resolved (a tab,
//                       a control, a grid line). No control is added here.
//   resolution_options  the fixed options for the type, each naming the
//                       existing endpoint or control that applies it today,
//                       or not_available_yet
//   agent_policy        propose, apply or human_only (agentPolicyFor)
//
// The same issue reported by two sources shows once. A payment-terms
// difference is both a reconcile verdict and a terms flag; the -MOD blocker
// is both a finding and the reconcile's mod_bom block; a line-count shortfall
// is both an extraction anomaly and a finding. The row from the source that
// can decide it wins, and `sources` lists both.
//
// The anomaly rules (/api/anomaly/compute) run only from "run validation";
// the server does not run them (plan PR 8 is not built). An order whose rules
// never ran gets one row, "Anomaly check not run", whose option is that
// existing button.
//
// PURE. No I/O, never throws on odd input. The endpoint reads the inputs; the
// SO workspace imports this file too, so they cannot disagree.

import { SEVERITY_LEVELS } from "./terms/taxonomy.js";
import { isUnresolvedBlocker } from "./blocking-findings.js";

// The response shape. Bump it when a field changes meaning.
export const EXCEPTIONS_VERSION = 1;

export const SOURCES = Object.freeze([
  "terms",           // order_term_flags, through the terms read path
  "finding",         // orders.rule_findings: blocking and recorded findings
  "reconciliation",  // result.quoteReconciliation: lines, header verdicts, gaps
  "customer",        // the order's customer against the PO's buyer block
  "delivery_date",   // the PO's delivery dates against ours
  "anomaly",         // the anomaly rule library (run validation), anomaly_flags
  "extraction",      // the extraction run: status, confidence, anomalies, validators
]);

// When two sources report one issue, the earlier source wins: a terms flag
// carries its own decision control, a finding carries the resolve control,
// and both say more than a reconcile verdict.
const SOURCE_RANK = Object.fromEntries(SOURCES.map((s, i) => [s, i]));

export const SEVERITY_RANK = Object.fromEntries(SEVERITY_LEVELS.map((s, i) => [s, i]));

// Below the intake's customer-match gate (so-intake.tsx), a run's confidence
// is low enough that a person should look at the lines.
export const LOW_CONFIDENCE = 0.85;

// The extraction anomaly a fallback parser leaves (docai/llm-fallback.js).
export const FALLBACK_PARSE_CODE = "llm_unavailable_fallback_parse";

// The action decision 2 requires to accept a high or critical terms flag.
// The same string as terms/compare.js ACCEPT_HIGH_ACTION, which this file
// cannot import (it pulls in node:crypto, and the browser imports this).
export const MANAGER_ACCEPT_ACTION = "order.terms_accept_high";

// Statuses before approval. The "not run" rule applies only while the order
// is still being reviewed.
export const REVIEW_STATUSES = new Set(["DRAFT", "PENDING_REVIEW", "BLOCKED"]);

const HEADER_VERDICTS = new Set(["payment_terms_mismatch", "incoterms_mismatch", "incoterms_place_differs"]);

// ── resolution options ──────────────────────────────────────────────────────

// The vocabulary. Each type lists the options that make sense for it.
export const RESOLUTION_OPTIONS = Object.freeze({
  accept_po_value: "Keep the PO's value",
  accept_quote_value: "Change the order to the quote's value",
  accept_suggested_date: "Set the committed date to the suggested date",
  request_amendment: "Ask the customer to amend the PO",
  reject_line: "Remove the line from the order",
  reject_term: "Reject the PO's term",
  not_a_deviation: "Record that it is not a deviation",
  set_value: "Enter a corrected value",
  map_item: "Map the line to an item-master part",
  add_line: "Add the quoted line, marked not on the PO",
  run_check: "Run the check again",
  confirm: "Confirm it as it stands",
  change_customer: "Link the order to another customer",
  update_master: "Update the customer master from the PO",
});

// How each option is applied today. kind "endpoint" names the existing call
// and the control that makes it; kind "not_available_yet" says what is
// missing. Placeholders in braces ({order_id}, {line_index}, {code}) are
// filled from the row's payload by the caller.
const NA = (reason) => Object.freeze({ kind: "not_available_yet", reason });
const NO_DECISION_RECORD = NA("No decision record exists yet: plan PR 11 (order_exception_decisions) is not built.");
const NO_AMENDMENT = NA("No amendment request exists yet: plan PR 11 decisions and the plan PR 16 handoff are not built.");
const NO_CUSTOMER_CHANGE = NA("customer_id is not in the order PATCH allowlist: plan PR 7 is not built.");
const endpoint = (method, path, body, control, permission = "write") =>
  Object.freeze({ kind: "endpoint", method, path, body, control, permission });
const ORDER = "/api/orders/{order_id}";
const lineEdit = (field) => endpoint("PATCH", ORDER, "result.salesOrder.lineItems[{line_index}]." + field,
  "Line grid: edit the cell on line {line_number}, then Save line edits");
const LINE_REMOVE = endpoint("PATCH", ORDER, "result.salesOrder.lineItems without line {line_index}",
  "Line grid: remove line {line_number}, then Save line edits");
const LINE_MAP = endpoint("PATCH", ORDER, "result.salesOrder.lineItems[{line_index}]._mapped_item",
  "Line grid: Map to canonical on line {line_number}, then Save line edits");
const LINE_ADD = endpoint("PATCH", ORDER, "result.salesOrder.lineItems plus one line",
  "Line grid: + Add line, then Save line edits");
const ADD_QUOTED = endpoint("PATCH", ORDER, "result.salesOrder.lineItems plus a quote_variance line",
  "Quote check: Quoted-only lines, Add, then Save line edits");
const LINE_EDIT_ANY = endpoint("PATCH", ORDER, "result.salesOrder.lineItems[{line_index}]",
  "Line grid: edit line {line_number}, then Save line edits");
const headerField = (field) => endpoint("PATCH", ORDER, field, "Header fields tab: Save header");
const RUN_VALIDATION = endpoint("POST", "/api/anomaly/compute", "then PATCH " + ORDER + " rule_findings",
  "Header: run validation");
const RUN_EXTRACTION = endpoint("POST", "/api/docai/extract", "source_id, order_id", "Header: run extraction");
const TERMS_CHECK = endpoint("POST", "/api/orders/terms_check", "order_id", "Terms tab: Re-check terms");
const termsDecide = (decision, permission) => endpoint("POST", "/api/orders/terms_decide",
  "order_id, flag_id, decision: " + decision + ", reason", "Terms tab: the flag's decision buttons", permission);
const RESOLVE_FINDING = endpoint("PATCH", ORDER, "resolve_finding: { code: {code}, note }",
  "Why tab: Blocks approval, resolve", "approve");
const UPDATE_MASTER = endpoint("POST", "/api/customers", "the customer record with the PO's values",
  "SO intake: Update customer dialog");

const opt = (option, appliesVia) => Object.freeze({ option, applies_via: appliesVia });

// The type enum. Every row's type is a key here, or a key ending in ":*"
// with the code after the colon (anomaly:<rule>, finding:<code>,
// extraction_check:<code>). Each type names its source and its fixed
// resolution options, in the order a screen offers them.
export const EXCEPTION_TYPES = Object.freeze({
  // the quote check (reconciliation)
  line_price_mismatch: { source: "reconciliation", options: [opt("accept_po_value", NO_DECISION_RECORD), opt("accept_quote_value", lineEdit("rate")), opt("request_amendment", NO_AMENDMENT), opt("set_value", lineEdit("rate"))] },
  line_qty_mismatch: { source: "reconciliation", options: [opt("accept_po_value", NO_DECISION_RECORD), opt("accept_quote_value", lineEdit("qty")), opt("request_amendment", NO_AMENDMENT), opt("set_value", lineEdit("qty"))] },
  line_description_mismatch: { source: "reconciliation", options: [opt("accept_po_value", NO_DECISION_RECORD), opt("accept_quote_value", lineEdit("description")), opt("set_value", lineEdit("description"))] },
  line_unmatched: { source: "reconciliation", options: [opt("map_item", LINE_MAP), opt("set_value", lineEdit("itemCode")), opt("reject_line", LINE_REMOVE), opt("request_amendment", NO_AMENDMENT)] },
  line_reconcile_other: { source: "reconciliation", options: [opt("set_value", LINE_EDIT_ANY), opt("confirm", NO_DECISION_RECORD)] },
  payment_terms_mismatch: { source: "reconciliation", options: [opt("accept_po_value", NO_DECISION_RECORD), opt("request_amendment", NO_AMENDMENT)] },
  incoterm_mismatch: { source: "reconciliation", options: [opt("accept_po_value", NO_DECISION_RECORD), opt("set_value", headerField("incoterm_code")), opt("request_amendment", NO_AMENDMENT)] },
  incoterm_place_differs: { source: "reconciliation", options: [opt("accept_po_value", NO_DECISION_RECORD), opt("set_value", headerField("incoterm_code")), opt("request_amendment", NO_AMENDMENT)] },
  incoterm_unconfirmed: { source: "reconciliation", options: [opt("confirm", NO_DECISION_RECORD), opt("set_value", headerField("incoterm_code"))] },
  quoted_not_ordered: { source: "reconciliation", options: [opt("add_line", ADD_QUOTED), opt("request_amendment", NO_AMENDMENT), opt("confirm", NO_DECISION_RECORD)] },
  // findings and blockers
  mod_bom_pending: { source: "finding", options: [opt("confirm", RESOLVE_FINDING), opt("run_check", RUN_EXTRACTION)] },
  line_count_shortfall: { source: "finding", options: [opt("run_check", RUN_EXTRACTION), opt("confirm", RESOLVE_FINDING)] },
  blocking_finding: { source: "finding", options: [opt("confirm", RESOLVE_FINDING)] },
  "finding:*": { source: "finding", options: [opt("confirm", RESOLVE_FINDING), opt("set_value", LINE_EDIT_ANY)] },
  // the anomaly rules
  "anomaly:*": { source: "anomaly", options: [opt("confirm", NO_DECISION_RECORD), opt("set_value", LINE_EDIT_ANY), opt("run_check", RUN_VALIDATION)] },
  anomaly_check_not_run: { source: "anomaly", options: [opt("run_check", RUN_VALIDATION)] },
  // the extraction run
  extraction_no_lines: { source: "extraction", options: [opt("run_check", RUN_EXTRACTION), opt("set_value", LINE_ADD)] },
  extraction_failed: { source: "extraction", options: [opt("run_check", RUN_EXTRACTION), opt("confirm", NO_DECISION_RECORD)] },
  extraction_low_confidence: { source: "extraction", options: [opt("run_check", RUN_EXTRACTION), opt("confirm", NO_DECISION_RECORD)] },
  extraction_fallback_parse: { source: "extraction", options: [opt("run_check", RUN_EXTRACTION), opt("confirm", NO_DECISION_RECORD)] },
  "extraction_check:*": { source: "extraction", options: [opt("set_value", lineEdit("{field}")), opt("run_check", RUN_EXTRACTION), opt("confirm", NO_DECISION_RECORD)] },
  // the terms check
  terms_flag: {
    source: "terms",
    options: [
      opt("accept_po_value", termsDecide("accept", "order.terms_decide (and " + MANAGER_ACCEPT_ACTION + " at high or critical)")),
      opt("request_amendment", termsDecide("request_amendment", "order.terms_decide")),
      opt("reject_term", termsDecide("reject_term", "order.terms_decide")),
      opt("not_a_deviation", termsDecide("not_a_deviation", "order.terms_decide (and " + MANAGER_ACCEPT_ACTION + " at high or critical)")),
    ],
  },
  terms_not_read: { source: "terms", options: [opt("run_check", TERMS_CHECK)] },
  // the customer
  customer_unmatched: { source: "customer", options: [opt("change_customer", NO_CUSTOMER_CHANGE)] },
  customer_gstin_conflict: { source: "customer", options: [opt("change_customer", NO_CUSTOMER_CHANGE), opt("update_master", UPDATE_MASTER), opt("confirm", NO_DECISION_RECORD)] },
  customer_low_confidence: { source: "customer", options: [opt("change_customer", NO_CUSTOMER_CHANGE), opt("confirm", NO_DECISION_RECORD)] },
  customer_state_differs: { source: "customer", options: [opt("update_master", UPDATE_MASTER), opt("confirm", NO_DECISION_RECORD)] },
});

// The registry entry for a type, with the ":*" families resolved.
export const typeSpec = (type) => {
  const t = String(type || "");
  if (EXCEPTION_TYPES[t]) return EXCEPTION_TYPES[t];
  const i = t.indexOf(":");
  return i > 0 ? EXCEPTION_TYPES[t.slice(0, i) + ":*"] || null : null;
};

export const resolutionOptionsFor = (type) => (typeSpec(type)?.options || []).map((o) => ({
  option: o.option,
  label: RESOLUTION_OPTIONS[o.option] || o.option,
  applies_via: o.applies_via,
}));

// ── the agent policy ────────────────────────────────────────────────────────

// Who may act on a row: an agent may apply it, may only propose it to the
// engineer, or it is a person's decision alone. DEFAULTS, kept as data. A
// tenant setting can override any key later (resolveAgentPolicy); none is
// read today.
export const DEFAULT_AGENT_POLICY = Object.freeze({
  version: 1,
  // A person decides anything this serious.
  human_only_severities: Object.freeze(["high", "critical"]),
  // A money deviation above either bound is a person's decision: per line,
  // the percentage against the quote, or the amount it moves the order by.
  // Owner decision 4's suggested default (2% or 10,000 per line).
  money_tolerance: Object.freeze({ pct: 2, amount: 10000 }),
  // Terms flags at these severities need a sales manager or an admin to
  // accept (owner decision 2, lib/rbac.ts order.terms_accept_high). A
  // clause whose tenant policy sets accept_requires is reserved too.
  manager_terms_severities: Object.freeze(["high", "critical"]),
  // Housekeeping an agent may simply do: re-running a read-only check.
  apply_types: Object.freeze(["anomaly_check_not_run", "terms_not_read"]),
  // Everything else is proposed to the engineer.
  otherwise: "propose",
});

export const AGENT_POLICIES = Object.freeze(["propose", "apply", "human_only"]);

// The defaults with a tenant's overrides laid over them, key by key. Values
// of the wrong shape are ignored, so a bad setting cannot loosen anything by
// accident.
export const resolveAgentPolicy = (override = null) => {
  const o = override && typeof override === "object" ? override : {};
  const list = (v, d) => (Array.isArray(v) ? Object.freeze(v.map(String)) : d);
  const tol = o.money_tolerance && typeof o.money_tolerance === "object" ? o.money_tolerance : {};
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
  const d = DEFAULT_AGENT_POLICY;
  return Object.freeze({
    version: d.version,
    human_only_severities: list(o.human_only_severities, d.human_only_severities),
    money_tolerance: Object.freeze({ pct: n(tol.pct, d.money_tolerance.pct), amount: n(tol.amount, d.money_tolerance.amount) }),
    manager_terms_severities: list(o.manager_terms_severities, d.manager_terms_severities),
    apply_types: list(o.apply_types, d.apply_types),
    otherwise: AGENT_POLICIES.includes(o.otherwise) && o.otherwise !== "apply" ? o.otherwise : d.otherwise,
  });
};

// True when a row moves money by more than the tolerance.
export const exceedsMoneyTolerance = (payload, policy = DEFAULT_AGENT_POLICY) => {
  const p = payload || {};
  const pct = num(p.delta_pct);
  const amount = num(p.amount);
  return (pct != null && Math.abs(pct) > policy.money_tolerance.pct)
    || (amount != null && Math.abs(amount) > policy.money_tolerance.amount);
};

// The policy for one row. In order:
//   1. a shadow terms row, a blocking row, or a severity in
//      human_only_severities: human_only
//   2. a money deviation above money_tolerance: human_only
//   3. a terms flag that decision 2 reserves for a manager: human_only
//   4. a type in apply_types: apply
//   5. otherwise: propose
export const agentPolicyFor = (row, policy = DEFAULT_AGENT_POLICY) => {
  if (!row) return "human_only";
  if (row.shadow || row.blocks) return "human_only";
  if (policy.human_only_severities.includes(row.severity)) return "human_only";
  if (exceedsMoneyTolerance(row.payload, policy)) return "human_only";
  if (row.type === "terms_flag"
    && (policy.manager_terms_severities.includes(row.severity) || row.payload?.manager_only === true)) return "human_only";
  if (policy.apply_types.includes(row.type)) return "apply";
  return policy.otherwise === "human_only" ? "human_only" : "propose";
};

// ── small helpers ───────────────────────────────────────────────────────────

const str = (v) => (v == null ? "" : String(v).trim());
function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const arr = (v) => (Array.isArray(v) ? v : []);
const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);
const words = (s) => str(s).replace(/_/g, " ");
const fmtNum = (n) => {
  const v = num(n);
  if (v == null) return "?";
  try { return v.toLocaleString("en-IN", { maximumFractionDigits: 2 }); } catch { return String(v); }
};
const signed = (n) => (n > 0 ? "+" : "") + fmtNum(n);
// A code or part number as a key fragment: no spaces, no colons.
const keyPart = (s) => str(s).toUpperCase().replace(/[\s:]+/g, "_");

// Every vocabulary the sources use, mapped onto the terms one.
//   anomaly rules       high, medium, low
//   extraction          error, warn, info
//   rule_findings       ERROR, WARNING, INFO
//   terms               critical, high, warn, info
export const normSeverity = (s) => {
  const v = str(s).toLowerCase();
  if (v === "critical" || v === "blocker") return "critical";
  if (v === "high" || v === "error") return "high";
  if (v === "info" || v === "low") return "info";
  return "warn";
};

const maxSeverity = (a, b) => ((SEVERITY_RANK[a] ?? 1) >= (SEVERITY_RANK[b] ?? 1) ? a : b);

const linesOf = (order) => arr(order?.result?.salesOrder?.lineItems);

// A line index from any of the spellings the sources use.
const lineIndexOf = (x) => {
  for (const k of ["line_index", "lineIndex"]) {
    const v = num(x?.[k]);
    if (v != null && v >= 0) return Math.floor(v);
  }
  const m = /^lines\[(\d+)\]/.exec(str(x?.field || x?.path));
  return m ? Number(m[1]) : null;
};

// The subject of a line row. The PO's own line number when it printed one
// (it survives a line added or removed above), else the grid index, plus the
// part. Used in the key, so a re-read of the same order gives the same key.
const lineSubject = (lines, lineIndex, partNo) => {
  const ln = lineIndex != null ? lines[lineIndex] : null;
  const part = keyPart(partNo ?? ln?.partNumber ?? ln?.part_no ?? ln?.itemCode);
  const where = ln && ln.line_no != null && str(ln.line_no) !== ""
    ? "n" + keyPart(ln.line_no)
    : (lineIndex != null ? "i" + lineIndex : null);
  return "line:" + [where, part].filter(Boolean).join(":");
};

const lineSubjectData = (lines, lineIndex, partNo) => ({
  kind: "line",
  line_index: lineIndex,
  line_number: lineIndex != null ? lineIndex + 1 : null,
  line_no: lineIndex != null && lines[lineIndex]?.line_no != null ? lines[lineIndex].line_no : null,
  part_no: str(partNo) || null,
});

// The PO evidence a line carries (stampEvidenceOnLines), as a ref.
const lineEvidenceRefs = (order, lineIndex) => {
  const refs = [];
  const ln = lineIndex != null ? linesOf(order)[lineIndex] : null;
  const ev = ln && ln._evidence;
  const doc = order?.preflight_payload?.source_document_id || null;
  if (ev && (ev.page != null || Array.isArray(ev.bbox_norm))) {
    refs.push({ kind: "po_document", document_id: doc, page: num(ev.page), bbox_norm: Array.isArray(ev.bbox_norm) ? ev.bbox_norm : null, field_path: "lines[" + lineIndex + "]" });
  }
  return refs;
};

const lineLabel = (lineIndex, partNo) => [lineIndex != null ? "L" + (lineIndex + 1) : null, str(partNo) || null].filter(Boolean).join(" ");
const withLine = (label, text) => (label ? label + ": " + text : text);

// Where a line issue is resolved: that row of the line grid.
const lineAction = (lineIndex, what) => (lineIndex != null
  ? { tab: "recon", target: "lines[" + lineIndex + "]", label: what + " on line " + (lineIndex + 1) + " in the line grid" }
  : { tab: "recon", label: what + " in the line grid" });

// ── the customer match ──────────────────────────────────────────────────────

const normName = (s) => str(s).toLowerCase()
  .replace(/^m\/s\.?\s*/i, "")
  .replace(/[.,]/g, " ")
  .replace(/\b(pvt|ltd|llp|inc|corp|gmbh|kk|ag|bv|sa|company|limited|co)\b/g, "")
  .replace(/\s+/g, " ")
  .trim();
const normGstin = (s) => str(s).toUpperCase().replace(/\s+/g, "");

export const MATCH_BASIS_LABEL = Object.freeze({
  gstin: "matched by GSTIN",
  vendor_code: "matched by vendor code",
  name: "matched by name",
  gstin_conflict: "GSTIN on the PO differs",
  unverified: "not confirmed by the PO",
  not_on_po: "the PO names no buyer",
  unknown: "match basis unknown",
  none: "no customer",
});

// How the order's customer is backed by the PO. The intake does not save the
// basis it matched on (audit F8), so it is derived from what the PO's buyer
// block and the customer master both say, strongest first:
//   gstin           the PO's GSTIN is the master's
//   gstin_conflict  both state a GSTIN and they differ
//   vendor_code     the vendor code the PO prints is one this customer uses
//   name            the names agree once legal suffixes are dropped
//   not_on_po       the PO's buyer block carries no name and no GSTIN
//   unverified      the PO names someone, and nothing above agrees
//   unknown         the order has a customer whose record was not read
//   none            the order has no customer
export const customerMatchBasis = ({ order, customer = null, vendorCodes = [] } = {}) => {
  const po = order?.result?.salesOrder?.customer || {};
  const base = { po_name: str(po.name) || null, master_name: str(customer?.customer_name) || null };
  if (!order?.customer_id) return { ...base, basis: "none", label: MATCH_BASIS_LABEL.none };
  if (!customer) return { ...base, basis: "unknown", label: MATCH_BASIS_LABEL.unknown };
  const poGstin = normGstin(po.gstin);
  const masterGstin = normGstin(customer.gstin);
  if (poGstin && masterGstin) {
    const basis = poGstin === masterGstin ? "gstin" : "gstin_conflict";
    return { ...base, basis, label: MATCH_BASIS_LABEL[basis], po_gstin: poGstin, master_gstin: masterGstin };
  }
  const vendor = str(order.vendor_code) || str(po.vendor_code);
  if (vendor && arr(vendorCodes).map(str).includes(vendor)) return { ...base, basis: "vendor_code", label: MATCH_BASIS_LABEL.vendor_code };
  const poName = normName(po.name);
  if (poName && poName === normName(customer.customer_name)) return { ...base, basis: "name", label: MATCH_BASIS_LABEL.name };
  if (!poName && !poGstin) return { ...base, basis: "not_on_po", label: MATCH_BASIS_LABEL.not_on_po };
  return { ...base, basis: "unverified", label: MATCH_BASIS_LABEL.unverified };
};

const customerRows = ({ order, customer, vendorCodes }) => {
  const out = [];
  const match = customerMatchBasis({ order, customer, vendorCodes });
  const subject = "customer:" + (order?.customer_id || "none");
  const subjectData = { kind: "customer", customer_id: order?.customer_id || null };
  const cardAction = { tab: "recon", control: "customer_card", label: "Customer · from PO header card on the Reconcile tab" };
  if (match.basis === "none") {
    out.push(({
      type: "customer_unmatched", subject, source: "customer", severity: "high",
      title: "No customer on the order",
      detail: (match.po_name ? "The PO names " + match.po_name + ". " : "")
        + "The quote check and the anomaly rules need a customer.",
      payload: { subject: subjectData, field: "customer_id", po_value: match.po_name, evidence_refs: [] },
      // The PATCH allowlist has no customer_id (audit F8), so no screen can
      // set it after create. The one place that can is a new intake.
      action: { href: "#/so?new=1", label: "Cannot be set here yet: create the order again from New from PO" },
    }));
  } else if (match.basis === "gstin_conflict") {
    out.push(({
      type: "customer_gstin_conflict", subject, source: "customer", severity: "high",
      title: "GSTIN on the PO differs from the customer master",
      detail: "PO " + match.po_gstin + " vs master " + match.master_gstin + (match.master_name ? " (" + match.master_name + ")" : ""),
      payload: { subject: subjectData, field: "customer.gstin", po_value: match.po_gstin, master_value: match.master_gstin, evidence_refs: [] },
      action: cardAction,
    }));
  } else if (match.basis === "unverified") {
    out.push(({
      type: "customer_low_confidence", subject, source: "customer", severity: "warn",
      title: "Customer not confirmed by the PO",
      detail: "The PO names " + (match.po_name || "a buyer") + "; the order is linked to " + (match.master_name || "another customer")
        + ". No GSTIN, vendor code or name agrees.",
      payload: { subject: subjectData, field: "customer.name", po_value: match.po_name, master_value: match.master_name, evidence_refs: [] },
      action: cardAction,
    }));
  }
  // The state decides IGST against CGST and SGST. A GSTIN conflict already
  // carries it (a GSTIN starts with the state code), so it is said once.
  const poState = str(order?.result?.salesOrder?.customer?.state_code).toUpperCase();
  const masterState = str(customer?.state_code).toUpperCase();
  if (match.basis !== "gstin_conflict" && poState && masterState && poState !== masterState) {
    out.push(({
      type: "customer_state_differs", subject, source: "customer", severity: "warn",
      title: "State on the PO differs from the customer master",
      detail: "PO state code " + poState + " vs master " + masterState + ". The tax split (IGST, or CGST and SGST) follows the state.",
      payload: { subject: subjectData, field: "customer.state_code", po_value: poState, master_value: masterState, evidence_refs: [] },
      action: cardAction,
    }));
  }
  return { rows: out, match };
};

// ── the quote reconciliation ────────────────────────────────────────────────

// Each line flag gets the grid row it came from. The flags carry the PO's
// line_no and the part, not the grid index; the persisted lines carry the
// same verdict on _match, so the first unused line with that verdict and
// part is the one.
const assignLineIndexes = (flags, lines) => {
  const used = new Set();
  return flags.map((f) => {
    const i = lines.findIndex((ln, idx) => {
      if (used.has(idx)) return false;
      const m = ln && ln._match;
      if (!m || m.verdict !== f.verdict) return false;
      if (str(m.part_no) !== str(f.part_no)) return false;
      if (f.line_no != null && ln.line_no != null && String(ln.line_no) !== String(f.line_no)) return false;
      return true;
    });
    if (i >= 0) used.add(i);
    return i >= 0 ? i : null;
  });
};

const lineFlagRow = (order, f, lineIndex, policy) => {
  const lines = linesOf(order);
  const label = lineLabel(lineIndex, f.part_no);
  const q = f.source_quote_number ? " · " + f.source_quote_number : "";
  const subject = lineSubject(lines, lineIndex, f.part_no);
  const base = {
    subject: lineSubjectData(lines, lineIndex, f.part_no),
    quote_number: f.source_quote_number || null,
    evidence_refs: [
      ...lineEvidenceRefs(order, lineIndex),
      ...(f.source_quote_number ? [{ kind: "quote", quote_number: f.source_quote_number }] : []),
    ],
  };
  if (f.verdict === "price_mismatch") {
    const po = num(f.po_rate);
    const quote = num(f.quote_rate);
    const qty = num(f.po_qty);
    const amount = po != null && quote != null && qty != null ? Math.round((po - quote) * qty) : null;
    const pct = num(f.price_delta_pct);
    const payload = { ...base, field: "rate", po_value: po, quote_value: quote, delta_pct: pct, qty, amount };
    return ({
      type: "line_price_mismatch", subject, source: "reconciliation",
      // Beyond the money tolerance a person decides; inside it, a look.
      severity: exceedsMoneyTolerance(payload, policy) ? "high" : "warn",
      title: withLine(label, "price differs from the quote"),
      detail: "PO " + fmtNum(po) + " vs quote " + fmtNum(quote)
        + (pct != null ? " (" + (pct > 0 ? "+" : "") + pct + "%)" : "")
        + (amount != null ? " = " + signed(amount) + " on " + fmtNum(qty) : "") + q,
      payload,
      action: lineAction(lineIndex, "The rate"),
    });
  }
  if (f.verdict === "description_mismatch") {
    return ({
      type: "line_description_mismatch", subject, source: "reconciliation", severity: "warn",
      title: withLine(label, "description differs from the quote"),
      detail: "PO “" + (str(f.po_description) || "-") + "” vs quote “" + (str(f.quote_description) || "-") + "”" + q,
      payload: { ...base, field: "description", po_value: f.po_description || null, quote_value: f.quote_description || null },
      action: lineAction(lineIndex, "The description"),
    });
  }
  if (f.verdict === "unmatched") {
    return ({
      type: "line_unmatched", subject, source: "reconciliation", severity: "warn",
      title: withLine(label || "A line", "no quote covers this line"),
      detail: "unmatched: " + (str(f.part_no) || "-") + ". Nothing in the customer's quotes prices it.",
      payload: { ...base, field: "part_no", po_value: f.part_no || null, quote_value: null },
      action: lineAction(lineIndex, "Map to canonical"),
    });
  }
  // A verdict this builder does not know is named as it is, never relabelled.
  return ({
    type: "line_reconcile_other", subject: subject + ":" + keyPart(f.verdict || "issue"), source: "reconciliation", severity: "warn",
    title: withLine(label, words(f.verdict || "issue")),
    detail: words(f.verdict || "issue") + ": " + (str(f.part_no) || "-") + q,
    payload: { ...base, field: null, verdict: f.verdict || null },
    action: lineAction(lineIndex, "The line"),
  });
};

const ORDER_SUBJECT = { kind: "order" };

const reconciliationRows = ({ order, termsByClause, policy }) => {
  const recon = order?.result?.quoteReconciliation;
  if (!recon || typeof recon !== "object") return [];
  const out = [];
  const lines = linesOf(order);
  const lineFlags = arr(recon.flags).filter((f) => f && !HEADER_VERDICTS.has(f.verdict));
  const indexes = assignLineIndexes(lineFlags, lines);
  lineFlags.forEach((f, n) => out.push(lineFlagRow(order, f, indexes[n], policy)));

  // A quantity difference reconciles as "matched" with a note, so it is not
  // in the flags. It is read off the line.
  lines.forEach((ln, i) => {
    const m = ln && ln._match;
    if (!m || m.verdict !== "matched" || !m.qty_note) return;
    out.push(({
      type: "line_qty_mismatch", subject: lineSubject(lines, i, m.part_no), source: "reconciliation", severity: "warn",
      title: withLine(lineLabel(i, m.part_no), "quantity differs from the quote"),
      detail: "PO " + fmtNum(m.po_qty) + " vs quote " + fmtNum(m.quote_qty) + (m.source_quote_number ? " · " + m.source_quote_number : ""),
      payload: {
        subject: lineSubjectData(lines, i, m.part_no), field: "qty", po_value: num(m.po_qty), quote_value: num(m.quote_qty),
        quote_number: m.source_quote_number || null,
        evidence_refs: [...lineEvidenceRefs(order, i), ...(m.source_quote_number ? [{ kind: "quote", quote_number: m.source_quote_number }] : [])],
      },
      action: lineAction(i, "The quantity"),
    }));
  });

  // Header verdicts. When the terms check owns the clause and has decided
  // it, the verdict is kept as decided rather than asked again.
  const decidedBy = (clause) => {
    const t = termsByClause.get(clause);
    return t && t.state !== "undecided" ? t : null;
  };
  const pt = recon.payment_terms;
  if (pt && pt.verdict === "mismatch") {
    const t = decidedBy("payment_terms");
    out.push(({
      type: "payment_terms_mismatch", issue: "clause:payment_terms", subject: "order", source: "reconciliation", severity: "high",
      title: "Payment terms differ from the quote",
      detail: "PO “" + str(pt.po_terms) + "” vs quote “" + str(pt.quote_terms) + "”" + (pt.source_quote_number ? " (" + pt.source_quote_number + ")" : ""),
      payload: {
        subject: ORDER_SUBJECT, field: "payment_terms", po_value: pt.po_terms || null, quote_value: pt.quote_terms || null,
        quote_number: pt.source_quote_number || null, differs: arr(pt.differs),
        evidence_refs: pt.source_quote_number ? [{ kind: "quote", quote_number: pt.source_quote_number }] : [],
      },
      action: termsByClause.size
        ? { tab: "terms", label: "Decide on the Terms tab" }
        : { tab: "quotes", label: "Compare with the quote on the Quotes tab" },
      ...(t ? { status: "decided", decided_note: "Decided on the Terms tab: " + words(t.decision || t.state) } : {}),
    }));
  }
  const ic = recon.incoterms;
  if (ic && (ic.verdict === "mismatch" || ic.verdict === "place_differs" || ic.verdict === "quote_missing")) {
    const t = decidedBy("incoterm");
    const q = ic.source_quote_number ? " (" + ic.source_quote_number + ")" : "";
    const byVerdict = {
      mismatch: {
        type: "incoterm_mismatch", severity: "high", title: "Incoterm differs from the quote",
        detail: "PO “" + str(ic.po_incoterm) + "” vs quote “" + str(ic.quote_incoterm) + "”" + q,
      },
      place_differs: {
        type: "incoterm_place_differs", severity: "warn", title: "Incoterm place differs from the quote",
        detail: "Both " + str(ic.po_code) + ", but PO “" + (str(ic.po_place) || "-") + "” vs quote “" + (str(ic.quote_place) || "-") + "”",
      },
      // Not a discrepancy: the quote is silent, so the PO's rule is
      // unconfirmed rather than contradicted.
      quote_missing: {
        type: "incoterm_unconfirmed", severity: "info", title: "Incoterm not stated on the quote",
        detail: "PO “" + str(ic.po_incoterm) + "”, the quote has no incoterm" + q,
      },
    }[ic.verdict];
    out.push(({
      ...byVerdict, issue: "clause:incoterm", subject: "order", source: "reconciliation",
      payload: {
        subject: ORDER_SUBJECT, field: "incoterm", po_value: ic.po_incoterm || null, quote_value: ic.quote_incoterm || null,
        quote_number: ic.source_quote_number || null,
        evidence_refs: ic.source_quote_number ? [{ kind: "quote", quote_number: ic.source_quote_number }] : [],
      },
      action: { tab: "header", label: "Incoterm on the Header fields tab" },
      ...(t ? { status: "decided", decided_note: "Decided on the Terms tab: " + words(t.decision || t.state) } : {}),
    }));
  }

  // Quoted, not ordered. Not an error: a partial order is ordinary. One row,
  // with the parts, and the existing control that lists them.
  const gaps = arr(recon.quoted_not_ordered);
  if (gaps.length) {
    const shown = gaps.slice(0, 6).map((g) => str(g.part_no) || "-");
    out.push(({
      type: "quoted_not_ordered", subject: "order", source: "reconciliation", severity: "info",
      title: plural(gaps.length, "quoted line") + " " + (gaps.length === 1 ? "is" : "are") + " not on this PO",
      detail: shown.join(", ") + (gaps.length > shown.length ? ", +" + (gaps.length - shown.length) + " more" : ""),
      payload: {
        subject: ORDER_SUBJECT, field: "lines", parts: gaps.map((g) => g.part_no || null),
        evidence_refs: [...new Set(gaps.map((g) => g.source_quote_number).filter(Boolean))].map((n) => ({ kind: "quote", quote_number: n })),
      },
      action: { tab: "recon", control: "quoted_only", label: "Quoted-only lines in the quote check" },
    }));
  }

  // The -MOD blocker. The finding (in rule_findings) carries the resolved
  // state, so it wins; this row is the fallback when the finding is missing.
  const mod = recon.mod_bom;
  if (mod && mod.is_modification_quote) {
    const parts = arr(mod.pending_parts);
    out.push(({
      type: "mod_bom_pending", subject: "finding:MOD_QUOTE_BOM_PENDING", source: "reconciliation", severity: "critical",
      blocks: "approval",
      title: "Gun modification: final BOM outstanding",
      detail: plural(parts.length, "provisional part") + " (-MOD): " + parts.slice(0, 8).join(", ") + (parts.length > 8 ? ", +" + (parts.length - 8) + " more" : ""),
      payload: { subject: { kind: "finding", code: "mod_quote_bom_pending" }, code: "mod_quote_bom_pending", field: "lines", parts, evidence_refs: [{ kind: "finding", code: "mod_quote_bom_pending" }] },
      action: { tab: "why", label: "Resolve on the Why tab (an approver clears it)" },
    }));
  }
  return out;
};

// ── findings and anomaly rules ──────────────────────────────────────────────

const resolvedNote = (f) => "Resolved" + (f.resolution_note ? ": " + f.resolution_note : "");

const findingRows = ({ order }) => {
  const out = [];
  const lines = linesOf(order);
  for (const f of arr(order?.rule_findings)) {
    if (!f || typeof f !== "object") continue;
    const code = str(f.code || f.rule_id);
    const li = lineIndexOf(f);
    // The anomaly rule library writes { key, label, severity, detail,
    // lineIndex } (anomaly/compute.js, persisted by "run validation").
    if (!code && str(f.key)) { out.push(anomalyRow(order, f, "rule_findings")); continue; }
    if (!code) continue;
    const blocker = f.blocks === true || isUnresolvedBlocker(f);
    const resolved = f.resolved === true;
    const findingSubject = { kind: "finding", code };
    const decided = resolved ? { status: "decided", decided_note: resolvedNote(f) } : {};
    if (code === "mod_quote_bom_pending") {
      const parts = arr(f.pending_parts);
      out.push(({
        type: "mod_bom_pending", subject: "finding:" + keyPart(code), source: "finding", severity: "critical", blocks: resolved ? null : "approval",
        title: "Gun modification: final BOM outstanding",
        detail: str(f.detail) || plural(parts.length, "provisional part"),
        payload: { subject: findingSubject, code, field: "lines", parts, evidence_refs: [{ kind: "finding", code }] },
        action: { tab: "why", label: "Resolve on the Why tab (an approver clears it)" },
        ...decided,
      }));
      continue;
    }
    if (code === "line_count_shortfall") {
      out.push(({
        type: "line_count_shortfall", subject: "finding:" + keyPart(code), source: "finding", severity: "critical", blocks: resolved ? null : "approval",
        title: "Lines missing: the PO declares " + fmtNum(f.expected) + ", extraction returned " + fmtNum(f.actual),
        detail: str(f.detail) || "Extraction is incomplete.",
        payload: { subject: findingSubject, code, field: "lines", po_value: num(f.expected), extracted_value: num(f.actual), evidence_refs: [{ kind: "finding", code }] },
        action: { tab: "why", label: "Re-run extraction, or resolve on the Why tab (an approver clears it)" },
        ...decided,
      }));
      continue;
    }
    out.push(({
      type: blocker ? "blocking_finding" : "finding:" + code,
      subject: "finding:" + keyPart(code) + (li != null ? ":" + lineSubject(lines, li) : ""),
      source: "finding",
      severity: blocker ? "critical" : normSeverity(f.severity),
      blocks: blocker && !resolved ? "approval" : null,
      title: withLine(li != null ? "L" + (li + 1) : "", (blocker ? "Blocks approval: " : "") + words(code)),
      detail: str(f.detail || f.message) || words(code),
      payload: {
        subject: li != null ? { ...lineSubjectData(lines, li), finding_code: code } : findingSubject,
        code, field: str(f.field) || null, po_value: f.actual ?? null, expected_value: f.expected ?? null,
        evidence_refs: [{ kind: "finding", code }, ...lineEvidenceRefs(order, li)],
      },
      action: blocker
        ? { tab: "why", label: "Resolve on the Why tab (an approver clears it)" }
        : (li != null ? lineAction(li, "The line") : { tab: "why", label: "The Why tab" }),
      ...decided,
    }));
  }
  return out;
};

// One anomaly-rule flag. The same rule on the same line from two places
// (rule_findings and the older anomaly_flags column) is one row.
function anomalyRow(order, f, from) {
  const lines = linesOf(order);
  const ruleKey = str(f.key || f.code || f.rule_id) || "anomaly";
  const li = lineIndexOf(f);
  return ({
    type: "anomaly:" + ruleKey,
    subject: li != null ? lineSubject(lines, li) : "order",
    source: "anomaly", severity: normSeverity(f.severity),
    title: withLine(li != null ? "L" + (li + 1) : "", str(f.label) || words(ruleKey)),
    detail: str(f.detail || f.message) || words(ruleKey),
    payload: {
      subject: li != null ? lineSubjectData(lines, li) : ORDER_SUBJECT,
      rule: ruleKey, field: str(f.field) || null, po_value: f.actual ?? null, expected_value: f.expected ?? null,
      evidence_refs: [{ kind: "anomaly_rule", rule: ruleKey, stored_in: from }, ...lineEvidenceRefs(order, li)],
    },
    action: li != null ? lineAction(li, "The line") : { tab: "why", label: "The Why tab" },
  });
}

const anomalyRows = ({ order }) => {
  const out = arr(order?.anomaly_flags).filter((f) => f && typeof f === "object").map((f) => anomalyRow(order, f, "anomaly_flags"));
  const ran = !!order?.preflight_payload?.last_validated_at;
  if (!ran && order?.customer_id && linesOf(order).length > 0 && REVIEW_STATUSES.has(str(order?.status))) {
    out.push(({
      type: "anomaly_check_not_run", subject: "order", source: "anomaly", severity: "warn",
      title: "Anomaly check not run",
      detail: "The rate, margin, GST, credit and hygiene rules have not scored this order. They run only from “run validation”.",
      payload: { subject: ORDER_SUBJECT, field: "rule_findings", evidence_refs: [] },
      action: { tab: "recon", control: "run_validation", label: "Run anomaly check" },
    }));
  }
  return out;
};

// ── the extraction run ──────────────────────────────────────────────────────

const extractionRows = ({ order, extractionRun }) => {
  const out = [];
  const lines = linesOf(order);
  const pf = order?.preflight_payload || {};
  const run = extractionRun && typeof extractionRun === "object" ? extractionRun : null;
  const runRef = run?.id || pf.extraction_run_id ? [{ kind: "extraction_run", run_id: run?.id || pf.extraction_run_id }] : [];
  const hasDoc = !!(pf.source_document_id || arr(order?.documents).length);
  const qualityAction = { tab: "recon", control: "extraction_quality", label: "Extraction quality card on the Reconcile tab" };

  if (!lines.length && (hasDoc || run || pf.extraction_run_id)) {
    out.push(({
      type: "extraction_no_lines", subject: "order", source: "extraction", severity: "high",
      title: "No line items extracted",
      detail: (run?.status ? "The last run ended " + words(run.status) + ". " : "") + "Run extraction again, or try another engine.",
      payload: { subject: ORDER_SUBJECT, field: "lines", run_status: run?.status || null, evidence_refs: runRef },
      action: { tab: "recon", control: "run_extraction", label: "Run extraction" },
    }));
  } else if (run && run.status === "failed") {
    out.push(({
      type: "extraction_failed", subject: "order", source: "extraction", severity: "high",
      title: "Extraction run failed",
      detail: "The lines on the order came from an earlier run or were entered by hand.",
      payload: { subject: ORDER_SUBJECT, run_status: "failed", evidence_refs: runRef },
      action: qualityAction,
    }));
  }

  const conf = num(run?.confidence_overall) ?? num(pf.confidence_overall);
  if (lines.length && ((conf != null && conf < LOW_CONFIDENCE) || run?.status === "low_confidence")) {
    const adapter = run?.adapter_used || pf.adapter_used || null;
    out.push(({
      type: "extraction_low_confidence", subject: "order", source: "extraction", severity: "warn",
      title: "Low extraction confidence" + (conf != null ? " (" + Math.round(conf * 100) + "%)" : ""),
      detail: "Check the lines against the PO" + (adapter ? "; read by " + adapter : "") + ".",
      payload: { subject: ORDER_SUBJECT, confidence: conf, threshold: LOW_CONFIDENCE, adapter, evidence_refs: runRef },
      action: qualityAction,
    }));
  }

  // Run anomalies and validator issues, one row per code: a check that fired
  // on nine lines is one thing to look at, listed with its lines.
  const groups = new Map();
  const add = (code, severity, item, kind) => {
    const g = groups.get(code) || { code, severity: "info", items: [], kinds: new Set() };
    g.severity = maxSeverity(g.severity, normSeverity(severity));
    g.items.push(item);
    g.kinds.add(kind);
    groups.set(code, g);
  };
  for (const a of arr(run?.anomalies)) {
    if (!a || typeof a !== "object") continue;
    const code = str(a.code) || "anomaly";
    if (code === FALLBACK_PARSE_CODE) {
      out.push(({
        type: "extraction_fallback_parse", subject: "order", source: "extraction", severity: "warn",
        title: "Read by the fallback parser",
        detail: "The AI models were busy, so " + (str(a.actual) || "a parser") + " read this PO. It can miss header fields and split one item into several lines.",
        payload: { subject: ORDER_SUBJECT, parser: str(a.actual) || null, evidence_refs: runRef },
        action: qualityAction,
      }));
      continue;
    }
    if (code === "line_count_shortfall") {
      out.push(({
        type: "line_count_shortfall", subject: "finding:LINE_COUNT_SHORTFALL", source: "extraction", severity: "critical", blocks: "approval",
        title: "Lines missing: the PO declares " + fmtNum(a.expected) + ", extraction returned " + fmtNum(a.actual),
        detail: str(a.detail) || "Extraction is incomplete.",
        payload: { subject: { kind: "finding", code }, code, field: "lines", po_value: num(a.expected), extracted_value: num(a.actual), evidence_refs: runRef },
        action: { tab: "why", label: "Re-run extraction, or resolve on the Why tab (an approver clears it)" },
      }));
      continue;
    }
    add(code, a.severity, { line_index: lineIndexOf(a), field: str(a.path || a.field) || null, detail: str(a.detail || a.message) || null }, "anomaly");
  }
  for (const v of arr(run?.validator_issues)) {
    if (!v || typeof v !== "object") continue;
    add(str(v.code) || "issue", v.severity, { line_index: lineIndexOf(v), field: str(v.field) || null, detail: str(v.message) || null }, "validator");
  }
  for (const g of groups.values()) {
    const lineIdx = [...new Set(g.items.map((it) => it.line_index).filter((x) => x != null))].sort((a, b) => a - b);
    const first = g.items.find((it) => it.detail);
    const where = lineIdx.length
      ? " on " + (lineIdx.length === 1 ? "line " : "lines ") + lineIdx.slice(0, 8).map((i) => i + 1).join(", ") + (lineIdx.length > 8 ? ", +" + (lineIdx.length - 8) + " more" : "")
      : (g.items[0]?.field ? " on " + g.items[0].field : "");
    const fields = [...new Set(g.items.map((it) => it.field).filter(Boolean))].slice(0, 20);
    out.push(({
      type: "extraction_check:" + g.code, subject: "order", source: "extraction", severity: g.severity,
      title: words(g.code) + where,
      detail: (first?.detail || "Extraction " + [...g.kinds].join(" and ") + " check") + (g.items.length > 1 ? " (" + plural(g.items.length, "place") + ")" : ""),
      payload: {
        subject: lineIdx.length === 1 ? lineSubjectData(lines, lineIdx[0]) : ORDER_SUBJECT,
        code: g.code, line_indexes: lineIdx, field: fields[0] || null, fields, count: g.items.length,
        evidence_refs: [...runRef, ...(lineIdx.length ? lineEvidenceRefs(order, lineIdx[0]) : [])],
      },
      action: lineIdx.length ? { ...lineAction(lineIdx[0], "The value"), control: "extraction_quality" } : qualityAction,
    }));
  }
  return out;
};

// ── the terms check ─────────────────────────────────────────────────────────

const OUTCOME_TEXT = {
  deviates: "differs from the quote",
  po_only: "only the PO states it",
  quote_only: "only the quote states it",
  unknown: "could not be compared",
  not_read: "PO terms not read",
};
const DIRECTION_TEXT = { against_us: "against us", for_us: "for us", neutral: "neutral" };

// terms: the view GET /api/orders/terms returns for this caller. A shadow
// check reaches here only for an admin who asked for it (the read path hides
// it from everyone else); its rows are marked shadow and never block.
// termsPolicy: the tenant's effective terms policy, when the caller has it,
// so a clause whose accept_requires names the manager action is reserved.
const termsRows = ({ terms, termsPolicy }) => {
  const out = [];
  if (!terms || !terms.visible) return out;
  const shadow = terms.shadow === true;
  for (const f of arr(terms.flags)) {
    if (!f || f.state !== "undecided") continue;
    const clause = str(f.clause);
    const notRead = f.outcome === "not_read";
    const severity = normSeverity(f.severity);
    const reserved = severity === "high" || severity === "critical"
      || termsPolicy?.clauses?.[clause]?.accept_requires === MANAGER_ACCEPT_ACTION;
    const subjectData = { kind: "terms_flag", flag_id: f.id || null, clause: clause || null };
    const refs = [
      ...(f.id ? [{ kind: "terms_flag", flag_id: f.id }] : []),
      ...(f.po?.page != null ? [{ kind: "po_document", document_id: f.po?.document_id || null, page: num(f.po.page), bbox_norm: Array.isArray(f.po?.bbox_norm) ? f.po.bbox_norm : null, field_path: "terms." + (f.id || clause) }] : []),
      ...(f.quote?.quote_number ? [{ kind: "quote", quote_number: f.quote.quote_number }] : []),
    ];
    out.push(({
      type: notRead ? "terms_not_read" : "terms_flag",
      issue: notRead ? "terms:not_read" : "clause:" + (clause || f.id),
      subject: notRead ? "order" : "clause:" + keyPart(clause || f.id),
      source: "terms", severity,
      blocks: !shadow && severity === "critical" ? "send" : null,
      shadow,
      title: (str(f.clause_label) || words(clause) || "PO terms") + ": " + (OUTCOME_TEXT[f.outcome] || words(f.outcome))
        + (f.direction && f.outcome === "deviates" ? ", " + (DIRECTION_TEXT[f.direction] || words(f.direction)) : ""),
      detail: [
        f.po?.text ? "PO “" + str(f.po.text) + "”" : null,
        f.quote?.text ? "quote “" + str(f.quote.text) + "”" + (f.quote.quote_number ? " (" + f.quote.quote_number + ")" : "") : null,
      ].filter(Boolean).join(" vs ") || str(f.rationale) || "Needs a decision.",
      payload: {
        subject: subjectData, field: clause || null, outcome: f.outcome || null, direction: f.direction || null,
        po_value: f.po?.text || null, quote_value: f.quote?.text || null, quote_number: f.quote?.quote_number || null,
        manager_only: reserved, allowed_decisions: arr(f.allowed), method: f.method || null,
        evidence_refs: refs,
      },
      action: { tab: "terms", target: f.id ? "terms." + f.id : null, label: "Decide on the Terms tab" },
    }));
  }
  // The check could not read the PO's terms at all. Said even when no flag
  // carries it, so "no flags" is never mistaken for "no deviations". A
  // not_read flag someone already decided keeps it decided.
  if (terms.check && terms.check.po_terms_status === "not_read") {
    const decidedFlag = arr(terms.flags).find((f) => f && f.outcome === "not_read" && f.state !== "undecided" && f.state !== "display");
    out.push(({
      type: "terms_not_read", issue: "terms:not_read", subject: "order", source: "terms", severity: "warn",
      shadow,
      title: "PO terms not read",
      detail: "The terms check found no terms text it could read on the PO, so no clause was compared.",
      payload: { subject: ORDER_SUBJECT, field: "terms", po_terms_status: "not_read", check_id: terms.check.id || null, evidence_refs: terms.check.id ? [{ kind: "terms_check", check_id: terms.check.id }] : [] },
      action: { tab: "terms", label: "Re-check terms on the Terms tab" },
      ...(decidedFlag ? { status: "decided", decided_note: "Decided on the Terms tab: " + words(decidedFlag.decision?.decision || decidedFlag.state) } : {}),
    }));
  }
  return out;
};

// clause -> { state, decision } for every flag in the view, so a reconcile
// verdict on a clause the terms check already decided is not asked again.
const termsClauseStates = (terms) => {
  const m = new Map();
  if (!terms || !terms.visible || terms.shadow) return m;
  for (const f of arr(terms.flags)) {
    if (!f || !f.clause) continue;
    const prev = m.get(f.clause);
    // Undecided wins: one open flag on the clause keeps it open.
    if (!prev || f.state === "undecided") m.set(f.clause, { state: f.state, decision: f.decision?.decision || null });
  }
  return m;
};

// ── merge, sort, split ──────────────────────────────────────────────────────

// The key: the type and the subject. Stable across re-reads of the same
// order, since both come from the order's content and never from a row id
// that a re-run replaces.
export const exceptionKey = (type, subject) => String(type) + "|" + String(subject || "order");

// Rows from different sources that describe one issue share an `issue`
// (the key when none is given). The winner keeps its type, title, action
// and status; the loser fills in only the payload fields the winner lacks.
// Status is the winner's alone: a resolved finding closes the reconcile's
// copy of the same blocker, and an open terms flag keeps a verdict open.
const mergeRows = (rows) => {
  const byIssue = new Map();
  for (const r of rows) {
    const issue = r.issue || exceptionKey(r.type, r.subject);
    const prev = byIssue.get(issue);
    if (!prev) { byIssue.set(issue, { ...r, sources: [r.source] }); continue; }
    const winner = (SOURCE_RANK[r.source] ?? 99) < (SOURCE_RANK[prev.source] ?? 99) ? r : prev;
    const loser = winner === r ? prev : r;
    const payload = { ...(loser.payload || {}) };
    for (const [k, v] of Object.entries(winner.payload || {})) if (v != null) payload[k] = v;
    const decided = winner.status === "decided";
    byIssue.set(issue, {
      ...winner,
      payload,
      severity: maxSeverity(prev.severity, r.severity),
      blocks: decided ? null : (winner.blocks || loser.blocks || null),
      sources: [...new Set([...(prev.sources || [prev.source]), r.source])],
    });
  }
  return [...byIssue.values()];
};

// Blockers are one issue per finding code, whichever source reported them.
const withIssues = (rows) => rows.map((r) => (r.subject && String(r.subject).startsWith("finding:") && !r.issue
  ? { ...r, issue: "blocker:" + r.subject }
  : r));

const orderRows = (rows) => rows
  .map((r, i) => ({ r, i }))
  .sort((a, b) => {
    const s = (SEVERITY_RANK[b.r.severity] ?? 0) - (SEVERITY_RANK[a.r.severity] ?? 0);
    if (s) return s;
    const src = (SOURCE_RANK[a.r.source] ?? 99) - (SOURCE_RANK[b.r.source] ?? 99);
    if (src) return src;
    const la = a.r.payload?.subject?.line_index ?? Infinity;
    const lb = b.r.payload?.subject?.line_index ?? Infinity;
    if (la !== lb) return la - lb;
    return a.r.key < b.r.key ? -1 : a.r.key > b.r.key ? 1 : a.i - b.i;
  })
  .map(({ r }) => r);

const finish = (r, policy) => {
  const row = {
    key: exceptionKey(r.type, r.subject),
    type: r.type,
    source: r.source,
    sources: r.sources || [r.source],
    severity: r.severity,
    blocks: r.blocks || null,
    shadow: r.shadow === true,
    status: r.status === "decided" ? "decided" : "open",
    ...(r.decided_note ? { decided_note: r.decided_note } : {}),
    title: r.title,
    detail: r.detail || "",
    payload: r.payload || { subject: ORDER_SUBJECT, evidence_refs: [] },
    action: r.action || null,
    resolution_options: resolutionOptionsFor(r.type),
  };
  row.agent_policy = agentPolicyFor(row, policy);
  return row;
};

const emptyCounts = () => ({
  open: 0, info: 0, decided: 0, blocking: 0,
  by_severity: Object.fromEntries(SEVERITY_LEVELS.map((s) => [s, 0])),
  by_agent_policy: Object.fromEntries(AGENT_POLICIES.map((p) => [p, 0])),
});

// What the terms rows were built from, so a screen can say "terms not
// checked" rather than imply "no terms issues".
const termsState = (terms) => {
  if (!terms) return "unavailable";
  if (terms.mode === "off") return "off";
  if (terms.hidden || !terms.visible) return "hidden";
  return terms.shadow ? "shadow" : "on";
};

// inputs:
//   order          the orders row (result, rule_findings, anomaly_flags,
//                  preflight_payload, status, customer_id, vendor_code, ...)
//   customer       the customers row (customer_name, gstin, state_code) or null
//   vendorCodes    the vendor codes this customer uses for us
//   extractionRun  the extraction_runs row the order was read by, or null
//   terms          the terms view this caller may see (GET /api/orders/terms),
//                  or null when the check is not installed
//   termsPolicy    the tenant's effective terms policy, or null
//   agentPolicy    resolveAgentPolicy(tenant override); the defaults when null
//
// Returns the response GET /api/orders/exceptions sends, version 1:
//   { version, order_id, status, rows, info, decided, counts, clean,
//     customer_match, terms_state, agent_policy }
export const buildOrderExceptions = ({
  order = null, customer = null, vendorCodes = [], extractionRun = null, terms = null, termsPolicy = null, agentPolicy = null,
} = {}) => {
  const policy = agentPolicy ? resolveAgentPolicy(agentPolicy) : DEFAULT_AGENT_POLICY;
  const base = { version: EXCEPTIONS_VERSION, order_id: order?.id || null, status: order?.status || null, agent_policy: policy };
  if (!order || typeof order !== "object") {
    return { ...base, rows: [], info: [], decided: [], counts: emptyCounts(), clean: true, customer_match: null, terms_state: termsState(terms) };
  }
  const termsByClause = termsClauseStates(terms);
  const cust = customerRows({ order, customer, vendorCodes });
  const all = mergeRows(withIssues([
    ...termsRows({ terms, termsPolicy }),
    ...findingRows({ order }),
    ...reconciliationRows({ order, termsByClause, policy }),
    ...cust.rows,
    ...anomalyRows({ order }),
    ...extractionRows({ order, extractionRun }),
  ])).map((r) => finish(r, policy));
  const sorted = orderRows(all);
  const rows = sorted.filter((r) => r.status === "open" && r.severity !== "info");
  const info = sorted.filter((r) => r.status === "open" && r.severity === "info");
  const decided = sorted.filter((r) => r.status === "decided");
  const counts = emptyCounts();
  for (const r of rows) {
    counts.by_severity[r.severity] += 1;
    counts.by_agent_policy[r.agent_policy] += 1;
  }
  counts.open = rows.length;
  counts.info = info.length;
  counts.decided = decided.length;
  counts.blocking = rows.filter((r) => r.blocks && !r.shadow).length;
  return {
    ...base,
    rows, info, decided, counts,
    clean: rows.length === 0,
    customer_match: cust.match,
    terms_state: termsState(terms),
  };
};

// The grid rows any open exception points at, for a screen that collapses
// the grid when no line needs a look.
export const lineExceptionIndexes = (result) => {
  const out = new Set();
  for (const r of arr(result?.rows)) {
    const p = r.payload || {};
    if (num(p.subject?.line_index) != null) out.add(Number(p.subject.line_index));
    for (const i of arr(p.line_indexes)) if (num(i) != null) out.add(Number(i));
  }
  return out;
};

// The open rows that stop the order:
//   send      should not be sent for approval with it open
//   approval  the server refuses approval until an approver clears it
export const blockingRows = (result) => {
  const rows = arr(result?.rows).filter((r) => r.blocks && !r.shadow);
  return { send: rows.filter((r) => r.blocks === "send"), approval: rows.filter((r) => r.blocks === "approval") };
};
