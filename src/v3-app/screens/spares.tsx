// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useMemo, useRef, useState } from "react";
import { fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Spare Matrix Worksheet
// Customer + Project scoped grid with inline editing, autosave,
// import/export, auto-fill from BOMs, and recommended-spares sync.
// Overrides the minimal wired-spares-c.jsx via window.SparesMatrix.
// ============================================================

const SM_LS_KEY = "obara:v3_spare_matrices";
const SM_XLSX_CDN = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";

// ---------- helpers ----------------------------------------------------
const smUid = () => "mx_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const smReadAll = () => {
  try {
    const raw = localStorage.getItem(SM_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
};

const smWriteAll = (rows) => {
  try { localStorage.setItem(SM_LS_KEY, JSON.stringify(rows || [])); } catch (_) {}
};

const smUpsert = (matrix) => {
  const rows = smReadAll();
  const ix = rows.findIndex((m) => m.id === matrix.id);
  if (ix >= 0) rows[ix] = matrix; else rows.push(matrix);
  smWriteAll(rows);
};

const smRemove = (id) => smWriteAll(smReadAll().filter((m) => m.id !== id));

const smLoadXlsx = () => new Promise((resolve, reject) => {
  if (window.XLSX) return resolve(window.XLSX);
  const existing = document.querySelector('script[data-sm-xlsx="1"]');
  if (existing) { existing.addEventListener("load", () => resolve(window.XLSX)); existing.addEventListener("error", reject); return; }
  const s = document.createElement("script");
  s.src = SM_XLSX_CDN;
  s.async = true;
  s.dataset.smXlsx = "1";
  s.onload = () => resolve(window.XLSX);
  s.onerror = () => reject(new Error("Could not load XLSX library."));
  document.head.appendChild(s);
});

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
      smUpsert(next);
      onChange(next);
      try {
        if (next.customer_id && ObaraBackend?.spareMatrix?.recommend) {
          await ObaraBackend.spareMatrix.recommend({ customer_id: next.customer_id });
        }
        setSaveState("saved");
        setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1800);
      } catch (err) {
        window.notifyError?.("Autosave failed", String(err.message || err));
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
  const onAddRow = (gun_no, qty) => {
    const trimmed = String(gun_no || "").trim();
    if (!trimmed) return;
    dirty((d) => ({ ...d, rows: [...(d.rows || []), { id: smUid(), gun_no: trimmed, qty: Number(qty) || 1, values: {} }] }));
    setShowAddRow(false);
  };

  // ------- Add col -------------------------------------------------------
  const onAddCol = (col_name, col_type) => {
    const trimmed = String(col_name || "").trim();
    if (!trimmed) return;
    if ((draft.cols || []).some((c) => c.col_name === trimmed)) {
      window.notifyError?.("Column exists", `"${trimmed}" already exists.`);
      return;
    }
    dirty((d) => ({ ...d, cols: [...(d.cols || []), { id: smUid(), col_name: trimmed, col_type: col_type || "spare", locked: false }] }));
    setShowAddCol(false);
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
      rows: (d.rows || []).map((r) => r.id === rowId ? { ...r, [field]: field === "qty" ? (Number(val) || 0) : val } : r),
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
  const onAutoFill = async () => {
    setBusyAuto(true);
    try {
      const resp = await ObaraBackend?.bom?.list?.();
      const bomRows = Array.isArray(resp) ? resp : (resp?.rows || resp?.bom || []);
      if (!Array.isArray(bomRows) || !bomRows.length) {
        window.notifyError?.("Auto-fill", "No BOM rows available.");
        return;
      }
      // Group children by parent (gun)
      const byParent = new Map();
      bomRows.forEach((b) => {
        const parent = String(b.parent_part_no || b.parent_item || b.parent || "").trim().toUpperCase();
        if (!parent) return;
        const child = String(b.child_part_no || b.child_item || b.child || "").trim();
        if (!child) return;
        const list = byParent.get(parent) || [];
        list.push({ child, qty: Number(b.qty) || 1, type: String(b.consumable_spare || b.type || "spare").toLowerCase() });
        byParent.set(parent, list);
      });
      let filled = 0;
      dirty((d) => {
        const cols = [...(d.cols || [])];
        const colNames = new Set(cols.map((c) => c.col_name));
        const rows = (d.rows || []).map((r) => {
          const children = byParent.get(String(r.gun_no || "").toUpperCase()) || [];
          const values = { ...(r.values || {}) };
          children.forEach((ch) => {
            if (!colNames.has(ch.child)) {
              cols.push({ id: smUid(), col_name: ch.child, col_type: ch.type === "consumable" ? "consumable" : "spare", locked: false });
              colNames.add(ch.child);
            }
            if (!values[ch.child]) { values[ch.child] = String(ch.qty); filled += 1; }
          });
          return { ...r, values };
        });
        return { ...d, cols, rows };
      });
      window.notifySuccess?.("Auto-fill complete", `${filled} cells populated.`);
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
    const gunIx = [ix("gun_no"), ix("gun"), ix("gun no"), ix("part")].find((n) => n >= 0);
    const qtyIx = [ix("qty"), ix("quantity")].find((n) => n >= 0);
    if (gunIx == null || gunIx < 0) {
      setImportErr("File must include a 'gun_no' column.");
      return;
    }
    const spareCols = headers
      .map((h, i) => ({ name: h, i }))
      .filter((c) => c.i !== gunIx && c.i !== qtyIx && c.name);

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
      const qty = qtyIx != null && qtyIx >= 0 ? (Number(row[qtyIx]) || 1) : 1;
      const values = {};
      spareCols.forEach((c) => { const v = row[c.i]; if (v != null && String(v) !== "") values[c.name] = String(v); });
      const upper = gunNo.toUpperCase();
      const exists = existingByGun.get(upper);
      if (exists) {
        const ixR = merged.findIndex((m) => m.id === exists.id);
        if (ixR >= 0) merged[ixR] = { ...exists, qty, values: { ...(exists.values || {}), ...values } };
      } else {
        const newRow = { id: smUid(), gun_no: gunNo, qty, values };
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
    const headers = ["gun_no", "qty", ...(draft.cols || []).map((c) => c.col_name)];
    const data = (draft.rows || []).map((r) => [
      r.gun_no || "",
      r.qty || 0,
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
    setBusySync(true);
    try {
      // Flatten matrix → recommended part_no rows
      const partTotals = new Map();
      (draft.rows || []).forEach((r) => {
        const rowQty = Number(r.qty) || 1;
        (draft.cols || []).forEach((c) => {
          const cellQty = Number((r.values || {})[c.col_name]);
          if (!cellQty) return;
          const key = c.col_name;
          partTotals.set(key, (partTotals.get(key) || 0) + (cellQty * rowQty));
        });
      });
      const rec = Array.from(partTotals.entries())
        .map(([part_no, qty]) => ({ part_no, qty }))
        .sort((a, b) => b.qty - a.qty);
      const next = { ...draft, recommended: rec, updated_at: new Date().toISOString() };
      smUpsert(next);
      onChange(next);
      setDraft(next);
      if (draft.customer_id && ObaraBackend?.spareMatrix?.recommend) {
        await ObaraBackend.spareMatrix.recommend({ customer_id: draft.customer_id });
      }
      window.notifySuccess?.("Recommended spares synced", `${rec.length} parts updated.`);
    } catch (err) {
      window.notifyError?.("Sync failed", String(err.message || err));
    } finally {
      setBusySync(false);
    }
  };

  const onExportRecommended = (format) => {
    const rec = draft.recommended || [];
    if (!rec.length) { window.notifyError?.("Nothing to export", "Sync recommended spares first."); return; }
    const filename = `RecommendedSpares_${(draft.name || "untitled").replace(/[^A-Za-z0-9_-]+/g, "_")}`;
    const aoa = [["part_no", "qty"], ...rec.map((r) => [r.part_no, r.qty])];
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

  const onDeleteMatrix = () => {
    if (!window.confirm(`Delete matrix "${draft.name}"? This cannot be undone.`)) return;
    smRemove(draft.id);
    onDelete(draft.id);
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
              onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setTitleEdit(false); }}
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
          <SMAddColForm onAdd={onAddCol} onCancel={() => setShowAddCol(false)} />
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
                    <th style={{ minWidth: 110, position: "sticky", left: 0, background: "var(--paper-3)", zIndex: 2 }}>gun_no</th>
                    <th className="r" style={{ minWidth: 60 }}>qty</th>
                    {(draft.cols || []).map((c) => (
                      <th key={c.id} style={{ minWidth: 110 }} title={c.col_type}>
                        {c.locked && <span style={{ marginRight: 4, color: "var(--ink-4)" }}>{Icon.lock}</span>}
                        {c.col_name}
                      </th>
                    ))}
                    <th style={{ width: 28 }}></th>
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
                      <td className="r mono">
                        <input
                          className="input mono"
                          type="number"
                          min={0}
                          value={r.qty || 0}
                          onChange={(e) => onRowMetaChange(r.id, "qty", e.target.value)}
                          style={{ height: 26, fontSize: 11.5, padding: "0 6px", width: 56, textAlign: "right" }}
                        />
                      </td>
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

      {/* Recommended sub-view */}
      {recView && (
        <Card title="Recommended spares" eyebrow="flattened from worksheet"
              right={<>
                <Btn sm kind="primary" onClick={onSyncRecommended} disabled={busySync}>{busySync ? "…" : "Sync from matrix"}</Btn>
                <Btn sm kind="ghost" onClick={() => onExportRecommended("csv")}>CSV</Btn>
                <Btn sm kind="ghost" onClick={() => onExportRecommended("tsv")}>TSV</Btn>
                <Btn sm kind="ghost" onClick={() => onExportRecommended("json")}>JSON</Btn>
              </>}>
          {!(draft.recommended || []).length ? (
            <div className="body" style={{ color: "var(--ink-3)" }}>No recommendations yet. Click Sync from matrix.</div>
          ) : (
            <table className="tbl">
              <thead><tr><th>Part</th><th className="r">Qty</th></tr></thead>
              <tbody>
                {(draft.recommended || []).map((r, i) => (
                  <tr key={i}><td className="mono"><span className="pri">{r.part_no}</span></td><td className="r mono">{r.qty}</td></tr>
                ))}
              </tbody>
            </table>
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

// ---------- Add Row form ----------
const SMAddRowForm = ({ onAdd, onCancel }) => {
  const { useState: uF, useRef: rF, useEffect: eF } = React;
  const [gunNo, setGunNo] = uF("");
  const [qty, setQty] = uF(1);
  const ref = rF(null);
  eF(() => { ref.current?.focus(); }, []);
  const submit = (e) => { e?.preventDefault(); onAdd(gunNo, qty); };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "end" }}>
      <div style={{ flex: 1 }}>
        <div className="label">gun_no</div>
        <input ref={ref} className="input mono" value={gunNo} onChange={(e) => setGunNo(e.target.value)} placeholder="e.g. X-Gun" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
      </div>
      <div style={{ width: 100 }}>
        <div className="label">qty</div>
        <input className="input mono" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
      </div>
      <Btn sm type="submit" kind="primary">Add row</Btn>
      <Btn sm kind="ghost" onClick={onCancel}>Cancel</Btn>
    </form>
  );
};

// ---------- Add Col form ----------
const SMAddColForm = ({ onAdd, onCancel }) => {
  const { useState: uF, useRef: rF, useEffect: eF } = React;
  const [name, setName] = uF("");
  const [type, setType] = uF("spare");
  const ref = rF(null);
  eF(() => { ref.current?.focus(); }, []);
  const submit = (e) => { e?.preventDefault(); onAdd(name, type); };
  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "end" }}>
      <div style={{ flex: 1 }}>
        <div className="label">column name (part #)</div>
        <input ref={ref} className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. SRTC-K12464" onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
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
      <Btn sm kind="ghost" onClick={onCancel}>Cancel</Btn>
    </form>
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
                    onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
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
  const [matrices, setMatrices] = uM(() => smReadAll());
  const [activeId, setActiveId] = uM(() => (smReadAll()[0]?.id || ""));
  const [showNew, setShowNew] = uM(false);

  const customers = useFetch(() => ObaraBackend?.customers?.list?.() || Promise.resolve([]), []);
  const customerList = mM(() => {
    const d = customers.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return d.customers || d.rows || [];
  }, [customers.data]);

  // Sync matrices state with localStorage when other tabs/instances change
  eM(() => {
    const onStorage = (e) => { if (e.key === SM_LS_KEY) setMatrices(smReadAll()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const onCreate = async ({ customer_id, project_name, name }) => {
    const now = new Date().toISOString();
    const matrix = {
      id: smUid(),
      customer_id,
      project_name,
      name,
      created_at: now,
      updated_at: now,
      rows: [],
      cols: [],
      recommended: [],
    };
    smUpsert(matrix);
    setMatrices(smReadAll());
    setActiveId(matrix.id);
    setShowNew(false);
    try {
      if (ObaraBackend?.spareMatrix?.recommend) {
        await ObaraBackend.spareMatrix.recommend({ customer_id });
      }
    } catch (err) {
      window.notifyError?.("Could not seed recommendations", String(err.message || err));
    }
    window.notifySuccess?.("Matrix created", name);
  };

  const onMatrixChange = (next) => {
    setMatrices((all) => {
      const ix = all.findIndex((m) => m.id === next.id);
      if (ix < 0) return [...all, next];
      const copy = [...all]; copy[ix] = next; return copy;
    });
  };

  const onMatrixDelete = (id) => {
    setMatrices((all) => all.filter((m) => m.id !== id));
    setActiveId((cur) => (cur === id ? (smReadAll()[0]?.id || "") : cur));
  };

  const active = mM(() => matrices.find((m) => m.id === activeId), [matrices, activeId]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 14, alignItems: "start" }}>
      {/* Left rail */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, position: "sticky", top: 0 }}>
        <Btn kind="primary" sm full onClick={() => setShowNew(true)}>{Icon.plus} New matrix</Btn>
        <Card flush>
          {customers.error ? (
            <Banner kind="bad" icon={Icon.alert} title="Could not load customers">
              <span className="mono-sm">{String(customers.error.message || customers.error)}</span>
            </Banner>
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
        {!active ? (
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
  const [months, setMonths] = uS(12);
  const [obsMonths, setObsMonths] = uS(18);
  const [state, setState] = uS({ data: null, loading: false, error: null });

  const run = async () => {
    setState({ data: null, loading: true, error: null });
    try {
      let data;
      if (tab === "recommend")     data = await ObaraBackend?.spareMatrix?.recommend?.({ customer_id: customerId });
      else if (tab === "kit")      data = await ObaraBackend?.spareMatrix?.kit?.({ customer_id: customerId, months: Number(months) || 12 });
      else if (tab === "opps")     data = await ObaraBackend?.spareMatrix?.opportunities?.(customerId);
      else if (tab === "obsolete") data = await ObaraBackend?.spareMatrix?.obsolete?.(Number(obsMonths) || 18);
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
const SM_TABS = [
  { id: "worksheet",    label: "Worksheet" },
  { id: "recommend",    label: "Recommend" },
  { id: "kit",          label: "Kit" },
  { id: "opps",         label: "Opportunities" },
  { id: "obsolete",     label: "Obsolete" },
];

const WiredSparesWorksheet = () => {
  const { useState: uW, useMemo: mW } = React;
  const [active, setActive] = uW("worksheet");
  const [customerId, setCustomerId] = uW("");

  const customers = useFetch(() => ObaraBackend?.customers?.list?.() || Promise.resolve([]), []);
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
        meta="worksheet · recommend · kit · opportunities · obsolete"
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
