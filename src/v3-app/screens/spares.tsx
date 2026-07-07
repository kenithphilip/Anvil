import React, { useEffect, useMemo, useRef, useState } from "react";
import { fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { matchSpares, SPARE_PRESETS, isConsumableCol, nameMatchCandidates, type SpareBomItem } from "../lib/spare-match";
import { lsGet } from "../lib/storage-keys";

// ============================================================
// ANVIL v3 — Spare Matrix Worksheet
// Customer + Project scoped grid with inline editing, autosave,
// import/export, auto-fill from BOMs, and recommended-spares sync.
// Overrides the minimal wired-spares-c.jsx via window.SparesMatrix.
// ============================================================

const SM_LS_SUFFIX = "v3_spare_matrices";
const SM_IMPORTED_KEY = "anvil:v3_spare_matrices_imported";
// xlsx is a bundled dep loaded via dynamic import (CSP blocks CDN scripts).

// ---------- helpers ----------------------------------------------------
const smUid = () => "mx_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// Legacy localStorage matrices (pre-server, migration 159). Read-only
// now — kept as a safety-net backup + one-time import source; never
// written to. Server is the source of truth (spareMatrix.* endpoints).
const smReadAll = () => {
  try {
    const raw = lsGet(SM_LS_SUFFIX);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
};

// ── Server <-> component-shape adapters ──────────────────────────────
// Component shape: { id, customer_id, project_name, name, updated_at,
//   cols:[{id, col_name, col_type, locked}],
//   rows:[{id, gun_no, qty, values:{col_name:parts}, +station fields}] }
// Local ids (smUid) are React keys ONLY; toServer() OMITS child ids so a
// save FULL-REPLACES columns+rows (safe: recommended_spares keys on
// matrix_id+part_no+description, not on row/col ids — no id round-trip).
const fromHeader = (h) => ({
  id: h.id, customer_id: h.customer_id || null,
  project_name: h.project_name || "", name: h.name || "", updated_at: h.updated_at || null,
});

const fromServer = (full) => {
  const m = (full && full.matrix) || {};
  return {
    id: m.id,
    customer_id: m.customer_id || null,
    project_name: m.project_name || "",
    name: m.name || "",
    updated_at: m.updated_at || null,
    cols: ((full && full.columns) || []).map((c) => ({ id: c.id || smUid(), col_name: c.col_name || "", col_type: c.category || "spare", locked: !!c.locked })),
    rows: ((full && full.rows) || []).map((r) => ({
      id: r.id || smUid(),
      gun_no: r.gun_no || "",
      qty: r.qty != null ? r.qty : 1,
      values: (r.spare_values && typeof r.spare_values === "object") ? r.spare_values : {},
      sr_no: r.sr_no || "", line: r.line || "", station_no: r.station_no || "", robot_no: r.robot_no || "",
      gun_type: r.gun_type || "", l_qty: r.l_qty != null ? r.l_qty : "", r_qty: r.r_qty != null ? r.r_qty : "", timer: r.timer || "", atd: r.atd || "",
    })),
    recommended: (full && full.recommended) || [],
  };
};

const numOrNull = (v) => (v === "" || v == null ? null : Number(v));
const toServer = (matrix) => ({
  header: { customer_id: matrix.customer_id || null, project_name: matrix.project_name || null, name: matrix.name || null },
  columns: (matrix.cols || []).map((c, i) => ({ col_name: c.col_name, category: c.col_type || null, locked: !!c.locked, position: i })),
  rows: (matrix.rows || []).map((r, i) => ({
    position: i,
    gun_no: r.gun_no || null,
    qty: numOrNull(r.qty),
    spare_values: (r.values && typeof r.values === "object") ? r.values : {},
    sr_no: r.sr_no || null, line: r.line || null, station_no: r.station_no || null, robot_no: r.robot_no || null,
    gun_type: r.gun_type || null, l_qty: numOrNull(r.l_qty), r_qty: numOrNull(r.r_qty),
    timer: r.timer || null, atd: r.atd || null,
  })),
});

const smLoadXlsx = (): Promise<any> => {
  if (typeof window !== "undefined" && window.XLSX) return Promise.resolve(window.XLSX);
  return import("xlsx").then((m: any) => {
    const XLSX = (m && m.read) ? m : (m.default || m);
    try { if (typeof window !== "undefined") window.XLSX = XLSX; } catch (_) { /* noop */ }
    return XLSX;
  });
};

const smDownload = (filename, mime, content) => {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
};

// CSV/TSV escape: wrap in quotes if cell contains delimiter, quote, or newline.
const smCsvCell = (v, sep) => {
  const s = v == null ? "" : String(v);
  if (s.includes(sep) || s.includes('"') || s.includes("\n")) return '"' + s.replace(/"/g, '""') + '"';
  return s;
};

const smAoaToDelim = (aoa, sep) => (aoa || []).map((r) => r.map((c) => smCsvCell(c, sep)).join(sep)).join("\n");

const smParseDelim = (text, sep) => {
  const rows = []; let cur = []; let buf = ""; let inQ = false;
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') { if (t[i + 1] === '"') { buf += '"'; i++; } else inQ = false; }
      else buf += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { cur.push(buf); buf = ""; }
      else if (c === "\n") { cur.push(buf); rows.push(cur); cur = []; buf = ""; }
      else buf += c;
    }
  }
  if (buf.length || cur.length) { cur.push(buf); rows.push(cur); }
  return rows.filter((r) => r.length && r.some((x) => String(x).trim() !== ""));
};

const smFmtTs = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

// Fetch the rich BOM lines for one gun/asset code, normalized to the
// { part_no, part_name, material, size } shape the matcher consumes.
// Prefers the imported bom_assets/bom_lines detail (asset_code lookup);
// falls back to flat bill_of_materials children for legacy data.
const smFetchLinesForGun = async (code: string): Promise<SpareBomItem[]> => {
  const c = String(code || "").trim();
  if (!c) return [];
  try {
    if (AnvilBackend?.bom?.assetByCode) {
      const r: any = await AnvilBackend.bom.assetByCode(c);
      const lines = r?.lines || [];
      if (Array.isArray(lines) && lines.length) {
        return lines.map((l: any) => ({
          part_no: l.part_no || l.supplier_part_no || "",
          part_name: l.part_name || "",
          material: l.material || "",
          size: l.size || "",
        }));
      }
    }
  } catch (_) { /* fall through to legacy */ }
  // Legacy fallback: flat bill_of_materials children (no material/size,
  // so only name + part-number matching can apply).
  try {
    const resp: any = await AnvilBackend?.bom?.list?.({ parent: c });
    const rows = Array.isArray(resp) ? resp : (resp?.rows || resp?.bom || []);
    return (rows || []).map((b: any) => ({
      part_no: String(b.child_part_no || b.child_item || b.child || "").trim(),
      part_name: String(b.child_name || b.child_description || "").trim(),
      material: String(b.material || "").trim(),
      size: String(b.size || "").trim(),
    })).filter((l: SpareBomItem) => l.part_no);
  } catch (_) { return []; }
};

// Fixed station-identity columns (reference "Guns Spare Matrix" model),
// rendered as a leading block before the spare-category cols. gun_no is
// the sticky identity column; qty folds in here.
const SM_STATION_COLS = [
  { key: "line", label: "Line", w: 84 },
  { key: "station_no", label: "Station", w: 84 },
  { key: "robot_no", label: "Robot", w: 68 },
  { key: "gun_type", label: "Type", w: 84 },
  { key: "l_qty", label: "L", w: 44, num: true },
  { key: "r_qty", label: "R", w: 44, num: true },
  { key: "timer", label: "Timer", w: 90 },
  { key: "atd", label: "ATD", w: 100 },
  { key: "qty", label: "Qty", w: 52, num: true },
];
const SM_NUM_ROW_FIELDS = new Set(["qty", "l_qty", "r_qty"]);
// Import header aliases for the station-identity columns.
const SM_STATION_ALIASES = {
  line: ["line", "line name"],
  station_no: ["station_no", "station", "station no", "station no.", "s'tn no", "s'tn  no", "station name", "s.tn no"],
  robot_no: ["robot_no", "robot", "robot no", "robot no.", "robot number"],
  gun_type: ["gun_type", "type", "gun type"],
  l_qty: ["l_qty", "l qty", "l-qty", "l q'ty", "l"],
  r_qty: ["r_qty", "r qty", "r-qty", "r q'ty", "r"],
  timer: ["timer"],
  atd: ["atd"],
  qty: ["qty", "quantity", "m"],
};

// ---------- Worksheet pane ---------------------------------------------
const SMWorksheetPane = ({ matrix, onChange, onDelete, customers }) => {
  const { useState: uM, useEffect: eM, useMemo: mM, useRef: rM } = React;

  const [draft, setDraft] = uM(matrix);
  const [saveState, setSaveState] = uM("idle"); // idle | dirty | saving | saved | error
  const [showAddRow, setShowAddRow] = uM(false);
  const [showAddCol, setShowAddCol] = uM(false);
  const [showConfig, setShowConfig] = uM(false);
  const [showImport, setShowImport] = uM(false);
  const [importPreview, setImportPreview] = uM(null);
  const [importErr, setImportErr] = uM("");
  const [showExport, setShowExport] = uM(false);
  const [recView, setRecView] = uM(false);
  const [busyAuto, setBusyAuto] = uM(false);
  const [busySync, setBusySync] = uM(false);
  const [busyFeed, setBusyFeed] = uM(false);
  const [busyFill, setBusyFill] = uM(false);
  const [selRec, setSelRec] = uM<Set<string>>(new Set()); // checked recommended rows to feed
  const [titleEdit, setTitleEdit] = uM(false);
  const debounceRef = rM(null);
  const fileRef = rM(null);

  // Sync external matrix → local draft when matrix.id changes
  eM(() => { setDraft(matrix); setSaveState("idle"); }, [matrix.id]);

  // Debounced autosave on draft change
  eM(() => {
    if (saveState !== "dirty") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaveState("saving");
      const next = { ...draft, updated_at: new Date().toISOString() };
      try {
        await AnvilBackend.spareMatrix.update(next.id, toServer(next));
        onChange(next);
        setSaveState("saved");
        setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1800);
      } catch (err) {
        window.notifyError?.("Autosave failed", String((err && err.message) || err));
        setSaveState("error");
      }
    }, 1000);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, saveState]);

  const dirty = (mut) => setDraft((d) => { setSaveState("dirty"); return mut(d); });

  const customer = mM(() => customers.find((c) => c.id === draft.customer_id), [customers, draft.customer_id]);
  const customerName = customer?.customer_name || customer?.name || draft.customer_id?.slice(0, 8) || "—";

  const totalCells = (draft.rows?.length || 0) * Math.max(1, draft.cols?.length || 0);

  // ------- Add row -------------------------------------------------------
  // Adds a gun/asset row. Spare-category cells are filled by Auto-fill
  // (matchSpares), matching this gun's BOM parts into the category columns
  // - same process as the standalone tool.
  const onAddRow = (fields) => {
    const f = fields || {};
    const code = String(f.gun_no || "").trim();
    if (!code) return;
    setShowAddRow(false);
    dirty((d) => {
      if ((d.rows || []).some((r) => String(r.gun_no || "").toUpperCase() === code.toUpperCase())) {
        window.notifyError?.("Row exists", `"${code}" is already in this matrix.`);
        return d;
      }
      return { ...d, rows: [...(d.rows || []), {
        id: smUid(), gun_no: code, qty: Number(f.qty) || 1, values: {},
        line: f.line || "", station_no: f.station_no || "", robot_no: f.robot_no || "",
        gun_type: f.gun_type || "", l_qty: f.l_qty != null ? f.l_qty : "", r_qty: f.r_qty != null ? f.r_qty : "",
        timer: f.timer || "", atd: f.atd || "",
      }] };
    });
  };

  // ------- Add col -------------------------------------------------------
  // Stays open so several categories can be added in a row (presets); the
  // form closes itself on typed submit / cancel.
  const onAddCol = (col_name, col_type) => {
    const trimmed = String(col_name || "").trim();
    if (!trimmed) return;
    if ((draft.cols || []).some((c) => c.col_name === trimmed)) {
      window.notifyError?.("Column exists", `"${trimmed}" already exists.`);
      return;
    }
    dirty((d) => ({ ...d, cols: [...(d.cols || []), { id: smUid(), col_name: trimmed, col_type: col_type || "spare", locked: false }] }));
  };

  // ------- Cell change ---------------------------------------------------
  const onCellChange = (rowId, colName, val) => {
    dirty((d) => ({
      ...d,
      rows: (d.rows || []).map((r) => r.id === rowId ? { ...r, values: { ...(r.values || {}), [colName]: val } } : r),
    }));
  };

  // ------- Row meta change ----------------------------------------------
  const onRowMetaChange = (rowId, field, val) => {
    dirty((d) => ({
      ...d,
      rows: (d.rows || []).map((r) => r.id === rowId ? { ...r, [field]: SM_NUM_ROW_FIELDS.has(field) ? (val === "" ? "" : (Number(val) || 0)) : val } : r),
    }));
  };

  const onRemoveRow = (rowId) => {
    dirty((d) => ({ ...d, rows: (d.rows || []).filter((r) => r.id !== rowId) }));
  };

  // ------- Configure cols (modal) ---------------------------------------
  const onColMove = (ix, dir) => {
    dirty((d) => {
      const cols = [...(d.cols || [])];
      const j = ix + dir;
      if (j < 0 || j >= cols.length) return d;
      const tmp = cols[ix]; cols[ix] = cols[j]; cols[j] = tmp;
      return { ...d, cols };
    });
  };

  const onColLockToggle = (ix) => {
    dirty((d) => ({ ...d, cols: (d.cols || []).map((c, i) => i === ix ? { ...c, locked: !c.locked } : c) }));
  };

  const onColDelete = (ix) => {
    dirty((d) => {
      const removed = (d.cols || [])[ix];
      if (!removed) return d;
      return {
        ...d,
        cols: (d.cols || []).filter((_, i) => i !== ix),
        rows: (d.rows || []).map((r) => {
          const v = { ...(r.values || {}) }; delete v[removed.col_name]; return { ...r, values: v };
        }),
      };
    });
  };

  const onColRename = (ix, name) => {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    dirty((d) => {
      const old = (d.cols || [])[ix];
      if (!old || old.col_name === trimmed) return d;
      return {
        ...d,
        cols: (d.cols || []).map((c, i) => i === ix ? { ...c, col_name: trimmed } : c),
        rows: (d.rows || []).map((r) => {
          const v = { ...(r.values || {}) };
          if (old.col_name in v) { v[trimmed] = v[old.col_name]; delete v[old.col_name]; }
          return { ...r, values: v };
        }),
      };
    });
  };

  // ------- Auto-fill from BOMs ------------------------------------------
  // Matches each gun's BOM parts INTO the spare-category columns - same
  // engine as the standalone tool (part-name keyword + part-number pattern
  // + copper-material filter for consumables). A cell holds the matched
  // part number(s). Locked columns and manually edited cells are preserved.
  const onAutoFill = async () => {
    const colNames = (draft.cols || []).map((c) => c.col_name);
    if (!colNames.length) {
      window.notifyError?.("Auto-fill", "Add one or more spare columns first (e.g. TIP, SHUNT, ELECTRODE).");
      return;
    }
    const guns = Array.from(new Set((draft.rows || []).map((r) => String(r.gun_no || "").trim()).filter(Boolean)));
    if (!guns.length) {
      window.notifyError?.("Auto-fill", "Add gun/asset rows first.");
      return;
    }
    setBusyAuto(true);
    try {
      const lockedCols = new Set((draft.cols || []).filter((c) => c.locked).map((c) => c.col_name));
      // Fetch each unique gun's rich BOM lines once.
      const linesByGun = new Map<string, SpareBomItem[]>();
      await Promise.all(guns.map(async (code: string) => {
        linesByGun.set(code.toUpperCase(), await smFetchLinesForGun(code));
      }));
      let filled = 0;
      let matchedGuns = 0;
      let emptyGuns = 0;
      dirty((d) => {
        const names = (d.cols || []).map((c) => c.col_name);
        const rows = (d.rows || []).map((r) => {
          const lines = linesByGun.get(String(r.gun_no || "").toUpperCase()) || [];
          if (!lines.length) { emptyGuns += 1; return r; }
          const matched = matchSpares(lines, names);
          const values = { ...(r.values || {}) };
          let any = false;
          names.forEach((col) => {
            if (lockedCols.has(col)) return;
            const val = matched[col];
            if (val && values[col] !== val) { values[col] = val; filled += 1; any = true; }
          });
          if (any) matchedGuns += 1;
          return { ...r, values };
        });
        return { ...d, rows };
      });
      const tail = emptyGuns ? ` ${emptyGuns} gun(s) had no imported BOM.` : "";
      window.notifySuccess?.("Auto-fill complete", `${filled} cells filled across ${matchedGuns} gun(s).${tail}`);
    } catch (err) {
      window.notifyError?.("Auto-fill failed", String(err.message || err));
    } finally {
      setBusyAuto(false);
    }
  };

  // ------- Import --------------------------------------------------------
  const onImportFile = async (file) => {
    if (!file) return;
    setImportErr("");
    setImportPreview(null);
    setShowImport(true);
    const name = file.name || "";
    const ext = name.toLowerCase().split(".").pop();
    try {
      let aoa = null;
      if (ext === "json") {
        const text = await file.text();
        const data = JSON.parse(text);
        if (Array.isArray(data)) {
          if (data.length && Array.isArray(data[0])) aoa = data;
          else {
            const keys = Object.keys(data[0] || {});
            aoa = [keys, ...data.map((row) => keys.map((k) => row[k]))];
          }
        }
      } else if (ext === "csv") {
        aoa = smParseDelim(await file.text(), ",");
      } else if (ext === "tsv" || ext === "txt") {
        aoa = smParseDelim(await file.text(), "\t");
      } else if (ext === "xlsx" || ext === "xls") {
        const X = await smLoadXlsx();
        const buf = await file.arrayBuffer();
        const wb = X.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        aoa = X.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      } else {
        throw new Error("Unsupported file extension: " + ext);
      }
      if (!aoa || aoa.length < 2) throw new Error("File has no data rows.");
      setImportPreview(aoa);
    } catch (err) {
      setImportErr(String(err.message || err));
    }
  };

  const onCommitImport = () => {
    if (!importPreview || importPreview.length < 2) return;
    const headers = importPreview[0].map((h) => String(h || "").trim());
    const ix = (label) => headers.findIndex((h) => h.toLowerCase() === label.toLowerCase());
    const gunIx = [ix("gun_no"), ix("gun"), ix("gun no"), ix("gun no."), ix("part")].find((n) => n >= 0);
    if (gunIx == null || gunIx < 0) {
      setImportErr("File must include a 'gun' (or 'gun_no') column.");
      return;
    }
    // Recognize station-identity columns by alias; everything else that
    // isn't reserved becomes a spare-category column.
    const stationIxByKey: Record<string, number> = {};
    const reserved = new Set([gunIx]);
    Object.entries(SM_STATION_ALIASES).forEach(([key, aliases]) => {
      const i = headers.findIndex((h) => aliases.includes(h.toLowerCase()));
      if (i >= 0 && !reserved.has(i)) { stationIxByKey[key] = i; reserved.add(i); }
    });
    const spareCols = headers
      .map((h, i) => ({ name: h, i }))
      .filter((c) => !reserved.has(c.i) && c.name);

    const newCols = [...(draft.cols || [])];
    const colNames = new Set(newCols.map((c) => c.col_name));
    spareCols.forEach((c) => {
      if (!colNames.has(c.name)) {
        newCols.push({ id: smUid(), col_name: c.name, col_type: "spare", locked: false });
        colNames.add(c.name);
      }
    });

    const existingByGun = new Map((draft.rows || []).map((r) => [String(r.gun_no).toUpperCase(), r]));
    const merged = [...(draft.rows || [])];
    importPreview.slice(1).forEach((row) => {
      const gunNo = String(row[gunIx] || "").trim();
      if (!gunNo) return;
      const station: Record<string, any> = {};
      Object.entries(stationIxByKey).forEach(([key, i]) => {
        const v = row[i];
        if (v == null || String(v) === "") return;
        station[key] = SM_NUM_ROW_FIELDS.has(key) ? (Number(v) || 0) : String(v);
      });
      const qty = station.qty != null ? station.qty : 1;
      const values: Record<string, string> = {};
      spareCols.forEach((c) => { const v = row[c.i]; if (v != null && String(v) !== "") values[c.name] = String(v); });
      const upper = gunNo.toUpperCase();
      const exists = existingByGun.get(upper) as any;
      if (exists) {
        const ixR = merged.findIndex((m: any) => m.id === exists.id);
        if (ixR >= 0) merged[ixR] = { ...exists, ...station, qty, values: { ...(exists.values || {}), ...values } };
      } else {
        const newRow = { id: smUid(), gun_no: gunNo, values, ...station, qty };
        merged.push(newRow);
        existingByGun.set(upper, newRow);
      }
    });

    dirty((d) => ({ ...d, cols: newCols, rows: merged }));
    setShowImport(false);
    setImportPreview(null);
    setImportErr("");
    window.notifySuccess?.("Import complete", `${importPreview.length - 1} rows merged.`);
  };

  // ------- Export --------------------------------------------------------
  const exportAoa = () => {
    const headers = ["gun_no", ...SM_STATION_COLS.map((sc) => sc.key), ...(draft.cols || []).map((c) => c.col_name)];
    const data = (draft.rows || []).map((r) => [
      r.gun_no || "",
      ...SM_STATION_COLS.map((sc) => ((r as any)[sc.key] != null ? (r as any)[sc.key] : "")),
      ...((draft.cols || []).map((c) => (r.values || {})[c.col_name] || "")),
    ]);
    return [headers, ...data];
  };

  const onExport = async (format) => {
    const filename = `SpareMatrix_${(draft.name || "untitled").replace(/[^A-Za-z0-9_-]+/g, "_")}_${new Date().toISOString().slice(0, 10)}`;
    const aoa = exportAoa();
    setShowExport(false);
    try {
      if (format === "xlsx") {
        const X = await smLoadXlsx();
        const ws = X.utils.aoa_to_sheet(aoa);
        const wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, ws, "Spare Matrix");
        X.writeFile(wb, filename + ".xlsx");
        return;
      }
      if (format === "csv") return smDownload(filename + ".csv", "text/csv", smAoaToDelim(aoa, ","));
      if (format === "tsv") return smDownload(filename + ".tsv", "text/tab-separated-values", smAoaToDelim(aoa, "\t"));
      if (format === "json") {
        const headers = aoa[0]; const body = aoa.slice(1);
        const data = body.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i]])));
        return smDownload(filename + ".json", "application/json", JSON.stringify(data, null, 2));
      }
    } catch (err) {
      window.notifyError?.("Export failed", String(err.message || err));
    }
  };

  // ------- Sync recommended ---------------------------------------------
  const onSyncRecommended = async () => {
    if (!draft.id) return;
    setBusySync(true);
    try {
      // Persist current worksheet edits, then recompute the Recommended
      // sheet server-side: installed_qty = COUNT of guns per (category,
      // part). Human-edited fields are preserved by the server.
      await AnvilBackend.spareMatrix.update(draft.id, toServer(draft));
      const res = await AnvilBackend.spareMatrix.recomputeRecommended(draft.id);
      const rec = (res && res.recommended) || [];
      const next = { ...draft, recommended: rec };
      onChange(next);
      setDraft(next);
      window.notifySuccess?.("Recommended spares recompiled", `${rec.length} parts · installed qty counted across guns.`);
    } catch (err) {
      window.notifyError?.("Recompile failed", String((err && err.message) || err));
    } finally {
      setBusySync(false);
    }
  };

  // Edit a recommended-sheet field: update locally + persist immediately
  // (recommended rows live in their own table, not the matrix autosave).
  const onRecEdit = (rowId, field, val) => {
    setDraft((d) => ({ ...d, recommended: (d.recommended || []).map((r) => r.id === rowId ? { ...r, [field]: val } : r) }));
    if (draft.id) {
      AnvilBackend.spareMatrix.updateRecommended(draft.id, { row_id: rowId, [field]: val })
        .catch((err) => window.notifyError?.("Save failed", String((err && err.message) || err)));
    }
  };

  // Feed the recommended sheet (rows with recommended qty > 0) into a
  // DRAFT quote, then deep-link to it. Pricing happens downstream, so the
  // quote lands unpriced; this just carries "what to quote, how many".
  // Bulk auto-fill recommended qty across ALL rows from a source column
  // (Max / Min / Installed) in one request — no per-row typing.
  const onBulkFill = async (source: "max" | "min" | "installed") => {
    if (!draft.id) return;
    if (!(draft.recommended || []).length) {
      window.notifyError?.("Nothing to fill", "Recompile the recommended sheet first.");
      return;
    }
    setBusyFill(true);
    try {
      const res = await AnvilBackend.spareMatrix.bulkFillRecommended(draft.id, { source });
      const next = { ...draft, recommended: (res && res.recommended) || draft.recommended };
      setDraft(next);
      onChange(next);
      window.notifySuccess?.("Recommended qty filled", `${res?.updated ?? 0} row(s) set from ${source}.`);
    } catch (err) {
      window.notifyError?.("Auto-fill failed", String((err && err.message) || err));
    } finally {
      setBusyFill(false);
    }
  };

  const onFeedToQuote = async () => {
    if (!draft.id) return;
    const feedable = (draft.recommended || []).filter((r) => Number(r.recommended_qty) > 0);
    // If rows are checked, feed only those; else feed all with qty > 0.
    const chosen = selRec.size ? feedable.filter((r) => selRec.has(r.id)) : feedable;
    if (!chosen.length) {
      window.notifyError?.("Nothing to quote", selRec.size
        ? "None of the checked rows have a recommended qty > 0."
        : "Check the rows to quote (or set a recommended qty > 0).");
      return;
    }
    // Infer the group so spares & consumables land on SEPARATE quotes.
    const isCons = (r) => String(r.item_type || "").toLowerCase() === "consumable";
    const group = !selRec.size ? "all"
      : chosen.every(isCons) ? "consumables"
      : chosen.every((r) => !isCons(r)) ? "spares"
      : "selected";
    setBusyFeed(true);
    try {
      const res = await AnvilBackend.spareMatrix.toQuote(draft.id, { row_ids: chosen.map((r) => r.id), group });
      const q = res && res.quote;
      if (!q || !q.id) throw new Error("Quote was not created");
      // Reflect the new quote_ref locally so the sheet shows the link.
      if (res.quote_number || q.quote_number) {
        const ref = q.quote_number || res.quote_number;
        const fedIds = new Set(chosen.map((r) => r.id));
        const next = { ...draft, recommended: (draft.recommended || []).map((r) => fedIds.has(r.id) ? { ...r, quote_ref: ref, quote_id: q.id } : r) };
        setDraft(next);
        onChange(next);
      }
      window.notifySuccess?.(
        res.reused ? `Updated ${group === "all" ? "" : group + " "}draft quote` : `Created ${group === "all" ? "" : group + " "}draft quote`,
        `${q.quote_number || "Quote"} · ${res.fed} line(s) · price it in the quote drawer.`,
      );
      window.location.hash = `#/quotes?id=${encodeURIComponent(q.id)}&tab=lines`;
    } catch (err) {
      window.notifyError?.("Feed to quote failed", String((err && err.message) || err));
    } finally {
      setBusyFeed(false);
    }
  };

  const onExportRecommended = (format) => {
    const rec = draft.recommended || [];
    if (!rec.length) { window.notifyError?.("Nothing to export", "Recompile the recommended sheet first."); return; }
    const filename = `RecommendedSpares_${(draft.name || "untitled").replace(/[^A-Za-z0-9_-]+/g, "_")}`;
    const cols = ["sr_no", "description", "part_no", "gun_number", "installed_qty", "recommended_min", "recommended_max", "recommended_qty", "priority", "item_type", "customer_part_no", "lead_time_days", "remarks", "quote_ref", "po_ref"];
    const aoa = [cols, ...rec.map((r) => cols.map((c) => (r[c] != null ? r[c] : "")))];
    if (format === "csv") return smDownload(filename + ".csv", "text/csv", smAoaToDelim(aoa, ","));
    if (format === "tsv") return smDownload(filename + ".tsv", "text/tab-separated-values", smAoaToDelim(aoa, "\t"));
    if (format === "json") return smDownload(filename + ".json", "application/json", JSON.stringify(rec, null, 2));
  };

  const onTitleCommit = (val) => {
    const trimmed = String(val || "").trim();
    if (!trimmed || trimmed === draft.name) { setTitleEdit(false); return; }
    dirty((d) => ({ ...d, name: trimmed }));
    setTitleEdit(false);
  };

  const onDeleteMatrix = async () => {
    if (!window.confirm(`Delete matrix "${draft.name || "Untitled"}"? This cannot be undone.`)) return;
    try {
      await AnvilBackend.spareMatrix.remove(draft.id);
      onDelete(draft.id);
    } catch (err) {
      window.notifyError?.("Delete failed", String((err && err.message) || err));
    }
  };

  const savingPill = saveState === "saving" || saveState === "dirty"
    ? <Chip k="warn">Saving…</Chip>
    : saveState === "saved"
      ? <Chip k="good">Saved</Chip>
      : saveState === "error"
        ? <Chip k="bad">Save error</Chip>
        : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div className="h-eyebrow">{customerName} · {draft.project_name || "—"}</div>
          {titleEdit ? (
            <input
              className="input"
              autoFocus
              defaultValue={draft.name}
              onBlur={(e) => onTitleCommit(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setTitleEdit(false); }}
              style={{ height: 28, fontSize: 16, fontWeight: 600 }}
            />
          ) : (
            <h2 className="h2" style={{ margin: "2px 0 0", cursor: "pointer" }} onClick={() => setTitleEdit(true)} title="Click to rename">
              {draft.name || "Untitled matrix"}
            </h2>
          )}
        </div>
        {savingPill}
      </div>

      {/* Sub tabs */}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn sm kind={!recView ? "primary" : "ghost"} onClick={() => setRecView(false)}>Worksheet</Btn>
        <Btn sm kind={recView ? "primary" : "ghost"} onClick={() => setRecView(true)}>Recommended Spares</Btn>
      </div>

      {/* Toolbar */}
      {!recView && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <Btn sm onClick={() => { setShowAddRow(true); setShowAddCol(false); }}>{Icon.plus} Row</Btn>
          <Btn sm onClick={() => { setShowAddCol(true); setShowAddRow(false); }}>{Icon.plus} Spare column</Btn>
          <Btn sm kind="ghost" onClick={() => setShowConfig(true)}>{Icon.settings} Configure cols</Btn>
          <Btn sm kind="ghost" onClick={onAutoFill} disabled={busyAuto}>{busyAuto ? "…" : <>{Icon.bolt} Auto-fill</>}</Btn>
          <Btn sm kind="ghost" onClick={() => fileRef.current?.click()}>{Icon.upload} Import</Btn>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,.tsv,.txt,.json" style={{ display: "none" }} onChange={(e) => onImportFile(e.target.files?.[0])} />
          <div style={{ position: "relative" }}>
            <Btn sm kind="ghost" onClick={() => setShowExport((s) => !s)}>{Icon.download} Export {Icon.caret}</Btn>
            {showExport && (
              <div style={{ position: "absolute", top: 30, left: 0, zIndex: 10, background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 6, padding: 4, minWidth: 110, boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
                {["xlsx", "csv", "tsv", "json"].map((f) => (
                  <div key={f} className="cmdk-row" style={{ padding: "6px 10px", cursor: "pointer", fontSize: 12, textTransform: "uppercase" }} onClick={() => onExport(f)}>{f}</div>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <Btn sm kind="ghost" onClick={onSyncRecommended} disabled={busySync}>{busySync ? "…" : <>{Icon.cycle} Sync recommended</>}</Btn>
          <Btn sm kind="ghost" onClick={onDeleteMatrix} className="">{Icon.x} Delete</Btn>
        </div>
      )}

      {/* Add row */}
      {showAddRow && !recView && (
        <Card>
          <SMAddRowForm onAdd={onAddRow} onCancel={() => setShowAddRow(false)} />
        </Card>
      )}
      {/* Add col */}
      {showAddCol && !recView && (
        <Card>
          <SMAddColForm onAdd={onAddCol} onClose={() => setShowAddCol(false)} existing={draft.cols || []} guns={(draft.rows || []).map((r) => r.gun_no).filter(Boolean)} />
        </Card>
      )}

      {/* Import preview */}
      {showImport && !recView && (
        <Card title="Import preview" eyebrow="review then commit"
              right={<>
                <Btn sm kind="ghost" onClick={() => { setShowImport(false); setImportPreview(null); setImportErr(""); }}>Cancel</Btn>
                <Btn sm kind="primary" onClick={onCommitImport} disabled={!importPreview}>Commit</Btn>
              </>}>
          {importErr ? (
            <Banner kind="bad" icon={Icon.alert} title="Could not parse file"><span className="mono-sm">{importErr}</span></Banner>
          ) : !importPreview ? (
            <div className="body" style={{ color: "var(--ink-3)" }}>Loading…</div>
          ) : (
            <div style={{ overflow: "auto", maxHeight: 280 }}>
              <table className="tbl">
                <thead><tr>{importPreview[0].map((h, i) => <th key={i}>{String(h)}</th>)}</tr></thead>
                <tbody>
                  {importPreview.slice(1, 21).map((r, ri) => (
                    <tr key={ri}>{r.map((c, ci) => <td key={ci} className="mono-sm">{String(c == null ? "" : c)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {importPreview.length > 21 && <div className="mono-sm" style={{ padding: 8, color: "var(--ink-3)" }}>+ {importPreview.length - 21} more rows…</div>}
            </div>
          )}
        </Card>
      )}

      {/* Worksheet grid */}
      {!recView && (
        <Card flush>
          {((draft.rows || []).length === 0 || (draft.cols || []).length === 0) ? (
            <div className="body" style={{ padding: 24, textAlign: "center", color: "var(--ink-3)" }}>
              {(draft.rows || []).length === 0 ? "No rows yet — click " : "No spare columns yet — click "}
              <span style={{ color: "var(--ink)" }}>{(draft.rows || []).length === 0 ? "+ Row" : "+ Spare column"}</span> to start.
            </div>
          ) : (
            <div style={{ overflow: "auto", maxHeight: "60vh" }}>
              <table className="tbl" style={{ minWidth: "100%" }}>
                <thead>
                  <tr>
                    {/* Corner cell: sticky on BOTH axes (top + left). */}
                    <th style={{ minWidth: 110, position: "sticky", left: 0, top: 0, background: "var(--paper-3)", zIndex: 3 }}>Gun</th>
                    {SM_STATION_COLS.map((sc) => (
                      <th key={sc.key} className={sc.num ? "r" : ""} style={{ minWidth: sc.w, position: "sticky", top: 0, zIndex: 2, background: "var(--paper-3)" }}>{sc.label}</th>
                    ))}
                    {(draft.cols || []).map((c) => (
                      <th key={c.id} style={{ minWidth: 110, position: "sticky", top: 0, zIndex: 2, background: "var(--paper-3)" }} title={c.col_type}>
                        {c.locked && <span style={{ marginRight: 4, color: "var(--ink-4)" }}>{Icon.lock}</span>}
                        {c.col_name}
                      </th>
                    ))}
                    <th style={{ width: 28, position: "sticky", top: 0, zIndex: 2, background: "var(--paper-3)" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {(draft.rows || []).map((r) => (
                    <tr key={r.id}>
                      <td className="mono" style={{ position: "sticky", left: 0, background: "var(--paper)", zIndex: 1 }}>
                        <input
                          className="input mono"
                          value={r.gun_no || ""}
                          onChange={(e) => onRowMetaChange(r.id, "gun_no", e.target.value)}
                          style={{ height: 26, fontSize: 11.5, padding: "0 6px", minWidth: 90 }}
                        />
                      </td>
                      {SM_STATION_COLS.map((sc) => (
                        <td key={sc.key} className={sc.num ? "r mono" : "mono"}>
                          <input
                            className="input mono"
                            type={sc.num ? "number" : "text"}
                            value={(r as any)[sc.key] != null ? (r as any)[sc.key] : ""}
                            onChange={(e) => onRowMetaChange(r.id, sc.key, e.target.value)}
                            style={{ height: 26, fontSize: 11.5, padding: "0 6px", width: sc.num ? 52 : Math.max(72, sc.w), textAlign: sc.num ? "right" : "left" }}
                          />
                        </td>
                      ))}
                      {(draft.cols || []).map((c) => (
                        <td key={c.id} className="mono">
                          <textarea
                            className="input mono"
                            value={(r.values || {})[c.col_name] || ""}
                            onChange={(e) => onCellChange(r.id, c.col_name, e.target.value)}
                            disabled={c.locked}
                            rows={1}
                            style={{ minHeight: 26, height: 26, padding: "4px 6px", fontSize: 11.5, resize: "vertical", width: "100%" }}
                          />
                        </td>
                      ))}
                      <td>
                        <Btn icon sm kind="ghost" onClick={() => onRemoveRow(r.id)} title="Remove row">{Icon.x}</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--hairline-2)", display: "flex", gap: 12, fontSize: 11 }} className="mono-sm">
            <span style={{ color: "var(--ink-3)" }}>{(draft.rows || []).length} rows · {(draft.cols || []).length} cols · {totalCells} cells</span>
            <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>updated {smFmtTs(draft.updated_at)}</span>
          </div>
        </Card>
      )}

      {/* Recommended spares sheet (lives inside the matrix) */}
      {recView && (
        <Card title="Recommended spares" eyebrow="installed qty counted across guns · feeds the quote"
              right={<>
                <Btn sm kind="ghost" onClick={onSyncRecommended} disabled={busySync}>{busySync ? "…" : <>{Icon.cycle} Recompile from grid</>}</Btn>
                {/* Bulk auto-fill recommended qty — no per-row typing. */}
                <span style={{ fontSize: 11, color: "var(--ink-3)", alignSelf: "center", marginLeft: 4 }}>Fill qty:</span>
                <Btn sm kind="ghost" onClick={() => onBulkFill("max")} disabled={busyFill} title="Set every row's recommended qty to its Max level">{busyFill ? "…" : "Max"}</Btn>
                <Btn sm kind="ghost" onClick={() => onBulkFill("min")} disabled={busyFill} title="Set every row's recommended qty to its Min level">Min</Btn>
                <Btn sm kind="ghost" onClick={() => onBulkFill("installed")} disabled={busyFill} title="Set every row's recommended qty to its installed count">Installed</Btn>
                {/* Select rows to quote — spares & consumables typically go on separate quotes. */}
                <span style={{ fontSize: 11, color: "var(--ink-3)", alignSelf: "center", marginLeft: 4 }}>Select:</span>
                <Btn sm kind="ghost" onClick={() => setSelRec(new Set((draft.recommended || []).filter((r) => String(r.item_type || "").toLowerCase() !== "consumable").map((r) => r.id)))} title="Select all spares (non-consumables)">Spares</Btn>
                <Btn sm kind="ghost" onClick={() => setSelRec(new Set((draft.recommended || []).filter((r) => String(r.item_type || "").toLowerCase() === "consumable").map((r) => r.id)))} title="Select all consumables">Consumables</Btn>
                <Btn sm kind="ghost" onClick={() => setSelRec(new Set((draft.recommended || []).map((r) => r.id)))}>All</Btn>
                {selRec.size > 0 && <Btn sm kind="ghost" onClick={() => setSelRec(new Set())}>None</Btn>}
                <Btn sm kind="primary" onClick={onFeedToQuote} disabled={busyFeed || busySync}
                     title={selRec.size ? "Feed the checked rows into their own draft quote (spares / consumables grouped separately)" : "Feed all rows with a recommended qty > 0 into a draft quote"}>
                  {busyFeed ? "…" : <>{Icon.doc} Feed to quote{selRec.size ? ` (${selRec.size})` : ""}</>}
                </Btn>
                <Btn sm kind="ghost" onClick={() => onExportRecommended("csv")}>CSV</Btn>
                <Btn sm kind="ghost" onClick={() => onExportRecommended("tsv")}>TSV</Btn>
                <Btn sm kind="ghost" onClick={() => onExportRecommended("json")}>JSON</Btn>
              </>}>
          {!(draft.recommended || []).length ? (
            <div className="body" style={{ color: "var(--ink-3)" }}>No recommended spares yet. Click <b>Recompile from grid</b> to compile installed quantities from the worksheet.</div>
          ) : (
            <div style={{ overflow: "auto", maxHeight: "60vh" }}>
              <table className="tbl" style={{ minWidth: "100%" }}>
                <thead><tr>
                  <th style={{ width: 30, position: "sticky", top: 0, zIndex: 2, background: "var(--paper-3)", textAlign: "center" }}>
                    <input type="checkbox" aria-label="select all"
                      checked={(draft.recommended || []).length > 0 && selRec.size === (draft.recommended || []).length}
                      ref={(el) => { if (el) el.indeterminate = selRec.size > 0 && selRec.size < (draft.recommended || []).length; }}
                      onChange={(e) => setSelRec(e.target.checked ? new Set((draft.recommended || []).map((r) => r.id)) : new Set())} />
                  </th>
                  {[
                    { label: "#", style: { width: 40 } },
                    { label: "Description" }, { label: "Part no" }, { label: "Gun" },
                    { label: "Installed", cls: "r", title: "Number of guns using this part" },
                    { label: "Min", cls: "r", title: "Suggested minimum stock (reorder point) — auto from installed qty + type" },
                    { label: "Max", cls: "r", title: "Suggested maximum stock — auto from installed qty + type" },
                    { label: "Recommended", cls: "r" },
                    { label: "Priority" }, { label: "Type" }, { label: "Customer Part No" },
                    { label: "Lead Time" }, { label: "Remarks" }, { label: "Quote Ref" }, { label: "PO Ref" },
                  ].map((h, i) => (
                    <th key={i} className={h.cls || ""} title={h.title}
                        style={{ ...(h.style || {}), position: "sticky", top: 0, zIndex: 2, background: "var(--paper-3)" }}>
                      {h.label}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {(draft.recommended || []).map((r, i) => (
                    <tr key={r.id || i} style={selRec.has(r.id) ? { background: "var(--paper-2)" } : undefined}>
                      <td style={{ textAlign: "center" }}>
                        <input type="checkbox" aria-label={"select " + (r.part_no || i)}
                          checked={selRec.has(r.id)}
                          onChange={(e) => setSelRec((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                      </td>
                      <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.sr_no != null ? r.sr_no : i + 1}</td>
                      <td>{r.description}</td>
                      <td className="mono"><span className="pri">{r.part_no}</span></td>
                      <td className="mono-sm">{r.gun_number || ""}</td>
                      <td className="r mono">{r.installed_qty != null ? r.installed_qty : ""}</td>
                      <td className="r mono">
                        <input className="input mono" type="number" value={r.recommended_min != null ? r.recommended_min : ""} onChange={(e) => onRecEdit(r.id, "recommended_min", e.target.value)} style={{ height: 26, width: 56, textAlign: "right", fontSize: 11.5, padding: "0 6px" }} />
                      </td>
                      <td className="r mono">
                        <input className="input mono" type="number" value={r.recommended_max != null ? r.recommended_max : ""} onChange={(e) => onRecEdit(r.id, "recommended_max", e.target.value)} style={{ height: 26, width: 56, textAlign: "right", fontSize: 11.5, padding: "0 6px" }} />
                      </td>
                      <td className="r mono">
                        <input className="input mono" type="number" value={r.recommended_qty != null ? r.recommended_qty : ""} onChange={(e) => onRecEdit(r.id, "recommended_qty", e.target.value)} style={{ height: 26, width: 76, textAlign: "right", fontSize: 11.5, padding: "0 6px" }} />
                      </td>
                      <td>
                        <select className="input" value={r.priority || ""} onChange={(e) => onRecEdit(r.id, "priority", e.target.value)} style={{ height: 26, fontSize: 11.5, padding: "0 4px" }}>
                          <option value="">—</option><option>High</option><option>Medium</option><option>Low</option>
                        </select>
                      </td>
                      <td>
                        <select className="input" value={r.item_type || ""} onChange={(e) => onRecEdit(r.id, "item_type", e.target.value)} style={{ height: 26, fontSize: 11.5, padding: "0 4px" }}>
                          <option value="">—</option><option>Consumable</option><option>Spare</option><option>Wear Part</option>
                        </select>
                      </td>
                      <td><input className="input mono" value={r.customer_part_no || ""} onChange={(e) => onRecEdit(r.id, "customer_part_no", e.target.value)} style={{ height: 26, fontSize: 11.5, padding: "0 6px", minWidth: 120 }} /></td>
                      <td><input className="input mono" value={r.lead_time_days || ""} onChange={(e) => onRecEdit(r.id, "lead_time_days", e.target.value)} style={{ height: 26, fontSize: 11.5, padding: "0 6px", width: 90 }} /></td>
                      <td><input className="input mono" value={r.remarks || ""} onChange={(e) => onRecEdit(r.id, "remarks", e.target.value)} style={{ height: 26, fontSize: 11.5, padding: "0 6px", minWidth: 120 }} /></td>
                      <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.quote_ref || ""}</td>
                      <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.po_ref || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Configure columns modal */}
      {showConfig && (
        <SMConfigColsModal
          cols={draft.cols || []}
          onMove={onColMove}
          onLockToggle={onColLockToggle}
          onDelete={onColDelete}
          onRename={onColRename}
          onClose={() => setShowConfig(false)}
        />
      )}
    </div>
  );
};

// ---------- Add Row form (search imported assets) ----------
const SMAddRowForm = ({ onAdd, onCancel }) => {
  const { useState: uF, useRef: rF, useEffect: eF } = React;
  const [gunNo, setGunNo] = uF("");
  const [qty, setQty] = uF<number | string>(1);
  const [line, setLine] = uF("");
  const [stationNo, setStationNo] = uF("");
  const [robotNo, setRobotNo] = uF("");
  const [gunType, setGunType] = uF("");
  const [results, setResults] = uF<Array<{ code: string; name?: string | null }>>([]);
  const [searching, setSearching] = uF(false);
  const ref = rF(null);
  eF(() => { ref.current?.focus(); }, []);

  // Search imported assets (bom_assets). Falls back to distinct parents in
  // bill_of_materials so it works even on legacy / flat-imported data.
  const runSearch = async (term) => {
    setGunNo(term);
    const q = String(term || "").trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    try {
      let assets: Array<{ code: string; name?: string | null }> = [];
      if (AnvilBackend?.bom?.assets) {
        const r = await AnvilBackend.bom.assets({ q });
        assets = (r?.assets || []).map((a: any) => ({ code: a.asset_code, name: a.name }));
      }
      if (!assets.length && AnvilBackend?.bom?.list) {
        const r = await AnvilBackend.bom.list();
        const rows = Array.isArray(r) ? r : (r?.rows || r?.bom || []);
        const seen = new Set<string>();
        (rows || []).forEach((b: any) => {
          const p = String(b.parent_part_no || b.parent || "").trim();
          if (p && !seen.has(p) && p.toLowerCase().includes(q.toLowerCase())) { seen.add(p); assets.push({ code: p, name: null }); }
        });
        assets = assets.slice(0, 20);
      }
      setResults(assets);
    } catch (_) { setResults([]); } finally { setSearching(false); }
  };

  const station = () => ({ line, station_no: stationNo, robot_no: robotNo, gun_type: gunType });
  const pick = (code) => { setResults([]); onAdd({ gun_no: code, qty, ...station() }); };
  const submit = (e) => { e?.preventDefault(); onAdd({ gun_no: gunNo, qty, ...station() }); };

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 240, position: "relative" }}>
        <div className="label">Search asset / gun (or type a code)</div>
        <input ref={ref} className="input mono" value={gunNo} onChange={(e) => runSearch(e.target.value)} placeholder="search imported BOMs…" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
        {results.length > 0 && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "var(--paper)", border: "1px solid var(--hairline)", borderRadius: 8, maxHeight: 220, overflow: "auto", marginTop: 4 }}>
            {results.map((a) => (
              <div key={a.code} onClick={() => pick(a.code)}
                   style={{ padding: "8px 10px", cursor: "pointer", borderBottom: "1px solid var(--hairline-2)" }}>
                <span className="mono pri">{a.code}</span>
                {a.name ? <span className="mono-sm" style={{ color: "var(--ink-3)", marginLeft: 8 }}>{a.name}</span> : null}
              </div>
            ))}
          </div>
        )}
        {searching ? <div className="mono-sm" style={{ color: "var(--ink-4)", marginTop: 2 }}>searching…</div> : null}
      </div>
      <div style={{ width: 88 }}><div className="label">Line</div><input className="input mono" value={line} onChange={(e) => setLine(e.target.value)} /></div>
      <div style={{ width: 88 }}><div className="label">Station</div><input className="input mono" value={stationNo} onChange={(e) => setStationNo(e.target.value)} /></div>
      <div style={{ width: 76 }}><div className="label">Robot</div><input className="input mono" value={robotNo} onChange={(e) => setRobotNo(e.target.value)} /></div>
      <div style={{ width: 88 }}><div className="label">Type</div><input className="input mono" value={gunType} onChange={(e) => setGunType(e.target.value)} /></div>
      <div style={{ width: 76 }}>
        <div className="label">qty</div>
        <input className="input mono" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <Btn sm type="submit" kind="primary">Add row</Btn>
      <Btn sm kind="ghost" onClick={onCancel}>Cancel</Btn>
    </form>
  );
};

// ---------- Add Col form ----------
// A column is a spare CATEGORY (TIP, SHUNT, ELECTRODE, BOLT, ...). Auto-fill
// matches each gun's BOM parts into these categories. Suggestions are drawn
// from the actual BOM descriptions of the guns already in this matrix (so
// you only see categories/parts that exist), plus the familiar presets.
const SMAddColForm = ({ onAdd, onClose, existing, guns }) => {
  const { useState: uF, useRef: rF, useEffect: eF } = React;
  const [name, setName] = uF("");
  const [type, setType] = uF("spare");
  const [loading, setLoading] = uF(false);
  // presetHits: presets that actually match >=1 part in the loaded guns.
  const [presetHits, setPresetHits] = uF<Array<{ name: string; count: number; consumable: boolean }>>([]);
  // descOptions: distinct cleaned part descriptions found in the loaded guns.
  const [descOptions, setDescOptions] = uF<string[]>([]);
  const ref = rF(null);
  eF(() => { ref.current?.focus(); }, []);

  const usedNames = new Set((existing || []).map((c) => c.col_name));

  // Load the BOM descriptions of the populated guns and derive suggestions.
  eF(() => {
    let cancel = false;
    const codes = Array.from(new Set((guns || []).map((g) => String(g || "").trim()).filter(Boolean)));
    if (!codes.length) { setPresetHits([]); setDescOptions([]); return; }
    setLoading(true);
    (async () => {
      const all: SpareBomItem[] = [];
      await Promise.all(codes.map(async (code: string) => {
        const lines = await smFetchLinesForGun(code);
        all.push(...lines);
      }));
      if (cancel) return;
      // Presets that match >=1 part across the loaded guns, ranked by count.
      const hits = SPARE_PRESETS
        .map((p) => {
          const v = matchSpares(all, [p.name])[p.name] || "";
          const count = v ? v.split("\n").filter(Boolean).length : 0;
          return { name: p.name, count, consumable: p.category === "Consumable" };
        })
        .filter((h) => h.count > 0)
        .sort((a, b) => b.count - a.count);
      // Distinct cleaned descriptions for free-text autocomplete.
      const seen = new Set<string>();
      const descs: string[] = [];
      all.forEach((l) => {
        const cands = nameMatchCandidates(l.part_name);
        const cleaned = (cands.length ? cands[cands.length - 1] : String(l.part_name || "")).trim().toUpperCase();
        if (cleaned && !seen.has(cleaned)) { seen.add(cleaned); descs.push(cleaned); }
      });
      descs.sort();
      setPresetHits(hits);
      setDescOptions(descs.slice(0, 200));
      setLoading(false);
    })().catch(() => { if (!cancel) { setLoading(false); } });
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onNameChange = (val) => {
    setName(val);
    const up = String(val || "").trim().toUpperCase();
    const preset = SPARE_PRESETS.find((p) => p.name === up);
    if (preset) setType(preset.category === "Consumable" ? "consumable" : "spare");
  };
  const addCol = (colName, consumable) => {
    onAdd(colName, consumable ? "consumable" : "spare");
  };
  const submit = (e) => {
    e?.preventDefault();
    const trimmed = String(name).trim().toUpperCase();
    if (!trimmed) return;
    onAdd(trimmed, type);
    onClose();
  };

  // Datalist = matched presets + descriptions + all preset names (deduped).
  const dataOptions = Array.from(new Set([
    ...presetHits.map((h) => h.name),
    ...descOptions,
    ...SPARE_PRESETS.map((p) => p.name),
  ])).filter((n) => !usedNames.has(n));

  const hasGuns = (guns || []).length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "end" }}>
        <div style={{ flex: 1 }}>
          <div className="label">spare category / description (column)</div>
          <input ref={ref} list="sm-col-suggestions" className="input mono" value={name} onChange={(e) => onNameChange(e.target.value)} placeholder={hasGuns ? "type to autocomplete from your guns…" : "e.g. TIP, SHUNT, ELECTRODE"} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }} />
          <datalist id="sm-col-suggestions">
            {dataOptions.map((n) => <option key={n} value={n} />)}
          </datalist>
        </div>
        <div style={{ width: 160 }}>
          <div className="label">type</div>
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="spare">spare</option>
            <option value="consumable">consumable</option>
            <option value="kit">kit</option>
            <option value="drawing">drawing</option>
          </select>
        </div>
        <Btn sm type="submit" kind="primary">Add column</Btn>
        <Btn sm kind="ghost" onClick={onClose}>Cancel</Btn>
      </form>

      {/* Suggestions found in the guns currently in this matrix */}
      {hasGuns && (
        <div>
          <div className="label" style={{ marginBottom: 4 }}>
            {loading ? "scanning your guns…" : presetHits.filter((h) => !usedNames.has(h.name)).length ? "found in your guns" : "no preset categories matched your guns - use a preset or description below"}
          </div>
          {!loading && (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {presetHits.filter((h) => !usedNames.has(h.name)).map((h) => (
                <button key={h.name} type="button" className="chip" style={{ cursor: "pointer", fontSize: 10.5 }} title={h.consumable ? "consumable" : "spare"} onClick={() => addCol(h.name, h.consumable)}>
                  {h.name} <span style={{ opacity: 0.6 }}>· {h.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Familiar preset categories (always available) */}
      <div>
        <div className="label" style={{ marginBottom: 4 }}>preset categories</div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {SPARE_PRESETS.filter((p) => !usedNames.has(p.name)).map((p) => (
            <button key={p.name} type="button" className="chip ghost" style={{ cursor: "pointer", fontSize: 10.5 }} title={p.category} onClick={() => addCol(p.name, p.category === "Consumable")}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

// ---------- Configure Cols modal ----------
const SMConfigColsModal = ({ cols, onMove, onLockToggle, onDelete, onRename, onClose }) => {
  const { useEffect: eM } = React;
  eM(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="cmdk-bg" style={{ padding: 0, alignItems: "stretch", justifyItems: "end" }} onClick={onClose} role="dialog" aria-modal="true" aria-label="Configure columns">
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 520 }}>
        <div className="drawer-h">
          <div>
            <div className="h-eyebrow">Worksheet</div>
            <div className="h2" style={{ marginTop: 2 }}>Configure columns</div>
          </div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">{Icon.x}</button>
        </div>
        <div style={{ padding: 16, overflow: "auto", flex: 1 }}>
          {cols.length === 0 ? (
            <div className="body" style={{ color: "var(--ink-3)" }}>No columns yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {cols.map((c, ix) => (
                <div key={c.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: 6, border: "1px solid var(--hairline)", borderRadius: 4 }}>
                  <span className="mono-sm" style={{ width: 28, color: "var(--ink-4)" }}>{ix + 1}</span>
                  <input
                    className="input mono"
                    defaultValue={c.col_name}
                    onBlur={(e) => onRename(ix, e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    style={{ flex: 1 }}
                  />
                  <span className="chip ghost" style={{ minWidth: 70, justifyContent: "center" }}>{c.col_type}</span>
                  <Btn icon sm kind="ghost" onClick={() => onMove(ix, -1)} disabled={ix === 0} title="Move up">{Icon.arrowU}</Btn>
                  <Btn icon sm kind="ghost" onClick={() => onMove(ix, 1)} disabled={ix === cols.length - 1} title="Move down">{Icon.arrowD}</Btn>
                  <Btn icon sm kind={c.locked ? "primary" : "ghost"} onClick={() => onLockToggle(ix)} title={c.locked ? "Unlock" : "Lock"}>{Icon.lock}</Btn>
                  <Btn icon sm kind="ghost" onClick={() => onDelete(ix)} title="Delete column">{Icon.x}</Btn>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
          <Btn kind="primary" onClick={onClose} full>Done</Btn>
        </div>
      </div>
    </div>
  );
};

// ---------- New Matrix modal ----------
const SMNewMatrixModal = ({ customers, loading, onCreate, onClose }) => {
  const { useState: uM, useRef: rM, useEffect: eM } = React;
  const [customerId, setCustomerId] = uM(customers[0]?.id || "");
  const [project, setProject] = uM("");
  const [name, setName] = uM("");
  const ref = rM(null);
  eM(() => { ref.current?.focus(); }, []);
  eM(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (e) => {
    e?.preventDefault();
    if (!customerId) { window.notifyError?.("Pick a customer", "A matrix must be scoped to a customer."); return; }
    const proj = String(project || "").trim() || "Default project";
    const cn = customers.find((c) => c.id === customerId);
    const auto = `${cn?.customer_name || "Customer"} · ${proj}`;
    onCreate({ customer_id: customerId, project_name: proj, name: String(name || "").trim() || auto });
  };

  return (
    <div className="cmdk-bg" onClick={onClose} role="dialog" aria-modal="true" aria-label="New matrix">
      <div className="drawer" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxHeight: "80vh" }}>
        <div className="drawer-h">
          <div>
            <div className="h-eyebrow">Spare matrix</div>
            <div className="h2" style={{ marginTop: 2 }}>New matrix</div>
          </div>
          <button className="btn icon sm ghost" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close">{Icon.x}</button>
        </div>
        <form onSubmit={submit} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div className="label">customer</div>
            <select ref={ref} className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={loading}>
              {loading ? <option>Loading…</option> :
                customers.length === 0 ? <option value="">No customers</option> :
                customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.name || c.id?.slice(0, 8)}</option>)}
            </select>
          </div>
          <div>
            <div className="label">project name</div>
            <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. Plant 2 Line A" />
          </div>
          <div>
            <div className="label">matrix name (optional)</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="auto-generated if blank" />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn sm kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn sm type="submit" kind="primary">Create matrix</Btn>
          </div>
        </form>
      </div>
    </div>
  );
};

// ---------- Worksheet outer ----------
const SMWorksheetTab = () => {
  const { useState: uM, useEffect: eM, useMemo: mM } = React;
  const [matrices, setMatrices] = uM([]);          // light headers from the server
  const [activeId, setActiveId] = uM("");
  const [active, setActive] = uM(null);             // full matrix (fromServer)
  const [loadingList, setLoadingList] = uM(true);
  const [listErr, setListErr] = uM(null);
  const [loadingActive, setLoadingActive] = uM(false);
  const [showNew, setShowNew] = uM(false);
  const [legacyCount, setLegacyCount] = uM(0);
  const [importing, setImporting] = uM(false);

  const customers = useFetch(() => AnvilBackend?.customers?.list?.() || Promise.resolve([]), []);
  const customerList = mM(() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.customers || d.rows || [];
  }, [customers.data]);

  // Load the matrix list from the server (migration 159).
  const reloadList = React.useCallback(async (selectId?: string) => {
    setLoadingList(true); setListErr(null);
    try {
      const r = await AnvilBackend.spareMatrix.list();
      const list = ((r && r.matrices) || []).map(fromHeader);
      setMatrices(list);
      setActiveId((cur) => selectId || cur || (list[0] ? list[0].id : ""));
    } catch (err) {
      setListErr(err);
    } finally {
      setLoadingList(false);
    }
  }, []);

  eM(() => { reloadList(); }, [reloadList]);

  // Offer a one-time import of any legacy localStorage matrices.
  eM(() => {
    try { if (!localStorage.getItem(SM_IMPORTED_KEY)) setLegacyCount(smReadAll().length); } catch (_) { /* noop */ }
  }, []);

  // Load the full active matrix when the selection changes.
  eM(() => {
    if (!activeId) { setActive(null); return; }
    let cancel = false;
    setLoadingActive(true);
    (async () => {
      try {
        const full = await AnvilBackend.spareMatrix.get(activeId);
        if (!cancel) setActive(fromServer(full));
      } catch (err) {
        if (!cancel) { setActive(null); window.notifyError?.("Could not load matrix", String((err && err.message) || err)); }
      } finally {
        if (!cancel) setLoadingActive(false);
      }
    })();
    return () => { cancel = true; };
  }, [activeId]);

  const onCreate = async ({ customer_id, project_name, name }) => {
    try {
      const r = await AnvilBackend.spareMatrix.create({ customer_id, project_name, name });
      const m = r && r.matrix;
      if (!m) throw new Error("create returned no matrix");
      setMatrices((prev) => [fromHeader(m), ...prev]);
      setActiveId(m.id);
      setShowNew(false);
      window.notifySuccess?.("Matrix created", name || "Untitled");
    } catch (err) {
      window.notifyError?.("Create failed", String((err && err.message) || err));
    }
  };

  // In-pane edits (autosaved to server by the pane) reflect into the rail header.
  const onMatrixChange = (next) => {
    setActive(next);
    setMatrices((all) => all.map((m) => (m.id === next.id ? { ...m, name: next.name, project_name: next.project_name, customer_id: next.customer_id, updated_at: next.updated_at } : m)));
  };

  const onMatrixDelete = (id) => {
    setMatrices((all) => all.filter((m) => m.id !== id));
    setActive(null);
    setActiveId((cur) => (cur === id ? "" : cur));
  };

  // One-time migration of legacy localStorage matrices into the server.
  // The local copy is left intact as a backup (idempotency via a flag).
  const onImportLegacy = async () => {
    setImporting(true);
    let ok = 0; let total = 0;
    try {
      const legacy = smReadAll(); total = legacy.length;
      for (const lm of legacy) {
        try {
          const r = await AnvilBackend.spareMatrix.create({ customer_id: lm.customer_id || null, project_name: lm.project_name || null, name: lm.name || null });
          const id = r && r.matrix && r.matrix.id;
          if (!id) continue;
          await AnvilBackend.spareMatrix.update(id, toServer({
            customer_id: lm.customer_id, project_name: lm.project_name, name: lm.name,
            cols: (lm.cols || []).map((c) => ({ col_name: c.col_name, col_type: c.col_type, locked: !!c.locked })),
            rows: (lm.rows || []).map((rw) => ({ gun_no: rw.gun_no, qty: rw.qty, values: rw.values || {} })),
          }));
          ok += 1;
        } catch (_) { /* skip this one */ }
      }
      try { localStorage.setItem(SM_IMPORTED_KEY, new Date().toISOString()); } catch (_) { /* noop */ }
      setLegacyCount(0);
      await reloadList();
      window.notifySuccess?.("Imported local matrices", `${ok} of ${total} imported. Your local copy is kept as a backup.`);
    } catch (err) {
      window.notifyError?.("Import failed", String((err && err.message) || err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 14, alignItems: "start" }}>
      {/* Left rail */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, position: "sticky", top: 0 }}>
        <Btn kind="primary" sm full onClick={() => setShowNew(true)}>{Icon.plus} New matrix</Btn>
        {legacyCount > 0 && (
          <Btn sm kind="ghost" full onClick={onImportLegacy} disabled={importing}>{importing ? "Importing…" : <>{Icon.upload} Import {legacyCount} local</>}</Btn>
        )}
        <Card flush>
          {listErr ? (
            <Banner kind="bad" icon={Icon.alert} title="Could not load matrices">
              <span className="mono-sm">{String((listErr && listErr.message) || listErr)}</span>
            </Banner>
          ) : loadingList ? (
            <div className="body" style={{ padding: 14, color: "var(--ink-3)" }}>Loading…</div>
          ) : matrices.length === 0 ? (
            <div className="body" style={{ padding: 14, color: "var(--ink-3)" }}>No matrices yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {matrices.map((m) => {
                const cn = customerList.find((c) => c.id === m.customer_id);
                const display = cn?.customer_name || cn?.name || m.customer_id?.slice(0, 8) || "—";
                const isSel = m.id === activeId;
                return (
                  <div
                    key={m.id}
                    onClick={() => setActiveId(m.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setActiveId(m.id); }}
                    style={{ padding: "10px 12px", cursor: "pointer", borderBottom: "1px solid var(--hairline-2)", background: isSel ? "var(--paper-4)" : "transparent" }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>{m.name || "Untitled"}</div>
                    <div className="mono-sm" style={{ color: "var(--ink-3)", fontSize: 10, marginTop: 2 }}>{display} · {m.project_name || "—"}</div>
                    <div className="mono-sm" style={{ color: "var(--ink-4)", fontSize: 10, marginTop: 2 }}>{smFmtTs(m.updated_at)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Right pane */}
      <div>
        {loadingActive ? (
          <Card><div className="body" style={{ padding: 24, color: "var(--ink-3)" }}>Loading matrix…</div></Card>
        ) : !active ? (
          <Card>
            <div style={{ padding: 28, textAlign: "center" }}>
              <div className="h-eyebrow" style={{ marginBottom: 6 }}>Spare matrix</div>
              <div className="h2" style={{ marginBottom: 10 }}>Create your first matrix</div>
              <div className="body" style={{ color: "var(--ink-3)", marginBottom: 14 }}>Build a customer-and-project worksheet of guns × spare parts. Auto-fill from BOMs, import existing sheets, or start from scratch.</div>
              <Btn kind="primary" onClick={() => setShowNew(true)} disabled={customers.loading}>{Icon.plus} New matrix</Btn>
            </div>
          </Card>
        ) : (
          <SMWorksheetPane matrix={active} onChange={onMatrixChange} onDelete={onMatrixDelete} customers={customerList} />
        )}
      </div>

      {showNew && (
        <SMNewMatrixModal customers={customerList} loading={customers.loading} onCreate={onCreate} onClose={() => setShowNew(false)} />
      )}
    </div>
  );
};

// ---------- Sub-tabs (recommend/kit/opps/obsolete) — re-implemented inline ----------
const SMSubTab = ({ tab, customerId, customers, onCustomerChange }) => {
  const { useState: uS, useEffect: eS, useMemo: mS } = React;
  const [months, setMonths] = uS<number | string>(12);
  const [obsMonths, setObsMonths] = uS<number | string>(18);
  const [state, setState] = uS({ data: null, loading: false, error: null });

  const run = async () => {
    setState({ data: null, loading: true, error: null });
    try {
      let data;
      if (tab === "recommend")     data = await AnvilBackend?.spareMatrix?.recommend?.({ customer_id: customerId });
      else if (tab === "kit")      data = await AnvilBackend?.spareMatrix?.kit?.({ customer_id: customerId, months: Number(months) || 12 });
      else if (tab === "opps")     data = await AnvilBackend?.spareMatrix?.opportunities?.(customerId);
      else if (tab === "obsolete") data = await AnvilBackend?.spareMatrix?.obsolete?.(Number(obsMonths) || 18);
      setState({ data, loading: false, error: null });
    } catch (err) {
      setState({ data: null, loading: false, error: err });
    }
  };

  eS(() => { if (tab === "obsolete" && state.data == null && !state.loading) run(); /* eslint-disable-line */ }, [tab]);

  const rows = mS(() => {
    const d = state.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.rows || d.recommendations || d.items || d.opportunities || d.obsolete || d.spares || d.top || [];
  }, [state.data]);

  const pct = (n) => {
    if (n == null || Number.isNaN(Number(n))) return "—";
    const v = Number(n);
    if (v >= 0 && v <= 1) return (v * 100).toFixed(0) + "%";
    if (v > 1 && v <= 100) return v.toFixed(0) + "%";
    return v.toLocaleString("en-IN");
  };

  const customerSelect = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Customer</label>
      <select className="input" value={customerId} onChange={(e) => onCustomerChange(e.target.value)} style={{ width: 240, height: 30 }}>
        {customers.length === 0 ? <option value="">No customers</option> :
          customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.name || c.id?.slice(0, 8)}</option>)}
      </select>
    </div>
  );

  if (tab === "recommend") {
    return (
      <Card title="Recommendations" eyebrow="sorted by criticality"
            right={<>{customerSelect}<Btn sm kind="primary" onClick={run} disabled={!customerId || state.loading}>{state.loading ? "…" : <>{Icon.cycle} Regenerate</>}</Btn></>}>
        {state.error ? <Banner kind="bad" icon={Icon.alert} title="Failed"><span className="mono-sm">{String(state.error.message || state.error)}</span></Banner> :
         state.data == null ? <div className="body" style={{ color: "var(--ink-3)" }}>Pick a customer and click Regenerate.</div> :
         rows.length === 0 ? <div className="body" style={{ color: "var(--ink-3)" }}>No recommendations.</div> :
         <table className="tbl">
           <thead><tr><th>Part</th><th>Description</th><th className="r">Criticality</th><th className="r">Recommended qty</th></tr></thead>
           <tbody>{rows.map((r, i) => (
             <tr key={r.id || r.part_no || i}>
               <td className="mono"><span className="pri">{r.part_no || r.part_number || "—"}</span></td>
               <td>{r.description || r.name || "—"}</td>
               <td className="r mono">{r.criticality_score != null ? Number(r.criticality_score).toFixed(2) : "—"}</td>
               <td className="r mono">{r.recommended_qty != null ? Number(r.recommended_qty).toFixed(0) : "—"}</td>
             </tr>
           ))}</tbody>
         </table>}
      </Card>
    );
  }
  if (tab === "kit") {
    return (
      <Card title="Kit prediction" eyebrow="forecast target qty per part"
            right={<>{customerSelect}<label className="mono-sm" style={{ color: "var(--ink-3)" }}>Months</label>
              <input className="input" type="number" min={1} max={36} value={months} onChange={(e) => setMonths(e.target.value)} style={{ width: 70, height: 30 }} />
              <Btn sm kind="primary" onClick={run} disabled={!customerId || state.loading}>{state.loading ? "…" : <>{Icon.bolt} Predict</>}</Btn></>}>
        {state.error ? <Banner kind="bad" icon={Icon.alert} title="Failed"><span className="mono-sm">{String(state.error.message || state.error)}</span></Banner> :
         state.data == null ? <div className="body" style={{ color: "var(--ink-3)" }}>Pick a customer and click Predict.</div> :
         rows.length === 0 ? <div className="body" style={{ color: "var(--ink-3)" }}>No prediction.</div> :
         <table className="tbl">
           <thead><tr><th>Part</th><th>Description</th><th className="r">Predicted qty</th><th className="r">Confidence</th></tr></thead>
           <tbody>{rows.map((r, i) => (
             <tr key={r.id || r.part_no || i}>
               <td className="mono"><span className="pri">{r.part_no || r.part_number || "—"}</span></td>
               <td>{r.description || r.name || "—"}</td>
               <td className="r mono">{r.predicted_qty != null ? Number(r.predicted_qty).toFixed(0) : (r.target_qty != null ? Number(r.target_qty).toFixed(0) : "—")}</td>
               <td className="r mono">{pct(r.confidence)}</td>
             </tr>
           ))}</tbody>
         </table>}
      </Card>
    );
  }
  if (tab === "opps") {
    return (
      <Card title="Opportunities" eyebrow="₹ uplift potential"
            right={<>{customerSelect}<Btn sm kind="primary" onClick={run} disabled={!customerId || state.loading}>{state.loading ? "…" : <>{Icon.cycle} Refresh</>}</Btn></>}>
        {state.error ? <Banner kind="bad" icon={Icon.alert} title="Failed"><span className="mono-sm">{String(state.error.message || state.error)}</span></Banner> :
         state.data == null ? <div className="body" style={{ color: "var(--ink-3)" }}>Pick a customer and click Refresh.</div> :
         rows.length === 0 ? <div className="body" style={{ color: "var(--ink-3)" }}>No opportunities.</div> :
         <table className="tbl">
           <thead><tr><th>Pattern</th><th>Suggested part</th><th className="r">Est ₹/mo</th><th className="r">Confidence</th></tr></thead>
           <tbody>{rows.map((r, i) => (
             <tr key={r.id || i}>
               <td>{r.pattern || r.description || "—"}</td>
               <td className="mono">{r.suggested_part || r.part_no || "—"}</td>
               <td className="r mono">{r.est_value_inr != null ? fmtINRShort(Number(r.est_value_inr)) : (r.estimated_value_per_month != null ? fmtINRShort(Number(r.estimated_value_per_month)) : "—")}</td>
               <td className="r mono">{pct(r.confidence)}</td>
             </tr>
           ))}</tbody>
         </table>}
      </Card>
    );
  }
  // obsolete
  return (
    <Card title="Obsolete / dormant SKUs" eyebrow="no-orders threshold"
          right={<><label className="mono-sm" style={{ color: "var(--ink-3)" }}>Months</label>
            <input className="input" type="number" min={1} max={120} value={obsMonths} onChange={(e) => setObsMonths(e.target.value)} style={{ width: 70, height: 30 }} />
            <Btn sm kind="primary" onClick={run} disabled={state.loading}>{state.loading ? "…" : <>{Icon.cycle} Refresh</>}</Btn></>}>
      {state.error ? <Banner kind="bad" icon={Icon.alert} title="Failed"><span className="mono-sm">{String(state.error.message || state.error)}</span></Banner> :
       state.loading ? <div className="body">Loading…</div> :
       rows.length === 0 ? <div className="body" style={{ color: "var(--ink-3)" }}>No SKUs flagged.</div> :
       <table className="tbl">
         <thead><tr><th>SKU</th><th>Description</th><th>Last sold</th><th className="r">On hand</th></tr></thead>
         <tbody>{rows.map((r, i) => (
           <tr key={r.id || r.part_no || i}>
             <td className="mono"><span className="pri">{r.part_no || r.part_number || "—"}</span></td>
             <td>{r.description || r.name || "—"}</td>
             <td className="mono-sm">{r.last_sold_at ? new Date(r.last_sold_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" }) : "—"}</td>
             <td className="r mono">{r.on_hand != null ? Number(r.on_hand).toLocaleString("en-IN") : "—"}</td>
           </tr>
         ))}</tbody>
       </table>}
    </Card>
  );
};

// ---------- Top-level ----------
// Kit / Opportunities / Obsolete are hidden for now (SMSubTab still supports
// them if re-enabled here).
const SM_TABS = [
  { id: "worksheet",    label: "Worksheet" },
  { id: "recommend",    label: "Recommend" },
];

const WiredSparesWorksheet = () => {
  const { useState: uW, useMemo: mW } = React;
  const [active, setActive] = uW("worksheet");
  const [customerId, setCustomerId] = uW("");

  const customers = useFetch(() => AnvilBackend?.customers?.list?.() || Promise.resolve([]), []);
  const customerList = mW(() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.customers || d.rows || [];
  }, [customers.data]);

  // default first customer for sub-tabs
  React.useEffect(() => {
    if (!customerId && customerList.length > 0) setCustomerId(customerList[0].id);
  }, [customerList, customerId]);

  return (
    <>
      <WSTitle
        eyebrow="Procurement · Spares Matrix"
        title="Spares matrix"
        meta="worksheet · recommend"
      />
      <WSTabs tabs={SM_TABS} active={active} onChange={setActive} />
      <div className="ws-content">
        {customers.error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load customers"
                  action={<Btn sm onClick={customers.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(customers.error.message || customers.error)}</span>
          </Banner>
        )}
        {active === "worksheet" && <SMWorksheetTab />}
        {active !== "worksheet" && (
          <SMSubTab
            tab={active}
            customerId={customerId}
            customers={customerList}
            onCustomerChange={setCustomerId}
          />
        )}
      </div>
    </>
  );
};


export default WiredSparesWorksheet;
