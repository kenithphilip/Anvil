// Unit tests for explodePipelineThroughBom (P2 BOM-explode demand) in
// src/api/_lib/inventory/pipeline-demand.js. Pure function: cascades
// probability-weighted finished-good pipeline demand down the BOM into
// raw materials / components, multiplying by per-unit BOM quantities.

import { describe, it, expect } from "vitest";
import { explodePipelineThroughBom, computeCommittedDemand, buildBomAttributionIndex, topContributingOpps, computePipelineDemand } from "../api/_lib/inventory/pipeline-demand.js";

const wk = "2026-06-08";
const mk = (entries) => new Map(entries.map(([p, q]) => [p, new Map([[wk, q]])]));
const qtyOf = (pipeline, part) => (pipeline.get(part)?.get(wk) ?? null);

describe("explodePipelineThroughBom", () => {
  it("is inert with no BOM rows", () => {
    const p = mk([["GUN", 10]]);
    const out = explodePipelineThroughBom(p, []);
    expect(out.exploded).toBe(0);
    expect(p.size).toBe(1);
  });

  it("explodes single-level demand by the BOM quantity", () => {
    const p = mk([["GUN", 10]]);
    // each GUN consumes 2 STEEL bars + 1 ELECTRONICS module
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "STEEL", qty: 2 },
      { parent_part_no: "GUN", child_part_no: "ELEC", qty: 1 },
    ]);
    expect(qtyOf(p, "STEEL")).toBe(20);
    expect(qtyOf(p, "ELEC")).toBe(10);
    expect(qtyOf(p, "GUN")).toBe(10); // finished-good demand untouched
  });

  it("cascades multi-level with multiplied quantities", () => {
    const p = mk([["GUN", 10]]);
    // GUN → 2 ASSY; ASSY → 3 STEEL  ⇒ STEEL = 10*2*3 = 60
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "ASSY", qty: 2 },
      { parent_part_no: "ASSY", child_part_no: "STEEL", qty: 3 },
    ]);
    expect(qtyOf(p, "ASSY")).toBe(20);
    expect(qtyOf(p, "STEEL")).toBe(60);
  });

  it("aggregates a shared raw material across multiple finished goods", () => {
    const p = mk([["GUN", 10], ["ATD", 5]]);
    // both consume STEEL: GUN→2, ATD→4 ⇒ 10*2 + 5*4 = 40
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "STEEL", qty: 2 },
      { parent_part_no: "ATD", child_part_no: "STEEL", qty: 4 },
    ]);
    expect(qtyOf(p, "STEEL")).toBe(40);
  });

  it("adds component demand on top of a child's own direct demand", () => {
    // STEEL is itself demanded directly (5) AND consumed by GUN (10*2=20) ⇒ 25
    const p = mk([["GUN", 10], ["STEEL", 5]]);
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "STEEL", qty: 2 },
    ]);
    expect(qtyOf(p, "STEEL")).toBe(25);
  });

  it("does not double-count when a child is also a parent root", () => {
    // GUN(10) → ASSY(×2); ASSY also has its own direct demand (3).
    // ASSY → STEEL(×1).
    // STEEL = (GUN path) 10*2*1 + (ASSY direct) 3*1 = 23. ASSY = 20 + 3 = 23.
    const p = mk([["GUN", 10], ["ASSY", 3]]);
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "ASSY", qty: 2 },
      { parent_part_no: "ASSY", child_part_no: "STEEL", qty: 1 },
    ]);
    expect(qtyOf(p, "ASSY")).toBe(23);
    expect(qtyOf(p, "STEEL")).toBe(23);
  });

  it("survives a cyclic BOM without infinite looping", () => {
    const p = mk([["A", 1]]);
    const out = explodePipelineThroughBom(p, [
      { parent_part_no: "A", child_part_no: "B", qty: 1 },
      { parent_part_no: "B", child_part_no: "A", qty: 1 },
    ]);
    expect(out.exploded).toBeGreaterThan(0);
    expect(Number.isFinite(qtyOf(p, "B"))).toBe(true);
  });
});

describe("make/buy guard: a bought-out part is terminal (Slice D)", () => {
  it("a buy part receives part-level demand but is NOT cascaded into raw material", () => {
    // GUN(make) → BOUGHT_SUB(buy) ×1 → INNER ×5. INNER must stay null.
    const p = mk([["GUN", 10]]);
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "BOUGHT_SUB", qty: 1 },
      { parent_part_no: "BOUGHT_SUB", child_part_no: "INNER", qty: 5 },
    ], 8, { buyParts: new Set(["BOUGHT_SUB"]) });
    expect(qtyOf(p, "BOUGHT_SUB")).toBe(10); // bought whole — demanded at part level
    expect(qtyOf(p, "INNER")).toBeNull();    // never exploded into its innards
  });

  it("a make sibling still explodes normally alongside a guarded buy part", () => {
    const p = mk([["GUN", 10]]);
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "BOUGHT_SUB", qty: 1 },
      { parent_part_no: "BOUGHT_SUB", child_part_no: "INNER", qty: 5 },
      { parent_part_no: "GUN", child_part_no: "STEEL", qty: 2 }, // made -> raw material
    ], 8, { buyParts: new Set(["BOUGHT_SUB"]) });
    expect(qtyOf(p, "INNER")).toBeNull();
    expect(qtyOf(p, "STEEL")).toBe(20);
  });

  it("a buy ROOT is not exploded at all", () => {
    const p = mk([["BOUGHT", 4]]);
    explodePipelineThroughBom(p, [{ parent_part_no: "BOUGHT", child_part_no: "X", qty: 2 }], 8, { buyParts: new Set(["BOUGHT"]) });
    expect(qtyOf(p, "BOUGHT")).toBe(4);
    expect(qtyOf(p, "X")).toBeNull();
  });

  it("without buyParts, behaviour is unchanged (everything cascades)", () => {
    const p = mk([["GUN", 10]]);
    explodePipelineThroughBom(p, [
      { parent_part_no: "GUN", child_part_no: "SUB", qty: 1 },
      { parent_part_no: "SUB", child_part_no: "INNER", qty: 5 },
    ]);
    expect(qtyOf(p, "INNER")).toBe(50);
  });
});

describe("computeCommittedDemand (future SO schedule lines → part×week)", () => {
  it("buckets scheduled_qty by part_no and ISO week", () => {
    const out = computeCommittedDemand([
      { part_no: "GUN", scheduled_qty: 4, scheduled_date: "2026-06-10" }, // in week 2026-06-08
      { part_no: "GUN", scheduled_qty: 6, scheduled_date: "2026-06-11" }, // same week -> summed
      { part_no: "ATD", scheduled_qty: 3, scheduled_date: "2026-06-10" },
    ]);
    expect(qtyOf(out, "GUN")).toBe(10);
    expect(qtyOf(out, "ATD")).toBe(3);
  });

  it("drops rows with no part_no, non-positive qty, or bad date", () => {
    const out = computeCommittedDemand([
      { part_no: null, scheduled_qty: 5, scheduled_date: "2026-06-10" },
      { part_no: "X", scheduled_qty: 0, scheduled_date: "2026-06-10" },
      { part_no: "Y", scheduled_qty: 5, scheduled_date: "not-a-date" },
    ]);
    expect(out.size).toBe(0);
  });

  it("handles null / empty input", () => {
    expect(computeCommittedDemand(null).size).toBe(0);
    expect(computeCommittedDemand([]).size).toBe(0);
  });
});

describe("gap ②: a confirmed SO explodes committed demand into raw material", () => {
  it("cascades committed finished-good demand down the BOM like the pipeline", () => {
    // A confirmed order schedules 5 GUN for delivery. GUN consumes 2 STEEL + 1 ELEC.
    const committed = computeCommittedDemand([
      { part_no: "GUN", scheduled_qty: 5, scheduled_date: "2026-06-10" },
    ]);
    explodePipelineThroughBom(committed, [
      { parent_part_no: "GUN", child_part_no: "STEEL", qty: 2 },
      { parent_part_no: "GUN", child_part_no: "ELEC", qty: 1 },
    ]);
    expect(qtyOf(committed, "GUN")).toBe(5);    // the ordered finished good
    expect(qtyOf(committed, "STEEL")).toBe(10); // raw material now has firm committed demand
    expect(qtyOf(committed, "ELEC")).toBe(5);
  });
});

// -------------------------------------------------------------------
// PR: BOM-traced opportunity attribution.
const bom = (rows) => rows.map(([parent_part_no, child_part_no, qty]) => ({ parent_part_no, child_part_no, qty }));
const opp = (id, stage, probability, name) => ({ id, stage, probability, opportunity_name: name });
const pair = (o, lines) => ({ opp: o, lines });

describe("buildBomAttributionIndex", () => {
  it("maps a raw material to its finished-good ancestor with multiplier + path", () => {
    const idx = buildBomAttributionIndex(bom([["GUN", "STEEL", 3]]));
    expect(idx.get("STEEL")).toEqual([{ root: "GUN", mult: 3, path: ["GUN", "STEEL"] }]);
    expect(idx.get("GUN")).toBeUndefined(); // descendants only, never self
  });
  it("accumulates the cumulative multiplier across BOM levels", () => {
    const idx = buildBomAttributionIndex(bom([["GUN", "SUB", 2], ["SUB", "STEEL", 5]]));
    expect(idx.get("STEEL")).toEqual(expect.arrayContaining([
      { root: "GUN", mult: 10, path: ["GUN", "SUB", "STEEL"] },
      { root: "SUB", mult: 5, path: ["SUB", "STEEL"] },
    ]));
    expect(idx.get("SUB")).toEqual([{ root: "GUN", mult: 2, path: ["GUN", "SUB"] }]);
  });
  it("stops at a buy part — its raw material is not attributed (bought whole)", () => {
    const idx = buildBomAttributionIndex(bom([["GUN", "SUB", 2], ["SUB", "STEEL", 5]]), 8, { buyParts: new Set(["SUB"]) });
    expect(idx.get("SUB")).toEqual([{ root: "GUN", mult: 2, path: ["GUN", "SUB"] }]); // SUB still gets demand from GUN
    expect(idx.get("STEEL")).toBeUndefined();                                          // but STEEL under it is not
  });
  it("is empty for no BOM and terminates on a cycle", () => {
    expect(buildBomAttributionIndex([]).size).toBe(0);
    const idx = buildBomAttributionIndex(bom([["A", "B", 1], ["B", "A", 1]]));
    expect(idx.get("B")).toBeTruthy(); // no infinite loop
  });
});

describe("topContributingOpps", () => {
  it("credits a DIRECT sale of the part (unchanged behavior, no path)", () => {
    const pairs = [pair(opp("o1", "RFQ", 0.3, "Acme GUN order"), [{ part_no: "GUN", qty: 10 }])];
    const out = topContributingOpps(pairs, "GUN", null);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ opp_id: "o1", opportunity_name: "Acme GUN order", qty: 10, probability: 0.3, expected_qty: 3, via: [] });
  });
  it("credits an EXPLODED raw-material to the finished-good opp, with multiplier + BOM path", () => {
    const idx = buildBomAttributionIndex(bom([["GUN", "STEEL", 3]]));
    const pairs = [pair(opp("o1", "RFQ", 0.3, "Acme GUN order"), [{ part_no: "GUN", qty: 10 }])];
    const out = topContributingOpps(pairs, "STEEL", idx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ opp_id: "o1", qty: 30, expected_qty: 9, via: ["GUN → STEEL"] });
  });
  it("fabricates nothing: an exploded part with no attributing opp yields []", () => {
    const idx = buildBomAttributionIndex(bom([["GUN", "STEEL", 3]]));
    const pairs = [pair(opp("o1", "RFQ", 0.3, "x"), [{ part_no: "BOLT", qty: 5 }])];
    expect(topContributingOpps(pairs, "STEEL", idx)).toEqual([]);
  });
  it("uses the stage default when probability is unset, and ranks by expected_qty", () => {
    const pairs = [
      pair(opp("o1", "RFQ", null, "no-prob"), [{ part_no: "GUN", qty: 100 }]),         // 100 * 0.30 = 30
      pair(opp("o2", "NEGOTIATION_REVIEW", 0.5, "big"), [{ part_no: "GUN", qty: 80 }]), //  80 * 0.50 = 40
    ];
    const out = topContributingOpps(pairs, "GUN", null);
    expect(out.map((o) => o.opp_id)).toEqual(["o2", "o1"]);
    expect(out[1].probability).toBe(0.30); // RFQ stage default
  });
});

describe("attribution reconciles with real demand (no fabrication)", () => {
  it("sum of attributed expected_qty for an exploded part == its exploded pipeline demand", () => {
    // One opp sells 10 GUN at p=0.3, closing in week W. GUN consumes 3 STEEL.
    const W = "2026-06-10";
    const pairs = [{ opp: { id: "o1", stage: "RFQ", probability: 0.3, close_date: W, opportunity_name: "Acme" },
                     lines: [{ part_no: "GUN", qty: 10 }] }];
    const bomRows = bom([["GUN", "STEEL", 3]]);
    // engine path: pipeline demand -> explode
    const pipeline = computePipelineDemand({ pairs });
    explodePipelineThroughBom(pipeline, bomRows);
    const steelDemand = [...(pipeline.get("STEEL")?.values() || [])].reduce((s, q) => s + q, 0); // 10*0.3*3 = 9
    // attribution path
    const idx = buildBomAttributionIndex(bomRows);
    const top = topContributingOpps(pairs, "STEEL", idx);
    const attributed = top.reduce((s, o) => s + o.expected_qty, 0);
    expect(steelDemand).toBe(9);
    expect(attributed).toBeCloseTo(steelDemand, 6); // attribution == real demand, not invented
  });
});
