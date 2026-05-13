// Unit tests for src/api/_lib/customer-part-bulk-diff.js (Wave CM 5.3).

import { describe, it, expect } from "vitest";
import { buildBulkDiff, __test } from "../api/_lib/customer-part-bulk-diff.js";

describe("__test.isUuid + norm helpers", () => {
  it("identifies UUIDs", () => {
    expect(__test.isUuid("00000000-0000-0000-0000-0000000000aa")).toBe(true);
    expect(__test.isUuid("not-a-uuid")).toBe(false);
    expect(__test.isUuid(null)).toBe(false);
  });
  it("normCode upper-cases + trims", () => {
    expect(__test.normCode("  thb-001  ")).toBe("THB-001");
  });
});

// Compose an in-memory supabase shim that lets us drive the
// diff helper without a real DB. Each from() returns a query
// builder that records its filters and returns canned data.
const makeSvc = (tables) => {
  return {
    from: (table) => {
      const ds = tables[table] || [];
      let rows = [...ds];
      const builder = {
        select() { return builder; },
        eq(col, val) { rows = rows.filter((r) => String(r[col]) === String(val)); return builder; },
        ilike(col, val) {
          rows = rows.filter((r) => String(r[col] || "").toLowerCase() === String(val || "").toLowerCase());
          return builder;
        },
        in(col, vals) {
          rows = rows.filter((r) => vals.some((v) => String(r[col]) === String(v)));
          return builder;
        },
        maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
        then(fn) { return Promise.resolve(fn({ data: rows, error: null })); },
      };
      return builder;
    },
  };
};

describe("buildBulkDiff", () => {
  it("returns ok=false on missing args", async () => {
    expect((await buildBulkDiff(null, { tenantId: "t" })).ok).toBe(false);
  });

  it("classifies a single new row", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1" }],
      item_master: [{ tenant_id: "t1", id: "i1", part_no: "THB-001" }],
      item_customer_parts: [],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_id: "c1", item_master_id: "i1", customer_part_number: "GD544" }],
    });
    expect(out.ok).toBe(true);
    expect(out.summary.new_count).toBe(1);
    expect(out.summary.update_count).toBe(0);
    expect(out.summary.noop_count).toBe(0);
    expect(out.new[0].customer_part_number).toBe("GD544");
  });

  it("classifies an update when prior mapping points at a different item", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1" }],
      item_master: [
        { tenant_id: "t1", id: "i1", part_no: "THB-001" },
        { tenant_id: "t1", id: "i2", part_no: "THB-002" },
      ],
      item_customer_parts: [
        { tenant_id: "t1", customer_id: "c1", customer_part_number: "GD544", item_id: "i2", valid_to: null },
      ],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_id: "c1", item_master_id: "i1", customer_part_number: "GD544" }],
    });
    expect(out.summary.update_count).toBe(1);
    expect(out.update[0].prior_item_id).toBe("i2");
    expect(out.update[0].item_id).toBe("i1");
  });

  it("classifies a noop when prior mapping already matches", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1" }],
      item_master: [{ tenant_id: "t1", id: "i1", part_no: "THB-001" }],
      item_customer_parts: [
        { tenant_id: "t1", customer_id: "c1", customer_part_number: "GD544", item_id: "i1", valid_to: null },
      ],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_id: "c1", item_master_id: "i1", customer_part_number: "GD544" }],
    });
    expect(out.summary.noop_count).toBe(1);
  });

  it("emits ERROR rows when item_master is missing", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1" }],
      item_master: [],
      item_customer_parts: [],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_id: "c1", part_no: "UNKNOWN", customer_part_number: "GD544" }],
    });
    expect(out.summary.error_count).toBe(1);
    expect(out.errors[0].error).toBe("item_master_not_found");
  });

  it("emits ERROR when customer not found", async () => {
    const svc = makeSvc({ customers: [], item_master: [], item_customer_parts: [] });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_name: "Unknown Customer", item_master_id: "i1", customer_part_number: "X" }],
    });
    expect(out.summary.error_count).toBe(1);
  });

  it("resolves customer by display_name when customer_id absent", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1", display_name: "Acme Auto" }],
      item_master: [{ tenant_id: "t1", id: "i1", part_no: "THB-001" }],
      item_customer_parts: [],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_name: "Acme Auto", item_master_id: "i1", customer_part_number: "GD544" }],
    });
    expect(out.summary.new_count).toBe(1);
  });

  it("normalises customer_part_number to uppercase", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1" }],
      item_master: [{ tenant_id: "t1", id: "i1", part_no: "THB-001" }],
      item_customer_parts: [],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [{ customer_id: "c1", item_master_id: "i1", customer_part_number: "  gd544  " }],
    });
    expect(out.new[0].customer_part_number).toBe("GD544");
  });

  it("emits a multi-row summary", async () => {
    const svc = makeSvc({
      customers: [{ tenant_id: "t1", id: "c1" }],
      item_master: [
        { tenant_id: "t1", id: "i1", part_no: "THB-001" },
        { tenant_id: "t1", id: "i2", part_no: "THB-002" },
      ],
      item_customer_parts: [
        { tenant_id: "t1", customer_id: "c1", customer_part_number: "A", item_id: "i1", valid_to: null }, // noop
        { tenant_id: "t1", customer_id: "c1", customer_part_number: "B", item_id: "i1", valid_to: null }, // update -> i2
      ],
    });
    const out = await buildBulkDiff(svc, {
      tenantId: "t1",
      rows: [
        { customer_id: "c1", item_master_id: "i1", customer_part_number: "A" }, // noop
        { customer_id: "c1", item_master_id: "i2", customer_part_number: "B" }, // update
        { customer_id: "c1", item_master_id: "i1", customer_part_number: "C" }, // new
        { customer_id: "c1", part_no: "BOGUS",    customer_part_number: "D" }, // error
      ],
    });
    expect(out.summary).toEqual({
      total: 4, new_count: 1, update_count: 1, noop_count: 1, error_count: 1,
    });
  });
});
