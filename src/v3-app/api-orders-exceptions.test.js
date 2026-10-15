// GET /api/orders/exceptions (plan PR 9): the REAL handler, terms read path
// and builder against an in-memory Supabase that applies the select lists.
// auth.js is real except resolveContext. Tenant scope, the shadow rule for
// terms rows, the response version, and the client method and route.
// Every name and id is invented.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";
import { dispatch } from "../api/router.js";

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
const CUST = u("c1"), CUST2 = u("c2");
const O1 = u("d1"), O_T2 = u("d9");
const RUN = u("f2"), CHECK = u("e1"), FLAG = u("e2");

const order = (id, over = {}) => ({
  id, tenant_id: T1, status: "DRAFT", customer_id: CUST, po_number: "PO-EX-1", po_date: "2026-10-01",
  vendor_code: null, committed_delivery_date: null, anomaly_flags: [],
  rule_findings: [{ code: "mod_quote_bom_pending", blocks: true, severity: "ERROR", detail: "1 part still provisional (-MOD).", pending_parts: ["GN-7-MOD"] }],
  preflight_payload: { source_document_id: u("f1"), extraction_run_id: RUN, last_validated_at: "2026-10-02T00:00:00Z" },
  result: {
    salesOrder: {
      customer: { name: "Fixture Buyer", gstin: "27AAACF0000A1Z5", state_code: "27" },
      lineItems: [{ partNumber: "EX-1", qty: 10, rate: 120, _match: { verdict: "price_mismatch", part_no: "EX-1" } }],
    },
    quoteReconciliation: {
      flags: [{ part_no: "EX-1", verdict: "price_mismatch", po_rate: 120, quote_rate: 100, price_delta_pct: 20, po_qty: 10, source_quote_number: "Q-EX-1" }],
      mod_bom: { is_modification_quote: true, pending_parts: ["GN-7-MOD"] },
      quoted_not_ordered: [],
    },
  },
  ...over,
});

const seed = (mode = "on") => {
  H.db = createMemoryDb({
    tenant_members: [],
    tenant_settings: [
      { tenant_id: T1, terms_check_mode: mode, terms_policy: null },
      { tenant_id: T2, terms_check_mode: "on", terms_policy: null },
    ],
    customers: [
      { id: CUST, tenant_id: T1, customer_name: "Fixture Buyer", gstin: "27AAACF0000A1Z5", state_code: "27" },
      { id: CUST2, tenant_id: T2, customer_name: "Other Tenant Buyer", gstin: null, state_code: null },
    ],
    customer_vendor_codes: [],
    orders: [order(O1), order(O_T2, { tenant_id: T2, customer_id: CUST2 })],
    extraction_runs: [{ id: RUN, tenant_id: T1, status: "ok", confidence_overall: 0.97, adapter_used: "gemini", anomalies: [], validator_issues: [] }],
    order_term_checks: [{ id: CHECK, tenant_id: T1, order_id: O1, superseded_at: null, created_at: "2026-10-02T00:00:00Z", trigger: "reconcile", po_terms_status: "read", po_clauses: [], quote_ids: [] }],
    order_term_flags: [{
      id: FLAG, tenant_id: T1, check_id: CHECK, order_id: O1, clause: "ld_penalty", outcome: "po_only", severity: "critical", method: "rule",
      po: { clause: "ld_penalty", side: "po", text: "LD at 2% per week, no cap.", provenance: "po_text", page: 6 }, quote: null, baseline: null,
      rationale: "Only the PO states liquidated damages.", created_at: "2026-10-02T00:00:00Z",
    }],
    order_term_decisions: [],
  }, {}, { project: true });
};

const as = (role, tenantId = T1) => { H.ctx = { user: { id: u("a1") }, tenantId, role }; };
const get = (query) => callHandler(handler, { query });

beforeEach(() => { seed("on"); H.ctx = null; });

describe("GET /api/orders/exceptions", () => {
  it("returns version 1: the rows the workspace renders, each with type, key, payload, options and policy", async () => {
    as("sales_engineer");
    const r = await get({ id: O1 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 1, order_id: O1, status: "DRAFT", terms_state: "on", customer_match: { basis: "gstin" } });
    const types = r.body.rows.map((x) => x.type);
    // Severity first (both critical), then the source that can decide it.
    expect(types).toEqual(["terms_flag", "mod_bom_pending", "line_price_mismatch"]);
    const terms = r.body.rows.find((x) => x.type === "terms_flag");
    expect(terms).toMatchObject({ key: "terms_flag|clause:LD_PENALTY", blocks: "send", agent_policy: "human_only", payload: { subject: { flag_id: FLAG } } });
    expect(r.body.rows.find((x) => x.type === "mod_bom_pending")).toMatchObject({ sources: ["finding", "reconciliation"], blocks: "approval" });
    for (const row of r.body.rows) expect(row.resolution_options.length).toBeGreaterThan(0);
  });

  it("is tenant-scoped: another tenant's order is not found", async () => {
    as("admin");
    expect((await get({ id: O_T2 })).status).toBe(404);
    as("admin", T2);
    const own = await get({ id: O_T2 });
    expect(own.status).toBe(200);
    // T2's order reads T2's customer, never T1's extraction run or terms.
    expect(own.body.customer_match).toMatchObject({ master_name: "Other Tenant Buyer" });
    expect(own.body.rows.find((x) => x.type === "terms_flag")).toBeUndefined();
  });

  it("never reads another tenant's customer, even when an order points at one", async () => {
    H.db.tables.orders.push(order(u("d2"), { customer_id: CUST2 }));
    as("sales_engineer");
    const r = await get({ id: u("d2") });
    expect(r.status).toBe(200);
    expect(r.body.customer_match).toMatchObject({ basis: "unknown", master_name: null });
  });

  it("fails closed without a tenant, and refuses a malformed id", async () => {
    H.ctx = { user: { id: u("a1") }, tenantId: null, role: "admin" };
    expect((await get({ id: O1 })).status).toBe(403);
    as("admin");
    expect((await get({ id: "not-an-id" })).status).toBe(400);
  });

  it("in shadow mode an engineer sees no terms rows, and may not ask for them", async () => {
    seed("shadow");
    as("sales_engineer");
    const r = await get({ id: O1 });
    expect(r.status).toBe(200);
    expect(r.body.terms_state).toBe("hidden");
    expect(r.body.rows.find((x) => x.source === "terms")).toBeUndefined();
    const asked = await get({ id: O1, include_shadow: "1" });
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe("SHADOW_ADMIN_ONLY");
  });

  it("in shadow mode an admin who asks sees the terms rows, marked shadow, never blocking", async () => {
    seed("shadow");
    as("admin");
    const r = await get({ id: O1, include_shadow: "1" });
    expect(r.body.terms_state).toBe("shadow");
    expect(r.body.rows.find((x) => x.type === "terms_flag")).toMatchObject({ shadow: true, blocks: null });
    // Without asking, an admin sees what an engineer sees.
    expect((await get({ id: O1 })).body.rows.find((x) => x.type === "terms_flag")).toBeUndefined();
  });

  it("before migration 250, the list is built without terms rows and says so", async () => {
    H.db.tables.tenant_settings = [{ tenant_id: T1 }];
    as("sales_engineer");
    const r = await get({ id: O1 });
    expect(r.status).toBe(200);
    expect(r.body.terms_state).toBe("unavailable");
    expect(r.body.rows.map((x) => x.type)).toEqual(["mod_bom_pending", "line_price_mismatch"]);
  });
});

describe("the client method and the route", () => {
  const client = window.AnvilBackend;
  let fetchMock;
  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* no storage: setConfig still runs */ }
    client.setConfig({ url: "https://api.test", tenantId: "t-1" });
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version: 1, rows: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("GETs /api/orders/exceptions, with include_shadow only when asked", async () => {
    await client.orders.exceptions(O1);
    expect(fetchMock.mock.calls.at(-1)[0]).toBe("https://api.test/api/orders/exceptions?id=" + O1);
    await client.orders.exceptions(O1, { includeShadow: true });
    expect(fetchMock.mock.calls.at(-1)[0]).toBe("https://api.test/api/orders/exceptions?id=" + O1 + "&include_shadow=1");
  });

  it("is a static route, not an order id", async () => {
    const req = { url: "/api/orders/exceptions?id=" + O1, method: "GET", query: {}, headers: {} };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.body = JSON.stringify(o); return res; };
    res.send = (b) => { res.body = b; return res; };
    as("sales_engineer");
    try { await dispatch(req, res); } catch (_) { /* the handler may fail without a database */ }
    expect(res.statusCode).not.toBe(404);
    expect(req.query.id).toBe(O1);
  });
});
