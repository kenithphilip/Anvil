// C-11 (decision C-D8): in Mode B an approval does not expire. Mode A keeps
// the 24 h expiry. The server sets the expiry, never the client. A line edit
// still clears the approval in both modes. A mode that cannot be read keeps
// the 24 h expiry.
//
// This runs the real PATCH handler (src/api/orders/[id].js) against a small
// in-memory database. Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ORDER = "00000000-0000-0000-0000-0000000000c1";
const HOUR = 3600 * 1000;

const H = vi.hoisted(() => ({ db: null }));

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// orders and tenant_settings. `settings` is the tenant_settings answer:
// { mode }, { error }, or { throws }.
const makeDb = (rows, settings) => ({
  rows,
  from(table) {
    const filters = [];
    let patch = null;
    const run = async () => {
      if (table === "tenant_settings") {
        if (settings.throws) throw new Error("connection reset");
        if (settings.error) return { data: [], error: { message: "read failed" } };
        const s = { tenant_id: TENANT, so_processing_mode: settings.mode };
        return { data: settings.mode && filters.every((f) => f(s)) ? [s] : [], error: null };
      }
      const list = table === "orders" ? rows : [];
      const hit = list.filter((r) => filters.every((f) => f(r)));
      if (patch) for (const r of hit) Object.assign(r, clone(patch));
      return { data: clone(hit), error: null };
    };
    const api = {
      select() { return api; },
      eq(c, v) { filters.push((r) => String(r[c]) === String(v)); return api; },
      update(p) { patch = p; return api; },
      single: () => run().then((r) => ({ data: r.data[0] || null, error: r.data[0] ? null : { message: "not found" } })),
      maybeSingle: () => run().then((r) => ({ data: r.data[0] || null, error: r.error })),
      then: (f, rj) => run().then(f, rj),
    };
    return api;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db }));
vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-approver" }, role: "sales_manager" }),
  requirePermission: () => {},
  requireAction: () => {},
  hasAction: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/approval-evaluator.js", () => ({ evaluateApprovalsForOrder: async () => ({ created: [] }) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));
vi.mock("../api/_lib/item-mapper.js", () => ({ lineCandidates: () => [], lineSapCandidates: () => [] }));
vi.mock("../api/_lib/item-customer-parts.js", () => ({ upsertCustomerPart: async () => ({}) }));
vi.mock("../api/_lib/order-reconcile.js", () => ({
  autoReconcileOrder: async () => {}, hasReconcilableLines: () => false, AUTO_RECONCILE_STATUSES: new Set(),
}));

const { default: patchOrder } = await import("../api/orders/[id].js");

const lines = (qty) => ({ salesOrder: { lineItems: [{ description: "Test item A", quantity: qty, rate: 10 }] } });

const order = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, status: "PENDING_REVIEW", po_number: "PO-TEST-11", quote_id: null,
  payload_hash: "hash-ttl-1", approval: null, approved_at: null, approval_expires_at: null, approval_actions: [],
  rule_findings: [], result: lines(1), preflight_payload: {},
  ...over,
});

// Approved 30 h ago. `expiresAt` is the stored expiry: an old row has the 24 h
// one (6 h ago), a Mode B approval after C-11 has none.
const approvedAgo = (expiresAt) => ({
  status: "APPROVED",
  approval: { payloadHash: "hash-ttl-1", approvedBy: "u-approver" },
  approved_at: new Date(Date.now() - 30 * HOUR).toISOString(),
  approval_expires_at: expiresAt,
  approval_actions: ["approve", "export_tally", "create_source_pos", "send_customer_ack"],
});
const OLD_24H_EXPIRY = () => new Date(Date.now() - 6 * HOUR).toISOString();

const seed = (over, settings) => { H.db = makeDb([order(over)], settings); };
const row = () => H.db.rows[0];

const patch = async (body) => {
  const res = { setHeader() {}, end() { return res; } };
  await patchOrder({ method: "PATCH", headers: {}, query: { id: ORDER }, url: "/api/orders/" + ORDER, _body: body }, res);
  return res;
};
const approve = (extra = {}) => patch({ status: "APPROVED", approval: { payloadHash: "hash-ttl-1", ...extra } });

// Hours from now to the stored expiry.
const hoursLeft = () => (new Date(row().approval_expires_at).getTime() - Date.now()) / HOUR;

beforeEach(() => { H.db = null; });

describe("approve sets the expiry by the mode", () => {
  it("Mode B: the approval is stored with no expiry", async () => {
    seed({}, { mode: "B" });
    const res = await approve();
    expect(res._status).toBe(200);
    expect(row().status).toBe("APPROVED");
    expect(row().approval.payloadHash).toBe("hash-ttl-1");
    expect(row().approval_expires_at).toBe(null);
  });

  it("Mode A: the approval expires in 24 h", async () => {
    seed({}, { mode: "A" });
    const res = await approve();
    expect(res._status).toBe(200);
    expect(hoursLeft()).toBeGreaterThan(23.9);
    expect(hoursLeft()).toBeLessThanOrEqual(24);
  });
});

describe("the client cannot set the expiry", () => {
  it("Mode A: ttlHours 1e6 still gives 24 h", async () => {
    seed({}, { mode: "A" });
    const res = await approve({ ttlHours: 1e6 });
    expect(res._status).toBe(200);
    expect(hoursLeft()).toBeLessThanOrEqual(24);
    expect(hoursLeft()).toBeGreaterThan(23.9);
  });

  it("Mode A: ttlHours 'x' is not a 500, and gives 24 h", async () => {
    seed({}, { mode: "A" });
    const res = await approve({ ttlHours: "x" });
    expect(res._status).toBe(200);
    expect(hoursLeft()).toBeGreaterThan(23.9);
  });

  it("Mode B: ttlHours 1 still gives no expiry", async () => {
    seed({}, { mode: "B" });
    const res = await approve({ ttlHours: 1 });
    expect(res._status).toBe(200);
    expect(row().approval_expires_at).toBe(null);
  });
});

describe("an order approved 30 h ago", () => {
  it("Mode B, old row with a 24 h expiry: it can still move to the next status", async () => {
    seed(approvedAgo(OLD_24H_EXPIRY()), { mode: "B" });
    const res = await patch({ status: "EXPORTED_TO_TALLY" });
    expect(res._status).toBe(200);
    expect(row().status).toBe("EXPORTED_TO_TALLY");
  });

  it("Mode B, approval with no expiry: it can still move to the next status", async () => {
    seed(approvedAgo(null), { mode: "B" });
    const res = await patch({ status: "EXPORTED_TO_TALLY" });
    expect(res._status).toBe(200);
  });

  it("Mode A: the expired approval is still refused", async () => {
    seed(approvedAgo(OLD_24H_EXPIRY()), { mode: "A" });
    const res = await patch({ status: "EXPORTED_TO_TALLY" });
    expect(res._status).toBe(409);
    expect(res._json.error.message).toMatch(/Approval expired/);
    expect(row().status).toBe("APPROVED");
  });

  it("Mode A, approval given in Mode B (no stored expiry): it expires 24 h after approved_at", async () => {
    seed(approvedAgo(null), { mode: "A" });
    const res = await patch({ status: "EXPORTED_TO_TALLY" });
    expect(res._status).toBe(409);
    expect(row().status).toBe("APPROVED");
  });
});

describe("a line edit clears the approval", () => {
  it.each(["B", "A"])("Mode %s", async (mode) => {
    seed(approvedAgo(mode === "B" ? null : new Date(Date.now() + HOUR).toISOString()), { mode });
    const res = await patch({ result: lines(2) });
    expect(res._status).toBe(200);
    expect(row().result.salesOrder.lineItems[0].quantity).toBe(2);
    expect(row().approval).toBe(null);
    expect(row().approval_expires_at).toBe(null);
    expect(row().approval_actions).toEqual([]);
  });
});

describe("a mode that cannot be read keeps the 24 h expiry", () => {
  it.each([
    ["the setting is missing", {}],
    ["the read returns an error", { error: true }],
    ["the read throws", { throws: true }],
  ])("%s: approve sets 24 h", async (_label, settings) => {
    seed({}, settings);
    const res = await approve();
    expect(res._status).toBe(200);
    expect(hoursLeft()).toBeGreaterThan(23.9);
    expect(hoursLeft()).toBeLessThanOrEqual(24);
  });

  it.each([
    ["the read returns an error", { error: true }],
    ["the read throws", { throws: true }],
  ])("%s: an expired approval is refused", async (_label, settings) => {
    seed(approvedAgo(OLD_24H_EXPIRY()), settings);
    const res = await patch({ status: "EXPORTED_TO_TALLY" });
    expect(res._status).toBe(409);
    expect(row().status).toBe("APPROVED");
  });
});
