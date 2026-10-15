// The one exceptions list (plan PR 9): _lib/order-exceptions.js, the pure
// builder behind GET /api/orders/exceptions and the workspace's "Needs
// decision" card. One test per source, the dedupe, the agent-ready hooks
// (types, keys, payloads, resolution options, the agent policy) and the
// response version. Every name, number and part is invented.

import { describe, it, expect } from "vitest";
import {
  buildOrderExceptions, customerMatchBasis, EXCEPTION_TYPES, RESOLUTION_OPTIONS, SOURCES, typeSpec,
  resolutionOptionsFor, agentPolicyFor, DEFAULT_AGENT_POLICY, resolveAgentPolicy, exceedsMoneyTolerance,
  EXCEPTIONS_VERSION, MANAGER_ACCEPT_ACTION, lineExceptionIndexes, blockingRows, AGENT_POLICIES,
} from "../api/_lib/order-exceptions.js";
import { ACCEPT_HIGH_ACTION } from "../api/_lib/terms/compare.js";

const VALIDATED = { source_document_id: "doc-1", extraction_run_id: "run-1", last_validated_at: "2026-10-10T00:00:00Z" };

// A clean order: lines, a customer, the rules run, nothing flagged.
const cleanOrder = (over = {}) => ({
  id: "ord-1", status: "DRAFT", customer_id: "cust-1", po_number: "PO-FX-1",
  preflight_payload: { ...VALIDATED },
  rule_findings: [], anomaly_flags: [],
  result: {
    salesOrder: {
      customer: { name: "Fixture Buyer Pvt Ltd", gstin: "27AAACF0000A1Z5", state_code: "27" },
      lineItems: [
        { partNumber: "FX-100", qty: 10, rate: 50, _match: { verdict: "matched", part_no: "FX-100" } },
        { partNumber: "FX-200", qty: 4, rate: 75, _match: { verdict: "matched", part_no: "FX-200" } },
      ],
    },
    quoteReconciliation: { summary: { total: 2, matched: 2 }, flags: [], quoted_not_ordered: [] },
  },
  ...over,
});
const master = { id: "cust-1", customer_name: "Fixture Buyer", gstin: "27AAACF0000A1Z5", state_code: "27" };

const withLines = (lines, recon = {}) => cleanOrder({
  result: {
    salesOrder: { customer: { name: "Fixture Buyer", gstin: "27AAACF0000A1Z5", state_code: "27" }, lineItems: lines },
    quoteReconciliation: { summary: {}, flags: [], quoted_not_ordered: [], ...recon },
  },
});

const types = (out) => out.rows.map((r) => r.type);
const byType = (out, t) => [...out.rows, ...out.info, ...out.decided].find((r) => r.type === t);

describe("a clean order", () => {
  it("has no open rows, says so, and carries version 1", () => {
    const out = buildOrderExceptions({ order: cleanOrder(), customer: master });
    expect(out.version).toBe(EXCEPTIONS_VERSION);
    expect(out.version).toBe(1);
    expect(out.order_id).toBe("ord-1");
    expect(out.rows).toEqual([]);
    expect(out.clean).toBe(true);
    expect(out.counts).toMatchObject({ open: 0, blocking: 0 });
    expect(out.customer_match).toMatchObject({ basis: "gstin", label: "matched by GSTIN" });
  });
});

describe("source: the quote reconciliation", () => {
  const order = withLines([
    { partNumber: "FX-100", qty: 100, rate: 1840, line_no: 10, _evidence: { page: 2, bbox_norm: [0.1, 0.2, 0.9, 0.25] }, _match: { verdict: "price_mismatch", part_no: "FX-100" } },
    { partNumber: "FX-200", qty: 5, rate: 10, _match: { verdict: "matched", part_no: "FX-200", qty_note: true, po_qty: 5, quote_qty: 4, source_quote_number: "Q-FX-1" } },
    { partNumber: "FX-300", qty: 1, rate: 10, _match: { verdict: "description_mismatch", part_no: "FX-300" } },
    { partNumber: "FX-400", qty: 1, rate: 10, _match: { verdict: "unmatched", part_no: "FX-400" } },
  ], {
    flags: [
      { line_no: 10, part_no: "FX-100", verdict: "price_mismatch", po_rate: 1840, quote_rate: 1750, price_delta_pct: 5.14, po_qty: 100, source_quote_number: "Q-FX-1" },
      { part_no: "FX-300", verdict: "description_mismatch", po_description: "BOLT M8", quote_description: "BOLT M10" },
      { part_no: "FX-400", verdict: "unmatched" },
      { part_no: null, verdict: "payment_terms_mismatch" },
    ],
    payment_terms: { verdict: "mismatch", po_terms: "90 days from GRN", quote_terms: "30 days from invoice", source_quote_number: "Q-FX-1" },
    incoterms: { verdict: "mismatch", po_incoterm: "CIF Chennai", quote_incoterm: "FOB Busan", source_quote_number: "Q-FX-1" },
    quoted_not_ordered: [{ part_no: "FX-900", source_quote_number: "Q-FX-1" }],
  });
  const out = buildOrderExceptions({ order, customer: master });

  it("a price difference: the line, both rates, the amount, and the rate cell", () => {
    const r = byType(out, "line_price_mismatch");
    expect(r.title).toBe("L1 FX-100: price differs from the quote");
    expect(r.detail).toBe("PO 1,840 vs quote 1,750 (+5.14%) = +9,000 on 100 · Q-FX-1");
    expect(r.payload).toMatchObject({
      subject: { kind: "line", line_index: 0, line_number: 1, line_no: 10, part_no: "FX-100" },
      field: "rate", po_value: 1840, quote_value: 1750, delta_pct: 5.14, qty: 100, amount: 9000, quote_number: "Q-FX-1",
    });
    expect(r.payload.evidence_refs).toEqual([
      { kind: "po_document", document_id: "doc-1", page: 2, bbox_norm: [0.1, 0.2, 0.9, 0.25], field_path: "lines[0]" },
      { kind: "quote", quote_number: "Q-FX-1" },
    ]);
    expect(r.action).toEqual({ tab: "recon", target: "lines[0]", label: "The rate on line 1 in the line grid" });
    // 5.14% is above the 2% tolerance: a person's decision.
    expect(r.severity).toBe("high");
    expect(r.agent_policy).toBe("human_only");
  });

  it("a quantity difference, read off a matched line", () => {
    const r = byType(out, "line_qty_mismatch");
    expect(r.title).toBe("L2 FX-200: quantity differs from the quote");
    expect(r.payload).toMatchObject({ field: "qty", po_value: 5, quote_value: 4, subject: { line_index: 1 } });
  });

  it("a description difference and an unmatched line", () => {
    expect(byType(out, "line_description_mismatch").detail).toBe("PO “BOLT M8” vs quote “BOLT M10”");
    const u = byType(out, "line_unmatched");
    expect(u.title).toBe("L4 FX-400: no quote covers this line");
    expect(u.action.target).toBe("lines[3]");
  });

  it("payment terms and incoterm at the header", () => {
    expect(byType(out, "payment_terms_mismatch")).toMatchObject({
      severity: "high", detail: "PO “90 days from GRN” vs quote “30 days from invoice” (Q-FX-1)",
      payload: { field: "payment_terms", po_value: "90 days from GRN", quote_value: "30 days from invoice" },
    });
    expect(byType(out, "incoterm_mismatch")).toMatchObject({
      detail: "PO “CIF Chennai” vs quote “FOB Busan” (Q-FX-1)",
      action: { tab: "header" },
    });
  });

  it("quoted lines not on the PO are listed for information, with the control that adds them", () => {
    const r = byType(out, "quoted_not_ordered");
    expect(out.info).toContain(r);
    expect(r.title).toBe("1 quoted line is not on this PO");
    expect(r.action.control).toBe("quoted_only");
  });
});

describe("every item the quote-check banner listed is in the list", () => {
  it("each line flag (beyond ten), an unknown verdict, and each incoterm verdict", () => {
    const lines = [];
    const flags = [];
    for (let i = 0; i < 12; i++) {
      lines.push({ partNumber: "UM-" + i, qty: 1, rate: 1, _match: { verdict: "unmatched", part_no: "UM-" + i } });
      flags.push({ part_no: "UM-" + i, verdict: "unmatched" });
    }
    lines.push({ partNumber: "ODD-1", qty: 1, rate: 1, _match: { verdict: "uom_mismatch", part_no: "ODD-1" } });
    flags.push({ part_no: "ODD-1", verdict: "uom_mismatch" });
    for (const verdict of ["place_differs", "quote_missing"]) {
      const out = buildOrderExceptions({
        order: withLines(lines, { flags, incoterms: { verdict, po_incoterm: "FOB Chennai", po_code: "FOB", po_place: "Chennai", quote_place: "Ennore", source_quote_number: "Q-2" } }),
        customer: master,
      });
      const all = [...out.rows, ...out.info];
      expect(all.filter((r) => r.type === "line_unmatched")).toHaveLength(12);
      expect(all.find((r) => r.type === "line_reconcile_other")).toMatchObject({ title: "L13 ODD-1: uom mismatch", detail: "uom mismatch: ODD-1" });
      if (verdict === "place_differs") {
        expect(byType(out, "incoterm_place_differs").detail).toBe("Both FOB, but PO “Chennai” vs quote “Ennore”");
      } else {
        // Not a discrepancy, so information, not a decision.
        expect(out.info.find((r) => r.type === "incoterm_unconfirmed").detail).toBe("PO “FOB Chennai”, the quote has no incoterm (Q-2)");
      }
    }
  });
});

describe("source: findings", () => {
  it("an unresolved blocker blocks approval; a resolved one is kept as decided", () => {
    const open = buildOrderExceptions({ order: cleanOrder({ rule_findings: [{ code: "custom_hold", blocks: true, severity: "ERROR", detail: "Held by the fixture." }] }), customer: master });
    expect(open.rows[0]).toMatchObject({ type: "blocking_finding", severity: "critical", blocks: "approval", title: "Blocks approval: custom hold", agent_policy: "human_only" });
    expect(blockingRows(open).approval).toHaveLength(1);
    const resolved = buildOrderExceptions({ order: cleanOrder({ rule_findings: [{ code: "custom_hold", blocks: true, resolved: true, resolution_note: "Checked with design." }] }), customer: master });
    expect(resolved.rows).toEqual([]);
    expect(resolved.decided[0]).toMatchObject({ type: "blocking_finding", status: "decided", decided_note: "Resolved: Checked with design.", blocks: null });
  });

  it("a recorded non-blocking finding on a line points at that line", () => {
    const out = buildOrderExceptions({ order: cleanOrder({ rule_findings: [{ code: "hsn_missing", severity: "WARNING", line_index: 1, detail: "No HSN on the line." }] }), customer: master });
    expect(out.rows[0]).toMatchObject({ type: "finding:hsn_missing", severity: "warn", title: "L2: hsn missing", action: { target: "lines[1]" } });
  });
});

describe("source: the anomaly rules", () => {
  it("a rule flag from run validation, on a line", () => {
    const out = buildOrderExceptions({
      order: cleanOrder({ rule_findings: [{ key: "duplicate_line", lineIndex: 1, severity: "medium", label: "Duplicate line", detail: "Lines 1 and 2 match on part/uom/rate" }] }),
      customer: master,
    });
    expect(out.rows[0]).toMatchObject({
      type: "anomaly:duplicate_line", source: "anomaly", severity: "warn", title: "L2: Duplicate line",
      detail: "Lines 1 and 2 match on part/uom/rate", action: { target: "lines[1]" },
    });
  });

  it("the rules never ran: one row whose action is the existing run-validation control", () => {
    const order = cleanOrder({ preflight_payload: { source_document_id: "doc-1" } });
    const out = buildOrderExceptions({ order, customer: master });
    const r = byType(out, "anomaly_check_not_run");
    expect(r).toMatchObject({ title: "Anomaly check not run", action: { control: "run_validation", label: "Run anomaly check" }, agent_policy: "apply" });
    expect(r.resolution_options).toEqual([
      { option: "run_check", label: "Run the check again", applies_via: expect.objectContaining({ kind: "endpoint", method: "POST", path: "/api/anomaly/compute", control: "Header: run validation" }) },
    ]);
    // Not asked of an approved order, nor of one with no lines.
    expect(types(buildOrderExceptions({ order: { ...order, status: "APPROVED" }, customer: master }))).not.toContain("anomaly_check_not_run");
  });
});

describe("source: the extraction run", () => {
  it("no lines: run extraction", () => {
    const out = buildOrderExceptions({ order: withLines([]), customer: master, extractionRun: { id: "run-1", status: "failed" } });
    expect(byType(out, "extraction_no_lines")).toMatchObject({ severity: "high", detail: "The last run ended failed. Run extraction again, or try another engine.", action: { control: "run_extraction" } });
  });

  it("low confidence, the fallback parser, and a check grouped by code", () => {
    const out = buildOrderExceptions({
      order: cleanOrder(), customer: master,
      extractionRun: {
        id: "run-1", status: "low_confidence", confidence_overall: 0.62, adapter_used: "llamaparse",
        anomalies: [
          { code: "llm_unavailable_fallback_parse", severity: "warn", actual: "llamaparse" },
          { code: "unit_price_zero", severity: "warn", line_index: 0, detail: "Rate is zero." },
        ],
        validator_issues: [{ code: "unit_price_zero", severity: "warn", field: "lines[1].unit_price", message: "Rate is zero." }],
      },
    });
    expect(byType(out, "extraction_low_confidence")).toMatchObject({ title: "Low extraction confidence (62%)", detail: "Check the lines against the PO; read by llamaparse." });
    expect(byType(out, "extraction_fallback_parse").title).toBe("Read by the fallback parser");
    const grouped = out.rows.filter((r) => r.type === "extraction_check:unit_price_zero");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ title: "unit price zero on lines 1, 2", payload: { line_indexes: [0, 1], count: 2 } });
  });
});

const termsView = (flags, over = {}) => ({
  mode: "on", shadow: false, visible: true,
  check: { id: "chk-1", po_terms_status: "read" },
  flags, ...over,
});
const flag = (over) => ({
  id: "fl-1", clause: "ld_penalty", clause_label: "Liquidated damages", outcome: "po_only", severity: "warn",
  state: "undecided", po: { text: "LD at 1% per week.", page: 4 }, quote: null, allowed: ["accept", "request_amendment"], ...over,
});

describe("source: the terms check", () => {
  it("undecided flags only, with the Terms tab as the action", () => {
    const out = buildOrderExceptions({
      order: cleanOrder(), customer: master,
      terms: termsView([flag({}), flag({ id: "fl-2", clause: "warranty", clause_label: "Warranty", state: "decided" })]),
    });
    const t = out.rows.filter((r) => r.type === "terms_flag");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({
      title: "Liquidated damages: only the PO states it", detail: "PO “LD at 1% per week.”",
      action: { tab: "terms", target: "terms.fl-1" },
      payload: { subject: { kind: "terms_flag", flag_id: "fl-1", clause: "ld_penalty" }, allowed_decisions: ["accept", "request_amendment"] },
    });
  });

  it("an undecided critical flag blocks sending", () => {
    const out = buildOrderExceptions({ order: cleanOrder(), customer: master, terms: termsView([flag({ severity: "critical" })]) });
    expect(out.rows[0]).toMatchObject({ blocks: "send", agent_policy: "human_only" });
    expect(blockingRows(out).send).toHaveLength(1);
  });

  it("PO terms not read is said, even with no flag", () => {
    const out = buildOrderExceptions({ order: cleanOrder(), customer: master, terms: termsView([], { check: { id: "chk-1", po_terms_status: "not_read" } }) });
    expect(byType(out, "terms_not_read")).toMatchObject({ title: "PO terms not read", agent_policy: "apply", action: { tab: "terms" } });
  });

  it("a shadow check's rows are marked shadow and never block", () => {
    const out = buildOrderExceptions({ order: cleanOrder(), customer: master, terms: termsView([flag({ severity: "critical" })], { mode: "shadow", shadow: true }) });
    expect(out.rows[0]).toMatchObject({ shadow: true, blocks: null, agent_policy: "human_only" });
    expect(out.terms_state).toBe("shadow");
  });

  it("a hidden view (shadow, engineer) gives no terms rows", () => {
    const out = buildOrderExceptions({ order: cleanOrder(), customer: master, terms: { mode: "shadow", shadow: true, visible: false, hidden: true, flags: [] } });
    expect(out.rows).toEqual([]);
    expect(out.terms_state).toBe("hidden");
  });
});

describe("source: the customer match", () => {
  it("the basis, strongest first", () => {
    const order = cleanOrder();
    expect(customerMatchBasis({ order, customer: master }).basis).toBe("gstin");
    expect(customerMatchBasis({ order, customer: { ...master, gstin: "29AAACF0000A1Z5" } }).basis).toBe("gstin_conflict");
    const noGstin = cleanOrder({ vendor_code: "VX-7", result: { salesOrder: { customer: { name: "Somebody Else" }, lineItems: [] } } });
    expect(customerMatchBasis({ order: noGstin, customer: { ...master, gstin: null }, vendorCodes: ["VX-7"] }).basis).toBe("vendor_code");
    const byName = cleanOrder({ result: { salesOrder: { customer: { name: "M/s. Fixture Buyer Pvt. Ltd." }, lineItems: [] } } });
    expect(customerMatchBasis({ order: byName, customer: { ...master, gstin: null } }).basis).toBe("name");
    expect(customerMatchBasis({ order: noGstin, customer: { ...master, gstin: null } }).basis).toBe("unverified");
    expect(customerMatchBasis({ order: cleanOrder({ customer_id: null }), customer: null }).basis).toBe("none");
  });

  it("no customer, a GSTIN conflict, an unconfirmed match, a different state", () => {
    expect(byType(buildOrderExceptions({ order: cleanOrder({ customer_id: null }) }), "customer_unmatched")).toMatchObject({ severity: "high", action: { href: "#/so?new=1" } });
    expect(byType(buildOrderExceptions({ order: cleanOrder(), customer: { ...master, gstin: "29AAACF0000A1Z5" } }), "customer_gstin_conflict").detail)
      .toBe("PO 27AAACF0000A1Z5 vs master 29AAACF0000A1Z5 (Fixture Buyer)");
    const other = cleanOrder({ result: { salesOrder: { customer: { name: "Somebody Else", state_code: "29" }, lineItems: cleanOrder().result.salesOrder.lineItems } } });
    const out = buildOrderExceptions({ order: other, customer: { ...master, gstin: null } });
    expect(byType(out, "customer_low_confidence").title).toBe("Customer not confirmed by the PO");
    expect(byType(out, "customer_state_differs").detail).toMatch(/^PO state code 29 vs master 27\./);
  });
});

describe("the same issue from two sources shows once", () => {
  it("payment terms: the reconcile verdict and the terms flag are one row, the terms flag's", () => {
    const order = withLines(cleanOrder().result.salesOrder.lineItems, {
      flags: [{ verdict: "payment_terms_mismatch" }],
      payment_terms: { verdict: "mismatch", po_terms: "90 days", quote_terms: "30 days" },
    });
    const out = buildOrderExceptions({ order, customer: master, terms: termsView([flag({ id: "fl-pt", clause: "payment_terms", clause_label: "Payment terms", outcome: "deviates", severity: "warn" })]) });
    const rows = out.rows.filter((r) => r.payload.field === "payment_terms");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "terms_flag", source: "terms", sources: ["terms", "reconciliation"], severity: "high" });
  });

  it("a terms flag already decided closes the reconcile's copy as decided", () => {
    const order = withLines(cleanOrder().result.salesOrder.lineItems, { payment_terms: { verdict: "mismatch", po_terms: "90 days", quote_terms: "30 days" } });
    const out = buildOrderExceptions({ order, customer: master, terms: termsView([flag({ clause: "payment_terms", state: "decided", decision: { decision: "accept" } })]) });
    expect(out.rows.filter((r) => r.type === "payment_terms_mismatch")).toEqual([]);
    expect(out.decided.find((r) => r.type === "payment_terms_mismatch").decided_note).toBe("Decided on the Terms tab: accept");
  });

  it("the -MOD blocker: the finding and the reconcile's mod_bom are one row", () => {
    const order = withLines(cleanOrder().result.salesOrder.lineItems, { mod_bom: { is_modification_quote: true, pending_parts: ["GN-1-MOD"] } });
    order.rule_findings = [{ code: "mod_quote_bom_pending", blocks: true, severity: "ERROR", detail: "1 quoted part still provisional (-MOD): GN-1-MOD.", pending_parts: ["GN-1-MOD"] }];
    const out = buildOrderExceptions({ order, customer: master });
    const mod = out.rows.filter((r) => r.type === "mod_bom_pending");
    expect(mod).toHaveLength(1);
    expect(mod[0]).toMatchObject({ source: "finding", sources: ["finding", "reconciliation"], blocks: "approval" });
    // Resolved on the Why tab: the reconcile's copy closes with it.
    order.rule_findings[0].resolved = true;
    const after = buildOrderExceptions({ order, customer: master });
    expect(after.rows.filter((r) => r.type === "mod_bom_pending")).toEqual([]);
    expect(after.decided.filter((r) => r.type === "mod_bom_pending")).toHaveLength(1);
  });

  it("a line-count shortfall: the extraction anomaly and the finding are one row", () => {
    const order = cleanOrder({ rule_findings: [{ code: "line_count_shortfall", blocks: true, severity: "ERROR", source: "extraction", expected: 12, actual: 2 }] });
    const run = { id: "run-1", status: "ok", anomalies: [{ code: "line_count_shortfall", severity: "error", expected: 12, actual: 2 }] };
    const rows = buildOrderExceptions({ order, customer: master, extractionRun: run }).rows.filter((r) => r.type === "line_count_shortfall");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "finding", sources: ["finding", "extraction"], title: "Lines missing: the PO declares 12, extraction returned 2" });
  });

  it("an anomaly rule stored in rule_findings and in anomaly_flags is one row", () => {
    const f = { key: "round_number_rate", lineIndex: 0, severity: "low", label: "Round rate" };
    const out = buildOrderExceptions({ order: cleanOrder({ rule_findings: [f], anomaly_flags: [f] }), customer: master });
    expect(out.info.filter((r) => r.type === "anomaly:round_number_rate")).toHaveLength(1);
  });
});

describe("keys are stable", () => {
  const messy = () => {
    const o = withLines([
      { partNumber: "FX-100", line_no: 10, qty: 100, rate: 1840, _match: { verdict: "price_mismatch", part_no: "FX-100" } },
      { partNumber: "FX-400", qty: 1, rate: 10, _match: { verdict: "unmatched", part_no: "FX-400" } },
    ], {
      flags: [
        { line_no: 10, part_no: "FX-100", verdict: "price_mismatch", po_rate: 1840, quote_rate: 1800, price_delta_pct: 2.2, po_qty: 100 },
        { part_no: "FX-400", verdict: "unmatched" },
      ],
    });
    o.rule_findings = [{ code: "custom_hold", blocks: true }, { key: "duplicate_line", lineIndex: 1, severity: "medium" }];
    return o;
  };

  it("the same order read twice gives the same keys", () => {
    const a = buildOrderExceptions({ order: messy(), customer: master, terms: termsView([flag({})]) });
    const b = buildOrderExceptions({ order: JSON.parse(JSON.stringify(messy())), customer: { ...master }, terms: termsView([flag({})]) });
    expect(a.rows.map((r) => r.key)).toEqual(b.rows.map((r) => r.key));
    expect(a.rows.map((r) => r.key)).toContain("line_price_mismatch|line:n10:FX-100");
  });

  it("reordered sources and a re-run terms check (new flag ids) keep every key", () => {
    const a = buildOrderExceptions({ order: messy(), customer: master, terms: termsView([flag({ id: "fl-old" })]) });
    const o = messy();
    o.rule_findings.reverse();
    o.result.quoteReconciliation.flags.reverse();
    const b = buildOrderExceptions({ order: o, customer: master, terms: termsView([flag({ id: "fl-new-after-recheck" })]) });
    expect(new Set(b.rows.map((r) => r.key))).toEqual(new Set(a.rows.map((r) => r.key)));
    expect(b.rows.find((r) => r.type === "terms_flag").key).toBe("terms_flag|clause:LD_PENALTY");
  });

  it("every key is unique within one list", () => {
    const out = buildOrderExceptions({ order: messy(), customer: master });
    const keys = [...out.rows, ...out.info, ...out.decided].map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the type enum", () => {
  it("covers every source", () => {
    const covered = new Set(Object.values(EXCEPTION_TYPES).map((t) => t.source));
    for (const s of SOURCES) expect(covered.has(s)).toBe(true);
    expect([...covered].sort()).toEqual([...SOURCES].sort());
  });

  it("every row a busy order produces has a type in the enum", () => {
    const order = withLines([
      { partNumber: "FX-100", qty: 1, rate: 1, _match: { verdict: "price_mismatch", part_no: "FX-100" } },
    ], { flags: [{ part_no: "FX-100", verdict: "price_mismatch", po_rate: 1, quote_rate: 2, price_delta_pct: -50, po_qty: 1 }], quoted_not_ordered: [{ part_no: "Z" }], mod_bom: { is_modification_quote: true, pending_parts: ["A-MOD"] } });
    order.rule_findings = [{ code: "x_rule", severity: "WARNING" }, { key: "grand_total", severity: "high" }];
    order.anomaly_flags = [{ key: "line_count", severity: "low" }];
    order.preflight_payload = { source_document_id: "d" };
    const out = buildOrderExceptions({
      order, customer: { ...master, gstin: "29X", state_code: "29" },
      extractionRun: { id: "r", status: "failed", confidence_overall: 0.4, anomalies: [{ code: "qty_zero", severity: "warn" }, { code: "llm_unavailable_fallback_parse" }] },
      terms: termsView([flag({})], { check: { id: "c", po_terms_status: "not_read" } }),
    });
    const all = [...out.rows, ...out.info, ...out.decided];
    expect(all.length).toBeGreaterThan(10);
    for (const r of all) {
      expect(typeSpec(r.type), r.type).toBeTruthy();
      expect(SOURCES).toContain(r.source);
      expect(r.key.startsWith(r.type + "|")).toBe(true);
      expect(AGENT_POLICIES).toContain(r.agent_policy);
    }
    const sources = new Set(all.flatMap((r) => r.sources));
    for (const s of ["terms", "finding", "reconciliation", "customer", "anomaly", "extraction"]) expect(sources.has(s)).toBe(true);
  });
});

describe("resolution options", () => {
  it("every type has a fixed list, each option named in the vocabulary and applied by an endpoint or marked not available yet", () => {
    for (const [type, spec] of Object.entries(EXCEPTION_TYPES)) {
      expect(spec.options.length, type).toBeGreaterThan(0);
      for (const o of spec.options) {
        expect(RESOLUTION_OPTIONS[o.option], type + " " + o.option).toBeTruthy();
        if (o.applies_via.kind === "endpoint") {
          expect(o.applies_via.method).toMatch(/^(GET|POST|PATCH)$/);
          expect(o.applies_via.path).toMatch(/^\/api\//);
          expect(o.applies_via.control.length).toBeGreaterThan(0);
        } else {
          expect(o.applies_via.kind).toBe("not_available_yet");
          expect(o.applies_via.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("per type: what applies today", () => {
    const opts = (t) => Object.fromEntries(resolutionOptionsFor(t).map((o) => [o.option, o.applies_via]));
    expect(Object.keys(opts("line_price_mismatch"))).toEqual(["accept_po_value", "accept_quote_value", "request_amendment", "set_value"]);
    expect(opts("line_price_mismatch").accept_quote_value).toMatchObject({ kind: "endpoint", method: "PATCH", path: "/api/orders/{order_id}", body: "result.salesOrder.lineItems[{line_index}].rate" });
    expect(opts("line_price_mismatch").accept_po_value.kind).toBe("not_available_yet");
    expect(opts("terms_flag").request_amendment).toMatchObject({ kind: "endpoint", method: "POST", path: "/api/orders/terms_decide" });
    expect(opts("terms_not_read").run_check).toMatchObject({ path: "/api/orders/terms_check" });
    expect(opts("mod_bom_pending").confirm).toMatchObject({ path: "/api/orders/{order_id}", permission: "approve" });
    expect(opts("customer_unmatched").change_customer.kind).toBe("not_available_yet");
    expect(opts("anomaly:rate_10x_jump").run_check).toMatchObject({ path: "/api/anomaly/compute" });
    expect(resolutionOptionsFor("no_such_type")).toEqual([]);
  });

  it("each row carries its type's options", () => {
    const r = buildOrderExceptions({ order: cleanOrder({ preflight_payload: { source_document_id: "d" } }), customer: master }).rows[0];
    expect(r.resolution_options).toEqual(resolutionOptionsFor(r.type));
  });
});

describe("the agent policy", () => {
  const row = (over) => ({ type: "line_qty_mismatch", severity: "warn", blocks: null, shadow: false, payload: {}, ...over });

  it("the defaults are data", () => {
    expect(DEFAULT_AGENT_POLICY).toMatchObject({
      human_only_severities: ["high", "critical"],
      money_tolerance: { pct: 2, amount: 10000 },
      manager_terms_severities: ["high", "critical"],
      apply_types: ["anomaly_check_not_run", "terms_not_read"],
      otherwise: "propose",
    });
    expect(AGENT_POLICIES).toEqual(["propose", "apply", "human_only"]);
  });

  it("high and critical are human_only", () => {
    expect(agentPolicyFor(row({ severity: "high" }))).toBe("human_only");
    expect(agentPolicyFor(row({ severity: "critical" }))).toBe("human_only");
    expect(agentPolicyFor(row({ severity: "warn" }))).toBe("propose");
    expect(agentPolicyFor(row({ severity: "info" }))).toBe("propose");
  });

  it("a money deviation above the tolerance is human_only, even at warn", () => {
    expect(agentPolicyFor(row({ payload: { delta_pct: 2.5 } }))).toBe("human_only");
    expect(agentPolicyFor(row({ payload: { delta_pct: -2.01 } }))).toBe("human_only");
    expect(agentPolicyFor(row({ payload: { amount: 10001 } }))).toBe("human_only");
    expect(agentPolicyFor(row({ payload: { delta_pct: 2, amount: 10000 } }))).toBe("propose");
    expect(exceedsMoneyTolerance({ delta_pct: 1.9, amount: -500 })).toBe(false);
  });

  it("a terms flag reserved for a manager is human_only", () => {
    expect(agentPolicyFor(row({ type: "terms_flag", severity: "warn", payload: { manager_only: true } }))).toBe("human_only");
    expect(agentPolicyFor(row({ type: "terms_flag", severity: "warn", payload: {} }))).toBe("propose");
    expect(agentPolicyFor(row({ type: "terms_flag", severity: "high" }), resolveAgentPolicy({ human_only_severities: [] }))).toBe("human_only");
    // A clause whose tenant policy needs the manager action is reserved.
    const out = buildOrderExceptions({
      order: cleanOrder(), customer: master, terms: termsView([flag({ clause: "warranty", severity: "warn" })]),
      termsPolicy: { clauses: { warranty: { accept_requires: MANAGER_ACCEPT_ACTION } } },
    });
    expect(out.rows[0]).toMatchObject({ payload: { manager_only: true }, agent_policy: "human_only" });
    expect(MANAGER_ACCEPT_ACTION).toBe(ACCEPT_HIGH_ACTION);
  });

  it("apply only for housekeeping types; shadow and blocking rows are human_only", () => {
    expect(agentPolicyFor(row({ type: "anomaly_check_not_run" }))).toBe("apply");
    expect(agentPolicyFor(row({ type: "terms_not_read" }))).toBe("apply");
    expect(agentPolicyFor(row({ type: "anomaly_check_not_run", severity: "high" }))).toBe("human_only");
    expect(agentPolicyFor(row({ shadow: true }))).toBe("human_only");
    expect(agentPolicyFor(row({ blocks: "send" }))).toBe("human_only");
    expect(agentPolicyFor(null)).toBe("human_only");
  });

  it("a tenant override replaces a default key by key; a bad value never loosens", () => {
    const p = resolveAgentPolicy({ money_tolerance: { pct: 5 }, apply_types: [], otherwise: "apply" });
    expect(p.money_tolerance).toEqual({ pct: 5, amount: 10000 });
    expect(p.apply_types).toEqual([]);
    expect(p.otherwise).toBe("propose");
    expect(agentPolicyFor(row({ payload: { delta_pct: 4 } }), p)).toBe("propose");
    expect(agentPolicyFor(row({ type: "anomaly_check_not_run" }), p)).toBe("propose");
    expect(resolveAgentPolicy({ human_only_severities: "high" }).human_only_severities).toEqual(["high", "critical"]);
    expect(resolveAgentPolicy({ otherwise: "human_only" }).otherwise).toBe("human_only");
  });

  it("the policy in force is returned with the list, and a tenant override reaches the rows", () => {
    const order = withLines([{ partNumber: "FX-1", qty: 10, rate: 103, _match: { verdict: "price_mismatch", part_no: "FX-1" } }],
      { flags: [{ part_no: "FX-1", verdict: "price_mismatch", po_rate: 103, quote_rate: 100, price_delta_pct: 3, po_qty: 10 }] });
    const def = buildOrderExceptions({ order, customer: master });
    expect(def.agent_policy).toEqual(DEFAULT_AGENT_POLICY);
    expect(byType(def, "line_price_mismatch")).toMatchObject({ severity: "high", agent_policy: "human_only" });
    const loose = buildOrderExceptions({ order, customer: master, agentPolicy: { money_tolerance: { pct: 5 } } });
    expect(byType(loose, "line_price_mismatch")).toMatchObject({ severity: "warn", agent_policy: "propose" });
    expect(loose.counts.by_agent_policy).toMatchObject({ propose: 1 });
  });
});

describe("helpers for the screen", () => {
  it("the grid lines an open row points at", () => {
    const order = withLines([
      { partNumber: "A", qty: 1, rate: 1, _match: { verdict: "matched", part_no: "A" } },
      { partNumber: "B", qty: 1, rate: 1, _match: { verdict: "unmatched", part_no: "B" } },
    ], { flags: [{ part_no: "B", verdict: "unmatched" }] });
    expect([...lineExceptionIndexes(buildOrderExceptions({ order, customer: master }))]).toEqual([1]);
    expect([...lineExceptionIndexes(buildOrderExceptions({ order: cleanOrder(), customer: master }))]).toEqual([]);
  });

  it("never throws on odd input", () => {
    expect(buildOrderExceptions({}).rows).toEqual([]);
    const odd = buildOrderExceptions({ order: { id: "x", result: { quoteReconciliation: { flags: [null, 7, {}] } }, rule_findings: [null, "x"], anomaly_flags: "no" }, extractionRun: { anomalies: [null] } });
    expect(Array.isArray(odd.rows)).toBe(true);
  });
});
