// Provider-agnostic LLM router (P1). Pure tests: provider resolution
// precedence, response normalization for BOTH provider shapes, and the
// Anthropic-tool -> Gemini-responseSchema translation.

import { describe, it, expect, afterEach } from "vitest";
import { resolveProvider, __test__ } from "../api/_lib/llm.js";

const { toGeminiSchema, normalizeClaude, normalizeGemini } = __test__;

afterEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.LLM_PROVIDER_EMAIL_CLASSIFIER;
});

describe("resolveProvider precedence", () => {
  it("defaults to claude", () => {
    expect(resolveProvider("email_classifier")).toBe("claude");
  });
  it("global LLM_PROVIDER=gemini switches all features", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(resolveProvider("anything")).toBe("gemini");
  });
  it("per-feature env overrides the global default", () => {
    process.env.LLM_PROVIDER = "claude";
    process.env.LLM_PROVIDER_EMAIL_CLASSIFIER = "gemini";
    expect(resolveProvider("email_classifier")).toBe("gemini");
    expect(resolveProvider("other_feature")).toBe("claude");
  });
  it("explicit provider wins over env", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(resolveProvider("x", "claude")).toBe("claude");
  });
  it("unknown provider values fall back to claude", () => {
    expect(resolveProvider("x", "bogus")).toBe("claude");
  });

  // P2: per-tenant settings.
  it("per-tenant default (settings.llm_provider) applies when no env/explicit", () => {
    expect(resolveProvider("email_classifier", null, { llm_provider: "gemini" })).toBe("gemini");
  });
  it("per-tenant per-feature override beats per-tenant default AND env global", () => {
    process.env.LLM_PROVIDER = "claude";
    const settings = { llm_provider: "claude", llm_provider_overrides: { email_classifier: "gemini" } };
    expect(resolveProvider("email_classifier", null, settings)).toBe("gemini");
    expect(resolveProvider("anomaly_explain", null, settings)).toBe("claude");
  });
  it("env per-feature beats per-tenant default (env is more specific than tenant default)", () => {
    process.env.LLM_PROVIDER_EMAIL_CLASSIFIER = "gemini";
    expect(resolveProvider("email_classifier", null, { llm_provider: "claude" })).toBe("gemini");
  });
  it("explicit still wins over per-tenant override", () => {
    const settings = { llm_provider_overrides: { email_classifier: "gemini" } };
    expect(resolveProvider("email_classifier", "claude", settings)).toBe("claude");
  });
});

describe("normalizeClaude — data.content blocks", () => {
  const r = {
    ok: true, status: 200, model: "claude-x", tier: "preflight",
    data: { content: [
      { type: "text", text: "hello" },
      { type: "tool_use", name: "classify_email", input: { intent: "po", confidence: 0.9 } },
    ] },
  };
  it("exposes text, structured, and toolInput(name)", () => {
    const n = normalizeClaude(r);
    expect(n.provider).toBe("claude");
    expect(n.text).toBe("hello");
    expect(n.structured).toEqual({ intent: "po", confidence: 0.9 });
    expect(n.toolInput("classify_email")).toEqual({ intent: "po", confidence: 0.9 });
    expect(n.toolInput("missing")).toBeNull();
  });
});

describe("normalizeGemini — candidates parts", () => {
  const r = {
    ok: true, status: 200, model: "gemini-x", tier: "preflight",
    data: { candidates: [{ content: { parts: [{ text: '{"intent":"rfq","confidence":0.8}' }] } }] },
  };
  it("parses structured JSON and exposes it via structured + toolInput", () => {
    const n = normalizeGemini(r);
    expect(n.provider).toBe("gemini");
    expect(n.structured).toEqual({ intent: "rfq", confidence: 0.8 });
    expect(n.toolInput("classify_email")).toEqual({ intent: "rfq", confidence: 0.8 });
  });
});

describe("toGeminiSchema — Anthropic tool schema -> Gemini responseSchema", () => {
  it("strips keys Gemini rejects, keeps structure", () => {
    const s = toGeminiSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      additionalProperties: false,
      properties: { intent: { type: "string", enum: ["po", "rfq"] }, nested: { type: "object", additionalProperties: false, properties: { a: { type: "number" } } } },
      required: ["intent"],
    });
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBeUndefined();
    expect(s.properties.nested.additionalProperties).toBeUndefined();
    expect(s.properties.intent.enum).toEqual(["po", "rfq"]);
    expect(s.required).toEqual(["intent"]);
  });
});
