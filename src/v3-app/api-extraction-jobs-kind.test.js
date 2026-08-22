// The background worker assumed every document was a purchase order.
//
// extraction_jobs has carried no kind since migration 117, so the worker had
// nothing to tell the adapter and the adapter fell back to its default: the PO
// schema. That was invisible while only POs could be queued — the enqueue
// handler requires an order_id and both callers are PO flows — but it made a
// guess load-bearing. PR #492 had to infer "po" from order_id, which is true
// today and silently wrong the moment anything else enqueues.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "../api/cron/extraction_jobs.js";
import { mergeChunkResults } from "../api/_lib/docai/chunked-extract.js";

const { kindOfJob, variantHintsFor } = __test;
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// Every place the permitted kinds are written down.
const kindsIn = (src, constraintName) => {
  const i = src.indexOf(constraintName);
  const open = src.indexOf("(", src.indexOf("check", i));
  const close = src.indexOf("));", open);
  return (src.slice(open, close).match(/'([a-z_]+)'/g) || []).map((q) => q.replace(/'/g, "")).sort();
};

describe("the three kind lists cannot drift apart", () => {
  // A job's kind ends up on the run it produces. Two lists that can drift are
  // two lists that will — and the failure is a CHECK violation that rejects
  // the whole insert, so the queue looks broken rather than the list looking
  // wrong.
  const runsSql = read("supabase/migrations/217_packing_list_kind.sql");
  const jobsSql = read("supabase/migrations/219_extraction_jobs_kind.sql");
  const handler = read("src/api/orders/extraction_jobs.js");

  const runsKinds = kindsIn(runsSql, "extraction_runs_extraction_kind_check");
  const jobsKinds = kindsIn(jobsSql, "extraction_jobs_extraction_kind_check");

  it("migration 219 permits exactly what extraction_runs permits", () => {
    expect(jobsKinds).toEqual(runsKinds);
    expect(jobsKinds).toContain("quote");
    expect(jobsKinds).toContain("packing_list");
  });

  it("the enqueue handler validates against the same list", () => {
    const block = handler.slice(handler.indexOf("const KNOWN_KINDS"));
    const declared = (block.slice(0, block.indexOf("]")).match(/"([a-z_]+)"/g) || [])
      .map((q) => q.replace(/"/g, "")).sort();
    expect(declared).toEqual(runsKinds);
  });

  it("permits null, because rows predating the column have no honest kind", () => {
    expect(jobsSql).toMatch(/extraction_kind is null or extraction_kind in/);
  });
});

describe("kindOfJob", () => {
  it("uses the column when it is there", () => {
    expect(kindOfJob({ extraction_kind: "quote", order_id: "o1" })).toBe("quote");
  });

  it("reads a pre-column row as po, which is what those rows were", () => {
    // Nothing but the PO flows could create one, so this is a statement about
    // history rather than a guess about the future.
    expect(kindOfJob({ order_id: "o1" })).toBe("po");
  });

  it("says nothing when it knows nothing", () => {
    expect(kindOfJob({})).toBeNull();
    expect(kindOfJob(null)).toBeNull();
  });
});

describe("the variant follows the job's kind, not the order", () => {
  const on = { docai_prompt_variants: true };

  it("does not put a po_extractor variant on a quote job", () => {
    // The po_extractor canary teaches multi-row PO table counting. On a
    // quotation it is guidance about a document that is not there.
    const quotes = Array.from({ length: 60 }, (_, i) => ({
      tenant_id: "t1", order_id: "o1", extraction_kind: "quote", document_id: "d" + i,
    }));
    expect(quotes.map((j) => variantHintsFor(j, on)).filter(Boolean)).toHaveLength(0);
  });

  it("still applies on a PO job", () => {
    const pos = Array.from({ length: 60 }, (_, i) => ({
      tenant_id: "t1", order_id: "o1", extraction_kind: "po", document_id: "d" + i,
    }));
    expect(pos.map((j) => variantHintsFor(j, on)).filter(Boolean).length).toBeGreaterThan(0);
  });
});

describe("the worker tells the adapter what it is reading", () => {
  const src = strip(read("src/api/cron/extraction_jobs.js"));

  it("passes expectedKind", () => {
    expect(src).toMatch(/expectedKind: kindOfJob\(job\)/);
  });

  it("omits it rather than defaulting, so the adapter owns that decision", () => {
    expect(src).toMatch(/kindOfJob\(job\) \? \{ expectedKind: kindOfJob\(job\) \} : \{\}/);
  });
});

describe("a non-PO merge cannot overwrite the order's lines", () => {
  const src = strip(read("src/api/cron/extraction_jobs.js"));

  it("gates the orders writeback on a PO-shaped kind", () => {
    // orders.result.salesOrder.lineItems is what the CUSTOMER ordered, and the
    // reconciler, the approval gate and the Tally push all read it. Writing a
    // quotation's lines there replaces the order's contents with another
    // document's.
    expect(src).toMatch(/const PO_SHAPED = new Set\(\["po", "rfq", "generic"\]\)/);
    expect(src).toMatch(/if \(orderId && PO_SHAPED\.has\(jobKind\)\)/);
  });

  it("completes rather than fails, and says so", () => {
    // The extraction succeeded; only the writeback is missing, and the merged
    // result is durable on extraction_jobs.result.
    expect(src).toMatch(/docai_chunk_merged_no_writeback/);
    expect(src).toMatch(/has no background writeback/);
  });
});

describe("the enqueue survives an unapplied migration", () => {
  const src = strip(read("src/api/orders/extraction_jobs.js"));

  it("retries without the column rather than refusing the job", () => {
    // A document that extracts on the PO schema beats one that never extracts.
    expect(src).toMatch(/42703/);
    expect(src).toMatch(/delete retry\.extraction_kind/);
  });

  it("rejects an unknown kind before the CHECK does", () => {
    // PostgREST rejects the statement, not the column, so a caller's typo
    // would look like the queue was broken.
    expect(src).toMatch(/unknown kind: /);
  });
});

describe("a thrown adapter no longer takes dispatchExtract with it", () => {
  const src = strip(read("src/api/_lib/docai/index.js"));

  it("assigns to lastFailure, not into a const's dead zone", () => {
    // `const last = best || lastFailure` is declared further down the SAME
    // block, so `last = {...}` in the adapter catch was a write into its
    // temporal dead zone: every adapter that THREW made dispatchExtract itself
    // throw "Cannot access 'last' before initialization", discarding attempts,
    // best and salvagedRaw with it.
    expect(src).toMatch(/lastFailure = \{ ok: false, reason: "adapter_threw"/);
    expect(src).not.toMatch(/\n\s+last = \{ ok: false, reason: "adapter_threw"/);
  });

  it("leaves the two `last` bindings in their own scopes", () => {
    // There are legitimately two: a `let last` inside the GAEB fallback branch
    // and the `const last` tail of the main dispatch. They never shared a
    // scope — which is precisely why assigning to `last` from the main loop
    // hit the const, not the let.
    expect(src).toMatch(/const last = best \|\| lastFailure/);
    const mainCatch = src.slice(src.indexOf('reason: "adapter_threw"') - 200, src.indexOf('reason: "adapter_threw"') + 60);
    expect(mainCatch).not.toMatch(/\blast =/);
  });
});

describe("a capped tenant is told about the cap, not about credentials", () => {
  const src = strip(read("src/api/_lib/docai/index.js"));
  const worker = strip(read("src/api/cron/extraction_jobs.js"));

  it("names the budget when every adapter was capped", () => {
    // This returned "no docai adapter configured", so an operator whose own
    // daily limit stopped the run went looking for a credential problem that
    // did not exist.
    expect(src).toMatch(/allOverBudget/);
    expect(src).toMatch(/every adapter is over its daily budget: /);
  });

  it("reports it as skipped, not as unconfigured", () => {
    expect(src).toMatch(/\(allSkipped \|\| allOverBudget\) \? "all_adapters_skipped" : "no_adapter_configured"/);
  });

  it("the worker prefers the specific reason over the catch-all", () => {
    // Shipped the other way round in #492, which let the generic error win and
    // left the branch written for the capped case dead in exactly that case.
    expect(worker).toMatch(/chunkErr = \(overBudget\.length \? "over daily budget: /);
  });
});

// Telling the adapter the kind is worth nothing if the adapter ignores it,
// and carrying the kind through is worth nothing if the merge drops the
// fields that kind is made of. Both were true.

describe("gemini refuses a kind it has no schema for", () => {
  const src = strip(read("src/api/_lib/docai/gemini.js"));

  it("has the guard its own comment claimed", () => {
    // The routing comment says "lockstep with claude.js". It was not: claude
    // grew this refusal in #485 after invoices were read as purchase orders,
    // and gemini kept falling through to PO_SCHEMA for quote, invoice,
    // eway_bill and packing_list — while being FIRST in the provider order,
    // so the unguarded adapter is the one that runs.
    expect(src).toMatch(/reason: "unsupported_kind"/);
    expect(src).toMatch(/expectedKind !== "po" && expectedKind !== "rfq" && expectedKind !== "generic"/);
  });

  it("refuses rather than defaulting, so the dispatcher can try another", () => {
    expect(src).toMatch(/No extraction schema for kind/);
  });

  it("still routes the kinds it does implement", () => {
    for (const k of ["SUPPLIER_ACK_SCHEMA", "ASSEMBLY_BOM_SCHEMA", "PART_DRAWING_SCHEMA"]) {
      expect(src).toContain(k);
    }
  });
});

describe("the multi-chunk merge keeps the head fields", () => {
  const src = strip(read("src/api/_lib/docai/chunked-extract.js"));

  it("no longer returns only classification/customer/lines", () => {
    // A background job chunks at five pages, so multi-chunk is the only case
    // that matters — and this dropped every per-kind header. A quotation lost
    // its quote_number, which ingestQuote refuses to proceed without.
    expect(src).toMatch(/normalized: \{ \.\.\.headFields, classification, customer, lines \}/);
  });

  it("keeps stated_line_count, the input the shortfall guard exists to read", () => {
    // checkLineCountShortfall compares the PO's own declared count against the
    // lines extracted — the guard written for the "6 of 190 lines" failure.
    // Dropping it here disabled that guard on exactly the long, multi-chunk
    // documents it was written for.
    expect(src).toMatch(/stated_line_count/);
  });

  it("takes the LARGEST stated_line_count, not the first", () => {
    // Each chunk can only report the highest serial IT can see, so the
    // document's declared count is the largest across chunks.
    const chunk = (i, extra) => ({
      ok: true, adapter_used: "gemini", confidence_overall: 0.9, confidences: {},
      normalized: { classification: "po", customer: { name: "ACME" }, lines: [{ partNumber: "P" + i }], ...extra },
    });
    const merged = mergeChunkResults(
      [chunk(1, { stated_line_count: 12, quote_number: "Q-1" }),
       chunk(2, { stated_line_count: 31 }),
       chunk(3, {})],
      [{ index: 0 }, { index: 1 }, { index: 2 }],
    );
    expect(merged.normalized.stated_line_count).toBe(31);
    // First non-null wins for everything else — page 1 carries the header.
    expect(merged.normalized.quote_number).toBe("Q-1");
    // And the fields that were already merged are untouched.
    expect(merged.normalized.lines).toHaveLength(3);
    expect(merged.normalized.customer).toEqual({ name: "ACME" });
  });
});
