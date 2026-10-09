// The Internal SOs list was always empty: the screen read
// internal_sales_orders / rows, and GET /api/sales/internal_so returns
// { internalSos } (#547 PR 24's screen fix). The rows also read reference
// and iso_lines (the API has iso_number and lines), the customer picker read
// rows (GET /api/customers returns { customers }), and the create sent
// reference, so POST answered 400 "iso_number required" every time.
//
// These tests put the REAL internal_so handler behind the screen's
// listInternalSos and createInternalSo (screen -> real client -> handler).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, any>>> }));

vi.mock("../../api/_lib/supabase.js", () => {
  let idc = 0;
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    let op = "select";
    let payload: any = null;
    const rows = () => (db.tables[table] || []).filter((r) => filters.every((f) => f(r)));
    const exec = () => {
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload];
        const out = list.map((p) => ({ id: table + "-new-" + (++idc), created_at: "2026-10-09T00:00:00.000Z", ...JSON.parse(JSON.stringify(p)) }));
        (db.tables[table] = db.tables[table] || []).push(...out);
        return out.map((r) => ({ ...r }));
      }
      return rows().map((r) => ({ ...r }));
    };
    const q: any = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return q; },
      insert: (p: any) => { op = "insert"; payload = p; return q; },
      single: async () => { const d = exec(); return d[0] ? { data: d[0], error: null } : { data: null, error: { message: "no rows" } }; },
      then: (resolve: (v: unknown) => void) => resolve({ data: exec(), error: null }),
    };
    return q;
  };
  return { serviceClient: () => ({ from }), userClient: () => ({ from }) };
});
vi.mock("../../api/_lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveContext: vi.fn(async () => ({ user: { id: "u-op" }, tenantId: "t-1", role: "operator" })),
}));
vi.mock("../../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}) }));

const isoHandler = (await import("../../api/sales/internal_so.js")).default;

// test-setup.ts ran the client IIFE before this file loaded, so this is the
// real client, captured before installBackend swaps in a stub.
const realClient = (window as any).AnvilBackend;

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
  await isoHandler({ method: init.method, headers: {}, query, url: "/api/sales/internal_so", body: init.body ? JSON.parse(init.body) : undefined }, res);
  return { ok: status < 400, status, text: async () => sent };
});

const CUST = "0ccccccc-0000-4000-8000-000000000003";

beforeEach(() => {
  db.tables = {
    internal_sales_orders: [{
      id: "iso-1", tenant_id: "t-1", iso_type: "FOC_SUPPLY", iso_number: "ISO-2026-0007",
      customer_id: CUST, status: "APPROVED", created_at: "2026-10-01T00:00:00.000Z",
    }],
    internal_so_lines: [
      { id: "ln-1", tenant_id: "t-1", internal_so_id: "iso-1", part_no: "TIP-16", qty: 4 },
      { id: "ln-2", tenant_id: "t-1", internal_so_id: "iso-1", part_no: "TIP-18", qty: 2 },
    ],
  };
  realClient.setConfig({ url: "https://api.test", tenantId: "t-1" });
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  installBackend({
    sales: {
      listInternalSos: () => realClient.sales.listInternalSos(),
      createInternalSo: (p: unknown) => realClient.sales.createInternalSo(p),
    },
    // The real response shape of GET /api/customers.
    customers: { list: vi.fn(async () => ({ customers: [{ id: CUST, customer_name: "Heron Castings" }], profiles: {} })) },
  });
  installRbac("operator");
  (window as any).notifySuccess = vi.fn();
  (window as any).notifyError = vi.fn();
  window.location.hash = "#/internal";
});

afterEach(() => {
  vi.unstubAllGlobals();
  realClient.setConfig(null);
});

const renderIsos = async () => {
  const mod = await import("./internal-sos");
  return renderScreen(mod.default);
};

describe("Internal SOs: the list reads internalSos", () => {
  it("shows each internal SO's number, customer and line count", async () => {
    await renderIsos();

    const row = within((await screen.findByText("ISO-2026-0007")).closest("tr") as HTMLElement);
    expect(row.getByText("Heron Castings")).toBeTruthy();
    expect(row.getByText("2")).toBeTruthy();
    expect(row.getByText("approved")).toBeTruthy();
    expect(screen.queryByText("No internal SOs yet.")).toBeNull();
  });
});

describe("Internal SOs: create", () => {
  it("creates an Expected PO internal SO with its lines, and the list shows it", async () => {
    window.location.hash = "#/internal?new=1&type=EXPECTED_PO";
    await renderIsos();
    await screen.findByRole("option", { name: "Heron Castings" });

    fireEvent.change(screen.getByLabelText("ISO number *"), { target: { value: "ISO-2026-0008" } });
    fireEvent.change(screen.getByLabelText("Customer *"), { target: { value: CUST } });
    fireEvent.change(screen.getByLabelText("Approximate cost INR (optional)"), { target: { value: "45000" } });
    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Supply ahead of the customer PO" } });
    fireEvent.change(screen.getByLabelText("Line 1 part number"), { target: { value: "NOZ-22" } });
    fireEvent.change(screen.getByLabelText("Line 1 qty"), { target: { value: "6" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });

    await waitFor(() => expect(db.tables.internal_sales_orders).toHaveLength(2));
    const created = db.tables.internal_sales_orders[1];
    expect(created).toMatchObject({
      tenant_id: "t-1",
      iso_type: "EXPECTED_PO",
      iso_number: "ISO-2026-0008",
      customer_id: CUST,
      approximate_cost_inr: 45000,
      purpose: "Supply ahead of the customer PO",
      status: "DRAFT",
    });
    expect(db.tables.internal_so_lines.filter((l) => l.internal_so_id === created.id)).toEqual([
      expect.objectContaining({ tenant_id: "t-1", part_no: "NOZ-22", qty: 6, uom: "Nos" }),
    ]);
    expect((window as any).notifyError).not.toHaveBeenCalled();
    await screen.findByText("ISO-2026-0008");
  });
});
