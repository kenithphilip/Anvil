// Unit tests for src/api/_lib/item-mapper.js. Uses the pure
// __mapLinesPure entry point so we can test the resolution
// order (item_customer_parts -> item_master.part_no ->
// item_master.alias) without touching a DB.

import { describe, it, expect } from "vitest";
import { __mapLinesPure, resolveLineUom, fuzzyBlockedMatch } from "../api/_lib/item-mapper.js";

const masterRow = (overrides) => ({
  id: "im-1", part_no: "THB-L1-70B-2", alias: "BEND ADAPTER",
  description: "Bend Adapter (THB-L1-70B-2)",
  hsn_sac: "85159000", uom: "NO",
  source_country: "JP",
  print_name: "THB-L1-70B-2 BEND ADAPTER",
  gst_applicable: "Applicable",
  taxability_type: "Taxable",
  type_of_supply: "Goods",
  rate_of_duty_pct: 18,
  stock_group: "BEND ADAPTERS",
  specification_code: "OIPN036906",
  ...overrides,
});

describe("__mapLinesPure", () => {
  it("matches via item_master.part_no when the line has the tenant's own code (Faith PO)", () => {
    const im = masterRow({});
    const out = __mapLinesPure([
      { partNumber: "THB-L1-70B-2", description: "THB-L1-70B-2 (BEND ADAPTER)" },
    ], {
      imByCode: new Map([["THB-L1-70B-2", im]]),
      imById: new Map([[im.id, im]]),
    });
    expect(out[0]._mapped_item.match_via).toBe("item_master.part_no");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2");
    expect(out[0]._mapped_item.print_name).toBe("THB-L1-70B-2 BEND ADAPTER");
  });

  it("matches via item_master.alias when the line uses the alias", () => {
    const im = masterRow({});
    const out = __mapLinesPure([
      { partNumber: "BEND ADAPTER", description: "BEND ADAPTER" },
    ], {
      imByAlias: new Map([["BEND ADAPTER", im]]),
      imById: new Map([[im.id, im]]),
    });
    expect(out[0]._mapped_item.match_via).toBe("item_master.alias");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2");
  });

  it("prefers item_customer_parts when available (Hyundai uses GD544... -> THB-L1-70B-2)", () => {
    const im = masterRow({});
    const out = __mapLinesPure([
      { partNumber: "GD544202603190008" },
    ], {
      cpMap: new Map([["GD544202603190008", { item_id: "im-1", customer_part_description: "OBARA Bend Adapter" }]]),
      imById: new Map([[im.id, im]]),
      // Note: imByCode does NOT have GD544...; only the customer table does.
    });
    expect(out[0]._mapped_item.match_via).toBe("customer_part");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2");
    expect(out[0]._mapped_item.customer_part_description).toBe("OBARA Bend Adapter");
  });

  it("backfills hsn + uom when the line omitted them", () => {
    const im = masterRow({});
    const out = __mapLinesPure([
      { partNumber: "THB-L1-70B-2" },
    ], {
      imByCode: new Map([["THB-L1-70B-2", im]]),
      imById: new Map([[im.id, im]]),
    });
    expect(out[0].hsn).toBe("85159000");
    expect(out[0].uom).toBe("NO");
  });

  it("does not overwrite a line's existing hsn / uom", () => {
    const im = masterRow({ hsn_sac: "11111111", uom: "KG" });
    const out = __mapLinesPure([
      { partNumber: "THB-L1-70B-2", hsn: "85159000", uom: "NO" },
    ], {
      imByCode: new Map([["THB-L1-70B-2", im]]),
      imById: new Map([[im.id, im]]),
    });
    expect(out[0].hsn).toBe("85159000");
    expect(out[0].uom).toBe("NO");
  });

  it("stamps _mapped_item: null when nothing matches", () => {
    const out = __mapLinesPure([
      { partNumber: "UNKNOWN-PART-XYZ" },
    ], {});
    expect(out[0]._mapped_item).toBeNull();
    expect(out[0].partNumber).toBe("UNKNOWN-PART-XYZ");
  });

  it("matches case-insensitively", () => {
    const im = masterRow({});
    const out = __mapLinesPure([
      { partNumber: "thb-l1-70b-2" },
    ], {
      imByCode: new Map([["THB-L1-70B-2", im]]),
      imById: new Map([[im.id, im]]),
    });
    expect(out[0]._mapped_item).not.toBeNull();
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2");
  });

  it("considers multiple line-alias keys when matching", () => {
    const im = masterRow({});
    // Line has the part number under "sku" rather than "partNumber".
    const out = __mapLinesPure([
      { sku: "THB-L1-70B-2", description: "Bend adapter" },
    ], {
      imByCode: new Map([["THB-L1-70B-2", im]]),
      imById: new Map([[im.id, im]]),
    });
    expect(out[0]._mapped_item).not.toBeNull();
  });
});

describe("__mapLinesPure: Hyundai PO scenarios", () => {
  const guideAssy = {
    id: "im-guide", part_no: "THB-L1-70B-2-GA",
    alias: "GUIDE ASSY",
    print_name: "Guide Assembly THB-L1-70B-2",
    description: "Guide assembly for the Hyundai welding line",
    hsn_sac: "84669390", uom: "NOS",
    specification_code: "4-ET31062",
  };
  const pointHolder = {
    id: "im-point", part_no: "THB-L1-70B-2-PH",
    alias: "POINT HOLDER",
    print_name: "Point Holder THB-L1-70B-2",
    description: "Tip holder for spot-welding gun",
    hsn_sac: "85159000", uom: "NOS",
    specification_code: "403A7K1172",
  };

  it("specification_code tier maps Hyundai's spec to OBARA item (4-ET31062 -> Guide Assy)", () => {
    const out = __mapLinesPure([
      {
        partNumber: "GD544202603190008",
        description: "GUIDE ASSY",
        specification: "4-ET31062",
        qty: 2, rate: 46991,
      },
    ], {
      imBySpec: new Map([["4-ET31062", guideAssy]]),
      imById: new Map([[guideAssy.id, guideAssy]]),
    });
    expect(out[0]._mapped_item.match_via).toBe("item_master.specification_code");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2-GA");
    expect(out[0].hsn).toBe("84669390");
  });

  it("description fuzzy match maps GUIDE ASSY to the matching item_master row", () => {
    const out = __mapLinesPure([
      {
        partNumber: "GD544202603190008",
        description: "GUIDE ASSY",
        qty: 2, rate: 46991,
      },
    ], {
      imAll: [guideAssy, pointHolder],
    });
    expect(out[0]._mapped_item).not.toBeNull();
    expect(out[0]._mapped_item.match_via).toBe("item_master.description_fuzzy");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2-GA");
  });

  it("description fuzzy match maps POINT HOLDER -> point holder item", () => {
    const out = __mapLinesPure([
      {
        partNumber: "GD544202503260069",
        description: "POINT HOLDER",
        qty: 2, rate: 68110,
      },
    ], {
      imAll: [guideAssy, pointHolder],
    });
    expect(out[0]._mapped_item.match_via).toBe("item_master.description_fuzzy");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2-PH");
  });

  it("does not fuzzy-match a single ambiguous word like BOLT", () => {
    const im = { ...guideAssy, description: "M8 bolt", print_name: "Bolt M8", alias: null };
    const out = __mapLinesPure([
      { partNumber: "X", description: "BOLT" },
    ], { imAll: [im] });
    expect(out[0]._mapped_item).toBeNull();
  });

  it("falls through to null when neither code nor description matches", () => {
    const out = __mapLinesPure([
      { partNumber: "GD544202603190008", description: "UNKNOWN WIDGET" },
    ], {
      imAll: [guideAssy, pointHolder],
    });
    expect(out[0]._mapped_item).toBeNull();
  });

  it("CM 2.4: fuzzy_blocked tier catches a typo'd part_no when description shares a block", () => {
    // PartNo has a trailing extraneous char ("THB-001A"); the
    // item_master row is "THB-001" with description "Bend Adapter".
    // Tier 2 (part_no exact) misses; alias misses; description
    // _fuzzy misses (line has no clean 2-word description). The
    // new fuzzy_blocked tier should win.
    const im = { id: "im-1", part_no: "THB-001", description: "Bend adapter", alias: "BEND ADAPTER" };
    const out = __mapLinesPure([
      { partNumber: "THB-001A", description: "Bend adapter" },
    ], {
      imAll: [im],
    });
    expect(out[0]._mapped_item).not.toBeNull();
    expect(out[0]._mapped_item.match_via).toBe("item_master.fuzzy_blocked");
    expect(out[0]._mapped_item.part_no).toBe("THB-001");
  });

  it("CM 2.4: fuzzy_blocked tier rejects below-threshold scores", () => {
    // Same block (THB prefix + bend) but the item description is
    // an entirely different product. Score should fall below 0.75.
    const im = { id: "im-1", part_no: "THB-999", description: "Random gizmo Z2", alias: "GIZMO" };
    const out = __mapLinesPure([
      { partNumber: "ABC-001", description: "Bend adapter" },
    ], {
      imAll: [im],
    });
    expect(out[0]._mapped_item).toBeNull();
  });

  it("customer_part still wins over description fuzzy match", () => {
    // The operator has a translation table; trust it over the
    // description text on the PO.
    const ph = { ...pointHolder, alias: "GUIDE ASSY", print_name: "Guide ass (mis-named)" };
    const out = __mapLinesPure([
      { partNumber: "GD544202603190008", description: "GUIDE ASSY" },
    ], {
      cpMap: new Map([["GD544202603190008", { item_id: guideAssy.id, customer_part_description: "Hyundai code" }]]),
      imById: new Map([[guideAssy.id, guideAssy], [ph.id, ph]]),
      imAll: [ph, guideAssy],
    });
    expect(out[0]._mapped_item.match_via).toBe("customer_part");
    expect(out[0]._mapped_item.part_no).toBe("THB-L1-70B-2-GA");
  });
});

// CM 1.4: sales-order-only enforcement. The DB-aware
// mapLinesToItemMaster() filters item_customer_parts.applies_to
// based on opts.context. We verify the surface contract here
// using an in-memory svc shim that records the filter applied.
describe("mapLinesToItemMaster: CM 1.4 applies_to context gate", () => {
  // Lazy import so the vi.mock pattern from other tests does not
  // contaminate this suite.
  it("defaults to 'sales_order' context and passes that to the .contains() filter", async () => {
    const { mapLinesToItemMaster } = await import("../api/_lib/item-mapper.js");
    let capturedContext = null;
    const svc = {
      from: (table) => {
        const builder = {
          _filters: [],
          select() { return builder; },
          eq() { return builder; },
          in() { return builder; },
          contains(col, vals) {
            if (table === "item_customer_parts" && col === "applies_to") {
              capturedContext = vals;
            }
            return builder;
          },
          or() { return builder; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          then(fn) { fn({ data: [], error: null }); return { catch: () => {} }; },
        };
        return builder;
      },
    };
    await mapLinesToItemMaster(svc, "t1", "c1", [{ partNumber: "X" }]);
    expect(capturedContext).toEqual(["sales_order"]);
  });

  it("propagates a non-default context to the .contains() filter", async () => {
    const { mapLinesToItemMaster } = await import("../api/_lib/item-mapper.js");
    let capturedContext = null;
    const svc = {
      from: (table) => {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          in() { return builder; },
          contains(col, vals) {
            if (table === "item_customer_parts" && col === "applies_to") {
              capturedContext = vals;
            }
            return builder;
          },
          or() { return builder; },
          limit() { return Promise.resolve({ data: [], error: null }); },
          then(fn) { fn({ data: [], error: null }); return { catch: () => {} }; },
        };
        return builder;
      },
    };
    await mapLinesToItemMaster(svc, "t1", "c1", [{ partNumber: "X" }], { context: "quote" });
    expect(capturedContext).toEqual(["quote"]);
  });
});

describe("resolveLineUom (pack conversion + mismatch flag)", () => {
  const boxToNos = new Map([["BOX", { canonical_uom: "NOS", conversion_factor: 10, tally_uom: "NOS" }]]);
  it("converts to base units via the alias factor and does NOT flag a mismatch", () => {
    const r = resolveLineUom("BOX", 5, "NOS", boxToNos);
    expect(r).toEqual({ canonical_uom: "NOS", tally_uom: "NOS", uom_conversion_factor: 10, base_qty: 50, uom_mismatch: false });
  });
  it("flags a mismatch when the line uom differs from the item's stock uom with NO alias to reconcile", () => {
    const r = resolveLineUom("BOX", 5, "NOS", new Map());
    expect(r.uom_mismatch).toBe(true);
    expect(r.base_qty).toBe(5);           // factor defaults to 1
    expect(r.canonical_uom).toBe("BOX");
  });
  it("no mismatch when line uom equals the item uom; base_qty passes through", () => {
    expect(resolveLineUom("NOS", 3, "NOS", new Map())).toMatchObject({ uom_mismatch: false, base_qty: 3 });
  });
  it("tolerates a null/blank qty (base_qty null)", () => {
    expect(resolveLineUom("NOS", null, "NOS", new Map()).base_qty).toBe(null);
  });
  // The real seed aliases Nos/Pcs/Box-500 all to canonical "EA" while
  // item_master.uom stays "Nos" -- the item uom must be canonicalized too, or
  // every discrete line false-flags a mismatch.
  it("does NOT flag when line and item both normalize to the same canonical", () => {
    const m = new Map([
      ["NOS", { canonical_uom: "EA", conversion_factor: 1 }],
      ["PCS", { canonical_uom: "EA", conversion_factor: 1 }],
      ["BOX-500", { canonical_uom: "EA", conversion_factor: 500 }],
    ]);
    expect(resolveLineUom("Nos", 5, "Nos", m).uom_mismatch).toBe(false);   // the false positive the review caught
    expect(resolveLineUom("Pcs", 5, "Nos", m).uom_mismatch).toBe(false);   // different raw, same canonical
    expect(resolveLineUom("Box-500", 2, "Nos", m)).toMatchObject({ uom_mismatch: false, base_qty: 1000 }); // reconciled by factor
  });
  it("still flags a genuinely unreconcilable pairing (Kg vs Nos->EA)", () => {
    const m = new Map([["NOS", { canonical_uom: "EA", conversion_factor: 1 }]]);
    expect(resolveLineUom("Kg", 5, "Nos", m).uom_mismatch).toBe(true);
  });
});

describe("__mapLinesPure stamps UOM metadata onto _mapped_item", () => {
  it("carries canonical_uom / base_qty / uom_mismatch through a match", () => {
    const im = masterRow({ uom: "NOS" });
    const out = __mapLinesPure(
      [{ partNumber: "THB-L1-70B-2", uom: "BOX", qty: 4 }],
      { imByCode: new Map([["THB-L1-70B-2", im]]),
        uomAliasMap: new Map([["BOX", { canonical_uom: "NOS", conversion_factor: 10, tally_uom: "NOS" }]]) },
    );
    expect(out[0]._mapped_item).toMatchObject({ canonical_uom: "NOS", base_qty: 40, uom_mismatch: false });
    // Priced fields are never touched.
    expect(out[0].qty).toBe(4);
    expect(out[0].uom).toBe("BOX");
  });
});

describe("fuzzyBlockedMatch helper (shared by live + pure)", () => {
  it("returns null when the master pool is empty", () => {
    expect(fuzzyBlockedMatch({ partNumber: "X", description: "y z" }, [])).toBe(null);
  });
});
