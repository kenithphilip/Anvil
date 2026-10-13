// The Leads screen read and wrote field names the leads table does not have:
// the list showed r.name, r.source, r.owner and r.estimated_value, so every
// row was an id slice and blanks, and the create form sent a free-text owner.
// These tests put the REAL /api/sales/leads handler behind the screen's
// listLeads, createLead and updateLead (screen -> real client -> handler),
// over a small in-memory table set, so the shapes are the server's own.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, any>>>,
  users: {} as Record<string, any>,
}));

vi.mock("../../api/_lib/supabase.js", () => {
  let idc = 0;
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let op = "select";
    let payload: any = null;
    const rows = () => (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (op === "insert") {
        const row = { id: table + "-new-" + (++idc), ...JSON.parse(JSON.stringify(payload)) };
        (db.tables[table] = db.tables[table] || []).push(row);
        return [{ ...row }];
      }
      if (op === "update") {
        const hit = rows();
        hit.forEach((r) => Object.assign(r, JSON.parse(JSON.stringify(payload))));
        return hit.map((r) => ({ ...r }));
      }
      return rows().map((r) => ({ ...r }));
    };
    const q: any = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      insert: (p: any) => { op = "insert"; payload = p; return q; },
      update: (p: any) => { op = "update"; payload = p; return q; },
      single: async () => { const d = exec(); return d[0] ? { data: d[0], error: null } : { data: null, error: { message: "no rows" } }; },
      maybeSingle: async () => ({ data: exec()[0] || null, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: exec(), error: null }),
    };
    return q;
  };
  const auth = { admin: { getUserById: async (id: string) => ({ data: { user: db.users[id] || null } }) } };
  return { serviceClient: () => ({ from, auth }), userClient: () => ({ from, auth }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => ({ user: { id: "11111111-1111-4111-8111-111111111111" }, tenantId: "t-1", role: "sales_engineer" })),
}));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const leadsHandler = (await import("../../api/sales/leads.js")).default;

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before installBackend swaps in a stub.
const realClient = (window as any).AnvilBackend;

// fetch, answered by the real handler.
const serverFetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    end() { return res; },
  };
  const query = Object.fromEntries(new URL(url).searchParams.entries());
  await leadsHandler({ method: init.method, headers: {}, query, url: "/api/sales/leads", body: init.body ? JSON.parse(init.body) : undefined }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const REP = "22222222-2222-4222-8222-222222222222";
const CUST = "aaaaaaaa-0000-4000-8000-000000000001";

const LEAD = {
  id: "lead-1",
  tenant_id: "t-1",
  status: "QUALIFIED",
  company_name: "Kestrel Fabrication",
  lead_source: "Trade show",
  allocated_to: REP,
  account_id: null,
  budget_estimate: 250000,
  created_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  db.tables = {
    leads: [{ ...LEAD }],
    customers: [{ id: CUST, tenant_id: "t-1", customer_name: "Kestrel Fabrication Pvt Ltd" }],
    tenant_members: [{ tenant_id: "t-1", user_id: REP, status: "approved" }],
    opportunities: [],
  };
  db.users = { [REP]: { id: REP, email: "rep@example.test", user_metadata: { name: "Priya Rao" } } };
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  installBackend({
    sales: {
      listLeads: () => realClient.sales.listLeads(),
      createLead: (p: unknown) => realClient.sales.createLead(p),
      updateLead: (p: unknown) => realClient.sales.updateLead(p),
    },
    // The real response shapes of GET /api/customers and GET /api/admin/members.
    customers: { list: vi.fn(async () => ({ customers: [{ id: CUST, customer_name: "Kestrel Fabrication Pvt Ltd" }], profiles: {} })) },
    admin: { listMembers: vi.fn(async () => ({ members: [{ user_id: REP, display_name: "Priya Rao", status: "approved", role: "sales_engineer" }] })) },
  });
  installRbac("sales_engineer");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  window.location.hash = "#/leads";
});

afterEach(() => {
  vi.unstubAllGlobals();
  realClient.setConfig(null);
});

const renderLeads = async () => {
  const mod = await import("./leads");
  return renderScreen(mod.default);
};

describe("Leads: the list reads what the API returns", () => {
  it("shows the company, source, owner's name and value of each lead", async () => {
    await renderLeads();

    const cell = await screen.findByText("Kestrel Fabrication");
    const row = within(cell.closest("tr") as HTMLElement);
    expect(row.getByText("Trade show")).toBeTruthy();
    expect(row.getByText("Priya Rao")).toBeTruthy();
    expect(row.getByText("₹ 250k")).toBeTruthy();
  });
});

describe("Leads: create", () => {
  it("writes the company, source, status, owner, account and value to the real columns", async () => {
    await renderLeads();
    await screen.findByText("Kestrel Fabrication");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /New lead/ })); });
    await screen.findByRole("option", { name: "Priya Rao" });
    await screen.findByRole("option", { name: "Kestrel Fabrication Pvt Ltd" });

    fireEvent.change(screen.getByLabelText("Company *"), { target: { value: "Heron Castings" } });
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "Referral" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "CONTACTED" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: REP } });
    fireEvent.change(screen.getByLabelText("Customer account"), { target: { value: CUST } });
    fireEvent.change(screen.getByLabelText("Estimated value (₹)"), { target: { value: "1200000" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "save lead" })); });

    await waitFor(() => expect(db.tables.leads).toHaveLength(2));
    expect(db.tables.leads[1]).toMatchObject({
      tenant_id: "t-1",
      company_name: "Heron Castings",
      lead_source: "Referral",
      status: "CONTACTED",
      allocated_to: REP,
      account_id: CUST,
      budget_estimate: 1200000,
    });
  });
});

describe("Leads: link a customer, then convert", () => {
  it("links the account on a lead that has none, and the convert opens the opportunity on it", async () => {
    window.location.hash = "#/leads?id=lead-1";
    await renderLeads();
    await screen.findByText("not linked");
    await screen.findByRole("option", { name: "Kestrel Fabrication Pvt Ltd" });

    fireEvent.change(screen.getByLabelText("Customer account"), { target: { value: CUST } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Link customer" })); });
    await waitFor(() => expect(db.tables.leads[0].account_id).toBe(CUST));

    // The reloaded list carries the account, so the convert goes through.
    await waitFor(() => expect(screen.queryByText("not linked")).toBeNull());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Convert to opportunity" })); });

    await waitFor(() => expect(db.tables.opportunities).toHaveLength(1));
    expect(db.tables.opportunities[0]).toMatchObject({ tenant_id: "t-1", customer_id: CUST, related_lead_id: "lead-1" });
    expect(db.tables.leads[0].status).toBe("CONVERTED");
  });
});
