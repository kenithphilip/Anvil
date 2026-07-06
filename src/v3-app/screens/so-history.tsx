import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtINRShort } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { lsGet, lsSet, lsKey } from "../lib/storage-keys";

// ============================================================
// ANVIL v3 — wired Sales Order History
// Drag-drop import (XLSX/XLS/CSV/TSV/TXT), format auto-detect
// (PO vs Tally), filterable table, multi-format export, and
// reverse-search drawer for any part_no.
// Persistence: localStorage `anvil:v3_so_history` (via storage-keys helper).
// Live data: AnvilBackend.salesHistory.priceBand.
// ============================================================

const SOH_SUFFIX = "v3_so_history";
// xlsx is a bundled dep loaded via dynamic import (CSP blocks CDN scripts).

// ── Storage helpers ─────────────────────────────────────────────
const sohLoad = () => {
  try { return JSON.parse(lsGet(SOH_SUFFIX) || "[]") || []; }
  catch { return []; }
};
const sohSave = (rows) => {
  try { lsSet(SOH_SUFFIX, JSON.stringify(rows || [])); }
  catch (e) { console.warn("[soh] persist failed:", e.message); }
};

// ── XLSX lazy loader ───────────────────────────────────────────
let _xlsxPromise = null;
const ensureXlsx = () => {
  if (typeof window !== "undefined" && window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = import("xlsx").then((m: any) => {
    const XLSX = (m && m.read) ? m : (m.default || m);
    try { if (typeof window !== "undefined") window.XLSX = XLSX; } catch (_) { /* noop */ }
    return XLSX;
  });
  return _xlsxPromise;
};

// ── Header / value helpers ─────────────────────────────────────
const sohNormHdr = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sohFindCol = (hdr, variants) => {
  const norm = hdr.map(sohNormHdr);
  for (const v of variants) {
    const nv = sohNormHdr(v);
    const i = norm.indexOf(nv);
    if (i !== -1) return i;
  }
  for (const v of variants) {
    const nv = sohNormHdr(v);
    const i = norm.findIndex((h) => h && (h.includes(nv) || nv.includes(h)));
    if (i !== -1) return i;
  }
  return -1;
};
const sohParseDate = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{2,4})$/);
  if (m) { let y = m[3]; if (y.length === 2) y = (Number(y) < 50 ? "20" : "19") + y; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{2,4})$/);
  if (m) {
    const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, sept:9, oct:10, nov:11, dec:12 };
    const mo = months[m[2].toLowerCase().slice(0, 3)];
    if (mo) { let y = m[3]; if (y.length === 2) y = (Number(y) < 50 ? "20" : "19") + y; return `${y}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  }
  m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return s.slice(0, 10);
  return s;
};
const sohParseNum = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[₹,\s]/g, "").replace(/Rs\.?/i, "").trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
};
const sohParseQty = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/No\.?s?\.?/gi, "").replace(/,/g, "").trim();
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
};

// ── Format detector ────────────────────────────────────────────
const detectSoHistoryFormat = (headers) => {
  if (!Array.isArray(headers) || !headers.length) return "PO";
  const norm = headers.map(sohNormHdr);
  const hasTally =
    norm.some((h) => h.includes("voucher number") || h.includes("sales voucher") || h.includes("sales order number")) ||
    norm.some((h) => h === "stock item" || h.includes("stock item")) ||
    (norm.some((h) => h === "ordered") && norm.some((h) => h === "supplied") && norm.some((h) => h === "balance"));
  const hasPO =
    norm.some((h) => h.includes("obara part no") || h.includes("po items") || h.includes("final unit price")) ||
    (norm.some((h) => h.includes("po no") || h.includes("po number")) &&
     norm.some((h) => h.includes("part no") || h.includes("part number")) &&
     norm.some((h) => h === "rate" || h.includes("rate") || h.includes("unit price"))) ||
    (norm.some((h) => h.includes("po qty")) && norm.some((h) => h.includes("pending qty")));
  if (hasPO && !hasTally) return "PO";
  if (hasTally && !hasPO) return "Tally";
  if (hasPO) return "PO";
  if (hasTally) return "Tally";
  return "PO";
};

// ── CSV/TSV/TXT parser (RFC 4180-ish) ──────────────────────────
const parseDelimitedSoh = (text) => {
  const src = String(text || "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!src.trim()) return [];
  // Auto-pick delimiter: prefer tab if present in first 4KB, else comma.
  const sample = src.slice(0, 4096);
  const tabs = (sample.match(/\t/g) || []).length;
  const commas = (sample.match(/,/g) || []).length;
  const delim = tabs > commas ? "\t" : ",";
  const out = [];
  let cur = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === "\"") {
        if (src[i + 1] === "\"") { field += "\""; i++; }
        else inQ = false;
      } else { field += ch; }
    } else {
      if (ch === "\"") inQ = true;
      else if (ch === delim) { cur.push(field); field = ""; }
      else if (ch === "\n") { cur.push(field); out.push(cur); cur = []; field = ""; }
      else { field += ch; }
    }
  }
  if (field.length || cur.length) { cur.push(field); out.push(cur); }
  // Normalise short rows.
  const width = out.reduce((m, r) => Math.max(m, r.length), 0);
  return out.map((r) => { while (r.length < width) r.push(""); return r; });
};

// ── XLSX parser ────────────────────────────────────────────────
const parseXlsxSoh = async (arrayBuffer) => {
  const X = await ensureXlsx();
  const wb = X.read(arrayBuffer, { type: "array", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return X.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
};

// ── Header row detector ────────────────────────────────────────
const sohFindHeaderRow = (rows) => {
  let hi = 0, max = 0;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const ne = (rows[i] || []).filter((c) => String(c == null ? "" : c).trim()).length;
    if (ne > max) { max = ne; hi = i; }
  }
  return hi;
};

// ── Build rows from a header + body chunk for a given format ───
const sohBuildRows = (rows, headerIdx, format) => {
  const hdr = rows[headerIdx] || [];
  const fmtKey = format === "Tally" ? "tally_format" : "po_format";
  let colMap;
  if (fmtKey === "po_format") {
    colMap = {
      sr_no:            sohFindCol(hdr, ["sr no", "sr no.", "sr. no.", "sr.no", "s no", "s.no"]),
      po_number:        sohFindCol(hdr, ["po no", "po number", "po no."]),
      po_received_date: sohFindCol(hdr, ["po received date"]),
      customer_part_no: sohFindCol(hdr, ["customer part no", "customer part no.", "customer part number"]),
      description:      sohFindCol(hdr, ["po items", "po item", "description", "item description"]),
      obara_part_no:    sohFindCol(hdr, ["obara part no", "obara part no.", "obara part number", "part no"]),
      consumable_spare: sohFindCol(hdr, ["consumable/spare", "consumable spare", "type"]),
      remark:           sohFindCol(hdr, ["remarks", "remark"]),
      unit_price:       sohFindCol(hdr, ["final unit price", "unit price", "price", "rate"]),
      quantity:         sohFindCol(hdr, ["po qty", "qty", "quantity"]),
      total_price:      sohFindCol(hdr, ["final total price", "total price", "amount", "value"]),
      delivered_qty:    sohFindCol(hdr, ["delivered qty", "delivered"]),
      pending_qty:      sohFindCol(hdr, ["pending qty", "pending"]),
      invoice_number:   sohFindCol(hdr, ["invoice number", "invoice no", "invoice no."]),
      wo_number:        sohFindCol(hdr, ["wo number", "wo no", "work order"]),
      dispatched_on:    sohFindCol(hdr, ["dispatched on", "dispatch date", "delivery date", "dispatched"]),
      source_po_no:     sohFindCol(hdr, ["source po no", "source po", "source po no."]),
      docket_no:        sohFindCol(hdr, ["docket no", "docket no.", "docket"]),
      customer_name:    sohFindCol(hdr, ["customer", "customer name", "party", "party name"]),
    };
  } else {
    colMap = {
      order_date:       sohFindCol(hdr, ["date", "order date"]),
      so_number:        sohFindCol(hdr, ["sales order number", "voucher number", "sales voucher", "so number", "so no"]),
      customer_name:    sohFindCol(hdr, ["customer", "customer name", "party name", "party"]),
      description:      sohFindCol(hdr, ["description", "stock item", "item", "item name"]),
      obara_part_no:    sohFindCol(hdr, ["part no", "part no.", "part number", "obara part no", "seller part no"]),
      drawing_no:       sohFindCol(hdr, ["drawing no", "drawing no.", "drawing"]),
      ordered_qty:      sohFindCol(hdr, ["ordered", "order qty", "qty ordered"]),
      balance_qty:      sohFindCol(hdr, ["balance"]),
      supplied_qty:     sohFindCol(hdr, ["supplied", "supplied qty"]),
      rate:             sohFindCol(hdr, ["rate", "price", "unit price"]),
      value_amt:        sohFindCol(hdr, ["value", "amount"]),
      remark:           sohFindCol(hdr, ["remark", "remarks"]),
      consumable_spare: sohFindCol(hdr, ["mode", "type", "consumable/spare"]),
      source_po_no:     sohFindCol(hdr, ["source po no", "source po"]),
    };
  }
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    if (!row.length) continue;
    const partGet = (idx) => idx == null || idx === -1 ? "" : String(row[idx] == null ? "" : row[idx]).trim();
    const obaraPN = partGet(colMap.obara_part_no);
    const custPN  = partGet(colMap.customer_part_no);
    const desc    = partGet(colMap.description);
    if (!obaraPN && !custPN && !desc) continue;
    const rec = { source_format: fmtKey, format, obara_part_no: obaraPN || null, customer_part_no: custPN || null, description: desc || null };
    const setIf = (key: string, idx: number | null | undefined, fn?: (v: any) => any) => {
      if (idx == null || idx === -1) return;
      const v = row[idx];
      if (v === "" || v == null) return;
      const out2 = fn ? fn(v) : String(v).trim();
      if (out2 !== null && out2 !== "") rec[key] = out2;
    };
    if (fmtKey === "po_format") {
      setIf("sr_no", colMap.sr_no);
      setIf("po_number", colMap.po_number);
      setIf("po_received_date", colMap.po_received_date, sohParseDate);
      setIf("order_date", colMap.po_received_date, sohParseDate);
      setIf("consumable_spare", colMap.consumable_spare);
      setIf("remark", colMap.remark);
      setIf("unit_price", colMap.unit_price, sohParseNum);
      setIf("quantity", colMap.quantity, sohParseQty);
      setIf("total_price", colMap.total_price, sohParseNum);
      setIf("delivered_qty", colMap.delivered_qty, sohParseQty);
      setIf("pending_qty", colMap.pending_qty, sohParseQty);
      setIf("invoice_number", colMap.invoice_number);
      setIf("wo_number", colMap.wo_number);
      setIf("dispatched_on", colMap.dispatched_on, sohParseDate);
      setIf("source_po_no", colMap.source_po_no);
      setIf("docket_no", colMap.docket_no);
      setIf("customer_name", colMap.customer_name);
    } else {
      setIf("order_date", colMap.order_date, sohParseDate);
      setIf("so_number", colMap.so_number);
      setIf("customer_name", colMap.customer_name);
      setIf("drawing_no", colMap.drawing_no);
      setIf("ordered_qty", colMap.ordered_qty, sohParseQty);
      setIf("balance_qty", colMap.balance_qty, sohParseQty);
      setIf("supplied_qty", colMap.supplied_qty, sohParseQty);
      setIf("rate", colMap.rate, sohParseNum);
      setIf("value_amt", colMap.value_amt, sohParseNum);
      setIf("remark", colMap.remark);
      setIf("consumable_spare", colMap.consumable_spare);
      setIf("source_po_no", colMap.source_po_no);
    }
    out.push(rec);
  }
  return out;
};

// ── Top-level: parse one file ──────────────────────────────────
const parseSohFile = async (file) => {
  const name = (file.name || "").toLowerCase();
  const isXlsx = name.endsWith(".xlsx") || name.endsWith(".xls");
  let rows;
  if (isXlsx) {
    const buf = await file.arrayBuffer();
    rows = await parseXlsxSoh(buf);
  } else {
    const text = await file.text();
    rows = parseDelimitedSoh(text);
  }
  if (!rows || !rows.length) return { format: "PO", rows: [] };
  const hi = sohFindHeaderRow(rows);
  const headers = rows[hi] || [];
  const format = detectSoHistoryFormat(headers);
  const built = sohBuildRows(rows, hi, format);
  return { format, rows: built };
};

// ── Top-level: persist parsed rows ─────────────────────────────
const applySohImport = (parsed) => {
  if (!parsed || !Array.isArray(parsed.rows) || !parsed.rows.length) return [];
  const existing = sohLoad();
  const stamped = parsed.rows.map((r) => ({ ...r, format: r.format || parsed.format, imported_at: r.imported_at || new Date().toISOString() }));
  const next = existing.concat(stamped);
  sohSave(next);
  try { window.dispatchEvent(new CustomEvent("soh:change")); } catch (_) {}
  return next;
};

// ── Top-level: trigger a download ──────────────────────────────
const sohDownloadBlob = (filename, blob) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
};
const sohEscCsv = (v) => {
  const s = String(v == null ? "" : v);
  return /[",\n\t]/.test(s) ? `"${s.replace(/"/g, "\"\"")}"` : s;
};
const SOH_EXPORT_HEADERS = [
  "Format", "Date", "Internal Part No", "Customer Part No", "Description", "Customer",
  "PO No", "SO No", "Type", "Qty", "Unit Price", "Total", "Delivered", "Pending",
  "Invoice", "WO", "Dispatched", "Drawing No", "Remark"
];
const sohRowToAoa = (r) => [
  r.format || (r.source_format === "tally_format" ? "Tally" : "PO"),
  r.order_date || r.po_received_date || "",
  r.obara_part_no || "", r.customer_part_no || "", r.description || "", r.customer_name || "",
  r.po_number || "", r.so_number || "",
  r.consumable_spare || "",
  r.quantity ?? r.ordered_qty ?? "",
  r.unit_price ?? r.rate ?? "",
  r.total_price ?? r.value_amt ?? "",
  r.delivered_qty ?? r.supplied_qty ?? "",
  r.pending_qty ?? r.balance_qty ?? "",
  r.invoice_number || "", r.wo_number || "", r.dispatched_on || "", r.drawing_no || "", r.remark || ""
];
const exportSoh = async (format, rows) => {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) { window.notifyWarn?.("Nothing to export", "No SO history rows in scope"); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `SalesOrderHistory_${stamp}`;
  const fmt = String(format || "csv").toLowerCase();
  const aoa = [SOH_EXPORT_HEADERS, ...list.map(sohRowToAoa)];
  if (fmt === "json") {
    sohDownloadBlob(`${base}.json`, new Blob([JSON.stringify(list, null, 2)], { type: "application/json" }));
    return;
  }
  if (fmt === "csv" || fmt === "tsv") {
    const sep = fmt === "tsv" ? "\t" : ",";
    const text = "﻿" + aoa.map((r) => r.map(sohEscCsv).join(sep)).join("\n");
    sohDownloadBlob(`${base}.${fmt}`, new Blob([text], { type: fmt === "tsv" ? "text/tab-separated-values;charset=utf-8" : "text/csv;charset=utf-8" }));
    return;
  }
  // xlsx default
  const X = await ensureXlsx();
  const ws = X.utils.aoa_to_sheet(aoa);
  ws["!cols"] = SOH_EXPORT_HEADERS.map(() => ({ wch: 16 }));
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, "Sales Order History");
  X.writeFile(wb, `${base}.xlsx`);
};

// ── Templates (PO + Tally) ─────────────────────────────────────
const SOH_TEMPLATES = {
  PO: {
    sheet: "PO Format",
    headers: [
      "Sr. No.", "PO No", "PO Received Date", "Customer Part No.", "PO Items",
      "Internal Part No", "Customer", "Consumable/Spare", "Remarks",
      "Final Unit Price", "PO Qty", "Final Total Price", "Delivered Qty", "Pending Qty",
      "Invoice Number", "WO Number", "Dispatched On", "Source PO No", "Docket No.", "Delivery Date"
    ],
    example: [
      "1", "P241220197", "10-12-2024", "GD544202411300001", "ATD CUTTER BLADE",
      "NS ATD CUTTER 13D-AC4-0090", "Pioneer Tool Engineers", "Spare", "",
      9251, 2, 18502, 2, 0,
      "INV-2024-0421", "WO-3344", "12-12-2024", "", "", "12-12-2024"
    ],
    base: "SO_History_Template_PO_Format"
  },
  Tally: {
    sheet: "Tally Format",
    headers: [
      "Date", "Voucher Number", "Sales Order Number", "Customer", "Stock Item",
      "Part No", "Drawing No", "Ordered", "Balance", "Supplied",
      "Rate", "Value", "Mode", "Remark", "Source PO No"
    ],
    example: [
      "21-Jan-25", "POU08-8325", "POU08-8325", "Pioneer Tool Engineers Pvt.Ltd.", "Name Plate WGX-2C16",
      "129-IND", "", "1 No.", "1 No.", "0 No.",
      150, 150, "Stock", "Payment-WO", ""
    ],
    base: "SO_History_Template_Tally_Format"
  }
};
const templateBlob = (format, ext = "csv") => {
  const t = SOH_TEMPLATES[format] || SOH_TEMPLATES.PO;
  if (ext === "csv") {
    const text = "﻿" + [t.headers.map(sohEscCsv).join(","), t.example.map(sohEscCsv).join(",")].join("\n");
    return { blob: new Blob([text], { type: "text/csv;charset=utf-8" }), filename: `${t.base}.csv` };
  }
  return null;
};
const downloadTemplateBundle = async (kind) => {
  // Prefer XLSX when XLSX is reachable; fall back to CSV.
  try {
    const X = await ensureXlsx();
    const t = SOH_TEMPLATES[kind] || SOH_TEMPLATES.PO;
    const ws = X.utils.aoa_to_sheet([t.headers, t.example]);
    ws["!cols"] = t.headers.map((h) => ({ wch: Math.max(12, Math.min(32, (h || "").length + 4)) }));
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, t.sheet);
    X.writeFile(wb, `${t.base}.xlsx`);
  } catch (_) {
    const tpl = templateBlob(kind, "csv");
    if (tpl) sohDownloadBlob(tpl.filename, tpl.blob);
  }
};

// ── Schema SQL (informational) ─────────────────────────────────
const SOH_SCHEMA_SQL = `-- ============================================================
-- sales_history_imports: Historical Sales Order pricing & delivery data
-- (Recommended Postgres shape if a backend table is added.)
-- Supports TWO import formats:
--   1. PO-format (internal delivery tracker)
--   2. Tally-format (Tally ERP / sales voucher export)
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_history_imports (
  id                    BIGSERIAL PRIMARY KEY,
  source_format         TEXT,            -- 'po_format' | 'tally_format'
  sr_no                 TEXT,
  po_number             TEXT,
  so_number             TEXT,
  po_received_date      TEXT,
  order_date            TEXT,
  obara_part_no         TEXT,
  customer_part_no      TEXT,
  description           TEXT,
  drawing_no            TEXT,
  consumable_spare      TEXT,
  unit_price            NUMERIC,
  rate                  NUMERIC,
  quantity              NUMERIC,
  ordered_qty           NUMERIC,
  total_price           NUMERIC,
  value_amt             NUMERIC,
  delivered_qty         NUMERIC,
  pending_qty           NUMERIC,
  supplied_qty          NUMERIC,
  balance_qty           NUMERIC,
  invoice_number        TEXT,
  wo_number             TEXT,
  dispatched_on         TEXT,
  source_po_no          TEXT,
  docket_no             TEXT,
  customer_name         TEXT,
  remark                TEXT,
  raw_data              JSONB,
  imported_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shi_obara_part ON sales_history_imports(obara_part_no);
CREATE INDEX IF NOT EXISTS idx_shi_cust_part  ON sales_history_imports(customer_part_no);
CREATE INDEX IF NOT EXISTS idx_shi_po_number  ON sales_history_imports(po_number);
CREATE INDEX IF NOT EXISTS idx_shi_so_number  ON sales_history_imports(so_number);
CREATE INDEX IF NOT EXISTS idx_shi_customer   ON sales_history_imports(customer_name);
CREATE INDEX IF NOT EXISTS idx_shi_order_date ON sales_history_imports(order_date);

-- RLS: this is internal-tool data; mirror bom_items style.
ALTER TABLE sales_history_imports DISABLE ROW LEVEL SECURITY;
`;

// Expose helpers for command palette / external callers.

// ════════════════════════════════════════════════════════════════
// React surface
// ════════════════════════════════════════════════════════════════
const WiredSOHistory = () => {
  const { useState: u, useEffect: e, useMemo: uM, useRef: uR, useCallback: uC } = React;
  const [rows, setRows] = u(() => sohLoad());
  const [view, setView] = u("imported");           // "imported" | "live"
  const [query, setQuery] = u("");
  const [debouncedQuery, setDebouncedQuery] = u("");
  const [fmtFilter, setFmtFilter] = u("ALL");      // ALL | PO | Tally
  const [typeFilter, setTypeFilter] = u("ALL");    // ALL | Spare | Consumable
  const [drawer, setDrawer] = u(null);             // { partNo } | null
  const [exportOpen, setExportOpen] = u(false);
  const [tplOpen, setTplOpen] = u(false);
  const [schemaOpen, setSchemaOpen] = u(false);
  const [busy, setBusy] = u(false);
  const [drag, setDrag] = u(false);
  const [livePB, setLivePB] = u({ rows: [], loading: false, error: null });
  const fileInputRef = uR(null);

  // Cross-tab / external sync.
  e(() => {
    const onChange = () => setRows(sohLoad());
    const onStorage = (ev) => { if (ev.key === lsKey(SOH_SUFFIX)) setRows(sohLoad()); };
    window.addEventListener("soh:change", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("soh:change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Debounce text filter (100ms) so typing doesn't restyle the table on every keystroke.
  e(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 100);
    return () => clearTimeout(t);
  }, [query]);

  // Esc key closes drawer / popovers.
  e(() => {
    const onKey = (ev) => {
      if (ev.key !== "Escape") return;
      if (drawer) { setDrawer(null); return; }
      if (exportOpen) { setExportOpen(false); return; }
      if (tplOpen) { setTplOpen(false); return; }
      if (schemaOpen) { setSchemaOpen(false); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer, exportOpen, tplOpen, schemaOpen]);

  const filtered = uM(() => {
    const q = debouncedQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (fmtFilter !== "ALL") {
        const f = r.format || (r.source_format === "tally_format" ? "Tally" : "PO");
        if (f !== fmtFilter) return false;
      }
      if (typeFilter !== "ALL") {
        const t = String(r.consumable_spare || "").toLowerCase();
        if (typeFilter === "Spare" && !t.includes("spare")) return false;
        if (typeFilter === "Consumable" && !t.includes("consum")) return false;
      }
      if (!q) return true;
      const hay = [
        r.obara_part_no, r.customer_part_no, r.customer_name,
        r.po_number, r.so_number, r.description
      ].map((v) => String(v || "").toLowerCase()).join(" ");
      return hay.includes(q);
    });
  }, [rows, debouncedQuery, fmtFilter, typeFilter]);

  // KPIs (active rows = filtered).
  const kpis = uM(() => {
    let value = 0;
    const partSet = new Set();
    const custSet = new Set();
    const refSet = new Set();
    filtered.forEach((r) => {
      const v = Number(r.total_price ?? r.value_amt ?? 0);
      if (Number.isFinite(v)) value += v;
      else {
        const p = Number(r.unit_price ?? r.rate ?? 0);
        const q = Number(r.quantity ?? r.ordered_qty ?? 0);
        if (Number.isFinite(p) && Number.isFinite(q)) value += p * q;
      }
      const part = r.obara_part_no || r.customer_part_no;
      if (part) partSet.add(String(part).trim().toUpperCase());
      if (r.customer_name) custSet.add(String(r.customer_name).trim());
      const ref = r.po_number || r.so_number;
      if (ref) refSet.add(String(ref).trim());
    });
    return { records: filtered.length, value, parts: partSet.size, customers: custSet.size, refs: refSet.size };
  }, [filtered]);

  // ── File ingestion ──────────────────────────────────────────
  const ingestFiles = uC(async (fileList) => {
    if (!fileList || !fileList.length) return;
    setBusy(true);
    let totalParsed = 0;
    let formats = new Set();
    const errors = [];
    for (const file of Array.from(fileList) as File[]) {
      try {
        const parsed = await parseSohFile(file);
        if (!parsed.rows.length) { errors.push(`${file.name}: no rows`); continue; }
        applySohImport(parsed);
        totalParsed += parsed.rows.length;
        formats.add(parsed.format);
      } catch (err: any) {
        errors.push(`${file.name}: ${err?.message || err}`);
      }
    }
    setBusy(false);
    setRows(sohLoad());
    if (totalParsed > 0) {
      window.notifySuccess?.(`Imported ${totalParsed} row${totalParsed === 1 ? "" : "s"}`,
        `Format${formats.size === 1 ? "" : "s"}: ${[...formats].join(", ")}`);
    }
    if (errors.length) window.notifyWarn?.("Some files failed", errors.slice(0, 3).join(" · "));
  }, []);

  const onPick = (ev) => { ingestFiles(ev.target.files); ev.target.value = ""; };
  const onDrop = (ev) => { ev.preventDefault(); setDrag(false); ingestFiles(ev.dataTransfer?.files); };
  const onDragOver = (ev) => { ev.preventDefault(); setDrag(true); };
  const onDragLeave = (ev) => { ev.preventDefault(); setDrag(false); };

  // ── Live Price Band tab ─────────────────────────────────────
  const loadLive = uC(async () => {
    setLivePB({ rows: [], loading: true, error: null });
    try {
      // Parts are sourced from the imported set; capped to 30 to avoid hammering the API.
      const partSet = new Map();
      for (const r of rows) {
        const p = (r.obara_part_no || r.customer_part_no || "").trim();
        if (!p) continue;
        const key = p.toUpperCase();
        if (!partSet.has(key)) partSet.set(key, { part_no: key, customer_name: r.customer_name || "" });
        if (partSet.size >= 30) break;
      }
      const targets = [...partSet.values()];
      if (!targets.length) { setLivePB({ rows: [], loading: false, error: null }); return; }
      const results = await Promise.all(targets.map(async (t) => {
        try {
          const resp = await AnvilBackend?.salesHistory?.priceBand?.({ part_no: t.part_no });
          return { ...t, ...(resp || {}) };
        } catch (err) {
          return { ...t, error: err.message || String(err) };
        }
      }));
      setLivePB({ rows: results, loading: false, error: null });
    } catch (err) {
      setLivePB({ rows: [], loading: false, error: err });
    }
  }, [rows]);

  e(() => {
    if (view === "live") loadLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // ── Render ──────────────────────────────────────────────────
  const fmtChip = (f) => f === "Tally" ? <Chip k="info">tally</Chip> : <Chip k="plum">po</Chip>;
  const typeChip = (t) => {
    if (!t) return null;
    const lo = String(t).toLowerCase();
    if (lo.includes("spare")) return <Chip k="good">spare</Chip>;
    if (lo.includes("consum")) return <Chip k="warn">consumable</Chip>;
    return <Chip k="ghost">{lo}</Chip>;
  };
  const inr = (n) => n != null && n !== "" && Number.isFinite(Number(n))
    ? "₹ " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Sales Orders · History"
        title="Sales order history"
        meta={`${rows.length} row${rows.length === 1 ? "" : "s"} · imported + live`}
        right={<>
          <Btn icon kind="ghost" sm onClick={() => setRows(sohLoad())} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="ghost" onClick={() => window.location.hash = "#/so"}>{Icon.arrowL} back to orders</Btn>
        </>}
      />
      <WSTabs
        tabs={[
          { id: "imported", label: "Imported", count: rows.length },
          { id: "live",     label: "Live price band" },
        ]}
        active={view}
        onChange={setView}
      />

      <div className="ws-content">
        {/* Stat row */}
        <Card>
          <KPIRow cols={5}>
            <KPI lbl="Records" v={String(kpis.records)} d={kpis.records === rows.length ? "all rows" : `of ${rows.length}`} />
            <KPI lbl="Total value" v={fmtINRShort(kpis.value)} d="filtered window" dKind={kpis.value > 0 ? "up" : ""} />
            <KPI lbl="Unique parts" v={String(kpis.parts)} d="distinct part_no" />
            <KPI lbl="Customers" v={String(kpis.customers)} d="distinct names" />
            <KPI lbl="PO / SO refs" v={String(kpis.refs)} d="distinct po_so_no" />
          </KPIRow>
        </Card>

        {/* Filter bar */}
        <Card>
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{
              display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center",
              borderRadius: 6,
              outline: drag ? "2px dashed var(--ink)" : "none",
              outlineOffset: 4,
            }}
          >
            <input
              className="input"
              placeholder="filter by part_no / customer / po_so / description…"
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              style={{ width: 320, height: 30 }}
              aria-label="Filter SO history rows"
            />
            <select className="select" style={{ width: 140 }} value={fmtFilter} onChange={(ev) => setFmtFilter(ev.target.value)} aria-label="Format filter">
              <option value="ALL">All formats</option>
              <option value="PO">PO format</option>
              <option value="Tally">Tally format</option>
            </select>
            <select className="select" style={{ width: 160 }} value={typeFilter} onChange={(ev) => setTypeFilter(ev.target.value)} aria-label="Type filter">
              <option value="ALL">All types</option>
              <option value="Spare">Spare</option>
              <option value="Consumable">Consumable</option>
            </select>
            {(query || fmtFilter !== "ALL" || typeFilter !== "ALL") && (
              <Btn sm kind="ghost" onClick={() => { setQuery(""); setFmtFilter("ALL"); setTypeFilter("ALL"); }}>
                {Icon.filterX} clear
              </Btn>
            )}
            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,.tsv,.txt"
                multiple
                onChange={onPick}
                style={{ display: "none" }}
                aria-label="Import SO history files"
              />
              <Btn sm kind={rows.length === 0 ? "primary" : "ghost"} onClick={() => fileInputRef.current?.click()} disabled={busy}>
                {Icon.upload} {busy ? "Parsing…" : "Import"}
              </Btn>
              <div style={{ position: "relative" }}>
                <Btn sm kind={rows.length === 0 ? "primary" : "ghost"} onClick={() => setTplOpen((v) => !v)}>
                  {Icon.doc} Templates {Icon.caret}
                </Btn>
                {tplOpen && (
                  <div role="menu" style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 220,
                    background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 6,
                    boxShadow: "var(--shadow-2)", zIndex: 50, padding: 6,
                  }}>
                    <button className="btn ghost sm full" onClick={() => { downloadTemplateBundle("PO"); setTplOpen(false); }}>PO Format (.xlsx)</button>
                    <button className="btn ghost sm full" onClick={() => { const t = templateBlob("PO", "csv"); if (t) sohDownloadBlob(t.filename, t.blob); setTplOpen(false); }}>PO Format (.csv)</button>
                    <div style={{ height: 1, background: "var(--hairline-2)", margin: "4px 0" }} />
                    <button className="btn ghost sm full" onClick={() => { downloadTemplateBundle("Tally"); setTplOpen(false); }}>Tally Format (.xlsx)</button>
                    <button className="btn ghost sm full" onClick={() => { const t = templateBlob("Tally", "csv"); if (t) sohDownloadBlob(t.filename, t.blob); setTplOpen(false); }}>Tally Format (.csv)</button>
                  </div>
                )}
              </div>
              <div style={{ position: "relative" }}>
                <Btn sm kind="ghost" onClick={() => setExportOpen((v) => !v)} disabled={!filtered.length}>
                  {Icon.download} Export {Icon.caret}
                </Btn>
                {exportOpen && (
                  <div role="menu" style={{
                    position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 160,
                    background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 6,
                    boxShadow: "var(--shadow-2)", zIndex: 50, padding: 6,
                  }}>
                    {["xlsx", "csv", "tsv", "json"].map((f) => (
                      <button key={f} className="btn ghost sm full" onClick={() => { exportSoh(f, filtered); setExportOpen(false); }}>
                        {f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Btn sm kind="ghost" onClick={() => setSchemaOpen(true)}>{Icon.info} Schema</Btn>
            </div>
          </div>
          <div className="mono-sm" style={{ marginTop: 8, color: "var(--ink-4)" }}>
            Drop XLSX, XLS, CSV, TSV, or TXT anywhere in this strip. PO vs Tally is auto-detected.
          </div>
        </Card>

        {/* Imported tab */}
        {view === "imported" && (
          rows.length === 0 ? (
            <Card>
              <div style={{ padding: "28px 12px", textAlign: "center", color: "var(--ink-3)" }}>
                <div className="h2" style={{ marginBottom: 6 }}>Import your first SO history file</div>
                <div className="body" style={{ marginBottom: 14 }}>
                  Drag-drop a PO tracker or Tally export onto the filter strip above, or use the buttons below to grab a template.
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  <Btn kind="primary" sm onClick={() => fileInputRef.current?.click()}>{Icon.upload} Import file</Btn>
                  <Btn kind="ghost" sm onClick={() => downloadTemplateBundle("PO")}>{Icon.doc} PO template</Btn>
                  <Btn kind="ghost" sm onClick={() => downloadTemplateBundle("Tally")}>{Icon.doc} Tally template</Btn>
                </div>
              </div>
            </Card>
          ) : (
            <Card flush>
              <table className="tbl">
                <thead><tr>
                  <th style={{ width: 70 }}>Format</th>
                  <th>Part No</th>
                  <th>Customer</th>
                  <th>PO / SO</th>
                  <th className="r">Qty</th>
                  <th className="r">Rate</th>
                  <th className="r">Value</th>
                  <th>Type</th>
                  <th>Order date</th>
                  <th>Remark</th>
                </tr></thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={10} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                      No rows match the current filters.
                    </td></tr>
                  ) : filtered.slice(0, 1500).map((r, i) => {
                    const part = r.obara_part_no || r.customer_part_no || "";
                    const qty = r.quantity ?? r.ordered_qty;
                    const rate = r.unit_price ?? r.rate;
                    const total = r.total_price ?? r.value_amt ?? (rate && qty ? Number(rate) * Number(qty) : null);
                    const fmt = r.format || (r.source_format === "tally_format" ? "Tally" : "PO");
                    return (
                      <tr key={`${r.imported_at || ""}-${i}`}>
                        <td>{fmtChip(fmt)}</td>
                        <td className="mono">
                          {part ? (
                            <span
                              tabIndex={0}
                              role="link"
                              onClick={() => setDrawer({ partNo: part })}
                              onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setDrawer({ partNo: part }); } }}
                              className="pri"
                              style={{ cursor: "pointer", textDecoration: "none", borderBottom: "1px dotted var(--hairline)" }}
                              onMouseEnter={(ev) => { ev.currentTarget.style.textDecoration = "underline"; }}
                              onMouseLeave={(ev) => { ev.currentTarget.style.textDecoration = "none"; }}
                              title="Reverse search"
                            >
                              {part}
                            </span>
                          ) : "—"}
                          {r.description && <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.description}</div>}
                        </td>
                        <td>{r.customer_name || "—"}</td>
                        <td className="mono-sm">{r.po_number || r.so_number || "—"}</td>
                        <td className="r mono">{qty ?? "—"}</td>
                        <td className="r mono">{inr(rate)}</td>
                        <td className="r mono">{inr(total)}</td>
                        <td>{typeChip(r.consumable_spare)}</td>
                        <td className="mono-sm">{r.order_date || r.po_received_date || "—"}</td>
                        <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.remark || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length > 1500 && (
                <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
                  Showing 1,500 of {filtered.length.toLocaleString("en-IN")} · refine filters to narrow.
                </div>
              )}
            </Card>
          )
        )}

        {/* Live price band tab */}
        {view === "live" && (
          <Card flush>
            <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--hairline-2)", display: "flex", alignItems: "center", gap: 10 }}>
              <span className="h2">Live price band</span>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                aggregated from orders.line_items (last 60 orders)
              </span>
              <div style={{ marginLeft: "auto" }}>
                <Btn icon kind="ghost" sm onClick={loadLive} title="Refresh live">{Icon.cycle}</Btn>
              </div>
            </div>
            {livePB.loading ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading live price band…</div>
            ) : livePB.error ? (
              <div style={{ padding: 14 }}>
                <Banner kind="bad" icon={Icon.alert} title="Could not load live price band">
                  <span className="mono-sm">{String(livePB.error.message || livePB.error)}</span>
                </Banner>
              </div>
            ) : livePB.rows.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                Import some history first — live aggregates use the imported part_no list as keys.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Part No</th>
                  <th>Customer (hint)</th>
                  <th className="r">Sample</th>
                  <th className="r">Last sold</th>
                  <th>At</th>
                  <th className="r">Median</th>
                  <th className="r">Min</th>
                  <th className="r">Max</th>
                </tr></thead>
                <tbody>
                  {livePB.rows.map((r, i) => (
                    <tr key={r.part_no + "-" + i}>
                      <td className="mono"><span className="pri">{r.part_no}</span></td>
                      <td>{r.customer_name || "—"}</td>
                      <td className="r mono">{r.sample ?? 0}</td>
                      <td className="r mono">{inr(r.lastRate)}</td>
                      <td className="mono-sm">{r.lastAt ? new Date(r.lastAt).toLocaleDateString("en-IN") : "—"}</td>
                      <td className="r mono">{inr(r.medianRate)}</td>
                      <td className="r mono">{inr(r.minRate)}</td>
                      <td className="r mono">{inr(r.maxRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
      </div>

      {/* Reverse-search drawer */}
      {drawer && (
        <ReverseSearchDrawer
          partNo={drawer.partNo}
          rows={rows}
          onClose={() => setDrawer(null)}
        />
      )}

      {/* Schema modal */}
      {schemaOpen && (
        <SchemaModal sql={SOH_SCHEMA_SQL} onClose={() => setSchemaOpen(false)} />
      )}
    </>
  );
};

// ── Reverse-search drawer ──────────────────────────────────────
const ReverseSearchDrawer = ({ partNo, rows, onClose }) => {
  const { useState: u, useEffect: e, useMemo: uM } = React;
  const [bom, setBom] = u({ data: [], loading: false, error: null });
  const [pb, setPb] = u({ data: null, loading: false });

  // Pull BOM (gun installations) + live price band on open.
  e(() => {
    let cancel = false;
    setBom({ data: [], loading: true, error: null });
    Promise.resolve(AnvilBackend?.bom?.list?.({ part_no: partNo }) || [])
      .then((resp) => {
        if (cancel) return;
        const list = Array.isArray(resp) ? resp : (resp?.rows || resp?.bom_items || []);
        setBom({ data: list, loading: false, error: null });
      })
      .catch((err) => { if (!cancel) setBom({ data: [], loading: false, error: err }); });

    setPb({ data: null, loading: true });
    Promise.resolve(AnvilBackend?.salesHistory?.priceBand?.({ part_no: partNo }) || null)
      .then((resp) => { if (!cancel) setPb({ data: resp || null, loading: false }); })
      .catch(() => { if (!cancel) setPb({ data: null, loading: false }); });

    return () => { cancel = true; };
  }, [partNo]);

  const localHits = uM(() => {
    const key = String(partNo).toUpperCase();
    return rows.filter((r) => {
      const a = String(r.obara_part_no || "").toUpperCase();
      const b = String(r.customer_part_no || "").toUpperCase();
      return a === key || b === key;
    }).sort((a, b) => String(b.order_date || b.po_received_date || "").localeCompare(String(a.order_date || a.po_received_date || "")));
  }, [rows, partNo]);

  // Aggregate price stats from local hits.
  const stats = uM(() => {
    const prices = localHits.map((r) => Number(r.unit_price ?? r.rate)).filter((n) => Number.isFinite(n) && n > 0);
    const last = localHits.find((r) => Number.isFinite(Number(r.unit_price ?? r.rate)));
    const lastRate = last ? Number(last.unit_price ?? last.rate) : null;
    const lastDate = last ? (last.order_date || last.po_received_date) : null;
    const min = prices.length ? Math.min(...prices) : null;
    const max = prices.length ? Math.max(...prices) : null;
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    const totalRevenue = localHits.reduce((s, r) => {
      const v = Number(r.total_price ?? r.value_amt);
      if (Number.isFinite(v)) return s + v;
      const p = Number(r.unit_price ?? r.rate);
      const q = Number(r.quantity ?? r.ordered_qty);
      return s + (Number.isFinite(p) && Number.isFinite(q) ? p * q : 0);
    }, 0);
    const totalQty = localHits.reduce((s, r) => s + (Number(r.quantity ?? r.ordered_qty) || 0), 0);
    return { lastRate, lastDate, min, max, avg, totalRevenue, totalQty, sample: prices.length };
  }, [localHits]);

  // Group BOM by gun_no (or gun_number) → sum installed qty.
  const guns = uM(() => {
    const map = new Map();
    (bom.data || []).forEach((b) => {
      const g = b.gun_no || b.gun_number || "UNKNOWN";
      const cur = map.get(g) || { gun_no: g, qty: 0 };
      cur.qty += Number(b.qty) || 0;
      map.set(g, cur);
    });
    return [...map.values()].sort((a, b) => String(a.gun_no).localeCompare(String(b.gun_no)));
  }, [bom.data]);

  const inr = (n) => n != null && n !== "" && Number.isFinite(Number(n))
    ? "₹ " + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
    : "—";

  return (
    <div
      className="cmdk-bg"
      style={{ padding: 0, alignItems: "stretch", justifyItems: "end" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Reverse search for ${partNo}`}
    >
      <div className="drawer" onClick={(ev) => ev.stopPropagation()} style={{ width: 560 }}>
        <div className="drawer-h">
          <div>
            <div className="h-eyebrow">Reverse search · part_no</div>
            <div className="h2 mono" style={{ marginTop: 2 }}>{partNo}</div>
          </div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close drawer">
            {Icon.x}
          </button>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14, overflow: "auto", flex: 1 }}>
          <KPIRow cols={3}>
            <KPI lbl="Sales rows" v={String(localHits.length)} d={stats.totalQty ? `qty sold: ${stats.totalQty}` : "no qty"} />
            <KPI lbl="Last sold" v={inr(stats.lastRate)} d={stats.lastDate ? `on ${stats.lastDate}` : "—"} dKind={stats.lastRate ? "up" : ""} />
            <KPI lbl="Avg rate" v={inr(stats.avg)} d={`${stats.sample} prices`} />
          </KPIRow>
          <KPIRow cols={2}>
            <KPI lbl="Range (min – max)" v={stats.min != null ? `${inr(stats.min)} – ${inr(stats.max)}` : "—"} d="local imports" />
            <KPI lbl="Total revenue" v={fmtINRShort(stats.totalRevenue)} d="local imports" />
          </KPIRow>

          <Card title="Installed in" eyebrow="bom · gun_no">
            {bom.loading ? (
              <div className="body">Loading BOM…</div>
            ) : guns.length === 0 ? (
              <div className="mono-sm" style={{ color: "var(--ink-4)" }}>
                {bom.error ? "BOM lookup failed (backend optional)." : "Not installed in any gun BOM."}
              </div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {guns.map((g) => (
                  <span key={g.gun_no} className="chip info" style={{ height: 22 }}>
                    {g.gun_no}{g.qty ? <span className="mono-sm" style={{ marginLeft: 6, opacity: 0.85 }}>×{g.qty}</span> : null}
                  </span>
                ))}
              </div>
            )}
          </Card>

          <Card title="Live price band" eyebrow="orders.line_items aggregate">
            {pb.loading ? (
              <div className="body">Loading…</div>
            ) : !pb.data || !pb.data.sample ? (
              <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No live aggregate available for this part.</div>
            ) : (
              <KV rows={[
                ["Sample", String(pb.data.sample)],
                ["Last sold", inr(pb.data.lastRate) + (pb.data.lastAt ? ` · ${new Date(pb.data.lastAt).toLocaleDateString("en-IN")}` : "")],
                ["Median", inr(pb.data.medianRate)],
                ["Min", inr(pb.data.minRate)],
                ["Max", inr(pb.data.maxRate)],
              ]} />
            )}
          </Card>

          <Card title={`Sales order history (${localHits.length})`} eyebrow="local imports" flush>
            {localHits.length === 0 ? (
              <div className="body" style={{ padding: 14, color: "var(--ink-3)" }}>No local imports for this part.</div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Date</th><th>Fmt</th><th>Customer</th><th>Ref</th>
                  <th className="r">Qty</th><th className="r">Rate</th><th className="r">Value</th>
                </tr></thead>
                <tbody>
                  {localHits.slice(0, 50).map((r, i) => {
                    const fmt = r.format || (r.source_format === "tally_format" ? "Tally" : "PO");
                    const qty = r.quantity ?? r.ordered_qty;
                    const rate = r.unit_price ?? r.rate;
                    const total = r.total_price ?? r.value_amt ?? (rate && qty ? Number(rate) * Number(qty) : null);
                    return (
                      <tr key={i}>
                        <td className="mono-sm">{r.order_date || r.po_received_date || "—"}</td>
                        <td>{fmt === "Tally" ? <Chip k="info">tally</Chip> : <Chip k="plum">po</Chip>}</td>
                        <td>{r.customer_name || "—"}</td>
                        <td className="mono-sm">{r.po_number || r.so_number || "—"}</td>
                        <td className="r mono">{qty ?? ""}</td>
                        <td className="r mono">{inr(rate)}</td>
                        <td className="r mono">{inr(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

// ── Schema modal ───────────────────────────────────────────────
const SchemaModal = ({ sql, onClose }) => (
  <div
    className="cmdk-bg"
    onClick={onClose}
    role="dialog"
    aria-modal="true"
    aria-label="Recommended SO history schema"
    style={{ alignItems: "center" }}
  >
    <div onClick={(ev) => ev.stopPropagation()} style={{
      width: "min(820px, 92vw)", maxHeight: "82vh",
      background: "var(--paper)", border: "1px solid var(--ink)", borderRadius: 6,
      boxShadow: "var(--shadow-2)", display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--hairline)" }}>
        <div>
          <div className="h-eyebrow">Recommended Postgres schema</div>
          <div className="h2" style={{ marginTop: 2 }}>sales_history_imports</div>
        </div>
        <Btn icon kind="ghost" sm onClick={() => navigator.clipboard?.writeText(sql).then(() => window.notifySuccess?.("SQL copied"), () => window.notifyError?.("Copy failed"))} style={{ marginLeft: "auto" }}>{Icon.link}</Btn>
        <Btn icon kind="ghost" sm onClick={onClose} aria-label="Close">{Icon.x}</Btn>
      </div>
      <pre style={{
        margin: 0, padding: 16, overflow: "auto", fontFamily: "var(--mono)", fontSize: 11.5,
        color: "var(--ink-2)", background: "var(--paper-2)", flex: 1, whiteSpace: "pre",
      }}>{sql}</pre>
    </div>
  </div>
);


export default WiredSOHistory;
