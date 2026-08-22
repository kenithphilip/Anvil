// The background worker ran on nobody's settings.
//
// cron/extraction_jobs.js drains the queue that handles the LARGEST documents
// — anything over 40 pages is downscoped to page 1 synchronously and the full
// extraction is pushed here. It called dispatchExtract with a synthetic
// settings object, literally `{ tenant_id }`, so the most expensive and most
// failure-prone path in the product ran on defaults for everything.
//
// The sharpest consequence was not the missing prompt variant. It was the
// daily budget: allowedToCall reads settings.docai_daily_limits and returned
// "allowed" every time because the key was absent — while recordCall still
// fired with the tenant id. So background chunks INCREMENTED the counter they
// were exempt from, and one large PO could exhaust a tenant's day and block
// the interactive path, which does honour the cap.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { __test } from "../api/cron/extraction_jobs.js";

const { settingsForTenant, variantHintsFor } = __test;
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// tenantSettings does one maybeSingle() read and inserts when absent.
const svcReturning = (row, opts = {}) => {
  let reads = 0;
  const b = {
    select: () => b, eq: () => b, insert: () => b, single: () => b,
    maybeSingle: async () => { reads++; if (opts.throws) throw new Error("boom"); return { data: row, error: null }; },
  };
  return { from: () => b, _reads: () => reads };
};

describe("settingsForTenant", () => {
  it("returns the tenant's real settings", async () => {
    const row = { tenant_id: "t1", docai_provider_order: ["claude"], docai_daily_limits: { claude: 5 } };
    const s = await settingsForTenant(svcReturning(row), "t1", new Map());
    expect(s.docai_provider_order).toEqual(["claude"]);
    expect(s.docai_daily_limits).toEqual({ claude: 5 });
  });

  it("reads once per tenant per tick", async () => {
    // One read shared across every job and chunk the tick handles.
    const svc = svcReturning({ tenant_id: "t1" });
    const cache = new Map();
    await settingsForTenant(svc, "t1", cache);
    await settingsForTenant(svc, "t1", cache);
    await settingsForTenant(svc, "t1", cache);
    expect(svc._reads()).toBe(1);
  });

  it("falls back rather than stranding a job when the read fails", async () => {
    // A settings hiccup must never turn a document that would extract into one
    // that never does. Degrades to exactly the old synthetic object.
    const s = await settingsForTenant(svcReturning(null, { throws: true }), "t1", new Map());
    expect(s).toEqual({ tenant_id: "t1" });
  });

  it("always carries tenant_id, which the cost guard keys on", async () => {
    // allowedToCall / recordCall both read settings.tenant_id. A settings row
    // without it would make the counter tenant-less.
    const s = await settingsForTenant(svcReturning({ docai_provider_order: [] }), "t1", new Map());
    expect(s.tenant_id).toBe("t1");
  });
});

describe("variantHintsFor", () => {
  const job = { tenant_id: "t1", customer_id: "c1", order_id: "o1", document_id: "doc-1" };

  it("is silent unless the tenant opted in", () => {
    expect(variantHintsFor(job, { tenant_id: "t1" })).toBeNull();
    expect(variantHintsFor(job, { docai_prompt_variants: false })).toBeNull();
  });

  it("refuses when the kind cannot be known", () => {
    // extraction_jobs has no kind column. order_id is the honest inference —
    // this worker merges into orders.result.salesOrder, the PO shape. Without
    // an order there is nothing to say the document is a PO.
    expect(variantHintsFor({ ...job, order_id: null }, { docai_prompt_variants: true })).toBeNull();
  });

  it("hands over a variant when one applies", () => {
    // document_id is the split key, so every chunk of one document lands in
    // the same arm and the job is one observation rather than a blend.
    const on = { docai_prompt_variants: true };
    const docs = Array.from({ length: 60 }, (_, i) => ({ ...job, document_id: "doc-" + i }));
    const hits = docs.map((j) => variantHintsFor(j, on)).filter(Boolean);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.promptVariant.name).toBe("po_extractor");
      expect(Array.isArray(h.promptVariant.system_append)).toBe(true);
    }
  });

  it("is stable across ticks for the same document", () => {
    const on = { docai_prompt_variants: true };
    const a = variantHintsFor(job, on);
    const b = variantHintsFor(job, on);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("honours a tenant pin out of the experiment", () => {
    const pinned = { docai_prompt_variants: true, docai_prompt_pins: { po_extractor: "v1" } };
    const docs = Array.from({ length: 60 }, (_, i) => ({ ...job, document_id: "doc-" + i }));
    expect(docs.map((j) => variantHintsFor(j, pinned)).filter(Boolean)).toHaveLength(0);
  });
});

describe("the worker no longer synthesises settings", () => {
  const src = strip(read("src/api/cron/extraction_jobs.js"));

  it("passes real settings to dispatchExtract", () => {
    expect(src).not.toMatch(/settings: \{ tenant_id: job\.tenant_id \}/);
    expect(src).toMatch(/const settings = await settingsForTenant\(svc, job\.tenant_id, settingsCache\)/);
    expect(src).toMatch(/dispatchExtract\(\{[\s\S]{0,200}\n\s+settings,/);
  });

  it("shares one cache across the whole tick", () => {
    expect(src).toMatch(/const settingsCache = new Map\(\)/);
    expect(src).toMatch(/advanceJob\(svc, current, settingsCache\)/);
  });
});

describe("the merged extraction reaches extraction_runs", () => {
  const src = strip(read("src/api/cron/extraction_jobs.js"));

  it("resolves the run through the document, since the job has no run column", () => {
    // extraction_jobs' linkage columns are exactly tenant_id, order_id,
    // customer_id, document_id, storage_path, created_by — no
    // extraction_run_id, no kind. extraction_runs.source_id IS the document
    // id, so the job resolves its own run with no migration.
    expect(src).toMatch(/from\("extraction_runs"\)[\s\S]{0,240}eq\("source_id", job\.document_id\)/);
  });

  it("skips a dedupe_hit run, same trap as the quote tab", () => {
    expect(src).toMatch(/status_reason !== "dedupe_hit"/);
  });

  it("replaces field_confidences along with the extract", () => {
    // lineCountOf() derives the DPMO opportunity count from the lines[N] keys
    // in field_confidences. Writing the full document's lines while leaving
    // page 1's confidences would report page 1's line count against them.
    expect(src).toMatch(/normalized_extract: mergedNorm/);
    expect(src).toMatch(/field_confidences: merged\.confidences \|\| \{\}/);
  });

  it("records empty_lines the same way the sync pipeline does", () => {
    expect(src).toMatch(/status: mergedLines\.length \? "ok" : "failed"/);
    expect(src).toMatch(/status_reason: mergedLines\.length \? "ok" : "empty_lines"/);
  });

  it("guards prompt_version against the unapplied-migration case", () => {
    expect(src).toMatch(/42703/);
    expect(src).toMatch(/delete retry\.prompt_version/);
  });

  it("never fails a job over telemetry", () => {
    // extraction_jobs.result is the durable record. A quality-telemetry write
    // must not turn a document that extracted fine into a failed job — and in
    // this worker ANY throw inside advanceJob is caught by the handler and
    // flips the job to 'failed'. Read unstripped: the intent is in the comment.
    const raw = read("src/api/cron/extraction_jobs.js");
    expect(raw).toMatch(/catch \(_e\) \{ \/\* telemetry only — never fail the job for it \*\/ \}/);
  });

  it("wraps the whole telemetry block, not just the write", () => {
    // The resolve query can throw too — both live inside one try.
    expect(src).toMatch(/if \(job\.document_id\) \{\s*try \{\s*const runQ = await svc\.from\("extraction_runs"\)/);
  });
});

describe("a refused chunk says why", () => {
  const src = strip(read("src/api/cron/extraction_jobs.js"));

  it("captures a not-ok dispatch, which does not throw", () => {
    // last_error was only ever set from a caught exception, so a chunk that
    // failed because every adapter declined recorded nothing.
    expect(src).toMatch(/if \(!chunkOk\) \{/);
    expect(src).toMatch(/chunkErr = out\?\.error/);
  });

  it("names the budget explicitly — the failure this change makes possible", () => {
    // Enforcing docai_daily_limits here is correct, but it introduces a way
    // for a chunk to be refused that did not exist before.
    expect(src).toMatch(/skipped_over_budget/);
    expect(src).toMatch(/over daily budget: /);
  });
});
