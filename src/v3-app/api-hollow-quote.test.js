// A quote head with no lines is not an ingest, and must never be reported as
// one.
//
// Observed in production on 2026-08-19. A real quotation was attached; the
// extractor returned line objects carrying none of part_no / description /
// customer_part_number; every one was dropped by toQuoteLineRow's filter; and
// ingestQuote wrote the HEAD anyway — quote number, currency, grand_total —
// with zero lines and no error. attach_quote read "no error" as success:
//
//   order_quote_attached  { "ingested": true, "lines_written": 0 }
//
// Two silent harms. The operator was told the upload worked. And the
// reconciler pools every non-cancelled quote for the customer, so the empty
// shell joined the pool and could never match anything — which is what
// "0/2 matched across 0 quote(s)" in that same audit log actually meant.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ingestQuote } from "../api/_lib/quote-ingest.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const CTX = { tenantId: "t1", user: { id: "u1" } };

// Records which tables were written to, because the whole question is whether
// anything was written at all.
const makeSvc = (existing = null, failLines = false) => {
  const calls = [];
  const chain = (table) => {
    const self = {
      select: () => self, eq: () => self, is: () => self, order: () => self,
      limit: async () => ({ data: existing ? [existing] : [], error: null }),
      maybeSingle: async () => ({ data: existing, error: null }),
      single: async () => ({ data: { id: "new-quote" }, error: null }),
      insert: (payload) => {
        calls.push({ table, op: "insert" });
        if (table === "quote_lines" && failLines) {
          return { ...self, then: (r) => r({ error: { message: "insert refused" } }) };
        }
        return self;
      },
      update: () => { calls.push({ table, op: "update" }); return self; },
      delete: () => { calls.push({ table, op: "delete" }); return self; },
      then: (r) => r({ error: null }),
    };
    return self;
  };
  return { from: (t) => chain(t), _calls: calls };
};

describe("a document that yields no usable lines writes NOTHING", () => {
  // Lines with a quantity and a price but no code and no description — which
  // is the shape that actually arrived.
  const HOLLOW = [{ quantity: 30, unitPrice: 1910 }, { quantity: 30, unitPrice: 840 }];

  it("does not create a quote head", async () => {
    const svc = makeSvc(null);
    const report = await ingestQuote(svc, CTX, {
      customerId: "c1",
      quote: { quote_number: "Q-EXT-1", currency: "INR", grand_total: 80850 },
      lines: HOLLOW,
    });
    expect(svc._calls).toHaveLength(0);
    expect(report.quote_id).toBeNull();
    expect(report.lines_written).toBe(0);
  });

  it("reports an error, so the caller cannot read it as success", async () => {
    const report = await ingestQuote(makeSvc(null), CTX, {
      customerId: "c1", quote: { quote_number: "Q-EXT-1" }, lines: HOLLOW,
    });
    expect(report.error).toBeTruthy();
    expect(report.error).toMatch(/no usable lines/i);
  });

  it("says how many lines the extractor claimed, so the gap is visible", async () => {
    const report = await ingestQuote(makeSvc(null), CTX, {
      customerId: "c1", quote: { quote_number: "Q-EXT-1" }, lines: HOLLOW,
    });
    // Two came in, none survived — that difference is the diagnosis.
    expect(report.lines_total).toBe(2);
    expect(report.lines_written).toBe(0);
  });

  it("does not damage an EXISTING quote by attempting a re-ingest", async () => {
    // The old code deleted the quote's lines before discovering it had
    // nothing to put back. Refusing before any write is what prevents that.
    const svc = makeSvc({ id: "q1", status: "SENT", ingest_source: "document" });
    await ingestQuote(svc, CTX, { customerId: "c1", quote: { quote_number: "Q-EXT-1" }, lines: HOLLOW });
    expect(svc._calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });
});

describe("a line with any one identifying field still ingests", () => {
  it("accepts a line with only a description", async () => {
    const svc = makeSvc(null);
    const report = await ingestQuote(svc, CTX, {
      customerId: "c1", quote: { quote_number: "Q-EXT-2" },
      lines: [{ description: "Socket", quantity: 30, unitPrice: 1872 }],
    });
    expect(report.error).toBeNull();
    expect(report.lines_written).toBe(1);
  });

  it("accepts a line with only the customer's own reference", async () => {
    const report = await ingestQuote(makeSvc(null), CTX, {
      customerId: "c1", quote: { quote_number: "Q-EXT-3" },
      lines: [{ customerPartNumber: "CUST-99", quantity: 1, unitPrice: 10 }],
    });
    expect(report.lines_written).toBe(1);
  });
});

describe("a failed line insert is not a success either", () => {
  it("reports the error and stops rather than continuing", async () => {
    const svc = makeSvc(null, /* failLines */ true);
    const report = await ingestQuote(svc, CTX, {
      customerId: "c1", quote: { quote_number: "Q-EXT-4" },
      lines: [{ partNumber: "A", quantity: 1, unitPrice: 10 }],
    });
    expect(report.error).toMatch(/quote_lines insert/);
    expect(report.lines_written).toBe(0);
    // The delete ran, so the quote now has no lines. Learning part mappings
    // from a quote whose lines were just destroyed would be worse than useless.
    expect(report.mappings_learned).toBe(0);
  });
});

describe("attach_quote agrees with the ingest", () => {
  const src = read("src/api/orders/attach_quote.js");

  it("only calls it ingested when lines actually landed", () => {
    expect(src).toMatch(/linesLanded = \(report\.lines_written \|\| 0\) > 0/);
    expect(src).toMatch(/ingestedForReal = [^;]*&&\s*linesLanded/);
  });

  it("explains why, rather than reporting a bare false", () => {
    expect(src).toMatch(/no priced lines could be read/i);
    expect(src).toMatch(/firstError/);
  });

  it("records the real outcome on the audit event", () => {
    // The audit line that exposed this said ingested:true, lines_written:0.
    expect(src).toMatch(/document_id: documentId, ingested: ingestedForReal/);
    expect(src).toMatch(/error: firstError/);
  });
});
