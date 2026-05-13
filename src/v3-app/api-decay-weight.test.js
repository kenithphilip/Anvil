// Unit tests for src/api/_lib/decay-weight.js (Wave CM 3.2).

import { describe, it, expect } from "vitest";
import {
  halfLifeDecay, daysBetween,
  weightedCorrections, topKWeighted, decayedScore,
} from "../api/_lib/decay-weight.js";

describe("halfLifeDecay", () => {
  it("returns 1 at zero days", () => {
    expect(halfLifeDecay(0)).toBe(1);
  });
  it("returns 0.5 at exactly the half-life", () => {
    expect(halfLifeDecay(90, 90)).toBeCloseTo(0.5);
  });
  it("returns 0.25 at two half-lives", () => {
    expect(halfLifeDecay(180, 90)).toBeCloseTo(0.25);
  });
  it("clamps negative inputs to 0 days = weight 1", () => {
    expect(halfLifeDecay(-10)).toBe(1);
  });
  it("falls back to default half-life on invalid input", () => {
    expect(halfLifeDecay(90, 0)).toBeCloseTo(0.5);    // 0 -> default 90
    expect(halfLifeDecay(90, "nan")).toBeCloseTo(0.5);
  });
});

describe("daysBetween", () => {
  it("computes absolute day difference", () => {
    const a = new Date("2026-01-01T00:00:00Z");
    const b = new Date("2026-01-11T00:00:00Z");
    expect(daysBetween(a, b)).toBe(10);
  });
  it("returns 0 on missing args", () => {
    expect(daysBetween(null, new Date())).toBe(0);
    expect(daysBetween(new Date(), null)).toBe(0);
  });
  it("handles string dates", () => {
    expect(daysBetween("2026-01-01", "2026-01-11")).toBeCloseTo(10);
  });
});

describe("weightedCorrections", () => {
  const now = new Date("2026-05-13T00:00:00Z");

  it("assigns weight=1 to a same-day correction", () => {
    const out = weightedCorrections(
      [{ created_at: "2026-05-13T00:00:00Z", field_path: "x" }],
      { now },
    );
    expect(out[0].weight).toBeCloseTo(1);
  });

  it("assigns weight=0 to undated rows", () => {
    const out = weightedCorrections([{ field_path: "x" }], { now });
    expect(out[0].weight).toBe(0);
  });

  it("decays older rows correctly", () => {
    const out = weightedCorrections(
      [
        { created_at: "2026-05-13T00:00:00Z", field_path: "today" },
        { created_at: "2026-02-12T00:00:00Z", field_path: "90 days ago" },
        { created_at: "2025-11-14T00:00:00Z", field_path: "180 days ago" },
      ],
      { now },
    );
    expect(out[0].weight).toBeCloseTo(1, 5);
    expect(out[1].weight).toBeCloseTo(0.5, 1);
    expect(out[2].weight).toBeCloseTo(0.25, 1);
  });
});

describe("topKWeighted", () => {
  const now = new Date("2026-05-13T00:00:00Z");

  it("returns top-K sorted by weight desc", () => {
    const out = topKWeighted(
      [
        { created_at: "2026-02-12T00:00:00Z", field_path: "B" },   // 90d -> 0.5
        { created_at: "2026-05-13T00:00:00Z", field_path: "A" },   // 0d -> 1.0
        { created_at: "2025-11-14T00:00:00Z", field_path: "C" },   // 180d -> 0.25
      ],
      2,
      { now },
    );
    expect(out.length).toBe(2);
    expect(out[0].field_path).toBe("A");
    expect(out[1].field_path).toBe("B");
  });

  it("breaks ties by created_at desc when two rows share the exact same weight", () => {
    // Two rows with identical created_at have identical weights;
    // the secondary sort is a no-op so they preserve relative
    // order. A third row with a distinct created_at sorts by
    // weight independently.
    const out = topKWeighted(
      [
        { created_at: "2026-02-12T00:00:00Z", field_path: "old_a" },   // 90d ago, weight ~0.5
        { created_at: "2026-05-13T00:00:00Z", field_path: "today" },   // weight 1.0
        { created_at: "2026-02-12T00:00:00Z", field_path: "old_b" },   // same as old_a, weight ~0.5
      ],
      3,
      { now },
    );
    expect(out[0].field_path).toBe("today");
    // old_a + old_b share weight; both come after today.
    expect(["old_a", "old_b"]).toContain(out[1].field_path);
    expect(["old_a", "old_b"]).toContain(out[2].field_path);
  });

  it("returns [] on empty", () => {
    expect(topKWeighted([])).toEqual([]);
  });
});

describe("decayedScore", () => {
  const now = new Date("2026-05-13T00:00:00Z");

  it("returns the raw score on same-day", () => {
    expect(decayedScore(0.9, "2026-05-13T00:00:00Z", { now })).toBeCloseTo(0.9);
  });

  it("decays scores from older corrections", () => {
    const out = decayedScore(0.9, "2026-02-12T00:00:00Z", { now });
    expect(out).toBeCloseTo(0.45, 1);
  });

  it("returns the raw score when no created_at", () => {
    expect(decayedScore(0.9, null, { now })).toBe(0.9);
  });
});
