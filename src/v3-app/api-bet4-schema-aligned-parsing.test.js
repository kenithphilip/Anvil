// Bet 4 regression tests: schema-aligned parsing (SAP).
//
// Covers the parseSchemaAligned helper end-to-end:
//   1. Repair primitives - fences, prose prefix/suffix, comma fix,
//      truncation, comments, unquoted keys
//   2. Public entry point - parse_method values, repairs list,
//      retries, validator + retry callback
//   3. Source-contract checks for the adapter + run.js + diagnostics
//      wiring (text-mode pulls in parseSchemaAligned, run.js
//      persists parse_method, cost_status surfaces parse_methods).
//   4. Migration columns + check constraint + index exist.
//
// Keeps the spec hermetic: no network, no DB, no LLM. Vitest only.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseSchemaAligned, __test as P } from "../api/_lib/docai/parse.js";

const SRC = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

// -------------------- repair primitives ---------------------------

describe("Bet 4 - parse.js repair primitives", () => {
  it("stripFences peels ```json fences", () => {
    const r = P.stripFences('```json\n{"a":1}\n```');
    expect(r.repair).toBe("fences");
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
  });

  it("stripFences peels bare ``` fences", () => {
    const r = P.stripFences('```\n{"a":1}\n```');
    expect(r.repair).toBe("fences");
  });

  it("stripFences is a no-op when no fence is present", () => {
    const r = P.stripFences('{"a":1}');
    expect(r.repair).toBeNull();
  });

  it("trimToObject drops prose prefix", () => {
    const r = P.trimToObject('Sure, here it is: {"a":1}');
    expect(r.repairs).toContain("prose_prefix");
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
  });

  it("trimToObject drops prose suffix", () => {
    const r = P.trimToObject('{"a":1}\nLet me know if you need anything else.');
    expect(r.repairs).toContain("prose_suffix");
    expect(JSON.parse(r.text)).toEqual({ a: 1 });
  });

  it("trimToObject handles both prefix and suffix together", () => {
    const r = P.trimToObject('Sure! {"a":1} -- done.');
    expect(r.repairs).toContain("prose_prefix");
    expect(r.repairs).toContain("prose_suffix");
  });

  it("trimToObject is string-aware and doesn't trim a } inside a quoted string", () => {
    const r = P.trimToObject('{"description":"M/s. Acme & Co {special}","qty":2}');
    expect(JSON.parse(r.text)).toEqual({
      description: "M/s. Acme & Co {special}",
      qty: 2,
    });
  });

  it("trimToObject closes a mid-array truncation", () => {
    const r = P.trimToObject('{"lines": [{"a": 1}, {"a"');
    expect(r.repairs).toContain("truncated");
    // The closer is best-effort; we assert it parses, not the
    // exact reconstructed value.
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  it("trimToObject closes an unterminated string at EOF", () => {
    const r = P.trimToObject('{"a": "unter');
    expect(r.repairs).toContain("truncated_string");
    expect(r.repairs).toContain("truncated");
    expect(() => JSON.parse(r.text)).not.toThrow();
  });

  it("stripTrailingCommas removes trailing commas in arrays", () => {
    const r = P.stripTrailingCommas('{"a":[1,2,3,]}');
    expect(r.repair).toBe("trailing_comma");
    expect(JSON.parse(r.text)).toEqual({ a: [1, 2, 3] });
  });

  it("stripTrailingCommas removes trailing commas in objects", () => {
    const r = P.stripTrailingCommas('{"a":1,"b":2,}');
    expect(r.repair).toBe("trailing_comma");
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 2 });
  });

  it("stripTrailingCommas leaves commas inside strings alone", () => {
    const input = '{"name":"Acme, Inc.","qty":3}';
    const r = P.stripTrailingCommas(input);
    expect(r.repair).toBeNull();
    expect(JSON.parse(r.text)).toEqual({ name: "Acme, Inc.", qty: 3 });
  });

  it("quoteUnquotedKeys quotes bare keys", () => {
    const r = P.quoteUnquotedKeys('{a: 1, b: 2}');
    expect(r.repair).toBe("unquoted_keys");
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 2 });
  });

  it("quoteUnquotedKeys does NOT touch values that look like keys", () => {
    // Inside a string value, the colon is just text. We must not
    // turn 'priority: high' into '"priority": high'.
    const r = P.quoteUnquotedKeys('{"note": "priority: high"}');
    expect(r.repair).toBeNull();
  });

  it("stripComments removes /* block */ comments", () => {
    const r = P.stripComments('{"a": 1, /* note */ "b": 2}');
    expect(r.repair).toBe("comments");
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 2 });
  });

  it("stripComments removes // line comments", () => {
    const r = P.stripComments('{"a": 1 // tail\n,"b": 2}');
    expect(r.repair).toBe("comments");
    expect(JSON.parse(r.text)).toEqual({ a: 1, b: 2 });
  });

  it("stripComments leaves '//' inside strings alone", () => {
    const r = P.stripComments('{"url": "https://x.test/path"}');
    expect(r.repair).toBeNull();
    expect(JSON.parse(r.text)).toEqual({ url: "https://x.test/path" });
  });
});

// -------------------- repairAndParse smoke ------------------------

describe("Bet 4 - repairAndParse composite repairs", () => {
  it("handles fence + trailing comma in one pass", async () => {
    const out = await parseSchemaAligned('```json\n{"a":[1,2,3,],}\n```');
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ a: [1, 2, 3] });
    expect(out.repairs).toContain("fences");
    expect(out.repairs).toContain("trailing_comma");
    expect(out.parse_method).toBe("sap_repaired");
  });

  it("handles prose prefix + comments + comma fix", async () => {
    const out = await parseSchemaAligned(
      'Sure, here it is:\n{"a": 1, /* unit */ "b": "kg",}\nDone.',
    );
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ a: 1, b: "kg" });
    expect(out.repairs).toContain("prose_prefix");
    expect(out.repairs).toContain("comments");
    expect(out.repairs).toContain("trailing_comma");
    expect(out.repairs).toContain("prose_suffix");
  });

  it("handles unquoted keys + comma in same payload", async () => {
    const out = await parseSchemaAligned('{a: 1, b: 2,}');
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ a: 1, b: 2 });
    expect(out.repairs).toContain("unquoted_keys");
    expect(out.repairs).toContain("trailing_comma");
  });

  it("handles a truncated array mid-line", async () => {
    const out = await parseSchemaAligned('{"lines": [{"part": "A"}, {"part": "B"');
    expect(out.ok).toBe(true);
    // We don't assert the partial last entry survives, just that
    // the top-level array is closed and the parse succeeds.
    expect(out.repairs).toContain("truncated");
  });

  it("emits parse_method=sap_repaired even when no repair was applied", async () => {
    const out = await parseSchemaAligned('{"a":1}');
    expect(out.ok).toBe(true);
    expect(out.parse_method).toBe("sap_repaired");
    expect(out.repairs).toEqual([]);
    expect(out.retries).toBe(0);
  });

  it("returns ok=false + parse_method=failed when the text is non-JSON garbage", async () => {
    const out = await parseSchemaAligned('not even close to json');
    expect(out.ok).toBe(false);
    expect(out.parse_method).toBe("failed");
  });
});

// -------------------- validator + retry ---------------------------

describe("Bet 4 - validator + retry callback", () => {
  const validator = (v) => v?.classification === "po" && Array.isArray(v?.lines)
    ? { ok: true }
    : { ok: false, errors: ["classification must be 'po' and lines must be an array"] };

  it("ok+validates produces parse_method=sap_repaired with empty repairs", async () => {
    const out = await parseSchemaAligned('{"classification":"po","lines":[]}', validator);
    expect(out.ok).toBe(true);
    expect(out.parse_method).toBe("sap_repaired");
    expect(out.retries).toBe(0);
  });

  it("validation failure + no retry callback returns ok=false", async () => {
    const out = await parseSchemaAligned('{"classification":"non_po"}', validator);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/validation/);
  });

  it("validation failure + retry callback that returns valid text -> sap_zod_retry", async () => {
    const out = await parseSchemaAligned(
      '{"classification":"non_po"}',
      validator,
      { retry: async () => '{"classification":"po","lines":[]}' },
    );
    expect(out.ok).toBe(true);
    expect(out.parse_method).toBe("sap_zod_retry");
    expect(out.retries).toBe(1);
  });

  it("parse failure + retry callback that returns valid text -> sap_zod_retry", async () => {
    const out = await parseSchemaAligned(
      'totally garbage with no json',
      null,
      { retry: async () => '{"classification":"po","lines":[]}' },
    );
    expect(out.ok).toBe(true);
    expect(out.parse_method).toBe("sap_zod_retry");
    expect(out.retries).toBe(1);
  });

  it("retry callback that returns null gives up gracefully", async () => {
    const out = await parseSchemaAligned(
      'not json',
      null,
      { retry: async () => null },
    );
    expect(out.ok).toBe(false);
    expect(out.parse_method).toBe("failed");
  });

  it("fromToolUse:true marks parse_method=tool_use and skips text-parse", async () => {
    const out = await parseSchemaAligned(
      { classification: "po", lines: [] },
      validator,
      { fromToolUse: true },
    );
    expect(out.ok).toBe(true);
    expect(out.parse_method).toBe("tool_use");
  });

  it("fromNativeStructured:true marks parse_method=native_structured", async () => {
    const out = await parseSchemaAligned(
      { classification: "po", lines: [] },
      null,
      { fromNativeStructured: true },
    );
    expect(out.ok).toBe(true);
    expect(out.parse_method).toBe("native_structured");
  });
});

// -------------------- source-contract regression -----------------

describe("Bet 4 - adapter wiring (source contract)", () => {
  const claudeSrc = SRC("src/api/_lib/docai/claude.js");
  const geminiSrc = SRC("src/api/_lib/docai/gemini.js");
  const runSrc    = SRC("src/api/_lib/docai/run.js");
  const costStatusSrc = SRC("src/api/docai/cost_status.js");
  const runsApiSrc = SRC("src/api/docai/runs.js");

  it("claude.js imports parseSchemaAligned", () => {
    expect(claudeSrc).toMatch(/from\s+["']\.\/parse\.js["']/);
    expect(claudeSrc).toMatch(/parseSchemaAligned/);
  });

  it("claude.js threads parse_method through the final success return", () => {
    expect(claudeSrc).toMatch(/parse_method:\s*parseMethod/);
    expect(claudeSrc).toMatch(/parse_repairs:\s*parseRepairs/);
    expect(claudeSrc).toMatch(/parse_retries:\s*parseRetries/);
  });

  it("claude.js falls back to SAP text-parse when tool_use is missing", () => {
    // Tightened so we don't accidentally regress to a hard
    // parse_failed on text-mode replies.
    expect(claudeSrc).toMatch(/parse_method:\s*"failed"/);
    expect(claudeSrc).toMatch(/parseSchemaAligned\(text\)/);
  });

  it("gemini.js routes the structured-output text through parseSchemaAligned", () => {
    expect(geminiSrc).toMatch(/from\s+["']\.\/parse\.js["']/);
    expect(geminiSrc).toMatch(/parseSchemaAligned\(text\)/);
    expect(geminiSrc).toMatch(/parse_method:\s*parseMethod/);
  });

  it("run.js persists parse_method on the extraction_runs row", () => {
    expect(runSrc).toMatch(/parse_method:\s*parseMethod/);
    expect(runSrc).toMatch(/parse_repairs:\s*parseRepairs/);
    expect(runSrc).toMatch(/parse_retries:\s*parseRetries/);
  });

  it("run.js surfaces parse fields on the runExtractionPipeline return", () => {
    expect(runSrc).toMatch(/parseMethod,\s*\n\s*parseRepairs,\s*\n\s*parseRetries/);
  });

  it("run.js aggregates parse_method across voter entries", () => {
    expect(runSrc).toMatch(/methodOrder/);
    expect(runSrc).toMatch(/worstMethod/);
  });

  it("cost_status.js queries extraction_runs.parse_method for the rollup", () => {
    expect(costStatusSrc).toMatch(/parse_method/);
    expect(costStatusSrc).toMatch(/parse_methods/);
    expect(costStatusSrc).toMatch(/failed_rate_window/);
    expect(costStatusSrc).toMatch(/sap_repair_rate_window/);
  });

  it("cost_status.js has an R7 rule that fires on > 1% parse-failed", () => {
    expect(costStatusSrc).toMatch(/parse_failed_rate_high/);
    expect(costStatusSrc).toMatch(/failed_rate_window > 0\.01/);
  });

  it("/api/docai/runs select list returns parse_method + parse_retries + parse_repairs", () => {
    expect(runsApiSrc).toMatch(/parse_method,\s*parse_retries,\s*parse_repairs/);
  });
});

// -------------------- migration regression -----------------------

describe("Bet 4 - migration 099", () => {
  const mig = SRC("supabase/migrations/099_extraction_runs_parse_method.sql");

  it("adds parse_method, parse_retries, parse_repairs columns", () => {
    expect(mig).toMatch(/add column if not exists parse_method text/);
    expect(mig).toMatch(/add column if not exists parse_retries smallint not null default 0/);
    expect(mig).toMatch(/add column if not exists parse_repairs text\[\] not null default '\{\}'::text\[\]/);
  });

  it("enforces the parse_method enum via CHECK constraint", () => {
    expect(mig).toMatch(/extraction_runs_parse_method_check/);
    for (const v of ["native_structured", "tool_use", "sap_repaired", "sap_zod_retry", "failed"]) {
      expect(mig).toMatch(new RegExp("'" + v + "'"));
    }
  });

  it("creates a partial index on (tenant_id, parse_method, finished_at)", () => {
    expect(mig).toMatch(/create index if not exists extraction_runs_parse_method_idx/);
    expect(mig).toMatch(/on extraction_runs \(tenant_id, parse_method, finished_at desc\)/);
    expect(mig).toMatch(/where parse_method is not null/);
  });

  it("documents the columns with COMMENT statements for the diagnostics tab", () => {
    expect(mig).toMatch(/comment on column extraction_runs\.parse_method/);
    expect(mig).toMatch(/comment on column extraction_runs\.parse_retries/);
    expect(mig).toMatch(/comment on column extraction_runs\.parse_repairs/);
  });
});
