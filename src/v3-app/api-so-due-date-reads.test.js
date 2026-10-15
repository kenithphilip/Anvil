// The SO PDF and the Excel export each read the committed date and the
// schedule with their own select lists (plan PR 10). The in-memory Supabase
// applies those lists, so a column a handler forgets to select reads back
// undefined and the due date falls through. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as XLSX from "xlsx";
import { createMemoryDb } from "./test-memory-supabase";

const H = vi.hoisted(() => ({ db: null, rendered: [] }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => ({ user: { id: "u-1" }, tenantId: "t-due", role: "admin" })) };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: vi.fn(async () => {}), recordEvent: vi.fn(async () => {}) }));
vi.mock("../api/_lib/pdf-renderer.js", () => ({
  renderSalesOrder: vi.fn(async (data) => { H.rendered.push(data); return Buffer.from("%PDF due"); }),
}));

const { default: exportHandler } = await import("../api/orders/export.js");
const { default: soPdfHandler } = await import("../api/orders/so_pdf.js");

const res = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  status(c) { this.statusCode = c; return this; },
  json(o) { this.body = o; return this; },
  send(p) { this.body = p; return this; },
  end(p) { if (p != null) this.body = p; return this; },
});

beforeEach(() => {
  H.rendered = [];
  H.db = createMemoryDb({
    orders: [{
      id: "ord-due", tenant_id: "t-due", status: "DRAFT", po_number: "PO-DUE-R", customer_id: null, created_at: "2026-10-01",
      committed_delivery_date: "2026-12-05", rule_findings: [],
      result: { salesOrder: { lineItems: [{ part_no: "DR-1", qty: 1, unitPrice: 5 }, { part_no: "DR-2", qty: 1, unitPrice: 5 }] } },
    }],
    order_schedule_lines: [{ tenant_id: "t-due", order_id: "ord-due", line_index: 1, scheduled_date: "2026-11-02" }],
    tenant_settings: [],
  }, {}, { project: true });
});

describe("the committed date and the schedule reach both documents", () => {
  it("the Excel export", async () => {
    const r = res();
    await exportHandler({ method: "GET", headers: {}, query: { orderId: "ord-due" } }, r);
    expect(r.statusCode).toBe(200);
    const aoa = XLSX.utils.sheet_to_json(XLSX.read(r.body, { type: "buffer" }).Sheets["Sales Order"], { header: 1, blankrows: false, defval: "" });
    const head = aoa.findIndex((row) => row[0] === "#");
    const col = aoa[head].indexOf("Due On");
    expect([aoa[head + 1][col], aoa[head + 2][col]]).toEqual(["05-Dec-26", "02-Nov-26"]);
  });

  it("the SO PDF", async () => {
    const r = res();
    await soPdfHandler({ method: "GET", headers: {}, query: { orderId: "ord-due" } }, r);
    expect(r.statusCode).toBe(200);
    expect(H.rendered[0].items.map((it) => it.dueOn)).toEqual(["05-Dec-26", "02-Nov-26"]);
  });
});
