// The SO workspace offers cancel, return for fix and approve only from the
// statuses in _lib/order-status-actions.js. This runs the real PATCH handler
// (src/api/orders/[id].js) from every status, so those lists cannot drift
// from the server's ALLOWED_TRANSITIONS: a list that offered more would be a
// dead button, one that offered less would hide a way out.
//
// It also pins the Mode B unblock: an approval expires after 24 h, and in
// Mode B the order rests at APPROVED, so a cancel or a return after a day was
// refused with 409. A withdrawal now passes; every move that relies on the
// approval is still refused. And it pins where the reason lands: the audit row.
//
// Every value is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";
const ORDER = "00000000-0000-0000-0000-0000000000b1";

const H = vi.hoisted(() => ({ db: null, audits: [], events: [], role: "sales_manager" }));

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// A small in-memory Supabase: select, eq, update, single. Enough for the
// PATCH path with no lines and no thresholds.
const makeDb = (rows) => ({
  rows,
  from(table) {
    const filters = [];
    let patch = null;
    const run = async () => {
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
      maybeSingle: () => run().then((r) => ({ data: r.data[0] || null, error: null })),
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
  resolveContext: async () => ({ tenantId: "00000000-0000-0000-0000-0000000000aa", user: { id: "u-approver" }, role: H.role }),
  requirePermission: () => {},
  requireAction: () => {},
  hasAction: () => true,
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: async (ctx, p) => { H.audits.push(p); },
  recordEvent: async (ctx, p) => { H.events.push(p); },
}));
vi.mock("../api/_lib/approval-evaluator.js", () => ({ evaluateApprovalsForOrder: async () => ({ created: [] }) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: async () => ({ promoted: false }) }));
vi.mock("../api/_lib/item-mapper.js", () => ({ lineCandidates: () => [], lineSapCandidates: () => [] }));
vi.mock("../api/_lib/item-customer-parts.js", () => ({ upsertCustomerPart: async () => ({}) }));
vi.mock("../api/_lib/order-reconcile.js", () => ({
  autoReconcileOrder: async () => {}, hasReconcilableLines: () => false, AUTO_RECONCILE_STATUSES: new Set(),
}));

const { default: patchOrder } = await import("../api/orders/[id].js");
const {
  ORDER_STATUSES, canCancelFrom, canReturnFrom, canApproveFrom, approvalExpiryBlocks,
} = await import("../api/_lib/order-status-actions.js");

const order = (over = {}) => ({
  id: ORDER, tenant_id: TENANT, status: "DRAFT", po_number: "PO-TEST-9", quote_id: null,
  payload_hash: "hash-test-1", approval: null, approval_expires_at: null, approval_actions: [],
  rule_findings: [], result: {}, preflight_payload: {},
  ...over,
});

const patch = async (body) => {
  const res = { setHeader() {}, end() { return res; } };
  await patchOrder({ method: "PATCH", headers: {}, query: { id: ORDER }, url: "/api/orders/" + ORDER, _body: body }, res);
  return res;
};

const seed = (over) => { H.db = makeDb([order(over)]); };
const row = () => H.db.rows[0];

const DAY = 24 * 3600 * 1000;
const expiredApproval = () => ({
  status: "APPROVED",
  approval: { payloadHash: "hash-test-1", approvedBy: "u-approver" },
  approved_at: new Date(Date.now() - 3 * DAY).toISOString(),
  approval_expires_at: new Date(Date.now() - 2 * DAY).toISOString(),
  approval_actions: ["approve", "export_tally", "create_source_pos", "send_customer_ack"],
});

beforeEach(() => {
  H.audits = [];
  H.events = [];
  H.role = "sales_manager";
});

describe("the workspace's status lists match the server", () => {
  it.each(ORDER_STATUSES.filter((s) => s !== "CANCELLED"))("cancel from %s", async (from) => {
    seed({ status: from });
    const res = await patch({ status: "CANCELLED", reason: "Customer withdrew the order" });
    expect(res._status === 200).toBe(canCancelFrom(from));
    expect(row().status).toBe(canCancelFrom(from) ? "CANCELLED" : from);
  });

  it.each(ORDER_STATUSES.filter((s) => s !== "DRAFT"))("return for fix from %s", async (from) => {
    seed({ status: from });
    const res = await patch({ status: "DRAFT", correction_reason: "Ship-to address is wrong" });
    expect(res._status === 200).toBe(canReturnFrom(from));
  });

  it.each(ORDER_STATUSES.filter((s) => s !== "APPROVED"))("approve is offered from %s only when the server allows it", async (from) => {
    seed({ status: from });
    const res = await patch({ status: "APPROVED", approval: { payloadHash: "hash-test-1" } });
    // The workspace is stricter than the server (approve only in
    // PENDING_REVIEW, per the audit), never looser.
    if (canApproveFrom(from)) expect(res._status).toBe(200);
  });

  it("offers approve in PENDING_REVIEW only", () => {
    expect(ORDER_STATUSES.filter(canApproveFrom)).toEqual(["PENDING_REVIEW"]);
  });
});

describe("the reason lands in the audit", () => {
  it("records the cancel reason on the audit row", async () => {
    seed({ status: "PENDING_REVIEW" });
    await patch({ status: "CANCELLED", reason: "Customer withdrew the order" });
    const a = H.audits.find((x) => x.after?.status === "CANCELLED");
    expect(a).toBeTruthy();
    expect(a.reason).toBe("Customer withdrew the order");
    expect(a.before.status).toBe("PENDING_REVIEW");
  });

  it("records the return reason as manager_requested_correction", async () => {
    seed({ status: "PENDING_REVIEW" });
    await patch({ status: "DRAFT", correction_reason: "Rate on line 2 is wrong", correction_requested_by: "sales_manager" });
    const a = H.audits.find((x) => x.action === "manager_requested_correction");
    expect(a).toBeTruthy();
    expect(a.reason).toBe("Rate on line 2 is wrong");
    expect(row().correction_reason).toBe("Rate on line 2 is wrong");
  });
});

// No tenant_settings row here, so the mode reads as A and the 24 h expiry
// applies. Mode B (no expiry) is in api-orders-approval-ttl.modeB.test.js.
describe("an approved order after the approval expired", () => {
  it("can be cancelled", async () => {
    seed(expiredApproval());
    const res = await patch({ status: "CANCELLED", reason: "Customer cancelled by phone" });
    expect(res._status).toBe(200);
    expect(row().status).toBe("CANCELLED");
  });

  it("can be returned for a fix, which clears the approval, and then resubmitted", async () => {
    seed(expiredApproval());
    const res = await patch({ status: "DRAFT", correction_reason: "Delivery date must move" });
    expect(res._status).toBe(200);
    expect(row().status).toBe("DRAFT");
    expect(row().approval).toBe(null);
    expect(row().approval_expires_at).toBe(null);
    // The resubmit is not refused by the old, expired approval.
    const again = await patch({ status: "PENDING_REVIEW" });
    expect(again._status).toBe(200);
    expect(row().status).toBe("PENDING_REVIEW");
  });

  it("still refuses a move that relies on the approval", async () => {
    seed(expiredApproval());
    const res = await patch({ status: "EXPORTED_TO_TALLY" });
    expect(res._status).toBe(409);
    expect(res._json.error.message).toMatch(/Approval expired/);
    expect(row().status).toBe("APPROVED");
  });

  it("can still be approved again (the expiry never blocked a re-approve)", async () => {
    seed({ ...expiredApproval(), status: "FAILED_TALLY_IMPORT" });
    const res = await patch({ status: "APPROVED", approval: { payloadHash: "hash-test-1" } });
    expect(res._status).toBe(200);
  });
});

describe("a return keeps an unexpired approval off the DRAFT too", () => {
  it("clears a live approval on return", async () => {
    seed({ ...expiredApproval(), approval_expires_at: new Date(Date.now() + DAY).toISOString() });
    const res = await patch({ status: "DRAFT", correction_reason: "Customer asked for a new rate" });
    expect(res._status).toBe(200);
    expect(row().approval).toBe(null);
    expect(row().approval_actions).toEqual([]);
  });

  it("leaves the approval on a cancelled order as the record of what was approved", async () => {
    seed(expiredApproval());
    await patch({ status: "CANCELLED", reason: "Customer cancelled by phone" });
    expect(row().approval).toEqual({ payloadHash: "hash-test-1", approvedBy: "u-approver" });
  });
});

describe("approvalExpiryBlocks", () => {
  const prev = { status: "APPROVED", approval: { payloadHash: "h" }, approval_expires_at: "2026-01-01T00:00:00Z" };
  const now = Date.parse("2026-01-02T00:00:00Z");

  it("blocks a non-withdrawal after expiry", () => {
    expect(approvalExpiryBlocks({ prev, body: { status: "EXPORTED_TO_TALLY" }, intendedAction: "export_tally", now })).toBe(true);
  });

  it.each(["CANCELLED", "DRAFT"])("passes a withdrawal to %s", (to) => {
    expect(approvalExpiryBlocks({ prev, body: { status: to }, now })).toBe(false);
  });

  it("passes before expiry, a re-approve, and a PATCH with no status change", () => {
    expect(approvalExpiryBlocks({ prev, body: { status: "EXPORTED_TO_TALLY" }, now: Date.parse("2025-12-31T00:00:00Z") })).toBe(false);
    expect(approvalExpiryBlocks({ prev, body: { status: "APPROVED" }, intendedAction: "approve", now })).toBe(false);
    expect(approvalExpiryBlocks({ prev, body: { status: "APPROVED" }, now })).toBe(false);
    expect(approvalExpiryBlocks({ prev, body: { committed_delivery_date: "2026-02-01" }, now })).toBe(false);
  });
});
