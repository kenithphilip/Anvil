// The -MOD finding still refuses approve (plan R-F1 (c), C-3 regression).
//
// A gun-modification order priced against provisional (-MOD) parts carries
// the reconcile's finding in rule_findings with blocks: true (modBomFinding,
// order-reconcile.js). The server refused its approval before the exceptions
// gate (plan C-3) existed, a Kanban drop included, as
// ORDER_HAS_UNRESOLVED_BLOCKER. These tests keep it so with the gate in place,
// and keep the escape hatch: an approver resolves the finding, then approves.
//
// The REAL orders/[id].js runs against an in-memory Supabase, with the terms
// check on and no terms flag, so the new gate has nothing of its own to
// refuse. Every part number and id is invented.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";
import { approvalPatch } from "./lib/helpers";
import { modBomFinding } from "../api/_lib/mod-parts.js";
import { buildOrderExceptions } from "../api/_lib/order-exceptions.js";
import { nextStep } from "../api/_lib/order-next-step.js";

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

const id = (n) => "00000000-0000-4000-8000-0000000000" + n;
const T1 = id("01"), O1 = id("d1"), ENG = id("a1"), MGR = id("a2");

const LINES = [
  { line_no: 1, partNumber: "GN-7-MOD", quantity: 1, unitPrice: 5000 },
  { line_no: 2, partNumber: "GN-7-TIP", quantity: 4, unitPrice: 120 },
];
const MOD = modBomFinding(LINES, { sourceQuoteNumber: "Q-MOD-1" });

const order = (over = {}) => ({
  id: O1, tenant_id: T1, customer_id: null, status: "PENDING_REVIEW", po_number: "PO-MOD-1", po_date: "2026-10-01",
  quote_id: null, quote_number: null, payload_hash: "hash-mod-1",
  approval: null, approval_actions: [], approval_expires_at: null,
  rule_findings: [MOD], anomaly_flags: [], preflight_payload: {},
  result: {
    salesOrder: { lineItems: LINES },
    quoteReconciliation: { flags: [], quoted_not_ordered: [], mod_bom: { is_modification_quote: true, pending_parts: ["GN-7-MOD"] } },
  },
  updated_at: "2026-10-10T00:00:00.000Z",
  ...over,
});

const seed = (o = order()) => {
  H.db = createMemoryDb({
    tenant_settings: [{ tenant_id: T1, terms_check_mode: "on", terms_policy: null }],
    orders: [o],
    order_term_checks: [],
    order_term_flags: [],
    order_term_decisions: [],
  }, {}, { project: true });
};

const as = (userId, role) => { H.ctx = { user: { id: userId }, tenantId: T1, role }; };
const patch = (body) => callHandler(patchOrder, { method: "PATCH", query: { id: O1 }, body });
const row = () => H.db.tables.orders[0];

beforeEach(() => {
  H.audits = [];
  seed();
  as(MGR, "sales_manager");
});

describe("the server-held -MOD finding", () => {
  it("is the reconcile's blocking finding", () => {
    expect(MOD).toMatchObject({ code: "mod_quote_bom_pending", blocks: true, pending_parts: ["GN-7-MOD"] });
  });

  it("refuses a Kanban-shaped approve with 409 ORDER_HAS_UNRESOLVED_BLOCKER, and writes nothing", async () => {
    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("ORDER_HAS_UNRESOLVED_BLOCKER");
    expect(r.body.error.finding).toMatchObject({ code: "mod_quote_bom_pending" });
    expect(row()).toMatchObject({ status: "PENDING_REVIEW", approval: null });
    expect(H.audits.map((a) => a.action)).not.toContain("approve_order");
  });

  it("is what the workspace shows too: an approval row that disables Approve", () => {
    const list = buildOrderExceptions({ order: row() });
    const mod = list.rows.find((r) => r.type === "mod_bom_pending");
    expect(mod).toMatchObject({ blocks: "approval", sources: ["finding", "reconciliation"] });
    const step = nextStep({ status: "PENDING_REVIEW", exceptions: list, permissions: { write: true, approve: true, push: true } });
    expect(step).toMatchObject({ action: "approve", enabled: false });
    expect(step.blockers.map((b) => b.key)).toEqual([mod.key]);
  });

  it("does not stop the engineer sending the order to an approver", async () => {
    seed(order({ status: "DRAFT", payload_hash: null }));
    as(ENG, "sales_engineer");
    const r = await patch({ status: "PENDING_REVIEW" });
    expect(r.status).toBe(200);
    expect(row().status).toBe("PENDING_REVIEW");
  });

  it("lets the approve through once an approver resolves it, and keeps the finding as resolved", async () => {
    const resolved = await patch({ resolve_finding: { code: "mod_quote_bom_pending", note: "Design confirmed the provisional number." } });
    expect(resolved.status).toBe(200);
    expect(H.audits.map((a) => a.action)).toContain("order_finding_resolved");

    const r = await patch(approvalPatch(row()));
    expect(r.status).toBe(200);
    expect(row().status).toBe("APPROVED");
    expect(row().rule_findings[0]).toMatchObject({ code: "mod_quote_bom_pending", resolved: true, resolved_by: MGR });
  });
});
