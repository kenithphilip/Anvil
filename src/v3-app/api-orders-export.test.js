// GET /api/orders/export — the extracted sales order as an .xlsx.
// Pure builder (buildSalesOrderAoa) + the endpoint over a Supabase fake, with
// the returned workbook round-tripped through the real xlsx dep.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as XLSX from "xlsx";

const H = vi.hoisted(() => ({ store: {} }));

vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-1", role: "admin" })),
  requirePermission: vi.fn(() => {}),
}));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const rows = () => H.store[table] || [];
      const flt = [];
      const b = {
        select() { return b; },
        eq(c, v) { flt.push((r) => r[c] === v); return b; },
        _one() { return Promise.resolve({ data: rows().find((r) => flt.every((f) => f(r))) || null, error: null }); },
        maybeSingle() { return this._one(); },
        single() { return this._one(); },
        then(res) { return Promise.resolve({ data: rows().filter((r) => flt.every((f) => f(r))), error: null }).then(res); },
      };
      return b;
    },
  }),
}));

const { default: handler, buildSalesOrderAoa, filenameFor, toCsv, deFormula } = await import("../api/orders/export.js");

const run = async (query = {}, method = "GET") => {
  const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method, headers: {}, url: "/api/orders/export", query }, res);
  return res;
};

const order = () => ({
  id: "ord-1", tenant_id: "t-1", po_number: "P250432265", customer_id: "c-1",
  payment_terms: "Net 60", created_at: "2026-04-16",
  result: { salesOrder: {
    currency: "INR", payment_terms: "Net 60",
    customer: { name: "HYUNDAI MOTOR INDIA LTD", gstin: "27AAACO8335K1Z5" },
    lineItems: [
      { partNumber: "GD544202503060009", customer_part_number: "AS2-0061", itemName: "ATD NS HEAD ASSY", description: "ATD NS HEAD ASSY", qty: 1, uom: "EA", rate: 45408, amount: 45408, hsn: "8479" },
      { partNumber: "GE450202504010096", customer_part_number: "NWCL-G3", itemName: "COLOR SENSOR ASSY", quantity: 2, uom: "NOS", unitPrice: 166497.1 },
    ],
  } },
});

beforeEach(() => { H.store = { orders: [order()], customers: [{ id: "c-1", tenant_id: "t-1", customer_name: "Hyundai Motor India Ltd" }] }; });

describe("buildSalesOrderAoa", () => {
  it("emits a meta block, the column header, one row per line, and a total", () => {
    const aoa = buildSalesOrderAoa(order());
    expect(aoa[0]).toEqual(["Sales Order (extracted)"]);
    expect(aoa.find((r) => r[0] === "PO Number")).toEqual(["PO Number", "P250432265"]);
    expect(aoa.find((r) => r[0] === "Customer")).toEqual(["Customer", "HYUNDAI MOTOR INDIA LTD"]);
    const headerRow = aoa.find((r) => r[0] === "#");
    expect(headerRow).toEqual(["#", "Part Number", "Customer Part No", "Item Name", "Description", "Qty", "UOM", "Unit Price", "Amount", "HSN"]);
    const hi = aoa.indexOf(headerRow);
    // line 1 uses partNumber/qty/rate/amount aliases
    expect(aoa[hi + 1]).toEqual([1, "GD544202503060009", "AS2-0061", "ATD NS HEAD ASSY", "ATD NS HEAD ASSY", 1, "EA", 45408, 45408, "8479"]);
    // line 2 uses quantity/unitPrice aliases; amount derived = 2 * 166497.1
    expect(aoa[hi + 2][5]).toBe(2);
    expect(aoa[hi + 2][7]).toBe(166497.1);
    expect(aoa[hi + 2][8]).toBeCloseTo(332994.2, 2);
    const totalRow = aoa[aoa.length - 1];
    expect(totalRow[7]).toBe("Total");
    expect(totalRow[8]).toBeCloseTo(45408 + 332994.2, 2);
  });

  it("filename is derived from the PO number, sanitised", () => {
    expect(filenameFor({ po_number: "P250432265" })).toBe("SO_P250432265.xlsx");
    expect(filenameFor({ po_number: "PO/12 34" }, "csv")).toBe("SO_PO_12_34.csv");
  });

  it("does not throw on a bare order (no salesOrder)", () => {
    const aoa = buildSalesOrderAoa({ id: "x" });
    expect(aoa.find((r) => r[0] === "#")).toBeTruthy();
  });
});

describe("GET /api/orders/export", () => {
  it("returns an .xlsx that round-trips to the expected rows", async () => {
    const res = await run({ orderId: "ord-1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml\.sheet/);
    expect(res.headers["content-disposition"]).toContain('filename="SO_P250432265.xlsx"');
    const wb = XLSX.read(res.body, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
    // header + both line parts survived the workbook round-trip
    const flat = JSON.stringify(aoa);
    expect(flat).toContain("GD544202503060009");
    expect(flat).toContain("COLOR SENSOR ASSY");
    expect(flat).toContain("HYUNDAI MOTOR INDIA LTD");
  });

  it("404s an order that is not in the tenant", async () => {
    H.store.orders = [{ ...order(), tenant_id: "t-OTHER" }];
    const res = await run({ orderId: "ord-1" });
    expect(res.statusCode).toBe(404);
  });

  it("400s when orderId is missing", async () => {
    const res = await run({});
    expect(res.statusCode).toBe(400);
  });

  it("405s a non-GET", async () => {
    const res = await run({ orderId: "ord-1" }, "POST");
    expect(res.statusCode).toBe(405);
  });
});

describe("CSV formula-injection guard", () => {
  it("deFormula neutralises leading =,+,-,@ but leaves normal text", () => {
    expect(deFormula('=HYPERLINK("http://evil","x")')).toBe('\'=HYPERLINK("http://evil","x")');
    expect(deFormula("+1")).toBe("'+1");
    expect(deFormula("-cmd")).toBe("'-cmd");
    expect(deFormula("@SUM")).toBe("'@SUM");
    expect(deFormula("ATD NS HEAD ASSY")).toBe("ATD NS HEAD ASSY");
  });

  it("toCsv guards a formula-leading string cell but keeps a numeric -45 as a number", () => {
    const csv = toCsv([["ok", "=1+1", -45, "a,b"]]);
    // the =formula string is prefixed and (because of the leading quote) not
    // wrapped again; the numeric -45 is NOT prefixed; the comma value is quoted.
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("-45");
    expect(csv).not.toContain("'-45");
    expect(csv).toContain('"a,b"');
  });

  it("the .xlsx path stores a formula-looking description as TEXT, not a live formula", async () => {
    H.store.orders[0].result.salesOrder.lineItems[0].description = '=HYPERLINK("http://evil","click")';
    const res = await run({ orderId: "ord-1" });
    const wb = XLSX.read(res.body, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // find the cell holding the injected string and assert it is a string cell
    // (t:'s') with no formula (.f) — SheetJS does not evaluate string cells.
    const cell = Object.values(ws).find((c) => c && c.v === '=HYPERLINK("http://evil","click")');
    expect(cell).toBeTruthy();
    expect(cell.t).toBe("s");
    expect(cell.f).toBeUndefined();
  });
});
