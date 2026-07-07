// Unit tests for the Document AI v2 dispatcher.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dispatchExtract, buildPromptOverrides, withEngineOverride, ADAPTER_NAMES } from "../api/_lib/docai/index.js";
import * as reducto from "../api/_lib/docai/reducto.js";
import * as azureDI from "../api/_lib/docai/azure_di.js";
import * as unstructured from "../api/_lib/docai/unstructured.js";

beforeAll(() => {
  delete process.env.REDUCTO_API_KEY;
  delete process.env.AZURE_DI_KEY;
  delete process.env.AZURE_DI_ENDPOINT;
  delete process.env.UNSTRUCTURED_API_KEY;
});

afterAll(() => { /* noop */ });

describe("docai / adapter configured detection", () => {
  it("reducto reports unconfigured without env or settings creds", () => {
    expect(reducto.isConfigured({})).toBe(false);
  });
  it("azure_di reports unconfigured without endpoint", () => {
    expect(azureDI.isConfigured({})).toBe(false);
  });
  it("unstructured reports unconfigured", () => {
    expect(unstructured.isConfigured({})).toBe(false);
  });
});

describe("docai / prompt overrides", () => {
  it("returns null when no customer or no overrides", () => {
    expect(buildPromptOverrides({}, "cust-1")).toBeNull();
    expect(buildPromptOverrides({ docai_prompt_overrides: { "cust-1": { foo: [] } } }, null)).toBeNull();
  });
  it("returns the per-customer entry when present", () => {
    const overrides = { "cust-1": { "lines[0].partNumber": [{ from: "X", to: "Y" }] } };
    const got = buildPromptOverrides({ docai_prompt_overrides: overrides }, "cust-1");
    expect(got).toEqual(overrides["cust-1"]);
  });
});

describe("docai / per-run engine override (SO workspace picker)", () => {
  it("registers llamaparse + gemini + claude among adapters", () => {
    expect(ADAPTER_NAMES).toContain("llamaparse");
    expect(ADAPTER_NAMES).toContain("gemini");
    expect(ADAPTER_NAMES).toContain("claude");
  });
  it("prepends a valid engine, keeping the tenant order as fallback", () => {
    const out = withEngineOverride({ docai_provider_order: ["reducto", "claude"] }, "llamaparse");
    expect(out.docai_provider_order).toEqual(["llamaparse", "reducto", "claude"]);
  });
  it("dedupes when the engine is already in the order (moves it to the front)", () => {
    const out = withEngineOverride({ docai_provider_order: ["claude", "gemini"] }, "gemini");
    expect(out.docai_provider_order).toEqual(["gemini", "claude"]);
  });
  it("runs only the engine when the tenant has no custom order", () => {
    const out = withEngineOverride({}, "gemini");
    expect(out.docai_provider_order).toEqual(["gemini"]);
  });
  it("ignores a blank or unknown engine (settings unchanged)", () => {
    const s = { docai_provider_order: ["claude"] };
    expect(withEngineOverride(s, "")).toBe(s);
    expect(withEngineOverride(s, "not_a_real_engine")).toBe(s);
    expect(withEngineOverride(s, null)).toBe(s);
  });
  it("is case/space tolerant on the engine name", () => {
    const out = withEngineOverride({ docai_provider_order: [] }, "  LlamaParse ");
    expect(out.docai_provider_order).toEqual(["llamaparse"]);
  });
});

describe("docai / dispatcher", () => {
  it("returns no-adapter-configured error when nothing is wired", async () => {
    const r = await dispatchExtract({
      source: { url: "https://example.com/doc.pdf", sourceType: "pdf" },
      settings: {},
      customerId: null,
      hints: {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no docai adapter configured/);
  });

  it("xlsx route hits the excel adapter directly even without provider config", async () => {
    // The excel adapter requires xlsx package; if not installed it
    // returns a clear error rather than throwing.
    const r = await dispatchExtract({
      source: { sourceType: "xlsx", filename: "tender.xlsx", bytes: Buffer.from([1,2,3,4,5]) },
      settings: {},
      customerId: null,
      hints: {},
    });
    expect(r.adapter_used).toBe("excel");
    // Either the adapter parsed (very unlikely with garbage bytes)
    // or returned a clear failure with a useful error message.
    if (!r.ok) {
      expect(r.error).toBeTruthy();
    }
  });
});
