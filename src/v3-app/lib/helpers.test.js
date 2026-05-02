// Smoke tests for the shared helpers. These exist to prove the Vitest +
// Vite + jsdom chain works end-to-end. Real coverage will land alongside
// each screen conversion in Sub-PR 3.

import { describe, it, expect } from "vitest";
import { ageLabel, fmtINRShort, stageOf, sevOf } from "./helpers.js";

describe("ageLabel", () => {
  it("returns em-dash for nullish input", () => {
    expect(ageLabel(null)).toBe("—");
    expect(ageLabel(undefined)).toBe("—");
  });

  it("formats minutes under an hour", () => {
    const iso = new Date(Date.now() - 14 * 60_000).toISOString();
    expect(ageLabel(iso)).toBe("14m");
  });

  it("formats hours under a day", () => {
    const iso = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(ageLabel(iso)).toBe("3h");
  });

  it("formats days with optional residual hours", () => {
    const iso = new Date(Date.now() - (2 * 24 + 5) * 60 * 60_000).toISOString();
    expect(ageLabel(iso)).toBe("2d 5h");
  });
});

describe("fmtINRShort", () => {
  it("returns em-dash for null", () => {
    expect(fmtINRShort(null)).toBe("—");
  });

  it("formats lakhs above 10L", () => {
    expect(fmtINRShort(15_50_000)).toBe("₹ 15.5 L");
  });

  it("formats thousands above 1k", () => {
    expect(fmtINRShort(45_000)).toBe("₹ 45k");
  });

  it("formats small values with locale grouping", () => {
    expect(fmtINRShort(999)).toBe("₹ 999");
  });
});

describe("stageOf", () => {
  it("maps known status enums", () => {
    expect(stageOf("BLOCKED")).toEqual({ label: "blocked", k: "bad" });
    expect(stageOf("RECONCILED")).toEqual({ label: "shipped", k: "good" });
  });

  it("falls back to a ghost chip for unknown status", () => {
    const out = stageOf("WEIRD_STATE");
    expect(out.k).toBe("ghost");
    expect(out.label).toBe("weird_state");
  });
});

describe("sevOf", () => {
  it("returns high for blocked / failed-tally", () => {
    expect(sevOf({ status: "BLOCKED" })).toBe("high");
    expect(sevOf({ status: "FAILED_TALLY_IMPORT" })).toBe("high");
  });

  it("returns med for pending review / duplicate", () => {
    expect(sevOf({ status: "PENDING_REVIEW" })).toBe("med");
    expect(sevOf({ status: "DUPLICATE" })).toBe("med");
  });

  it("returns low otherwise", () => {
    expect(sevOf({ status: "APPROVED" })).toBe("low");
    expect(sevOf(null)).toBe("low");
  });
});
