// An uploaded quote keeps its incoterm, delivery terms and validity, and the
// reconciler reads them. Plan PR 10a, docs/SO_TERMS_AND_HANDOFF_SCOPE.md
// sections 2.5, 3.4 and 9.
//
// The extractor has always read these three off an uploaded quotation
// (QUOTE_TOOL), and quoteHeadFromExtract dropped them, so the incoterm check
// read the quote's rule out of its payment-terms text. Migration 250 gives
// `quotes` the columns. It is applied BY HAND, so every path here must also
// work on a database that does not have them yet: the ingest stores the quote
// without those three fields, and the reconciler compares as it did before.
//
// The in-memory database below answers like PostgREST: a write naming a
// column the table lacks fails with PGRST204, and a read naming one fails
// with 42703, each naming the column. Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/_lib/item-customer-parts.js", () => ({
  upsertCustomerPart: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));

import { ingestQuote, quoteHeadFromExtract } from "../api/_lib/quote-ingest.js";
import { reconcileOrderQuotes, QUOTE_TERM_COLUMNS, isMissingQuoteTermColumn } from "../api/_lib/order-reconcile.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CUSTOMER = "00000000-0000-0000-0000-0000000000c1";
const ORDER = "00000000-0000-0000-0000-0000000000b1";
const CTX = { tenantId: TENANT, user: { id: "u-1" } };

const QUOTE_COLUMNS_BEFORE_250 = [
  "id", "tenant_id", "customer_id", "quote_number", "version", "status", "currency",
  "grand_total", "terms", "notes", "revision", "revised_date", "source_document_id",
  "ingest_source", "updated_at", "sent_at", "created_at", "opportunity_id",
];
const MIGRATION_250 = ["incoterm", "delivery_terms", "validity_text", "terms_snapshot", "terms_snapshot_at"];

const SCHEMA = (with250) => ({
  quotes: new Set([...QUOTE_COLUMNS_BEFORE_250, ...(with250 ? MIGRATION_250 : [])]),
  quote_lines: null, item_master: null, orders: null, item_customer_parts: null,
});

const clone = (v) => JSON.parse(JSON.stringify(v));

// A PostgREST stand-in that knows each table's columns. null = any column.
const makeDb = ({ with250, seed = {} }) => {
  const schema = SCHEMA(with250);
  const tables = { quotes: [], quote_lines: [], item_master: [], orders: [], item_customer_parts: [], ...clone(seed) };
  const calls = [];
  let seq = 0;
  const from = (table) => {
    const filters = [];
    let op = "select";
    let cols = "*";
    let payload = null;
    let single = false;
    const known = schema[table];
    const missingIn = (names) => (known ? names.find((c) => !known.has(c)) : undefined);
    const run = () => {
      calls.push({ table, op, cols, payload: clone(payload) });
      const rows = tables[table];
      if (op === "insert" || op === "update") {
        const bad = missingIn(Object.keys(Array.isArray(payload) ? payload[0] || {} : payload || {}));
        if (bad) {
          return { data: null, error: { code: "PGRST204", message: "Could not find the '" + bad + "' column of '" + table + "' in the schema cache" } };
        }
      }
      if (op === "select") {
        const wanted = cols === "*" ? [] : cols.split(",").map((c) => c.trim()).filter(Boolean);
        const bad = missingIn(wanted);
        if (bad) return { data: null, error: { code: "42703", message: "column " + table + "." + bad + " does not exist" } };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: table + "-" + (++seq), ...clone(r) }));
        rows.push(...list);
        return { data: single ? list[0] : list, error: null };
      }
      if (op === "update") {
        for (const r of hit) Object.assign(r, clone(payload));
        return { data: clone(hit), error: null };
      }
      if (op === "delete") {
        tables[table] = rows.filter((r) => !hit.includes(r));
        return { data: null, error: null };
      }
      const pick = (r) => (cols === "*" ? clone(r) : Object.fromEntries(cols.split(",").map((c) => c.trim()).map((c) => [c, r[c] ?? null])));
      const out = hit.map(pick);
      return { data: single ? (out[0] || null) : out, error: null };
    };
    const api = {
      select(c) { if (op === "select") cols = c || "*"; return api; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
      in(c, vals) { filters.push((r) => vals.map(String).includes(String(r[c]))); return api; },
      not(c, _op, list) {
        const banned = String(list).replace(/[()]/g, "").split(",");
        filters.push((r) => !banned.includes(String(r[c])));
        return api;
      },
      is(c, v) { filters.push((r) => (r[c] ?? null) === v); return api; },
      order() { return api; },
      limit() { return api; },
      insert(p) { op = "insert"; payload = p; return api; },
      update(p) { op = "update"; payload = p; return api; },
      delete() { op = "delete"; return api; },
      maybeSingle() { single = true; return api; },
      single() { single = true; return api; },
      then: (f, r) => Promise.resolve(run()).then(f, r),
    };
    return api;
  };
  return { from, tables, calls };
};

// The normalized extract of an uploaded quotation, as the extractor returns it
// (docai/claude.js: the quote head fields ride next to the lines).
const EXTRACT = {
  classification: "quote",
  quote_number: "Q-TEST-250",
  quote_date: "2026-09-01",
  currency: "INR",
  grand_total: 2400,
  terms: "30 days from invoice",
  notes: "MOQ 10 per part",
  revision: "R1",
  incoterm: "FCA Chennai",
  delivery_terms: "11-12 weeks from receipt of order",
  validity: "One(1) Month",
  lines: [{ partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 600 }],
};

describe("quoteHeadFromExtract keeps the quote's terms", () => {
  it("keeps incoterm, delivery terms and the validity wording", () => {
    expect(quoteHeadFromExtract(EXTRACT)).toMatchObject({
      quote_number: "Q-TEST-250",
      terms: "30 days from invoice",
      incoterm: "FCA Chennai",
      delivery_terms: "11-12 weeks from receipt of order",
      validity_text: "One(1) Month",
    });
  });

  it("is null for each one the quote does not state", () => {
    const h = quoteHeadFromExtract({ quote_number: "Q-2" });
    expect(h.incoterm).toBeNull();
    expect(h.delivery_terms).toBeNull();
    expect(h.validity_text).toBeNull();
  });
});

describe("an uploaded quote stores its terms", () => {
  // The head as the bulk endpoint (POST /api/quotes/ingest) passes it: the
  // extracted head, plus a revision, so the test can see an older optional
  // column survive when only migration 250 is missing.
  const ingest = (svc) => ingestQuote(svc, CTX, {
    quote: { ...quoteHeadFromExtract(EXTRACT), revision: EXTRACT.revision },
    lines: EXTRACT.lines, customerId: CUSTOMER, sourceDocumentId: "doc-1",
  });

  it("never writes them onto a quote authored in Anvil", async () => {
    // ingest_source null means authored in Anvil (migration 188).
    const svc = makeDb({
      with250: true,
      seed: { quotes: [{ id: "q-own", tenant_id: TENANT, quote_number: "Q-TEST-250", version: 1, status: "DRAFT", ingest_source: null }] },
    });
    const r = await ingest(svc);
    expect(r.matched_authored).toBe(true);
    expect(svc.tables.quotes[0]).toEqual({ id: "q-own", tenant_id: TENANT, quote_number: "Q-TEST-250", version: 1, status: "DRAFT", ingest_source: null });
  });

  it("writes the three columns when migration 250 is applied", async () => {
    const svc = makeDb({ with250: true });
    const r = await ingest(svc);
    expect(r.error).toBeNull();
    expect(svc.tables.quotes[0]).toMatchObject({
      incoterm: "FCA Chennai",
      delivery_terms: "11-12 weeks from receipt of order",
      validity_text: "One(1) Month",
      terms: "30 days from invoice",
    });
  });

  it("updates them on a re-ingest", async () => {
    const svc = makeDb({ with250: true });
    await ingest(svc);
    await ingestQuote(svc, CTX, {
      quote: quoteHeadFromExtract({ ...EXTRACT, incoterm: "CIF Chennai" }),
      lines: EXTRACT.lines, customerId: CUSTOMER,
    });
    expect(svc.tables.quotes).toHaveLength(1);
    expect(svc.tables.quotes[0].incoterm).toBe("CIF Chennai");
  });

  it("still ingests without migration 250, and drops only those three", async () => {
    const svc = makeDb({ with250: false });
    const r = await ingest(svc);
    expect(r.error).toBeNull();
    expect(r.lines_written).toBe(1);
    const q = svc.tables.quotes[0];
    expect(q).toMatchObject({ terms: "30 days from invoice", notes: "MOQ 10 per part", revision: "R1", status: "SENT" });
    expect(q).not.toHaveProperty("incoterm");
    expect(q).not.toHaveProperty("delivery_terms");
    expect(q).not.toHaveProperty("validity_text");
  });

  it("re-ingests without migration 250 too (the update path)", async () => {
    const svc = makeDb({
      with250: false,
      seed: { quotes: [{ id: "q-old", tenant_id: TENANT, quote_number: "Q-TEST-250", version: 1, status: "SENT", ingest_source: "document" }] },
    });
    const r = await ingest(svc);
    expect(r.error).toBeNull();
    expect(svc.tables.quotes[0]).toMatchObject({ id: "q-old", terms: "30 days from invoice", revision: "R1" });
    expect(svc.tables.quotes[0]).not.toHaveProperty("incoterm");
  });

  it("does not hide a write error that is not a missing column", async () => {
    const svc = makeDb({ with250: true });
    const realFrom = svc.from;
    svc.from = (table) => {
      const b = realFrom(table);
      if (table !== "quotes") return b;
      const insert = b.insert;
      b.insert = (p) => { insert(p); b.then = (f) => Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }).then(f); return b; };
      return b;
    };
    const r = await ingest(svc);
    expect(r.error).toMatch(/quote insert: duplicate key/);
    expect(svc.tables.quote_lines).toHaveLength(0);
  });
});

// ── the reconciler ──────────────────────────────────────────────────────────

const orderRow = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, customer_id: CUSTOMER, status: "DRAFT", po_number: "PO-TEST-250",
  updated_at: "2026-09-30T00:00:00.000Z", quote_id: null, quote_number: null, rule_findings: [],
  incoterm_code: "FCA Chennai", delivery_terms: null,
  result: { salesOrder: { lineItems: [{ line_no: 1, partNumber: "PART-A", description: "Test bracket", quantity: 4, unitPrice: 600 }] } },
  ...over,
});
const quoteRow = (over = {}) => ({
  id: "q1", tenant_id: TENANT, customer_id: CUSTOMER, quote_number: "Q-TEST-250", version: 1,
  status: "SENT", created_at: "2026-09-01T00:00:00Z", terms: "30 days from invoice", ...over,
});
const QUOTE_LINE = { quote_id: "q1", tenant_id: TENANT, line_index: 0, part_no: "PART-A", description: "Test bracket", qty: 4, discounted_unit_price: 600 };

const seedFor = (order, quote) => ({ orders: [order], quotes: [quote], quote_lines: [QUOTE_LINE] });

// The reconciler's own read of the customer's quotes: the one that asks for
// the quote number. Other steps of the reconcile may read quotes for other
// columns (the opportunity link reads id and opportunity_id).
const quotePoolReads = (svc) =>
  svc.calls.filter((c) => c.table === "quotes" && c.op === "select" && /\bquote_number\b/.test(c.cols));

describe("the reconciler reads the quote's terms columns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads incoterm, delivery_terms and validity_text with the quotes", async () => {
    const svc = makeDb({
      with250: true,
      seed: seedFor(orderRow(), quoteRow({ incoterm: "FCA Chennai", delivery_terms: "4 weeks", validity_text: "30 days" })),
    });
    const out = await reconcileOrderQuotes(svc, CTX, ORDER);
    expect(out.status).toBe("reconciled");
    const reads = quotePoolReads(svc);
    expect(reads).toHaveLength(1);
    expect(reads[0].cols.split(",").map((c) => c.trim()))
      .toEqual(expect.arrayContaining([...QUOTE_TERM_COLUMNS, "terms"]));
  });

  it("leaves the reconcile result as it was: the select is the only change", async () => {
    // The terms check (plan PR 12) is what compares these columns. Until it
    // lands, the incoterm check still reads the quote's terms text.
    const seed = seedFor(orderRow({ incoterm_code: "FOB Busan" }), quoteRow({ incoterm: "FCA Chennai", terms: "FOB Busan, 30 days" }));
    const withCols = await reconcileOrderQuotes(makeDb({ with250: true, seed }), CTX, ORDER);
    const without = await reconcileOrderQuotes(makeDb({ with250: false, seed }), CTX, ORDER);
    expect(withCols.report.incoterms).toMatchObject({ verdict: "match", quote_code: "FOB" });
    expect(withCols.report).toEqual(without.report);
  });
});

describe("isMissingQuoteTermColumn", () => {
  it.each([
    [{ code: "42703", message: "column quotes.incoterm does not exist" }, true],
    [{ code: "PGRST204", message: "Could not find the 'validity_text' column of 'quotes' in the schema cache" }, true],
    [{ message: "column quotes.delivery_terms does not exist" }, true],
    [{ code: "42703", message: "column quotes.version_tag does not exist" }, false],
    [{ code: "23505", message: "duplicate key on incoterm" }, false],
    [null, false],
  ])("%j is %s", (err, want) => {
    expect(isMissingQuoteTermColumn(err)).toBe(want);
  });
});

describe("the reconciler without migration 250", () => {
  it("reconciles, and reads the incoterm from the terms text as before", async () => {
    const svc = makeDb({
      with250: false,
      seed: seedFor(orderRow({ incoterm_code: "FOB Busan" }), quoteRow({ terms: "FOB Busan, 30 days credit" })),
    });
    const out = await reconcileOrderQuotes(svc, CTX, ORDER);
    expect(out.status).toBe("reconciled");
    expect(out.report.summary).toMatchObject({ total: 1, matched: 1 });
    expect(out.report.incoterms).toMatchObject({ verdict: "match", quote_code: "FOB" });
    // The first read named the new columns and was refused; the second did not.
    const reads = quotePoolReads(svc);
    expect(reads).toHaveLength(2);
    expect(reads[1].cols).not.toMatch(/incoterm/);
  });

  it("still fails loudly on a quotes read error that is not one of those columns", async () => {
    const svc = makeDb({ with250: true, seed: seedFor(orderRow(), quoteRow()) });
    const realFrom = svc.from;
    svc.from = (table) => {
      const b = realFrom(table);
      if (table === "quotes") {
        b.then = (f, r) => Promise.resolve({ data: null, error: { code: "42703", message: "column quotes.version_tag does not exist" } }).then(f, r);
      }
      return b;
    };
    await expect(reconcileOrderQuotes(svc, CTX, ORDER)).rejects.toThrow(/quotes read: column quotes.version_tag/);
  });
});
