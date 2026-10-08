// Mode B: Anvil does not write to the customer's ledger, on ANY path.
//
// tally/push.js refused in Mode B, but tally/retry.js drained
// tally_retry_queue with no mode check. A row queued before a switch to B, or
// enqueued by the copilot (_lib/tally-enqueue.js), could still post a voucher.
// Both handlers now share _lib/so-processing-mode.js, and these tests run the
// real handlers. Only the Tally bridge client and the database are faked.
// Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-test-secret";
  return { ctx: null, store: null, settingsError: false };
});

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/tally-client.js", () => ({
  tallyPush: vi.fn(async () => ({ ok: true, status: 200, body: "<RESPONSE><VOUCHERID>V-100</VOUCHERID></RESPONSE>" })),
  tallyResolveCompany: vi.fn(async () => ({ id: "co-1", bridge_url: "https://bridge.test" })),
  tallyIsRecoverable: vi.fn((s) => s === 0 || s === 429 || s >= 500),
}));

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));

const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      lte(c, v) { this._f.push((r) => String(r[c]) <= String(v)); return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      update(p) { this._op = "update"; this._payload = p; return this; },
      _run() {
        if (table === "tenant_settings" && H.settingsError) {
          return { data: null, error: { code: "42703", message: "column so_processing_mode does not exist" } };
        }
        if (this._op === "insert") {
          const created = { id: table + "-" + (rows().length + 1), ...this._payload };
          rows().push(created);
          return { data: [created], error: null };
        }
        const hit = rows().filter((r) => this._f.every((fn) => fn(r)));
        if (this._op === "update") for (const r of hit) Object.assign(r, this._payload);
        return { data: hit, error: null };
      },
      maybeSingle() { const r = this._run(); return Promise.resolve({ data: r.data?.[0] || null, error: r.error }); },
      single() { const r = this._run(); return Promise.resolve(r.data?.[0] ? { data: r.data[0], error: null } : { data: null, error: r.error || { message: "no rows" } }); },
      then(res, rej) { return Promise.resolve(this._run()).then(res, rej); },
    };
    return q;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { tallyPush, tallyResolveCompany } = await import("../api/_lib/tally-client.js");
const { default: retry } = await import("../api/tally/retry.js");
const { default: push } = await import("../api/tally/push.js");

const call = async (handler, { method = "POST", body = {}, headers = {} } = {}) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method, headers, body, query: {} }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const PAST = "2026-01-01T00:00:00.000Z";
const queueRow = (id, tenantId, orderId) => ({
  id, tenant_id: tenantId, company_id: "co-1", order_id: orderId, voucher_record_id: null,
  payload_xml: "<ENVELOPE/>", attempt_count: 1, status: "pending", next_attempt_at: PAST,
});
const row = (id) => H.store.tally_retry_queue.find((r) => r.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  H.settingsError = false;
  H.ctx = { user: { id: "u-admin" }, tenantId: "t-a", role: "admin" };
  H.store = {
    tenant_settings: [
      { tenant_id: "t-a", so_processing_mode: "A" },
      { tenant_id: "t-b", so_processing_mode: "B" },
    ],
    tally_retry_queue: [queueRow("q-a", "t-a", "o-a"), queueRow("q-b", "t-b", "o-b")],
    tally_voucher_records: [],
    orders: [
      { id: "o-a", tenant_id: "t-a", status: "APPROVED" },
      { id: "o-b", tenant_id: "t-b", status: "APPROVED" },
    ],
  };
});

describe("tally/retry, manual call", () => {
  it("in Mode B returns 409 and never reaches Tally", async () => {
    H.ctx = { user: { id: "u-admin-b" }, tenantId: "t-b", role: "admin" };
    const r = await call(retry);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SO_PROCESSING_MODE_B");
    expect(tallyResolveCompany).not.toHaveBeenCalled();
    expect(tallyPush).not.toHaveBeenCalled();
    // The row is left exactly as it was.
    expect(row("q-b")).toMatchObject({ status: "pending", attempt_count: 1 });
    expect(H.store.orders.find((o) => o.id === "o-b").status).toBe("APPROVED");
  });

  it("refuses with the same body the push returns", async () => {
    H.ctx = { user: { id: "u-admin-b" }, tenantId: "t-b", role: "admin" };
    const fromRetry = await call(retry);
    const fromPush = await call(push, { body: { orderId: "o-b" } });
    expect(fromPush.status).toBe(409);
    expect(fromRetry.body).toEqual(fromPush.body);
  });

  it("in Mode A drains the tenant's due rows as before", async () => {
    const r = await call(retry);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tenant_id: "t-a", processed: 1 });
    expect(r.body.results[0]).toMatchObject({ id: "q-a", ok: true, voucher_id: "V-100" });
    expect(tallyPush).toHaveBeenCalledTimes(1);
    expect(row("q-a").status).toBe("succeeded");
    expect(H.store.orders.find((o) => o.id === "o-a").status).toBe("EXPORTED_TO_TALLY");
    // Tenant scope: the other tenant's row is not touched.
    expect(row("q-b").status).toBe("pending");
  });

  it("proceeds as Mode A when the setting cannot be read, as the push does", async () => {
    H.settingsError = true;
    const r = await call(retry);
    expect(r.status).toBe(200);
    expect(tallyPush).toHaveBeenCalledTimes(1);
    expect(row("q-a").status).toBe("succeeded");
  });
});

describe("tally/retry, cron", () => {
  it("skips a Mode B tenant and drains a Mode A tenant", async () => {
    const r = await call(retry, { method: "GET", headers: { authorization: "Bearer cron-test-secret" } });
    expect(r.status).toBe(200);
    const byTenant = Object.fromEntries(r.body.tenants.map((t) => [t.tenant_id, t]));
    expect(byTenant["t-b"]).toMatchObject({ processed: 0, refused: "SO_PROCESSING_MODE_B" });
    expect(byTenant["t-a"]).toMatchObject({ processed: 1 });

    expect(tallyPush).toHaveBeenCalledTimes(1);
    expect(tallyResolveCompany).toHaveBeenCalledTimes(1);
    expect(tallyResolveCompany.mock.calls[0][1]).toBe("t-a");
    expect(row("q-a").status).toBe("succeeded");
    expect(row("q-b")).toMatchObject({ status: "pending", attempt_count: 1 });
  });
});

describe("tally/push, after moving its mode check to the shared helper", () => {
  it("in Mode B returns 409 before resolving the bridge", async () => {
    H.ctx = { user: { id: "u-admin-b" }, tenantId: "t-b", role: "admin" };
    const r = await call(push, { body: { orderId: "o-b" } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("SO_PROCESSING_MODE_B");
    expect(r.body.error.message).toMatch(/Mode B/);
    expect(tallyResolveCompany).not.toHaveBeenCalled();
    expect(tallyPush).not.toHaveBeenCalled();
  });

  it("proceeds past the mode check when the setting cannot be read", async () => {
    H.settingsError = true;
    vi.mocked(tallyResolveCompany).mockResolvedValueOnce(null);
    const r = await call(push, { body: { orderId: "o-a" } });
    // It reached the bridge lookup, which is the next gate.
    expect(tallyResolveCompany).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BRIDGE_NOT_CONFIGURED");
  });

  it("in Mode A reaches the bridge lookup", async () => {
    vi.mocked(tallyResolveCompany).mockResolvedValueOnce(null);
    const r = await call(push, { body: { orderId: "o-a" } });
    expect(tallyResolveCompany).toHaveBeenCalledTimes(1);
    expect(r.body.error.code).toBe("BRIDGE_NOT_CONFIGURED");
  });
});
