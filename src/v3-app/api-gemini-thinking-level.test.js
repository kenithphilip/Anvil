// Gemini 3 reasoning depth on the extraction call.
//
// Why this exists: thinking tokens are drawn from the SAME maxOutputTokens
// budget as the answer, and Gemini 3 Flash thinks at "high" by DEFAULT. A
// 45-line PO needs only ~4,800 tokens of JSON but still truncated at
// max_tokens 8000, because the default reasoning consumed the rest. The docai
// path pins it low so the budget goes to line items.
//
// The casing matters more than it looks. Google's REST reference documents the
// values as lowercase ("minimal" | "low" | "medium" | "high"). An unknown enum
// value is a 400, and a 400 fails the whole request — so getting this wrong
// would break EVERY extraction, not just the long ones the setting targets.
// The first draft of this feature sent "LOW"; these tests pin the fix.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sent = [];
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }],
      }),
    };
  },
}));

let callGemini, IS_GEMINI_3;
beforeEach(async () => {
  sent.length = 0;
  ({ callGemini, IS_GEMINI_3 } = await import("../api/_lib/gemini.js"));
});
afterEach(() => { vi.clearAllMocks(); });

const call = (over = {}) => callGemini({
  tenantId: "t1",
  apiKey: "k",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gemini-3.6-flash",
  ...over,
});

describe("thinkingLevel wire format", () => {
  it("sends generationConfig.thinkingConfig.thinkingLevel in LOWERCASE", async () => {
    await call({ thinking_level: "low" });
    expect(sent[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
  });

  it("normalises an uppercase caller value down, so a 400 cannot be reintroduced", async () => {
    await call({ thinking_level: "HIGH" });
    expect(sent[0].generationConfig.thinkingConfig.thinkingLevel).toBe("high");
  });

  it("omits thinkingConfig entirely when the caller does not ask", async () => {
    await call();
    expect(sent[0].generationConfig.thinkingConfig).toBeUndefined();
  });

  it("omits it for non-Gemini-3 models", async () => {
    await call({ model: "gemini-2.5-flash", thinking_level: "low" });
    expect(sent[0].generationConfig.thinkingConfig).toBeUndefined();
  });

  it("never sends the legacy thinking_budget alongside it (Google 400s on both)", async () => {
    await call({ thinking_level: "low" });
    const gc = sent[0].generationConfig;
    expect(gc.thinkingBudget).toBeUndefined();
    expect(gc.thinking_budget).toBeUndefined();
  });
});

describe("IS_GEMINI_3 family test", () => {
  // The original gate was /3-/, which matches the preview spelling but NOT
  // "gemini-3.6-flash" ("3.6-" contains no "3-") — so media_resolution
  // silently stopped applying the moment the deployment moved to 3.6-flash.
  it.each([
    ["gemini-3-flash-preview", true],
    ["gemini-3.6-flash", true],
    ["gemini-3.1-pro-preview", true],
    ["gemini-2.5-flash", false],
    ["gemini-2.0-flash", false],
  ])("%s -> %s", (model, expected) => {
    expect(IS_GEMINI_3.test(model)).toBe(expected);
  });
});
