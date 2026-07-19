// Unit tests for src/api/_lib/docai/learned-corrections.js (Wave 3.3).

import { describe, it, expect } from "vitest";
import {
  flattenNormalized,
  diffNormalized,
  classifyDiff,
  recordCorrections,
  suggestOverrides,
  __test,
} from "../api/_lib/docai/learned-corrections.js";

describe("flattenNormalized", () => {
  it("flattens customer + lines + totals", () => {
    const out = flattenNormalized({
      customer: { name: "Acme", gstin: "27AAACA1234B1Z5" },
      lines: [{ partNumber: "X", quantity: 10 }],
      totals: { grand_total: 1180 },
      classification: "po",
    });
    expect(out["customer.name"]).toBe("Acme");
    expect(out["customer.gstin"]).toBe("27AAACA1234B1Z5");
    expect(out["lines[0].partNumber"]).toBe("X");
    expect(out["lines[0].quantity"]).toBe(10);
    expect(out["totals.grand_total"]).toBe(1180);
    expect(out.classification).toBe("po");
  });
  it("ignores _internal markers on lines", () => {
    const out = flattenNormalized({
      lines: [{ partNumber: "X", _chunk_index: 0, _line_index: 3 }],
    });
    expect(out["lines[0].partNumber"]).toBe("X");
    expect(out["lines[0]._chunk_index"]).toBeUndefined();
  });
  it("returns {} on null", () => {
    expect(flattenNormalized(null)).toEqual({});
  });
});

describe("__test.stableEqual", () => {
  it("treats numbers within 0.5 paise as equal", () => {
    expect(__test.stableEqual(100, 100.001)).toBe(true);
    expect(__test.stableEqual(100, 100.01)).toBe(false);
  });
  it("treats null and null as equal", () => {
    expect(__test.stableEqual(null, null)).toBe(true);
    expect(__test.stableEqual(null, 0)).toBe(false);
  });
  it("trims string equality", () => {
    expect(__test.stableEqual("Acme", " Acme ")).toBe(true);
  });
});

describe("diffNormalized", () => {
  it("returns [] when no fields differ", () => {
    const same = { customer: { name: "Acme" }, lines: [] };
    expect(diffNormalized(same, same)).toEqual([]);
  });

  it("flags an add when the operator filled a null", () => {
    const model = { customer: { name: "Acme" } };
    const operator = { customer: { name: "Acme", gstin: "27AAACA1234B1Z5" } };
    const diffs = diffNormalized(model, operator);
    expect(diffs.length).toBe(1);
    expect(diffs[0].diff_kind).toBe("add");
    expect(diffs[0].severity).toBe("high");  // gstin is critical
  });

  it("flags a remove when the operator nulled out a model value", () => {
    const model = { customer: { name: "Acme", gstin: "WRONG" } };
    const operator = { customer: { name: "Acme" } };
    const diffs = diffNormalized(model, operator);
    expect(diffs.length).toBe(1);
    expect(diffs[0].diff_kind).toBe("remove");
    expect(diffs[0].severity).toBe("high");
  });

  it("flags a replace as medium when not critical", () => {
    const model = { lines: [{ quantity: 10, unitPrice: 100 }] };
    const operator = { lines: [{ quantity: 10, unitPrice: 110 }] };
    const diffs = diffNormalized(model, operator);
    expect(diffs.length).toBe(1);
    expect(diffs[0].field_path).toBe("lines[0].unitPrice");
    expect(diffs[0].diff_kind).toBe("replace");
    expect(diffs[0].severity).toBe("medium");
  });

  it("flags a whitespace-only change as low severity on non-critical fields", () => {
    const model = { lines: [{ description: "Bend  Adapter" }] };
    const operator = { lines: [{ description: "bend adapter" }] };
    const diffs = diffNormalized(model, operator);
    expect(diffs.length).toBe(1);
    expect(diffs[0].severity).toBe("low");
  });
});

describe("recordCorrections", () => {
  it("returns ok=true written=0 when no diffs", async () => {
    const out = await recordCorrections({}, { tenantId: "t", extractionRunId: "r" }, { diffs: [] });
    expect(out.ok).toBe(true);
    expect(out.written).toBe(0);
  });

  it("upserts one row per diff", async () => {
    let upsertCalls = 0;
    const svc = {
      from: (table) => ({
        upsert: (rows, opts) => {
          if (table === "learned_corrections") {
            upsertCalls++;
            expect(opts?.onConflict).toContain("tenant_id");
            expect(rows.length).toBe(2);
          }
          return Promise.resolve({ error: null });
        },
      }),
    };
    const out = await recordCorrections(
      svc,
      { tenantId: "t", extractionRunId: "r", adapterUsed: "claude", selectedModel: "claude-3-5-sonnet-latest", confidenceAtExtraction: 0.9 },
      {
        diffs: [
          { field_path: "customer.name", model_value: "X", operator_value: "Acme", diff_kind: "replace", severity: "medium" },
          { field_path: "lines[0].quantity", model_value: 10, operator_value: 11, diff_kind: "replace", severity: "medium" },
        ],
      },
    );
    expect(out.ok).toBe(true);
    expect(out.written).toBe(2);
    expect(upsertCalls).toBe(1);
  });

  it("returns ok=false on upsert error", async () => {
    const svc = {
      from: () => ({
        upsert: () => Promise.resolve({ error: { message: "fail" } }),
      }),
    };
    const out = await recordCorrections(
      svc,
      { tenantId: "t", extractionRunId: "r" },
      { diffs: [{ field_path: "x", model_value: null, operator_value: "y", diff_kind: "add", severity: "medium" }] },
    );
    expect(out.ok).toBe(false);
    expect(out.error).toBe("fail");
  });
});

describe("suggestOverrides", () => {
  it("aggregates corrections by (customer, field_path, operator_value)", async () => {
    const rows = [
      { tenant_id: "t", customer_id: "c1", field_path: "customer.gstin", operator_value: "27ABC", severity: "high", created_at: new Date().toISOString() },
      { tenant_id: "t", customer_id: "c1", field_path: "customer.gstin", operator_value: "27ABC", severity: "high", created_at: new Date().toISOString() },
      { tenant_id: "t", customer_id: "c1", field_path: "customer.gstin", operator_value: "27ABC", severity: "high", created_at: new Date().toISOString() },
      { tenant_id: "t", customer_id: "c2", field_path: "customer.gstin", operator_value: "27XYZ", severity: "high", created_at: new Date().toISOString() },
    ];
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              gte: () => ({
                eq: () => ({
                  then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
                }),
                then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
              }),
            }),
          }),
        }),
      }),
    };
    const out = await suggestOverrides(svc, { tenantId: "t", supportThreshold: 3 });
    expect(out.length).toBe(1);
    expect(out[0].customer_id).toBe("c1");
    expect(out[0].support_count).toBe(3);
  });

  it("returns [] when no svc", async () => {
    expect(await suggestOverrides(null, { tenantId: "t" })).toEqual([]);
  });
});

describe("classifyDiff", () => {
  it("classifies add / remove / replace kinds", () => {
    expect(classifyDiff("lines[0].qty", null, 10).diff_kind).toBe("add");
    expect(classifyDiff("lines[0].qty", 10, null).diff_kind).toBe("remove");
    expect(classifyDiff("lines[0].qty", 10, 12).diff_kind).toBe("replace");
  });
  it("flags critical fields + removals as high severity", () => {
    expect(classifyDiff("customer.gstin", "A", "B").severity).toBe("high");
    expect(classifyDiff("customer.name", "A", "B").severity).toBe("high");
    expect(classifyDiff("lines[0].rate", 5, null).severity).toBe("high"); // removal
  });
  it("treats a whitespace/case-only shift as low severity", () => {
    expect(classifyDiff("lines[0].description", "Weld  GUN", "weld gun").severity).toBe("low");
  });
  it("defaults a plain value replace to medium", () => {
    expect(classifyDiff("lines[0].rate", 5, 6).severity).toBe("medium");
  });
  it("matches diffNormalized for the same single change", () => {
    const diffs = diffNormalized(
      { lines: [{ partNumber: "X" }] },
      { lines: [{ partNumber: "Y" }] },
    );
    const single = classifyDiff("lines[0].partNumber", "X", "Y");
    expect(diffs[0].diff_kind).toBe(single.diff_kind);
    expect(diffs[0].severity).toBe(single.severity);
  });
});
