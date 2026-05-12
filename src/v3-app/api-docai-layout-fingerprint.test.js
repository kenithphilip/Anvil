// Unit tests for src/api/_lib/docai/layout-fingerprint.js (Wave 3.5).

import { describe, it, expect } from "vitest";
import {
  computeLayoutFingerprint,
  findRunByLayoutFingerprint,
  adapterBiasFromPriorLayout,
  __test,
} from "../api/_lib/docai/layout-fingerprint.js";

describe("__test.sigTokens", () => {
  it("returns the first 20 distinct significant tokens", () => {
    const text = "PURCHASE ORDER PO 12345 BILL TO Acme Auto Address Mumbai Item Qty Rate Amount Total";
    const out = __test.sigTokens(text);
    expect(out).toContain("purchase");
    expect(out).toContain("order");
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toContain("to");           // stop word
  });
  it("returns [] on null", () => {
    expect(__test.sigTokens(null)).toEqual([]);
  });
});

describe("computeLayoutFingerprint", () => {
  it("returns the same hash for identical inputs", async () => {
    const a = await computeLayoutFingerprint({
      bodyText: "PURCHASE ORDER FROM ACME",
      pageCount: 1,
      sourceSizeBytes: 1024,
    });
    const b = await computeLayoutFingerprint({
      bodyText: "PURCHASE ORDER FROM ACME",
      pageCount: 1,
      sourceSizeBytes: 1024,
    });
    expect(a).toBe(b);
  });
  it("returns different hashes when page count differs", async () => {
    const a = await computeLayoutFingerprint({ bodyText: "X", pageCount: 1, sourceSizeBytes: 1024 });
    const b = await computeLayoutFingerprint({ bodyText: "X", pageCount: 5, sourceSizeBytes: 1024 });
    expect(a).not.toBe(b);
  });
  it("returns different hashes when size bucket differs", async () => {
    const a = await computeLayoutFingerprint({ bodyText: "X", pageCount: 1, sourceSizeBytes: 1024 });
    const b = await computeLayoutFingerprint({ bodyText: "X", pageCount: 1, sourceSizeBytes: 5 * 1024 });
    expect(a).not.toBe(b);
  });
  it("returns the same hash when content (PO number) varies but headers do not", async () => {
    const a = await computeLayoutFingerprint({
      bodyText: "PURCHASE ORDER 12345 BILL TO ACME ITEM QTY",
      pageCount: 1,
      sourceSizeBytes: 1024,
    });
    const b = await computeLayoutFingerprint({
      bodyText: "PURCHASE ORDER 99999 BILL TO ACME ITEM QTY",
      pageCount: 1,
      sourceSizeBytes: 1024,
    });
    // Numbers are stripped; both produce the same signature tokens.
    expect(a).toBe(b);
  });
});

describe("adapterBiasFromPriorLayout", () => {
  it("returns the prior adapter as a single-element array", () => {
    expect(adapterBiasFromPriorLayout({ adapter_used: "gemini" })).toEqual(["gemini"]);
  });
  it("returns null for voter mode", () => {
    expect(adapterBiasFromPriorLayout({ adapter_used: "voter" })).toBeNull();
  });
  it("returns null for excel and gaeb (already routed deterministically)", () => {
    expect(adapterBiasFromPriorLayout({ adapter_used: "excel" })).toBeNull();
    expect(adapterBiasFromPriorLayout({ adapter_used: "gaeb" })).toBeNull();
  });
  it("returns null when no prior adapter is known", () => {
    expect(adapterBiasFromPriorLayout(null)).toBeNull();
    expect(adapterBiasFromPriorLayout({})).toBeNull();
  });
});

describe("findRunByLayoutFingerprint", () => {
  it("returns null on no svc", async () => {
    expect(await findRunByLayoutFingerprint(null, { tenantId: "t", layoutFingerprint: "x" })).toBeNull();
  });
  it("returns null on missing args", async () => {
    expect(await findRunByLayoutFingerprint({}, { tenantId: null })).toBeNull();
  });
  it("queries supabase with the right filters and returns the row", async () => {
    const svc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({
                    eq: () => ({
                      maybeSingle: () => Promise.resolve({ data: { id: "run-prior", adapter_used: "claude" }, error: null }),
                    }),
                    is: () => ({
                      maybeSingle: () => Promise.resolve({ data: { id: "run-prior", adapter_used: "claude" }, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const out = await findRunByLayoutFingerprint(svc, { tenantId: "t", customerId: "c", layoutFingerprint: "x" });
    expect(out.id).toBe("run-prior");
  });
});
