// mediaResolution is a protobuf enum, and Anvil stores the friendly word.
//
// Gemini failed in ~100ms on EVERY call with:
//   Invalid value at 'generation_config.media_resolution'
//   (...v1beta.GenerationConfig.MediaResolution), "high"
//
// The bug was latent for months: the family test used to be /3-/, which does
// not match "gemini-3.6-flash", so the knob was never sent. Widening it to
// IS_GEMINI_3 made the knob start applying and took the primary adapter out —
// every document silently demoted down the fallback chain, which is how a
// 13-page PO ended up starving LlamaParse of run budget.
//
// These assert the WIRE value, not the stored one: the stored vocabulary
// ("high" in tenant_settings / GEMINI_MEDIA_RESOLUTION) is deliberately
// unchanged, and translation happens at the edge.

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

let callGemini, toMediaResolutionEnum;
const savedEnv = { ...process.env };
beforeEach(async () => {
  sent.length = 0;
  ({ callGemini, toMediaResolutionEnum } = await import("../api/_lib/gemini.js"));
});
afterEach(() => { vi.clearAllMocks(); process.env = { ...savedEnv }; });

const call = (over = {}) => callGemini({
  tenantId: "t1",
  apiKey: "k",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  model: "gemini-3.6-flash",
  ...over,
});

describe("toMediaResolutionEnum", () => {
  it.each([
    ["low", "MEDIA_RESOLUTION_LOW"],
    ["medium", "MEDIA_RESOLUTION_MEDIUM"],
    ["high", "MEDIA_RESOLUTION_HIGH"],
    ["ultra_high", "MEDIA_RESOLUTION_ULTRA_HIGH"],
  ])("maps the stored word %s to the proto enum", (word, wire) => {
    expect(toMediaResolutionEnum(word)).toBe(wire);
  });

  it("passes an already-prefixed value through, so raw env still works", () => {
    expect(toMediaResolutionEnum("MEDIA_RESOLUTION_MEDIUM")).toBe("MEDIA_RESOLUTION_MEDIUM");
  });

  it("tolerates case and whitespace, which env vars accumulate", () => {
    expect(toMediaResolutionEnum(" HIGH ")).toBe("MEDIA_RESOLUTION_HIGH");
  });

  // null is what lets the caller OMIT the field. Echoing the input back would
  // forward the typo and reproduce the exact 400 this fixes.
  it.each([[""], ["  "], [undefined], [null], ["huge"], ["MEDIUM_RES"]])(
    "returns null for the unmappable value %p rather than forwarding it",
    (input) => { expect(toMediaResolutionEnum(input)).toBeNull(); },
  );
});

describe("mediaResolution wire format", () => {
  it("sends the proto enum, never the bare word Google rejects", async () => {
    await call({ media_resolution: "high" });
    expect(sent[0].generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
  });

  it("defaults to high — as an enum — when neither caller nor env sets it", async () => {
    delete process.env.GEMINI_MEDIA_RESOLUTION;
    await call();
    expect(sent[0].generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_HIGH");
  });

  it("translates the env default too, which is where 'high' actually came from", async () => {
    process.env.GEMINI_MEDIA_RESOLUTION = "medium";
    await call();
    expect(sent[0].generationConfig.mediaResolution).toBe("MEDIA_RESOLUTION_MEDIUM");
  });

  it("omits the field for non-Gemini-3 models", async () => {
    await call({ model: "gemini-2.5-flash", media_resolution: "high" });
    expect(sent[0].generationConfig.mediaResolution).toBeUndefined();
  });

  it("omits an unmappable value instead of 400ing the whole request", async () => {
    await call({ media_resolution: "enormous" });
    expect(sent[0].generationConfig.mediaResolution).toBeUndefined();
  });

  // ULTRA_HIGH is documented as per-PART only; at generationConfig level it is
  // rejected. The admin panel offers it, so a tenant can be configured this way
  // — dropping it yields a working extraction at Google's default rather than a
  // hard 400 on every document.
  it("drops ultra_high at config level rather than sending a per-part-only value", async () => {
    await call({ media_resolution: "ultra_high" });
    expect(sent[0].generationConfig.mediaResolution).toBeUndefined();
  });

  it("no generationConfig value is ever a bare lowercase word", async () => {
    await call({ media_resolution: "high", thinking_level: "low" });
    const mr = sent[0].generationConfig.mediaResolution;
    expect(mr).toMatch(/^MEDIA_RESOLUTION_[A-Z_]+$/);
  });
});
