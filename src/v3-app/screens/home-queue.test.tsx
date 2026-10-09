// My Day read orders.data.rows and audit.data.rows. GET /api/orders returns
// { orders } and GET /api/audit returns { events }, so the queue and the
// activity stream were always empty.
//
// These tests put the REAL orders and audit GET handlers behind the screen's
// orders.list and audit.list (screen -> real client -> handler), over a small
// in-memory table set that also answers the orders list's customer embed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, any>>> }));

vi.mock("../../api/_lib/supabase.js", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let cols = "*";
    // The embed the orders list asks for: customer:customer_id(customer_name, state_code).
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
const auditHandler = (await import("../../api/audit/index.js")).default;

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
  const handler = u.pathname === "/api/audit" ? auditHandler : ordersHandler;
  await handler({ method: init.method, headers: {}, query: Object.fromEntries(u.searchParams.entries()), url: u.pathname }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const CUST = "0ccccccc-0000-4000-8000-000000000003";
const NOW = new Date().toISOString();

beforeEach(() => {
  db.tables = {
    customers: [{ id: CUST, tenant_id: "t-1", customer_name: "Heron Castings", state_code: "27" }],
    orders: [
      { id: "o-1", tenant_id: "t-1", po_number: "PO-4471", status: "PENDING_REVIEW", customer_id: CUST, created_at: NOW, updated_at: NOW,
        result: { salesOrder: { grandTotal: 120000 } } },
      { id: "o-2", tenant_id: "t-1", po_number: "PO-4472", status: "DRAFT", customer_id: CUST, created_at: NOW, updated_at: NOW, result: {} },
      { id: "o-3", tenant_id: "t-1", po_number: "PO-4400", status: "RECONCILED", customer_id: CUST, created_at: NOW, updated_at: NOW, result: {} },
      { id: "o-9", tenant_id: "t-2", po_number: "PO-OTHER", status: "DRAFT", customer_id: null, created_at: NOW, updated_at: NOW, result: {} },
    ],
    audit_events: [
      { id: "ev-1", tenant_id: "t-1", action: "quote_sent", object_type: "quote", object_id: "q1234567-aaaa", created_at: NOW },
    ],
  };
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  installBackend({
    orders: { list: (p: unknown) => realClient.orders.list(p) },
    audit: { list: (p: unknown) => realClient.audit.list(p) },
  });
  installRbac("sales_engineer");
});

afterEach(() => {
  vi.unstubAllGlobals();
  realClient.setConfig(null);
});

const renderHome = async () => {
  const mod = await import("./home");
  return renderScreen(mod.default);
};

describe("My Day: the queue reads { orders }", () => {
  it("lists this tenant's open orders with their customer and value", async () => {
    await renderHome();

    const row = within((await screen.findByText("PO-4471")).closest("tr") as HTMLElement);
    expect(row.getByText("Heron Castings")).toBeTruthy();
    expect(row.getByText("₹ 120k")).toBeTruthy();
    expect(screen.getAllByText("PO-4472").length).toBeGreaterThan(0);
    // Reconciled orders have left the queue; another tenant's never came.
    expect(screen.queryByText("PO-4400")).toBeNull();
    expect(screen.queryByText("PO-OTHER")).toBeNull();
    const queue = screen.getByText("My queue").parentElement as HTMLElement;
    expect(queue.querySelector(".v")?.textContent).toBe("2");
    expect(screen.queryByText(/Nothing in your queue/)).toBeNull();
  });
});

describe("My Day: the activity stream reads { events }", () => {
  it("shows the latest audit event as plain text", async () => {
    await renderHome();

    expect(await screen.findByText("quote_sent · quote q1234567")).toBeTruthy();
    expect(screen.queryByText("No recent activity.")).toBeNull();
  });
});
