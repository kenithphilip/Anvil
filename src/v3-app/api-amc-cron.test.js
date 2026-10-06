// /api/service/amc_cron: cron auth fails closed, and only an in-force
// contract mints a visit.
//
// Two defects. The endpoint checked CRON_SECRET only when one was set, so it
// was open to anyone when the variable was missing; fx/cron.js and the daily
// mux that calls this job both refuse instead. And it minted a visit for
// every due schedule row whatever its contract's status or end date, so an
// EXPIRED or TERMINATED AMC kept producing visits.
//
// contracts.status values are from migration 006: ACTIVE, EXPIRED,
// TERMINATED, PENDING_RENEWAL. The in-memory fake resolves the
// `contract:contract_id(...)` embed the way PostgREST does. Invented
// fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: {}, seq: 0, reads: [] }));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      H.store[table] = H.store[table] || [];
      const q = {
        _op: "select", _cols: "", _filters: [], _payload: null, _select: false,
        select(cols) { this._select = true; this._cols = cols || ""; return this; },
        insert(p) { this._op = "insert"; this._payload = p; return this; },
        update(p) { this._op = "update"; this._payload = p; return this; },
        eq(col, val) { this._filters.push((r) => r[col] === val); return this; },
        lte(col, val) { this._filters.push((r) => String(r[col]) <= String(val)); return this; },
        _embed(r) {
          const m = /contract:contract_id\(([^)]*)\)/.exec(this._cols);
          if (!m) return r;
          const c = H.store.contracts.find((x) => x.id === r.contract_id) || null;
          const pick = c ? Object.fromEntries(m[1].split(",").map((s) => s.trim()).map((k) => [k, c[k] ?? null])) : null;
          return { ...r, contract: pick };
        },
        _exec(single) {
          const store = H.store[table];
          const hit = () => store.filter((r) => this._filters.every((f) => f(r)));
          let data = null;
          if (this._op === "select") {
            H.reads.push(table);
            data = hit().map((r) => this._embed({ ...r }));
          } else if (this._op === "insert") {
            const rec = { id: table + "-" + (++H.seq), ...this._payload };
            store.push(rec);
            data = this._select ? (single ? rec : [rec]) : null;
          } else if (this._op === "update") {
            for (const r of hit()) Object.assign(r, this._payload);
          }
          return Promise.resolve({ data, error: null });
        },
        single() { const self = this; return { then: (res, rej) => self._exec(1).then(res, rej) }; },
        then(resolve, reject) { return this._exec(0).then(resolve, reject); },
      };
      return q;
    },
  }),
}));

const { default: amcCron } = await import("../api/service/amc_cron.js");

const run = async ({ auth } = {}) => {
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  const headers = auth ? { authorization: "Bearer " + auth } : {};
  await amcCron({ method: "GET", headers, query: {}, url: "/api/service/amc_cron" }, res);
  return { statusCode: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const contract = (id, status, end_date) => ({ id, tenant_id: "t-1", customer_id: "cust-1", status, start_date: day(-300), end_date });
const schedule = (id, contract_id, scheduled_date) => ({
  id, tenant_id: "t-1", contract_id, customer_id: "cust-1", customer_location_id: null,
  scheduled_date, visit_label: "Q4 PM " + id, status: "SCHEDULED",
});

let savedSecret;
beforeEach(() => {
  savedSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "test-cron-secret";
  H.seq = 0;
  H.reads = [];
  H.store = { contracts: [], amc_schedules: [], service_visits: [], audit_events: [] };
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = savedSecret;
});

describe("amc_cron: cron auth", () => {
  it("refuses to run when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    H.store.contracts = [contract("c-active", "ACTIVE", day(200))];
    H.store.amc_schedules = [schedule("s-1", "c-active", day(2))];
    const out = await run();
    expect(out.statusCode).toBe(503);
    expect(out.body.error.code).toBe("CRON_SECRET_MISSING");
    expect(H.reads).toEqual([]);
    expect(H.store.service_visits).toHaveLength(0);
  });

  it("rejects a wrong secret", async () => {
    H.store.contracts = [contract("c-active", "ACTIVE", day(200))];
    H.store.amc_schedules = [schedule("s-1", "c-active", day(2))];
    const out = await run({ auth: "not-the-secret" });
    expect(out.statusCode).toBe(401);
    expect(H.store.service_visits).toHaveLength(0);
  });

  it("runs with the right secret", async () => {
    H.store.contracts = [contract("c-active", "ACTIVE", day(200))];
    H.store.amc_schedules = [schedule("s-1", "c-active", day(2))];
    const out = await run({ auth: "test-cron-secret" });
    expect(out.statusCode).toBe(200);
    expect(out.body.created).toBe(1);
  });
});

describe("amc_cron: only an in-force contract mints a visit", () => {
  beforeEach(() => {
    H.store.contracts = [
      contract("c-active",     "ACTIVE",          day(200)),
      contract("c-open-ended", "ACTIVE",          null),
      contract("c-renewing",   "PENDING_RENEWAL", day(20)),
      contract("c-expired",    "EXPIRED",         day(-10)),
      contract("c-terminated", "TERMINATED",      day(100)),
      contract("c-lapsed",     "ACTIVE",          day(-1)),
      contract("c-ends-soon",  "ACTIVE",          day(1)),
    ];
    H.store.amc_schedules = [
      schedule("s-active",     "c-active",     day(2)),
      schedule("s-open-ended", "c-open-ended", day(3)),
      schedule("s-renewing",   "c-renewing",   day(4)),
      schedule("s-expired",    "c-expired",    day(2)),
      schedule("s-terminated", "c-terminated", day(2)),
      schedule("s-lapsed",     "c-lapsed",     day(2)),
      schedule("s-ends-soon",  "c-ends-soon",  day(5)),   // visit falls after the contract ends
    ];
  });

  it("creates visits only for contracts that are in force on the visit date", async () => {
    const out = await run({ auth: "test-cron-secret" });
    expect(out.statusCode).toBe(200);
    expect(out.body.created).toBe(3);
    expect(H.store.service_visits.map((v) => v.purpose).sort())
      .toEqual(["Q4 PM s-active", "Q4 PM s-open-ended", "Q4 PM s-renewing"]);
  });

  it("reports each skipped row with its reason", async () => {
    const out = await run({ auth: "test-cron-secret" });
    const reasons = Object.fromEntries(out.body.skipped.map((s) => [s.amc_id, s.reason]));
    expect(reasons).toEqual({
      "s-expired": "contract_expired",
      "s-terminated": "contract_terminated",
      "s-lapsed": "contract_ended",
      "s-ends-soon": "contract_ended",
    });
  });

  it("leaves skipped rows SCHEDULED, so a renewal picks them up later", async () => {
    await run({ auth: "test-cron-secret" });
    const status = Object.fromEntries(H.store.amc_schedules.map((s) => [s.id, s.status]));
    expect(status).toEqual({
      "s-active": "VISIT_CREATED",
      "s-open-ended": "VISIT_CREATED",
      "s-renewing": "VISIT_CREATED",
      "s-expired": "SCHEDULED",
      "s-terminated": "SCHEDULED",
      "s-lapsed": "SCHEDULED",
      "s-ends-soon": "SCHEDULED",
    });
  });

  it("mints a skipped row once its contract is renewed", async () => {
    await run({ auth: "test-cron-secret" });
    Object.assign(H.store.contracts.find((c) => c.id === "c-ends-soon"), { end_date: day(365) });
    const out = await run({ auth: "test-cron-secret" });
    expect(out.body.created).toBe(1);
    expect(H.store.amc_schedules.find((s) => s.id === "s-ends-soon").status).toBe("VISIT_CREATED");
  });
});
