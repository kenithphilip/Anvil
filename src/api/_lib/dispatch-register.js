// Customer-facing DISPATCH REGISTER — per PO line, what was despatched.
//
// A dispatch register goes TO the customer's stores team (purchase + accounts in
// CC): "against your PO line 3, 40 of 100 despatched on 12 Mar under LR 4471,
// billed on invoice INV-882." The despatched quantity is mirrored from the ERP
// delivery note into `dispatch_lines`; the promised quantity is in
// `order_schedule_lines`; the consignment header is in `shipments`.
//
// TWO load-bearing properties, both asserted by the tests:
//
//   * REDUNDANCY, NOT A WATERFALL. The register degrades instead of blocking.
//     It matches a despatch to its PO line by line_index, else part_no; an
//     unmatched despatch is still listed on its own; a PO line
//     with nothing despatched shows as pending; and if there are NO line-grain
//     records at all it falls back to the shipment headers. It never returns
//     "cannot produce".
//
//   * FAIL-SAFE VISIBILITY. Only known customer-safe columns are emitted. A
//     template may relabel / reorder / hide them and may add extra fields, but
//     an extra field appears ONLY if it is explicitly marked visibility
//     'customer'. Internal context (dispatch_lines.metadata, cost, remarks) is
//     never emitted by omission.
//
// Pure: no I/O, no clock. The caller passes `today` when it wants deterministic
// status, so every calculation is testable.

const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();

// Trim a numeric like 40.0000 -> "40", 12.5000 -> "12.5". Keeps big/precise
// values honest without printing accountancy zeros to a stores clerk.
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n;
};
export const fmtQty = (v) => {
  const n = num(v);
  if (n == null) return "";
  return String(Math.round(n * 10000) / 10000);
};

// ── the PO line items (the ORDERED side) ─────────────────────────────────────
// The authoritative ordered quantity is the customer's PO line, which lives in
// orders.result.salesOrder.lineItems[] — the same array every ERP push client
// and invoicing.js read. NOT order_schedule_lines: that is the DELIVERY SCHEDULE
// (scheduled_qty), one-to-many per PO line, and summing it double-counts the
// order. The stable per-line key is the ordinal into that array (`ordinal`),
// which is what dispatch_lines.line_index is stamped to; part_no is the
// convention-independent fallback.
const pick = (o, keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== "") return v; } return null; };
const PART_KEYS = ["partNo", "part_no", "partNumber", "itemCode", "sku", "part", "item"];
const QTY_KEYS = ["quantity", "qty", "orderedQty", "ordered_qty"];
const UOM_KEYS = ["uom", "unit", "unitOfMeasure"];
const DESC_KEYS = ["description", "desc", "itemName", "name"];
const LABEL_KEYS = ["lineNo", "line_no", "srNo", "slNo", "sr_no"];

const normalizePoLine = (raw, i) => ({
  ordinal: i,                                                    // 0-based match key
  line_label: pick(raw, LABEL_KEYS) != null ? pick(raw, LABEL_KEYS) : i + 1,  // display
  part_no: pick(raw, PART_KEYS),
  description: pick(raw, DESC_KEYS),
  ordered_qty: num(pick(raw, QTY_KEYS)),
  uom: pick(raw, UOM_KEYS),
});

// Pull the PO line items off an order row, tolerating the shape variants the
// rest of the codebase already tolerates (salesOrder.lineItems | lineItems |
// lines). Returns the RAW line items; buildDispatchRegister normalises them.
export const extractPoLines = (order) => {
  const r = order?.result || {};
  const raw = (r.salesOrder && r.salesOrder.lineItems) || r.lineItems || r.lines || [];
  return Array.isArray(raw) ? raw : [];
};

// ── columns ────────────────────────────────────────────────────────────────
// The built-in, always-customer-safe columns. A template can hide/relabel these
// and add its own, but only these keys (plus a template field explicitly marked
// visibility:'customer') are ever rendered.
const SAFE_KEYS = new Set([
  "line_no", "part_no", "description", "ordered_qty", "dispatched_qty",
  "balance_qty", "uom", "last_dispatch_date", "lr_number", "invoice_number",
  "status",
]);

export const DEFAULT_COLUMNS = [
  { key: "line_no", label: "Line" },
  { key: "part_no", label: "Part / Item" },
  { key: "description", label: "Description" },
  { key: "ordered_qty", label: "Ordered" },
  { key: "dispatched_qty", label: "Despatched" },
  { key: "balance_qty", label: "Balance" },
  { key: "uom", label: "UOM" },
  { key: "last_dispatch_date", label: "Despatch date" },
  { key: "lr_number", label: "LR / Docket" },
  { key: "invoice_number", label: "Invoice" },
  { key: "status", label: "Status" },
];

// Resolve the column set from an optional template. Fail-safe: an unknown key is
// dropped unless the template marks it visibility:'customer'.
export const resolveColumns = (template) => {
  const cols = template && Array.isArray(template.columns) ? template.columns : null;
  if (!cols) return DEFAULT_COLUMNS;
  const out = [];
  for (const c of cols) {
    if (!c || !c.key) continue;
    if (c.include === false) continue;
    const key = String(c.key);
    const known = SAFE_KEYS.has(key);
    // An extra (non-built-in) column is customer-facing ONLY when said so.
    if (!known && c.visibility !== "customer") continue;
    out.push({ key, label: c.label ? String(c.label) : key, extra: !known });
  }
  return out.length ? out : DEFAULT_COLUMNS;
};

// ── despatch aggregation for one PO line ─────────────────────────────────────
const emptyAgg = () => ({ qty: 0, dispatches: [], invoice_numbers: [], last_dispatch_date: null, lr_numbers: [] });

const addDispatch = (agg, d) => {
  const q = num(d.dispatched_qty) || 0;
  agg.qty += q;
  const date = d.dispatch_date || null;
  const entry = {
    qty: q, date, lr_number: d.lr_number || null, carrier: d.carrier || null,
    invoice_number: d.invoice_number || null, invoice_date: d.invoice_date || null,
  };
  agg.dispatches.push(entry);
  if (date && (!agg.last_dispatch_date || date > agg.last_dispatch_date)) agg.last_dispatch_date = date;
  if (d.invoice_number && !agg.invoice_numbers.includes(d.invoice_number)) agg.invoice_numbers.push(d.invoice_number);
  if (d.lr_number && !agg.lr_numbers.includes(d.lr_number)) agg.lr_numbers.push(d.lr_number);
};

const statusFor = (ordered, dispatched) => {
  const disp = num(dispatched) || 0;
  const ord = num(ordered);
  if (ord == null) return disp > 0 ? "despatched" : "pending";
  if (disp <= 0) return "pending";
  if (disp >= ord) return disp > ord ? "over-despatched" : "complete";
  return "partial";
};

// ── the header (shipment-only) fallback ──────────────────────────────────────
// When nothing has line grain, a register is still worth sending: it tells the
// stores team a consignment left, on what, when, and against which invoice. This
// is the "degrade to shipment header + invoice" path from §4.
const shipmentDispatchDate = (s) =>
  s.customer_delivery_date || s.vessel_sailing_date || s.ready_date || s.warehouse_receipt_date || null;

const linesFromShipments = (shipments) =>
  (shipments || [])
    .map((s, i) => ({
      line_no: s.shipment_number || String(i + 1),
      part_no: null,
      description: s.carrier ? "Consignment via " + s.carrier : "Consignment",
      ordered_qty: null,
      dispatched_qty: null,
      balance_qty: null,
      uom: null,
      dispatches: [{ qty: null, date: shipmentDispatchDate(s), lr_number: null, carrier: s.carrier || null, invoice_number: s.shipper_invoice_no || null, invoice_date: null }],
      last_dispatch_date: shipmentDispatchDate(s),
      invoice_numbers: s.shipper_invoice_no ? [s.shipper_invoice_no] : [],
      lr_numbers: [],
      status: "despatched",
      matched: "shipment-header",
    }));

// ── main ─────────────────────────────────────────────────────────────────────
export const buildDispatchRegister = ({
  order = {}, poLines = [], dispatchLines = [], shipments = [],
  customer = {}, invoices = [], template = null,
} = {}) => {
  const columns = resolveColumns(template);

  // Index the PO lines for matching: by ordinal (the stable per-line key) and by
  // part_no (convention-independent fallback). `_key` is the array position, a
  // guaranteed-unique aggregation handle even if two lines share a part_no.
  const po = (poLines || []).map((raw, i) => ({ ...normalizePoLine(raw, i), _key: i }));
  const byIndex = new Map();
  const byPart = new Map();
  for (const p of po) {
    byIndex.set(String(p.ordinal), p);
    if (p.part_no && !byPart.has(norm(p.part_no))) byPart.set(norm(p.part_no), p);
  }

  // Attach each despatch to a PO line, degrading through the match keys.
  const aggByLine = new Map();       // _key -> agg
  const matchKeyUsed = new Map();    // _key -> how it matched (for transparency)
  const unmatched = [];              // despatches that key to no PO line

  for (const d of dispatchLines || []) {
    let p = null;
    let how = null;
    if (d.line_index != null && byIndex.has(String(d.line_index))) { p = byIndex.get(String(d.line_index)); how = "line_index"; }
    else if (d.part_no && byPart.has(norm(d.part_no))) { p = byPart.get(norm(d.part_no)); how = "part_no"; }

    if (p) {
      if (!aggByLine.has(p._key)) aggByLine.set(p._key, emptyAgg());
      addDispatch(aggByLine.get(p._key), d);
      if (!matchKeyUsed.has(p._key)) matchKeyUsed.set(p._key, how);
    } else {
      unmatched.push(d);
    }
  }

  const lines = [];

  // One row per PO line — pending or (partly) despatched.
  for (const p of po) {
    const agg = aggByLine.get(p._key) || emptyAgg();
    const ordered = num(p.ordered_qty);
    const dispatched = agg.dispatches.length ? agg.qty : null;
    const balance = ordered != null ? Math.round((ordered - (dispatched || 0)) * 10000) / 10000 : null;
    lines.push({
      line_no: p.line_label,
      part_no: p.part_no || null,
      description: p.description || null,
      ordered_qty: ordered,
      dispatched_qty: dispatched,
      balance_qty: balance,
      uom: p.uom || null,
      dispatches: agg.dispatches,
      last_dispatch_date: agg.last_dispatch_date,
      invoice_numbers: agg.invoice_numbers,
      lr_numbers: agg.lr_numbers,
      status: statusFor(ordered, dispatched),
      matched: aggByLine.has(p._key) ? (matchKeyUsed.get(p._key) || "line_index") : "ordered-only",
    });
  }

  // Despatches that matched no PO line are still shown — never dropped.
  for (const d of unmatched) {
    const agg = emptyAgg();
    addDispatch(agg, d);
    lines.push({
      line_no: d.line_index != null ? d.line_index : (d.part_no || "—"),
      part_no: d.part_no || null,
      description: d.description || null,
      ordered_qty: null,
      dispatched_qty: agg.qty,
      balance_qty: null,
      uom: d.uom || null,
      dispatches: agg.dispatches,
      last_dispatch_date: agg.last_dispatch_date,
      invoice_numbers: agg.invoice_numbers,
      lr_numbers: agg.lr_numbers,
      status: "despatched",
      matched: "unmatched-dispatch",
    });
  }

  let degraded = null;
  // Nothing at line grain at all -> fall back to the shipment headers.
  if (!lines.length && (shipments || []).length) {
    lines.push(...linesFromShipments(shipments));
    degraded = { header_fallback: true, reason: "no line-grain despatch data; showing consignment headers" };
  }

  // Enrich invoice numbers from the invoices table when a line has none but the
  // order has exactly one invoice (redundancy, not a hard join).
  const orderInvoices = (invoices || []).filter((iv) => iv && iv.invoice_number);
  if (orderInvoices.length === 1) {
    for (const ln of lines) {
      if (!ln.invoice_numbers || !ln.invoice_numbers.length) ln.invoice_numbers = [orderInvoices[0].invoice_number];
    }
  }

  const dispatchedLines = lines.filter((l) => (l.dispatches || []).length > 0);
  const summary = {
    line_count: lines.length,
    dispatched_line_count: dispatchedLines.length,
    pending_line_count: lines.filter((l) => l.status === "pending").length,
    complete_count: lines.filter((l) => l.status === "complete").length,
    partial_count: lines.filter((l) => l.status === "partial").length,
    total_dispatched_qty: Math.round(lines.reduce((a, l) => a + (num(l.dispatched_qty) || 0), 0) * 10000) / 10000,
  };

  return {
    po_number: order.po_number || null,
    po_date: order.po_date || null,
    order_id: order.id || null,
    customer_name: customer.customer_name || null,
    columns,
    lines,
    summary,
    degraded,
  };
};

// True when there is nothing worth sending.
export const isDispatchRegisterEmpty = (register) => !register || !Array.isArray(register.lines) || register.lines.length === 0;

// ── plain-text render (the email body) ───────────────────────────────────────
const cellValue = (line, key) => {
  switch (key) {
    case "line_no": return line.line_no == null ? "" : String(line.line_no);
    case "part_no": return line.part_no || "";
    case "description": return line.description || "";
    case "ordered_qty": return fmtQty(line.ordered_qty);
    case "dispatched_qty": return fmtQty(line.dispatched_qty);
    case "balance_qty": return fmtQty(line.balance_qty);
    case "uom": return line.uom || "";
    case "last_dispatch_date": return line.last_dispatch_date || "";
    case "lr_number": return (line.lr_numbers || []).join(", ");
    case "invoice_number": return (line.invoice_numbers || []).join(", ");
    case "status": return STATUS_LABEL[line.status] || line.status || "";
    default: {
      // A template extra column: read from the line only if the value is a
      // primitive (never dump an object/metadata blob at the customer).
      const v = line[key];
      return (v == null || typeof v === "object") ? "" : String(v);
    }
  }
};

const STATUS_LABEL = {
  complete: "Despatched", partial: "Part despatched", pending: "Awaited",
  despatched: "Despatched", "over-despatched": "Over-despatched",
};

// Drop a column that is empty for every row, so a register without (say) LR
// numbers doesn't print an empty column — degrade gracefully, no skeletons.
const usedColumns = (columns, lines) =>
  columns.filter((c) => ["line_no", "part_no", "dispatched_qty", "status"].includes(c.key)
    || lines.some((l) => cellValue(l, c.key) !== ""));

export const renderDispatchRegisterText = (register, opts = {}) => {
  if (isDispatchRegisterEmpty(register)) return "";
  const cols = usedColumns(register.columns || DEFAULT_COLUMNS, register.lines);
  const rows = register.lines.map((l) => cols.map((c) => cellValue(l, c.key)));

  // Column widths for a monospace-aligned table.
  const widths = cols.map((c, i) => Math.max(c.label.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((v, i) => v.padEnd(widths[i])).join("  ").replace(/\s+$/, "");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");

  const head = [];
  head.push("Dispatch register" + (register.po_number ? " — PO " + register.po_number : ""));
  if (register.customer_name) head.push(register.customer_name);
  if (register.po_date) head.push("PO date: " + register.po_date);

  const table = [line(cols.map((c) => c.label)), sep, ...rows.map(line)];

  const s = register.summary || {};
  const summaryBits = [
    s.line_count + " line" + (s.line_count === 1 ? "" : "s"),
    s.dispatched_line_count + " despatched",
  ];
  if (s.pending_line_count) summaryBits.push(s.pending_line_count + " awaited");

  const out = [head.join("\n"), "", table.join("\n"), "", summaryBits.join(" · ")];
  if (register.degraded?.header_fallback) {
    out.push("", "(Line-level despatch detail not yet available for this order; consignment summary shown.)");
  }
  if (opts.footer) out.push("", String(opts.footer));
  return out.join("\n");
};

// Subject line for the drafted email.
export const dispatchRegisterSubject = (register) =>
  "Dispatch register" + (register?.po_number ? " — PO " + register.po_number : "");
