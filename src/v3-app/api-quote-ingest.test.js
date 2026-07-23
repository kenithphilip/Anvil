// Quote-document ingestion.
//
// The design constraints are as important as the happy path: this must be
// REDUNDANCY (an optional, additive source of identity) rather than a waterfall
// stage, and it must handle MANY quotes. So the tests below assert those
// properties directly — partial failure is reported not thrown, one bad quote
// never aborts a batch, re-ingest is idempotent, and a wrong/ambiguous mapping
// is refused rather than guessed.

import { describe, it, expect, vi } from "vitest";

vi.mock("../api/_lib/item-customer-parts.js", () => ({
  upsertCustomerPart: vi.fn(async () => ({ ok: true })),
}));

import { ingestQuote, ingestQuotes, toQuoteLineRow, mappableLines } from "../api/_lib/quote-ingest.js";
import { upsertCustomerPart } from "../api/_lib/item-customer-parts.js";
import { QUOTE_TOOL, QUOTE_SYSTEM_PROMPT } from "../api/_lib/docai/claude.js";

const CTX = { tenantId: "t1", user: { id: "u1" } };

// In-memory Supabase stand-in: enough to exercise upsert/replace semantics.
const makeSvc = (items = []) => {
  // resolveItems filters on tenant_id, so fixtures must carry it.
  const db = { quotes: [], quote_lines: [], item_master: items.map((i) => ({ tenant_id: "t1", ...i })) };
  const api = (table) => {
    let rows = [...(db[table] || [])];
    let pending = null, mode = "select", single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      insert: (p) => { mode = "insert"; pending = p; return b; },
      update: (p) => { mode = "update"; pending = p; return b; },
      delete: () => { mode = "delete"; return b; },
      then: (fn) => Promise.resolve(fn(run())),
    };
    const run = () => {
      if (mode === "insert") {
        const arr = Array.isArray(pending) ? pending : [pending];
        const made = arr.map((r, i) => ({ id: table + "-" + (db[table].length + i + 1), ...r }));
        db[table].push(...made);
        return { data: single ? made[0] : made, error: null };
      }
      if (mode === "update") {
        for (const r of db[table]) if (rows.some((x) => x.id === r.id)) Object.assign(r, pending);
        return { data: null, error: null };
      }
      if (mode === "delete") {
        const ids = new Set(rows.map((r) => r.id));
        db[table] = db[table].filter((r) => !ids.has(r.id));
        return { data: null, error: null };
      }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  };
  return { db, from: api };
};

// One line straight off a real quotation layout.
const LINE = {
  partNumber: "THB-L1-70B-2",          // ours
  customerPartNumber: "3-380153-2",    // theirs (drawing / customer number)
  description: "Bend Adapter",
  quantity: 1, uom: "Nos", unitPrice: 9790, hsn: "85159000", cgst_pct: 9, sgst_pct: 9,
};
const QUOTE = { quote_number: "Q-1", quote_date: "2025-12-10", currency: "INR", grand_total: 9790 };

describe("toQuoteLineRow / mappableLines", () => {
  it("maps an extracted line onto the quote_lines column shape", () => {
    expect(toQuoteLineRow(LINE, 0)).toMatchObject({
      line_index: 0, part_no: "THB-L1-70B-2", customer_part_number: "3-380153-2",
      description: "Bend Adapter", qty: 1, uom: "Nos", listed_unit_price: 9790, hsn_sac: "85159000",
    });
  });

  it("only lines carrying BOTH codes can teach identity", () => {
    const rows = [LINE, { partNumber: "X-1" }, { customerPartNumber: "C-1" }].map(toQuoteLineRow);
    expect(mappableLines(rows)).toHaveLength(1);
  });

  it("strips currency noise from numbers", () => {
    expect(toQuoteLineRow({ unitPrice: "₹ 9,790.00" }, 0).listed_unit_price).toBe(9790);
  });
});

describe("ingestQuote", () => {
  it("writes the quote + lines and learns the customer-part mapping", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "THB-L1-70B-2" }]);
    const r = await ingestQuote(svc, CTX, { quote: QUOTE, lines: [LINE], customerId: "c1" });
    expect(r.error).toBeNull();
    expect(r.lines_written).toBe(1);
    expect(r.mappings_learned).toBe(1);
    expect(upsertCustomerPart).toHaveBeenCalledWith(svc, expect.objectContaining({
      itemId: "i1", customerId: "c1",
      customerPartNumber: "3-380153-2",     // THEIR code becomes the lookup key
      createdVia: "quote_doc",
    }));
  });

  it("stores the quote as SENT so the existing reconciler pools it immediately", async () => {
    const svc = makeSvc([]);
    await ingestQuote(svc, CTX, { quote: QUOTE, lines: [LINE], customerId: "c1" });
    // reconcile_quotes.js excludes only CANCELLED, so SENT is eligible at once.
    expect(svc.db.quotes[0].status).toBe("SENT");
    expect(svc.db.quotes[0].ingest_source).toBe("document");
  });

  it("is idempotent — re-ingesting the same quote does not duplicate", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "THB-L1-70B-2" }]);
    const input = { quote: QUOTE, lines: [LINE], customerId: "c1" };
    await ingestQuote(svc, CTX, input);
    await ingestQuote(svc, CTX, input);
    expect(svc.db.quotes).toHaveLength(1);
    expect(svc.db.quote_lines).toHaveLength(1);   // replaced, not appended
  });

  it("REPORTS an unresolvable part instead of throwing (partial success is normal)", async () => {
    const svc = makeSvc([]);   // item master has nothing
    const r = await ingestQuote(svc, CTX, { quote: QUOTE, lines: [LINE], customerId: "c1" });
    expect(r.error).toBeNull();
    expect(r.lines_written).toBe(1);              // the quote is still captured
    expect(r.mappings_learned).toBe(0);
    expect(r.unresolved).toEqual([{ part_no: "THB-L1-70B-2", customer_part_number: "3-380153-2" }]);
  });

  it("refuses to guess: a line with no customer reference teaches nothing", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "THB-L1-70B-2" }]);
    const r = await ingestQuote(svc, CTX, {
      quote: QUOTE, customerId: "c1",
      lines: [{ partNumber: "THB-L1-70B-2", description: "Bend Adapter" }],
    });
    expect(r.lines_written).toBe(1);
    expect(r.mappings_learned).toBe(0);   // a wrong mapping is worse than none
  });

  it("still captures the quote when no customer is known", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "THB-L1-70B-2" }]);
    const r = await ingestQuote(svc, CTX, { quote: QUOTE, lines: [LINE], customerId: null });
    expect(r.lines_written).toBe(1);
    expect(r.mappings_learned).toBe(0);
    expect(r.skipped[0].reason).toMatch(/no customer_id/);
  });

  it("needs a quote_number to stay idempotent", async () => {
    const r = await ingestQuote(makeSvc(), CTX, { quote: {}, lines: [LINE], customerId: "c1" });
    expect(r.error).toMatch(/quote_number/);
  });
});

describe("ingestQuotes / many quotes at once", () => {
  it("ingests a batch and aggregates the report", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "A-1" }, { id: "i2", part_no: "B-1" }]);
    const out = await ingestQuotes(svc, CTX, [
      { quote: { quote_number: "Q-1" }, customerId: "c1", lines: [{ partNumber: "A-1", customerPartNumber: "CA-1" }] },
      { quote: { quote_number: "Q-2" }, customerId: "c1", lines: [{ partNumber: "B-1", customerPartNumber: "CB-1" }] },
    ]);
    expect(out.quotes_total).toBe(2);
    expect(out.quotes_ok).toBe(2);
    expect(out.mappings_learned).toBe(2);
    expect(svc.db.quotes).toHaveLength(2);
  });

  it("one bad quote never aborts the batch (back-catalogue imports must survive)", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "A-1" }]);
    const out = await ingestQuotes(svc, CTX, [
      { quote: {}, customerId: "c1", lines: [] },                                            // no quote_number
      { quote: { quote_number: "Q-2" }, customerId: "c1", lines: [{ partNumber: "A-1", customerPartNumber: "CA-1" }] },
    ]);
    expect(out.quotes_total).toBe(2);
    expect(out.quotes_ok).toBe(1);
    expect(out.mappings_learned).toBe(1);   // the good one still landed
  });

  it("order-independent: the same set converges regardless of sequence", async () => {
    const items = [{ id: "i1", part_no: "A-1" }, { id: "i2", part_no: "B-1" }];
    const a = { quote: { quote_number: "Q-1" }, customerId: "c1", lines: [{ partNumber: "A-1", customerPartNumber: "CA-1" }] };
    const b = { quote: { quote_number: "Q-2" }, customerId: "c1", lines: [{ partNumber: "B-1", customerPartNumber: "CB-1" }] };
    const fwd = makeSvc(items); await ingestQuotes(fwd, CTX, [a, b]);
    const rev = makeSvc(items); await ingestQuotes(rev, CTX, [b, a]);
    expect(fwd.db.quotes.map((q) => q.quote_number).sort()).toEqual(rev.db.quotes.map((q) => q.quote_number).sort());
    expect(fwd.db.quote_lines).toHaveLength(rev.db.quote_lines.length);
  });

  it("accepts a single object as well as an array", async () => {
    const svc = makeSvc([{ id: "i1", part_no: "A-1" }]);
    const out = await ingestQuotes(svc, CTX, { quote: { quote_number: "Q-9" }, customerId: "c1", lines: [] });
    expect(out.quotes_total).toBe(1);
  });
});

describe("quote extraction kind is entity-agnostic", () => {
  it("keeps OUR code and the CUSTOMER's reference in distinct fields", () => {
    const props = QUOTE_TOOL.input_schema.properties.lines.items.properties;
    expect(props.partNumber).toBeTruthy();
    expect(props.customerPartNumber).toBeTruthy();
    expect(props.customerPartNumber.description).toMatch(/customer/i);
  });

  it("instructs the model to leave an ambiguous code NULL rather than guess", () => {
    expect(QUOTE_SYSTEM_PROMPT).toMatch(/leave customerPartNumber NULL/i);
    expect(QUOTE_SYSTEM_PROMPT).toMatch(/wrong mapping is worse\s+than a missing one/i);
  });

  it("names no seller, buyer or template — columns are resolved by meaning", () => {
    for (const needle of ["OBARA", "MAHINDRA", "FAITH", "THB-L1", "OIQTLC"]) {
      expect(QUOTE_SYSTEM_PROMPT.toUpperCase()).not.toContain(needle);
    }
  });

  it("distinguishes a quote from a PO (opposite direction)", () => {
    expect(QUOTE_SYSTEM_PROMPT).toMatch(/A PO is NOT a quote/i);
    expect(QUOTE_TOOL.input_schema.properties.classification.enum).toEqual(["quote", "non_quote"]);
  });
});
