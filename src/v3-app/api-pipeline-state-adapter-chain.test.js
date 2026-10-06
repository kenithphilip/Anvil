// The SO workspace "Adapter chain" card used to derive its own answer instead
// of asking the dispatcher, and it was wrong in both halves:
//
//   const adapterChain = settings.docai_provider_order
//     || ["reducto", "azure_di", "unstructured", "claude"];   // stale legacy list
//   configured_hint: name === "claude" ? !!process.env.ANTHROPIC_API_KEY
//                  : name === "reducto" ? !!settings.reducto_api_key   // legacy PLAINTEXT column
//                  : ... : false;                                      // everything else: false
//
// So a tenant with a NULL docai_provider_order rendered as `reducto(no),
// azure_di(no), unstructured(no), claude(yes)` — indistinguishable from a
// tenant genuinely pinned to a claude-first legacy order. During the
// 2026-08-10 outage that phantom sent us chasing a provider-order bug that did
// not exist. The card must show the SAME chain the dispatcher will run.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROVIDER_ORDER,
  ensureLlmFallbacks,
  isAdapterConfigured,
  ADAPTER_NAMES,
} from "../api/_lib/docai/index.js";

// Exactly what pipeline_state.js now does, so a regression there fails here.
const cardFor = (settings) =>
  ensureLlmFallbacks(
    settings.docai_provider_order || DEFAULT_PROVIDER_ORDER,
    (n) => isAdapterConfigured(n, settings),
  ).map((name) => ({
    name,
    configured_hint: isAdapterConfigured(name, settings),
    source: settings.docai_provider_order ? "tenant" : "default",
  }));

describe("adapter-chain card reflects the dispatcher, not a local guess", () => {
  it("shows the real default order when the tenant has pinned nothing", () => {
    const names = cardFor({}).map((a) => a.name);
    // The legacy hardcoded list started with reducto and omitted gemini
    // entirely — the exact display bug.
    expect(names[0]).toBe("gemini");
    expect(names).toEqual(expect.arrayContaining(DEFAULT_PROVIDER_ORDER));
    expect(names.slice(0, DEFAULT_PROVIDER_ORDER.length)).toEqual(DEFAULT_PROVIDER_ORDER);
  });

  it("labels a NULL provider order as the platform default, not a tenant choice", () => {
    expect(cardFor({}).every((a) => a.source === "default")).toBe(true);
    expect(cardFor({ docai_provider_order: ["claude"] })[0].source).toBe("tenant");
  });

  it("honours a genuinely pinned tenant order", () => {
    const names = cardFor({ docai_provider_order: ["claude", "gemini"] }).map((a) => a.name);
    expect(names.slice(0, 2)).toEqual(["claude", "gemini"]);
  });

  it("never reports an unconfigured adapter as configured", () => {
    // No keys and no env for these -> every hint must be false.
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (/^(ANTHROPIC|GEMINI|REDUCTO|AZURE_DI|UNSTRUCTURED|DOCLING|MARKER|LLAMAPARSE|LLAMA_CLOUD|OPENROUTER)/.test(k)) {
        delete process.env[k];
      }
    }
    try {
      const card = cardFor({ docai_provider_order: ["reducto", "azure_di", "unstructured"] });
      expect(card.every((a) => a.configured_hint === false)).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it("reports a configured adapter as configured (the old probe said false for all but three)", () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
    try {
      const card = cardFor({ docai_provider_order: ["gemini", "docling"] });
      expect(card.find((a) => a.name === "gemini").configured_hint).toBe(true);
      // docling needs an endpoint, which is not set — still false.
      expect(card.find((a) => a.name === "docling").configured_hint).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
    }
  });

  it("does not throw when ANVIL_SECRETS_KEY is unset (encrypted keys present)", () => {
    const saved = process.env.ANVIL_SECRETS_KEY;
    delete process.env.ANVIL_SECRETS_KEY;
    try {
      // Every adapter wraps decryptField in try/catch, so this must be false,
      // not an exception — the card is rendered on a read-only diagnostics
      // endpoint and must never 500.
      expect(() => cardFor({
        docai_provider_order: ["gemini"],
        docai_gemini_api_key_enc: "\\xdeadbeef",
        docai_creds_iv: "\\xbeef",
      })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.ANVIL_SECRETS_KEY;
      else process.env.ANVIL_SECRETS_KEY = saved;
    }
  });

  it("only ever names adapters that really exist in the registry", () => {
    expect(DEFAULT_PROVIDER_ORDER.every((n) => ADAPTER_NAMES.includes(n))).toBe(true);
  });
});
