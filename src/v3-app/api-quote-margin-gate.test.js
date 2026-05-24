// Tests for the margin-floor gate on the quote SENT transition
// (/api/quotes PATCH). A quote with any line below its profile's floor
// cannot be sent by a non-approver; an approver can override (recorded
// in the audit); a clean quote sends normally.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  role: "sales_engineer",
  quote: null,
  compositionLines: [],
  audits: [],
}));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: h.role, anonymous: false })),
  requirePermission: vi.fn(() => {}),
  // Mirror the real role map so the gate can branch on approve.
  hasPermission: (ctx, level) => {
    const APPROVERS = new Set(["sales_manager", "finance", "admin"]);
    const WRITERS = new Set(["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator"]);
    if (level === "approve") return APPROVERS.has(ctx.role);
    if (level === "write") return WRITERS.has(ctx.role);
    return true;
  },
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async (ctx, a) => { h.audits.push(a); }),
  recordEvent: vi.fn(async () => {}),
}));

const makeQuery = (resolve) => {
  const state = { filters: {}, op: "select", payload: null };
  const q = {
    select() { return q; },
    eq(k, v) { state.filters[k] = v; return q; },
    update(p) { state.op = "update"; state.payload = p; return q; },
    maybeSingle() { return Promise.resolve(resolve(state, "maybeSingle")); },
    single() { return Promise.resolve(resolve(state, "single")); },
    then(onF, onR) { return Promise.resolve(resolve(state, "list")).then(onF, onR); },
  };
  return q;
};

const resolver = (table) => (state, mode) => {
  if (table === "quotes") {
    if (state.op === "update") return { data: { ...h.quote, ...state.payload }, error: null };
    return { data: h.quote, error: null }; // maybeSingle / single
  }
  if (table === "price_composition_lines") return { data: h.compositionLines, error: null };
  return { data: [], error: null };
};

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: vi.fn(() => ({ from: (t) => makeQuery(resolver(t)) })),
}));

const { default: handler } = await import("../api/quotes/index.js");

const makeRes = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.statusCode = c; return this; },
  send(p) { this.body = p; return this; },
  json(o) { this.body = JSON.stringify(o); return this; },
  end() { return this; },
});

const patchToSent = async () => {
  const req = { method: "PATCH", headers: {}, query: { id: "q-1" }, body: { status: "SENT" } };
  const res = makeRes();
  await handler(req, res);
  return { res, parsed: res.body ? JSON.parse(res.body) : null };
};

beforeEach(() => {
  h.role = "sales_engineer";
  h.quote = { id: "q-1", tenant_id: "t-1", status: "DRAFT", quote_number: "Q-1", version: 1, validity_days: 30, currency: "INR" };
  h.compositionLines = [];
  h.audits = [];
});

describe("quote margin-floor gate on SENT", () => {
  it("blocks a non-approver when a line is below the floor", async () => {
    h.compositionLines = [{ line_index: 0, part_no: "X", margin_realized: 0.02, margin_floor: 0.05 }];
    const { res, parsed } = await patchToSent();
    expect(res.statusCode).toBe(409);
    expect(parsed.error.code).toBe("MARGIN_FLOOR_BLOCK");
    expect(parsed.error.below).toHaveLength(1);
  });

  it("lets an approver override and records the override in the audit", async () => {
    h.role = "sales_manager";
    h.compositionLines = [{ line_index: 0, part_no: "X", margin_realized: 0.02, margin_floor: 0.05 }];
    const { res } = await patchToSent();
    expect(res.statusCode).toBe(200);
    expect(h.audits.some((a) => a.action === "quote_margin_override")).toBe(true);
  });

  it("allows a non-approver to send when all lines clear the floor", async () => {
    h.compositionLines = [{ line_index: 0, part_no: "X", margin_realized: 0.3, margin_floor: 0.05 }];
    const { res } = await patchToSent();
    expect(res.statusCode).toBe(200);
    expect(h.audits.some((a) => a.action === "quote_margin_override")).toBe(false);
  });

  it("allows sending when there is no composition at all", async () => {
    h.compositionLines = [];
    const { res } = await patchToSent();
    expect(res.statusCode).toBe(200);
  });
});
