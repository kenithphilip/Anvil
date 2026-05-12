// Unit tests for src/api/_lib/item-mapper.js. Uses the pure
// __mapLinesPure entry point so we can test the resolution
// order (item_customer_parts -> item_master.part_no ->
// item_master.alias) without touching a DB.

import { describe, it, expect } from "vitest";
import { __mapLinesPure } from "../api/_lib/item-mapper.js";

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
