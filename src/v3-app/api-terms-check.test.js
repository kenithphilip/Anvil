// The terms check endpoints and the reconcile trigger (plan PR 12):
// POST /api/orders/terms_check, GET /api/orders/terms, and the step at the end
// of the server-side quote reconcile.
//
// The REAL handlers, check, comparator, audit and reconcile run against an
// in-memory Supabase that applies the select lists. auth.js is real except
// resolveContext. The terms pass (plan PR 11, built separately) is a fixture
// in the shape docs/SO_TERMS_AND_HANDOFF_SCOPE.md sections 3, 4 and 9 define;
// with no pass, the check reads what extraction already gives. Every name,
// id and clause is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null, termsPass: null, passCalls: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/terms/terms-pass-hook.js", () => ({ loadTermsPass: async () => H.termsPass }));

const { default: termsHandler } = await import("../api/orders/terms.js");
const { default: checkHandler } = await import("../api/orders/terms_check.js");
const { default: reconcileHandler } = await import("../api/orders/reconcile_quotes.js");
const { autoReconcileOrder } = await import("../api/_lib/order-reconcile.js");

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const u = (n) => "00000000-0000-4000-8000-0000000000" + n;
const ENG = u("a1"), MGR = u("a2"), ADMIN = u("a3"), VIEWER = u("a4"), FOREIGN = u("b1");
const CUST = u("c1"), CUST2 = u("c2");
const O1 = u("d1"), O2 = u("d2"), O_T2 = u("d9");
const Q1 = u("e1"), Q2 = u("e2");
const DOC = u("f1"), RUN = u("f2");

// The terms pass fixture: what PR 11 returns for a digital PO it read.
const PASS_READ = {
  po_terms_status: "read",
  po_text_source: "text_layer",
  segmenter: "headings",
  dropped_unverified: 1,
  prompt_version: "terms_pass@v1",
  model: "fixture-model",
  po_clauses: [
    { clause: "payment_terms", side: "po", text: "Payment: 60 days from the date of GRN", value: { days: 60, basis: "grn", advance_pct: 0, instrument: null }, provenance: "po_text", document_id: DOC, page: 7, bbox_norm: [0.08, 0.41, 0.62, 0.44], verified: true, confidence: 0.92, method: "llm:terms_pass@v1" },
    { clause: "ld_penalty", side: "po", text: "Liquidated damages at 1% per day of delay.", value: null, provenance: "po_text", document_id: DOC, page: 8, verified: true, method: "llm:terms_pass@v1" },
  ],
};

const order = (id, over = {}) => ({
  id, tenant_id: T1, status: "DRAFT", customer_id: CUST, po_number: "PO-" + id.slice(-2), po_date: "2026-09-20",
  quote_id: null, quote_number: null, incoterm_code: null, delivery_terms: null, rule_findings: [],
  preflight_payload: { source_document_id: DOC, extraction_run_id: RUN },
  result: {
    salesOrder: {
      customer: { name: "Fixture Buyer", payment_terms: "45 days credit" },
      lineItems: [{ partNumber: "P-100", quantity: 2, unitPrice: 500, description: "Fixture part" }],
    },
    quoteReconciliation: { quotes_used: [{ quote_id: Q1, quote_number: "Q-1", lines_matched: 1 }] },
  },
  updated_at: "2026-09-20T00:00:00Z", ...over,
});

const seed = (mode = "on", extra = {}) => {
  H.db = createMemoryDb({
    tenant_members: [],
    tenant_settings: [
      { tenant_id: T1, terms_check_mode: mode, terms_policy: null },
      { tenant_id: T2, terms_check_mode: "on", terms_policy: null },
    ],
    customers: [
      { id: CUST, tenant_id: T1, customer_name: "Fixture Buyer", default_payment_terms: "45 days credit", default_incoterms: null },
      { id: CUST2, tenant_id: T2, customer_name: "Other Buyer", default_payment_terms: null, default_incoterms: null },
    ],
    orders: [order(O1), order(O2, { result: { salesOrder: { customer: {}, lineItems: [] } } }), order(O_T2, { tenant_id: T2, customer_id: CUST2 })],
    quotes: [
      { id: Q1, tenant_id: T1, customer_id: CUST, quote_number: "Q-1", status: "SENT", ingest_source: "document", source_document_id: null, terms: "30 days from invoice", incoterm: "FCA Chennai", delivery_terms: null, validity_text: null, terms_snapshot: null, created_at: "2026-09-01T00:00:00Z", opportunity_id: null },
      { id: Q2, tenant_id: T1, customer_id: CUST, quote_number: "Q-2", status: "SENT", ingest_source: "document", terms: "30 days from invoice", incoterm: null, created_at: "2026-08-01T00:00:00Z", opportunity_id: null },
    ],
    quote_lines: [{ quote_id: Q1, tenant_id: T1, line_index: 0, part_no: "P-100", description: "Fixture part", qty: 2, uom: "NOS", listed_unit_price: 500, discounted_unit_price: 500 }],
    extraction_runs: [{ id: RUN, tenant_id: T1, normalized_extract: { _provenance: { "customer.payment_terms": "customer_master" } } }],
    order_documents: [],
    item_customer_parts: [],
    order_term_checks: [],
    order_term_flags: [],
    order_term_decisions: [],
    audit_events: [],
    processing_events: [],
    ...extra,
  }, {}, { project: true });
};

beforeEach(() => {
  seed("on");
  H.ctx = null;
  H.passCalls = [];
  H.termsPass = vi.fn(async (args) => { H.passCalls.push(args); return PASS_READ; });
});

const as = (userId, role, tenantId = T1) => { H.ctx = { user: { id: userId }, tenantId, role }; };
const getTerms = (orderId, extra = {}) => callHandler(termsHandler, { query: { order_id: orderId, ...extra } });
const recheck = (orderId, extra = {}) => callHandler(checkHandler, { method: "POST", body: { order_id: orderId, ...extra } });
const checks = (orderId = O1) => H.db.tables.order_term_checks.filter((c) => c.order_id === orderId);
const current = (orderId = O1) => checks(orderId).filter((c) => !c.superseded_at);
const flagsOf = (checkId) => H.db.tables.order_term_flags.filter((f) => f.check_id === checkId);

describe("POST /api/orders/terms_check and GET /api/orders/terms, mode on", () => {
  it("stores one check and its flags, and GET returns both sides with provenance", async () => {
    as(ENG, "sales_engineer");
    const r = await recheck(O1);
    expect(r.status).toBe(200);
    expect(r.body.ran).toBe("checked");

    const [c] = checks();
    expect(c).toMatchObject({
      tenant_id: T1, trigger: "manual", po_terms_status: "read", po_text_source: "text_layer", segmenter: "headings",
      dropped_unverified: 1, quote_ids: [Q1], policy_version: 1, prompt_version: "terms_pass@v1", created_by: ENG, po_document_id: DOC,
    });
    // The pass was handed the PO document and told it is the PO.
    expect(H.passCalls[0]).toMatchObject({ orderId: O1, documentId: DOC, kind: "po", mode: "on", previous: null });

    const g = await getTerms(O1);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ mode: "on", visible: true, shadow: false, check: { po_source: "terms_pass", clause_count: 2 } });
    const byClause = Object.fromEntries(g.body.flags.map((f) => [f.clause, f]));
    expect(byClause.ld_penalty).toMatchObject({ outcome: "po_only", severity: "critical", needs_decision: true });
    // A full read, so a clause only the quote states is listed, at info.
    expect(byClause.incoterm).toMatchObject({ outcome: "quote_only", severity: "info", needs_decision: false, po: null });
    expect(byClause.payment_terms).toMatchObject({ outcome: "deviates", direction: "against_us", severity: "high" });
    expect(byClause.payment_terms.po).toMatchObject({ text: "Payment: 60 days from the date of GRN", label: "from PO, page 7", bbox_norm: [0.08, 0.41, 0.62, 0.44] });
    expect(byClause.payment_terms.quote).toMatchObject({ text: "30 days from invoice", quote_number: "Q-1", primary: true, label: "from uploaded quote Q-1" });
    // The grounded master value is a labelled baseline, never "from PO".
    expect(byClause.payment_terms.baseline).toMatchObject({ text: "45 days credit", label: "from customer master" });
    // Sorted: critical first.
    expect(g.body.flags[0].clause).toBe("ld_penalty");
    expect(g.body.counts).toMatchObject({ total: g.body.flags.length, by_severity: { critical: 1, high: 1 } });
  });

  it("is idempotent: the same inputs write nothing new; a changed quote supersedes the old check", async () => {
    as(ENG, "sales_engineer");
    await recheck(O1);
    const first = current()[0];
    const n = flagsOf(first.id).length;

    const again = await recheck(O1);
    expect(again.body.ran).toBe("unchanged");
    expect(checks()).toHaveLength(1);
    expect(H.db.tables.order_term_flags).toHaveLength(n);

    H.db.tables.quotes.find((q) => q.id === Q1).terms = "60 days from the date of GRN";
    const changed = await recheck(O1);
    expect(changed.body.ran).toBe("checked");
    expect(checks()).toHaveLength(2);
    expect(current()).toHaveLength(1);
    expect(current()[0].id).not.toBe(first.id);
    expect(checks().find((c) => c.id === first.id).superseded_at).toBeTruthy();
    expect(flagsOf(first.id).every((f) => f.superseded_at)).toBe(true);
    // The payment terms now agree. The LD the PO imposes stays, and so does
    // the incoterm only the quote states (info, last).
    expect(changed.body.flags.map((f) => [f.clause, f.outcome])).toEqual([["ld_penalty", "po_only"], ["incoterm", "quote_only"]]);
  });

  it("records the manual re-check in the audit trail, without clause wording", async () => {
    as(ENG, "sales_engineer");
    await recheck(O1);
    const audit = H.db.tables.audit_events.filter((a) => a.action === "order_terms_checked");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ object_id: O1, actor: ENG, detail: { mode: "on", po_terms_status: "read", flags: 3 } });
    expect(JSON.stringify(audit[0].detail)).not.toContain("GRN");
  });

  it("a viewer may read and may not re-run", async () => {
    as(VIEWER, "viewer");
    expect((await recheck(O1)).status).toBe(403);
    expect(checks()).toHaveLength(0);
    expect((await getTerms(O1)).status).toBe(200);
  });
});

describe("the not_read row", () => {
  it("a PO whose terms were not read gets one explicit not_read flag", async () => {
    H.termsPass = vi.fn(async () => ({ po_terms_status: "not_read", po_text_source: "none", po_clauses: [], reason: "image only, no text layer" }));
    as(ENG, "sales_engineer");
    await recheck(O1);
    const g = await getTerms(O1);
    expect(g.body.check.po_terms_status).toBe("not_read");
    expect(g.body.flags).toHaveLength(1);
    expect(g.body.flags[0]).toMatchObject({ clause: null, clause_label: "PO terms", outcome: "not_read", severity: "high", needs_decision: true });
    expect(g.body.flags[0].rationale).toContain("image only, no text layer");
  });

  it("with no terms pass and nothing extracted, the fallback is not_read too", async () => {
    H.termsPass = null;
    as(ENG, "sales_engineer");
    await recheck(O2);
    const [c] = current(O2);
    expect(c).toMatchObject({ po_terms_status: "not_read", prompt_version: null });
    expect(flagsOf(c.id).map((f) => f.outcome)).toEqual(["not_read"]);
  });
});

describe("until the terms pass exists, the PO side is what extraction gives, with its true provenance", () => {
  beforeEach(() => { H.termsPass = null; });

  it("a master value grounding filled in is never labelled from PO; the operator's incoterm is theirs", async () => {
    H.db.tables.orders.find((o) => o.id === O1).incoterm_code = "DDP Pune";
    as(ENG, "sales_engineer");
    await recheck(O1);
    const g = await getTerms(O1);
    expect(g.body.check).toMatchObject({ po_source: "extraction", po_terms_status: "partial" });
    expect(g.body.po_clauses.map((c) => [c.clause, c.provenance, c.label])).toEqual([
      ["incoterm", "operator_entry", "entered on the order header"],
    ]);
    expect(g.body.flags.map((f) => [f.clause, f.direction, f.severity, f.po.label])).toEqual([
      ["incoterm", "against_us", "high", "entered on the order header"],
    ]);
    expect(JSON.stringify(g.body)).not.toContain("from PO");
  });

  it("a payment term the PO printed is the PO side, labelled as read by extraction", async () => {
    const o = H.db.tables.orders.find((x) => x.id === O1);
    o.result.salesOrder.customer.payment_terms = "Payment 60 days from GRN";
    H.db.tables.extraction_runs[0].normalized_extract = {};
    as(ENG, "sales_engineer");
    await recheck(O1);
    const g = await getTerms(O1);
    const [f] = g.body.flags;
    expect(f).toMatchObject({ clause: "payment_terms", outcome: "deviates", severity: "high" });
    expect(f.po.label).toBe("from PO (read by extraction, not the terms reader)");
  });
});

describe("the mode", () => {
  it("off: nothing is run, written or shown, even where older checks exist", async () => {
    as(ENG, "sales_engineer");
    await recheck(O1);
    H.db.tables.tenant_settings[0].terms_check_mode = "off";
    const r = await recheck(O1);
    expect(r.body).toMatchObject({ ran: "off", mode: "off", visible: false, flags: [] });
    expect(checks()).toHaveLength(1);
    const g = await getTerms(O1);
    expect(g.body).toMatchObject({ mode: "off", visible: false, check: null, flags: [] });
  });

  it("off writes nothing at all on a fresh order", async () => {
    seed("off");
    as(ENG, "sales_engineer");
    await recheck(O1);
    expect(H.db.tables.order_term_checks).toEqual([]);
    expect(H.termsPass).not.toHaveBeenCalled();
  });

  it("shadow: stored, hidden from engineers, shown to an admin who asks", async () => {
    seed("shadow");
    as(ENG, "sales_engineer");
    const r = await recheck(O1);
    expect(r.body).toMatchObject({ ran: "checked", mode: "shadow", visible: false, hidden: true, flags: [] });
    expect(checks()).toHaveLength(1);
    expect((await getTerms(O1)).body).toMatchObject({ visible: false, hidden: true, flags: [] });
    const refused = await getTerms(O1, { include_shadow: "1" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("SHADOW_ADMIN_ONLY");

    as(ADMIN, "admin");
    const g = await getTerms(O1, { include_shadow: "1" });
    expect(g.body).toMatchObject({ mode: "shadow", shadow: true, visible: true });
    expect(g.body.flags.length).toBeGreaterThan(0);
    // Without asking, an admin sees what everyone sees.
    expect((await getTerms(O1)).body.visible).toBe(false);
  });

  it("shadow: the audit row of a re-check carries no flag count", async () => {
    seed("shadow");
    as(ENG, "sales_engineer");
    await recheck(O1);
    const [a] = H.db.tables.audit_events.filter((x) => x.action === "order_terms_checked");
    expect(a.detail).toEqual({ check_id: current()[0].id, mode: "shadow" });
  });

  it("a mode value outside off, shadow and on is off", async () => {
    seed("sometimes");
    as(ENG, "sales_engineer");
    expect((await recheck(O1)).body.ran).toBe("off");
  });
});

describe("before migration 250 is applied", () => {
  const missingColumn = { code: "42703", message: "column tenant_settings.terms_check_mode does not exist" };

  it("both endpoints return 409 MIGRATION_NOT_APPLIED naming 250_order_terms.sql", async () => {
    H.db.failRead.tenant_settings = missingColumn;
    as(ENG, "sales_engineer");
    for (const r of [await getTerms(O1), await recheck(O1)]) {
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({ code: "MIGRATION_NOT_APPLIED", migration: "250_order_terms.sql" });
    }
  });

  it("a missing order_term_checks table is the same 409", async () => {
    H.db.failRead.order_term_checks = { code: "42P01", message: 'relation "order_term_checks" does not exist' };
    as(ENG, "sales_engineer");
    const r = await recheck(O1);
    expect(r.status).toBe(409);
    expect(r.body.error.migration).toBe("250_order_terms.sql");
  });

  it("a different missing column is a different fault, not this 409", async () => {
    H.db.failRead.tenant_settings = { code: "42703", message: "column tenant_settings.some_other_flag does not exist" };
    as(ENG, "sales_engineer");
    expect((await getTerms(O1)).status).toBe(500);
  });

  it("the reconcile still runs and stores, and skips the terms step cleanly", async () => {
    H.db.failRead.tenant_settings = missingColumn;
    as(ENG, "sales_engineer");
    const r = await callHandler(reconcileHandler, { method: "POST", body: { order_id: O1 } });
    expect(r.status).toBe(200);
    expect(r.body.summary.matched).toBe(1);
    expect(H.db.tables.orders.find((o) => o.id === O1).result.quoteReconciliation.as_of).toBeTruthy();
    expect(H.db.tables.order_term_checks).toEqual([]);
    expect(H.db.tables.processing_events.filter((e) => String(e.event_type).startsWith("terms_check"))).toEqual([]);
  });
});

describe("the reconcile trigger", () => {
  it("the reconcile endpoint ends with a terms check", async () => {
    as(ENG, "sales_engineer");
    const r = await callHandler(reconcileHandler, { method: "POST", body: { order_id: O1 } });
    expect(r.status).toBe(200);
    expect(current()).toHaveLength(1);
    expect(current()[0]).toMatchObject({ trigger: "reconcile", quote_ids: [Q1] });
  });

  it("the server trigger runs once per payload hash, and a failing pass never fails the reconcile", async () => {
    as(ENG, "sales_engineer");
    const first = await autoReconcileOrder(H.db.svc(), H.ctx, O1, { trigger: "lines_changed" });
    expect(first.status).toBe("reconciled");
    expect(H.termsPass).toHaveBeenCalledTimes(1);
    expect(current()).toHaveLength(1);

    const second = await autoReconcileOrder(H.db.svc(), H.ctx, O1, { trigger: "lines_changed" });
    expect(second.status).toBe("unchanged");
    expect(H.termsPass).toHaveBeenCalledTimes(1);
    expect(checks()).toHaveLength(1);

    H.termsPass = vi.fn(async () => { throw new Error("reader unavailable"); });
    H.db.tables.orders.find((o) => o.id === O1).result.salesOrder.lineItems[0].quantity = 3;
    const third = await autoReconcileOrder(H.db.svc(), H.ctx, O1, { trigger: "lines_changed" });
    expect(third.status).toBe("reconciled");
    expect(H.db.tables.processing_events.map((e) => e.event_type)).toContain("terms_check_failed");
    expect(checks()).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("another tenant's order is not found, and nothing is written", async () => {
    as(FOREIGN, "sales_engineer", T2);
    expect((await getTerms(O1)).status).toBe(404);
    expect((await recheck(O1)).status).toBe(404);
    expect(H.db.tables.order_term_checks).toEqual([]);
  });

  it("a tenant reads only its own checks", async () => {
    as(ENG, "sales_engineer");
    await recheck(O1);
    as(FOREIGN, "sales_engineer", T2);
    await recheck(O_T2);
    const g = await getTerms(O_T2);
    expect(g.body.check.id).toBe(current(O_T2)[0].id);
    expect(H.db.tables.order_term_checks.map((c) => c.tenant_id).sort()).toEqual([T1, T2]);
    expect(H.db.tables.order_term_flags.filter((f) => f.order_id === O_T2).every((f) => f.tenant_id === T2)).toBe(true);
  });

  it("no tenant in context is refused", async () => {
    H.ctx = { user: { id: ENG }, tenantId: null, role: "sales_engineer" };
    expect((await getTerms(O1)).status).toBe(403);
    expect((await recheck(O1)).status).toBe(403);
  });
});
