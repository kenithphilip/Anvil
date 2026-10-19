// The server refuses a move that an exception blocks (plan R-F1 (c), C-3).
//
// The SO workspace greyed out "Send for approval" and "Approve" while an
// undecided critical terms flag was open, but src/api/orders/[id].js read no
// exception on the way to PENDING_REVIEW or APPROVED. A Kanban drop or a
// direct API call went straight past it once terms_check_mode was on. The
// PATCH now builds the exceptions list with the workspace's own builder and
// refuses with 409 ORDER_HAS_BLOCKING_EXCEPTION, naming the rows.
//
// The REAL orders/[id].js, terms read path and terms_decide run against an
// in-memory Supabase. The approve body is the one the Kanban and the queue
// send (approvalPatch). Every name, clause and id is invented.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";
import { approvalPatch } from "./lib/helpers";

const H = vi.hoisted(() => ({ db: null, ctx: null, audits: [] }));

vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal()),
  resolveContext: vi.fn(async () => H.ctx),
}));
vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async (_c, p) => { H.audits.push(p); }),
  recordEvent: vi.fn(async () => {}),
}));
vi.mock("../api/_lib/approval-evaluator.js", () => ({ evaluateApprovalsForOrder: vi.fn(async () => ({ created: [] })) }));
vi.mock("../api/eval/promote.js", () => ({ promoteApprovedOrder: vi.fn(async () => ({ promoted: false })) }));

const { default: patchOrder } = await import("../api/orders/[id].js");
const { default: decideHandler } = await import("../api/orders/terms_decide.js");
const { default: exceptionsHandler } = await import("../api/orders/exceptions.js");

const id = (n) => "00000000-0000-4000-8000-0000000000" + n;
const T1 = id("01"), T2 = id("02");
const O1 = id("d1"), CHECK = id("e1"), FLAG = id("e2");
const ENG = id("a1"), MGR = id("a2");
const CUST = id("c1"), RUN = id("f2");

const LD_TITLE = "Liquidated damages: only the PO states it";

const order = (over = {}) => ({
  id: O1, tenant_id: T1, customer_id: null, status: "PENDING_REVIEW", po_number: "PO-GATE-1", po_date: "2026-10-01",
  quote_id: null, quote_number: null, payload_hash: "hash-gate-1",
  approval: null, approval_actions: [], approval_expires_at: null,
  rule_findings: [], anomaly_flags: [], preflight_payload: {},
  result: { salesOrder: { lineItems: [{ line_no: 1, partNumber: "GATE-A", quantity: 2, unitPrice: 100 }] } },
  updated_at: "2026-10-10T00:00:00.000Z",
  ...over,
});

const criticalFlag = (over = {}) => ({
  id: FLAG, tenant_id: T1, check_id: CHECK, order_id: O1, clause: "ld_penalty", outcome: "po_only", direction: "against_us",
  severity: "critical", method: "rule", superseded_at: null,
  po: { clause: "ld_penalty", side: "po", text: "LD at 2% per week, no cap.", provenance: "po_text", page: 3 },
  quote: null, baseline: null, rationale: "Only the PO states liquidated damages, uncapped.",
  created_at: "2026-10-10T00:00:00Z",
  ...over,
});

const seed = ({ mode = "on", orders = [order()], flags = [criticalFlag()] } = {}) => {
  H.db = createMemoryDb({
    tenant_settings: mode === null
      // A database without migration 250: the row has no terms_check_mode.
      ? [{ tenant_id: T1 }]
      : [{ tenant_id: T1, terms_check_mode: mode, terms_policy: null }, { tenant_id: T2, terms_check_mode: "on", terms_policy: null }],
    orders,
    order_term_checks: [{
      id: CHECK, tenant_id: T1, order_id: O1, superseded_at: null, created_at: "2026-10-10T00:00:00Z",
      trigger: "reconcile", po_terms_status: "read", po_clauses: [], quote_ids: [],
    }],
    order_term_flags: flags,
    order_term_decisions: [],
    customers: [{ id: CUST, tenant_id: T1, customer_name: "Gate Test Buyer", gstin: "27AAACG0000A1Z5", state_code: "27" }],
    customer_vendor_codes: [],
    extraction_runs: [{ id: RUN, tenant_id: T1, status: "ok", confidence_overall: 0.97, adapter_used: "gemini", anomalies: [], validator_issues: [] }],
  }, {}, { project: true });
};

const as = (userId, role, tenantId = T1) => { H.ctx = { user: { id: userId }, tenantId, role }; };
const patch = (body, orderId = O1) => callHandler(patchOrder, { method: "PATCH", query: { id: orderId }, body });
const decide = (decision) => callHandler(decideHandler, {
  method: "POST",
  body: { order_id: O1, flag_id: FLAG, decision, reason: "Checked with the buyer's contract team on the call." },
});
const row = () => H.db.tables.orders.find((o) => o.id === O1);

beforeEach(() => {
  H.audits = [];
  seed();
  as(MGR, "sales_manager");
});

describe("approve: an undecided critical terms flag", () => {
  it("refuses a Kanban-shaped approve with 409 ORDER_HAS_BLOCKING_EXCEPTION, names the flag, and writes nothing", async () => {
    const body = approvalPatch(row());
    expect(body).toEqual({ status: "APPROVED", approval: { payloadHash: "hash-gate-1" } });

    const r = await patch(body);

    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "ORDER_HAS_BLOCKING_EXCEPTION", to: "APPROVED" });
    expect(r.body.error.blocking).toEqual([{
      key: "terms_flag|clause:LD_PENALTY", type: "terms_flag", title: LD_TITLE, severity: "critical", blocks: "send",
      action: { tab: "terms", target: "terms." + FLAG, label: "Decide on the Terms tab" },
    }]);
    expect(r.body.error.message).toBe("Cannot approve this order. Blocked by: " + LD_TITLE + ". Decide it on the order first.");
    expect(row()).toMatchObject({ status: "PENDING_REVIEW", approval: null, approval_actions: [] });
    expect(row().approved_by).toBeUndefined();
    expect(H.audits.map((a) => a.action)).not.toContain("approve_order");
  });

  it("approves the same order once a manager has decided the flag", async () => {
    const d = await decide("accept");
    expect(d.status).toBe(200);
    expect(d.body.flag.state).toBe("decided");

    const r = await patch(approvalPatch(row()));

    expect(r.status).toBe(200);
    expect(row()).toMatchObject({ status: "APPROVED", approved_by: MGR, approval: { payloadHash: "hash-gate-1", approvedBy: MGR } });
    expect(H.audits.map((a) => a.action)).toContain("approve_order");
  });

  it("names every blocking flag, and only the blocking ones", async () => {
    seed({ flags: [
      criticalFlag(),
      criticalFlag({ id: id("e3"), clause: "jurisdiction", outcome: "deviates", severity: "critical" }),
      // A high flag needs a decision too, but it does not stop the move.
      criticalFlag({ id: id("e4"), clause: "warranty", outcome: "deviates", severity: "high" }),
    ] });
    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(409);
    expect(r.body.error.blocking.map((b) => b.key).sort()).toEqual(["terms_flag|clause:JURISDICTION", "terms_flag|clause:LD_PENALTY"]);
    expect(r.body.error.message).toMatch(/^Cannot approve this order\. Blocked by: .+; .+\. Decide them on the order first\.$/);
  });

  it("refuses the send rows the workspace's list shows, read from the same inputs", async () => {
    // An order with a customer and an extraction run: the list the workspace
    // reads (GET /api/orders/exceptions) is built from those too.
    seed({ orders: [order({ customer_id: CUST, preflight_payload: { extraction_run_id: RUN } })] });
    const list = await callHandler(exceptionsHandler, { method: "GET", query: { id: O1 } });
    expect(list.status).toBe(200);
    const shown = list.body.rows.filter((x) => x.blocks === "send" && !x.shadow && x.status === "open").map((x) => x.key);
    expect(shown).toEqual(["terms_flag|clause:LD_PENALTY"]);

    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(409);
    expect(r.body.error.blocking.map((b) => b.key)).toEqual(shown);
  });

  it("refuses a re-approval from FAILED_TALLY_IMPORT, and lets it through once the flag is decided", async () => {
    // The order was approved before the terms check flagged it (a manual run
    // after approval), and its Tally import then failed. Every approve is
    // gated, so the retry's re-approval meets the flag too.
    seed({ orders: [order({
      status: "FAILED_TALLY_IMPORT",
      approval: { payloadHash: "hash-gate-1", approvedBy: MGR },
      approval_actions: ["approve", "export_tally"],
      approval_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    })] });

    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "ORDER_HAS_BLOCKING_EXCEPTION", to: "APPROVED" });
    expect(row().status).toBe("FAILED_TALLY_IMPORT");

    expect((await decide("accept")).status).toBe(200);
    const again = await patch(approvalPatch(row()));
    expect(again.status).toBe(200);
    expect(row()).toMatchObject({ status: "APPROVED", approved_by: MGR });
  });
});

describe("send for approval: the same flag", () => {
  beforeEach(() => {
    seed({ orders: [order({ status: "DRAFT", payload_hash: null })] });
    as(ENG, "sales_engineer");
  });

  it("refuses DRAFT to PENDING_REVIEW with 409, and the order stays a DRAFT with no hash", async () => {
    const r = await patch({ status: "PENDING_REVIEW" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "ORDER_HAS_BLOCKING_EXCEPTION", to: "PENDING_REVIEW" });
    expect(r.body.error.blocking.map((b) => b.key)).toEqual(["terms_flag|clause:LD_PENALTY"]);
    expect(r.body.error.message).toBe("Cannot send this order for approval. Blocked by: " + LD_TITLE + ". Decide it on the order first.");
    expect(row()).toMatchObject({ status: "DRAFT", payload_hash: null });
  });

  it("sends it once the engineer has rejected the term", async () => {
    // reject_term needs only order.terms_decide, which an engineer holds.
    expect((await decide("reject_term")).status).toBe(200);
    const r = await patch({ status: "PENDING_REVIEW" });
    expect(r.status).toBe(200);
    expect(row().status).toBe("PENDING_REVIEW");
    expect(row().payload_hash).toBeTruthy();
  });

  it("still saves a line edit on the DRAFT: only the two moves are gated", async () => {
    const r = await patch({ result: { salesOrder: { lineItems: [{ line_no: 1, partNumber: "GATE-A", quantity: 3, unitPrice: 100 }] } } });
    expect(r.status).toBe(200);
    expect(row().result.salesOrder.lineItems[0].quantity).toBe(3);
  });
});

describe("what never blocks", () => {
  it("a shadow-mode flag: shown to an admin who asks, never acted on", async () => {
    seed({ mode: "shadow" });
    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(200);
    expect(row().status).toBe("APPROVED");
  });

  it("a stored flag while the check is off", async () => {
    seed({ mode: "off" });
    expect((await patch(approvalPatch(row()))).status).toBe(200);
  });

  it("anything, before migration 250: no check can exist", async () => {
    seed({ mode: null });
    expect((await patch(approvalPatch(row()))).status).toBe(200);
  });

  it("another tenant's flag on the same order id", async () => {
    seed({ flags: [criticalFlag({ tenant_id: T2 })] });
    expect((await patch(approvalPatch(row()))).status).toBe(200);
  });

  it("a return for correction", async () => {
    const r = await patch({ status: "DRAFT", correction_reason: "Fix the ship-to address." });
    expect(r.status).toBe(200);
    expect(row().status).toBe("DRAFT");
  });
});

describe("fails closed", () => {
  let logged;
  beforeEach(() => { logged = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { logged.mockRestore(); });

  const UNAVAILABLE = { code: "ORDER_EXCEPTIONS_UNAVAILABLE", message: "Could not check this order's exceptions. Try again.", to: "APPROVED" };

  it("refuses the move with 503 when the terms flags cannot be read, says to try again, and writes nothing", async () => {
    H.db.failRead.order_term_flags = { message: "connection reset" };
    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual(UNAVAILABLE);
    // The database's words go to the log, not to the person.
    expect(JSON.stringify(r.body)).not.toContain("connection reset");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("order-move-gate"), expect.objectContaining({ order_id: O1, to: "APPROVED", message: expect.stringContaining("connection reset") }));
    expect(row()).toMatchObject({ status: "PENDING_REVIEW", approval: null });
  });

  it("refuses the move with 503 when the tenant's settings cannot be read, with the check off", async () => {
    seed({ mode: "off" });
    H.db.failRead.tenant_settings = { message: "timeout" };
    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(503);
    expect(r.body.error).toEqual(UNAVAILABLE);
    expect(row().status).toBe("PENDING_REVIEW");
  });

  it("refuses the move with 503 when the customer master cannot be read", async () => {
    seed({ orders: [order({ customer_id: CUST })] });
    H.db.failRead.customers = { message: "connection reset" };
    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("ORDER_EXCEPTIONS_UNAVAILABLE");
    expect(row().status).toBe("PENDING_REVIEW");
  });
});
