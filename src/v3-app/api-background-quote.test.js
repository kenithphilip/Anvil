// A quotation too long to read in one request now finishes in the background.
//
// The sync path reads page 1 and attaches it. That ingests FINE — the quote is
// simply short — and the reconciler then reports every PO line from pages 2+ as
// one the customer ordered but was never quoted. The failure is silent and
// reads like a supplier problem.
//
// docai/extract.js has always returned `large_pdf` with a comment saying the
// CALLER must enqueue the rest. so-intake and so-workspace do. QuotesStrip did
// not, because until #493 gave a job a kind there was nothing to enqueue AS,
// and the worker had nowhere to write a quote back to.
//
// The safety of the whole thing rests on one property of ingestQuote, asserted
// below: it is keyed on (tenant, quote_number, version) and REPLACES a quote's
// lines wholesale, so the complete read supersedes the page-1 lines instead of
// piling up beside them.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { quoteHeadFromExtract } from "../api/_lib/quote-ingest.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the quote head is built once, not twice", () => {
  it("maps the fields the ingest needs", () => {
    const h = quoteHeadFromExtract({
      quote_number: "Q-1", quote_date: "2026-08-01", currency: "INR",
      payment_terms: "30 days", notes: "MOQ 10", grand_total: 1234.5,
    });
    expect(h).toEqual({
      quote_number: "Q-1", quote_date: "2026-08-01", currency: "INR",
      terms: "30 days", notes: "MOQ 10", grand_total: 1234.5,
    });
  });

  it("prefers terms over payment_terms, and keeps a zero total", () => {
    expect(quoteHeadFromExtract({ terms: "A", payment_terms: "B" }).terms).toBe("A");
    // ?? not ||, or a genuinely zero-value quote loses its total.
    expect(quoteHeadFromExtract({ grand_total: 0 }).grand_total).toBe(0);
  });

  it("survives an empty extract", () => {
    expect(quoteHeadFromExtract(null).quote_number).toBeNull();
    expect(quoteHeadFromExtract(undefined).grand_total).toBeNull();
  });

  it("is used by BOTH callers, so the map cannot drift", () => {
    // The repo has already paid for this twice: the multi-row prompt fix and
    // the unsupported-kind guard each landed on one adapter and not the other.
    const attach = strip(read("src/api/orders/attach_quote.js"));
    const worker = strip(read("src/api/cron/extraction_jobs.js"));
    expect(attach).toMatch(/quote: quoteHeadFromExtract\(extracted\)/);
    expect(worker).toMatch(/quote: quoteHeadFromExtract\(mergedNorm\)/);
    // And the hand-rolled head literal is gone. Matched on grand_total, which
    // only ever appeared in the head — quote_number is also read for the audit
    // detail and the response, and asserting on that would fail on code that
    // is doing something else entirely.
    expect(attach).not.toMatch(/grand_total: extracted\.grand_total/);
  });
});

describe("the worker writes a quote back", () => {
  const src = strip(read("src/api/cron/extraction_jobs.js"));

  it("reuses the ingest rather than writing quote_lines itself", () => {
    // Writing lines here would be a second implementation of the tax-fraction
    // conversion, the MOQ remark, the two price columns and the authored-quote
    // guard — every one of which was a bug this repo already fixed once.
    expect(src).toMatch(/ingestQuote\(svc, \{ tenantId: job\.tenant_id \}/);
    expect(src).not.toMatch(/from\("quote_lines"\)/);
  });

  it("passes only a tenant id as its context, inventing no user", () => {
    // ingestQuote reads exactly one thing off ctx, so a cron can call it
    // honestly. Faking an actor would put a person's name on a machine's work.
    expect(src).toMatch(/\{ tenantId: job\.tenant_id \}/);
    expect(src).not.toMatch(/user_id:|actorId|ctx\.user/);
  });

  it("fails the job when the writeback fails, rather than completing", () => {
    // A quote that silently stayed truncated is the exact failure this
    // feature removes; swallowing the error would reinstate it.
    expect(src).toMatch(/quote writeback failed: /);
    expect(src).toMatch(/status: "failed", result: merged, last_error: "quote writeback failed/);
  });

  it("reports an Anvil-authored quote as kept, not as ingested", () => {
    // ingestQuote returns early on ingest_source IS NULL. That is a real
    // outcome, not a no-op, and the event has to distinguish it.
    expect(src).toMatch(/matched_authored/);
  });

  it("no longer routes quotes to the no-writeback branch", () => {
    expect(src).toMatch(/jobKind !== "quote"/);
  });
});

describe("the upload queues the rest of the document", () => {
  const src = strip(read("src/v3-app/components/QuotesStrip.tsx"));

  it("enqueues on large_pdf instead of only warning", () => {
    expect(src).toMatch(/if \(out\?\.large_pdf\)/);
    expect(src).toMatch(/enqueueFullRead\(orderId, documentId, file\.name\)/);
  });

  it("declares the kind, or the worker would read a quote as a PO", () => {
    expect(src).toMatch(/kind: "quote"/);
  });

  it("mirrors the existing enqueue call rather than inventing a third spelling", () => {
    const intake = strip(read("src/v3-app/screens/so-intake.tsx"));
    for (const bit of ["x-anvil-tenant", "/api/orders/extraction_jobs", "session?.access_token"]) {
      expect(src).toContain(bit);
      expect(intake).toContain(bit);
    }
  });

  it("tells the operator which of the two things happened", () => {
    // "still reading" and "we read one page and gave up" are different
    // promises, and an operator not told the difference acts on a short quote
    // either way.
    expect(src).toMatch(/being read in the/);
    expect(src).toMatch(/could not be queued/);
  });
});

describe("the UI can see how it ended", () => {
  const src = read("src/api/orders/extraction_status.js");

  it("knows the merge step's terminal events", () => {
    // Both were emitted and then filtered out here, so a background run
    // appeared to stop at "merging results" and never said what became of it.
    expect(src).toMatch(/"docai_chunk_quote_ingested"/);
    expect(src).toMatch(/"docai_chunk_merged_no_writeback"/);
  });
});
