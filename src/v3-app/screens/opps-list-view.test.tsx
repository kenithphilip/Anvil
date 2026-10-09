// The opportunities screen reads what GET /api/sales/opportunities returns.
//
// The screen read title, customer_name, value, owner and expected_close_date.
// The API sent opportunity_name, customer_id, amount_inr, owner_id and
// close_date, so name, value, weighted value and owner were blank. The KPI
// tiles counted DISCOVERY, DEMO, QUOTE, NEGOTIATION and WON, which are not
// stages, so every tile but Total read 0. The operator probability is stored
// as a percent and was multiplied by 100 (the default 50 showed as 5000%).
//
// These tests run the REAL handler against an in-memory Supabase and feed its
// response to the screen, so a fixture cannot drift from the API again.
// Every name and id here is invented.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor, fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const DB = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  users: {} as Record<string, any>,
  failRead: {} as Record<string, any>,
  ctx: null as any,
}));

vi.mock("../../api/_lib/auth.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => DB.ctx) };
});

const makeSvc = () => ({
  auth: { admin: { getUserById: async (id: string) => ({ data: { user: DB.users[id] || null }, error: null }) } },
  from(table: string) {
    const filters: ((r: any) => boolean)[] = [];
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const run = () => {
      if (DB.failRead[table]) return { data: null, error: DB.failRead[table] };
      let out = (DB.tables[table] || []).filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }));
      if (order) {
        const { col, asc } = order;
        out.sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit != null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b; },
      lte: (c: string, v: any) => { filters.push((r) => r[c] <= v); return b; },
      order: (col: string, opts: any) => { order = { col, asc: !opts || opts.ascending !== false }; return b; },
      limit: (n: number) => { limit = n; return b; },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  },
});
vi.mock("../../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));

const callGet = async (query: Record<string, string> = {}) => {
  const handler = (await import("../../api/sales/opportunities.js")).default;
  let body: any = null;
  const res: any = {
    statusCode: 200,
    setHeader() {}, status(c: number) { this.statusCode = c; return this; },
    json(o: any) { body = o; return this; }, send(p: any) { body = typeof p === "string" ? JSON.parse(p) : p; return this; },
    end() { return this; },
  };
  await handler({ method: "GET", headers: {}, query, url: "/api/sales/opportunities" }, res);
  return { status: res.statusCode, body };
};

const T = "t-1";
const OPP = (id: string, over: any) => ({
  id, tenant_id: T, customer_id: "c-axle", stage: "QUALIFICATION", amount_inr: null,
  probability: 50, owner_id: null, close_date: null, product_summary: null, ai_probability: null,
  created_at: "2026-09-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

const seed = () => {
  DB.ctx = { user: { id: "u-ravi" }, tenantId: T, role: "sales_engineer" };
  DB.failRead = {};
  DB.users = {
    "u-ravi": { id: "u-ravi", email: "ravi@fixture.test", user_metadata: { name: "Ravi Fixture" } },
    "u-meera": { id: "u-meera", email: "meera@fixture.test", user_metadata: {} },
  };
  DB.tables = {
    customers: [
      { id: "c-axle", tenant_id: T, customer_name: "Fixture Axle Works" },
      { id: "c-press", tenant_id: T, customer_name: "Fixture Press Shop" },
      // Same id, another tenant: its name must never reach this tenant.
      { id: "c-foreign", tenant_id: "t-2", customer_name: "Another Tenant Buyer" },
    ],
    opportunities: [
      OPP("o-1", { opportunity_name: "Line 4 retrofit", stage: "RFQ", amount_inr: 200000, owner_id: "u-ravi", close_date: "2026-11-30", updated_at: "2026-10-06T00:00:00Z" }),
      OPP("o-2", { opportunity_name: "Weld gun spares", customer_id: "c-press", stage: "QUALIFICATION", amount_inr: 100000, probability: 20, updated_at: "2026-10-05T00:00:00Z" }),
      OPP("o-3", { opportunity_name: "Press line cell", stage: "NEGOTIATION_REVIEW", amount_inr: 1000000, owner_id: "u-meera", updated_at: "2026-10-04T00:00:00Z" }),
      OPP("o-4", { opportunity_name: "Robot dress packs", customer_id: "c-press", stage: "CLOSE_WON", amount_inr: 250000, owner_id: "u-ravi", updated_at: "2026-10-03T00:00:00Z" }),
      OPP("o-5", { opportunity_name: "Old tender", stage: "CLOSE_LOST", amount_inr: 300000, lost_reason: "PRICE_HIGH", updated_at: "2026-10-02T00:00:00Z" }),
      OPP("o-6", { opportunity_name: "Fixture rework", customer_id: "c-foreign", stage: "INTERNAL_PROPOSAL", amount_inr: 100000, updated_at: "2026-10-01T00:00:00Z" }),
      { ...OPP("o-x", { opportunity_name: "Not this tenant's deal", stage: "RFQ", amount_inr: 9900000 }), tenant_id: "t-2" },
    ],
  };
};

const mount = async (hash: string) => {
  const { body } = await callGet();
  installBackend({ sales: { listOpportunities: vi.fn(async () => body) } });
  window.location.hash = hash;
  const { default: Opps } = await import("./opps");
  const r = renderScreen(Opps);
  await waitFor(() => expect(r.container.textContent).toContain("Line 4 retrofit"));
  return r;
};

const kpi = (c: HTMLElement, label: string) => {
  const tile = Array.from(c.querySelectorAll(".kpi")).find((k) => k.querySelector(".lbl")?.textContent === label);
  return { v: tile?.querySelector(".v")?.textContent, d: tile?.querySelector(".d")?.textContent };
};
const listRows = (c: HTMLElement) => Array.from(c.querySelectorAll("table.tbl tbody tr"))
  .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent));
const kv = (c: HTMLElement, key: string) => {
  const dt = Array.from(c.querySelectorAll("dl.kv dt")).find((d) => d.textContent === key);
  return dt?.nextElementSibling?.textContent;
};

beforeEach(() => {
  seed();
  installRbac("sales_engineer");
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => { window.location.hash = ""; });

describe("GET /api/sales/opportunities names the customer and the owner", () => {
  it("returns this tenant's rows only, each with customer_name and owner_name", async () => {
    const { status, body } = await callGet();
    expect(status).toBe(200);
    const byId = new Map(body.opportunities.map((o: any) => [o.id, o]));
    expect([...byId.keys()].sort()).toEqual(["o-1", "o-2", "o-3", "o-4", "o-5", "o-6"]);
    expect(byId.get("o-1")).toMatchObject({ customer_name: "Fixture Axle Works", owner_name: "Ravi Fixture", amount_inr: 200000, probability: 50 });
    // No display name in the metadata: the email is the name.
    expect(byId.get("o-3")).toMatchObject({ owner_name: "meera@fixture.test" });
    expect(byId.get("o-2")).toMatchObject({ customer_name: "Fixture Press Shop", owner_id: null, owner_name: null });
  });

  it("does not name a customer that belongs to another tenant", async () => {
    const { body } = await callGet();
    const o6 = body.opportunities.find((o: any) => o.id === "o-6");
    expect(o6.customer_id).toBe("c-foreign");
    expect(o6.customer_name).toBeNull();
  });

  it("still returns the list when the customer lookup fails", async () => {
    DB.failRead.customers = { message: "statement timeout" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { status, body } = await callGet();
    warn.mockRestore();
    expect(status).toBe(200);
    expect(body.opportunities).toHaveLength(6);
    expect(body.opportunities.every((o: any) => o.customer_name === null)).toBe(true);
  });
});

describe("the KPI tiles count the real stages", () => {
  it("counts open, early, quoting, negotiation, won and lost from the data", async () => {
    const { container } = await mount("#/opps");
    // Open: RFQ, QUALIFICATION, NEGOTIATION_REVIEW, INTERNAL_PROPOSAL.
    expect(kpi(container, "Open")).toEqual({ v: "4", d: "₹ 14.0 L open value" });
    // 0.45 x 2L + 0.05 x 1L + 0.85 x 10L + 0.55 x 1L = 10L. The won deal is not pipeline.
    expect(kpi(container, "Weighted ₹").v).toBe("₹ 10.0 L");
    expect(kpi(container, "Early stage").v).toBe("1");
    expect(kpi(container, "Quoting")).toEqual({ v: "2", d: "1 in negotiation" });
    expect(kpi(container, "Won")).toEqual({ v: "₹ 250k", d: "1 won · 1 lost" });
  });
});

describe("the list view", () => {
  it("shows the name, customer, value, weighted value and owner the API sent", async () => {
    const { container } = await mount("#/opps?view=list");
    const rows = listRows(container);
    const line4 = rows.find((r) => r[0] === "Line 4 retrofit");
    expect(line4?.slice(0, 5)).toEqual(["Line 4 retrofit", "Fixture Axle Works", "rfq", "₹ 200k", "₹ 90k"]);
    expect(line4?.[6]).toBe("Ravi Fixture");
    const spares = rows.find((r) => r[0] === "Weld gun spares");
    expect(spares?.[1]).toBe("Fixture Press Shop");
    expect(spares?.[6]).toBe("unassigned");
    // The foreign customer gets no name; its id prefix is still shown.
    expect(rows.find((r) => r[0] === "Fixture rework")?.[1]).toBe("c-foreig");
  });

  it("sorts by value, biggest first, and by stage in pipeline order", async () => {
    const { container, getByTitle } = await mount("#/opps?view=list");
    expect(listRows(container).map((r) => r[0]).slice(0, 4))
      .toEqual(["Press line cell", "Old tender", "Robot dress packs", "Line 4 retrofit"]);
    // A newly chosen column starts descending: furthest along first.
    fireEvent.click(getByTitle("Sort by stage"));
    expect(listRows(container).map((r) => r[2]))
      .toEqual(["closed lost", "closed won", "negotiation review", "internal proposal", "rfq", "qualification"]);
    fireEvent.click(getByTitle("Sort by stage"));
    expect(listRows(container)[0][2]).toBe("qualification");
  });

  it("keeps the view in the hash and opens a row in the detail card", async () => {
    const { container } = await mount("#/opps?view=list");
    const tr = Array.from(container.querySelectorAll("table.tbl tbody tr")).find((r) => r.textContent?.includes("Line 4 retrofit"))!;
    fireEvent.keyDown(tr, { key: "Enter" });
    expect(window.location.hash).toBe("#/opps?id=o-1");
  });
});

describe("the board", () => {
  it("puts each card in its stage column with the customer, value and owner", async () => {
    const { container } = await mount("#/opps");
    const card = Array.from(container.querySelectorAll(".kard")).find((k) => k.querySelector(".ti")?.textContent === "Press line cell")!;
    expect(card.querySelector(".meta")?.textContent).toBe("Fixture Axle Works · ₹ 10.0 L · meera@fixture.test");
    const col = card.closest(".col");
    expect(col?.querySelector(".col-h .t")?.textContent).toBe("Negotiation review");
  });
});

describe("the detail card", () => {
  it("shows the operator probability once, as a percent, and the close date", async () => {
    const { container } = await mount("#/opps?id=o-1");
    await waitFor(() => expect(kv(container, "Name")).toBe("Line 4 retrofit"));
    expect(kv(container, "Customer")).toBe("Fixture Axle Works");
    expect(kv(container, "Owner")).toBe("Ravi Fixture");
    expect(kv(container, "Value")).toBe("₹ 200k");
    expect(kv(container, "Probability (operator)")).toBe("50%");
    expect(kv(container, "Expected close")).toBe("2026-11-30");
  });

  it("says an unowned opportunity is unassigned", async () => {
    const { container } = await mount("#/opps?id=o-2");
    await waitFor(() => expect(kv(container, "Name")).toBe("Weld gun spares"));
    expect(kv(container, "Owner")).toBe("unassigned");
    expect(kv(container, "Probability (operator)")).toBe("20%");
    expect(kv(container, "Expected close")).toBe("not set");
  });
});
