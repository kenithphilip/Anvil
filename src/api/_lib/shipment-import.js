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

// Header labels only — NEVER data.
//
// The logistics workbook spells the same column three ways across its sheets:
//
//   Pending    "Shipper Invoice No."     <- letter O
//   Completed  "Shipper Invoice N0."     <- DIGIT ZERO
//   details    "Shipper Invoice N0."     <- digit zero
//
// classifySheet matches loosely on "shipper inv", so Completed and details were
// correctly identified as shipment sheets — and then normalizePending looked
// for "shipper invoice no", did not find it, and dropped EVERY row. 1,145 of
// 1,718 rows in a real workbook went silently to zero.
//
// ONLY zero->o, and only between letters. That is the confusable actually
// observed, and narrowness is the point: folding 1->l or 5->s as well would
// rewrite a legitimate caption like "S5 Code" into "SS Code" and invent a
// match that is not there. A missed alias shows up as a sheet reporting zero
// rows, which parseSheets now reports; a WRONG alias silently maps the wrong
// column, which nothing would catch.
//
// Headers only, never data — applying this to values would corrupt part
// numbers, which is why it is a separate function from `norm`.
// Preceded by a letter, not followed by another digit: catches "N0." and "N0"
// while leaving "Zone 0" (space before) and "Bin 10" (digit before) alone.
export const normHeader = (s) => norm(s).replace(/(?<=[a-z])0(?![0-9])/g, "o");

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
    // Folded, so "Shipper Invoice N0." and "Shipper Invoice No." are one key.
    const key = normHeader(cell);
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
  // High Seas Sale: customer-facing, sold in transit before customs clearance.
  // Its own shape — Customer Name / Customer P/O / BOE status, no part column —
  // so it can never satisfy the line test below. Named rather than lumped into
  // "ignore" so 70 real rows stop disappearing without comment.
  if (has("customer p/o") || has("boe status") || has("hss document")) return "hss";
  // Line sheets are the per-part detail. Qty plus SOMETHING identifying: the
  // country sheets disagree about which of P/O and part number is populated —
  // Thailand leaves Part Number blank and puts the code in DESCRIPTION,
  // Japan/Korea leave P/O blank — and requiring all three classified those
  // sheets correctly only by luck.
  if (hasQty && (hasPO || hasPart)) return "lines";
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
// Origin from the sheet name. The workbook is one sheet per source country and
// nothing else records it — `shipments` and `shipment_lines` have no origin
// column of their own, so without this the KR/CN/JP corridor split is lost at
// the door.
//
// An explicit list, not a guess: "Sheet1", "Sheet2" and "HSS Transit Shipment"
// are not countries, and inferring one from an arbitrary tab name would invent
// data. An unlisted sheet simply yields null.
const SHEET_COUNTRY = {
  japan: "JP", china: "CN", korea: "KR", "south korea": "KR",
  thailand: "TH", france: "FR", germany: "DE", italy: "IT",
  usa: "US", "united states": "US", taiwan: "TW", vietnam: "VN",
  india: "IN", spain: "ES", uk: "GB", "united kingdom": "GB",
};
export const sheetCountry = (name) => SHEET_COUNTRY[norm(name)] || null;

// How many cells carry something a person would call data. Booleans are Excel
// checkbox artefacts, not values; whitespace is not content; a lone serial
// number is a row number, not a row.
const meaningfulCells = (row) => (row || []).reduce((n, c) => {
  if (c == null || typeof c === "boolean") return n;
  return String(c).trim() === "" ? n : n + 1;
}, 0);

export const parseSheets = (sheets) => {
  const pending = [];
  const lines = [];
  // Per-sheet accounting. A sheet that CLASSIFIES as a shipment sheet and then
  // yields zero rows is the failure mode this import already had and nobody
  // saw: "Shipper Invoice N0." (digit zero) passed classifySheet's loose
  // "shipper inv" test, missed normalizePending's exact alias, and 1,145 of
  // 1,718 rows in a real workbook went silently to zero. Header folding fixes
  // that instance; reporting fixes the class, because the next workbook will
  // misspell a different column.
  const diag = [];
  for (const sheet of (sheets || [])) {
    const rows = sheet?.rows;
    if (!Array.isArray(rows) || !rows.length) continue;
    const hdr = detectHeaderRow(rows);
    const map = buildHeaderMap(rows[hdr.index]);
    const kind = classifySheet(map);
    if (kind === "ignore") {
      diag.push({ sheet: sheet.name || null, kind, rows: rows.length, kept: 0, blank: 0, unrecognised: 0 });
      continue;

    }
    let kept = 0;
    let blank = 0;
    let unrecognised = 0;
    let unsupported = 0;
    let partless = 0;
    // The sheet NAME is the only place the origin appears. Read it for line
    // sheets so a KR/CN/JP corridor is something you can slice by, instead of
    // metadata the importer sees and drops.
    const sourceCountry = kind === "lines" ? sheetCountry(sheet.name) : null;
    for (let i = hdr.index + 1; i < rows.length; i++) {
      const row = rows[i];
      // Blank means "no content", not "no cells". The Pending sheet carries ~518
      // pre-numbered placeholder rows that hold a serial number, some Excel
      // checkbox `false` values and a stray space — nothing a human would call
      // data. Counting them as unrecognised made a healthy sheet look broken,
      // which is the opposite of what the accounting is for.
      if (!Array.isArray(row) || meaningfulCells(row) < 2) { blank++; continue; }
      if (kind === "pending") {
        const n = normalizePending(row, map);
        if (n.shipper_invoice_no) { pending.push(n); kept++; } else unrecognised++;
      } else if (kind === "lines") {
        const n = normalizeLine(row, map);
        // Keep a row that identifies WHAT (part or description) and anchors to
        // SOMETHING (a P/O or a shipper invoice). Requiring part_no AND po_ref
        // dropped 763 real rows across the country sheets — goods genuinely in
        // transit — because the sheets disagree about which columns they fill.
        //
        // Deliberately NOT filled in by guessing: a missing part number stays
        // null rather than being mined out of the description. That is the trap
        // that turned "TWS-092-90-2" into "90-2" on the PO side.
        const identifies = !!(n.part_no || n.description);
        const anchors = !!(n.po_ref || n.shipper_invoice_no);
        if (identifies && anchors) {
          lines.push(sourceCountry ? { ...n, source_country: sourceCountry } : n);
          kept++;
          if (!n.part_no) partless++;
        } else unrecognised++;
      } else {
        // A recognised-but-unsupported kind (hss). Counted, never silently lost.
        unsupported++;
      }
    }
    diag.push({
      sheet: sheet.name || null, kind, header_row: hdr.index,
      rows: Math.max(0, rows.length - hdr.index - 1), kept, blank, unrecognised,
      ...(sourceCountry ? { source_country: sourceCountry } : {}),
      // Rows kept WITHOUT a part number — real goods, identified by description
      // only. Surfaced so "why is this line missing a part?" has an answer.
      ...(partless ? { without_part_no: partless } : {}),
      ...(unsupported ? { unsupported } : {}),
      ...(kind === "hss"
        ? { warning: "High Seas Sale sheet recognised but not imported — it has no part-level columns. " + unsupported + " row(s) skipped." }
        : {}),
      // The loud case: the sheet looked right and produced nothing.
      ...(kept === 0 && unrecognised > 0
        ? { warning: "classified as " + kind + " but every non-blank row was unrecognised — a column header probably does not match" }
        : {}),
    });
  }
  return { pending, lines, diag };
};
