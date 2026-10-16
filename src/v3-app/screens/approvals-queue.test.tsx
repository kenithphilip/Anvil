// The Approvals queue decides the ORDER (plan PR 2).
//
// It used to list quote_approvals threshold rows only, and its approve and
// reject wrote those rows and never touched the order: an "approved" order
// stayed PENDING_REVIEW. These tests run the REAL handlers
// (admin/quote_approvals.js and orders/[id].js) behind the screen's client
// calls, over a small in-memory database, so "the order moved" is the
// server's own answer.
//
// Every value is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const T = "00000000-0000-0000-0000-0000000000aa";
const OTHER_T = "00000000-0000-0000-0000-0000000000ff";

const H = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, any>>>,
  ctx: { user: { id: "u-mgr" }, tenantId: "00000000-0000-0000-0000-0000000000aa", role: "sales_manager" } as Record<string, any>,
  audits: [] as Array<Record<string, any>>,
}));

// An in-memory Supabase: eq / in filters, update, insert, and the
// customer:customer_id(...) embed the queue reads.
vi.mock("../../api/_lib/supabase.js", () => {
  const clone = (v: any) => JSON.parse(JSON.stringify(v));
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let op = "select";
    let patch: any = null;
    let rowsIn: any[] = [];
    let cols = "";
    const run = async () => {
      const rows = H.tables[table] || (H.tables[table] = []);
      if (op === "insert") {
        const out = rowsIn.map((r, i) => ({ id: "row-" + Date.now() + "-" + i, created_at: new Date().toISOString(), ...clone(r) }));
        rows.push(...out);
        return { data: clone(out), error: null };
      }
      const hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") hit.forEach((r) => Object.assign(r, clone(patch), { updated_at: new Date().toISOString() }));
      const embed = /customer:customer_id\(/.test(cols);
      return {
        data: hit.map((r) => {
          const o = clone(r);
          if (embed) o.customer = (H.tables.customers || []).find((c) => c.id === r.customer_id) || null;
          return o;
        }),
        error: null,
      };
    };
    const one = () => run().then((r) => ({ data: r.data[0] || null, error: r.data[0] ? null : { message: "no rows" } }));
    const q: any = {
      select: (c?: string) => { if (op === "select") cols = c || ""; return q; },
      eq: (c: string, v: unknown) => { filters.push((r) => String(r[c]) === String(v)); return q; },
      in: (c: string, vals: unknown[]) => { filters.push((r) => vals.map(String).includes(String(r[c]))); return q; },
      order: () => q,
      limit: () => q,
      update: (p: any) => { op = "update"; patch = p; return q; },
      insert: (r: any) => { op = "insert"; rowsIn = Array.isArray(r) ? r : [r]; return q; },
      single: one,
      maybeSingle: () => run().then((r) => ({ data: r.data[0] || null, error: null })),
      then: (f: any, rj: any) => run().then(f, rj),
    };
    return q;
  };
  return { serviceClient: () => ({ from }), userClient: () => ({ from }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => H.ctx),
}));
vi.mock("../../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async (_ctx: any, p: any) => { H.audits.push(p); }),
  recordEvent: vi.fn(async () => {}),
}));
vi.mock("../../api/eval/promote.js", () => ({ promoteApprovedOrder: vi.fn(async () => ({ promoted: false })) }));

const approvalsHandler = (await import("../../api/admin/quote_approvals.js")).default;
const orderHandler = (await import("../../api/orders/[id].js")).default;

// Run a handler the way the client's apiFetch would: a non-2xx answer throws
// an Error carrying status and body.
const call = async (handler: any, req: Record<string, any>) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    json(o: unknown) { sent = JSON.stringify(o); return res; },
    end() { return res; },
  };
  await handler({ headers: {}, query: {}, ...req }, res);
  const body = sent ? JSON.parse(sent) : {};
  return { status, body };
};
const asClient = async (handler: any, req: Record<string, any>) => {
  const { status, body } = await call(handler, req);
  if (status >= 400) {
    const err: any = new Error(body?.error?.message || "HTTP " + status);
    err.status = status;
    err.body = body;
    throw err;
  }
  return body;
};

const orderUpdate = vi.fn((id: string, body: Record<string, unknown>) =>
  asClient(orderHandler, { method: "PATCH", query: { id }, url: "/api/orders/" + id, body }));
const orderGet = vi.fn((id: string) =>
  asClient(orderHandler, { method: "GET", query: { id }, url: "/api/orders/" + id }));
const listQueue = vi.fn(() => asClient(approvalsHandler, { method: "GET", query: { type: "queue" } }));
const decide = vi.fn((payload: Record<string, unknown>) =>
  asClient(approvalsHandler, { method: "POST", query: { type: "approvals" }, body: payload }));

const lines = [{ partNumber: "TEST-A", description: "Test bracket", qty: 4, rate: 250 }];
const order = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, tenant_id: T, status, po_number: "PO-" + id.toUpperCase(), customer_id: "c-1",
  payload_hash: "hash-" + id, approval: null, rule_findings: [],
  result: { salesOrder: { grandTotal: 1000, lineItems: lines } },
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-02T00:00:00.000Z",
  ...extra,
});

const seed = () => {
  H.tables = {
    customers: [{ id: "c-1", tenant_id: T, customer_name: "Test Buyer Pvt Ltd", gstin: "27AAAAA0000A1Z5", state_code: "27" }],
    orders: [
      order("pa", "PENDING_REVIEW"),
      order("pb", "PENDING_REVIEW"),
      order("dr", "DRAFT"),
      order("ap", "APPROVED"),
      order("ot", "PENDING_REVIEW", { tenant_id: OTHER_T }),
    ],
    quote_approvals: [
      { id: "qa-1", tenant_id: T, order_id: "pa", approver_role: "sales_manager", status: "PENDING", comments: "auto: threshold 0000aaaa" },
      { id: "qa-2", tenant_id: T, order_id: "pa", approver_role: "finance", status: "PENDING", comments: "auto: threshold 0000bbbb" },
      { id: "qa-old", tenant_id: T, order_id: "pb", approver_role: "finance", status: "REJECTED", comments: "earlier round" },
    ],
  };
};

const row = (id: string) => H.tables.orders.find((o) => o.id === id)!;
const approvalRow = (id: string) => H.tables.quote_approvals.find((a) => a.id === id)!;

beforeEach(() => {
  seed();
  H.audits = [];
  H.ctx = { user: { id: "u-mgr" }, tenantId: T, role: "sales_manager" };
  [orderUpdate, orderGet, listQueue, decide].forEach((f) => f.mockClear());
  installBackend({
    orders: { update: orderUpdate, get: orderGet },
    admin: { listApprovalQueue: listQueue, decideApprovalRequest: decide },
  });
  installRbac("sales_manager");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  (window as any).notifyWarn = vi.fn();
  // The queue must never fall back to a native dialog.
  vi.stubGlobal("prompt", () => { throw new Error("window.prompt must not be used"); });
  vi.stubGlobal("confirm", () => { throw new Error("window.confirm must not be used"); });
});

const renderQueue = async () => {
  const mod = await import("./approvals");
  const out = renderScreen(mod.default);
  await screen.findByText("PO-PA");
  return out;
};

describe("the Approvals queue", () => {
  it("lists every PENDING_REVIEW order of the tenant, with threshold rows as reasons", async () => {
    await renderQueue();
    expect(screen.getByText("PO-PB")).toBeTruthy();
    // Not a draft, not an approved order, not another tenant's order.
    expect(screen.queryByText("PO-DR")).toBeNull();
    expect(screen.queryByText("PO-AP")).toBeNull();
    expect(screen.queryByText("PO-OT")).toBeNull();
    // The order with two open threshold rows shows both as reasons.
    const pa = screen.getByTestId("approvals-row-pa");
    expect(within(pa).getByText("sales manager sign-off")).toBeTruthy();
    expect(within(pa).getByText("finance sign-off")).toBeTruthy();
    // The order with no open threshold row is still listed: it was sent
    // for approval. Its decided row from an earlier round is not a reason.
    const pb = screen.getByTestId("approvals-row-pb");
    expect(within(pb).getByText("sent for approval")).toBeTruthy();
    expect(within(pb).queryByText("finance sign-off")).toBeNull();
  });

  it("the queue endpoint returns the same set, with the payload hash", async () => {
    const { status, body } = await call(approvalsHandler, { method: "GET", query: { type: "queue" } });
    expect(status).toBe(200);
    expect(body.orders.map((o: any) => o.order_id).sort()).toEqual(["pa", "pb"]);
    const pa = body.orders.find((o: any) => o.order_id === "pa");
    expect(pa.payload_hash).toBe("hash-pa");
    expect(pa.customer_name).toBe("Test Buyer Pvt Ltd");
    expect(pa.thresholds.map((t: any) => t.id).sort()).toEqual(["qa-1", "qa-2"]);
  });

  it("approve moves the order to APPROVED with its hash, then closes its threshold rows", async () => {
    await renderQueue();
    const pa = screen.getByTestId("approvals-row-pa");
    await act(async () => { fireEvent.click(within(pa).getByTitle("Approve PO-PA")); });
    // An in-app confirm: nothing is sent on the first click.
    expect(orderUpdate).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(within(pa).getByTitle("Confirm: approve PO-PA")); });

    await waitFor(() => expect(row("pa").status).toBe("APPROVED"));
    // The SO workspace's request: approvalPatch with the order's hash.
    expect(orderUpdate).toHaveBeenCalledWith("pa", { status: "APPROVED", approval: { payloadHash: "hash-pa" } });
    expect(row("pa").approval.payloadHash).toBe("hash-pa");
    expect(row("pa").approved_by).toBe("u-mgr");
    await waitFor(() => expect(approvalRow("qa-2").status).toBe("APPROVED"));
    expect(approvalRow("qa-1").status).toBe("APPROVED");
    expect(approvalRow("qa-1").approver_user).toBe("u-mgr");
    // The decided row from an earlier round is left alone.
    expect(approvalRow("qa-old").status).toBe("REJECTED");
    expect(H.audits.map((a) => a.action)).toContain("approve_order");
    // The queue reloads, and the approved order has left it.
    await waitFor(() => expect(screen.queryByText("PO-PA")).toBeNull());
  });

  it("return for fix moves the order back to DRAFT, with the reason in the audit", async () => {
    await renderQueue();
    const pa = screen.getByTestId("approvals-row-pa");
    await act(async () => { fireEvent.click(within(pa).getByText("review")); });
    const drawer = await screen.findByRole("dialog", { name: "Review sales order" });
    await act(async () => { fireEvent.click(within(drawer).getByText("return for fix")); });
    // The reason is required: the send button stays off until it is typed.
    const send = within(drawer).getByText("send back for fix").closest("button") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText(/What needs to be fixed/), { target: { value: "Ship-to is Plant 2, not Plant 1." } });
    expect(send.disabled).toBe(false);
    await act(async () => { fireEvent.click(send); });

    await waitFor(() => expect(row("pa").status).toBe("DRAFT"));
    expect(row("pa").correction_reason).toBe("Ship-to is Plant 2, not Plant 1.");
    expect(row("pa").correction_requested_by).toBe("sales_manager");
    const audit = H.audits.find((a) => a.action === "manager_requested_correction");
    expect(audit).toBeTruthy();
    expect(audit!.reason).toBe("Ship-to is Plant 2, not Plant 1.");
    await waitFor(() => expect(approvalRow("qa-1").status).toBe("REJECTED"));
    expect(approvalRow("qa-1").comments).toBe("Returned for fix: Ship-to is Plant 2, not Plant 1.");
  });

  it("offers no reject until owner decision 3 says what reject means", async () => {
    await renderQueue();
    expect(screen.queryByText("reject")).toBeNull();
    const pa = screen.getByTestId("approvals-row-pa");
    await act(async () => { fireEvent.click(within(pa).getByText("review")); });
    const drawer = await screen.findByRole("dialog", { name: "Review sales order" });
    expect(within(drawer).queryByText("reject")).toBeNull();
    expect(within(drawer).getByTitle("Approve this order")).toBeTruthy();
  });
});

describe("a stale approval (plan PR 3)", () => {
  it("reloads the queue when the order changed after it loaded, and approves the order as it is now", async () => {
    await renderQueue();
    // An engineer saves a line meanwhile, which re-stamps the hash.
    row("pa").payload_hash = "hash-pa-v2";
    const pa = screen.getByTestId("approvals-row-pa");
    await act(async () => { fireEvent.click(within(pa).getByTitle("Approve PO-PA")); });
    await act(async () => { fireEvent.click(within(pa).getByTitle("Confirm: approve PO-PA")); });

    await waitFor(() => expect((window as any).notifyWarn).toHaveBeenCalledWith(
      "This order changed since you opened it", expect.stringMatching(/reloaded/)));
    expect(row("pa").status).toBe("PENDING_REVIEW");
    expect(approvalRow("qa-1").status).toBe("PENDING");
    // The queue reloaded, so the next approve carries the new hash.
    await waitFor(() => expect(listQueue.mock.calls.length).toBeGreaterThan(1));
    const again = screen.getByTestId("approvals-row-pa");
    await act(async () => { fireEvent.click(within(again).getByTitle("Approve PO-PA")); });
    await act(async () => { fireEvent.click(within(again).getByTitle("Confirm: approve PO-PA")); });
    await waitFor(() => expect(row("pa").status).toBe("APPROVED"));
    expect(row("pa").approval.payloadHash).toBe("hash-pa-v2");
  });

  it("refreshes an open drawer to the order as it is now", async () => {
    await renderQueue();
    const pa = screen.getByTestId("approvals-row-pa");
    await act(async () => { fireEvent.click(within(pa).getByText("review")); });
    const drawer = await screen.findByRole("dialog", { name: "Review sales order" });
    const loads = orderGet.mock.calls.length;
    row("pa").payload_hash = "hash-pa-v2";
    await act(async () => { fireEvent.click(within(drawer).getByTitle("Approve this order")); });
    await waitFor(() => expect((window as any).notifyWarn).toHaveBeenCalled());
    // The drawer re-read the order, and its approve now sends the new hash.
    await waitFor(() => expect(orderGet.mock.calls.length).toBeGreaterThan(loads));
    const fresh = await screen.findByRole("dialog", { name: "Review sales order" });
    await act(async () => { fireEvent.click(within(fresh).getByTitle("Approve this order")); });
    await waitFor(() => expect(row("pa").status).toBe("APPROVED"));
    expect(orderUpdate).toHaveBeenLastCalledWith("pa", { status: "APPROVED", approval: { payloadHash: "hash-pa-v2" } });
  });
});

describe("the decision POST needs approve", () => {
  it("refuses a sales engineer, and the row stays open", async () => {
    H.ctx = { user: { id: "u-eng" }, tenantId: T, role: "sales_engineer" };
    const { status } = await call(approvalsHandler, {
      method: "POST", query: { type: "approvals" },
      body: { id: "qa-1", order_id: "pa", approver_role: "sales_manager", status: "APPROVED" },
    });
    expect(status).toBe(403);
    expect(approvalRow("qa-1").status).toBe("PENDING");
    expect(approvalRow("qa-1").decided_at).toBeUndefined();
  });

  it("refuses a sales engineer a new row born decided", async () => {
    H.ctx = { user: { id: "u-eng" }, tenantId: T, role: "sales_engineer" };
    const before = H.tables.quote_approvals.length;
    const { status } = await call(approvalsHandler, {
      method: "POST", query: { type: "approvals" },
      body: { order_id: "pa", approver_role: "sales_manager", status: "APPROVED" },
    });
    expect(status).toBe(403);
    expect(H.tables.quote_approvals.length).toBe(before);
  });

  it("lets a sales engineer open a PENDING request, which is not a decision", async () => {
    H.ctx = { user: { id: "u-eng" }, tenantId: T, role: "sales_engineer" };
    const { status, body } = await call(approvalsHandler, {
      method: "POST", query: { type: "approvals" },
      body: { order_id: "pb", approver_role: "sales_manager" },
    });
    expect(status).toBe(200);
    expect(body.approval.status).toBe("PENDING");
  });

  it("lets a sales manager decide", async () => {
    const { status } = await call(approvalsHandler, {
      method: "POST", query: { type: "approvals" },
      body: { id: "qa-1", order_id: "pa", approver_role: "sales_manager", status: "APPROVED" },
    });
    expect(status).toBe(200);
    expect(approvalRow("qa-1").status).toBe("APPROVED");
  });
});
