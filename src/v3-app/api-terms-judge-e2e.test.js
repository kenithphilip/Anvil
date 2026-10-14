// The LLM wording judge inside the terms check (plan PR 12b), end to end.
//
// The order write, the reconcile, the terms pass, the rule comparator, the
// judge, the flags, GET /api/orders/terms and POST /api/orders/terms_decide
// run for real against an in-memory Supabase. Only the network is stubbed:
// Claude answers the pass and the judge through the real callAnthropic, told
// apart by the tool each request names.
//
// Every document, clause, company and place below is invented.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => {
  process.env.TERMS_PASS_BUDGET_MS = "6000";
  return { db: null, ctx: null, fetches: [], judgeSays: null };
});

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: async (_svc, _t, _c, lines) => lines,
  lineCandidates: () => [], lineSapCandidates: () => [],
}));
vi.mock("../api/_lib/stripe-client.js", () => ({ tenantSettings: async () => ({}) }));
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const tool = body?.tools?.[0]?.name || null;
    H.fetches.push({ url, tool, body });
    if (tool === "judge_terms_wording" && H.judgeDelayMs) {
      // A slow judge gives up at the timeout callAnthropic set, as safeFetch does.
      const limit = Number(init.timeoutMs) || 60_000;
      await new Promise((r) => setTimeout(r, Math.min(H.judgeDelayMs, limit)));
      if (H.judgeDelayMs > limit) throw new Error("Upstream judge did not respond within " + limit + "ms");
    }
    const input = tool === "judge_terms_wording" ? H.judgeSays : PASS_READ;
    const json = { content: [{ type: "tool_use", name: tool, input }], stop_reason: "tool_use", usage: {} };
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) };
  },
  safeFetchOk: async () => { throw new Error("unused"); },
}));

const { default: patchOrder } = await import("../api/orders/[id].js");
const { default: termsHandler } = await import("../api/orders/terms.js");
const { default: checkHandler } = await import("../api/orders/terms_check.js");
const { default: decideHandler } = await import("../api/orders/terms_decide.js");
const { __resetCircuitBreakers } = await import("../api/_lib/docai/circuit-breaker.js");

const id = (n) => "00000000-0000-4000-8000-0000000000" + n;
const T1 = id("01");
const ENG = id("a1"), MGR = id("a2"), ADMIN = id("a3");
const CUST = id("c1"), O1 = id("d1"), Q1 = id("e1"), DOC = id("f1"), TPL = id("b1");

// The PO's LD clause names no rate and no cap, so the rules cannot read it
// into a value: "unknown", the judge's case. The quote caps LD at 5%.
const PO_LD = "Liquidated damages: the buyer shall levy damages at its discretion for every week of delay, without any limit.";
const QUOTE_LD = "Liquidated damages shall not exceed 5% of the order value.";
const PAYMENT = "Payment: 60 days from the date of GRN.";
const HEADER = "PURCHASE ORDER\nPO No: TEST-PO-0077   Date: 20.09.2026\n1  PART-A  Test bracket   4 NOS   250.00";
const TERMS = ["TERMS AND CONDITIONS", "1. " + PAYMENT, "2. " + PO_LD].join("\n");

const PASS_READ = { clauses: [
  { clause: "payment_terms", segment: "S1", quote: PAYMENT, confidence: 0.9 },
  { clause: "ld_penalty", segment: "S1", quote: PO_LD, confidence: 0.85 },
] };
const JUDGED = {
  deviates: "yes", direction: "against_us",
  rationale: "The PO sets no limit on damages; the quote caps them at 5% of the order value.",
  cites: ["P1", "Q1"], po_phrase: "without any limit", quote_phrase: "shall not exceed 5% of the order value",
};

const seed = (mode = "on") => {
  const body = HEADER + "\n\n" + TERMS;
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: T1, terms_check_mode: mode, terms_policy: null, docai_daily_limits: null }],
    customers: [{ id: CUST, tenant_id: T1, default_payment_terms: null, default_incoterms: null }],
    orders: [{
      id: O1, tenant_id: T1, customer_id: CUST, status: "DRAFT", po_number: "TEST-PO-0077", po_date: "2026-09-20",
      quote_id: null, quote_number: null, rule_findings: [], approval: null, payload_hash: null,
      incoterm_code: null, delivery_terms: null, updated_at: "2026-09-30T00:00:00.000Z",
      preflight_payload: { source: "upload", source_document_id: DOC }, result: {},
    }],
    quotes: [{
      id: Q1, tenant_id: T1, customer_id: CUST, quote_number: "Q-TEST-7", status: "SENT", created_at: "2026-09-01T00:00:00Z",
      ingest_source: null, template_id: null, terms: "Payment: 30 days from the date of invoice.",
      incoterm: null, delivery_terms: null, validity_text: null, validity_days: null, expires_at: null,
      terms_snapshot: null, terms_snapshot_at: null, sent_at: null, source_document_id: null,
    }],
    quote_lines: [{ quote_id: Q1, tenant_id: T1, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, discounted_unit_price: 250 }],
    document_templates: [{
      id: TPL, tenant_id: T1, doc_type: "quotation", is_default: true, is_active: true, updated_at: "2026-08-01T00:00:00Z",
      payment_terms_clause: null, delivery_terms_clause: null, cancellation_clause: null, warranty_clause: null,
      penalty_clause: QUOTE_LD,
    }],
    documents: [{ id: DOC, tenant_id: T1, filename: "po.pdf", mime_type: "application/pdf", storage_bucket: "docs", storage_path: "po/77.pdf", sha256: null, scan_status: "clean" }],
    extraction_text_layer: [{
      tenant_id: T1, document_id: DOC, text_status: "has_text", page_count: 2, char_count: body.length, body_text: body,
      page_breakdown: [{ page: 1, chars: HEADER.length, has_text: true }, { page: 2, chars: TERMS.length, has_text: true }],
    }],
    extraction_ocr_layer: [], order_documents: [], item_customer_parts: [], item_master: [],
    order_term_checks: [], order_term_flags: [], order_term_decisions: [], extraction_cache: [],
    audit_events: [], processing_events: [],
  }, {}, { project: true });
};

const as = (userId, role) => { H.ctx = { user: { id: userId }, tenantId: T1, role }; };
const writeLines = () => callHandler(patchOrder, {
  method: "PATCH", query: { id: O1 },
  body: { result: { salesOrder: { lineItems: [{ line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 250 }] } } },
});
const view = (extra = {}) => callHandler(termsHandler, { query: { order_id: O1, ...extra } });
const recheck = () => callHandler(checkHandler, { method: "POST", body: { order_id: O1 } });
const decide = (flagId, decision) => callHandler(decideHandler, {
  method: "POST", body: { order_id: O1, flag_id: flagId, decision, reason: "Spoke to the buyer's purchase team today." },
});

const currentFlags = () => H.db.tables.order_term_flags.filter((f) => !f.superseded_at);
const flagOf = (clause) => currentFlags().find((f) => f.clause === clause);
const judgeCalls = () => H.fetches.filter((f) => f.tool === "judge_terms_wording");
const passCalls = () => H.fetches.filter((f) => f.tool === "record_terms_clauses");

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.GEMINI_API_KEY;
});

beforeEach(() => {
  H.fetches = [];
  H.judgeSays = JUDGED;
  H.judgeDelayMs = 0;
  __resetCircuitBreakers();
  as(ENG, "sales_engineer");
  seed("on");
});

describe("a wording-only difference the rules cannot decide", () => {
  it("gives an llm flag that cites both texts, verbatim, beside the rule flags", async () => {
    expect((await writeLines()).status).toBe(200);
    expect(passCalls()).toHaveLength(1);
    expect(judgeCalls()).toHaveLength(1);
    // The judge saw the two texts, and only for the clause the rules left open.
    const sent = judgeCalls()[0].body.messages[0].content[0].text;
    expect(sent).toContain("CLAUSE: ld_penalty");
    expect(sent).toContain("P1 (the purchase order)\n" + PO_LD);
    expect(sent).toContain("Q1 (our quotation)\n" + QUOTE_LD);

    const ld = flagOf("ld_penalty");
    expect(ld).toMatchObject({
      method: "llm", outcome: "deviates", direction: "against_us", severity: "high",
      rationale: JUDGED.rationale,
    });
    expect(ld.po).toMatchObject({ text: PO_LD, cited: "without any limit", provenance: "po_text" });
    expect(ld.quote).toMatchObject({ text: QUOTE_LD, cited: "shall not exceed 5% of the order value", quote_id: Q1 });
    // The payment terms are the rules' to decide, and stay a rule flag.
    expect(flagOf("payment_terms")).toMatchObject({ method: "rule", outcome: "deviates", severity: "high" });

    // GET returns the LLM flag with both citations, for the Terms tab.
    const g = await view();
    const f = g.body.flags.find((x) => x.clause === "ld_penalty");
    expect(f).toMatchObject({ method: "llm", outcome: "deviates", severity: "high" });
    expect(f.po.cited).toBe("without any limit");
    expect(f.quote.cited).toBe("shall not exceed 5% of the order value");
  });

  it("a judgement with a fabricated citation gives no llm flag: the rule's row stands", async () => {
    H.judgeSays = { ...JUDGED, po_phrase: "the buyer may claim unlimited damages" };
    await writeLines();
    expect(judgeCalls()).toHaveLength(1);
    expect(currentFlags().filter((f) => f.method === "llm")).toEqual([]);
    expect(flagOf("ld_penalty")).toMatchObject({ method: "rule", outcome: "unknown", severity: "high" });
    expect(flagOf("ld_penalty").po.cited).toBeUndefined();
    expect(H.db.tables.extraction_cache).toEqual([]);
  });

  it("a judgement that cites only one text gives no llm flag either", async () => {
    H.judgeSays = { ...JUDGED, cites: ["P1"] };
    await writeLines();
    expect(currentFlags().filter((f) => f.method === "llm")).toEqual([]);
  });

  it("the cache answers the same text pair on a re-check: no second judge call", async () => {
    await writeLines();
    expect(judgeCalls()).toHaveLength(1);
    expect(H.db.tables.extraction_cache).toHaveLength(1);
    const r = await recheck();
    expect(r.status).toBe(200);
    expect(judgeCalls()).toHaveLength(1);
    expect(passCalls()).toHaveLength(1);
    expect(r.body.ran).toBe("unchanged");
    expect(flagOf("ld_penalty")).toMatchObject({ method: "llm", severity: "high" });
  });

  it("decision 2: an engineer cannot accept a high llm flag, and may request an amendment; a manager may accept", async () => {
    await writeLines();
    const ld = flagOf("ld_penalty");
    const no = await decide(ld.id, "accept");
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe("ACTION_FORBIDDEN");
    expect((await decide(ld.id, "not_a_deviation")).status).toBe(403);
    expect((await decide(ld.id, "request_amendment")).status).toBe(200);
    as(MGR, "sales_manager");
    expect((await decide(ld.id, "accept")).status).toBe(200);
    expect(H.db.tables.order_term_decisions.map((d) => d.decision)).toEqual(["request_amendment", "accept"]);
  });

  it("a 'no' on a high-rated clause stays visible at info as LLM judged equivalent, citing both", async () => {
    H.judgeSays = { ...JUDGED, deviates: "no", rationale: "Both cap the damages." };
    await writeLines();
    expect(flagOf("ld_penalty")).toMatchObject({
      method: "llm", outcome: "unknown", severity: "info", direction: null,
      rationale: "LLM judged equivalent. Both cap the damages.",
    });
    expect(flagOf("ld_penalty").quote.cited).toBe("shall not exceed 5% of the order value");
  });
});

describe("the deadline", () => {
  it("a judge slower than the check's deadline leaves the rule's flag, stored inside the budget", async () => {
    H.judgeDelayMs = 60_000;
    const started = Date.now();
    await writeLines();
    expect(judgeCalls().length).toBeGreaterThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(H.db.tables.order_term_checks.filter((c) => !c.superseded_at)).toHaveLength(1);
    expect(flagOf("ld_penalty")).toMatchObject({ method: "rule", outcome: "unknown", severity: "high" });
    expect(H.db.tables.processing_events.filter((e) => e.event_type === "terms_check_timeout")).toEqual([]);
  }, 20_000);
});

describe("the mode", () => {
  it("off: no pass, no judge, nothing written", async () => {
    seed("off");
    await writeLines();
    expect(H.fetches).toEqual([]);
    expect(H.db.tables.order_term_flags).toEqual([]);
  });

  it("shadow: the llm flag is stored, and engineers cannot see it", async () => {
    seed("shadow");
    await writeLines();
    expect(flagOf("ld_penalty")).toMatchObject({ method: "llm" });
    expect((await view()).body).toMatchObject({ hidden: true, flags: [] });
    as(ADMIN, "admin");
    const admin = await view({ include_shadow: "1" });
    expect(admin.body.flags.find((f) => f.clause === "ld_penalty").method).toBe("llm");
  });
});
