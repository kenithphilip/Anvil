// Pure parsing/normalization for the logistics-team shipment workbooks.
// No req/res and no DB — so the /api/sales/shipment_import handler and the unit
// tests share exactly this logic. The frontend parses the .xlsx client-side
// (SheetJS, same as the BOM importer) and POSTs each sheet as a 2D `rows`
// array; everything here operates on those arrays.
//
// Two sheet shapes are recognised:
//   * "pending"  — the Daily Shipment Reports / Pending sheet: one row per
//                  supplier invoice, header on ~row 4, with the full
//                  ETD/ATD -> ETA/ATA-at-India -> ATA-at-store date ladder.
//   * "lines"    — the In Transit Items Details per-country sheets: one row per
//                  part (P/O, part no, qty, shipper invoice, receipt date).
// Column order differs between sheets (Japan lists PART then DESC; Korea/China
// list DESC then PART), so every column is resolved by header LABEL, never
// position.

// --- header handling --------------------------------------------------------

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();

// Labels that identify a real header row (vs the title/section rows above it).
const HEADER_HINTS = [
  "shipper invoice", "shipper inv", "invoice no", "mode", "vessel", "forwarder",
  "port of discharge", "hawb", "b/l", "bl no", "etd", "eta", "atd", "ata",
  "part no", "part number", "p/o", "q'ty", "qty", "description", "receipt date",
  "arrival at indian",
];

// Scan the first few rows and return the index of the one that looks most like
// a header (most hint labels present). Handles the Pending sheet's title +
// section-header rows above the real header.
export const detectHeaderRow = (rows, maxScan = 12) => {
  let best = { index: 0, score: 0 };
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const cells = (rows[i] || []).map(norm);
    const score = HEADER_HINTS.reduce((n, h) => n + (cells.some((c) => c.includes(h)) ? 1 : 0), 0);
    if (score > best.score) best = { index: i, score };
  }
  return best;
};

// label(normalized) -> [column indices]. Keeps every occurrence so duplicate
// columns (the Pending sheet has "ETA @ Indian Port" and "ETA @ Obara Store"
// twice — expected then revised) can be disambiguated by occurrence.
export const buildHeaderMap = (headerRow) => {
  const map = new Map();
  (headerRow || []).forEach((cell, idx) => {
    const key = norm(cell);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(idx);
  });
  return map;
};

// First column whose normalized label CONTAINS one of the aliases, at the given
// occurrence (0 = first match). Returns the trimmed cell value or "".
const pick = (row, map, aliases, occurrence = 0) => {
  for (const alias of aliases) {
    const a = norm(alias);
    // exact-key fast path preserves occurrence semantics for duplicate labels
    if (map.has(a)) {
      const idxs = map.get(a);
      const idx = idxs[occurrence] ?? idxs[idxs.length - 1];
      return cell(row, idx);
    }
  }
  // contains fallback (labels carry trailing units / newlines)
  for (const alias of aliases) {
    const a = norm(alias);
    let seen = 0;
    for (const [key, idxs] of map) {
      if (key.includes(a)) {
        for (const idx of idxs) {
          if (seen === occurrence) return cell(row, idx);
          seen++;
        }
      }
    }
  }
  return "";
};

const cell = (row, idx) => (idx == null ? "" : String(row[idx] == null ? "" : row[idx]).trim());

// --- value coercion ---------------------------------------------------------

const MODE_MAP = { sea: "SEA", air: "AIR", road: "ROAD", courier: "COURIER" };
export const normalizeMode = (v) => {
  const s = norm(v);
  for (const k of Object.keys(MODE_MAP)) if (s.includes(k)) return MODE_MAP[k];
  return null;
};

// Coerce a cell to YYYY-MM-DD, or "" when blank/unparseable. Accepts JS Dates
// (SheetJS cellDates), ISO strings, and dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy.
export const toDateStr = (v) => {
  if (v == null || v === "") return "";
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})$/); // dd.mm.yyyy
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
};

// --- sheet classification ---------------------------------------------------

export const classifySheet = (headerMap) => {
  const has = (a) => {
    const n = norm(a);
    for (const key of headerMap.keys()) if (key.includes(n)) return true;
    return false;
  };
  const hasInvoice = has("shipper inv") || has("invoice no");
  const hasPart = has("part no") || has("part number");
  const hasPO = has("p/o");
  const hasQty = has("q'ty") || has("qty");
  // Line sheets are the per-part detail: P/O + part + qty.
  if (hasPO && hasPart && hasQty) return "lines";
  // Pending is the shipment header: invoice + the arrival/departure ladder.
  if (hasInvoice && (has("ata") || has("port of discharge") || has("atd") || has("forwarder"))) return "pending";
  return "ignore";
};

// --- row normalization ------------------------------------------------------

// Derive our shipment status enum from the sheet's free-text status + which
// ladder hops have actual dates.
export const deriveStatus = (currentStatus, d) => {
  const s = norm(currentStatus);
  if (d.ata_store || s.includes("received at store") || s.includes("delivered")) return "DELIVERED";
  if (s.includes("clear")) return "CLEARED";
  if (d.ata_india || s.includes("at port") || s.includes("arrived")) return "AT_PORT";
  if (d.atd_source || s.includes("transit") || s.includes("sailed") || s.includes("shipped")) return "IN_TRANSIT";
  if (d.etd_source || s.includes("ready")) return "READY";
  return "PLANNED";
};

export const normalizePending = (row, map) => {
  const d = {
    etd_source: toDateStr(pick(row, map, ["etd @ source port", "etd"])),
    atd_source: toDateStr(pick(row, map, ["atd @ source port", "atd"])),
    eta_india: toDateStr(pick(row, map, ["eta @ indian port"], 0)),
    ata_india: toDateStr(pick(row, map, ["ata @ india", "ata @ indian port"])),
    eta_store: toDateStr(pick(row, map, ["revised eta at store", "eta @ obara store"], 0)),
    ata_store: toDateStr(pick(row, map, ["ata @ obara store"])),
  };
  return {
    shipper_invoice_no: pick(row, map, ["shipper invoice no", "shipper inv no", "invoice no"]),
    supplier: pick(row, map, ["supplier name", "supplier"]),
    items_text: pick(row, map, ["items details", "item details", "items"]),
    mode: normalizeMode(pick(row, map, ["mode"])),
    gross_weight: pick(row, map, ["gross weight"]),
    vessel_or_flight: pick(row, map, ["vessel name", "vessel or flight", "vessel"]),
    port_of_discharge: pick(row, map, ["port of discharge", "pod"]),
    carrier: pick(row, map, ["forwarder"]),
    bl_awb: pick(row, map, ["hawb no / bl no", "hawb", "b/l no", "bl no"]),
    current_status: pick(row, map, ["current status"]),
    remark: pick(row, map, ["remark"]),
    delays: pick(row, map, ["no. of delays", "delays"]),
    ...d,
  };
};

export const normalizeLine = (row, map) => ({
  po_ref: pick(row, map, ["p/o", "po"]),
  part_no: pick(row, map, ["part no", "part number"]),
  description: pick(row, map, ["description"]),
  qty: pick(row, map, ["q'ty", "qty"]),
  shipper_invoice_no: pick(row, map, ["shipper inv no", "shipper invoice no", "invoice no"]),
  receipt_date: toDateStr(pick(row, map, ["receipt date at our warehouse", "receipt date", "arrival at indian"])),
  remark: pick(row, map, ["remark"]),
});

// A human-readable remarks block that preserves the schedule info the shipments
// table has no dedicated column for (expected ETAs, items, delays, free-text
// status) — so the account owner still sees the promised dates until those get
// their own columns.
export const composeRemarks = (n) => {
  const parts = [];
  if (n.items_text) parts.push("Items: " + n.items_text);
  if (n.eta_india) parts.push("ETA India (expected): " + n.eta_india);
  if (n.eta_store) parts.push("ETA store (promised): " + n.eta_store);
  if (n.current_status) parts.push("Status: " + n.current_status);
  if (n.delays) parts.push("Delays: " + n.delays);
  if (n.gross_weight) parts.push("Gross wt (kg): " + n.gross_weight);
  if (n.remark) parts.push("Note: " + n.remark);
  return parts.join("\n").slice(0, 2000) || null;
};

// Build the `shipments` upsert body from a normalized pending row. `links` may
// carry a resolved { order_id, source_po_id }.
export const pendingToShipment = (n, links = {}) => ({
  shipper_invoice_no: n.shipper_invoice_no || null,
  shipment_number: n.bl_awb || null,
  mode: n.mode || null,
  carrier: n.carrier || null,
  vessel_or_flight: n.vessel_or_flight || null,
  port_of_discharge: n.port_of_discharge || null,
  ready_date: n.etd_source || null,
  vessel_sailing_date: n.atd_source || null,
  port_arrival_date: n.ata_india || null,
  warehouse_receipt_date: n.ata_store || null,
  status: deriveStatus(n.current_status, n),
  remarks: composeRemarks(n),
  order_id: links.order_id || null,
  source_po_id: links.source_po_id || null,
});

// Turn an array of { name, rows } sheets into normalized pending + line rows.
// Skips rows with no invoice (pending) / no part (lines).
export const parseSheets = (sheets) => {
  const pending = [];
  const lines = [];
  for (const sheet of (sheets || [])) {
    const rows = sheet?.rows;
    if (!Array.isArray(rows) || !rows.length) continue;
    const hdr = detectHeaderRow(rows);
    const map = buildHeaderMap(rows[hdr.index]);
    const kind = classifySheet(map);
    if (kind === "ignore") continue;
    for (let i = hdr.index + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row) || row.every((c) => c == null || String(c).trim() === "")) continue;
      if (kind === "pending") {
        const n = normalizePending(row, map);
        if (n.shipper_invoice_no) pending.push(n);
      } else {
        const n = normalizeLine(row, map);
        if (n.part_no && n.po_ref) lines.push(n);
      }
    }
  }
  return { pending, lines };
};
