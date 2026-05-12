// Unit tests for src/api/_lib/docai/prompt-versions.js (Wave 4.5).

import { describe, it, expect } from "vitest";
import {
  resolvePromptVersion, listPromptVersions, __test,
} from "../api/_lib/docai/prompt-versions.js";

describe("listPromptVersions", () => {
  it("returns the full registry when no name", () => {
    const all = listPromptVersions();
    expect(typeof all).toBe("object");
    expect(all.po_extractor).toBeDefined();
  });
  it("returns the rows for a given prompt", () => {
    const rows = listPromptVersions("po_extractor");
    expect(rows.length).toBeGreaterThan(0);
  });
  it("returns [] for an unknown prompt", () => {
    expect(listPromptVersions("does-not-exist")).toEqual([]);
  });
});

describe("__test.splitFraction", () => {
  it("is deterministic for the same tenant+customer", () => {
    const a = __test.splitFraction("t1", "c1");
    const b = __test.splitFraction("t1", "c1");
    expect(a).toBe(b);
  });
  it("differs across different tenants", () => {
    const a = __test.splitFraction("t1", "c1");
    const b = __test.splitFraction("t2", "c1");
    expect(a).not.toBe(b);
  });
});

describe("resolvePromptVersion", () => {
  it("returns null on unknown prompt", () => {
    expect(resolvePromptVersion("does-not-exist", { tenantId: "t1" })).toBeNull();
  });

  it("honours forceVersion", () => {
    const out = resolvePromptVersion("po_extractor", { tenantId: "t1", forceVersion: "v2" });
    expect(out.version).toBe("v2");
    expect(out.source).toBe("force");
  });

  it("honours tenant pin", () => {
    const out = resolvePromptVersion("po_extractor", { tenantId: "t1", pin: "v1" });
    expect(out.version).toBe("v1");
    expect(out.source).toBe("tenant_pin");
  });

  it("falls back to ab_split when no force/pin", () => {
    const out = resolvePromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    expect(out.source).toBe("ab_split");
    expect(["v1", "v2"]).toContain(out.version);
  });

  it("returns deterministically for the same tenant+customer", () => {
    const a = resolvePromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    const b = resolvePromptVersion("po_extractor", { tenantId: "t1", customerId: "c1" });
    expect(a.version).toBe(b.version);
  });

  it("returns the only available version when there is one", () => {
    const out = resolvePromptVersion("ocr_postprocess", { tenantId: "t1" });
    expect(out.version).toBe("v1");
  });
});
