// Unit tests for src/api/_lib/docai/adapter-learning.js.

import { describe, it, expect, beforeEach } from "vitest";
import { rankAdaptersForCustomer, __clearCache, __test } from "../api/_lib/docai/adapter-learning.js";

const T = "00000000-0000-0000-0000-0000000000aa";
const C = "00000000-0000-0000-0000-0000000000bb";

// In-memory Supabase stub. Only supports the chain
// adapter-learning uses (select/eq/gt/limit then await).
const makeSvc = (runs) => ({
  from() {
    let rows = [...runs];
    return {
      select: () => this.from(),
      eq: (col, val) => { rows = rows.filter((r) => String(r[col]) === String(val)); return this._chain(rows); },
      gt: (col, val) => { rows = rows.filter((r) => String(r[col]) > String(val)); return this._chain(rows); },
      limit: () => this._chain(rows),
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
  },
  _chain(rows) {
    return {
      eq: (col, val) => { const r = rows.filter((x) => String(x[col]) === String(val)); return this._chain(r); },
      gt: (col, val) => { const r = rows.filter((x) => String(x[col]) > String(val)); return this._chain(r); },
      limit: () => this._chain(rows),
      then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
    };
  },
});

const run = (adapter, ok, confidence, daysAgo = 1) => ({
  tenant_id: T, customer_id: C,
  adapter_used: adapter,
  status: ok ? "ok" : "failed",
  confidence_overall: confidence,
  created_at: new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString(),
});

beforeEach(() => { __clearCache(); });

describe("__test.scoreOne", () => {
  it("returns null below MIN_OBSERVATIONS", () => {
    const runs = [run("claude", true, 0.9)];
    expect(__test.scoreOne(runs, Date.now())).toBeNull();
  });
  it("scores higher when both ok-rate and confidence are high", () => {
    const all = [
      run("claude", true, 0.95), run("claude", true, 0.93),
      run("claude", true, 0.91), run("claude", true, 0.88),
      run("claude", true, 0.9),
    ];
    const s = __test.scoreOne(all, Date.now());
    expect(s).toBeGreaterThan(0.7);
  });
  it("penalises low confidence even when ok-rate is perfect", () => {
    const allLowConf = [
      run("claude", true, 0.4), run("claude", true, 0.42),
      run("claude", true, 0.38), run("claude", true, 0.39),
      run("claude", true, 0.41),
    ];
    const sHigh = __test.scoreOne([
      run("reducto", true, 0.92), run("reducto", true, 0.93),
      run("reducto", true, 0.91), run("reducto", true, 0.94),
      run("reducto", true, 0.9),
    ], Date.now());
    const sLow = __test.scoreOne(allLowConf, Date.now());
    expect(sHigh).toBeGreaterThan(sLow + 0.3);
  });
  it("penalises a mix of ok and failed runs", () => {
    const mixed = [
      run("claude", true, 0.9), run("claude", false, 0),
      run("claude", true, 0.9), run("claude", false, 0),
      run("claude", true, 0.9),
    ];
    const allOk = [
      run("reducto", true, 0.9), run("reducto", true, 0.9),
      run("reducto", true, 0.9), run("reducto", true, 0.9),
      run("reducto", true, 0.9),
    ];
    expect(__test.scoreOne(mixed, Date.now())).toBeLessThan(__test.scoreOne(allOk, Date.now()));
  });
});

describe("__test.decayWeight", () => {
  it("returns ~1 for now and ~0.5 at half-life", () => {
    const now = Date.now();
    const fresh = { created_at: new Date(now).toISOString() };
    const halfLife = { created_at: new Date(now - __test.HALF_LIFE_DAYS * 24 * 3600 * 1000).toISOString() };
    expect(__test.decayWeight(fresh, now)).toBeCloseTo(1, 2);
    expect(__test.decayWeight(halfLife, now)).toBeCloseTo(0.5, 2);
  });
});

describe("rankAdaptersForCustomer", () => {
  it("returns the default order when there are no observations", async () => {
    const svc = makeSvc([]);
    const out = await rankAdaptersForCustomer({ svc, tenantId: T, customerId: C });
    expect(out).toEqual(__test.DEFAULT_ORDER);
  });

  it("ranks observed adapters by score, then merges in unobserved adapters in default order", async () => {
    const runs = [
      // reducto: 5 ok at high conf -> top score
      run("reducto", true, 0.95), run("reducto", true, 0.93), run("reducto", true, 0.92),
      run("reducto", true, 0.94), run("reducto", true, 0.91),
      // claude: 5 ok at low conf -> lower score
      run("claude", true, 0.45), run("claude", true, 0.42), run("claude", true, 0.4),
      run("claude", true, 0.43), run("claude", true, 0.41),
      // gemini: insufficient observations -> not in learned ranking
      run("gemini", true, 0.9),
    ];
    const svc = makeSvc(runs);
    const out = await rankAdaptersForCustomer({ svc, tenantId: T, customerId: C });
    expect(out[0]).toBe("reducto");
    expect(out[1]).toBe("claude");
    // unobserved or under-MIN_OBS adapters still appear later
    expect(out.includes("gemini")).toBe(true);
    expect(out.includes("docling")).toBe(true);
  });

  it("returns the same answer twice without re-scanning thanks to the cache", async () => {
    const runs = [
      run("reducto", true, 0.9), run("reducto", true, 0.9), run("reducto", true, 0.9),
      run("reducto", true, 0.9), run("reducto", true, 0.9),
    ];
    let calls = 0;
    const svc = {
      from() {
        calls++;
        return {
          select: () => this.from(),
          eq: () => this._chain(runs),
          gt: () => this._chain(runs),
          limit: () => this._chain(runs),
          then: (fn) => Promise.resolve(fn({ data: runs, error: null })),
        };
      },
      _chain(rows) {
        return {
          eq: () => this._chain(rows),
          gt: () => this._chain(rows),
          limit: () => this._chain(rows),
          then: (fn) => Promise.resolve(fn({ data: rows, error: null })),
        };
      },
    };
    await rankAdaptersForCustomer({ svc, tenantId: T, customerId: C });
    const callsAfterFirst = calls;
    await rankAdaptersForCustomer({ svc, tenantId: T, customerId: C });
    expect(calls).toBe(callsAfterFirst); // second call hit the cache
  });
});
