// The kanban card read customer_name, grand_total and line_count, which
// GET /api/orders does not return: the customer comes under the `customer`
// embed and the totals inside result.salesOrder. Every card showed a blank
// customer and no value.
//
// This test puts the REAL orders GET handler behind the screen's
// orders.list (screen -> real client -> handler), over a small in-memory
// table set that also answers the list's customer embed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, any>>> }));

vi.mock("../../api/_lib/supabase.js", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let cols = "*";
    const shape = (r: any) => {
      const out = { ...r };
      if (cols.includes("customer:customer_id(")) {
        const c = (db.tables.customers || []).find((x) => x.id === r.customer_id);
        out.customer = c ? { customer_name: c.customer_name, state_code: c.state_code } : null;
      }
      return out;
    };
    const q: any = {
      select: (c?: string) => { if (c) cols = c; return q; },
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      // The stage evidence: the tenant's mode and the linked ERP sales orders.
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
      maybeSingle: () => Promise.resolve({ data: (db.tables[table] || []).filter((r) => filters.every((f) => f(r)))[0] || null, error: null }),
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: (db.tables[table] || []).filter((r) => filters.every((f) => f(r))).map(shape), error: null }),
    };
    return q;
  };
  return { serviceClient: () => ({ from }), userClient: () => ({ from }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => ({ user: { id: "u-se" }, tenantId: "t-1", role: "sales_engineer" })),
}));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));

const ordersHandler = (await import("../../api/orders/index.js")).default;

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before installBackend swaps in a stub.
const realClient = (window as any).AnvilBackend;

const serverFetch = vi.fn(async (url: string, init: { method: string }) => {
  let status = 200;
  let sent = "";
  const res: any = {
    setHeader: () => {},
    status(c: number) { status = c; return res; },
    send(p: string) { sent = p; return res; },
    end() { return res; },
  };
  const u = new URL(url);
  await ordersHandler({ method: init.method, headers: {}, query: Object.fromEntries(u.searchParams.entries()), url: u.pathname }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const CUST = "0ccccccc-0000-4000-8000-000000000003";

beforeEach(() => {
  db.tables = {
    customers: [{ id: CUST, tenant_id: "t-1", customer_name: "Heron Castings", state_code: "27" }],
    orders: [{
      id: "o-1", tenant_id: "t-1", po_number: "PO-4471", status: "PENDING_REVIEW", customer_id: CUST,
      created_at: new Date().toISOString(),
      result: { salesOrder: { grandTotal: 120000, lineItems: [{ partNumber: "TIP-16" }, { partNumber: "TIP-18" }, { partNumber: "NOZ-22" }] } },
    }],
  };
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  installBackend({ orders: { list: (p: unknown) => realClient.orders.list(p) } });
  installRbac("sales_engineer");
});

afterEach(() => {
  vi.unstubAllGlobals();
  realClient.setConfig(null);
});

describe("PipelineKanban card", () => {
  it("shows the customer's name, the order total and the line count from the orders list", async () => {
    const mod = await import("./pipeline-kanban");
    renderScreen(mod.default);

    const card = within((await screen.findByText("PO-4471")).closest("a") as HTMLElement);
    expect(card.getByText("Heron Castings")).toBeTruthy();
    expect(card.getByText("₹ 120k")).toBeTruthy();
    expect(card.getByText("3 lines")).toBeTruthy();
  });
});
