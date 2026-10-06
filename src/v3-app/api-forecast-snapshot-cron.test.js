// The "nightly" forecast snapshot was never scheduled.
//
// /api/forecast's own header says the dashboard "reads from the nightly
// forecast_snapshots table". cron/daily.js registered thirteen jobs and
// forecast was not among them, and the only writer sat behind
// requirePermission(ctx, "admin") in the POST branch. So the table advanced
// when somebody clicked and at no other time — and the cockpit's weighted
// pipeline was as old as the last click, with nothing on screen saying so.
//
// Stale-but-confident is the worst state for a forecast: it is the number
// people plan capacity against.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeForecastSnapshot } from "../api/forecast/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", "..", rel), "utf8");

// Minimal svc double: records what was upserted, fails a named table on demand.
const makeSvc = ({ opps = [], customers = [], failOn = null, capture = {} } = {}) => ({
  from: (table) => {
    if (table === "forecast_snapshots") {
      return { upsert: (rows) => { capture.rows = rows; return Promise.resolve(failOn === table ? { error: { message: "boom" } } : { error: null }); } };
    }
    const data = table === "opportunities" ? opps : customers;
    const b = {
      select: () => b,
      eq: () => Promise.resolve(failOn === table ? { error: { message: "boom" }, data: null } : { data, error: null }),
    };
    return b;
  },
});

const OPP = { id: "o1", customer_id: "c1", stage: "QUOTED", amount_inr: 1000, probability: 50, close_date: "2026-12-01", order_mode: "project" };

describe("writeForecastSnapshot", () => {
  it("writes every dimension for the tenant", async () => {
    const capture = {};
    const r = await writeForecastSnapshot(makeSvc({ opps: [OPP], customers: [{ id: "c1", customer_type: "OEM", state_code: "27" }], capture }), "t1");
    expect(r.written).toBeGreaterThan(0);
    const dims = new Set(capture.rows.map((x) => x.segment_dimension));
    expect([...dims].sort()).toEqual(["customer_type", "order_mode", "overall", "territory"]);
  });

  it("stamps the tenant and as_of on every row", async () => {
    const capture = {};
    await writeForecastSnapshot(makeSvc({ opps: [OPP], customers: [{ id: "c1" }], capture }), "t9");
    expect(capture.rows.every((x) => x.tenant_id === "t9")).toBe(true);
    expect(capture.rows.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.as_of))).toBe(true);
  });

  it("writes nothing rather than an empty row set when there are no opportunities", async () => {
    const r = await writeForecastSnapshot(makeSvc({ opps: [], customers: [] }), "t1");
    expect(r.written).toBe(0);
    expect(r.error).toBeUndefined();
  });

  it("returns the error instead of throwing, so one tenant cannot end the run", async () => {
    const r = await writeForecastSnapshot(makeSvc({ failOn: "opportunities" }), "t1");
    expect(r.error).toBe("boom");
    expect(r.tenant_id).toBe("t1");
  });

  it("reports a failed upsert rather than claiming a write", async () => {
    const r = await writeForecastSnapshot(makeSvc({ opps: [OPP], customers: [{ id: "c1" }], failOn: "forecast_snapshots" }), "t1");
    expect(r.error).toBe("boom");
    expect(r.written).toBeUndefined();
  });

  it("surfaces a customers read failure — it drives two of the four dimensions", async () => {
    // Silently continuing would file every opportunity under "unknown" and
    // report a clean snapshot.
    const r = await writeForecastSnapshot(makeSvc({ opps: [OPP], failOn: "customers" }), "t1");
    expect(r.error).toBe("boom");
  });
});

describe("the cron path", () => {
  const src = read("src/api/forecast/index.js");

  it("checks CRON_SECRET BEFORE resolving a user context", () => {
    // A cron has no user. Resolving first would throw on exactly the request
    // that most needs to succeed.
    const cronIdx = src.indexOf("auth === CRON_SECRET");
    const ctxIdx = src.indexOf("const ctx = await resolveContext(req)");
    expect(cronIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(cronIdx).toBeLessThan(ctxIdx);
  });

  it("drains every tenant, because a cron has no single one", () => {
    expect(src).toMatch(/from\("tenants"\)\.select\("id"\)/);
  });

  it("does not let one tenant's failure abandon the rest", () => {
    // A snapshot is a whole night's freshness for everybody else.
    expect(src).toMatch(/catch \(e\) \{ out\.push\(\{ tenant_id: t\.id, error/);
  });

  it("reports how many failed, not just how many ran", () => {
    expect(src).toMatch(/failed: out\.filter\(\(r\) => r\.error\)\.length/);
  });

  it("keeps the admin path authorised and audited", () => {
    expect(src).toMatch(/requirePermission\(ctx, "admin"\)/);
    expect(src).toMatch(/action: "forecast_snapshot"/);
  });

  it("shares one writer between both paths", () => {
    // Two copies of the aggregation would drift, and the nightly one is the
    // copy nobody watches.
    expect((src.match(/writeForecastSnapshot\(svc/g) || []).length).toBe(2);
  });
});

describe("and it is actually scheduled", () => {
  const daily = read("src/api/cron/daily.js");

  it("is registered in the daily group", () => {
    // The whole defect: the code existed and nothing called it.
    expect(daily).toMatch(/name: "forecast\/snapshot"/);
    expect(daily).toMatch(/path: "\/api\/forecast", method: "POST"/);
  });
});
