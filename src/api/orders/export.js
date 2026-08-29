// GET /api/orders/export?orderId=...   ->  .xlsx of the EXTRACTED sales order
//
// The reconcile tab shows the sales order Anvil extracted from the PO
// (result.salesOrder: a customer block + line items). This hands the operator
// that same data as a spreadsheet — a meta block (who / terms) then the
// line-item table — so they can drop it into their own workbook, mail it, or
// key it into an ERP that has no import.
//
// Server-side generation, reusing the bundled SheetJS (xlsx) dep the Excel
// INGESTION path already uses. A CSV fallback keeps the export working if that
// optional dep is ever absent in a deploy.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const first = (...xs) => { for (const x of xs) if (x !== undefined && x !== null && x !== "") return x; return null; };

// A line-item field is attacker-influenced (it comes off the customer's PO), so
// a string that opens with a formula trigger would execute as a formula when
// the recipient opens the file. The .xlsx path is safe -- SheetJS writes a JS
// string as a TEXT cell that Excel never re-evaluates -- but a raw CSV cell
// does get parsed, so neutralise leading =,+,-,@ (and tab/CR) there. Applied
// only to string cells: a numeric -45 must stay the number -45, not "'-45".
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;
export const deFormula = (s) => (CSV_FORMULA_LEAD.test(s) ? "'" + s : s);

// Defensive cap: line counts are small in practice, but a crafted result jsonb
// shouldn't be able to build an unbounded workbook in one synchronous pass.
const MAX_EXPORT_LINES = 5000;

// The columns, in order, and how to pull each from a line whatever alias the
// extractor / reconciler used (qty|quantity, rate|unitPrice, etc.).
const LINE_COLUMNS = ["#", "Part Number", "Customer Part No", "Item Name", "Description", "Qty", "UOM", "Unit Price", "Amount", "HSN"];

// Pure: the extracted sales order as one worksheet's array-of-arrays. Exported
// for tests so the shape is locked without a live workbook round-trip.
export const buildSalesOrderAoa = (order) => {
  const so = (order && order.result && order.result.salesOrder) || {};
  const cust = so.customer || {};
  const lines = (Array.isArray(so.lineItems) ? so.lineItems : []).slice(0, MAX_EXPORT_LINES);

  const meta = [
    ["Sales Order (extracted)"],
    ["PO Number", first(order && order.po_number, so.po_number) || ""],
    ["Customer", first(cust.name, order && order.customer_name) || ""],
    ["GSTIN", cust.gstin || ""],
    ["Currency", first(so.currency, cust.currency) || ""],
    ["Payment Terms", first(so.payment_terms, cust.payment_terms, order && order.payment_terms) || ""],
    ["Order Date", first(so.po_date, order && order.created_at) || ""],
    ["Order ID", (order && order.id) || ""],
    [],
  ];

  const rows = lines.map((li, i) => {
    const qty = num(first(li.qty, li.quantity)) ?? 0;
    const rate = num(first(li.rate, li.unitPrice, li.unit_price)) ?? 0;
    const amount = num(first(li.amount, li.line_amount));
    return [
      i + 1,
      first(li.partNumber, li.part_no, li.partNo) || "",
      first(li.customer_part_number, li.customerPartNumber) || "",
      first(li.itemName, li.item_name) || "",
      li.description || "",
      qty,
      li.uom || "",
      rate,
      amount != null ? amount : Math.round(qty * rate * 100) / 100,
      first(li.hsn, li.hsn_sac, li.hsnCode) || "",
    ];
  });

  const totalAmt = rows.reduce((s, r) => s + (Number(r[8]) || 0), 0);
  const totals = ["", "", "", "", "", "", "", "Total", Math.round(totalAmt * 100) / 100, ""];

  return [...meta, LINE_COLUMNS, ...rows, totals];
};

export const filenameFor = (order, ext) => {
  const base = String(first(order && order.po_number, order && order.id, "sales-order"))
    .replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60);
  return "SO_" + base + "." + (ext || "xlsx");
};

export const toCsv = (aoa) => aoa.map((r) => r.map((c) => {
  const raw = typeof c === "string" ? deFormula(c) : c;
  const s = raw == null ? "" : String(raw);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}).join(",")).join("\r\n");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return json(res, 405, { error: { message: "Method not allowed" } }); }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const orderId = first(req.query && req.query.orderId, req.query && req.query.order_id);
    if (!orderId) return json(res, 400, { error: { message: "orderId required" } });

    const svc = serviceClient();
    const { data: order, error } = await svc.from("orders")
      .select("id, po_number, customer_id, result, payment_terms, created_at")
      .eq("tenant_id", ctx.tenantId).eq("id", orderId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!order) return json(res, 404, { error: { message: "order not found" } });

    // The SO customer block usually carries the name; fall back to the
    // customers row so the export header is never blank.
    if (!(order.result?.salesOrder?.customer?.name) && order.customer_id) {
      const c = await svc.from("customers").select("customer_name")
        .eq("tenant_id", ctx.tenantId).eq("id", order.customer_id).maybeSingle();
      if (c.data) order.customer_name = c.data.customer_name;
    }

    const aoa = buildSalesOrderAoa(order);
    // A full-order data export is auditable like the PDF siblings (voucher_pdf /
    // so_pdf both record a *_downloaded event).
    const rowCount = Math.max(0, aoa.length - 10); // meta(9) + header(1)
    await recordAudit(ctx, { action: "so_excel_exported", objectType: "order", objectId: order.id, detail: "rows=" + rowCount });

    let xlsxMod = null;
    try {
      const spec = "xlsx";
      const m = await import(/* @vite-ignore */ spec);
      xlsxMod = m.default || m;
    } catch (_e) { xlsxMod = null; }

    if (!xlsxMod || !xlsxMod.utils) {
      // Graceful CSV fallback so the export never hard-fails. deFormula runs
      // inside toCsv (a raw CSV cell is parsed; an .xlsx string cell is not).
      const csv = toCsv(aoa);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="' + filenameFor(order, "csv") + '"');
      res.setHeader("Content-Length", Buffer.byteLength(csv));
      res.statusCode = 200;
      return res.end(csv);
    }

    const ws = xlsxMod.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 4 }, { wch: 20 }, { wch: 18 }, { wch: 22 }, { wch: 36 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 10 }];
    const wb = xlsxMod.utils.book_new();
    xlsxMod.utils.book_append_sheet(wb, ws, "Sales Order");
    const raw = xlsxMod.write(wb, { type: "buffer", bookType: "xlsx" });
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="' + filenameFor(order, "xlsx") + '"');
    res.setHeader("Content-Length", buf.length);
    res.statusCode = 200;
    return res.end(buf);
  } catch (err) { sendError(res, err); }
}
