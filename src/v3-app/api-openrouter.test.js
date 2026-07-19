// OpenRouter adapter (spike): request shaping, firewall re-application, and
// response normalization. Mocks safeFetch so no network is hit.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ captured: null, response: null }));
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: vi.fn(async (url, init) => { H.captured = { url, init }; return H.response; }),
}));

const { callOpenRouter, pickOpenRouterModel, blocksToText, toOpenAiTools } = await import("../api/_lib/openrouter.js");
const { resolveProvider, providerConfigured, __test__ } = await import("../api/_lib/llm.js");

const okResponse = (bodyObj) => ({ ok: true, status: 200, json: async () => bodyObj });

beforeEach(() => {
  H.captured = null;
  H.response = okResponse({ choices: [{ message: { content: "hi", tool_calls: [] } }] });
  process.env.OPENROUTER_API_KEY = "or-test-key";
  delete process.env.OPENROUTER_MODEL;
});

describe("callOpenRouter request shaping", () => {
  it("builds an OpenAI-format body with a firewalled system message + auth header", async () => {
    await callOpenRouter({
      system: "You are an extractor.",
      messages: [{ role: "user", content: "classify this" }],
      tenantId: "t-1",
    });
    expect(H.captured.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(H.captured.init.headers.authorization).toBe("Bearer or-test-key");
    const body = JSON.parse(H.captured.init.body);
    expect(body.model).toBe("anthropic/claude-sonnet-4.5"); // default
    // system message carries the injection firewall (re-applied here, not the provider).
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("SYSTEM_FIREWALL");
    expect(body.messages[1]).toEqual({ role: "user", content: "classify this" });
    expect(body.temperature).toBe(0);
  });

  it("converts an Anthropic tool into an OpenAI function + forces tool_choice", async () => {
    await callOpenRouter({
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "extract", description: "d", input_schema: { type: "object", properties: {} } }],
    });
    const body = JSON.parse(H.captured.init.body);
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "extract", description: "d", parameters: { type: "object", properties: {} } } });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "extract" } });
  });

  it("honors an explicit model + OPENROUTER_MODEL env", async () => {
    expect(pickOpenRouterModel("x/y")).toBe("x/y");
    process.env.OPENROUTER_MODEL = "meta/llama";
    expect(pickOpenRouterModel()).toBe("meta/llama");
  });

  it("returns a normalized failure shape (no key / non-2xx)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const r1 = await callOpenRouter({ messages: [{ role: "user", content: "x" }] });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/OPENROUTER_API_KEY/);

    process.env.OPENROUTER_API_KEY = "or-test-key";
    H.response = { ok: false, status: 502, json: async () => ({ error: { message: "upstream boom" } }) };
    const r2 = await callOpenRouter({ messages: [{ role: "user", content: "x" }] });
    expect(r2.ok).toBe(false);
    expect(r2.status).toBe(502);
    expect(r2.error).toBe("upstream boom");
  });

  it("summarises non-text blocks rather than shipping raw bytes on the text path", () => {
    expect(blocksToText([{ type: "text", text: "a" }, { type: "document", source: {} }]))
      .toBe("a\n[document omitted on the OpenRouter text path]");
  });
});

describe("llm.js provider wiring for openrouter", () => {
  it("resolveProvider recognizes openrouter (explicit + env) and rejects typos", () => {
    expect(resolveProvider("f", "openrouter")).toBe("openrouter");
    expect(resolveProvider("f", "OpenRouter")).toBe("openrouter"); // normalized
    expect(resolveProvider("f", "bogus")).toBe("claude");          // unknown -> claude
  });

  it("providerConfigured tracks OPENROUTER_API_KEY", () => {
    process.env.OPENROUTER_API_KEY = "k";
    expect(providerConfigured("openrouter")).toBe(true);
    delete process.env.OPENROUTER_API_KEY;
    expect(providerConfigured("openrouter")).toBe(false);
  });

  it("normalizeOpenRouter parses tool_calls arguments into structured", () => {
    const r = __test__.normalizeOpenRouter({
      ok: true, status: 200, model: "m", tier: "openrouter",
      data: { choices: [{ message: { content: "", tool_calls: [{ function: { name: "extract", arguments: '{"classification":"po"}' } }] } }] },
    });
    expect(r.provider).toBe("openrouter");
    expect(r.structured).toEqual({ classification: "po" });
    expect(r.toolInput()).toEqual({ classification: "po" });
  });

  it("isRetryable: network/429/5xx yes, 4xx no", () => {
    expect(__test__.isRetryable(0)).toBe(true);
    expect(__test__.isRetryable(429)).toBe(true);
    expect(__test__.isRetryable(503)).toBe(true);
    expect(__test__.isRetryable(400)).toBe(false);
    expect(__test__.isRetryable(200)).toBe(false);
  });
});
