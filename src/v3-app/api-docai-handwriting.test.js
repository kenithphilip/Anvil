// Unit tests for src/api/_lib/docai/handwriting.js (Wave 2.5).

import { describe, it, expect } from "vitest";
import {
  pageConfidenceStats, garbledTokenRatio,
  detectHandwriting, planHandwritingRoute,
  __test,
} from "../api/_lib/docai/handwriting.js";

describe("pageConfidenceStats", () => {
  it("returns null on empty input", () => {
    expect(pageConfidenceStats([])).toBeNull();
    expect(pageConfidenceStats(null)).toBeNull();
  });
  it("returns null when no page has a confidence number", () => {
    expect(pageConfidenceStats([{ page: 1 }, { page: 2, confidence: null }])).toBeNull();
  });
  it("computes mean and stddev", () => {
    const out = pageConfidenceStats([
      { page: 1, confidence: 0.9 },
      { page: 2, confidence: 0.7 },
      { page: 3, confidence: 0.5 },
    ]);
    expect(out.mean).toBeCloseTo(0.7, 5);
    expect(out.stddev).toBeGreaterThan(0);
    expect(out.count).toBe(3);
  });
});

describe("garbledTokenRatio", () => {
  it("returns 0 for clean English text", () => {
    expect(garbledTokenRatio("Purchase order for ten widgets")).toBe(0);
  });
  it("flags scrambled tokens", () => {
    const out = garbledTokenRatio("$%^ |}!{ Hello world &*( ?@#");
    expect(out).toBeGreaterThan(0.4);
  });
  it("returns 0 on empty", () => {
    expect(garbledTokenRatio("")).toBe(0);
  });
});

describe("__test.isGarbledToken", () => {
  it("flags tokens with >50% non-word chars", () => {
    expect(__test.isGarbledToken("&%^@!")).toBe(true);
    expect(__test.isGarbledToken("hello")).toBe(false);
  });
  it("returns false on too-short tokens", () => {
    expect(__test.isGarbledToken("@!")).toBe(false);
  });
});

describe("detectHandwriting", () => {
  it("returns suspected=false on null", () => {
    expect(detectHandwriting(null).suspected).toBe(false);
  });
  it("flags suspected when mean confidence is low + bbox count high", () => {
    const ocrLayer = {
      page_breakdown: [
        { page: 1, confidence: 0.30, chars: 200 },
        { page: 2, confidence: 0.25, chars: 180 },
      ],
      bbox_count: 18,
      body_text: "some text here",
    };
    const out = detectHandwriting(ocrLayer);
    expect(out.suspected).toBe(true);
    expect(out.score).toBeGreaterThan(0.45);
    expect(out.signals.bbox_count).toBe(18);
  });
  it("does not flag clean OCR", () => {
    const ocrLayer = {
      page_breakdown: [{ page: 1, confidence: 0.92, chars: 500 }],
      bbox_count: 25,
      body_text: "Purchase order for ten widgets",
    };
    expect(detectHandwriting(ocrLayer).suspected).toBe(false);
  });
  it("considers garbled token ratio when confidence isn't available", () => {
    const ocrLayer = {
      page_breakdown: [{ page: 1, confidence: null }],
      bbox_count: 12,
      body_text: "$%^ |}!{ Hello &*( ?@# nope &^% qwe!@$ asdrtgkjlsf%^&*",
    };
    const out = detectHandwriting(ocrLayer);
    expect(out.signals.garbled_token_ratio).toBeGreaterThan(0);
  });
});

describe("planHandwritingRoute", () => {
  it("returns 'none' when not suspected", () => {
    const out = planHandwritingRoute({ suspected: false, score: 0 }, {});
    expect(out.action).toBe("none");
  });
  it("escalates to human when no provider is configured", () => {
    const out = planHandwritingRoute({ suspected: true, score: 0.5 }, {});
    expect(out.action).toBe("escalate_to_human");
  });
  it("auto-reroutes when a provider is configured", () => {
    const out = planHandwritingRoute(
      { suspected: true, score: 0.6 },
      { docai_handwriting_provider: "azure_read_handwritten" },
    );
    expect(out.action).toBe("reocr_handwriting");
    expect(out.provider).toBe("azure_read_handwritten");
  });
  it("escalates to human when score is too high regardless of provider", () => {
    const out = planHandwritingRoute(
      { suspected: true, score: 0.9 },
      { docai_handwriting_provider: "azure_read_handwritten" },
    );
    expect(out.action).toBe("escalate_to_human");
    expect(out.reason).toBe("score_too_high_for_auto");
  });
});
