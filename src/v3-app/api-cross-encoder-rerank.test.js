// Unit tests for src/api/_lib/cross-encoder-rerank.js (Wave CM 2.3).

import { describe, it, expect, vi } from "vitest";
import { buildRerankPrompt, rerankCandidates } from "../api/_lib/cross-encoder-rerank.js";

describe("buildRerankPrompt", () => {
  it("includes the query line + every candidate", () => {
    const out = buildRerankPrompt(
      { partNumber: "GD544", description: "GUIDE ASSY" },
      [
        { item_id: "i1", part_no: "THB-001", description: "Bend adapter" },
        { item_id: "i2", part_no: "THB-002", description: "Guide assembly" },
      ],
    );
    expect(out).toContain("QUERY LINE");
    expect(out).toContain("GD544");
    expect(out).toContain("GUIDE ASSY");
    expect(out).toContain("THB-001");
    expect(out).toContain("Guide assembly");
  });

  it("caps candidates and description length", () => {
    const cands = Array.from({ length: 20 }, (_, i) => ({
      item_id: "x" + i, part_no: "P" + i, description: "y".repeat(500),
    }));
    const out = buildRerankPrompt({ partNumber: "Q" }, cands);
    // Only first 12 (MAX_CANDIDATES) should appear.
    expect(out).toContain("[x0]");
    expect(out).toContain("[x11]");
    expect(out).not.toContain("[x12]");
    // Each description trimmed to MAX_DESC_CHARS=160 not 500.
    expect(out.split("y").length - 1).toBeLessThan(20 * 500);
  });
});

describe("rerankCandidates", () => {
  it("returns null on missing inputs", async () => {
    expect(await rerankCandidates({ line: null, candidates: [] })).toBeNull();
    expect(await rerankCandidates({ line: { partNumber: "X" }, candidates: [] })).toBeNull();
  });

  it("returns null when callAnthropic missing", async () => {
    expect(await rerankCandidates({
      line: { partNumber: "X" },
      candidates: [{ item_id: "i1" }],
    })).toBeNull();
  });

  it("returns the top-K with scores normalised to 0..1", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use", name: "score_candidates",
          input: {
            scores: [
              { item_id: "i1", score: 95, reason: "exact match" },
              { item_id: "i2", score: 30, reason: "weak" },
              { item_id: "i3", score: 60, reason: "plausible" },
            ],
          },
        }],
      },
    });
    const out = await rerankCandidates({
      line: { partNumber: "X", description: "Bend adapter" },
      candidates: [
        { item_id: "i1", part_no: "P1", description: "Bend adapter" },
        { item_id: "i2", part_no: "P2", description: "Bolt M8" },
        { item_id: "i3", part_no: "P3", description: "Adapter ring" },
      ],
      callAnthropic,
      opts: { topK: 2 },
    });
    expect(out.length).toBe(2);
    expect(out[0].item_id).toBe("i1");
    expect(out[0].rerank_score).toBeCloseTo(0.95);
    expect(out[1].item_id).toBe("i3");
  });

  it("drops hallucinated item_ids", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use", name: "score_candidates",
          input: {
            scores: [
              { item_id: "i1", score: 90 },
              { item_id: "hallucinated", score: 99 },
            ],
          },
        }],
      },
    });
    const out = await rerankCandidates({
      line: { partNumber: "X" },
      candidates: [{ item_id: "i1", part_no: "P", description: "Bend" }],
      callAnthropic,
    });
    expect(out.length).toBe(1);
    expect(out[0].item_id).toBe("i1");
  });

  it("returns null when the upstream call fails", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({ ok: false });
    expect(await rerankCandidates({
      line: { partNumber: "X" },
      candidates: [{ item_id: "i1" }],
      callAnthropic,
    })).toBeNull();
  });

  it("returns null when the model omits the tool_use block", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: { content: [{ type: "text", text: "no tool" }] },
    });
    expect(await rerankCandidates({
      line: { partNumber: "X" },
      candidates: [{ item_id: "i1" }],
      callAnthropic,
    })).toBeNull();
  });

  it("clamps scores outside [0, 100]", async () => {
    const callAnthropic = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: [{
          type: "tool_use", name: "score_candidates",
          input: { scores: [{ item_id: "i1", score: 250 }, { item_id: "i2", score: -10 }] },
        }],
      },
    });
    const out = await rerankCandidates({
      line: { partNumber: "X" },
      candidates: [{ item_id: "i1", part_no: "P" }, { item_id: "i2", part_no: "Q" }],
      callAnthropic,
    });
    expect(out[0].rerank_score).toBe(1);   // clamped from 250
    const i2 = out.find((c) => c.item_id === "i2");
    expect(i2.rerank_score).toBe(0);       // clamped from -10
  });
});
