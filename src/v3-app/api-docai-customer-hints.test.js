// Unit tests for src/api/_lib/docai/customer-hints.js (Wave 1.5).

import { describe, it, expect, beforeEach } from "vitest";
import {
  buildCustomerHints,
  summariseLinePatterns,
  renderHintBlock,
  __test,
} from "../api/_lib/docai/customer-hints.js";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const CUST = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => __test.clearCache());

// Build a fake supabase svc that returns canned rows per table.
const makeSvc = (tables) => {
  const buildQuery = (table) => {
    const ds = tables[table] || [];
    let rows = [...ds];
    const builder = {
      select: () => builder,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return builder; },
      in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return builder; },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => Promise.resolve({ data: rows[0] || null, error: null }),
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
    return builder;
  };
  return { from: buildQuery };
};

describe("summariseLinePatterns", () => {
  it("aggregates HSN, GST, UOM, currency, and prefix counts", () => {
    const runs = [
      { normalized_extract: { customer: { currency: "INR" }, lines: [
        { partNumber: "ACM-1", hsn: "8482", gst_pct: 18, uom: "NOS" },
        { partNumber: "ACM-2", hsn: "8482", gst_pct: 18, uom: "NOS" },
        { partNumber: "ACM-3", hsn: "8483", gst_pct: 5,  uom: "PCS" },
      ] } },
      { normalized_extract: { customer: { currency: "INR" }, lines: [
        { partNumber: "ACM-4", hsn: "8482", gst_pct: 18, uom: "NOS" },
      ] } },
    ];
    const out = summariseLinePatterns(runs);
    expect(out.line_count_sample).toBe(4);
    expect(out.top_hsn[0]).toEqual({ value: "8482", count: 3 });
    expect(out.top_gst_pct[0]).toEqual({ value: "18", count: 3 });
    expect(out.top_uom[0]).toEqual({ value: "NOS", count: 3 });
    expect(out.top_currency[0]).toEqual({ value: "INR", count: 2 });
    expect(out.common_part_prefixes[0]).toEqual({ value: "ACM", count: 4 });
  });
  it("tolerates missing fields", () => {
    const out = summariseLinePatterns([{ normalized_extract: { lines: [] } }, {}]);
    expect(out.line_count_sample).toBe(0);
    expect(out.top_hsn).toEqual([]);
  });
});

describe("renderHintBlock", () => {
  it("returns null when no signal", () => {
    expect(renderHintBlock(null)).toBeNull();
    expect(renderHintBlock({})).toBeNull();
  });
  it("emits a multi-line block when fields are present", () => {
    const block = renderHintBlock({
      identity: { display_name: "Acme Auto", gstin: "27AAACA1234B1Z5", country: "IN" },
      line_patterns: {
        top_currency: [{ value: "INR" }],
        top_hsn: [{ value: "8482" }, { value: "8483" }],
        top_gst_pct: [{ value: "18" }],
        common_part_prefixes: [{ value: "ACM" }],
      },
      item_mappings_sample: [
        { customer_part_number: "ACM-1", canonical_part_no: "THB-1" },
      ],
    });
    expect(block).toContain("Customer: Acme Auto");
    expect(block).toContain("Expected GSTIN: 27AAACA1234B1Z5");
    expect(block).toContain("Default currency: INR");
    expect(block).toContain("Recent HSN codes: 8482, 8483");
    expect(block).toContain("Typical GST %: 18");
    expect(block).toContain("ACM-1 -> THB-1");
  });
});

describe("buildCustomerHints", () => {
  it("returns null for missing args", async () => {
    expect(await buildCustomerHints(null, { tenantId: TENANT, customerId: CUST })).toBeNull();
    expect(await buildCustomerHints({}, { tenantId: null, customerId: CUST })).toBeNull();
    expect(await buildCustomerHints({}, { tenantId: TENANT, customerId: null })).toBeNull();
  });

  it("aggregates identity, line patterns, and item mappings", async () => {
    const svc = makeSvc({
      customers: [{
        tenant_id: TENANT, id: CUST,
        display_name: "Acme Auto", gstin: "27AAACA1234B1Z5", country: "IN", currency_default: "INR",
      }],
      customer_field_overrides: [
        { tenant_id: TENANT, customer_id: CUST, field_path: "customer.name", replacement: "Acme Auto" },
      ],
      extraction_runs: [
        { tenant_id: TENANT, customer_id: CUST, status: "ok", normalized_extract: {
          customer: { currency: "INR" },
          lines: [
            { partNumber: "ACM-1", hsn: "8482", gst_pct: 18, uom: "NOS" },
            { partNumber: "ACM-2", hsn: "8482", gst_pct: 18, uom: "NOS" },
          ],
        } },
      ],
      item_customer_parts: [
        { tenant_id: TENANT, customer_id: CUST, customer_part_number: "ACM-1", item_id: "im-1" },
      ],
      item_master: [
        { tenant_id: TENANT, id: "im-1", part_no: "THB-1" },
      ],
    });
    const out = await buildCustomerHints(svc, { tenantId: TENANT, customerId: CUST });
    expect(out).not.toBeNull();
    expect(out.identity.display_name).toBe("Acme Auto");
    expect(out.identity.gstin).toBe("27AAACA1234B1Z5");
    expect(out.line_patterns.top_hsn[0].value).toBe("8482");
    expect(out.item_mappings_sample[0].canonical_part_no).toBe("THB-1");
    expect(out.rendered).toContain("Customer: Acme Auto");
  });

  it("caches per (tenantId, customerId) for the TTL window", async () => {
    let queryCount = 0;
    const svc = {
      from: () => {
        queryCount++;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
                then: (fn) => Promise.resolve(fn({ data: [], error: null })),
                order: () => ({
                  limit: () => ({
                    then: (fn) => Promise.resolve(fn({ data: [], error: null })),
                  }),
                }),
                in: () => ({ then: (fn) => Promise.resolve(fn({ data: [], error: null })) }),
              }),
            }),
          }),
        };
      },
    };
    // First call queries; result is null but the null is cached.
    await buildCustomerHints(svc, { tenantId: TENANT, customerId: CUST });
    const firstCount = queryCount;
    // Second call returns the cached null without re-querying.
    await buildCustomerHints(svc, { tenantId: TENANT, customerId: CUST });
    expect(queryCount).toBe(firstCount);
  });

  it("returns null when there is no useful signal", async () => {
    const svc = makeSvc({
      customers: [],
      customer_field_overrides: [],
      extraction_runs: [],
      item_customer_parts: [],
    });
    const out = await buildCustomerHints(svc, { tenantId: TENANT, customerId: CUST });
    expect(out).toBeNull();
  });
});
