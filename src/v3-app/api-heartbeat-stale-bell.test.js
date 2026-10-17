// A stale 5-minute tick rings the admin bell.
//
// The daily sweep (cron/daily) found a stale cron/tick and only wrote a
// console.warn, which reaches the log drain and nobody in the app. While the
// tick is down, background extraction, inbound email, ERP retries and agent
// runs all wait. Now the sweep also writes one admin bell row per tenant,
// through notifyAdmins. Bell only: no email is sent for this.
//
// Runs the real daily handler, heartbeat check and notifyAdmins. The daily
// sub-handlers (runCronGroup) and the database are faked. Invented fixtures.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ store: null, seq: 0 }));

vi.mock("../api/_lib/cron-mux.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runCronGroup: vi.fn(async () => []), recordCronHeartbeat: vi.fn(async () => {}) };
});

const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      in(c, vs) { this._f.push((r) => vs.includes(r[c])); return this; },
      gte() { return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      _run() {
        if (this._op === "insert") {
          H.seq += 1;
          const created = { id: table + "-" + H.seq, ...this._payload };
          rows().push(created);
          return [created];
        }
        return rows().filter((r) => this._f.every((fn) => fn(r)));
      },
      then(res, rej) { return Promise.resolve({ data: this._run(), error: null }).then(res, rej); },
    };
    return q;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

let handler;
beforeAll(async () => {
  vi.stubEnv("CRON_SECRET", "cron-test-secret");
  ({ default: handler } = await import("../api/cron/daily.js"));
});

const runDaily = async () => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "POST", headers: { authorization: "Bearer cron-test-secret" }, url: "/api/cron/daily", query: {} }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const bells = () => (H.store.admin_notifications || []).filter((n) => n.kind === "cron_tick_stale");

beforeEach(() => {
  H.seq = 0;
  H.store = {
    cron_health: [{ worker: "cron/daily", last_run_at: minutesAgo(1), last_status: "ok" }],
    tenants: [{ id: "t-1" }, { id: "t-2" }, { id: "t-3" }],
    tenant_members: [
      { tenant_id: "t-1", user_id: "u-1", role: "admin", status: "approved" },
      { tenant_id: "t-2", user_id: "u-2", role: "admin", status: "approved" },
      // t-3 has no approved admin: nothing to ring.
      { tenant_id: "t-3", user_id: "u-3", role: "operator", status: "approved" },
    ],
    admin_notifications: [],
    communications: [],
  };
});

describe("cron/daily: a stale tick rings the admin bell", () => {
  it("writes one bell row for each tenant that has an admin, and says how long the tick has been down", async () => {
    H.store.cron_health.push({ worker: "cron/tick", last_run_at: minutesAgo(42), last_status: "ok" });
    const r = await runDaily();
    expect(r.status).toBe(200);
    expect(r.body.staleness_check.stale_workers).toContain("cron/tick");
    expect(r.body.staleness_bell).toMatchObject({ tenants: 3, notified: 2 });

    expect(bells().map((b) => b.tenant_id).sort()).toEqual(["t-1", "t-2"]);
    expect(bells()[0].title).toBe("The background worker has stopped running");
    expect(bells()[0].body).toContain("last ran 42 minutes ago");
    // Bell only: no email row.
    expect(H.store.communications).toEqual([]);
  });

  it("rings nothing while the tick is fresh", async () => {
    H.store.cron_health.push({ worker: "cron/tick", last_run_at: minutesAgo(3), last_status: "ok" });
    const r = await runDaily();
    expect(r.status).toBe(200);
    expect(r.body.staleness_bell).toEqual({ tenants: 0, notified: 0 });
    expect(bells()).toEqual([]);
  });

  it("rings nothing for a stale worker other than the tick", async () => {
    H.store.cron_health.push(
      { worker: "cron/tick", last_run_at: minutesAgo(3), last_status: "ok" },
      { worker: "tally/sync", last_run_at: minutesAgo(200), last_status: "ok" },
    );
    const r = await runDaily();
    expect(r.body.staleness_check.stale_workers).toEqual(["tally/sync"]);
    expect(r.body.staleness_bell).toEqual({ tenants: 0, notified: 0 });
    expect(bells()).toEqual([]);
  });
});
