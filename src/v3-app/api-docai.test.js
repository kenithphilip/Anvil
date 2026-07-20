// Unit tests for the Document AI v2 dispatcher.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dispatchExtract, buildPromptOverrides, withEngineOverride, ADAPTER_NAMES, ensureLlmFallbacks } from "../api/_lib/docai/index.js";
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

describe("docai / provider self-heal (ensureLlmFallbacks)", () => {
  // A keyed engine, for the isConfigured stub.
  const keyed = (...names) => (n) => names.includes(n);

  it("appends a configured LLM to a stale gemini-less order so it can't dead-end", () => {
    // The exact failing shape: only Claude is in the order (and it 5xx's);
    // Gemini has a key but isn't listed. Self-heal makes Gemini reachable.
    const out = ensureLlmFallbacks(["reducto", "azure_di", "unstructured", "claude"], keyed("gemini", "claude"));
    expect(out).toEqual(["reducto", "azure_di", "unstructured", "claude", "gemini"]);
    expect(out.indexOf("gemini")).toBe(out.length - 1); // appended at the END
  });

  it("does not duplicate an LLM already in the order", () => {
    expect(ensureLlmFallbacks(["gemini", "docling"], keyed("gemini", "claude"))).toEqual(["gemini", "docling", "claude"]);
  });

  it("respects a no-key exclusion — never appends an unconfigured engine", () => {
    // Nothing keyed -> nothing appended (a residency/cost exclusion via no key
    // is honoured).
    expect(ensureLlmFallbacks(["reducto", "claude"], keyed())).toEqual(["reducto", "claude"]);
    // Only gemini keyed -> only gemini appended, not claude/llamaparse.
    expect(ensureLlmFallbacks(["reducto"], keyed("gemini"))).toEqual(["reducto", "gemini"]);
  });

  it("tolerates a null/empty order", () => {
    expect(ensureLlmFallbacks(null, keyed("gemini"))).toEqual(["gemini"]);
    expect(ensureLlmFallbacks([], keyed())).toEqual([]);
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
