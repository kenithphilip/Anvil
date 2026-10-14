// The terms check, end to end (plans PR 11, 12 and 13 joined).
//
// The order write, the server-side reconcile, the terms pass, the rule
// comparison, the flags, GET /api/orders/terms and POST
// /api/orders/terms_decide all run for real, against an in-memory Supabase.
// Only the network is stubbed: Claude answers through the real callAnthropic.
//
// The budget is cut to 6 s here (TERMS_PASS_BUDGET_MS) so a slow provider is
// tested in seconds. Gemini is not configured in this file, so Claude gets the
// whole read.
//
// Every document, clause, company and place below is invented.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => {
  process.env.TERMS_PASS_BUDGET_MS = "6000";
  return { db: null, ctx: null, fetches: [], responders: {}, delayMs: {} };
});

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
// Item mapping talks to tables this test does not seed; the reconcile is what
// is under test.
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines,
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
// The network. A responder answers each provider; delayMs makes one slow, and
// a slow call gives up at the timeout callAnthropic set, as safeFetch does.
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (url, init = {}) => {
    const provider = /anthropic\.com/.test(url) ? "claude" : /googleapis\.com/.test(url) ? "gemini" : "other";
    H.fetches.push({ provider, body: init.body ? JSON.parse(init.body) : null });
    const delay = H.delayMs[provider] || 0;
    if (delay) {
      const limit = Number(init.timeoutMs) || 60_000;
      await new Promise((r) => setTimeout(r, Math.min(delay, limit)));
      if (delay > limit) throw new Error("Upstream " + provider + " did not respond within " + limit + "ms");
    }
    const r = H.responders[provider] ? H.responders[provider]() : { status: 500, json: { error: { message: "no responder" } } };
    return { ok: r.status < 300, status: r.status, headers: { get: () => null }, text: async () => JSON.stringify(r.json) };
  },
  safeFetchOk: async () => { throw new Error("unused"); },
}));

const { default: patchOrder } = await import("../api/orders/[id].js");
const { default: termsHandler } = await import("../api/orders/terms.js");
const { default: decideHandler } = await import("../api/orders/terms_decide.js");
const { runTermsAfterReconcile, TERMS_AFTER_RECONCILE_BUDGET_MS } = await import("../api/_lib/terms/check.js");
const { TERMS_TOOL } = await import("../api/_lib/terms/terms-pass.js");
const { __resetCircuitBreakers } = await import("../api/_lib/docai/circuit-breaker.js");

const id = (n) => "00000000-0000-4000-8000-0000000000" + n;
const T1 = id("01");
const ENG = id("a1"), MGR = id("a2"), ADMIN = id("a3");
const CUST = id("c1"), O1 = id("d1"), Q1 = id("e1"), DOC = id("f1"), TPL = id("b1");

const HEADER = [
  "PURCHASE ORDER",
  "PO No: TEST-PO-0042   Date: 20.09.2026",
  "Buyer: Example Components Pvt Ltd",
  "1  PART-A  Test bracket   4 NOS   250.00",
].join("\n");
const PAYMENT = "Payment: 60 days from the date of GRN.";
const WARRANTY = "Warranty: 18 months from the date of supply.";
const LD = "Liquidated damages: 1% per week of delay, maximum 10% of the order value.";
const JURISDICTION = "Jurisdiction: Courts at Exampleville only.";
const TERMS = ["TERMS AND CONDITIONS", "1. " + PAYMENT, "2. " + WARRANTY, "3. " + LD, "4. " + JURISDICTION].join("\n");

const READ = { clauses: [
  { clause: "payment_terms", segment: "S1", quote: PAYMENT, confidence: 0.9 },
  { clause: "warranty", segment: "S1", quote: WARRANTY, confidence: 0.9 },
  { clause: "ld_penalty", segment: "S1", quote: LD, confidence: 0.9 },
  { clause: "jurisdiction", segment: "S1", quote: JURISDICTION, confidence: 0.85 },
] };
const claudeSays = (input) => () => ({
  status: 200,
  json: { content: [{ type: "tool_use", name: TERMS_TOOL.name, input }], stop_reason: "tool_use", usage: {} },
});

const textLayer = (over = {}) => {
  const body = HEADER + "\n\n" + TERMS;
  return {
    tenant_id: T1, document_id: DOC, text_status: "has_text", page_count: 2, char_count: body.length, body_text: body,
    page_breakdown: [{ page: 1, chars: HEADER.length, has_text: true }, { page: 2, chars: TERMS.length, has_text: true }],
    ...over,
  };
};

const seed = (mode, { layer = textLayer() } = {}) => {
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: T1, terms_check_mode: mode, terms_policy: null, docai_daily_limits: null }],
    customers: [{ id: CUST, tenant_id: T1, name: "Example Components Pvt Ltd", default_payment_terms: null, default_incoterms: null }],
    orders: [{
      id: O1, tenant_id: T1, customer_id: CUST, status: "DRAFT", po_number: "TEST-PO-0042", po_date: "2026-09-20",
      quote_id: null, quote_number: null, rule_findings: [], approval: null, payload_hash: null,
      incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00.000Z",
      preflight_payload: { source: "upload", source_document_id: DOC }, result: {},
    }],
    // Our own quote: payment terms on the quote row, warranty and LD on the
    // default quotation template.
    quotes: [{
      id: Q1, tenant_id: T1, customer_id: CUST, quote_number: "Q-TEST-1", status: "SENT", created_at: "2026-09-01T00:00:00Z",
      ingest_source: null, template_id: null, terms: "Payment: 30 days from the date of invoice.",
      incoterm: null, delivery_terms: null, validity_text: null, validity_days: null, expires_at: null,
      terms_snapshot: null, terms_snapshot_at: null, sent_at: null, source_document_id: null,
    }],
    quote_lines: [{ quote_id: Q1, tenant_id: T1, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, discounted_unit_price: 250 }],
    document_templates: [{
      id: TPL, tenant_id: T1, doc_type: "quotation", is_default: true, is_active: true, updated_at: "2026-08-01T00:00:00Z",
      payment_terms_clause: null, delivery_terms_clause: null, cancellation_clause: null,
      warranty_clause: "Warranty: 12 months from the date of dispatch.",
      penalty_clause: "Liquidated damages: 0.5% per week of delay, maximum 5% of the order value.",
    }],
    documents: [{ id: DOC, tenant_id: T1, filename: "po.pdf", mime_type: "application/pdf", storage_bucket: "docs", storage_path: "po/42.pdf", sha256: null, scan_status: "clean" }],
    extraction_text_layer: layer ? [layer] : [],
    extraction_ocr_layer: [],
    order_documents: [],
    item_customer_parts: [],
    item_master: [],
    order_term_checks: [],
    order_term_flags: [],
    order_term_decisions: [],
    audit_events: [],
    processing_events: [],
  }, {}, { project: true });
};

const as = (userId, role) => { H.ctx = { user: { id: userId }, tenantId: T1, role }; };
const writeLines = () => callHandler(patchOrder, {
  method: "PATCH", query: { id: O1 },
  body: { result: { salesOrder: { lineItems: [{ line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 250 }] } } },
});
const view = (extra = {}) => callHandler(termsHandler, { query: { order_id: O1, ...extra } });
const decide = (flagId, decision) => callHandler(decideHandler, {
  method: "POST", body: { order_id: O1, flag_id: flagId, decision, reason: "Spoke to the buyer's purchase team today." },
});

const t = () => H.db.tables;
const currentChecks = () => t().order_term_checks.filter((c) => !c.superseded_at);
const currentFlags = () => t().order_term_flags.filter((f) => !f.superseded_at);
const severities = (flags) => Object.fromEntries(flags.map((f) => [f.clause || "not_read", f.severity]));
const calls = () => H.fetches.filter((f) => f.provider === "claude" || f.provider === "gemini");

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.GEMINI_API_KEY;
});

beforeEach(() => {
  H.fetches = []; H.delayMs = {};
  H.responders = { claude: claudeSays(READ) };
  __resetCircuitBreakers();
  as(ENG, "sales_engineer");
});

describe("an order with PO text and a quote", () => {
  it("is written, reconciled, read, compared and flagged; GET shows the flags; a decision is recorded", async () => {
    seed("on");
    const w = await writeLines();
    expect(w.status).toBe(200);
    // The write and the reconcile stand.
    expect(t().orders[0].result.quoteReconciliation.quotes_used.map((q) => q.quote_number)).toEqual(["Q-TEST-1"]);
    // The pass read the PO's T&C through Claude, once.
    expect(calls()).toHaveLength(1);
    expect(calls()[0].body.messages[0].content[0].text).toContain(LD);

    // One current check, with its flags, written by the check alone.
    expect(currentChecks()).toHaveLength(1);
    const check = currentChecks()[0];
    expect(check).toMatchObject({
      trigger: "reconcile", po_terms_status: "read", po_text_source: "text_layer", po_document_id: DOC,
      prompt_version: "terms_pass@v1", quote_ids: [Q1],
    });
    expect(check.po_clauses.map((c) => c.clause)).toEqual(["payment_terms", "warranty", "ld_penalty", "jurisdiction"]);
    expect(currentFlags().every((f) => f.check_id === check.id && f.method === "rule")).toBe(true);
    expect(severities(currentFlags())).toEqual({ payment_terms: "high", warranty: "high", ld_penalty: "high", jurisdiction: "warn" });
    const ld = currentFlags().find((f) => f.clause === "ld_penalty");
    expect(ld).toMatchObject({ outcome: "deviates", direction: "against_us" });
    expect(ld.rationale).toContain("LD rate: PO 1% per week, quote 0.5% per week");
    expect(ld.po).toMatchObject({ text: LD, provenance: "po_text", page: 2, verified: true });
    expect(ld.quote).toMatchObject({ quote_id: Q1, provenance: "quote_template_live" });

    // GET /api/orders/terms returns them to the engineer, worst first.
    const g = await view();
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ mode: "on", visible: true, check: { po_terms_status: "read", po_source: "terms_pass" } });
    expect(g.body.flags.map((f) => f.clause)).toEqual(["payment_terms", "warranty", "ld_penalty", "jurisdiction"]);
    expect(g.body.flags[0].po.label).toBe("from PO, page 2");

    // terms_decide records the engineer's amendment request on a high flag.
    const pay = currentFlags().find((f) => f.clause === "payment_terms");
    const d = await decide(pay.id, "request_amendment");
    expect(d.status).toBe(200);
    expect(t().order_term_decisions).toMatchObject([{ flag_id: pay.id, decision: "request_amendment", decided_by: ENG, decided_role: "sales_engineer" }]);
    expect((await view()).body.flags.find((f) => f.clause === "payment_terms").state).toBe("amendment_requested");
    // Decision 2: accepting a high flag needs a manager.
    expect((await decide(ld.id, "accept")).status).toBe(403);
    as(MGR, "sales_manager");
    expect((await decide(ld.id, "accept")).status).toBe(200);
  });

  it("a second write with the same PO text reuses the read and writes nothing new", async () => {
    seed("on");
    await writeLines();
    t().orders[0].result.salesOrder.lineItems[0].quantity = 5;
    await callHandler(patchOrder, { method: "PATCH", query: { id: O1 }, body: { result: t().orders[0].result } });
    expect(calls()).toHaveLength(1);
    expect(currentChecks()).toHaveLength(1);
  });
});

describe("the mode", () => {
  it("off makes no provider call and writes nothing, and the reconcile still stands", async () => {
    seed("off");
    expect((await writeLines()).status).toBe(200);
    expect(calls()).toHaveLength(0);
    expect(t().order_term_checks).toEqual([]);
    expect(t().order_term_flags).toEqual([]);
    expect(t().orders[0].result.quoteReconciliation).toBeTruthy();
  });

  it("shadow stores the flags, and engineers cannot see them", async () => {
    seed("shadow");
    await writeLines();
    expect(currentFlags().length).toBe(4);
    const eng = await view();
    expect(eng.body).toMatchObject({ mode: "shadow", visible: false, hidden: true, flags: [] });
    expect((await view({ include_shadow: "1" })).status).toBe(403);
    as(ADMIN, "admin");
    const admin = await view({ include_shadow: "1" });
    expect(admin.body.flags.map((f) => f.clause)).toEqual(["payment_terms", "warranty", "ld_penalty", "jurisdiction"]);
  });
});

describe("PO terms not read", () => {
  it("a PO with no text gives the not_read row, and no call", async () => {
    seed("on", { layer: textLayer({ text_status: "image_only", body_text: null, char_count: 0, page_breakdown: [] }) });
    await writeLines();
    expect(calls()).toHaveLength(0);
    expect(currentChecks()[0]).toMatchObject({ po_terms_status: "not_read", po_text_source: "none" });
    expect(currentFlags()).toHaveLength(1);
    expect(currentFlags()[0]).toMatchObject({ outcome: "not_read", severity: "high", clause: null });
    const g = await view();
    expect(g.body.flags.map((f) => f.outcome)).toEqual(["not_read"]);
  });

  it("a read slower than the deadline is stored as not_read, never as no deviations", async () => {
    seed("on");
    H.delayMs.claude = 60_000;
    const started = Date.now();
    expect((await writeLines()).status).toBe(200);
    // Claude was asked, and gave up at the deadline, inside the budget.
    expect(calls().length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(TERMS_AFTER_RECONCILE_BUDGET_MS);
    expect(currentChecks()).toHaveLength(1);
    expect(currentChecks()[0].po_terms_status).toBe("not_read");
    expect(currentFlags().map((f) => f.outcome)).toEqual(["not_read"]);
    expect(t().processing_events.filter((e) => e.event_type === "terms_check_timeout")).toEqual([]);
  }, 20_000);

  it("the check hands its deadline to the pass, so a tight budget still stores not_read", async () => {
    seed("on");
    t().orders[0].result = { salesOrder: { lineItems: [] }, quoteReconciliation: { quotes_used: [{ quote_id: Q1, quote_number: "Q-TEST-1" }] } };
    H.delayMs.claude = 60_000;
    // 3 s budget: the read must end 2.5 s earlier, too soon to start a call.
    const out = await runTermsAfterReconcile(H.db.svc(), H.ctx, O1, { budgetMs: 3_000 });
    expect(out.status).toBe("checked");
    expect(calls()).toHaveLength(0);
    expect(currentChecks()[0].po_terms_status).toBe("not_read");
    expect(currentFlags().map((f) => f.outcome)).toEqual(["not_read"]);
  });
});
