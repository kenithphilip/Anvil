// A packing list is the only import document that can teach a per-part weight.
//
// item_master.weight_kg has been empty on every item since migration 145
// created it — 1,000 sampled from live data, zero with a weight — so the
// freight allocator (PR #481) apportions an awarded bid by line VALUE rather
// than by weight, and consolidatePlans returns recommended_mode "none" for
// every real plan.
//
// GRANULARITY is why it is this document and not another. A bill of lading
// gives one gross weight for a container; an invoice gives money. Only a
// packing list is per line, with the part number beside the weight.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { weightCandidates, unitWeightFromLine } from "../api/_lib/item-weight-capture.js";

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("net before gross", () => {
  it("takes NET when a row prints both", () => {
    // Net is the goods; gross includes the carton. This value is stored as
    // what the PART weighs, not as a shipping cost.
    const r = unitWeightFromLine({ weight: 2.5, gross_weight: 3.1, weight_uom: "kg", weight_basis: "per_unit" });
    expect(r.kg).toBe(2.5);
  });

  it("falls back to gross when only gross is printed", () => {
    const r = unitWeightFromLine({ gross_weight: 3.1, weight_uom: "kg", weight_basis: "per_unit" });
    expect(r.kg).toBe(3.1);
  });
});

describe("the header unit applies to rows that omit one", () => {
  it("uses the document's weight_uom when the row states none", () => {
    // Packing lists routinely print "KGS" once at the top. Defaulting to kg
    // instead would silently mis-scale a document printed in pounds.
    const r = unitWeightFromLine({ weight: 10, weight_basis: "per_unit" }, { weight_uom: "lb" });
    expect(r.kg).toBeCloseTo(4.536, 3);
  });

  it("lets a row's own unit win over the header", () => {
    const r = unitWeightFromLine({ weight: 500, weight_uom: "g", weight_basis: "per_unit" }, { weight_uom: "lb" });
    expect(r.kg).toBe(0.5);
  });

  it("threads the default through weightCandidates", () => {
    const { candidates } = weightCandidates(
      [{ partNumber: "A", weight: 10, weight_basis: "per_unit" }],
      { weight_uom: "lb" },
    );
    expect(candidates[0].weight_kg).toBeCloseTo(4.536, 3);
  });
});

describe("a realistic packing-list row", () => {
  it("divides a line total by the quantity", () => {
    // The usual shape: 30 pieces, 75 kg for the row.
    const { candidates } = weightCandidates([
      { partNumber: "BP8/35", quantity: 30, weight: 75, weight_basis: "line_total", packages: 3 },
    ], { weight_uom: "kg" });
    expect(candidates).toEqual([{ part_no: "BP8/35", weight_kg: 2.5 }]);
  });

  it("still REFUSES when the document did not say which basis", () => {
    // On a packing list the weight is usually the whole row — but "usually" is
    // not "always", and being wrong is invisible and permanent.
    const { candidates, skipped } = weightCandidates([
      { partNumber: "BP8/35", quantity: 30, weight: 75 },
    ], { weight_uom: "kg" });
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toBe("ambiguous_basis");
  });
});

describe("the extractor", () => {
  const src = read("src/api/_lib/docai/claude.js");

  it("has a packing-list tool that keeps net and gross apart", () => {
    expect(src).toMatch(/PACKING_LIST_TOOL/);
    expect(src).toMatch(/gross_weight: \{ type: \["number", "null"\]/);
  });

  it("uses the SAME weight slot names as the quote tool", () => {
    // So _lib/item-weight-capture.js consumes both without a second path.
    const tool = src.slice(src.indexOf("PACKING_LIST_TOOL"), src.indexOf("PART_DRAWING_TOOL"));
    for (const f of ["weight:", "weight_uom:", "weight_basis:"]) expect(tool).toContain(f);
  });

  it("tells the model a packing-list weight is USUALLY per row but not to assume", () => {
    expect(src).toMatch(/USUALLY the whole row/);
    expect(src).toMatch(/do not assume/i);
  });

  it("tells it never to estimate", () => {
    expect(src).toMatch(/NEVER estimate a weight from a part name, a material or a size/);
  });

  it("routes the kind to the tool", () => {
    expect(src).toMatch(/const isPackingList = expectedKind === "packing_list"/);
    expect(src).toMatch(/activeToolName = "extract_packing_list"/);
  });

  it("is registered as claude-capable, or it would run the PO schema", () => {
    expect(read("src/api/_lib/docai/index.js")).toMatch(/packing_list: \["claude"\]/);
  });
});

describe("the ingest", () => {
  const src = read("src/api/documents/packing_list_ingest.js");
  const code = strip(src);

  it("writes ONLY weights", () => {
    // A packing list describes what physically shipped; matching it to a
    // shipment is a separate problem and guessing it here would be worse.
    expect(code).toMatch(/from\("item_master"\)/);
    for (const t of ['from("shipments")', 'from("orders")', 'from("source_pos")']) {
      expect(code).not.toContain(t);
    }
  });

  it("fills a blank only, enforced in the update", () => {
    expect(code).toMatch(/\.is\("weight_kg", null\)/);
  });

  it("matches part codes EXACTLY, case-folded", () => {
    // A near-miss is a different SKU, and a weight on the wrong part is
    // invisible and permanent.
    expect(code).toMatch(/toUpperCase\(\)/);
    expect(code).not.toMatch(/ilike|fuzzy|levenshtein/i);
  });

  it("passes the header unit down as the document default", () => {
    expect(code).toMatch(/weightCandidates\(lines, \{ weight_uom: extracted\.weight_uom/);
  });

  it("survives a database without migration 216", () => {
    expect(code).toMatch(/42703/);
    expect(code).toMatch(/update\(\{ weight_kg: c\.weight_kg \}\)/);
  });

  it("separates 'already had a weight' from a real failure", () => {
    // The healthy steady state must not read like something went wrong.
    expect(code).toMatch(/already_had_weight/);
    expect(code).toMatch(/unmatched_parts/);
    expect(code).toMatch(/skipped/);
  });

  it("is routed and has a client method", () => {
    expect(strip(read("src/api/router.js"))).toMatch(/"\/documents\/packing_list_ingest":\s*documentsPackingList/);
    expect(strip(read("src/client/anvil-client.js"))).toMatch(/ingestPackingList: async \(documentId, extracted\)/);
  });
});

describe("migration 217", () => {
  const sql = read("supabase/migrations/217_packing_list_kind.sql");

  it("admits the kind without adding a table", () => {
    expect(sql).toMatch(/'packing_list'/);
    expect(sql).not.toMatch(/create table/i);
  });

  it("keeps every kind that was already allowed", () => {
    for (const k of ["po", "rfq", "supplier_ack", "invoice", "eway_bill", "generic", "assembly_bom", "part_drawing", "quote"]) {
      expect(sql).toContain("'" + k + "'");
    }
  });
});
