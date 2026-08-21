// Anvil must never re-read, and must never overwrite, a quote it wrote itself.
//
// The bug these cover was live and silent: attaching the quote PDF Anvil
// generated ran it through a model, matched the extracted number to the real
// quote row, DELETED that quote's hand-authored lines and inserted the model's
// reading in their place — then reported a successful ingest.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseQuoteRef, isAuthoredInAnvil, findSelfIssuedQuote } from "../api/_lib/quote-provenance.js";
import { ingestQuote } from "../api/_lib/quote-ingest.js";

const CTX = { tenantId: "t1", user: { id: "u1" } };

// A recording fake: the point of every ingest test below is WHICH writes did
// and did not happen, so the double records calls rather than returning
// plausible data.
const makeSvc = (quoteRow) => {
  const calls = [];
  const chain = (table) => {
    const rec = { table, op: null, payload: null };
    const self = {
      select: () => self,
      eq: () => self,
      is: () => self,
      order: () => self,
      limit: async () => ({ data: quoteRow ? [quoteRow] : [], error: null }),
      maybeSingle: async () => ({ data: quoteRow || null, error: null }),
      single: async () => ({ data: { id: "new-quote" }, error: null }),
      insert: (payload) => { rec.op = "insert"; rec.payload = payload; calls.push({ ...rec }); return self; },
      update: (payload) => { rec.op = "update"; rec.payload = payload; calls.push({ ...rec }); return self; },
      delete: () => { rec.op = "delete"; calls.push({ ...rec }); return self; },
    };
    return self;
  };
  return { from: (t) => chain(t), _calls: calls };
};

describe("parseQuoteRef", () => {
  it("reads our number out of the filename Anvil itself downloads as", () => {
    expect(parseQuoteRef("quote-Q-202608-0001.pdf")).toEqual({
      quote_number: "Q-202608-0001", version: null,
    });
  });

  it("reads the version the EMAILED pdf stamps, which the download does not", () => {
    expect(parseQuoteRef("Q-202608-0001 v2")).toEqual({
      quote_number: "Q-202608-0001", version: 2,
    });
  });

  it("does not match a near-miss shape", () => {
    // Six digits then four is the generateQuoteNumber contract; anything else
    // is somebody else's numbering that happens to start with Q.
    expect(parseQuoteRef("Q-2026-0001")).toBeNull();
    expect(parseQuoteRef("QUOTE-0001")).toBeNull();
  });

  it("survives junk without throwing — it runs on operator-supplied filenames", () => {
    for (const junk of [null, undefined, "", 42, "  ", "..pdf"]) {
      expect(() => parseQuoteRef(junk)).not.toThrow();
    }
  });
});

describe("isAuthoredInAnvil", () => {
  // Migration 188 states the contract: null = authored in Anvil.
  it("is true only for a row with no ingest_source", () => {
    expect(isAuthoredInAnvil({ ingest_source: null })).toBe(true);
    expect(isAuthoredInAnvil({ ingest_source: "document" })).toBe(false);
    expect(isAuthoredInAnvil({ ingest_source: "bulk" })).toBe(false);
    expect(isAuthoredInAnvil(null)).toBe(false);
  });
});

describe("findSelfIssuedQuote", () => {
  it("matches a quote this tenant authored", async () => {
    const svc = makeSvc({ id: "q1", quote_number: "Q-202608-0001", version: 2, status: "SENT", ingest_source: null });
    const r = await findSelfIssuedQuote(svc, "t1", { quote_number: "Q-202608-0001", version: null });
    expect(r.matched).toBe(true);
    expect(r.quote.id).toBe("q1");
  });

  it("does NOT match a row that was itself ingested — there is nothing to protect", async () => {
    const svc = makeSvc({ id: "q1", quote_number: "Q-202608-0001", version: 1, ingest_source: "document" });
    const r = await findSelfIssuedQuote(svc, "t1", { quote_number: "Q-202608-0001", version: null });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("previously_ingested");
  });

  it("does not match a number that resolves to nothing", async () => {
    // A customer PO may legitimately quote our number in its own text. The
    // filename is a hint; the row is the decision.
    const svc = makeSvc(null);
    const r = await findSelfIssuedQuote(svc, "t1", { quote_number: "Q-209901-9999", version: null });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("not_ours");
  });
});

describe("ingestQuote does not destroy an Anvil-authored quote", () => {
  const LINES = [{ part_no: "P-1", description: "model reading", unit_price: 10 }];

  it("writes NOTHING when the number resolves to a quote authored in Anvil", async () => {
    const svc = makeSvc({ id: "q1", status: "ACCEPTED", ingest_source: null });
    const report = await ingestQuote(svc, CTX, {
      customerId: "c1",
      quote: { quote_number: "Q-202608-0001", currency: "USD", grand_total: 999 },
      lines: LINES,
    });

    // This is the whole point: no delete of quote_lines, no update of the head.
    expect(svc._calls.filter((c) => c.op === "delete")).toHaveLength(0);
    expect(svc._calls.filter((c) => c.op === "update")).toHaveLength(0);
    expect(svc._calls.filter((c) => c.op === "insert")).toHaveLength(0);

    expect(report.matched_authored).toBe(true);
    expect(report.lines_written).toBe(0);
    // Not an error — the quote is present and in better shape than the PDF.
    expect(report.error).toBeNull();
    expect(report.quote_id).toBe("q1");
  });

  it("still re-ingests over a row that was previously ingested from a document", async () => {
    const svc = makeSvc({ id: "q1", status: "SENT", ingest_source: "document" });
    const report = await ingestQuote(svc, CTX, {
      customerId: "c1",
      quote: { quote_number: "Q-202608-0001" },
      lines: LINES,
    });
    expect(report.matched_authored).toBe(false);
    // A corrected third-party PDF must still replace the stale rows.
    expect(svc._calls.some((c) => c.table === "quote_lines" && c.op === "delete")).toBe(true);
    expect(svc._calls.some((c) => c.table === "quote_lines" && c.op === "insert")).toBe(true);
  });

  it("still creates a quote that does not exist yet", async () => {
    const svc = makeSvc(null);
    const report = await ingestQuote(svc, CTX, {
      customerId: "c1",
      quote: { quote_number: "Q-202608-0002" },
      lines: LINES,
    });
    expect(report.matched_authored).toBe(false);
    expect(svc._calls.some((c) => c.table === "quotes" && c.op === "insert")).toBe(true);
  });
});

describe("attach_quote wiring", () => {
  const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

  it("runs the self-issued check BEFORE it reads the extracted payload", () => {
    const src = read("src/api/orders/attach_quote.js");
    const check = src.indexOf("findSelfIssuedQuote");
    const useExtract = src.indexOf("const extracted = body?.extracted");
    expect(check).toBeGreaterThan(-1);
    expect(useExtract).toBeGreaterThan(-1);
    // If extraction were consulted first the model call would already have
    // been paid for, which is exactly what the preflight avoids.
    expect(check).toBeLessThan(useExtract);
  });

  it("answers a preflight with needs_extraction rather than 'could not be read'", () => {
    const src = read("src/api/orders/attach_quote.js");
    expect(src).toMatch(/needs_extraction:\s*true/);
    expect(src).toMatch(/extraction_attempted/);
  });

  it("stays compatible with a caller that sends no extraction_attempted flag", () => {
    // Old clients post {order_id, document_id, extracted} only. `undefined
    // !== false` keeps them on the original single-shot path instead of
    // bouncing them into a preflight they will never answer.
    const src = read("src/api/orders/attach_quote.js");
    expect(src).toMatch(/body\?\.extraction_attempted\s*!==\s*false/);
  });

  it("does not report ingested:true when the ingest guard kept the existing lines", () => {
    const src = read("src/api/orders/attach_quote.js");
    expect(src).toMatch(/const ingestedForReal = !authoredMatch/);
    expect(src).toMatch(/ingested: ingestedForReal/);
  });

  it("requires LINES to have landed before calling it an ingest", () => {
    // quotes_ok only counts reports without an error, and a head written with
    // zero lines carried no error — so this reported ingested:true with
    // lines_written:0 in production and told the operator a hollow quote had
    // been captured.
    const src = read("src/api/orders/attach_quote.js");
    expect(src).toMatch(/linesLanded = \(report\.lines_written \|\| 0\) > 0/);
    expect(src).toMatch(/ingestedForReal = [^;]*&&\s*linesLanded/);
  });

  it("the panel preflights before extracting", () => {
    const src = read("src/v3-app/components/QuotesStrip.tsx");
    const pre = src.indexOf("attachQuote?.(orderId, documentId, null, false)");
    const extract = src.indexOf('documents?.extract?.(file, { kind: "quote" })');
    expect(pre).toBeGreaterThan(-1);
    expect(extract).toBeGreaterThan(-1);
    expect(pre).toBeLessThan(extract);
  });
});
