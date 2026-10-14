// The terms pass (plan PR 11, docs/SO_TERMS_AND_HANDOFF_SCOPE.md section 4).
//
// The provider calls go through the real callAnthropic and callGemini; only the
// network (safeFetch) is stubbed, so the request bodies asserted here are the
// bytes each provider would receive. The database is in memory.
//
// Every document, clause, company and place below is invented.

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const OTHER_TENANT = "00000000-0000-0000-0000-0000000000ff";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";
const DOC = "00000000-0000-0000-0000-0000000000d1";
const OTHER_DOC = "00000000-0000-0000-0000-0000000000d2";
const USER = "00000000-0000-0000-0000-0000000000e1";

const H = vi.hoisted(() => ({
  db: null, fetches: [], events: [], audits: [], responders: {}, fail: {}, files: {}, geometry: null,
}));

// ── an in-memory Supabase ────────────────────────────────────────────────────

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
let seq = 0;
let clock = Date.parse("2026-10-01T00:00:00Z");
const stamp = () => new Date((clock += 1000)).toISOString();

const makeDb = (seed) => {
  const tables = clone(seed);
  const reads = [];
  return {
    tables,
    reads,
    storage: {
      from: (bucket) => ({
        download: async (path) => {
          const b = H.files[bucket + "/" + path];
          return b ? { data: { arrayBuffer: async () => b }, error: null } : { data: null, error: { message: "not found" } };
        },
      }),
    },
    from(table) {
      if (H.throwOn === table) throw new Error(table + " exploded");
      const filters = [];
      let op = "select";
      let patch = null;
      let rowsIn = null;
      let selectAfter = false;
      let orderBy = null;
      let lim = null;
      const run = async () => {
        const failure = H.fail[table + ":" + op] || H.fail[table];
        if (failure) return { data: null, error: failure };
        if (op === "select") reads.push(table);
        const rows = tables[table] || (tables[table] = []);
        if (op === "insert") {
          const out = rowsIn.map((r) => ({ id: r.id || "row-" + (++seq), created_at: stamp(), ...clone(r) }));
          rows.push(...out);
          return { data: clone(out), error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of hit) Object.assign(r, clone(patch));
          return { data: selectAfter ? clone(hit) : null, error: null };
        }
        if (orderBy) {
          const { c, asc } = orderBy;
          hit = [...hit].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
        }
        if (lim != null) hit = hit.slice(0, lim);
        return { data: clone(hit), error: null };
      };
      const one = () => run().then((r) => ({ data: Array.isArray(r.data) ? (r.data[0] || null) : r.data, error: r.error }));
      const api = {
        select() { if (op !== "select") selectAfter = true; return api; },
        eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
        neq(c, v) { filters.push((r) => String(r[c]) !== String(v)); return api; },
        in(c, vals) { filters.push((r) => vals.map(String).includes(String(r[c]))); return api; },
        is(c, v) { filters.push((r) => (r[c] ?? null) === v); return api; },
        not(c, _op, list) {
          const banned = String(list).replace(/[()]/g, "").split(",");
          filters.push((r) => !banned.includes(String(r[c])));
          return api;
        },
        gte() { return api; },
        or() { return api; },
        order(c, o) { orderBy = { c, asc: o?.ascending !== false }; return api; },
        limit(n) { lim = n; return api; },
        update(p) { op = "update"; patch = p; return api; },
        insert(r) { op = "insert"; rowsIn = Array.isArray(r) ? r : [r]; return api; },
        maybeSingle: one,
        single: one,
        then: (f, r) => run().then(f, r),
      };
      return api;
    },
  };
};

// ── the network: every provider request is recorded, answered by H.responders

vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const provider = /anthropic\.com/.test(url) ? "claude" : /googleapis\.com/.test(url) ? "gemini" : "other";
    H.fetches.push({ provider, url, body });
    const responder = H.responders[provider];
    const r = responder ? responder(body) : { status: 500, json: { error: { message: "no responder" } } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      text: async () => JSON.stringify(r.json),
    };
  },
  safeFetchOk: async () => { throw new Error("unused"); },
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db }));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push({ tenantId: ctx?.tenantId, ...p }); },
  recordEvent: async (ctx, p) => { H.events.push({ tenantId: ctx?.tenantId, ...p }); },
}));
// Geometry is the PDF's own text positions; the parser needs a real PDF, so
// the test hands back the pages it would have read.
vi.mock("../api/_lib/docai/text_layer.js", async (orig) => ({
  ...(await orig()),
  extractTextBlocks: vi.fn(async () => H.geometry),
}));

const {
  runTermsPass, verifyQuote, segmentTerms, buildClauses, TERMS_RULE, TERMS_TOOL, BODY_TEXT_CAP,
} = await import("../api/_lib/terms/terms-pass.js");
const { termsModeOf, termsCheckRuns, readTermsCheckMode } = await import("../api/_lib/terms/mode.js");
const { toGeminiSchema } = await import("../api/_lib/gemini.js");
const { __resetCircuitBreakers } = await import("../api/_lib/docai/circuit-breaker.js");

// ── fixtures ─────────────────────────────────────────────────────────────────

const ctx = { tenantId: TENANT, user: { id: USER }, role: "sales_engineer" };

const HEADER_PAGE = [
  "PURCHASE ORDER",
  "PO No: TEST-PO-0001   Date: 01.09.2026",
  "Buyer: Example Components Pvt Ltd",
  "1  Test bracket   4 NOS   250.00",
  "2  Test flange    1 NOS  1200.00",
].join("\n");
const TERMS_PAGE = [
  "TERMS AND CONDITIONS",
  "1. Payment: 60 days from the date of GRN.",
  "2. Delivery: Within 4 weeks from the date of this purchase order.",
  "3. Warranty: 18 months from the date of supply.",
  "4. Liquidated damages: 0.5% per week of delay, maximum 5% of the order value.",
  "5. Jurisdiction: Courts at Exampleville only.",
].join("\n");

const PAYMENT = "Payment: 60 days from the date of GRN.";
const WARRANTY = "Warranty: 18 months from the date of supply.";
const JURISDICTION = "Jurisdiction: Courts at Exampleville only.";

const textLayer = (pages, over = {}) => ({
  tenant_id: TENANT, document_id: DOC, text_status: "has_text", page_count: pages.length,
  char_count: pages.join("\n\n").length, body_text: pages.join("\n\n"),
  page_breakdown: pages.map((t, i) => ({ page: i + 1, chars: t.length, has_text: t.length >= 30 })),
  ...over,
});

const seed = ({ mode = "on", settings = null, layers = [textLayer([HEADER_PAGE, TERMS_PAGE])], preflight = { source_document_id: DOC }, extra = {} } = {}) => {
  H.db = makeDb({
    tenant_settings: [settings || { tenant_id: TENANT, terms_check_mode: mode, docai_daily_limits: null }],
    orders: [{
      id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status: "DRAFT", po_number: "TEST-PO-0001",
      preflight_payload: preflight, result: {}, rule_findings: [], updated_at: "2026-09-30T00:00:00.000Z",
    }],
    documents: [
      { id: DOC, tenant_id: TENANT, filename: "po.pdf", mime_type: "application/pdf", storage_bucket: "docs", storage_path: "po/test.pdf", sha256: null, scan_status: "clean" },
      { id: OTHER_DOC, tenant_id: OTHER_TENANT, filename: "po.pdf", mime_type: "application/pdf", storage_bucket: "docs", storage_path: "po/other.pdf", sha256: null, scan_status: "clean" },
    ],
    extraction_text_layer: [
      ...layers,
      { ...textLayer([HEADER_PAGE, TERMS_PAGE]), tenant_id: OTHER_TENANT, document_id: OTHER_DOC },
    ],
    extraction_ocr_layer: [],
    order_documents: [],
    order_term_checks: [],
    ...extra,
  });
};

const claudeSays = (input) => () => ({
  status: 200,
  json: { content: [{ type: "tool_use", name: TERMS_TOOL.name, input }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } },
});
const geminiSays = (input) => () => ({
  status: 200,
  json: { candidates: [{ content: { parts: [{ text: JSON.stringify(input) }] }, finishReason: "STOP" }] },
});

const GOOD = [
  { clause: "payment_terms", segment: "S1", quote: PAYMENT, value: { days: 60, basis: "grn" }, confidence: 0.9 },
  { clause: "warranty", segment: "S1", quote: WARRANTY, confidence: 0.9 },
  { clause: "jurisdiction", segment: "S1", quote: JURISDICTION, value: { courts_place: "Exampleville" }, confidence: 0.85 },
];

const checks = () => H.db.tables.order_term_checks;
const calls = (provider) => H.fetches.filter((f) => !provider || f.provider === provider);

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.GEMINI_API_KEY = "test-gemini-key";
});

beforeEach(() => {
  H.fetches = []; H.events = []; H.audits = []; H.fail = {}; H.throwOn = null;
  H.files = { "docs/po/test.pdf": Buffer.from("%PDF-1.4 test") };
  H.geometry = null;
  H.responders = { claude: claudeSays({ clauses: GOOD }), gemini: geminiSays({ clauses: GOOD }) };
  __resetCircuitBreakers();
  seed();
});

// ── the verbatim check ───────────────────────────────────────────────────────

describe("verifyQuote", () => {
  const SOURCE = "4.  Liquidated  damages:\n0.5% per week of delay \u2013 maximum 5% of the \u201corder value\u201d.";

  it("finds wording that differs only in whitespace, case, quote marks and dashes", () => {
    const v = verifyQuote(SOURCE, "liquidated damages: 0.5% per week of delay - maximum 5% of the \"order value\".");
    expect(v.ok).toBe(true);
    // The stored text is the document's own wording, not the model's copy.
    expect(v.text).toBe(SOURCE.slice(SOURCE.indexOf("Liquidated")));
  });

  it("finds a word broken by a hyphen at a line end, written either way", () => {
    const src = "Prices are ex-\nworks Exampleville and the warranty covers manufac-\nturing defects.";
    expect(verifyQuote(src, "Prices are ex-works Exampleville").ok).toBe(true);
    expect(verifyQuote(src, "covers manufacturing defects").ok).toBe(true);
  });

  it("refuses wording that is not in the source", () => {
    expect(verifyQuote(SOURCE, "Liquidated damages: 1% per day of delay, no maximum.")).toEqual({ ok: false, reason: "not_verbatim" });
    expect(verifyQuote(SOURCE, "  ").ok).toBe(false);
  });
});

// ── the segmenter ────────────────────────────────────────────────────────────

describe("segmentTerms", () => {
  it("sends the T&C section under its heading, and not the line items", () => {
    const text = HEADER_PAGE + "\n\n" + TERMS_PAGE;
    const pages = [{ page: 1, start: 0, end: HEADER_PAGE.length }, { page: 2, start: HEADER_PAGE.length + 2, end: text.length }];
    const s = segmentTerms(text, { pages });
    expect(s.segmenter).toBe("headings");
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]).toMatchObject({ id: "S1", page: 2 });
    expect(s.segments[0].text).toContain(PAYMENT);
    expect(s.segments[0].text).not.toContain("Test bracket");
  });

  it("sends every clause under a T&C heading, also one that names no keyword", () => {
    const text = [
      HEADER_PAGE, "",
      "GENERAL TERMS AND CONDITIONS OF PURCHASE", "",
      "1. Payment: sixty days from the date of the goods receipt note.", "",
      "2. The seller shall keep every drawing it receives confidential and shall return all of them on request.",
    ].join("\n");
    const sent = segmentTerms(text).segments.map((x) => x.text).join("\n");
    expect(sent).toContain("keep every drawing it receives confidential");
    expect(sent).not.toContain("Test bracket");
  });

  it("reaches prose terms that carry no heading, next to a header with a label line", () => {
    const header = "PURCHASE ORDER\nDelivery address: Plant 2, Exampleville\n1  Test bracket   4 NOS   250.00";
    const prose = [
      "Kindly supply the items above. The supplier shall deliver the goods within six weeks of this order and",
      "the buyer will release payment sixty days after acceptance of the material at our stores, and any delay",
      "in delivery will attract liquidated damages at one percent per week of the delayed value.",
    ].join("\n");
    const text = header + "\n\n" + prose;
    const pages = [{ page: 1, start: 0, end: header.length }, { page: 2, start: header.length + 2, end: text.length }];
    const s = segmentTerms(text, { pages });
    expect(s.segmenter).toBe("headings");
    const sent = s.segments.map((x) => x.text).join("\n");
    expect(sent).toContain("release payment sixty days after acceptance");
    expect(sent).toContain("liquidated damages at one percent per week");
  });

  it("falls back to keyword pages and the last three pages when there is no heading, and says so", () => {
    // No heading, no label line: each keyword sits mid-sentence on its own line.
    const pages = [
      "Item list page one", "Item list page two", "more items",
      "We expect that our payment will be released once the material is checked by the team\nand that the goods carry a warranty that covers twelve months of use in the plant.",
      "Thank you", "Signature",
    ];
    const text = pages.join("\n\n");
    let at = 0;
    const ranges = pages.map((t, i) => { const r = { page: i + 1, start: at, end: at + t.length }; at += t.length + 2; return r; });
    const s = segmentTerms(text, { pages: ranges });
    expect(s.segmenter).toBe("fallback");
    expect(s.segments.map((x) => x.page)).toEqual([4, 5, 6]);
  });
});


// ── what the pass returns ────────────────────────────────────────────────────
//
// The pass stores nothing: the terms check (check.js) writes its result as one
// order_term_checks row with the flags. api-terms-e2e.test.js covers that.

const pass = (over = {}) => runTermsPass({ svc: H.db, ctx, orderId: ORDER, ...over });

describe("the verbatim check in the pass", () => {
  it("drops an invented clause and counts it, and returns only the clauses the PO states", async () => {
    H.responders.claude = claudeSays({ clauses: [
      ...GOOD,
      { clause: "payment_terms", segment: "S1", quote: "Payment: 120 days from the date of invoice.", value: { days: 120 }, confidence: 0.95 },
      { clause: "one_sided", segment: "S1", quote: "The seller accepts unlimited liability for all losses.", value: { subtype: "unlimited_liability" }, confidence: 0.9 },
    ] });
    const r = await pass();
    expect(r).toMatchObject({ po_terms_status: "read", dropped_unverified: 2, mode: "on" });
    expect(r.po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
    expect(r.po_clauses.every((c) => c.verified === true && c.provenance === "po_text" && c.side === "po")).toBe(true);
    expect(checks()).toHaveLength(0);
  });

  it("drops a clause whose quote is in no segment the model was sent", () => {
    const segments = [{ id: "S1", start: 100, end: 140, page: 2, text: PAYMENT }];
    const built = buildClauses({
      raw: { clauses: [{ clause: "payment_terms", segment: "S1", quote: "Payment: 30 days net.", confidence: 0.9 }] },
      segments, promptLabel: "terms_pass@v1",
    });
    expect(built).toEqual({ clauses: [], dropped_unverified: 1, dropped_invalid: 0 });
  });
});

describe("structured values", () => {
  it("come from the code, read off the verified wording, and a disagreeing hint lowers the confidence", async () => {
    H.responders.claude = claudeSays({ clauses: [
      // The model misreads the term. The wording says 60 days from GRN.
      { clause: "payment_terms", segment: "S1", quote: PAYMENT, value: { days: 90, basis: "invoice", advance_pct: 10 }, confidence: 0.9 },
      { clause: "warranty", segment: "S1", quote: WARRANTY, value: { months: 18, from: "delivery" }, confidence: 0.9 },
    ] });
    const [pay, war] = (await pass()).po_clauses;
    expect(pay.value).toEqual({ days: 60, basis: "grn", advance_pct: 0, instrument: null });
    expect(pay.confidence).toBeLessThan(0.9);
    // An agreeing hint leaves the model's confidence as it was.
    expect(war.value).toEqual({ months: 18, from: "delivery", scope: null });
    expect(war.confidence).toBe(0.9);
    expect(pay.method).toBe("llm:terms_pass@v1");
    expect(pay.text_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── the mode ─────────────────────────────────────────────────────────────────

describe("the mode", () => {
  it("off makes no call and reads no PO text", async () => {
    seed({ mode: "off" });
    const r = await pass();
    expect(r).toMatchObject({ status: "off", mode: "off" });
    expect(calls()).toHaveLength(0);
    expect(H.db.reads).not.toContain("extraction_text_layer");
    expect(H.db.reads).not.toContain("documents");
  });

  it("reads the mode off the settings row, and anything but shadow or on is off", () => {
    expect(termsModeOf({ terms_check_mode: "shadow" })).toEqual({ mode: "shadow", migrated: true });
    expect(termsModeOf({ terms_check_mode: " On " })).toEqual({ mode: "on", migrated: true });
    expect(termsModeOf({ terms_check_mode: "ON_PLEASE" })).toEqual({ mode: "off", migrated: true });
    expect(termsModeOf({ terms_check_mode: null })).toEqual({ mode: "off", migrated: true });
    expect(termsModeOf({ tenant_id: TENANT })).toEqual({ mode: "off", migrated: false });
    expect(termsModeOf(null)).toEqual({ mode: "off", migrated: null });
    expect(["off", "shadow", "on", "bogus", "", null, undefined].filter(termsCheckRuns)).toEqual(["shadow", "on"]);
  });

  it("knows a missing migration 250 from any other refusal of the settings read", async () => {
    H.fail.tenant_settings = { code: "42703", message: "column tenant_settings.terms_check_mode does not exist" };
    expect(await readTermsCheckMode(H.db, TENANT)).toMatchObject({ mode: "off", migrated: false });
    H.fail.tenant_settings = { code: "42703", message: "column tenant_settings.some_other_flag does not exist" };
    expect(await readTermsCheckMode(H.db, TENANT)).toMatchObject({ mode: "off", migrated: null });
    H.fail = {};
    expect(await readTermsCheckMode(H.db, null)).toMatchObject({ mode: "off", error: "no tenant" });
  });

  it("an unknown mode value is off", async () => {
    seed({ settings: { tenant_id: TENANT, terms_check_mode: "ON_PLEASE" } });
    expect((await pass()).status).toBe("off");
    expect(calls()).toHaveLength(0);
  });

  it("a settings row with no terms_check_mode column is off, and sends nothing", async () => {
    seed({ settings: { tenant_id: TENANT, docai_daily_limits: null } });
    expect(await pass()).toMatchObject({ status: "off", reason: "migration_250_missing" });
    expect(calls()).toHaveLength(0);
  });

  it("shadow reads, and marks the result as shadow", async () => {
    seed({ mode: "shadow" });
    const r = await pass();
    expect(r).toMatchObject({ mode: "shadow", shadow: true, po_terms_status: "read", po_document_id: DOC, po_text_source: "text_layer", segmenter: "headings", prompt_version: "terms_pass@v1" });
    expect(r.po_clauses).toHaveLength(3);
    // Page 2 of the cached text, worked out from its page breakdown.
    expect(r.po_clauses.map((c) => c.page)).toEqual([2, 2, 2]);
  });
});

// ── the other text sources ───────────────────────────────────────────────────

describe("the text it reads", () => {
  it("reads a PO that arrived as the body of an email", async () => {
    seed({ preflight: { source: "inbound_email", text: "Dear team, please supply as below.\n\n" + TERMS_PAGE } });
    const r = await pass();
    expect(r).toMatchObject({ po_terms_status: "read", po_text_source: "email_body", po_document_id: null });
    expect(r.po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
  });

  it("reads an office PO from the text the pipeline derives from it", async () => {
    seed({ layers: [] });
    const rtfDoc = H.db.tables.documents.find((d) => d.id === DOC);
    Object.assign(rtfDoc, { filename: "po.rtf", mime_type: "application/rtf", storage_path: "po/test.rtf" });
    H.files["docs/po/test.rtf"] = Buffer.from("{\\rtf1\\ansi " + TERMS_PAGE.split("\n").join("\\par\n") + "}", "latin1");
    const r = await pass();
    expect(r).toMatchObject({ po_terms_status: "read", po_text_source: "office", po_document_id: DOC });
    expect(r.po_clauses).toHaveLength(3);
  });
});

// ── PO terms not read ────────────────────────────────────────────────────────

describe("PO terms not read", () => {
  it("a scanned PO with no text is not_read, and nothing is sent", async () => {
    seed({ layers: [{ tenant_id: TENANT, document_id: DOC, text_status: "image_only", page_count: 3, char_count: 0, body_text: null, page_breakdown: [] }] });
    const r = await pass();
    expect(r).toMatchObject({ po_terms_status: "not_read", po_text_source: "none", po_document_id: DOC, po_clauses: [] });
    expect(calls()).toHaveLength(0);
  });

  it("an order with no PO document is not_read, never an empty read", async () => {
    seed({ preflight: { source: "api" } });
    expect(await pass()).toMatchObject({ po_terms_status: "not_read", po_text_source: "none", po_document_id: null });
  });

  it("an image-only T&C page with nothing found elsewhere is not_read, not a clean read", async () => {
    // Page 2 (the T&C) is an image: the text layer has nothing on it.
    seed({ layers: [textLayer([HEADER_PAGE, ""], { text_status: "mixed" })] });
    H.responders.claude = claudeSays({ clauses: [] });
    expect(await pass()).toMatchObject({ po_terms_status: "not_read", po_text_source: "text_layer", po_clauses: [] });
  });

  it("an image-only page beside terms that were read is a partial read", async () => {
    seed({ layers: [textLayer([HEADER_PAGE, TERMS_PAGE, ""], { text_status: "mixed" })] });
    const r = await pass();
    expect(r.po_terms_status).toBe("partial");
    expect(r.po_clauses).toHaveLength(3);
  });

  it("a failed provider is not_read, not a read with no clauses", async () => {
    H.responders.claude = () => ({ status: 400, json: { error: { message: "refused" } } });
    H.responders.gemini = () => ({ status: 400, json: { error: { message: "refused" } } });
    expect(await pass()).toMatchObject({ po_terms_status: "not_read", reason: "provider_failed", po_clauses: [] });
  });

  it("a read that runs past its deadline is not_read", async () => {
    // The deadline is already too close for any provider call to finish.
    const r = await pass({ deadlineAt: Date.now() + 1_000 });
    expect(r).toMatchObject({ po_terms_status: "not_read", reason: "provider_failed", po_clauses: [] });
    expect(calls()).toHaveLength(0);
  });

  it("a document of another tenant is never read", async () => {
    seed({ preflight: { source_document_id: OTHER_DOC } });
    expect(await pass()).toMatchObject({ po_terms_status: "not_read", po_document_id: null });
    expect(calls()).toHaveLength(0);
  });
});

// ── long POs ─────────────────────────────────────────────────────────────────

const itemPage = (n) => Array.from({ length: 12 }, (_, i) =>
  String(n * 100 + i).padStart(5, "0") + "  Test part " + n + "-" + i + "  2 NOS  " + (100 + i) + ".00").join("\n");

describe("a long PO", () => {
  it("reads the T&C pages of a 30-page PO, which the profiler leaves out of extraction", async () => {
    const pages = Array.from({ length: 28 }, (_, i) => itemPage(i + 1));
    pages.push(TERMS_PAGE, "Authorised signatory\nFor Example Components Pvt Ltd");
    seed({ layers: [textLayer(pages)] });
    const r = await pass();
    const sent = calls("claude")[0].body.messages[0].content[0].text;
    expect(sent).toContain("SEGMENT S1 (page 29)");
    expect(sent).toContain(PAYMENT);
    expect(sent).not.toContain("Test part 3-1");
    expect(r.po_clauses.find((c) => c.clause === "payment_terms").page).toBe(29);
  });

  it("knows the cached text's cap", async () => {
    const { TEXT_LAYER_THRESHOLDS } = await import("../api/_lib/docai/text_layer.js");
    expect(BODY_TEXT_CAP).toBe(TEXT_LAYER_THRESHOLDS.bodyTextBytes);
  });

  it("reads the pages past the 200 KB text cap from the PDF's geometry, and boxes the wording", async () => {
    // The cached text was cut at 200 KB, long before the T&C on page 60.
    const cut = itemPage(1).repeat(400).slice(0, 200_000);
    seed({ layers: [{
      tenant_id: TENANT, document_id: DOC, text_status: "has_text", page_count: 60, char_count: 260_000,
      body_text: cut, page_breakdown: Array.from({ length: 60 }, (_, i) => ({ page: i + 1, chars: 4300, has_text: true })),
    }] });
    expect(cut).not.toContain("Payment");
    const block = (text, y) => ({ text, bbox: [60, y, 540, y + 12], confidence: 1 });
    H.geometry = {
      source: "text_layer",
      raw_pages: [
        ...Array.from({ length: 59 }, (_, i) => ({ index: i, width: 600, height: 800, blocks: [block("Test part " + i + "  2 NOS  100.00", 100)] })),
        { index: 59, width: 600, height: 800, blocks: TERMS_PAGE.split("\n").map((t, k) => block(t, 100 + k * 20)) },
      ],
    };
    const r = await pass();
    const sent = calls("claude")[0].body.messages[0].content[0].text;
    expect(sent).toContain("SEGMENT S1 (page 60)");
    expect(sent).toContain(PAYMENT);
    expect(r.po_terms_status).toBe("read");
    const pay = r.po_clauses.find((c) => c.clause === "payment_terms");
    expect(pay.page).toBe(60);
    // The payment line is the second block on that page: y 120..132 of 800.
    expect(pay.bbox_norm).toEqual([0.1, 0.15, 0.9, 0.165]);
  });
});

// ── the Gemini fallback ──────────────────────────────────────────────────────

describe("the Gemini fallback", () => {
  it("is asked with the same rule string and the same tool schema as Claude", async () => {
    H.responders.claude = () => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "test refusal" } } });
    const r = await pass();
    const claudeReq = calls("claude")[0].body;
    const geminiReq = calls("gemini")[0].body;
    expect(claudeReq.system.map((b) => b.text)).toContain(TERMS_RULE);
    expect(geminiReq.systemInstruction.parts.map((p) => p.text)).toContain(TERMS_RULE);
    expect(claudeReq.tools[0].input_schema).toEqual(TERMS_TOOL.input_schema);
    expect(geminiReq.generationConfig.responseSchema).toEqual(toGeminiSchema(TERMS_TOOL.input_schema));
    expect(geminiReq.contents[0].parts[0].text).toBe(claudeReq.messages[0].content[0].text);
    // And what it returned went through the same verification.
    expect(r.po_terms_status).toBe("read");
    expect(r.model).toMatch(/^gemini/);
    expect(r.po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
  });

  it("is not asked when Claude answers", async () => {
    const r = await pass();
    expect(calls("claude")).toHaveLength(1);
    expect(calls("gemini")).toHaveLength(0);
    expect(r.model).toMatch(/^claude/);
  });
});

// ── the entry the terms check calls ──────────────────────────────────────────

describe("runTermsPass, as the terms check (check.js) calls it", () => {
  const call = (over = {}) => runTermsPass({ svc: H.db, ctx, orderId: ORDER, documentId: DOC, kind: "po", mode: "on", previous: null, ...over });

  it("returns the order_term_checks columns and stores nothing", async () => {
    const r = await call();
    expect(r).toMatchObject({
      po_terms_status: "read", po_text_source: "text_layer", po_document_id: DOC, segmenter: "headings",
      dropped_unverified: 0, prompt_version: "terms_pass@v1", mode: "on", shadow: false, cached: false,
    });
    expect(r.model).toMatch(/^claude/);
    expect(r.po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
    expect(checks()).toHaveLength(0);
  });

  it("reuses the previous check's clauses for the same text and prompt version, without a call", async () => {
    const first = await call();
    expect(calls()).toHaveLength(1);
    const previous = {
      id: "check-1", po_terms_status: "read", prompt_version: "terms_pass@v1", po_document_id: DOC,
      po_text_source: "text_layer", po_clauses: first.po_clauses, segmenter: "headings", dropped_unverified: 0, model: first.model,
    };
    const again = await call({ previous });
    expect(calls()).toHaveLength(1);
    expect(again).toMatchObject({ cached: true, po_terms_status: "read" });
    expect(again.po_clauses).toEqual(first.po_clauses);
    // A check from another prompt version is not this read.
    await call({ previous: { ...previous, prompt_version: "terms_pass@v0" } });
    expect(calls()).toHaveLength(2);
    // Nor is a check that was not a full read.
    await call({ previous: { ...previous, po_terms_status: "partial" } });
    expect(calls()).toHaveLength(3);
  });

  it("looks the latest reusable check up itself when the caller passes none", async () => {
    const first = await call();
    H.db.tables.order_term_checks.push({
      id: "check-2", tenant_id: TENANT, order_id: ORDER, po_terms_status: "read", prompt_version: "terms_pass@v1",
      po_document_id: DOC, po_text_source: "text_layer", po_clauses: first.po_clauses, created_at: "2026-10-10T00:00:00Z",
    });
    const again = await call({ previous: undefined });
    expect(calls()).toHaveLength(1);
    expect(again).toMatchObject({ cached: true, cached_from: "check-2" });
  });

  it("does not run for a tenant that is off, whatever mode the caller passes", async () => {
    seed({ mode: "off" });
    expect((await call({ mode: "on" })).status).toBe("off");
    expect(calls()).toHaveLength(0);
  });

  it("does not run when the caller says off, whatever the tenant says", async () => {
    expect((await call({ mode: "off" })).status).toBe("off");
    expect(calls()).toHaveLength(0);
  });

  it("the check's reconcile budget holds one full Claude attempt and the comparison", async () => {
    const { TERMS_AFTER_RECONCILE_BUDGET_MS, TERMS_CHECK_MARGIN_MS } = await import("../api/_lib/terms/check.js");
    const { ANTHROPIC_ATTEMPT_TIMEOUT_MS } = await import("../api/_lib/anthropic.js");
    expect(TERMS_AFTER_RECONCILE_BUDGET_MS - TERMS_CHECK_MARGIN_MS).toBeGreaterThanOrEqual(ANTHROPIC_ATTEMPT_TIMEOUT_MS);
    expect(TERMS_CHECK_MARGIN_MS).toBeGreaterThan(0);
  });

  it("never throws: a read that broke is not_read", async () => {
    H.throwOn = "documents";
    expect(await call()).toMatchObject({ po_terms_status: "not_read", reason: "pass_failed" });
    expect(calls()).toHaveLength(0);
  });
});
