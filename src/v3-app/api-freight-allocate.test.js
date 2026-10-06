// Carrying an awarded freight bid into the price of a part.
//
// Anvil awards a real ocean bid against a consolidation (migration 145) and
// then prices customer quotes with a hand-typed shipping figure — freight_bids
// is referenced nowhere outside its own module. These cover the arithmetic
// that carries the awarded number across.
//
// The basis matters as much as the number. The obvious apportionment is by
// weight; item_master.weight_kg exists for exactly that and is EMPTY — 1,000
// items sampled from live data, zero with weight or volume — and no screen,
// importer or endpoint in the repo can write one. So the allocator uses the
// best basis AVAILABLE and always reports which, because "freight by weight"
// and "freight by value" are different commercial statements.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { allocateFreight, chooseBasis, BASES } from "../api/_lib/freight-allocate.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

// The real parts from a live consolidation lane.
const PARTS = [
  { part_no: "BP8/35", qty: 300, unit_price: 1872 },
  { part_no: "S8/M8-57AG", qty: 500, unit_price: 823 },
];

describe("choosing a basis", () => {
  it("prefers weight when every line has one", () => {
    const withW = PARTS.map((p, i) => ({ ...p, weight_kg: i === 0 ? 2.5 : 0.4 }));
    expect(chooseBasis(withW).basis).toBe("weight");
  });

  it("drops to value when weights are absent — which is today", () => {
    expect(chooseBasis(PARTS).basis).toBe("value");
  });

  it("drops to quantity when there is no price either", () => {
    expect(chooseBasis(PARTS.map((p) => ({ part_no: p.part_no, qty: p.qty }))).basis).toBe("quantity");
  });

  it("is ALL-OR-NOTHING per basis, never a mix", () => {
    // Weighting the costed lines by weight and the rest by value would load
    // one group twice and under-load the other — wrong in a way nobody sees.
    const partial = [{ ...PARTS[0], weight_kg: 2.5 }, PARTS[1]];
    expect(chooseBasis(partial).basis).toBe("value");
  });

  it("reports when nothing can carry every line", () => {
    expect(chooseBasis([{ part_no: "A" }]).basis).toBeNull();
    expect(chooseBasis([]).reason).toBe("no_lines");
  });

  it("ignores a zero weight rather than treating it as known", () => {
    // 0 kg is missing data, not a weightless part.
    expect(chooseBasis(PARTS.map((p) => ({ ...p, weight_kg: 0 }))).basis).toBe("value");
  });
});

describe("allocating", () => {
  it("splits the awarded total across the parts", () => {
    const a = allocateFreight(240000, PARTS, { currency: "INR" });
    expect(a.ok).toBe(true);
    expect(a.basis).toBe("value");
    expect(a.lines).toHaveLength(2);
  });

  it("RECONCILES exactly to the awarded total", () => {
    // Rounding each share independently loses paise, and a freight cost that
    // does not add up to the invoice is worse than an uneven one.
    for (const total of [240000, 100000.01, 7, 999999.99]) {
      const a = allocateFreight(total, PARTS);
      const sum = a.lines.reduce((s, l) => s + l.share, 0);
      expect(Math.round(sum * 100) / 100).toBe(Math.round(total * 100) / 100);
    }
  });

  it("returns a per-unit figure, which is what the pricing profile consumes", () => {
    // migration 135 seeds `shipping` as a per_unit adder in base currency.
    const a = allocateFreight(240000, PARTS);
    const bp = a.lines.find((l) => l.part_no === "BP8/35");
    expect(bp.per_unit).toBeCloseTo(bp.share / 300, 4);
  });

  it("upgrades itself to weight with no code change once weights exist", () => {
    // The whole point: coverage arrives from a packing list or a drawing, and
    // the allocation improves without anyone touching this.
    const withW = PARTS.map((p, i) => ({ ...p, weight_kg: i === 0 ? 2.5 : 0.4 }));
    const a = allocateFreight(240000, withW);
    expect(a.basis).toBe("weight");
    expect(a.approximate).toBe(false);
  });

  it("marks a value or quantity split as APPROXIMATE", () => {
    // So a consumer cannot present it with a precision the basis lacks.
    expect(allocateFreight(240000, PARTS).approximate).toBe(true);
  });

  it("refuses rather than splitting evenly when no basis works", () => {
    // An even split is a fifth basis nobody chose.
    const a = allocateFreight(240000, [{ part_no: "A" }]);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("no_common_basis");
    expect(a.lines).toEqual([]);
  });

  it("refuses when there is no awarded amount", () => {
    for (const t of [null, 0, -5, "abc"]) {
      expect(allocateFreight(t, PARTS).ok).toBe(false);
    }
  });

  it("survives a malformed line without throwing", () => {
    expect(() => allocateFreight(1000, [null, {}, { qty: "x" }])).not.toThrow();
  });
});

describe("the endpoint", () => {
  const src = read("src/api/logistics/freight_allocation.js");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("is read-only", () => {
    for (const w of [".insert(", ".update(", ".upsert(", ".delete("]) expect(code).not.toContain(w);
  });

  it("uses only the AWARDED bid", () => {
    expect(code).toMatch(/eq\("status", "awarded"\)/);
  });

  it("distinguishes 'no award yet' from 'awarded but unallocatable'", () => {
    // Most consolidations are open or bidding; that is not a failure.
    expect(code).toMatch(/awarded: false/);
    expect(code).toMatch(/reason: "no_awarded_bid"/);
  });

  it("flags an expired cost basis", () => {
    // A quote priced from a lapsed bid is a guess wearing a carrier's name.
    expect(code).toMatch(/expired: bid\.valid_until/);
  });

  it("reports dimension coverage, so the value basis is visibly a consequence", () => {
    expect(code).toMatch(/dimension_coverage/);
    expect(code).toMatch(/with_weight:/);
  });

  it("is routed", () => {
    const r = read("src/api/router.js");
    expect(r).toMatch(/"\/logistics\/freight_allocation":\s*logisticsFreightAllocation/);
  });
});
