// callLLM provider fallback + opt-in live failover. Mocks the three provider
// adapters so no network is hit and we can drive their return codes.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ claude: null, gemini: null, openrouter: null }));

vi.mock("../api/_lib/anthropic.js", () => ({ callAnthropic: vi.fn(async () => H.claude) }));
vi.mock("../api/_lib/gemini.js", () => ({
  callGemini: vi.fn(async () => H.gemini),
  extractTextFromGemini: () => "",
  parseStructuredGemini: () => null,
}));
vi.mock("../api/_lib/openrouter.js", () => ({ callOpenRouter: vi.fn(async () => H.openrouter) }));

const { callLLM } = await import("../api/_lib/llm.js");
const { callAnthropic } = await import("../api/_lib/anthropic.js");
const { callOpenRouter } = await import("../api/_lib/openrouter.js");

const orOk = { ok: true, status: 200, model: "or", tier: "openrouter", data: { choices: [{ message: { content: "or-said-hi" } }] } };
const claudeDown = { ok: false, status: 503, error: "anthropic 503" };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LLM_FAILOVER;
  delete process.env.GEMINI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "an-key";
  process.env.OPENROUTER_API_KEY = "or-key";
  H.claude = { ok: true, status: 200, data: { content: [{ type: "text", text: "claude-hi" }] } };
  H.openrouter = orOk;
});

describe("callLLM provider fallback + failover", () => {
  it("falls back to a configured provider when the chosen one has no key", async () => {
    delete process.env.OPENROUTER_API_KEY; // choose openrouter but it's unconfigured
    const r = await callLLM({ provider: "openrouter", tenantId: "t", messages: [{ role: "user", content: "x" }] });
    expect(callAnthropic).toHaveBeenCalledTimes(1); // fell back to claude
    expect(callOpenRouter).not.toHaveBeenCalled();
    expect(r.provider).toBe("claude");
    expect(r.text).toBe("claude-hi");
  });

  it("does NOT fail over by default (LLM_FAILOVER unset), even on a 503", async () => {
    H.claude = claudeDown;
    const r = await callLLM({ provider: "claude", tenantId: "t", messages: [{ role: "user", content: "x" }] });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
    expect(callOpenRouter).not.toHaveBeenCalled();
    expect(r.failed_over_from).toBeUndefined();
  });

  it("fails over to the next configured provider on a retryable error when LLM_FAILOVER=1", async () => {
    process.env.LLM_FAILOVER = "1";
    H.claude = claudeDown;
    const r = await callLLM({ provider: "claude", tenantId: "t", messages: [{ role: "user", content: "x" }] });
    expect(callAnthropic).toHaveBeenCalledTimes(1);
    expect(callOpenRouter).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("openrouter");
    expect(r.text).toBe("or-said-hi");
    expect(r.failed_over_from).toBe("claude");
  });

  it("does NOT fail over on a non-retryable 4xx", async () => {
    process.env.LLM_FAILOVER = "1";
    H.claude = { ok: false, status: 400, error: "bad request" };
    const r = await callLLM({ provider: "claude", tenantId: "t", messages: [{ role: "user", content: "x" }] });
    expect(callOpenRouter).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
