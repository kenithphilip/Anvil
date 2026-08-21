// Weight arrives from documents, not from a data-entry campaign.
//
// item_master.weight_kg has existed since migration 145 and is entirely empty
// — 1,000 items sampled from live data, zero with a weight — because nothing
// in the product can write one. So the freight allocator apportions an awarded
// bid by line VALUE, and the container estimator returns recommended_mode
// "none" for every real plan.
//
// A wrong weight is worse than none: it is stored once, no screen shows it,
// and it silently mis-apportions freight on every future quote for that part.
// So these tests are mostly about what the capture REFUSES.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { unitWeightFromLine, weightCandidates, toKg, MAX_PLAUSIBLE_UNIT_KG } from "../api/_lib/item-weight-capture.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("units", () => {
  it("converts the units a supplier actually prints", () => {
    expect(toKg(2.5, "kg")).toBe(2.5);
    expect(toKg(850, "g")).toBe(0.85);
    expect(toKg(1, "lb")).toBeCloseTo(0.4536, 4);
    expect(toKg(2, "t")).toBe(2000);
  });

  it("REFUSES an unrecognised unit rather than assuming kilograms", () => {
    // A pound silently treated as a kilo is a 2.2x error on every allocation
    // that part ever appears in.
    expect(toKg(2.5, "stone")).toBeNull();
    expect(toKg(2.5, "oz")).toBeNull();
  });

  it("treats a missing unit as kg, which is the printed default", () => {
    expect(toKg(2.5, null)).toBe(2.5);
  });

  it("rejects zero and negative", () => {
    expect(toKg(0, "kg")).toBeNull();
    expect(toKg(-1, "kg")).toBeNull();
  });
});

describe("basis — the ambiguity that would be invisible", () => {
  it("takes a per-unit weight as printed", () => {
    expect(unitWeightFromLine({ weight: 2.5, weight_uom: "kg", weight_basis: "per_unit" }).kg).toBe(2.5);
  });

  it("divides a line total by the quantity", () => {
    expect(unitWeightFromLine({ weight: 75, weight_uom: "kg", weight_basis: "line_total", quantity: 30 }).kg).toBe(2.5);
  });

  it("REFUSES a line total with no quantity to divide by", () => {
    expect(unitWeightFromLine({ weight: 75, weight_uom: "kg", weight_basis: "line_total" }))
      .toMatchObject({ kg: null, reason: "line_total_without_qty" });
  });

  it("REFUSES when the extractor could not tell which the column meant", () => {
    // A line total mistaken for a unit weight is wrong by the order quantity,
    // and nothing downstream can detect it.
    expect(unitWeightFromLine({ weight: 2.5, weight_uom: "kg" }))
      .toMatchObject({ kg: null, reason: "ambiguous_basis" });
  });

  it("REFUSES an implausible per-unit magnitude", () => {
    // A part heavier than a tonne is possible; inferring one from a PDF
    // without a human is not.
    expect(unitWeightFromLine({ weight: MAX_PLAUSIBLE_UNIT_KG + 1, weight_uom: "kg", weight_basis: "per_unit" }).reason)
      .toBe("implausible_magnitude");
  });

  it("says nothing was printed, which is the normal case and not a failure", () => {
    expect(unitWeightFromLine({}).reason).toBe("no_weight_stated");
    expect(unitWeightFromLine(null).reason).toBe("no_line");
  });
});

describe("candidates from a document", () => {
  it("keeps only lines with a part number AND a usable weight", () => {
    const { candidates } = weightCandidates([
      { partNumber: "A", weight: 2.5, weight_uom: "kg", weight_basis: "per_unit" },
      { partNumber: "B" },
      { weight: 9, weight_uom: "kg", weight_basis: "per_unit" },
    ]);
    expect(candidates).toEqual([{ part_no: "A", weight_kg: 2.5 }]);
  });

  it("reports a REFUSED weight but not an absent one", () => {
    // "No weight column" is the normal case; "we saw a weight and would not
    // trust it" is worth surfacing.
    const { skipped } = weightCandidates([
      { partNumber: "A", weight: 2.5, weight_uom: "kg" },
      { partNumber: "B" },
    ]);
    expect(skipped).toEqual([{ part_no: "A", reason: "ambiguous_basis" }]);
  });

  it("keeps the FIRST of a repeated part, not the last", () => {
    const { candidates } = weightCandidates([
      { partNumber: "A", weight: 2.5, weight_uom: "kg", weight_basis: "per_unit" },
      { partNumber: "a", weight: 9.9, weight_uom: "kg", weight_basis: "per_unit" },
    ]);
    expect(candidates).toEqual([{ part_no: "A", weight_kg: 2.5 }]);
  });
});

describe("the write", () => {
  const src = read("src/api/_lib/quote-ingest.js");

  it("fills a BLANK only, enforced in the query rather than by a prior read", () => {
    // Two documents ingesting concurrently must not race, and a value already
    // on the master is authoritative.
    expect(src).toMatch(/\.is\("weight_kg", null\)/);
  });

  it("records where the weight came from", () => {
    expect(src).toMatch(/weight_source: "document"/);
    expect(src).toMatch(/weight_document_id: sourceDocumentId/);
  });

  it("survives a database without migration 216", () => {
    // Applied by hand. PostgREST rejects the whole update over one unknown
    // column, and an optional enrichment must not take quote ingest down.
    expect(src).toMatch(/42703/);
    expect(src).toMatch(/update\(\{ weight_kg: c\.weight_kg \}\)/);
  });

  it("is best-effort — a quote ingests whether or not it carried weights", () => {
    expect(src).toMatch(/catch \(_e\) \{/);
  });

  it("reports what it learned and what it refused", () => {
    expect(src).toMatch(/weights_learned/);
    expect(src).toMatch(/report\.weights_skipped = skipped/);
  });
});

describe("the extractor asks for it safely", () => {
  const src = read("src/api/_lib/docai/claude.js");

  it("has slots for the value, the unit AND the basis", () => {
    expect(src).toMatch(/weight_uom: \{[^}]*enum: \["kg", "g", "lb", "t", null\]/);
    expect(src).toMatch(/weight_basis: \{[^}]*enum: \["per_unit", "line_total", null\]/);
  });

  it("tells the model never to estimate a weight", () => {
    // A guessed weight is worse than none, because it is stored and reused.
    expect(src).toMatch(/NEVER estimate a weight/);
  });

  it("tells it to return null when the basis is unclear", () => {
    expect(src).toMatch(/return null\. A line total mistaken for a unit/);
  });
});

describe("migration 216", () => {
  const sql = read("supabase/migrations/216_item_weight_provenance.sql");

  it("adds the provenance columns idempotently", () => {
    for (const c of ["weight_source", "weight_captured_at", "weight_document_id"]) {
      expect(sql).toMatch(new RegExp("add column if not exists " + c));
    }
  });

  it("indexes the parts still missing a weight, which is how coverage is chased", () => {
    expect(sql).toMatch(/where weight_kg is null/);
  });

  it("does not backfill or overwrite anything", () => {
    expect(sql).not.toMatch(/\bupdate\s+item_master\b/i);
  });
});
