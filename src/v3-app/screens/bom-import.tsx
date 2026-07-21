import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Card, Chip, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 - wired BOM Import
// Multi-file XLSX/XLS/CSV/TSV/TXT/ZIP ingest. Lazy-loads SheetJS
// (XLSX) + JSZip from CDN, reads each file to a 2D sheet, then maps
// it through the server format engine (/api/bom/parse, registry-
// driven: level / material / supplier part) and imports via
// /api/bom/import (asset + lines -> item_master + bill_of_materials
// with provenance). Falls back to the legacy client mapping + flat
// /api/bom upsert when those endpoints are unavailable, so the
// screen always works. Editable asset/gun no; rich preview; mod diff;
// progress bar; toasts + log. Mounted by app.jsx as
// ROUTES["items-import"]; suggested hash #/items?view=import.
// ============================================================

// ── Parser loaders ───────────────────────────────────────────
// SheetJS + JSZip are bundled deps loaded via dynamic import(), so they
// are served from our own origin. The previous CDN <script> approach is
// blocked by the app CSP (script-src 'self'), which surfaced as
// "Failed to load XLSX from CDN". Vite code-splits these into chunks
// fetched on demand the first time the importer runs.
let __xlsxPromise = null;
const loadXLSX = () => {
  if (typeof window !== "undefined" && window.XLSX && window.XLSX.read) return Promise.resolve(window.XLSX);
  if (__xlsxPromise) return __xlsxPromise;
  __xlsxPromise = import("xlsx").then((m) => {
    const XLSX = (m && m.read) ? m : (m.default || m);
    try { if (typeof window !== "undefined") window.XLSX = XLSX; } catch (_) { /* noop */ }
    return XLSX;
  });
  return __xlsxPromise;
};

let __jszipPromise = null;
const loadJSZipForBom = () => {
  if (typeof window !== "undefined" && window.JSZip) return Promise.resolve(window.JSZip);
  if (__jszipPromise) return __jszipPromise;
  __jszipPromise = import("jszip").then((m) => {
    const JSZip = m.default || m;
    try { if (typeof window !== "undefined") window.JSZip = JSZip; } catch (_) { /* noop */ }
    return JSZip;
  });
  return __jszipPromise;
};

// ── Origin detection from filename ──────────────────────────
// Returns one of: O-KOREA, O-CHINA, O-JAPAN, O-INDIA.
const detectOrigin = (filename) => {
  const f = String(filename || "").toLowerCase();
  if (/(korea|kr[-_ ])/.test(f) || f.startsWith("ixm") || /(^|[-_ ])kr[-_ ]/.test(f)) return "O-KOREA";
  if (/(china|cn[-_ ])/.test(f) || /(^|[-_ ])cn[-_ ]/.test(f) || /(\bchn\b)/.test(f)) return "O-CHINA";
  if (/(japan|jp[-_ ])/.test(f) || /(^|[-_ ])jp[-_ ]/.test(f) || /(\bjpn\b)/.test(f)) return "O-JAPAN";
  if (/(india|in[-_ ])/.test(f) || /(^|[-_ ])in[-_ ]/.test(f) || /(\bind\b)/.test(f)) return "O-INDIA";
  return "O-INDIA";
};

const ORIGIN_CHIP_KIND = {
  "O-KOREA": "info",
  "O-CHINA": "warn",
  "O-JAPAN": "good",
  "O-INDIA": "ghost",
};
const ORIGIN_LABEL = {
  "O-KOREA": "Korea",
  "O-CHINA": "China",
  "O-JAPAN": "Japan",
  "O-INDIA": "India",
};

// Strip extension and take a model-code-looking core (letters+digits, hyphen, slash).
const detectGunNo = (filename) => {
  const stem = String(filename || "").replace(/\.[A-Za-z0-9]+$/, "");
  const m = stem.match(/[A-Z0-9][A-Z0-9_\-\/]{2,}[A-Z0-9]/i);
  if (m && m[0]) return m[0].toUpperCase();
  return stem.toUpperCase();
};

// ── Delimited parsing (CSV/TSV/TXT) ─────────────────────────
const parseDelimited = (text) => {
  const t = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!t.trim()) return [];
  // Auto-detect delimiter from the first 4kb sample.
  const sample = t.slice(0, 4096);
  let delim = ",";
  if (sample.indexOf("\t") !== -1) delim = "\t";
  else if (sample.indexOf(";") !== -1 && sample.indexOf(",") === -1) delim = ";";
  const lines = t.split("\n").filter((ln) => ln.length > 0);
  const out = [];
  for (const ln of lines) {
    // Naïve CSV: handle simple quoted fields without escaped quotes.
    const cells = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < ln.length; i++) {
      const ch = ln[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === delim && !inQ) { cells.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur);
    out.push(cells.map((c) => c.trim()));
  }
  return out;
};

// ── XLSX parsing ────────────────────────────────────────────
const parseXlsx = async (arrayBuffer) => {
  const XLSX = await loadXLSX();
  const wb = XLSX.read(arrayBuffer, { type: "array", raw: false, cellDates: false });
  // Pick the sheet with the largest populated range (Korea exports leave Sheet1 empty).
  let bestName = wb.SheetNames[0];
  let bestScore = -1;
  for (const name of wb.SheetNames) {
    const sh = wb.Sheets[name];
    if (!sh || !sh["!ref"]) continue;
    const m = String(sh["!ref"]).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const colsW = XLSX.utils.decode_col(m[3]) - XLSX.utils.decode_col(m[1]) + 1;
    const rowsH = parseInt(m[4], 10) - parseInt(m[2], 10) + 1;
    const score = colsW * rowsH;
    if (score > bestScore) { bestScore = score; bestName = name; }
  }
  return XLSX.utils.sheet_to_json(wb.Sheets[bestName], { header: 1, defval: "" }) || [];
};

// ── ZIP expansion ───────────────────────────────────────────
const parseZip = async (arrayBuffer: ArrayBuffer) => {
  const JSZip: any = await loadJSZipForBom();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const out: Array<{ name: string; content: ArrayBuffer }> = [];
  const entries = (Object.values(zip.files) as any[]).filter((e) => !e.dir);
  for (const entry of entries) {
    const ext = (entry.name.split(".").pop() || "").toLowerCase();
    if (ext === "zip") continue; // disallow nested ZIPs
    const banned = new Set(["exe", "dll", "bat", "cmd", "sh", "js", "vbs", "ps1", "jar", "msi", "scr", "com"]);
    if (banned.has(ext)) continue;
    if (!["xlsx", "xls", "csv", "tsv", "txt"].includes(ext)) continue;
    const buf = await entry.async("arraybuffer");
    out.push({ name: entry.name, content: buf });
  }
  return out;
};

// ── Header detection + row extraction ───────────────────────
const PART_NO_LABELS  = ["part no", "part no.", "part number", "partno", "part_no", "item no", "item no.", "parts code", "product code", "child", "child_part"];
const PART_NAME_LABELS = ["part name", "part_name", "name", "description", "item name", "parts name", "product name", "desc"];
const QTY_LABELS       = ["qty", "quantity", "q'ty", "q'ty.", "needed qty", "req qty"];
const UOM_LABELS       = ["uom", "unit", "u/m", "unit of measure"];

const findHeaderRow = (rows) => {
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    if (!rows[i]) continue;
    const normed = rows[i].map((c) => String(c == null ? "" : c).toLowerCase().replace(/\s+/g, " ").trim());
    const hasPN = normed.some((n) => PART_NO_LABELS.includes(n));
    const hasPName = normed.some((n) => PART_NAME_LABELS.includes(n));
    if (hasPN && hasPName) return i;
  }
  // Fall back to the row with the most non-empty cells.
  let maxCells = 0;
  let hi = -1;
  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    if (!rows[i]) continue;
    const ne = rows[i].filter((c) => String(c == null ? "" : c).trim()).length;
    if (ne > maxCells) { maxCells = ne; hi = i; }
  }
  return hi;
};

const idxOf = (hdr, labels) => {
  for (let i = 0; i < hdr.length; i++) {
    const norm = String(hdr[i] == null ? "" : hdr[i]).toLowerCase().replace(/\s+/g, " ").trim();
    if (labels.includes(norm)) return i;
  }
  return -1;
};

// Hierarchy level inferred from leading whitespace / explicit "L1/L2/L3" in part name.
const inferHierarchyLevel = (val) => {
  const s = String(val == null ? "" : val);
  // Explicit L1 / L2 / L3 prefix
  const m = s.match(/^\s*L([0-9])\b/i);
  if (m) return Math.max(1, Math.min(9, parseInt(m[1], 10)));
  // Indentation: every two leading spaces or one tab = one level.
  const lead = (s.match(/^[\s\t]*/) || [""])[0];
  const tabs = (lead.match(/\t/g) || []).length;
  const spaces = lead.replace(/\t/g, "").length;
  const level = 1 + tabs + Math.floor(spaces / 2);
  return Math.max(1, Math.min(9, level));
};

const extractItems = (rows2d) => {
  if (!rows2d || !rows2d.length) return { items: [], headerRow: -1 };
  const hi = findHeaderRow(rows2d);
  if (hi === -1) return { items: [], headerRow: -1 };
  const hdr = rows2d[hi] || [];
  const ciPart = idxOf(hdr, PART_NO_LABELS);
  const ciName = idxOf(hdr, PART_NAME_LABELS);
  const ciQty  = idxOf(hdr, QTY_LABELS);
  const ciUom  = idxOf(hdr, UOM_LABELS);
  if (ciPart === -1) return { items: [], headerRow: hi };
  const items = [];
  for (let r = hi + 1; r < rows2d.length; r++) {
    const row = rows2d[r] || [];
    const partRaw = String(row[ciPart] == null ? "" : row[ciPart]).trim();
    if (!partRaw) continue;
    const nameRaw = ciName !== -1 ? String(row[ciName] == null ? "" : row[ciName]) : "";
    const qtyRaw  = ciQty  !== -1 ? row[ciQty]  : 1;
    const uomRaw  = ciUom  !== -1 ? String(row[ciUom] == null ? "" : row[ciUom]).trim() : "";
    const qtyN = Number(String(qtyRaw).replace(/[^0-9.\-]/g, "")) || 1;
    items.push({
      part_no: partRaw,
      description: String(nameRaw).trim(),
      qty: qtyN,
      uom: uomRaw || null,
      hierarchy_level: inferHierarchyLevel(nameRaw || partRaw),
    });
  }
  return { items, headerRow: hi };
};

// ── File parsing entry point ────────────────────────────────
// Read a file to a 2D array of cells (the SheetJS {header:1} shape).
const readRows = async (file) => {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const buf = await file.arrayBuffer();
    return await parseXlsx(buf);
  }
  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    const text = await file.text();
    return parseDelimited(text);
  }
  throw new Error("Unsupported extension: ." + ext);
};

// Map a parsed sheet to normalized BOM line items. Prefers the server
// format engine (/api/bom/parse) which is registry-driven and captures
// level / material / supplier part. Falls back to the shallow client
// mapping so the screen keeps working if the backend is not reachable.
const parseRowsRich = async (rows, fileName) => {
  try {
    if (AnvilBackend?.bom?.parse) {
      const resp = await AnvilBackend.bom.parse({ rows, file_name: fileName });
      if (resp && Array.isArray(resp.lines) && resp.lines.length) {
        const items = resp.lines.map((ln) => ({
          part_no: ln.part_no,
          description: ln.part_name || "",
          qty: ln.qty != null ? ln.qty : 1,
          uom: ln.uom || null,
          hierarchy_level: ln.level || 1,
          level: ln.level != null ? ln.level : null,
          material: ln.material || null,
          supplier_part_no: ln.supplier_part_no || null,
          side: ln.side || null,
          std_category: ln.std_category || null,
          remarks: ln.remarks || null,
        }));
        return { items, source_format: resp.source_format || null, asset: resp.asset || null };
      }
    }
  } catch (_) { /* fall through to client mapping */ }
  const { items } = extractItems(rows);
  return {
    items: items.map((it) => ({ ...it, level: it.hierarchy_level || null, material: null, supplier_part_no: null })),
    source_format: null,
    asset: null,
  };
};

// Convert a parsed-zip entry into a File-like object so parseBomFile() works.
const entryToFile = (entry) => {
  const blob = new Blob([entry.content]);
  return new File([blob], entry.name, { type: blob.type });
};

// Existing BOM rows for the gun_no, used for mod-detection diff.
const fetchExistingBomChildren = async (gunNo) => {
  try {
    if (!gunNo) return null;
    if (!AnvilBackend?.bom?.list) return null;
    const resp = await AnvilBackend.bom.list({ parent: gunNo });
    const arr = Array.isArray(resp) ? resp : (resp?.rows || resp?.bom || []);
    const set = new Set();
    arr.forEach((r) => {
      const c = r.child_part_no || r.child || r.child_item;
      if (c) set.add(String(c).trim().toUpperCase());
    });
    return set;
  } catch (_) {
    return null;
  }
};

// Compute additions/removals for the mod chip.
const computeDiff = (existingSet, items) => {
  if (!existingSet) return null;
  const incoming = new Set(items.map((it) => String(it.part_no).trim().toUpperCase()));
  let added = 0;
  incoming.forEach((p) => { if (!existingSet.has(p)) added += 1; });
  let removed = 0;
  existingSet.forEach((p) => { if (!incoming.has(p)) removed += 1; });
  return { added, removed };
};

// ── React component ─────────────────────────────────────────
const WiredBomImport = () => {
  const [files, setFiles] = useState([]);          // [{id, name, origin, gunNo, items, status, error, expanded, diff}]
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [logLines, setLogLines] = useState([]);
  const [parserLoading, setParserLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);
  const idRef = useRef(0);

  const log = (line) => setLogLines((arr) => [...arr, line]);

  const upsertFile = (id, patch) => {
    setFiles((arr) => arr.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const removeFile = (id) => {
    setFiles((arr) => arr.filter((f) => f.id !== id));
  };

  const ingestOne = async (file) => {
    const id = ++idRef.current;
    const origin = detectOrigin(file.name);
    const gunNo = detectGunNo(file.name);
    setFiles((arr) => [...arr, {
      id, name: file.name, origin, gunNo,
      items: [], status: "parsing", error: "",
      expanded: false, diff: null, sourceFormat: null, _file: file,
    }]);
    try {
      const rows = await readRows(file);
      const { items, source_format, asset } = await parseRowsRich(rows, file.name);
      if (!items.length) throw new Error("No item rows detected (header not found)");
      // The engine's detected asset code beats the filename guess.
      const resolvedGun = (asset && asset.asset_code) || gunNo;
      // Mod-detection diff against existing BOM (best-effort; non-fatal).
      const existing = await fetchExistingBomChildren(resolvedGun);
      const diff = computeDiff(existing, items);
      const status = items.length > 1000 ? "warn" : "good";
      upsertFile(id, { items, status, diff, gunNo: resolvedGun, sourceFormat: source_format });
    } catch (err) {
      upsertFile(id, { items: [], status: "bad", error: String(err.message || err) });
    }
  };

  const ingestList = async (rawList: FileList | File[]) => {
    const list = Array.from(rawList || []) as File[];
    if (!list.length) return;
    // Show "Loading parser…" the first time we touch XLSX or ZIP.
    const hasXlsx = list.some((f) => /\.(xlsx|xls)$/i.test(f.name));
    const hasZip  = list.some((f) => /\.zip$/i.test(f.name));
    if ((hasXlsx && !window.XLSX) || (hasZip && !window.JSZip)) {
      setParserLoading(true);
      try {
        if (hasXlsx) await loadXLSX();
        if (hasZip)  await loadJSZipForBom();
      } catch (err: any) {
        window.notifyError?.("Parser load failed", String(err?.message || err));
      }
      setParserLoading(false);
    }

    // Expand any ZIPs first.
    const flat: File[] = [];
    for (const f of list) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (ext === "zip") {
        try {
          const buf = await f.arrayBuffer();
          const inner = await parseZip(buf);
          for (const entry of inner) flat.push(entryToFile(entry));
        } catch (err: any) {
          window.notifyError?.("ZIP unpack failed", f.name + " · " + (err?.message || err));
        }
      } else if (["xlsx", "xls", "csv", "tsv", "txt"].includes(ext)) {
        flat.push(f);
      } else {
        window.notifyWarn?.("Skipped", f.name + " · unsupported extension");
      }
    }

    // Parse each file in parallel; UI updates are independent per row.
    await Promise.all(flat.map((f) => ingestOne(f)));
  };

  const onDrop = (ev) => {
    ev.preventDefault();
    setDragActive(false);
    if (ev.dataTransfer?.files?.length) ingestList(ev.dataTransfer.files);
  };

  const onDragOver = (ev) => { ev.preventDefault(); setDragActive(true); };
  const onDragLeave = (ev) => { ev.preventDefault(); setDragActive(false); };

  const onPick = (ev) => {
    if (ev.target.files?.length) ingestList(ev.target.files);
    ev.target.value = "";
  };

  const importable = files.filter((f) => f.status !== "bad" && f.items.length > 0);
  const canImport = !importing && importable.length > 0 && files.every((f) => f.status !== "parsing");

  const doImportAll = async () => {
    if (!canImport) return;
    setImporting(true);
    setLogLines([]);
    setProgress({ done: 0, total: importable.length, current: "" });
    let okCount = 0;
    let errCount = 0;
    for (let i = 0; i < importable.length; i++) {
      const f = importable[i];
      setProgress({ done: i, total: importable.length, current: f.name });
      try {
        if (AnvilBackend?.bom?.importBom) {
          // Rich path: asset + lines -> item_master + bill_of_materials,
          // with provenance. The server computes + returns the diff.
          const asset = {
            asset_code: f.gunNo,
            source_format: f.sourceFormat || undefined,
            source_country: f.origin || undefined,
          };
          const lines = f.items.map((it) => ({
            part_no: it.part_no,
            part_name: it.description || null,
            qty: it.qty != null ? it.qty : 1,
            uom: it.uom || null,
            level: it.level != null ? it.level : (it.hierarchy_level || null),
            material: it.material || null,
            supplier_part_no: it.supplier_part_no || null,
            side: it.side || null,
            std_category: it.std_category || null,
            remarks: it.remarks || null,
          }));
          const resp = await AnvilBackend.bom.importBom({ asset, lines, file_name: f.name, source_format: f.sourceFormat || undefined });
          if (!resp || resp.ok === false) throw new Error((resp && resp.error && resp.error.message) || "Import failed");
          const d = resp.diff;
          const der = resp.derived;
          log(f.name + " - imported " + (resp.lines != null ? resp.lines : lines.length) + " lines"
            + (d ? " (+" + d.added + "/-" + d.removed + "/~" + d.changed + ")" : "")
            + (der ? "; " + der.items_upserted + " items, " + der.edges_upserted + " edges" : ""));
        } else {
          // Fallback: legacy flat upsert (keeps working if importBom is
          // not deployed). Matches the original api/bom POST schema.
          const rows = f.items.map((it) => ({
            parent_part_no: f.gunNo,
            child_part_no: it.part_no,
            qty: it.qty || 1,
            uom: it.uom,
            notes: [
              it.description ? "desc=" + it.description : "",
              "origin=" + f.origin,
              "level=" + (it.level || it.hierarchy_level || 1),
            ].filter(Boolean).join(" - "),
          }));
          const resp = await AnvilBackend?.bom?.upsert?.({ rows });
          if (!resp) throw new Error("Backend not configured");
          const n = resp.count != null ? resp.count : rows.length;
          log(f.name + " - " + n + " row" + (n === 1 ? "" : "s") + " imported (legacy)");
        }
        upsertFile(f.id, { status: "good" });
        okCount += 1;
      } catch (err) {
        const msg = String(err.message || err);
        log(f.name + " - ERROR: " + msg);
        upsertFile(f.id, { status: "bad", error: msg });
        errCount += 1;
      }
    }
    setProgress({ done: importable.length, total: importable.length, current: "" });
    setImporting(false);
    if (errCount === 0) {
      window.notifySuccess?.("Imported " + okCount + " file" + (okCount === 1 ? "" : "s"), "BOM rows upserted to Supabase.");
      // Clear queue on full success.
      setFiles([]);
    } else {
      window.notifyError?.("Import completed with errors", okCount + " ok · " + errCount + " failed");
    }
  };

  // Drop-zone styling
  const dropStyle: React.CSSProperties = {
    border: "2px dashed " + (dragActive ? "var(--accent)" : "var(--hairline)"),
    borderRadius: 12,
    padding: "28px 18px",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 120ms ease, background 120ms ease",
    background: dragActive ? "var(--paper-2)" : undefined,
  };

  return (
    <>
      <WSTitle
        eyebrow="Data · Items · BOM Import"
        title="Import Bill of Materials"
        meta="multi-file · xlsx / xls / csv / tsv / txt / zip · origin auto-detected"
        right={<>
          <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/items?view=drawing")}>{Icon.upload} from drawing</Btn>
          <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/items")}>{Icon.arrowL} back to Items</Btn>
        </>}
      />

      <div className="ws-content">
        {/* ── Card 1 · Drop zone ─────────────────────────────── */}
        <Card title="Drop files" eyebrow="step 1">
          <div
            className={`dotgrid ${dragActive ? "active" : ""}`}
            style={dropStyle}
            onClick={() => fileInputRef.current?.click()}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            role="button"
            tabIndex={0}
            aria-label="Drop BOM files here"
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
              <span style={{ width: 32, height: 32, display: "grid", placeItems: "center", color: "var(--ink-2)" }}>{Icon.upload}</span>
              <div className="h2" style={{ margin: 0 }}>Drag XLSX, XLS, CSV, TSV, or ZIP files here</div>
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Origin auto-detected from filename. Most users only need XLSX. Hierarchy markers come from indentation or explicit L1/L2/L3.
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <Btn sm kind="primary" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                  {Icon.plus} Choose files
                </Btn>
                {parserLoading && <Chip k="info">Loading parser…</Chip>}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.tsv,.txt,.zip"
              style={{ display: "none" }}
              onChange={onPick}
            />
          </div>
        </Card>

        {/* ── Card 2 · File queue ─────────────────────────────── */}
        <Card title="File queue" eyebrow="step 2"
              right={files.length ? <Chip k="info">{files.length} file{files.length === 1 ? "" : "s"}</Chip> : null}
              flush>
          {!files.length ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No files yet. Drop or pick BOM exports above.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Filename</th>
                <th>Origin</th>
                <th>Gun no.</th>
                <th className="r">Items</th>
                <th>Status</th>
                <th>Mod</th>
                <th style={{ width: 140 }}></th>
              </tr></thead>
              <tbody>
                {files.map((f) => {
                  const statusChip =
                    f.status === "parsing" ? <Chip k="info">parsing…</Chip> :
                    f.status === "good" ? <Chip k="good">good</Chip> :
                    f.status === "warn" ? <Chip k="warn">warn</Chip> :
                    f.status === "bad" ? <Chip k="bad">error</Chip> :
                    <Chip k="ghost">{f.status}</Chip>;
                  const modChip = f.diff
                    ? (f.diff.added === 0 && f.diff.removed === 0
                        ? <Chip k="ghost">no change</Chip>
                        : <Chip k={f.diff.removed > 0 ? "warn" : "info"}>+{f.diff.added} −{f.diff.removed}</Chip>)
                    : <span className="mono-sm" style={{ color: "var(--ink-4)" }}>-</span>;
                  return (
                    <React.Fragment key={f.id}>
                      <tr>
                        <td>
                          <span className="pri">{f.name}</span>
                          {f.sourceFormat ? <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 2 }}>format: {f.sourceFormat}</div> : null}
                          {f.error ? <div className="mono-sm" style={{ color: "var(--bad)", marginTop: 2 }}>{f.error}</div> : null}
                        </td>
                        <td><Chip k={ORIGIN_CHIP_KIND[f.origin] || "ghost"}>{ORIGIN_LABEL[f.origin] || f.origin}</Chip></td>
                        <td>
                          <input
                            className="mono"
                            value={f.gunNo}
                            onChange={(e) => upsertFile(f.id, { gunNo: e.target.value.toUpperCase() })}
                            style={{
                              width: 160, padding: "4px 8px",
                              border: "1px solid var(--hairline)", borderRadius: 6,
                              background: "var(--paper)", color: "var(--ink)", fontSize: 12,
                            }}
                            aria-label={"Gun number for " + f.name}
                          />
                        </td>
                        <td className="r mono">{f.items.length}</td>
                        <td>{statusChip}</td>
                        <td>{modChip}</td>
                        <td>
                          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                            <Btn sm kind="ghost" onClick={() => upsertFile(f.id, { expanded: !f.expanded })}>
                              {f.expanded ? "hide" : "preview"}
                            </Btn>
                            <Btn sm kind="ghost" onClick={() => {
                              if (f.items.length > 0 && !window.confirm("Remove " + f.name + " (" + f.items.length + " rows)?")) return;
                              removeFile(f.id);
                            }}>{Icon.x}</Btn>
                          </div>
                        </td>
                      </tr>
                      {f.expanded && (
                        <tr>
                          <td colSpan={7} style={{ background: "var(--paper-2)", padding: 0 }}>
                            <div style={{ padding: 12 }}>
                              {f.status === "bad" ? (
                                <Banner kind="bad" icon={Icon.alert} title={"Failed to parse " + f.name}>
                                  <span className="mono-sm">{f.error || "Unknown error"}</span>
                                </Banner>
                              ) : f.items.length === 0 ? (
                                <div className="mono-sm" style={{ color: "var(--ink-4)" }}>No rows.</div>
                              ) : (
                                <>
                                  <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>
                                    Showing first {Math.min(20, f.items.length)} of {f.items.length} parsed rows.
                                  </div>
                                  <table className="tbl">
                                    <thead><tr>
                                      <th>Item #</th>
                                      <th>Description</th>
                                      <th>Material</th>
                                      <th>Supplier part</th>
                                      <th className="r">Qty</th>
                                      <th>UoM</th>
                                      <th className="r">Level</th>
                                    </tr></thead>
                                    <tbody>
                                      {f.items.slice(0, 20).map((it, i) => (
                                        <tr key={i}>
                                          <td className="mono"><span className="pri">{it.part_no}</span></td>
                                          <td>{it.description || "-"}</td>
                                          <td className="mono-sm">{it.material || "-"}</td>
                                          <td className="mono-sm">{it.supplier_part_no || "-"}</td>
                                          <td className="r mono">{it.qty}</td>
                                          <td className="mono-sm">{it.uom || "-"}</td>
                                          <td className="r mono">{(it.level || it.hierarchy_level) ? "L" + (it.level || it.hierarchy_level) : "-"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        {/* ── Card 3 · Import action ──────────────────────────── */}
        <Card title="Import" eyebrow="step 3"
              right={<Btn sm kind="primary" disabled={!canImport} onClick={doImportAll}>
                {importing ? "Importing…" : <>{Icon.upload} Import all to Supabase</>}
              </Btn>}>
          {!files.length ? (
            <div className="mono-sm" style={{ color: "var(--ink-4)" }}>
              Add files above. The button activates when at least one parsed file is in the queue.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                {progress.total > 0 && importing
                  ? <>Importing file {progress.done + 1} of {progress.total}{progress.current ? " · " + progress.current : ""}</>
                  : <>{importable.length} file{importable.length === 1 ? "" : "s"} ready · {importable.reduce((s, f) => s + f.items.length, 0)} rows total</>}
              </div>
              <div style={{
                height: 8, background: "var(--paper-2)", borderRadius: 999,
                border: "1px solid var(--hairline-2)", overflow: "hidden",
              }} role="progressbar"
                 aria-valuemin={0}
                 aria-valuemax={progress.total || 1}
                 aria-valuenow={progress.done}>
                <div style={{
                  height: "100%",
                  width: progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) + "%" : "0%",
                  background: "var(--accent)",
                  transition: "width 200ms ease",
                }} />
              </div>
              {logLines.length > 0 && (
                <div style={{
                  marginTop: 4, padding: 10, borderRadius: 8,
                  background: "var(--paper-2)", border: "1px solid var(--hairline-2)",
                  fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12,
                  maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap",
                }}>
                  {logLines.map((ln, i) => (
                    <div key={i} style={{ color: ln.includes("ERROR:") ? "var(--bad)" : "var(--ink-2)" }}>{ln}</div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredBomImport;
