// Phase E: customer-field overrides + immediate-feedback tests.

import { describe, it, expect } from "vitest";
import { applyOverrides, promoteCorrectionIfStable } from "../api/_lib/docai/overrides.js";

describe("overrides / applyOverrides", () => {
  it("is a no-op when no overrides", () => {
    const n = { customer: { name: "Acme" }, lines: [] };
    const out = applyOverrides(n, []);
    expect(out.normalized).toEqual(n);
    expect(out.applied).toEqual([]);
  });

  it("applies an always-on override when match_pattern is null", () => {
    const n = { customer: { payment_terms: "Net 60" }, lines: [] };
    const overrides = [
      { id: "ov-1", field_path: "customer.payment_terms", match_pattern: null, replacement: "Net 30", confidence_floor: 0.95 },
    ];
    const out = applyOverrides(n, overrides);
    expect(out.normalized.customer.payment_terms).toBe("Net 30");
    expect(out.applied).toHaveLength(1);
    expect(out.applied[0]).toMatchObject({
      field_path: "customer.payment_terms",
      before: "Net 60",
      after: "Net 30",
      override_id: "ov-1",
    });
  });

  it("applies a regex-based override only when the current value matches", () => {
    const overrides = [
      { id: "ov-2", field_path: "customer.name", match_pattern: "^M/[sS]\\.\\s*", replacement: "Acme Industries", confidence_floor: 0.95 },
    ];
    const matched = applyOverrides({ customer: { name: "M/s. Acme" } }, overrides);
    expect(matched.normalized.customer.name).toBe("Acme Industries");
    expect(matched.applied).toHaveLength(1);

    const unmatched = applyOverrides({ customer: { name: "Acme Industries" } }, overrides);
    expect(unmatched.normalized.customer.name).toBe("Acme Industries");
    expect(unmatched.applied).toHaveLength(0);
  });

  it("doesn't double-apply when the field already equals replacement", () => {
    const overrides = [
      { id: "ov-3", field_path: "customer.currency", match_pattern: null, replacement: "INR", confidence_floor: 0.95 },
    ];
    const out = applyOverrides({ customer: { currency: "INR" } }, overrides);
    expect(out.applied).toHaveLength(0);
  });

  it("does not mutate the input normalized object", () => {
    const original = { customer: { name: "M/s. Acme" } };
    const snapshot = JSON.parse(JSON.stringify(original));
    applyOverrides(original, [
      { id: "ov-4", field_path: "customer.name", match_pattern: null, replacement: "Acme", confidence_floor: 0.95 },
    ]);
    expect(original).toEqual(snapshot);
  });
});

// Tiny svc shim for the promote path; mirrors the templates test harness.
const svcShim = (handlers) => ({
  from: (table) => {
    const ctx = { table, filters: [], updates: null };
    const api = {
      select(_c) { return api; },
      eq(col, val) { ctx.filters.push({ col, val }); return api; },
      order(col) { ctx.order = col; return api; },
      limit(n) { ctx.limit = n; return api; },
      maybeSingle() { return Promise.resolve({ data: handlers(ctx)[0] || null, error: null }); },
      single() {
        const rows = handlers(ctx);
        if (!rows.length) return Promise.resolve({ data: null, error: { message: "no row" } });
        return Promise.resolve({ data: rows[0], error: null });
      },
      then(res) { res({ data: handlers(ctx), error: null }); return { catch: () => ({}) }; },
      update(values) { ctx.action = "update"; ctx.updates = values; return api; },
      insert(values) {
        ctx.action = "insert"; ctx.values = values;
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: "ov-new", ...values }, error: null }),
          }),
        };
      },
    };
    return api;
  },
});

describe("overrides / promoteCorrectionIfStable", () => {
  it("does nothing when fewer than two corrections exist", async () => {
    const out = await promoteCorrectionIfStable(svcShim((ctx) => {
      if (ctx.table === "extraction_corrections") return [{ original_value: "x", corrected_value: "y" }];
      return [];
    }), { tenantId: "t1", customerId: "c1", fieldPath: "customer.gstin" });
    expect(out.promoted).toBe(false);
    expect(out.reason).toBe("not_enough_corrections");
  });

  it("does nothing when the two latest corrections disagree", async () => {
    const out = await promoteCorrectionIfStable(svcShim((ctx) => {
      if (ctx.table === "extraction_corrections") {
        return [
          { original_value: "x", corrected_value: "A" },
          { original_value: "x", corrected_value: "B" },
        ];
      }
      return [];
    }), { tenantId: "t1", customerId: "c1", fieldPath: "customer.gstin" });
    expect(out.promoted).toBe(false);
    expect(out.reason).toBe("no_match_two_recent");
  });

  it("inserts an override when two latest corrections agree", async () => {
    const out = await promoteCorrectionIfStable(svcShim((ctx) => {
      if (ctx.table === "extraction_corrections") {
        return [
          { id: "c1", original_value: "M/s. Acme", corrected_value: "Acme" },
          { id: "c2", original_value: "M/s. Acme", corrected_value: "Acme" },
        ];
      }
      if (ctx.table === "customer_field_overrides" && ctx.action !== "insert") return [];
      return [];
    }), { tenantId: "t1", customerId: "c1", fieldPath: "customer.name" });
    expect(out.promoted).toBe(true);
    expect(out.override_id).toBe("ov-new");
  });

  it("is idempotent: skips when the override already exists", async () => {
    const out = await promoteCorrectionIfStable(svcShim((ctx) => {
      if (ctx.table === "extraction_corrections") {
        return [
          { id: "c1", original_value: "M/s. Acme", corrected_value: "Acme" },
          { id: "c2", original_value: "M/s. Acme", corrected_value: "Acme" },
        ];
      }
      if (ctx.table === "customer_field_overrides" && ctx.action !== "insert") {
        return [{ id: "existing-1" }];
      }
      return [];
    }), { tenantId: "t1", customerId: "c1", fieldPath: "customer.name" });
    expect(out.promoted).toBe(false);
    expect(out.reason).toBe("already_exists");
    expect(out.override_id).toBe("existing-1");
  });
});
