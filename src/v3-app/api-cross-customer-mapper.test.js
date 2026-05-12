// Unit tests for src/api/_lib/cross-customer-mapper.js (Wave 3.4).

import { describe, it, expect, beforeEach } from "vitest";
import {
  significantWords,
  buildCrossCustomerIndex,
  suggestCrossCustomer,
  suggestForLines,
  __test,
} from "../api/_lib/cross-customer-mapper.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

beforeEach(() => __test.clearCache());

const makeSvc = (tables) => {
  const buildQuery = (table) => {
    const ds = tables[table] || [];
    let rows = [...ds];
    const builder = {
      select: () => builder,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return builder; },
      in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return builder; },
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
    return builder;
  };
  return { from: buildQuery };
};

describe("significantWords", () => {
  it("strips stop words and short tokens", () => {
    expect(significantWords("The BIG bend ADAPTER for nos 2")).toEqual(["big", "bend", "adapter"]);
  });
  it("returns [] on null", () => {
    expect(significantWords(null)).toEqual([]);
  });
});

describe("buildCrossCustomerIndex", () => {
  it("returns [] when there are no item_customer_parts", async () => {
    const svc = makeSvc({ item_customer_parts: [], item_master: [] });
    const out = await buildCrossCustomerIndex(svc, TENANT);
    expect(out).toEqual([]);
  });

  it("aggregates mappings by item with customer count", async () => {
    const svc = makeSvc({
      item_customer_parts: [
        { tenant_id: TENANT, item_id: "im-1", customer_id: "c1", customer_part_description: "Bend adapter X1" },
        { tenant_id: TENANT, item_id: "im-1", customer_id: "c2", customer_part_description: "Bend adapter X1" },
        { tenant_id: TENANT, item_id: "im-2", customer_id: "c1", customer_part_description: "Point holder" },
      ],
      item_master: [
        { tenant_id: TENANT, id: "im-1", part_no: "THB-1", description: "Bend adapter" },
        { tenant_id: TENANT, id: "im-2", part_no: "THB-2", description: "Point holder" },
      ],
    });
    const idx = await buildCrossCustomerIndex(svc, TENANT);
    expect(idx.length).toBe(2);
    const im1 = idx.find((x) => x.itemId === "im-1");
    expect(im1.customerCount).toBe(2);
    expect(im1.words.has("bend")).toBe(true);
    expect(im1.words.has("adapter")).toBe(true);
  });

  it("caches results for the same tenant", async () => {
    let queryCount = 0;
    const svc = {
      from: () => {
        queryCount++;
        return {
          select: () => ({
            eq: () => ({
              then: (fn) => Promise.resolve(fn({ data: [], error: null })),
              in: () => ({ then: (fn) => Promise.resolve(fn({ data: [], error: null })) }),
            }),
          }),
        };
      },
    };
    await buildCrossCustomerIndex(svc, TENANT);
    const first = queryCount;
    await buildCrossCustomerIndex(svc, TENANT);
    expect(queryCount).toBe(first);                // second call hit cache
  });
});

describe("suggestCrossCustomer", () => {
  const idx = [
    { itemId: "im-1", partNo: "THB-1", description: "Bend adapter", words: new Set(["bend", "adapter"]), customerCount: 3 },
    { itemId: "im-2", partNo: "THB-2", description: "Point holder", words: new Set(["point", "holder"]), customerCount: 1 },
    { itemId: "im-3", partNo: "THB-3", description: "Random gizmo", words: new Set(["random", "gizmo"]), customerCount: 1 },
  ];

  it("returns the top overlap by score", () => {
    const out = suggestCrossCustomer(idx, { description: "BEND ADAPTER" });
    expect(out[0].item_id).toBe("im-1");
    expect(out[0].overlap_words).toBe(2);
    expect(out[0].customer_count).toBe(3);
  });

  it("orders by score with customer boost", () => {
    // Two items have equal overlap (1); the one with more customers wins.
    const out = suggestCrossCustomer(idx, { description: "POINT BEND" });
    expect(out[0].item_id).toBe("im-1");
  });

  it("returns [] when no significant words in the query", () => {
    expect(suggestCrossCustomer(idx, { description: "the for to" })).toEqual([]);
  });

  it("respects opts.limit", () => {
    const out = suggestCrossCustomer(idx, { description: "BEND ADAPTER POINT HOLDER" }, { limit: 1 });
    expect(out.length).toBe(1);
  });
});

describe("suggestForLines", () => {
  it("returns per-line suggestion arrays", async () => {
    const svc = makeSvc({
      item_customer_parts: [
        { tenant_id: TENANT, item_id: "im-1", customer_id: "c1", customer_part_description: "Bend adapter" },
      ],
      item_master: [
        { tenant_id: TENANT, id: "im-1", part_no: "THB-1", description: "Bend adapter" },
      ],
    });
    const out = await suggestForLines(svc, TENANT, [
      { description: "Bend adapter" },
      { description: "Unknown thing" },
    ]);
    expect(out.length).toBe(2);
    expect(out[0].length).toBeGreaterThan(0);
    expect(out[0][0].item_id).toBe("im-1");
    expect(out[1]).toEqual([]);
  });
});
