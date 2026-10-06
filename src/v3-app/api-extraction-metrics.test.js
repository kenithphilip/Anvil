// EXTRACTION_QUALITY PR 2 — extraction metrics in the governed Metric Catalog.
//
// The catalog is the only surface the copilot may quote a number from, and it
// held 22 metrics and zero about extraction: you could ask Anvil for overdue
// AR but not whether the machine that reads your purchase orders was getting
// better. These tests cover the pure reducers (the math), the fetch → reduce
// wiring, and the two guards that make the numbers honest: in-flight runs must
// not move a rate, and no prompt version may be crowned on thin volume.

import { describe, it, expect } from "vitest";
import {
  defectRate, runOutcomes, parseHealth, promptVersionSlices,
  promptVersionKey, isShipped, isFinished, lineCountOf, sigmaFromDpmo,
  evidenceOf, UNRECORDED_PROMPT,
} from "../api/_lib/extraction-kpis.js";
import { METRICS, listMetrics, getMetric, computeMetric } from "../api/_lib/metrics/catalog.js";

const NOW = Date.parse("2026-08-22T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

// A shipped run with `n` extracted lines.
const run = (id, n, over = {}) => ({
  id,
  status: "ok",
  status_reason: "ok",
  extraction_kind: "po",
  finished_at: daysAgo(1),
  field_confidences: Object.fromEntries(
    [["overall", 0.9]].concat(Array.from({ length: n }, (_, i) => [`lines[${i}]`, 0.9])),
  ),
  ...over,
});

const makeSvc = (seed) => ({
  from: (table) => {
    const b = {
      select: () => b, eq: () => b, gte: () => b, order: () => b, limit: () => b,
      then: (r) => r({ data: seed[table] || [], error: null }),
    };
    return b;
  },
});

describe("what counts as a unit of production", () => {
  it("counts lines from the field_confidences keys the adapters write", () => {
    expect(lineCountOf(run("r", 3))).toBe(3);
    expect(lineCountOf({ field_confidences: { overall: 0.9 } })).toBe(0);
    expect(lineCountOf({})).toBe(0);
  });

  it("excludes replays and no-op runs from the denominator", () => {
    expect(isShipped(run("a", 2))).toBe(true);
    expect(isShipped(run("b", 2, { status_reason: "dedupe_hit" }))).toBe(false);
    expect(isShipped(run("c", 2, { status_reason: "non_po" }))).toBe(false);
    expect(isShipped(run("d", 0))).toBe(false);              // ok but read nothing
    expect(isShipped(run("e", 2, { status: "failed" }))).toBe(false);
  });

  it("treats an in-flight run as not yet an outcome", () => {
    expect(isFinished({ status: "running" })).toBe(false);
    expect(isFinished({ status: "ok" })).toBe(true);
    expect(isFinished({ status: null })).toBe(false);
  });
});

describe("defectRate — the six-sigma core", () => {
  const runs = [run("r1", 2), run("r2", 1)];
  // opportunities = (5 + 2×5) + (5 + 1×5) = 15 + 10 = 25

  it("counts distinct (run, field) corrections and dedups re-edits", () => {
    const d = defectRate(runs, [
      { extraction_run_id: "r1", field_path: "lines[0].quantity" },
      { extraction_run_id: "r1", field_path: "lines[0].quantity" }, // same field, edited twice
      { extraction_run_id: "r2", field_path: "po_number" },
    ]);
    expect(d.opportunities).toBe(25);
    expect(d.defects).toBe(2);
    expect(d.corrected_runs).toBe(2);
    expect(d.escape_rate).toBeCloseTo(2 / 25, 6);
    expect(d.dpmo).toBeCloseTo(80000, 0);
  });

  it("ignores corrections against runs that never shipped", () => {
    const d = defectRate(runs, [{ extraction_run_id: "not-in-window", field_path: "po_number" }]);
    expect(d.defects).toBe(0);
    expect(d.sigma).toBe(6);
  });

  it("reports zero, not NaN, when nothing shipped", () => {
    const d = defectRate([run("x", 0)], [{ extraction_run_id: "x", field_path: "po_number" }]);
    expect(d.opportunities).toBe(0);
    expect(d.escape_rate).toBe(0);
    expect(d.run_ids).toEqual([]);
  });

  it("keeps the sigma scale it inherited", () => {
    expect(sigmaFromDpmo(3.4)).toBeCloseTo(6, 1);
    expect(sigmaFromDpmo(66807)).toBeCloseTo(3, 1);
  });
});

describe("runOutcomes — in-flight runs must not move a rate", () => {
  const runs = [
    run("a", 1),
    run("b", 1, { status: "failed", status_reason: "image_pdf_no_text" }),
    run("c", 1, { status: "low_confidence", status_reason: "low_confidence" }),
    run("d", 1, { status: "running", status_reason: null }),
  ];

  it("divides by finished runs, not by every row", () => {
    const o = runOutcomes(runs);
    expect(o.finished).toBe(3);
    expect(o.running).toBe(1);
    expect(o.failure_rate).toBeCloseTo(33.33, 1);
    expect(o.review_rate).toBeCloseTo(33.33, 1);
  });

  it("keeps a failure taxonomy and leaves ok runs out of it", () => {
    const o = runOutcomes(runs);
    expect(o.reasons).toEqual({ image_pdf_no_text: 1, low_confidence: 1 });
  });
});

describe("parseHealth — the rollup cost_status computed and threw away", () => {
  it("rates failures over runs that reached the parser, and reports repairs separately", () => {
    const p = parseHealth([
      run("a", 1, { parse_method: "native_structured" }),
      run("b", 1, { parse_method: "sap_repaired", parse_retries: 1 }),
      run("c", 1, { parse_method: "sap_zod_retry", parse_retries: 2 }),
      run("d", 1, { parse_method: "failed", parse_retries: 3 }),
      run("e", 1, { parse_method: null }),          // never reached the parser
    ]);
    expect(p.parsed_runs).toBe(4);
    expect(p.parse_failure_rate).toBe(25);
    expect(p.repair_rate).toBe(50);
    expect(p.retries_per_run).toBeCloseTo(1.5, 2);
    expect(p.by_method.native_structured).toBe(1);
  });
});

describe("prompt attribution", () => {
  it("reads the object migration 124 declared, and the bare string already in production", () => {
    expect(promptVersionKey({ prompt_version: { name: "po_extractor", version: "v2" } })).toBe("po_extractor@v2");
    expect(promptVersionKey({ prompt_version: { label: "po_extractor@v1" } })).toBe("po_extractor@v1");
    expect(promptVersionKey({ prompt_version: "po_extractor@v1" })).toBe("po_extractor@v1");
    expect(promptVersionKey({ prompt_version: null })).toBe(UNRECORDED_PROMPT);
    expect(promptVersionKey({})).toBe(UNRECORDED_PROMPT);
  });

  it("refuses to crown a version on thin volume", () => {
    const v1 = Array.from({ length: 3 }, (_, i) => run("v1-" + i, 1, { prompt_version: { name: "po_extractor", version: "v1" } }));
    const v = promptVersionSlices(v1, []);
    expect(v.comparable_versions).toBe(0);
    expect(v.best).toBeNull();
    expect(v.lift_pct).toBeNull();
    expect(v.versions[0].shipped_runs).toBe(3);   // still reported, just not comparable
  });

  it("names the unattributable history instead of quietly dropping it", () => {
    const rows = [run("old-1", 1), run("old-2", 1)];       // no prompt_version
    const v = promptVersionSlices(rows, []);
    expect(v.unrecorded_runs).toBe(2);
    expect(v.versions[0].prompt_version).toBe(UNRECORDED_PROMPT);
    expect(v.versions[0].comparable).toBe(false);
  });

  it("measures the lift between two versions with enough volume", () => {
    const mk = (ver, n) =>
      Array.from({ length: n }, (_, i) => run(`${ver}-${i}`, 1, { prompt_version: { name: "po_extractor", version: ver } }));
    const runs = [...mk("v1", 20), ...mk("v2", 20)];
    // v1: 4 corrected fields; v2: 1. opportunities per version = 20 × (5+5) = 200.
    const corrections = [
      ...Array.from({ length: 4 }, (_, i) => ({ extraction_run_id: `v1-${i}`, field_path: "po_number" })),
      { extraction_run_id: "v2-0", field_path: "po_number" },
    ];
    const v = promptVersionSlices(runs, corrections, { minRuns: 20 });
    expect(v.comparable_versions).toBe(2);
    expect(v.best).toBe("po_extractor@v2");
    expect(v.worst).toBe("po_extractor@v1");
    expect(v.lift_pct).toBeCloseTo(75, 0);       // 5000 dpmo vs 20000 dpmo
  });
});

describe("evidence — every number can be opened", () => {
  it("carries the run ids and admits when it truncated", () => {
    const e = evidenceOf(Array.from({ length: 40 }, (_, i) => "r" + i), "why");
    expect(e.table).toBe("extraction_runs");
    expect(e.total_runs).toBe(40);
    expect(e.run_ids.length).toBe(25);
    expect(e.truncated).toBe(true);
    expect(e.note).toBe("why");
  });
});

describe("the catalog entries", () => {
  const ids = [
    "extraction_defect_rate", "extraction_failure_rate", "extraction_review_rate",
    "extraction_parse_failure_rate", "extraction_runs_count", "extraction_prompt_version_lift",
  ];

  it("registers the extraction domain the copilot can now reach", () => {
    const list = listMetrics();
    expect(list.map((m) => m.id)).toEqual(expect.arrayContaining(ids));
    expect(new Set(list.map((m) => m.id)).size).toBe(list.length);
    for (const id of ids) {
      const m = getMetric(id);
      expect(m.domain).toBe("extraction");
      expect(m.params).toContain("window_days");
      expect(["percent", "count"]).toContain(m.unit);
    }
    // the pre-existing unit contract still holds across the whole catalog
    expect(METRICS.every((m) => ["currency", "count", "days", "percent"].includes(m.unit))).toBe(true);
  });

  it("computes the defect rate end to end, with provenance and evidence", async () => {
    const svc = makeSvc({
      extraction_runs: [run("r1", 2), run("r2", 1)],
      extraction_corrections: [{ extraction_run_id: "r1", field_path: "lines[0].quantity" }],
    });
    const ans = await computeMetric(svc, "t1", "extraction_defect_rate", { window_days: 30 }, NOW);
    expect(ans.unit).toBe("percent");
    expect(ans.value).toBeCloseTo(4, 2);              // 1 defect ÷ 25 opportunities
    expect(ans.denominator).toBe(25);
    expect(ans.breakdown.dpmo).toBe(40000);
    expect(ans.breakdown.by_kind.po.shipped_runs).toBe(2);
    expect(ans.evidence.run_ids).toEqual(["r1", "r2"]);
    expect(ans.provenance).toMatch(/LOWER BOUND/);
    expect(ans.window_days).toBe(30);
  });

  it("computes the failure and review rates over finished runs only", async () => {
    const rows = [
      run("a", 1),
      run("b", 1, { status: "failed", status_reason: "upstream_error" }),
      run("c", 1, { status: "low_confidence", status_reason: "low_confidence" }),
      run("d", 1, { status: "running" }),
    ];
    const fail = await computeMetric(makeSvc({ extraction_runs: rows }), "t1", "extraction_failure_rate", {}, NOW);
    expect(fail.denominator).toBe(3);
    expect(fail.count).toBe(1);
    expect(fail.evidence.run_ids).toEqual(["b"]);
    const review = await computeMetric(makeSvc({ extraction_runs: rows }), "t1", "extraction_review_rate", {}, NOW);
    expect(review.count).toBe(1);
    expect(review.evidence.run_ids).toEqual(["c"]);
  });

  it("computes parse health and document volume", async () => {
    const rows = [
      run("a", 1, { parse_method: "native_structured", extraction_kind: "po" }),
      run("b", 1, { parse_method: "failed", extraction_kind: "quote" }),
    ];
    const parse = await computeMetric(makeSvc({ extraction_runs: rows }), "t1", "extraction_parse_failure_rate", {}, NOW);
    expect(parse.value).toBe(50);
    const vol = await computeMetric(makeSvc({ extraction_runs: rows }), "t1", "extraction_runs_count", {}, NOW);
    expect(vol.value).toBe(2);
    expect(vol.breakdown.by_kind).toEqual({ po: 1, quote: 1 });
  });

  it("returns a null lift rather than a fabricated one when there is nothing to compare", async () => {
    const svc = makeSvc({ extraction_runs: [run("r1", 1)], extraction_corrections: [] });
    const ans = await computeMetric(svc, "t1", "extraction_prompt_version_lift", {}, NOW);
    expect(ans.value).toBeNull();
    expect(ans.count).toBe(0);
    expect(ans.evidence.note).toMatch(/fewer than two/);
  });

  it("survives an empty tenant without dividing by zero", async () => {
    const svc = makeSvc({});
    for (const id of ids) {
      const ans = await computeMetric(svc, "t1", id, {}, NOW);
      expect(ans.value === null || Number.isFinite(ans.value)).toBe(true);
      expect(ans.provenance).toBeTruthy();
      expect(ans.as_of).toBeTruthy();
    }
  });
});
