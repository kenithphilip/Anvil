// Unit tests for explodePipelineThroughBom (P2 BOM-explode demand) in
// src/api/_lib/inventory/pipeline-demand.js. Pure function: cascades
// probability-weighted finished-good pipeline demand down the BOM into
// raw materials / components, multiplying by per-unit BOM quantities.

import { describe, it, expect } from "vitest";
import { explodePipelineThroughBom } from "../api/_lib/inventory/pipeline-demand.js";

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
