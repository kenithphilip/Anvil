// An approval is bound to the payload hash the approver saw (plan PR 3).
//
// src/api/orders/[id].js checked only that approval.payloadHash was present,
// not that it was the order's. An engineer's line edit after the approver
// loaded the order (which re-stamps orders.payload_hash) was still approved,
// sight unseen. The server now refuses a hash that is not the stored one with
// 409 STALE_APPROVAL, and writes nothing.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "00000000-0000-0000-0000-0000000000aa";

const H = vi.hoisted(() => ({
  orders: [],
  writes: [],
  audits: [],
  ctx: { user: { id: "u-mgr" }, tenantId: "00000000-0000-0000-0000-0000000000aa", role: "sales_manager" },
}));

vi.mock("../api/_lib/supabase.js", () => {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const from = (table) => {
    const filters = [];
    let patch = null;
    const rows = () => (table === "orders" ? H.orders : []).filter((r) => filters.every((f) => f(r)));
    const q = {
      select: () => q,
      eq: (c, v) => { filters.push((r) => String(r[c]) === String(v)); return q; },
      update: (p) => { patch = p; return q; },
      single: async () => {
        const hit = rows();
        if (patch) {
          H.writes.push({ table, patch: clone(patch) });
          hit.forEach((r) => Object.assign(r, clone(patch)));
        }
        return hit[0] ? { data: clone(hit[0]), error: null } : { data: null, error: { message: "no rows" } };
      },
      maybeSingle: async () => ({ data: rows()[0] ? clone(rows()[0]) : null, error: null }),
    };
    return q;
  };
  return { serviceClient: () => ({ from }) };
});
vi.mock("../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveContext: vi.fn(async () => H.ctx),
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async (_c, p) => { H.audits.push(p); }),
  recordEvent: vi.fn(async () => {}),
}));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: vi.fn(async () => ({ promoted: false })) }));

const { default: handler } = await import("../api/orders/[id].js");

const patch = async (id, body) => {
  let status = 200;
  let sent = "";
  const res = {
    setHeader: () => {},
    status(c) { status = c; return res; },
    send(p) { sent = p; return res; },
    json(o) { sent = JSON.stringify(o); return res; },
    end() { return res; },
  };
  await handler({ method: "PATCH", headers: {}, query: { id }, url: "/api/orders/" + id, body }, res);
  return { status, body: sent ? JSON.parse(sent) : {} };
};

const order = (extra = {}) => ({
  id: "o-1", tenant_id: T, status: "PENDING_REVIEW", po_number: "PO-STALE-1",
  payload_hash: "hash-now", approval: null, rule_findings: [],
  result: { salesOrder: { lineItems: [{ partNumber: "TEST-A", quantity: 1, unitPrice: 10 }] } },
  ...extra,
});

beforeEach(() => {
  H.orders = [order()];
  H.writes = [];
  H.audits = [];
  H.ctx = { user: { id: "u-mgr" }, tenantId: T, role: "sales_manager" };
});

describe("approve is bound to the stored payload hash", () => {
  it("refuses a hash that is not the order's with 409 STALE_APPROVAL, and writes nothing", async () => {
    const out = await patch("o-1", { status: "APPROVED", approval: { payloadHash: "hash-when-loaded" } });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("STALE_APPROVAL");
    expect(out.body.error.message).toMatch(/changed since you opened it/);
    expect(H.writes).toEqual([]);
    expect(H.orders[0].status).toBe("PENDING_REVIEW");
    expect(H.orders[0].approval).toBeNull();
    expect(H.audits.map((a) => a.action)).not.toContain("approve_order");
  });

  it("approves with the current hash", async () => {
    const out = await patch("o-1", { status: "APPROVED", approval: { payloadHash: "hash-now" } });
    expect(out.status).toBe(200);
    expect(H.orders[0].status).toBe("APPROVED");
    expect(H.orders[0].approval.payloadHash).toBe("hash-now");
    expect(H.orders[0].approved_by).toBe("u-mgr");
    expect(H.audits.map((a) => a.action)).toContain("approve_order");
  });

  it("refuses any hash when the order has none stored", async () => {
    H.orders = [order({ payload_hash: null })];
    const out = await patch("o-1", { status: "APPROVED", approval: { payloadHash: "hash-now" } });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("STALE_APPROVAL");
    expect(H.writes).toEqual([]);
  });

  it("checks the approver's permission before the hash", async () => {
    // An engineer learns nothing about the order's hash from the answer.
    H.ctx = { user: { id: "u-eng" }, tenantId: T, role: "sales_engineer" };
    const out = await patch("o-1", { status: "APPROVED", approval: { payloadHash: "hash-when-loaded" } });
    expect(out.status).toBe(403);
    expect(H.writes).toEqual([]);
  });

  it("still refuses an approval with no hash at all as a bad request", async () => {
    const out = await patch("o-1", { status: "APPROVED", approval: {} });
    expect(out.status).toBe(400);
    expect(H.writes).toEqual([]);
  });

  it("does not touch a PATCH that is not an approval", async () => {
    // The hash check guards APPROVED only. A return for fix carries no hash.
    const out = await patch("o-1", { status: "DRAFT", correction_reason: "Fix the ship-to." });
    expect(out.status).toBe(200);
    expect(H.orders[0].status).toBe("DRAFT");
  });
});
