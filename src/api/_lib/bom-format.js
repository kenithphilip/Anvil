// BOM source-format engine - pure detect + column-map + normalize.
//
// Generalizes per-origin BOM logic (COL_MAP + detectOrigin + the
// per-source quirks) into DATA: a format is a record
// of { key, column_map, detect, quirks } and the same engine ingests any
// of them. Built-in profiles for four common import origins + a generic
// flat fallback ship in code; tenants add/override formats via the
// bom_source_formats table (merged at read time, tenant wins by key).
//
// NOTE: the built-in `key` values (e.g. "obara_japan") and
// `source_country` codes (e.g. "O-JAPAN") are persisted on BOM rows and
// referenced by tenant overrides, so they are intentionally kept stable
// for data compatibility. Only the display `label` is genericized.
//
// Pure (no I/O): callers pass the parsed sheet as rows (array-of-arrays,
// the SheetJS `{header:1}` shape) and the merged format list. See
// docs/BOM_INGESTION_DESIGN.md section 3.3.

// ── built-in profiles ────────────────────────────────────────────────
// detect signals (all optional):
//   headers_all : every label must appear in the header row
//   any_label   : any substring present anywhere in the first ~10 rows
//   script      : 'cjk_only' | 'kana' | 'hangul' present in the sheet
//   filename    : any substring present in the file name
//   priority    : higher wins when multiple match
// quirks:
//   parts_code_to : 'part_no' (China: PARTS CODE is the real part no)
//   level_from_col : canonical col holding the depth integer (China/Korea)
//   level_from_dotted : canonical col holding a dotted id (Japan "14 .1.1")
//   lr_yes_no : { yes:[...], no:[...] } (Japan 有/無)
//   remarks_append : canonical cols to fold into remarks
export const BUILTIN_FORMATS = [
  {
    key: "obara_japan", label: "Japan (structured)", is_builtin: true, source_country: "O-JAPAN",
    column_map: {
      part_no: ["item no", "item no.", "part no", "part number"],
      part_name: ["part name", "name", "description", "product name"],
      structure: ["structure"],
      material: ["material", "material code"],
      qty: ["qty", "quantity", "q'ty"],
      lr: ["lr is or not", "lr", "l/r"],
      size: ["size", "model name"],
      remarks: ["remarks", "remark", "note"],
    },
    detect: { headers_all: ["structure"], any_label: ["bill of materials"], script: "kana", priority: 40 },
    quirks: { level_from_dotted: "structure", lr_yes_no: { yes: ["有", "yes", "y"], no: ["無", "no", "n"] } },
  },
  {
    key: "obara_china", label: "China (parts-code)", is_builtin: true, source_country: "O-CHINA",
    column_map: {
      part_no: ["item no", "item no."],
      parts_code: ["parts code", "product code"],
      part_name: ["part name", "parts name", "product name", "name", "description"],
      jpn_model: ["jpn model"],
      model: ["model"],
      size: ["size", "model name"],
      material: ["material", "mat", "mat."],
      qty: ["qty", "quantity", "q'ty"],
      std_category: ["level", "lv"],
      hier_no: ["no"],
      remarks: ["remarks", "remark", "note"],
    },
    detect: { headers_all: ["parts code", "jpn model"], any_label: ["messrs", "product code"], script: "cjk_only", priority: 30 },
    quirks: { parts_code_to: "part_no", level_from_col: "std_category", remarks_append: ["jpn_model", "hier_no"] },
  },
  {
    key: "obara_korea", label: "Korea (Hangul)", is_builtin: true, source_country: "O-KOREA",
    column_map: {
      part_no: ["part no", "part no.", "part number", "item no"],
      part_name: ["part name", "name", "description"],
      size: ["size", "dimension"],
      material: ["material", "mat"],
      qty: ["qty", "quantity", "q'ty"],
      std_category: ["lv", "std", "standard", "level"],
      remarks: ["remarks", "remark", "note"],
    },
    detect: { any_label: ["parts list", "drawing no."], script: "hangul", filename: ["korea", "kr-", "ixm"], priority: 20 },
    quirks: { level_from_col: "std_category" },
  },
  {
    key: "obara_india", label: "India (flat)", is_builtin: true, source_country: "O-INDIA",
    column_map: {
      part_no: ["part no", "part no.", "part number", "partno", "part_no"],
      part_name: ["part name", "name", "description", "item name"],
      size: ["size", "dimension"],
      material: ["material", "mat"],
      qty: ["qty", "quantity"],
      side: ["side", "lh/rh"],
      lr: ["lr", "l/r"],
      std_category: ["std", "standard", "category"],
      is_spare: ["spare", "is_spare"],
      remarks: ["remarks", "remark", "note"],
    },
    detect: { priority: 5 },
    quirks: {},
  },
  {
    key: "generic_flat", label: "Generic flat", is_builtin: true, source_country: null,
    column_map: {
      part_no: ["part no", "part no.", "part number", "partno", "part_no", "item no", "item no.", "sku", "code"],
      part_name: ["part name", "name", "description", "item name", "desc"],
      qty: ["qty", "quantity", "amount"],
      uom: ["uom", "unit"],
      material: ["material", "mat"],
      size: ["size", "dimension"],
      supplier_part_no: ["supplier part", "supplier part no", "vendor part", "mpn"],
      remarks: ["remarks", "remark", "note", "comment"],
    },
    detect: { priority: 1 },
    quirks: {},
  },
];

// Merge built-ins with tenant-authored rows (tenant wins by key); drop
// disabled. Tenant rows look like the built-in shape (key, column_map,
// detect, quirks) plus `enabled`.
export const mergeFormats = (tenantRows) => {
  const byKey = new Map();
  for (const f of BUILTIN_FORMATS) byKey.set(f.key, f);
  for (const r of tenantRows || []) {
    if (!r || !r.key) continue;
    byKey.set(r.key, {
      key: r.key,
      label: r.label || r.key,
      is_builtin: false,
      source_country: r.source_country || null,
      column_map: r.column_map || {},
      detect: r.detect || {},
      quirks: r.quirks || {},
      enabled: r.enabled !== false,
    });
  }
  return Array.from(byKey.values()).filter((f) => f.enabled !== false);
};

const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const PART_NO_LABELS = ["part no", "part no.", "part number", "partno", "part_no", "item no", "item no.", "parts code"];
const PART_NAME_LABELS = ["part name", "part_name", "name", "description", "item name", "parts name"];

// Find the header row: first row (within 50) carrying both a part-no and
// a part-name label; else the most-populated row.
export const findHeaderRow = (rows) => {
  const lim = Math.min((rows || []).length, 50);
  for (let i = 0; i < lim; i += 1) {
    if (!rows[i]) continue;
    const cells = rows[i].map(norm);
    if (cells.some((c) => PART_NO_LABELS.includes(c)) && cells.some((c) => PART_NAME_LABELS.includes(c))) return i;
  }
  let best = -1, bestN = 0;
  for (let i = 0; i < lim; i += 1) {
    if (!rows[i]) continue;
    const n = rows[i].filter((c) => String(c == null ? "" : c).trim()).length;
    if (n > bestN) { bestN = n; best = i; }
  }
  return best;
};

const scriptsIn = (rows) => {
  const text = (rows || []).map((r) => (r || []).map((c) => String(c == null ? "" : c)).join("|")).join("\n");
  return {
    cjk: /[一-鿿]/.test(text),
    kana: /[぀-ゟ゠-ヿ]/.test(text),
    hangul: /[가-힯]/.test(text),
  };
};

// Pick the format whose detect signals match, highest priority first.
export const detectFormatKey = (rows, fileName, formats, headerIndex) => {
  const hi = headerIndex == null ? findHeaderRow(rows) : headerIndex;
  const headerCells = hi >= 0 && rows[hi] ? rows[hi].map(norm) : [];
  const scanText = (rows || []).slice(0, 10).map((r) => (r || []).map((c) => String(c == null ? "" : c)).join("|")).join("\n").toLowerCase();
  const fname = norm(fileName);
  const sc = scriptsIn(rows);

  // OR semantics: a format matches if ANY of its declared signals fire
  // (mirrors the original detectOrigin heuristics). A format with no
  // signals at all is a priority "floor" (e.g. india/generic fallback).
  const scriptMatch = (s) =>
    (s === "cjk_only" && sc.cjk && !sc.kana && !sc.hangul) ||
    (s === "cjk" && sc.cjk) || (s === "kana" && sc.kana) || (s === "hangul" && sc.hangul);
  const matches = (f) => {
    const d = f.detect || {};
    const hasSignal = (d.headers_all && d.headers_all.length) || d.script ||
      (d.any_label && d.any_label.length) || (d.filename && d.filename.length);
    if (!hasSignal) return "floor";
    if (Array.isArray(d.headers_all) && d.headers_all.length &&
        d.headers_all.every((lbl) => headerCells.includes(norm(lbl)))) return true;
    if (d.script && scriptMatch(d.script)) return true;
    if (Array.isArray(d.any_label) && d.any_label.some((lbl) => scanText.includes(norm(lbl)))) return true;
    if (Array.isArray(d.filename) && d.filename.some((s) => fname.includes(norm(s)))) return true;
    return false;
  };

  let chosen = null, chosenPr = -Infinity, floor = null, floorPr = -Infinity;
  for (const f of formats) {
    const m = matches(f);
    const pr = (f.detect && f.detect.priority) || 0;
    if (m === true && pr > chosenPr) { chosen = f; chosenPr = pr; }
    else if (m === "floor" && pr > floorPr) { floor = f; floorPr = pr; }
  }
  return (chosen || floor || formats[0] || { key: "generic_flat" }).key;
};

export const detectColumns = (headerRow, format) => {
  const cols = {};
  const cmap = (format && format.column_map) || {};
  (headerRow || []).forEach((cell, i) => {
    const n = norm(cell);
    if (!n) return;
    for (const [canon, aliases] of Object.entries(cmap)) {
      if (cols[canon] != null) continue;
      if ((aliases || []).map(norm).includes(n)) { cols[canon] = i; break; }
    }
  });
  return cols;
};

const cleanFileAsset = (fileName) =>
  String(fileName || "").replace(/\.[^.]+$/, "").trim().toUpperCase() || null;

const computeLevel = (row, cols, quirks) => {
  if (quirks.level_from_col && cols[quirks.level_from_col] != null) {
    const v = String(row[cols[quirks.level_from_col]] == null ? "" : row[cols[quirks.level_from_col]]).trim();
    if (/^\d+$/.test(v)) return parseInt(v, 10);
  }
  if (quirks.level_from_dotted && cols[quirks.level_from_dotted] != null) {
    const v = String(row[cols[quirks.level_from_dotted]] == null ? "" : row[cols[quirks.level_from_dotted]]).trim();
    if (v) return (v.match(/\./g) || []).length + 1; // "14"->1, "14 .1"->2
  }
  return null;
};

const cellAt = (row, idx) => (idx == null ? "" : String(row[idx] == null ? "" : row[idx]).trim());

// Extract pre-header metadata using the format's meta_labels map, plus
// product_code/name conventions. Returns a plain object.
const extractMetadata = (rows, headerIndex, format) => {
  const meta = {};
  const labels = (format.quirks && format.quirks.meta_labels) || {};
  for (let r = 0; r < headerIndex; r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      const label = String(row[c] == null ? "" : row[c]).trim().toUpperCase();
      if (!label) continue;
      const key = labels[label];
      if (!key || meta[key]) continue;
      for (let vc = c + 1; vc < row.length; vc += 1) {
        const v = String(row[vc] == null ? "" : row[vc]).trim();
        if (v && v.toUpperCase() !== label) { meta[key] = v; break; }
      }
    }
  }
  return meta;
};

// Full pipeline: rows + fileName + merged formats -> normalized result.
export const mapSheet = (rows, fileName, formats) => {
  const fmts = (formats && formats.length) ? formats : BUILTIN_FORMATS;
  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) {
    return { source_format: null, header_index: -1, columns: {}, asset: { asset_code: cleanFileAsset(fileName) }, lines: [], error: "no header row found" };
  }
  const formatKey = detectFormatKey(rows, fileName, fmts, headerIndex);
  const format = fmts.find((f) => f.key === formatKey) || fmts[0];
  const cols = detectColumns(rows[headerIndex], format);
  const quirks = format.quirks || {};
  const meta = extractMetadata(rows, headerIndex, format);
  // Base identity for LR-suffix inheritance (Japan 有 -> inherit L/R).
  const lrBase = String(meta.product_code || cleanFileAsset(fileName) || "");

  const lines = [];
  let seq = 0;
  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const row = rows[i] || [];
    let partNo = cellAt(row, cols.part_no);
    let supplierPartNo = cellAt(row, cols.parts_code) || cellAt(row, cols.supplier_part_no);
    if (quirks.parts_code_to === "part_no" && supplierPartNo) partNo = supplierPartNo;
    if (!partNo) continue;
    seq += 1;

    let qty = null;
    const rawQty = cellAt(row, cols.qty);
    if (rawQty !== "") {
      const n = parseFloat(rawQty);
      if (!isNaN(n)) qty = Number.isInteger(n) ? n : Math.round(n * 1e6) / 1e6;
    }

    let lr = cellAt(row, cols.lr);
    if (quirks.lr_yes_no) {
      const lo = lr.toLowerCase();
      if ((quirks.lr_yes_no.no || []).map((x) => String(x).toLowerCase()).includes(lo) || (quirks.lr_yes_no.no || []).includes(lr)) lr = "";
      else if ((quirks.lr_yes_no.yes || []).includes(lr) || (quirks.lr_yes_no.yes || []).map((x) => String(x).toLowerCase()).includes(lo)) {
        lr = (lrBase.match(/[/\-]([LR])$/i) || [])[1] || "";
      }
    }

    let remarks = cellAt(row, cols.remarks);
    if (Array.isArray(quirks.remarks_append)) {
      const extra = quirks.remarks_append.map((k) => cellAt(row, cols[k])).filter(Boolean);
      remarks = [remarks, ...extra].filter(Boolean).join(" - ");
    }

    lines.push({
      seq_no: seq,
      level: computeLevel(row, cols, quirks),
      part_no: partNo,
      part_name: cellAt(row, cols.part_name) || null,
      supplier_part_no: supplierPartNo || null,
      material: cellAt(row, cols.material) || null,
      size: cellAt(row, cols.size) || (quirks.parts_code_to ? cellAt(row, cols.model) : "") || null,
      qty,
      uom: cellAt(row, cols.uom) || null,
      side: cellAt(row, cols.side) || null,
      lr: lr || null,
      std_category: quirks.level_from_col ? null : (cellAt(row, cols.std_category) || null),
      is_spare: cols.is_spare != null ? /^(y|yes|true|1|spare)$/i.test(cellAt(row, cols.is_spare)) : null,
      remarks: remarks || null,
    });
  }

  const asset = {
    asset_code: meta.product_code || cleanFileAsset(fileName),
    name: meta.product_name || null,
    source_format: formatKey,
    source_country: format.source_country || null,
    customer_hint: meta.customer || null,
    metadata: meta,
  };
  return { source_format: formatKey, header_index: headerIndex, columns: cols, asset, lines };
};
