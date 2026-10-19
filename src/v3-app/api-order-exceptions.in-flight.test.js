// A background extraction still in flight is a row in the exceptions list
// (plan C-2): extraction_in_flight, which blocks sending the order for
// approval. The lines on the order can be a page-1 preview until it ends.
//
// The builder, the next step it feeds, and the REAL GET /api/orders/exceptions
// handler against an in-memory Supabase that applies the select lists. The
// job read is tenant-scoped. Every name and id is invented.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";
import { buildOrderExceptions } from "../api/_lib/order-exceptions.js";
import { nextStep } from "../api/_lib/order-next-step.js";

const H = vi.hoisted(() => ({ db: null, ctx: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));

const { default: handler } = await import("../api/orders/exceptions.js");

const T1 = "10000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const u = (n) => "00000000-0000-4000-8000-0000000000" + n;
const O1 = u("d1");

const order = (over = {}) => ({
  id: O1, tenant_id: T1, status: "DRAFT", customer_id: null, po_number: "PO-FL-1", po_date: "2026-10-01",
  vendor_code: null, committed_delivery_date: null, anomaly_flags: [], rule_findings: [],
  preflight_payload: {},
  result: { salesOrder: { lineItems: [{ partNumber: "FL-1", qty: 1, rate: 10 }] } },
  ...over,
});
const job = (over = {}) => ({ id: u("j1"), tenant_id: T1, order_id: O1, status: "extracting", created_at: "2026-10-02T00:00:00Z", ...over });

const inFlight = (out) => out.rows.find((r) => r.type === "extraction_in_flight");

describe("the builder", () => {
  it("raises extraction_in_flight for a queued or running job, and it blocks sending", () => {
    for (const status of ["queued", "profiling", "chunking", "extracting", "merging"]) {
      const out = buildOrderExceptions({ order: order(), extractionJob: job({ status }) });
      expect(inFlight(out), status).toMatchObject({ source: "extraction", blocks: "send", status: "open", payload: { job_id: u("j1"), job_status: status } });
    }
  });

  it("raises nothing for a job that ended, or no job", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      expect(inFlight(buildOrderExceptions({ order: order(), extractionJob: job({ status }) })), status).toBeUndefined();
    }
    expect(inFlight(buildOrderExceptions({ order: order() }))).toBeUndefined();
  });

  it("stops Send for approval until the job ends", () => {
    const permissions = { write: true, approve: false, push: false };
    const running = nextStep({ status: "DRAFT", exceptions: buildOrderExceptions({ order: order(), extractionJob: job() }), permissions });
    expect(running).toMatchObject({ action: "submit_for_approval", enabled: false });
    expect(running.blockers.map((b) => b.type)).toEqual(["extraction_in_flight"]);
    const done = nextStep({ status: "DRAFT", exceptions: buildOrderExceptions({ order: order(), extractionJob: job({ status: "completed" }) }), permissions });
    expect(done.enabled).toBe(true);
  });
});

describe("GET /api/orders/exceptions", () => {
  const seed = (jobs) => {
    H.db = createMemoryDb({
      tenant_members: [],
      tenant_settings: [{ tenant_id: T1, terms_check_mode: "off", terms_policy: null }],
      customers: [], customer_vendor_codes: [], extraction_runs: [],
      orders: [order()],
      extraction_jobs: jobs,
      order_term_checks: [], order_term_flags: [], order_term_decisions: [],
    }, {}, { project: true });
  };
  const get = () => callHandler(handler, { query: { id: O1 } });

  beforeEach(() => { H.ctx = { user: { id: u("a1") }, tenantId: T1, role: "sales_engineer" }; });

  it("reads the order's newest in-flight job and returns the row", async () => {
    seed([job({ id: u("j0"), status: "failed", created_at: "2026-10-01T00:00:00Z" }), job({ status: "queued" })]);
    const r = await get();
    expect(r.status).toBe(200);
    expect(inFlight(r.body)).toMatchObject({ blocks: "send", payload: { job_id: u("j1"), job_status: "queued" } });
  });

  it("never reads another tenant's job for the same order id", async () => {
    seed([job({ tenant_id: T2 })]);
    const r = await get();
    expect(r.status).toBe(200);
    expect(inFlight(r.body)).toBeUndefined();
  });

  it("returns no row once the job completed", async () => {
    seed([job({ status: "completed" })]);
    expect(inFlight((await get()).body)).toBeUndefined();
  });
});
