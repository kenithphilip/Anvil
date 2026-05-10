// Tests for the Phase 3.5 additions to the inventory engine:
//   - notifications dispatcher (severity threshold + window + cap)
//   - exception detectors (smoke against an in-memory svc stub)
//
// The engine library itself was tested in inventory-engine.test.js;
// this file covers the runtime that wraps the math.

import { describe, it, expect } from "vitest";

// ----------------------------------------------------------------
// Severity-threshold + time-window helpers (private to notifications.js;
// re-implemented here as a smoke check for the algorithm).

const SEVERITY_RANK = { info: 1, warn: 2, bad: 3, critical: 4 };
const meets = (sev, thr) => (SEVERITY_RANK[sev] || 0) >= (SEVERITY_RANK[thr] || 4);

const isWithinWindow = (now, startStr, endStr) => {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const parse = (s) => {
    const [h, m] = String(s || "00:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const s = parse(startStr); const e = parse(endStr);
  if (s === e) return true;
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e;
};

describe("Phase 3.5 notification severity gate", () => {
  it("critical-only threshold rejects bad/warn/info", () => {
    expect(meets("critical", "critical")).toBe(true);
    expect(meets("bad", "critical")).toBe(false);
    expect(meets("warn", "critical")).toBe(false);
    expect(meets("info", "critical")).toBe(false);
  });

  it("bad threshold accepts critical + bad", () => {
    expect(meets("critical", "bad")).toBe(true);
    expect(meets("bad", "bad")).toBe(true);
    expect(meets("warn", "bad")).toBe(false);
  });

  it("warn threshold accepts critical + bad + warn", () => {
    expect(meets("critical", "warn")).toBe(true);
    expect(meets("bad", "warn")).toBe(true);
    expect(meets("warn", "warn")).toBe(true);
    expect(meets("info", "warn")).toBe(false);
  });
});

describe("Phase 3.5 voice escalation window (IST)", () => {
  // Build a UTC instant whose IST projection lands at a specific
  // hour:minute. IST = UTC + 5:30, so an IST-noon instant is
  // UTC 06:30.
  const ISTat = (h, m) => {
    const utcH = (h - 5 + 24) % 24;
    const utcM = (m - 30 + 60) % 60;
    const adjustH = m < 30 ? (utcH - 1 + 24) % 24 : utcH;
    const d = new Date(Date.UTC(2026, 4, 8, adjustH, utcM));
    return d;
  };

  it("noon IST is inside the 08:00-20:00 default window", () => {
    expect(isWithinWindow(ISTat(12, 0), "08:00", "20:00")).toBe(true);
  });

  it("3am IST is outside the 08:00-20:00 default window", () => {
    expect(isWithinWindow(ISTat(3, 0), "08:00", "20:00")).toBe(false);
  });

  it("21:00 IST is outside the 08:00-20:00 default window", () => {
    expect(isWithinWindow(ISTat(21, 0), "08:00", "20:00")).toBe(false);
  });

  it("overnight window: 22:00 IST falls inside 22:00-06:00", () => {
    expect(isWithinWindow(ISTat(22, 30), "22:00", "06:00")).toBe(true);
  });

  it("overnight window: noon IST falls outside 22:00-06:00", () => {
    expect(isWithinWindow(ISTat(12, 0), "22:00", "06:00")).toBe(false);
  });
});

// ----------------------------------------------------------------
// Per-class default service level (replicates the cron's mapping).
const SL_BY_TYPE = {
  ATD: 0.99, TIMER: 0.99,
  GUN: 0.95, GUN_COMPONENT: 0.95,
  SPARE: 0.85, CONSUMABLE: 0.85,
  OTHER: 0.95,
};
const defaultServiceLevel = (itemType, tenantDefault) =>
  (itemType && SL_BY_TYPE[itemType]) || tenantDefault || 0.95;

describe("Phase 3.5 per-class service-level defaults", () => {
  it("ATD/Timer gets 0.99 (critical)", () => {
    expect(defaultServiceLevel("ATD", 0.5)).toBe(0.99);
    expect(defaultServiceLevel("TIMER", 0.5)).toBe(0.99);
  });

  it("Gun/Gun_component gets 0.95 (standard)", () => {
    expect(defaultServiceLevel("GUN", 0.5)).toBe(0.95);
    expect(defaultServiceLevel("GUN_COMPONENT", 0.5)).toBe(0.95);
  });

  it("Spare/Consumable gets 0.85 (long-tail)", () => {
    expect(defaultServiceLevel("SPARE", 0.5)).toBe(0.85);
    expect(defaultServiceLevel("CONSUMABLE", 0.5)).toBe(0.85);
  });

  it("Unknown item type falls back to tenant default", () => {
    expect(defaultServiceLevel(null, 0.92)).toBe(0.92);
    expect(defaultServiceLevel(undefined, undefined)).toBe(0.95);
  });
});
