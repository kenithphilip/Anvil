// OpenRouter DocAI extraction adapter: text-first extraction, normalized to the
// shared pipeline shape. callOpenRouter is mocked (no network); parseSchemaAligned
// + the shared TOOL_DEFINITION are real.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ resp: null, captured: null }));
vi.mock("../api/_lib/openrouter.js", () => ({
  callOpenRouter: vi.fn(async (opts) => { H.captured = opts; return H.resp; }),
  pickOpenRouterModel: (o) => o || "test/model",
  // The adapter resolves the key through the shared helper, which accepts the
  // canonical OPENROUTER_API_KEY or the `open_router` alias the deployment sets.
  openRouterApiKey: () => process.env.OPENROUTER_API_KEY || process.env.open_router || null,
}));

const { isConfigured, extract } = await import("../api/_lib/docai/openrouter.js");

const toolResp = (obj) => ({
  ok: true, status: 200,
  data: { choices: [{ message: { content: "", tool_calls: [{ function: { name: "extract_purchase_order", arguments: JSON.stringify(obj) } }] } }] },
});

const settings = { tenant_id: "t-1" };
const hints = { bodyText: "PO 4500312200\nAcme Steels\n1  WG-100  2  1000\n" };

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "or-key";
  delete process.env.OPENROUTER_DOCAI_MODEL;
  H.resp = toolResp({ classification: "po", confidence: 0.88, customer: { name: "Acme Steels" }, lines: [{ partNumber: "WG-100", quantity: 2, unitPrice: 1000 }] });
  H.captured = null;
});

describe("openrouter docai adapter", () => {
  it("isConfigured tracks OPENROUTER_API_KEY", () => {
    expect(isConfigured()).toBe(true);
    delete process.env.OPENROUTER_API_KEY;
    expect(isConfigured()).toBe(false);
  });

  it("skips cleanly (text-first) when there is no bodyText/OCR layer", async () => {
    const r = await extract({ settings, hints: {} });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_text_layer");
  });

  it("extracts + normalizes a PO to the shared pipeline shape", async () => {
    const r = await extract({ settings, hints });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("openrouter_document");
    expect(r.normalized.classification).toBe("po");
    expect(r.normalized.customer).toEqual({ name: "Acme Steels" });
    expect(r.normalized.lines).toHaveLength(1);
    expect(r.confidences.overall).toBe(0.88);
    expect(r.confidences["lines[0]"]).toBe(0.88);
    // It forced the shared extraction tool + sent the text layer.
    expect(H.captured.tools[0].name).toBe("extract_purchase_order");
    expect(H.captured.messages[0].content).toContain("PO 4500312200");
  });

  it("short-circuits non_po without fabricated lines", async () => {
    H.resp = toolResp({ classification: "non_po", confidence: 0.4 });
    const r = await extract({ settings, hints });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("non_po");
    expect(r.normalized.lines).toEqual([]);
  });

  it("returns upstream_error on a failed OpenRouter call", async () => {
    H.resp = { ok: false, status: 502, error: "gateway down" };
    const r = await extract({ settings, hints });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("upstream_error");
    expect(r.status).toBe(502);
  });

  it("honors a tenant/env model override", async () => {
    process.env.OPENROUTER_DOCAI_MODEL = "qwen/qwen-2-vl";
    await extract({ settings, hints });
    expect(H.captured.model).toBe("qwen/qwen-2-vl");
  });
});
