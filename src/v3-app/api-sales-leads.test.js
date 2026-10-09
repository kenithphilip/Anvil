// /api/sales/leads, driven through the real handler over a small in-memory
// table set.
//
// POST used to drop allocated_to and status, and neither POST nor PATCH
// could set a tenant-checked account_id, so a lead made on the screen could
// never convert (opportunities.customer_id is NOT NULL). account_id and
// allocated_to are bare FKs written by the service role, so each must be
// checked against the caller's tenant: another tenant's customer, or a user
// who is not an approved member, is refused and nothing is written.

import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => {
  const tables = {};
  const calls = [];
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  let idc = 0;
  const from = (table) => {
    if (!tables[table]) tables[table] = [];
    const filters = [];
    let op = "select";
    let payload = null;
    // Postgres refuses a non-uuid against a uuid column with 22P02. The
    // customers rows here use uuids, as the real table does.
    let castError = null;
    const rows = () => tables[table].filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      calls.push({ table, op });
      if (castError) return { data: [], error: castError };
      if (op === "insert") {
        const out = [];
        for (const p of Array.isArray(payload) ? payload : [payload]) {
          const row = { id: table + "-" + (++idc), ...clone(p) };
          tables[table].push(row);
          out.push(clone(row));
        }
        return { data: out };
      }
      if (op === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, clone(payload)));
        return { data: hit.map(clone) };
      }
      return { data: rows().map(clone) };
    };
    const q = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (c, v) => {
        if (table === "customers" && c === "id" && !/^[0-9a-f-]{36}$/i.test(String(v))) {
          castError = { code: "22P02", message: "invalid input syntax for type uuid: \"" + v + "\"" };
        }
        filters.push((r) => r[c] === v);
        return q;
      },
      insert: (p) => { op = "insert"; payload = p; return q; },
      update: (p) => { op = "update"; payload = p; return q; },
      single: async () => {
        const r = exec();
        return r.data[0] ? { data: r.data[0], error: null } : { data: null, error: { message: "no rows" } };
      },
      maybeSingle: async () => {
        const r = exec();
        return { data: r.data[0] || null, error: r.error || null };
      },
      then: (resolve, reject) => {
        try { const r = exec(); resolve({ data: r.data || null, error: null }); } catch (e) { reject(e); }
      },
    };
    return q;
  };
  const users = {};
  const auth = { admin: { getUserById: async (id) => ({ data: { user: users[id] || null } }) } };
  return {
    tables,
    calls,
    users,
    from,
    auth,
    reset() { for (const k of Object.keys(tables)) delete tables[k]; for (const k of Object.keys(users)) delete users[k]; calls.length = 0; idc = 0; },
    seed(t, list) { tables[t] = list.map(clone); },
  };
});

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "11111111-1111-4111-8111-111111111111" }, tenantId: "t-1", role: "sales_engineer" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => ({ from: H.from, auth: H.auth }) }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const { recordAudit } = await import("../api/_lib/audit.js");
const handler = (await import("../api/sales/leads.js")).default;

const call = async (method, body, query = {}) => {
  let status = 200;
  let sent = "";
  const res = {
    setHeader: () => {},
    status(c) { status = c; return res; },
    send(p) { sent = p; return res; },
    json(o) { sent = JSON.stringify(o); return res; },
    end() { return res; },
  };
  await handler({ method, headers: {}, query, url: "/api/sales/leads", body }, res);
  return { status, body: sent ? JSON.parse(sent) : null };
};

const ME = "11111111-1111-4111-8111-111111111111";
const REP = "22222222-2222-4222-8222-222222222222";
const PENDING = "33333333-3333-4333-8333-333333333333";
const OUTSIDER = "44444444-4444-4444-8444-444444444444";
const CUST = "aaaaaaaa-0000-4000-8000-000000000001";
const CUST_T2 = "bbbbbbbb-0000-4000-8000-000000000002";

const LEAD = {
  id: "lead-1",
  tenant_id: "t-1",
  status: "QUALIFIED",
  company_name: "Kestrel Fabrication",
  lead_source: "Trade show",
  account_id: null,
  allocated_to: null,
  budget_estimate: 250000,
};

beforeEach(() => {
  H.reset();
  H.seed("customers", [
    { id: CUST, tenant_id: "t-1", customer_name: "Kestrel Fabrication Pvt Ltd" },
    { id: CUST_T2, tenant_id: "t-2", customer_name: "Other tenant's customer" },
  ]);
  H.seed("tenant_members", [
    { tenant_id: "t-1", user_id: ME, status: "approved" },
    { tenant_id: "t-1", user_id: REP, status: "approved" },
    { tenant_id: "t-1", user_id: PENDING, status: "pending" },
    { tenant_id: "t-2", user_id: OUTSIDER, status: "approved" },
  ]);
  H.seed("leads", [LEAD, { ...LEAD, id: "lead-t2", tenant_id: "t-2", company_name: "Not ours", account_id: CUST_T2 }]);
  H.seed("opportunities", []);
  H.users[REP] = { id: REP, email: "rep@example.test", user_metadata: { name: "Priya Rao" } };
  vi.mocked(recordAudit).mockClear();
});

describe("GET /api/sales/leads", () => {
  it("returns this tenant's leads with the owner's name", async () => {
    H.tables.leads[0].allocated_to = REP;

    const r = await call("GET");

    expect(r.status).toBe(200);
    expect(r.body.leads).toHaveLength(1);
    expect(r.body.leads[0]).toMatchObject({ company_name: "Kestrel Fabrication", allocated_to: REP, allocated_to_name: "Priya Rao" });
  });
});

describe("POST /api/sales/leads", () => {
  it("writes the real columns, including the owner, the status and the account", async () => {
    const r = await call("POST", {
      company_name: "Heron Castings",
      lead_source: "Referral",
      status: "CONTACTED",
      allocated_to: REP,
      account_id: CUST,
      budget_estimate: 1200000,
    });

    expect(r.status).toBe(201);
    const row = H.tables.leads.find((l) => l.company_name === "Heron Castings");
    expect(row).toMatchObject({
      tenant_id: "t-1",
      lead_source: "Referral",
      status: "CONTACTED",
      allocated_to: REP,
      account_id: CUST,
      budget_estimate: 1200000,
    });
  });

  it("refuses another tenant's customer as the account, and writes nothing", async () => {
    const r = await call("POST", { company_name: "Heron Castings", account_id: CUST_T2 });

    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("account_id is not a customer of this tenant");
    expect(H.tables.leads).toHaveLength(2);
    expect(H.calls.filter((c) => c.table === "leads" && c.op === "insert")).toEqual([]);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("refuses an account id that is not a uuid (400, not a 500)", async () => {
    const r = await call("POST", { company_name: "Heron Castings", account_id: "Kestrel" });

    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("account_id is not a customer of this tenant");
    expect(H.tables.leads).toHaveLength(2);
  });

  it("refuses an owner who is not an approved member of this tenant", async () => {
    for (const who of [OUTSIDER, PENDING, "Priya"]) {
      const r = await call("POST", { company_name: "Heron Castings", allocated_to: who });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe("allocated_to must be an approved member of this tenant");
    }
    expect(H.tables.leads).toHaveLength(2);
  });

  it("does not create a lead as CONVERTED (only the convert action does that)", async () => {
    const r = await call("POST", { company_name: "Heron Castings", status: "CONVERTED" });

    expect(r.status).toBe(400);
    expect(H.tables.leads).toHaveLength(2);
  });
});

describe("PATCH /api/sales/leads", () => {
  it("links this tenant's customer and renames the lead", async () => {
    const r = await call("PATCH", { id: "lead-1", account_id: CUST, lead_source: "Inbound", company_name: "Kestrel Fab" });

    expect(r.status).toBe(200);
    expect(H.tables.leads.find((l) => l.id === "lead-1")).toMatchObject({ account_id: CUST, lead_source: "Inbound", company_name: "Kestrel Fab" });
  });

  it("refuses another tenant's customer, and leaves the lead as it was", async () => {
    const r = await call("PATCH", { id: "lead-1", account_id: CUST_T2 });

    expect(r.status).toBe(400);
    expect(H.tables.leads.find((l) => l.id === "lead-1")).toEqual(LEAD);
    expect(H.calls.filter((c) => c.table === "leads" && c.op === "update")).toEqual([]);
  });

  it("converts onto the lead's own account once one is linked", async () => {
    await call("PATCH", { id: "lead-1", account_id: CUST });

    const r = await call("PATCH", { id: "lead-1", convert_to_opportunity: true });

    expect(r.status).toBe(200);
    expect(H.tables.opportunities).toEqual([expect.objectContaining({
      tenant_id: "t-1",
      customer_id: CUST,
      related_lead_id: "lead-1",
      opportunity_name: "From lead: Kestrel Fabrication",
      owner_id: ME,
    })]);
    const lead = H.tables.leads.find((l) => l.id === "lead-1");
    expect(lead.status).toBe("CONVERTED");
    expect(lead.converted_opportunity_id).toBe(H.tables.opportunities[0].id);
  });

  it("refuses to convert a lead with no account, and opens no opportunity", async () => {
    const r = await call("PATCH", { id: "lead-1", convert_to_opportunity: true });

    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe("Link a customer account to this lead before converting it");
    expect(H.tables.opportunities).toEqual([]);
    expect(H.tables.leads.find((l) => l.id === "lead-1").status).toBe("QUALIFIED");
  });

  it("answers 404 for another tenant's lead, and opens no opportunity for it", async () => {
    const r = await call("PATCH", { id: "lead-t2", convert_to_opportunity: true, account_id: CUST });

    expect(r.status).toBe(404);
    expect(H.tables.opportunities).toEqual([]);
    expect(H.tables.leads.find((l) => l.id === "lead-t2")).toMatchObject({ status: "QUALIFIED", account_id: CUST_T2 });
  });
});
