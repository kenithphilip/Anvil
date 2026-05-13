// Unit tests for src/api/_lib/customer-external-ids.js (Wave CM 1.2).

import { describe, it, expect, vi } from "vitest";
import {
  isValidSystem, isValidSource, normExternalId,
  findCustomerByExternalId, listExternalIds, upsertExternalId,
} from "../api/_lib/customer-external-ids.js";

describe("isValidSystem / isValidSource", () => {
  it("accepts the known system codes", () => {
    for (const s of ["sap", "netsuite", "tally", "edi", "internal"]) {
      expect(isValidSystem(s)).toBe(true);
    }
  });
  it("rejects unknown systems", () => {
    expect(isValidSystem("hadoop")).toBe(false);
    expect(isValidSystem(null)).toBe(false);
    expect(isValidSystem("")).toBe(false);
  });
  it("accepts the known sources", () => {
    for (const s of ["operator", "inbound_email", "erp_sync", "bulk_import"]) {
      expect(isValidSource(s)).toBe(true);
    }
  });
});

describe("normExternalId", () => {
  it("lowercases + trims", () => {
    expect(normExternalId("  ABC-123 ")).toBe("abc-123");
  });
  it("returns null on null", () => {
    expect(normExternalId(null)).toBeNull();
  });
});

describe("findCustomerByExternalId", () => {
  it("returns null for missing args", async () => {
    expect(await findCustomerByExternalId(null, "t1", "sap", "1")).toBeNull();
    expect(await findCustomerByExternalId({}, null, "sap", "1")).toBeNull();
    expect(await findCustomerByExternalId({}, "t1", "bad_system", "1")).toBeNull();
    expect(await findCustomerByExternalId({}, "t1", "sap", "  ")).toBeNull();
  });

  it("queries with the right filters and returns the row", async () => {
    let capturedTenant = null;
    let capturedSystem = null;
    let capturedExternal = null;
    const svc = {
      from: () => ({
        select: () => ({
          eq: (col, val) => {
            if (col === "tenant_id") capturedTenant = val;
            if (col === "system_code") capturedSystem = val;
            return {
              eq: (col2, val2) => {
                if (col2 === "system_code") capturedSystem = val2;
                return {
                  ilike: (col3, val3) => {
                    if (col3 === "external_id") capturedExternal = val3;
                    return {
                      maybeSingle: () => Promise.resolve({
                        data: { customer_id: "c1", is_primary: true, source: "operator" },
                        error: null,
                      }),
                    };
                  },
                };
              },
            };
          },
        }),
      }),
    };
    const out = await findCustomerByExternalId(svc, "t1", "sap", "AT-1234");
    expect(out.customer_id).toBe("c1");
    expect(capturedSystem).toBe("sap");
    expect(capturedExternal).toBe("at-1234");
  });
});

describe("listExternalIds", () => {
  it("returns [] on missing args", async () => {
    expect(await listExternalIds(null, "t", "c")).toEqual([]);
    expect(await listExternalIds({}, null, "c")).toEqual([]);
  });
  it("returns the row list", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => Promise.resolve({
              data: [
                { system_code: "sap", external_id: "100051", is_primary: true },
                { system_code: "edi", external_id: "GLN5060", is_primary: false },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await listExternalIds(svc, "t", "c");
    expect(out.length).toBe(2);
  });
});

describe("upsertExternalId", () => {
  it("validates inputs", async () => {
    expect((await upsertExternalId(null, "t", "c", {})).ok).toBe(false);
    expect((await upsertExternalId({}, "t", "c", { system_code: "bogus", external_id: "x" })).ok).toBe(false);
    expect((await upsertExternalId({}, "t", "c", { system_code: "sap", external_id: " " })).ok).toBe(false);
  });

  it("upserts a non-primary row directly without demoting siblings", async () => {
    let upsertedRow = null;
    let updateCalled = false;
    const svc = {
      from: () => ({
        update: () => {
          updateCalled = true;
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                }),
              }),
            }),
          };
        },
        upsert: (row, opts) => {
          upsertedRow = row;
          expect(opts.onConflict).toContain("system_code");
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { ...row, id: "x1" }, error: null }),
            }),
          };
        },
      }),
    };
    const out = await upsertExternalId(svc, "t", "c", {
      system_code: "sap",
      external_id: "AT-100051",
      is_primary: false,
      source: "erp_sync",
    });
    expect(out.ok).toBe(true);
    expect(updateCalled).toBe(false);
    expect(upsertedRow.external_id).toBe("at-100051");
    expect(upsertedRow.system_code).toBe("sap");
    expect(upsertedRow.is_primary).toBe(false);
  });

  it("demotes prior primary when is_primary=true is requested", async () => {
    let updateCalled = false;
    const svc = {
      from: () => ({
        update: (vals) => {
          updateCalled = true;
          expect(vals.is_primary).toBe(false);
          return {
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ error: null }),
                }),
              }),
            }),
          };
        },
        upsert: (row) => ({
          select: () => ({
            single: () => Promise.resolve({ data: { ...row, id: "x1" }, error: null }),
          }),
        }),
      }),
    };
    const out = await upsertExternalId(svc, "t", "c", {
      system_code: "sap",
      external_id: "100051",
      is_primary: true,
    });
    expect(out.ok).toBe(true);
    expect(updateCalled).toBe(true);
  });

  it("returns ok=false on upsert error", async () => {
    const svc = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => Promise.resolve({ error: null }),
              }),
            }),
          }),
        }),
        upsert: () => ({
          select: () => ({
            single: () => Promise.resolve({ data: null, error: { message: "duplicate" } }),
          }),
        }),
      }),
    };
    const out = await upsertExternalId(svc, "t", "c", {
      system_code: "sap", external_id: "100051",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("duplicate");
  });
});
