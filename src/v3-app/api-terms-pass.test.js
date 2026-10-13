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
  runOrderTermsPass, runTermsPass, verifyQuote, segmentTerms, buildClauses, TERMS_RULE, TERMS_TOOL, BODY_TEXT_CAP,
} = await import("../api/_lib/terms/terms-pass.js");
const { autoReconcileOrder } = await import("../api/_lib/order-reconcile.js");
const { termsModeOf, termsCheckRuns, isMissingTermsSchema } = await import("../api/_lib/terms/mode.js");
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
const eventsOf = (type) => H.events.filter((e) => e.eventType === type);

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

// ── what the pass stores ─────────────────────────────────────────────────────

describe("the verbatim check in the pass", () => {
  it("drops an invented clause and counts it, and stores only the clauses the PO states", async () => {
    H.responders.claude = claudeSays({ clauses: [
      ...GOOD,
      { clause: "payment_terms", segment: "S1", quote: "Payment: 120 days from the date of invoice.", value: { days: 120 }, confidence: 0.95 },
      { clause: "one_sided", segment: "S1", quote: "The seller accepts unlimited liability for all losses.", value: { subtype: "unlimited_liability" }, confidence: 0.9 },
    ] });
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out.status).toBe("stored");
    const row = checks()[0];
    expect(row.po_terms_status).toBe("read");
    expect(row.dropped_unverified).toBe(2);
    expect(row.po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
    expect(row.po_clauses.every((c) => c.verified === true && c.provenance === "po_text" && c.side === "po")).toBe(true);
    // The hallucination rate is on the event; no wording is.
    const ev = eventsOf("terms_pass_stored")[0];
    expect(ev.detail).toMatchObject({ dropped_unverified: 2, clauses: 3, mode: "on", po_terms_status: "read" });
    const logged = JSON.stringify(H.events);
    for (const w of ["Exampleville", "60 days", "unlimited liability", "120 days"]) expect(logged).not.toContain(w);
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
    await runOrderTermsPass(H.db, ctx, ORDER);
    const [pay, war] = checks()[0].po_clauses;
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
  it("off makes no call, reads no PO text and stores nothing", async () => {
    seed({ mode: "off" });
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out).toMatchObject({ status: "off", mode: "off" });
    expect(calls()).toHaveLength(0);
    expect(H.db.reads).not.toContain("extraction_text_layer");
    expect(H.db.reads).not.toContain("documents");
    expect(checks()).toHaveLength(0);
    // The per-document entry point is gated the same way.
    const direct = await runTermsPass({ svc: H.db, ctx, documentId: DOC });
    expect(direct.status).toBe("off");
    expect(calls()).toHaveLength(0);
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

  it("knows a missing migration 250 from any other database error", () => {
    expect(isMissingTermsSchema({ code: "42P01", message: "relation \"public.order_term_checks\" does not exist" })).toBe(true);
    expect(isMissingTermsSchema({ code: "PGRST205", message: "Could not find the table 'public.order_term_checks' in the schema cache" })).toBe(true);
    expect(isMissingTermsSchema({ message: "column tenant_settings.terms_check_mode does not exist" })).toBe(true);
    expect(isMissingTermsSchema({ code: "42P01", message: "relation \"public.some_other_table\" does not exist" })).toBe(false);
    expect(isMissingTermsSchema({ code: "23503", message: "insert on order_term_checks violates foreign key constraint" })).toBe(false);
    expect(isMissingTermsSchema(null)).toBe(false);
  });

  it("an unknown mode value is off", async () => {
    seed({ settings: { tenant_id: TENANT, terms_check_mode: "ON_PLEASE" } });
    expect((await runOrderTermsPass(H.db, ctx, ORDER)).status).toBe("off");
    expect(calls()).toHaveLength(0);
  });

  it("shadow runs, stores the clauses, and marks the result as shadow", async () => {
    seed({ mode: "shadow" });
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out).toMatchObject({ status: "stored", mode: "shadow", shadow: true });
    expect(out.result).toMatchObject({ mode: "shadow", shadow: true, po_terms_status: "read" });
    expect(checks()).toHaveLength(1);
    expect(checks()[0]).toMatchObject({
      id: out.check_id, po_terms_status: "read", trigger: "reconcile", created_by: USER,
      po_document_id: DOC, po_text_source: "text_layer", segmenter: "headings", prompt_version: "terms_pass@v1",
    });
    expect(checks()[0].po_clauses).toHaveLength(3);
    // Page 2 of the cached text, worked out from its page breakdown.
    expect(checks()[0].po_clauses.map((c) => c.page)).toEqual([2, 2, 2]);
    expect(eventsOf("terms_pass_stored")[0].detail.mode).toBe("shadow");
  });
});

// ── the other text sources ───────────────────────────────────────────────────

describe("the text it reads", () => {
  it("reads a PO that arrived as the body of an email", async () => {
    seed({ preflight: { source: "inbound_email", text: "Dear team, please supply as below.\n\n" + TERMS_PAGE } });
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(checks()[0]).toMatchObject({ po_terms_status: "read", po_text_source: "email_body", po_document_id: null });
    expect(checks()[0].po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
  });

  it("reads an office PO from the text the pipeline derives from it", async () => {
    seed({ layers: [] });
    const rtfDoc = H.db.tables.documents.find((d) => d.id === DOC);
    Object.assign(rtfDoc, { filename: "po.rtf", mime_type: "application/rtf", storage_path: "po/test.rtf" });
    H.files["docs/po/test.rtf"] = Buffer.from("{\\rtf1\\ansi " + TERMS_PAGE.split("\n").join("\\par\n") + "}", "latin1");
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(checks()[0]).toMatchObject({ po_terms_status: "read", po_text_source: "office", po_document_id: DOC });
    expect(checks()[0].po_clauses).toHaveLength(3);
  });
});

// ── PO terms not read ────────────────────────────────────────────────────────

describe("PO terms not read", () => {
  it("a scanned PO with no text is stored as not_read, and nothing is sent", async () => {
    seed({ layers: [{ tenant_id: TENANT, document_id: DOC, text_status: "image_only", page_count: 3, char_count: 0, body_text: null, page_breakdown: [] }] });
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out.status).toBe("stored");
    expect(checks()[0]).toMatchObject({ po_terms_status: "not_read", po_text_source: "none", po_document_id: DOC, po_clauses: [] });
    expect(calls()).toHaveLength(0);
  });

  it("an order with no PO document is not_read, never an empty read", async () => {
    seed({ preflight: { source: "api" } });
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(checks()[0]).toMatchObject({ po_terms_status: "not_read", po_text_source: "none", po_document_id: null });
  });

  it("an image-only T&C page with nothing found elsewhere is not_read, not a clean read", async () => {
    // Page 2 (the T&C) is an image: the text layer has nothing on it.
    seed({ layers: [textLayer([HEADER_PAGE, ""], { text_status: "mixed" })] });
    H.responders.claude = claudeSays({ clauses: [] });
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(checks()[0]).toMatchObject({ po_terms_status: "not_read", po_text_source: "text_layer", po_clauses: [] });
  });

  it("an image-only page beside terms that were read is a partial read", async () => {
    seed({ layers: [textLayer([HEADER_PAGE, TERMS_PAGE, ""], { text_status: "mixed" })] });
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(checks()[0].po_terms_status).toBe("partial");
    expect(checks()[0].po_clauses).toHaveLength(3);
  });

  it("a failed provider is not_read, not a read with no clauses", async () => {
    H.responders.claude = () => ({ status: 400, json: { error: { message: "refused" } } });
    H.responders.gemini = () => ({ status: 400, json: { error: { message: "refused" } } });
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out.result.reason).toBe("provider_failed");
    expect(checks()[0]).toMatchObject({ po_terms_status: "not_read", po_clauses: [] });
  });

  it("a document of another tenant is never read", async () => {
    seed({ preflight: { source_document_id: OTHER_DOC } });
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(checks()[0]).toMatchObject({ po_terms_status: "not_read", po_document_id: null });
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
    await runOrderTermsPass(H.db, ctx, ORDER);
    const sent = calls("claude")[0].body.messages[0].content[0].text;
    expect(sent).toContain("SEGMENT S1 (page 29)");
    expect(sent).toContain(PAYMENT);
    expect(sent).not.toContain("Test part 3-1");
    const pay = checks()[0].po_clauses.find((c) => c.clause === "payment_terms");
    expect(pay.page).toBe(29);
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
    await runOrderTermsPass(H.db, ctx, ORDER);
    const sent = calls("claude")[0].body.messages[0].content[0].text;
    expect(sent).toContain("SEGMENT S1 (page 60)");
    expect(sent).toContain(PAYMENT);
    const row = checks()[0];
    expect(row.po_terms_status).toBe("read");
    const pay = row.po_clauses.find((c) => c.clause === "payment_terms");
    expect(pay.page).toBe(60);
    // The payment line is the second block on that page: y 120..132 of 800.
    expect(pay.bbox_norm).toEqual([0.1, 0.15, 0.9, 0.165]);
  });
});

// ── the Gemini fallback ──────────────────────────────────────────────────────

describe("the Gemini fallback", () => {
  it("is asked with the same rule string and the same tool schema as Claude", async () => {
    H.responders.claude = () => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "test refusal" } } });
    await runOrderTermsPass(H.db, ctx, ORDER);
    const claudeReq = calls("claude")[0].body;
    const geminiReq = calls("gemini")[0].body;
    expect(claudeReq.system.map((b) => b.text)).toContain(TERMS_RULE);
    expect(geminiReq.systemInstruction.parts.map((p) => p.text)).toContain(TERMS_RULE);
    expect(claudeReq.tools[0].input_schema).toEqual(TERMS_TOOL.input_schema);
    expect(geminiReq.generationConfig.responseSchema).toEqual(toGeminiSchema(TERMS_TOOL.input_schema));
    expect(geminiReq.contents[0].parts[0].text).toBe(claudeReq.messages[0].content[0].text);
    // And what it returned went through the same verification.
    const row = checks()[0];
    expect(row.po_terms_status).toBe("read");
    expect(row.model).toMatch(/^gemini/);
    expect(row.po_clauses.map((c) => c.text)).toEqual([PAYMENT, WARRANTY, JURISDICTION]);
  });

  it("is not asked when Claude answers", async () => {
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(calls("claude")).toHaveLength(1);
    expect(calls("gemini")).toHaveLength(0);
    expect(checks()[0].model).toMatch(/^claude/);
  });
});

// ── before migration 250 ─────────────────────────────────────────────────────

describe("a database without migration 250", () => {
  it("records 'not stored: migration 250 missing' and does not throw", async () => {
    const missing = { code: "42P01", message: "relation \"public.order_term_checks\" does not exist" };
    H.fail["order_term_checks:insert"] = missing;
    H.fail["order_term_checks:select"] = missing;
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out).toMatchObject({ status: "not_stored", reason: "migration_250_missing" });
    expect(out.result.po_clauses).toHaveLength(3);
    const ev = eventsOf("terms_pass_not_stored");
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ not_stored: "migration_250_missing", clauses: 3 });
  });

  it("reads a settings row with no terms_check_mode column as off, and sends nothing", async () => {
    seed({ settings: { tenant_id: TENANT, docai_daily_limits: null } });
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out).toMatchObject({ status: "off", reason: "migration_250_missing" });
    expect(calls()).toHaveLength(0);
  });

  it("does not swallow an unrelated store failure as a missing migration", async () => {
    H.fail["order_term_checks:insert"] = { code: "23503", message: "insert violates foreign key constraint on orders" };
    const out = await runOrderTermsPass(H.db, ctx, ORDER);
    expect(out).toMatchObject({ status: "not_stored", reason: "store_failed" });
  });
});

// ── re-runs ──────────────────────────────────────────────────────────────────

describe("a re-run on the same text", () => {
  it("reuses the stored clauses without a call, and supersedes the previous check", async () => {
    await runOrderTermsPass(H.db, ctx, ORDER);
    expect(calls()).toHaveLength(1);
    const second = await runOrderTermsPass(H.db, ctx, ORDER, { trigger: "manual" });
    expect(calls()).toHaveLength(1);
    expect(second.result.cached).toBe(true);
    const [first, latest] = checks();
    expect(first.superseded_at).toBeTruthy();
    expect(latest).toMatchObject({ trigger: "manual", po_terms_status: "read" });
    expect(latest.superseded_at ?? null).toBeNull();
    expect(latest.po_clauses).toEqual(first.po_clauses);
  });
});

// ── the entry the terms check calls ──────────────────────────────────────────

describe("runTermsPass, as the terms check (plan PR 12) calls it", () => {
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
    expect(eventsOf("terms_pass_stored")).toHaveLength(0);
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
  });

  it("does not run for a tenant that is off, whatever mode the caller passes", async () => {
    seed({ mode: "off" });
    const r = await call({ mode: "on" });
    expect(r.status).toBe("off");
    expect(calls()).toHaveLength(0);
  });

  it("never throws: a read that broke is not_read", async () => {
    H.throwOn = "documents";
    const r = await call();
    expect(r).toMatchObject({ po_terms_status: "not_read", reason: "pass_failed" });
    expect(calls()).toHaveLength(0);
  });
});

// ── where it runs ────────────────────────────────────────────────────────────

describe("after the server-side reconcile", () => {
  const PO_LINES = [{ line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 250 }];
  const withQuote = () => ({
    quotes: [{ id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-TEST-1", created_at: "2026-09-01T00:00:00Z", status: "SENT", terms: "60 days credit" }],
    quote_lines: [{ quote_id: "q1", tenant_id: TENANT, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, discounted_unit_price: 250 }],
    item_customer_parts: [],
    item_master: [],
  });
  const seedOrder = (mode) => {
    seed({ mode, extra: withQuote() });
    H.db.tables.orders[0].result = { salesOrder: { lineItems: PO_LINES } };
  };

  it("runs once the order is reconciled, and stores a check for it", async () => {
    seedOrder("on");
    const out = await autoReconcileOrder(H.db, ctx, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("reconciled");
    expect(out.terms).toMatchObject({ status: "stored" });
    expect(H.db.tables.orders[0].result.quoteReconciliation).toBeTruthy();
    expect(checks()).toHaveLength(1);
    expect(checks()[0]).toMatchObject({ trigger: "reconcile", order_id: ORDER, po_terms_status: "read" });
  });

  it("sends nothing when the mode is off, and the reconcile is unchanged", async () => {
    seedOrder("off");
    const out = await autoReconcileOrder(H.db, ctx, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("reconciled");
    expect(out.terms).toMatchObject({ status: "off" });
    expect(calls()).toHaveLength(0);
    expect(checks()).toHaveLength(0);
  });

  it("never fails the reconcile when the pass throws", async () => {
    seedOrder("on");
    H.throwOn = "documents";
    const out = await autoReconcileOrder(H.db, ctx, ORDER, { trigger: "lines_changed" });
    expect(out.status).toBe("reconciled");
    expect(out.terms).toMatchObject({ status: "failed", mode: "on" });
    expect(H.db.tables.orders[0].result.quoteReconciliation).toBeTruthy();
    expect(eventsOf("terms_pass_failed")).toHaveLength(1);
    expect(checks()).toHaveLength(0);
  });
});
