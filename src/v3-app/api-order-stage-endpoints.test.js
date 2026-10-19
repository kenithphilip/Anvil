// The stage on the approvals queue and on GET /api/orders/exceptions (plan
// R-M1, C-9). The REAL handlers against the in-memory Supabase. Invented ids;
// no real names.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, ctx: null, reads: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => {
    const svc = H.db.svc();
    return { ...svc, from: (t) => { H.reads.push(t); return svc.from(t); } };
  },
}));

const { default: approvals } = await import("../api/admin/quote_approvals.js");
const { default: exceptions } = await import("../api/orders/exceptions.js");

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const u = (n) => "00000000-0000-4000-8000-0000000000" + n;
const O1 = u("d1"), O2 = u("d2");

const order = (id, over = {}) => ({
  id, tenant_id: T1, status: "DRAFT", customer_id: null, po_number: "PO-" + id.slice(-2), result: {}, preflight_payload: {},
  rule_findings: [], anomaly_flags: [], created_at: "2026-10-01T05:00:00.000Z", updated_at: "2026-10-09T05:00:00.000Z",
  approval: null, approved_at: null, payload_hash: "h-1", tally_status: "idle", handoff_status: null, handoff_payload: null, ...over,
});

const seed = (tables, project = false) => {
  H.db = createMemoryDb({
    tenant_members: [], customers: [], customer_vendor_codes: [], extraction_runs: [],
    order_term_checks: [], order_term_flags: [], order_term_decisions: [], order_documents: [], extraction_jobs: [],
    tenant_settings: [{ tenant_id: T1, terms_check_mode: "off", terms_policy: null, so_processing_mode: "B" }],
    ...tables,
  }, {}, { project });
};

beforeEach(() => {
  H.ctx = { user: { id: u("a1") }, tenantId: T1, role: "sales_manager" };
  H.reads = [];
});

describe("the approvals queue carries the stage", () => {
  it("in approval, held by the open threshold's role, else a sales manager; no evidence read", async () => {
    seed({
      orders: [order(O1, { status: "PENDING_REVIEW" }), order(O2, { status: "PENDING_REVIEW" })],
      quote_approvals: [{ id: u("q1"), tenant_id: T1, order_id: O1, approver_role: "finance", status: "PENDING" }],
    });
    const r = await callHandler(approvals, { query: { type: "queue" } });
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.orders.map((o) => [o.order_id, o.stage]));
    expect(byId[O1]).toMatchObject({ stage: "in_approval", holder_role: "finance", next_action: "approve" });
    expect(byId[O2]).toMatchObject({ stage: "in_approval", holder_role: "sales_manager" });
    expect(H.reads).not.toContain("order_documents");
  });
});

describe("GET /api/orders/exceptions carries the stage", () => {
  const get = (id) => callHandler(exceptions, { query: { id } });

  it("received while this tenant's background extraction is in flight; verifying once it ends", async () => {
    seed({
      orders: [order(O1)],
      extraction_jobs: [
        { id: u("j1"), tenant_id: T1, order_id: O1, status: "extracting", created_at: "2026-10-01T06:00:00.000Z" },
        // Another tenant's job naming the same order id is never read.
        { id: u("j9"), tenant_id: T2, order_id: O1, status: "queued", created_at: "2026-10-01T07:00:00.000Z" },
      ],
    }, true);
    const r = await get(O1);
    expect(r.status).toBe(200);
    expect(r.body.stage).toEqual({ stage: "received", since: "2026-10-01T06:00:00.000Z", evidence_ref: "extraction_jobs:" + u("j1"), holder_role: "system", next_action: "wait_for_extraction" });
    H.db.tables.extraction_jobs[0].status = "completed";
    expect((await get(O1)).body.stage).toMatchObject({ stage: "verifying", next_action: "submit_for_approval" });
  });

  it("Mode B with the Tally SO attached: keyed in ERP, beside the same exceptions list", async () => {
    seed({
      orders: [order(O1, { status: "APPROVED", approval: { payloadHash: "h-1" }, approved_at: "2026-10-03T05:00:00.000Z" })],
      order_documents: [{ order_id: O1, document_id: u("e1"), role: "sales_order" }],
    }, true);
    const r = await get(O1);
    expect(r.body).toMatchObject({ version: 1, order_id: O1 });
    expect(r.body.stage).toMatchObject({ stage: "keyed", evidence_ref: "order_documents:" + u("e1") });
  });
});
