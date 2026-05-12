// Unit tests for src/api/_lib/docai/multi-language.js (Wave 2.4).

import { describe, it, expect, vi } from "vitest";
import {
  scriptHistogram,
  dominantScripts,
  detectLineLanguages,
  annotateLineLanguages,
  translateBatch,
} from "../api/_lib/docai/multi-language.js";

describe("scriptHistogram", () => {
  it("counts latin glyphs", () => {
    expect(scriptHistogram("Hello").latin).toBe(5);
  });
  it("counts hangul (Korean)", () => {
    const out = scriptHistogram("주문서 PO-1");
    expect(out.hangul).toBeGreaterThan(0);
    expect(out.latin).toBeGreaterThan(0);
  });
  it("counts devanagari", () => {
    expect(scriptHistogram("नमस्ते").devanagari).toBeGreaterThan(0);
  });
  it("counts kanji and hiragana", () => {
    const out = scriptHistogram("注文書 はい");
    expect(out.kanji).toBeGreaterThan(0);
    expect(out.hiragana).toBeGreaterThan(0);
  });
  it("ignores digits and whitespace", () => {
    expect(scriptHistogram("   123  ")).toEqual({});
  });
});

describe("dominantScripts", () => {
  it("returns the highest-count script as dominant", () => {
    const hist = { latin: 50, hangul: 20 };
    const out = dominantScripts(hist);
    expect(out.dominant).toBe("latin");
    expect(out.all.map((x) => x.script)).toContain("hangul");
  });
  it("filters scripts below 10% share", () => {
    const hist = { latin: 100, hangul: 1 };       // 1% only
    const out = dominantScripts(hist);
    expect(out.all.map((x) => x.script)).not.toContain("hangul");
  });
  it("returns empty on empty histogram", () => {
    expect(dominantScripts({})).toEqual({ dominant: null, all: [] });
  });
});

describe("detectLineLanguages", () => {
  it("flags non-English descriptions as needs_translation", () => {
    const out = detectLineLanguages({ description: "현대 모비스 부품", partNumber: "HMC-1" });
    expect(out.needs_translation).toBe(true);
    expect(out.detected_languages.some((x) => x.script === "hangul")).toBe(true);
  });
  it("leaves pure-English alone", () => {
    const out = detectLineLanguages({ description: "Bend adapter", partNumber: "BA-1" });
    expect(out.needs_translation).toBe(false);
  });
  it("returns empty when there are no text fields", () => {
    const out = detectLineLanguages({ quantity: 5 });
    expect(out.detected_languages).toEqual([]);
    expect(out.needs_translation).toBe(false);
  });
});

describe("annotateLineLanguages", () => {
  it("mutates each line in place and returns a summary", () => {
    const normalized = {
      lines: [
        { description: "Bend adapter" },
        { description: "현대 부품" },
        { description: "ขอบคุณ" },
      ],
    };
    const summary = annotateLineLanguages(normalized);
    expect(summary.lines_annotated).toBe(3);
    expect(summary.lines_needing_translation).toBe(2);
    expect(summary.scripts_seen).toContain("hangul");
    expect(summary.scripts_seen).toContain("thai");
    expect(normalized.lines[1].needs_translation).toBe(true);
    expect(normalized.lines[0].needs_translation).toBe(false);
  });
  it("tolerates missing lines array", () => {
    expect(annotateLineLanguages(null).lines_annotated).toBe(0);
    expect(annotateLineLanguages({}).lines_annotated).toBe(0);
  });
});

describe("translateBatch", () => {
  it("returns null when no callAnthropic is supplied", async () => {
    expect(await translateBatch([{ id: "1", text: "x" }], {})).toBeNull();
  });
  it("returns null when callAnthropic fails", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({ ok: false });
    expect(await translateBatch([{ id: "1", text: "x" }], { callAnthropic })).toBeNull();
  });
  it("aggregates translations keyed by id", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use",
          name: "return_translations",
          input: {
            translations: [
              { id: "a", text: "Hello" },
              { id: "b", text: "World" },
            ],
          },
        }],
      },
    });
    const out = await translateBatch(
      [{ id: "a", text: "안녕" }, { id: "b", text: "세계" }],
      { callAnthropic },
    );
    expect(out).toEqual({ a: "Hello", b: "World" });
  });
  it("drops malformed entries silently", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use",
          name: "return_translations",
          input: {
            translations: [
              { id: "a", text: "Hello" },
              { id: null, text: "World" },
              { text: "Missing id" },
            ],
          },
        }],
      },
    });
    const out = await translateBatch([{ id: "a", text: "x" }], { callAnthropic });
    expect(out).toEqual({ a: "Hello" });
  });
});
