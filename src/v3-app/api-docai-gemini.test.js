// Gemini adapter regression tests.
//
// We don't make a real Generative Language API call; the helper
// is mocked. We assert:
//   1. isConfigured honours the GEMINI_API_KEY env var.
//   2. The PO + supplier-ack tools + system prompts are present
//      in the source verbatim (so the adapter's contract with
//      the dispatcher stays stable).
//   3. The adapter switches schemas based on hints.expectedKind.
//   4. PDF bytes are sent as document inlineData; UTF-8 text
//      hints become text parts.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/_lib/docai/gemini.js"),
  "utf8",
);

describe("gemini / source contract", () => {
  it("declares the PO + supplier-ack schemas + prompts", () => {
    expect(SRC).toMatch(/PO_SCHEMA/);
    expect(SRC).toMatch(/SUPPLIER_ACK_SCHEMA/);
    expect(SRC).toMatch(/PO_SYSTEM_PROMPT/);
    expect(SRC).toMatch(/SUPPLIER_ACK_SYSTEM_PROMPT/);
  });

  for (const f of ["partNumber", "quantity", "unitPrice", "hsn", "gst_pct"]) {
    it("PO schema contains line field " + f, () => {
      expect(SRC).toMatch(new RegExp("\\b" + f + "\\b"));
    });
  }

  for (const f of ["supplier_ref", "confirmed_price", "confirmed_currency", "confirmed_eta", "line_acks"]) {
    it("supplier-ack schema contains header field " + f, () => {
      expect(SRC).toMatch(new RegExp("\\b" + f + "\\b"));
    });
  }

  it("respects hints.expectedKind for tool selection", () => {
    expect(SRC).toMatch(/expectedKind\s*===\s*['"]supplier_ack['"]/);
  });

  it("routes PDF bytes to document inlineData", () => {
    expect(SRC).toMatch(/isPdfBytes/);
    expect(SRC).toMatch(/media_type:\s*['"]application\/pdf['"]/);
  });

  it("routes image bytes to image inlineData via image MIME check", () => {
    expect(SRC).toMatch(/isImageMime/);
  });
});

describe("gemini / isConfigured", () => {
  let saved;
  beforeEach(() => { saved = process.env.GEMINI_API_KEY; });

  it("returns true when GEMINI_API_KEY is set", async () => {
    process.env.GEMINI_API_KEY = "test-key-123";
    try {
      const mod = await import("../api/_lib/docai/gemini.js?_=1");
      expect(mod.isConfigured({})).toBe(true);
    } finally {
      if (saved) process.env.GEMINI_API_KEY = saved;
      else delete process.env.GEMINI_API_KEY;
    }
  });

  it("returns false when GEMINI_API_KEY is absent and no tenant key", async () => {
    delete process.env.GEMINI_API_KEY;
    try {
      const mod = await import("../api/_lib/docai/gemini.js?_=2");
      expect(mod.isConfigured({})).toBe(false);
    } finally {
      if (saved) process.env.GEMINI_API_KEY = saved;
    }
  });
});

describe("gemini / extract end-to-end (with mocked HTTP)", () => {
  let saved;
  beforeEach(() => {
    vi.resetModules();
    saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";
  });

  it("returns ok=true with parsed normalized + confidences for a PO", async () => {
    vi.doMock("../api/_lib/gemini.js", () => ({
      callGemini: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            classification: "po",
            confidence: 0.91,
            customer: { name: "Acme", gstin: "27AAACA1234B1Z5", currency: "INR" },
            lines: [{ partNumber: "X", description: "Y", quantity: 3, unitPrice: 100, hsn: "8482", gst_pct: 18 }],
          }) }] } }],
        },
        model: "gemini-2.5-flash",
      })),
      pickGeminiModel: () => ({ model: "gemini-2.5-flash", tier: "generation" }),
      MODEL_BY_TIER: { preflight: "gemini-2.5-flash", generation: "gemini-2.5-flash", reasoning: "gemini-2.5-pro" },
      extractTextFromGemini: (d) => d.candidates[0].content.parts[0].text,
      parseStructuredGemini: (d) => ({ ok: true, value: JSON.parse(d.candidates[0].content.parts[0].text) }),
      stopReasonFromGemini: () => "STOP",
    }));
    const mod = await import("../api/_lib/docai/gemini.js");
    const out = await mod.extract({
      bytes: Buffer.from("%PDF-fake bytes here"),
      mime: "application/pdf",
      settings: { tenant_id: "t1" },
      hints: {},
    });
    expect(out.ok).toBe(true);
    expect(out.normalized.classification).toBe("po");
    expect(out.normalized.lines).toHaveLength(1);
    expect(out.confidences.overall).toBeCloseTo(0.91, 2);
    expect(out.mode).toBe("pdf_document");
    if (saved) process.env.GEMINI_API_KEY = saved;
  });

  it("switches to supplier_ack schema when hints.expectedKind=supplier_ack", async () => {
    vi.doMock("../api/_lib/gemini.js", () => ({
      callGemini: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: {
          candidates: [{ content: { parts: [{ text: JSON.stringify({
            classification: "ack",
            confidence: 0.9,
            supplier_ref: "SUP-1",
            confirmed_price: 12000,
            confirmed_currency: "INR",
            confirmed_eta: "2026-06-30",
            payment_terms: "Net 30",
            remarks: null,
            line_acks: [{ partNumber: "X", quantity: 5, unit_price: 100, eta: null, rejected: false }],
          }) }] } }],
        },
        model: "gemini-2.5-flash",
      })),
      pickGeminiModel: () => ({ model: "gemini-2.5-flash", tier: "generation" }),
      MODEL_BY_TIER: { preflight: "gemini-2.5-flash", generation: "gemini-2.5-flash", reasoning: "gemini-2.5-pro" },
      extractTextFromGemini: (d) => d.candidates[0].content.parts[0].text,
      parseStructuredGemini: (d) => ({ ok: true, value: JSON.parse(d.candidates[0].content.parts[0].text) }),
      stopReasonFromGemini: () => "STOP",
    }));
    const mod = await import("../api/_lib/docai/gemini.js");
    const out = await mod.extract({
      bytes: Buffer.from("%PDF-fake supplier ack bytes"),
      mime: "application/pdf",
      settings: { tenant_id: "t1" },
      hints: { expectedKind: "supplier_ack" },
    });
    expect(out.ok).toBe(true);
    expect(out.normalized.supplier_ack).toBeTruthy();
    expect(out.normalized.supplier_ack.confirmed_price).toBe(12000);
    expect(out.normalized.lines).toHaveLength(1);
    expect(out.normalized.lines[0].partNumber).toBe("X");
    expect(out.normalized.lines[0].quantity).toBe(5);
    if (saved) process.env.GEMINI_API_KEY = saved;
  });
});
