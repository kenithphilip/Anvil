// Unit tests for src/api/_lib/customer-merge.js (Wave CM 4.3).

import { describe, it, expect, vi } from "vitest";
import { applySurvivorship, buildMergePlan, executeMerge, __test } from "../api/_lib/customer-merge.js";

describe("applySurvivorship", () => {
  it("keeps winner's gstin when both set", () => {
    const out = applySurvivorship(
      { id: "w", gstin: "27ABC" },
      { id: "l", gstin: "27XYZ" },
    );
    expect(out.gstin).toBe("27ABC");
  });

  it("uses loser's gstin when winner's missing", () => {
    const out = applySurvivorship(
      { id: "w", gstin: null },
      { id: "l", gstin: "27XYZ" },
    );
    expect(out.gstin).toBe("27XYZ");
  });

  it("prefers longer display name", () => {
    const out = applySurvivorship(
      { id: "w", display_name: "MG" },
      { id: "l", display_name: "MG Motor India Pvt Ltd" },
    );
    expect(out.display_name).toBe("MG Motor India Pvt Ltd");
  });

  it("fills null fields from loser without overwriting", () => {
    const out = applySurvivorship(
      { id: "w", country: null, state_code: "MH" },
      { id: "l", country: "IN", state_code: "DL" },
    );
    expect(out.country).toBe("IN");
    expect(out.state_code).toBe("MH");
  });

  it("appends a merged-from marker to notes", () => {
    const out = applySurvivorship(
      { id: "w", notes: "Active" },
      { id: "l", notes: "Old" },
    );
    expect(out.notes).toContain("Active");
    expect(out.notes).toContain("Old");
    expect(out.notes).toContain("[merged from l on ");
  });

  it("bumps last_active_at to now", () => {
    const before = Date.now();
    const out = applySurvivorship({ id: "w" }, { id: "l" });
    expect(Date.parse(out.last_active_at)).toBeGreaterThanOrEqual(before);
  });
});

describe("buildMergePlan", () => {
  it("returns ok=false on missing args / same customer", async () => {
    expect((await buildMergePlan(null, { tenantId: "t", winnerId: "a", loserId: "b" })).ok).toBe(false);
    expect((await buildMergePlan({}, { tenantId: "t", winnerId: "a", loserId: "a" })).ok).toBe(false);
  });

  it("returns ok=false when one customer is missing", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    };
    const out = await buildMergePlan(svc, { tenantId: "t", winnerId: "a", loserId: "b" });
    expect(out.ok).toBe(false);
  });

  it("builds a plan with merged row + FK estimates", async () => {
    let select_calls = 0;
    const svc = {
      from: (table) => ({
        select: (_cols, opts) => ({
          eq: () => ({
            eq: () => {
              if (table === "customers") {
                select_calls++;
                return {
                  maybeSingle: () => Promise.resolve({
                    data: select_calls === 1
                      ? { id: "w", display_name: "MG", gstin: "27ABC", country: null }
                      : { id: "l", display_name: "MG Motor India Pvt Ltd", gstin: null, country: "IN" },
                    error: null,
                  }),
                };
              }
              // Other tables: count head.
              return Promise.resolve({ count: 5, error: null });
            },
          }),
        }),
      }),
    };
    const out = await buildMergePlan(svc, { tenantId: "t", winnerId: "w", loserId: "l" });
    expect(out.ok).toBe(true);
    expect(out.merged_row.display_name).toBe("MG Motor India Pvt Ltd");
    expect(out.merged_row.country).toBe("IN");
    expect(out.fk_updates.length).toBe(__test.FK_TABLES.length);
  });
});

describe("executeMerge", () => {
  it("returns ok=false on missing args", async () => {
    expect((await executeMerge(null, { tenantId: "t", winnerId: "a", loserId: "b" })).ok).toBe(false);
    expect((await executeMerge({}, { tenantId: "t", winnerId: "a", loserId: "a" })).ok).toBe(false);
  });

  it("rejects when buildMergePlan returns ok=false", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        }),
      }),
    };
    const out = await executeMerge(svc, { tenantId: "t", winnerId: "w", loserId: "l" });
    expect(out.ok).toBe(false);
  });
});

describe("__test.FK_TABLES", () => {
  it("includes all expected dependent tables", () => {
    const tables = __test.FK_TABLES.map(([t]) => t);
    expect(tables).toContain("orders");
    expect(tables).toContain("quotes");
    expect(tables).toContain("invoices");
    expect(tables).toContain("customer_contacts");
    expect(tables).toContain("item_customer_parts");
    expect(tables).toContain("customer_external_ids");
  });
});
