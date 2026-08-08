import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
// Pure workbook-normalization shared with the /api/sales/shipment_import handler
// (the same module runs on both sides). Used here to parse the logistics sheet
// client-side and pre-filter the huge line sheets before posting.
import { parseSheets } from "../../api/_lib/shipment-import.js";

// Lazy-load SheetJS the same way the BOM importer does (dynamic import keeps it
// out of the main bundle and satisfies the CSP — no CDN <script>).
let __xlsxPromise: any = null;
const loadXLSX = (): Promise<any> => {
  if (typeof window !== "undefined" && (window as any).XLSX?.read) return Promise.resolve((window as any).XLSX);
  if (__xlsxPromise) return __xlsxPromise;
  __xlsxPromise = import("xlsx").then((m: any) => {
    const XLSX = (m && m.read) ? m : (m.default || m);
    try { if (typeof window !== "undefined") (window as any).XLSX = XLSX; } catch (_) { /* noop */ }
    return XLSX;
  });
  return __xlsxPromise;
};

// Read a workbook File into [{ name, rows(2D) }] sheets.
const fileToSheets = async (file: File): Promise<Array<{ name: string; rows: any[][] }>> => {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  return wb.SheetNames.map((name: string) => ({
    name,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: "" }),
  }));
};

// ============================================================
// ANVIL v3 — Shipments CRUD overlay
// Adds create / edit / status-update / POD-toggle / delete on top
// of the read-only list in wired-shipments-b.jsx. Wins via load order.
// ============================================================

// DB `shipment_mode` enum is upper-case (SEA/AIR/ROAD/COURIER). Sending a
// lower-case value silently drops the column server-side (the API MODES set is
// upper-case), which is the field-drift bug this form used to have.
const SHIPMENT_MODES = ["SEA", "AIR", "ROAD", "COURIER"];
const SHIPMENT_STATUSES = [
  "PLANNED", "READY", "IN_TRANSIT", "AT_PORT", "CLEARED",
  "DELIVERED", "POD_RECEIVED", "EXCEPTION",
];

// Form keys are the real `shipments` column names 1:1, so `submit` can POST/PATCH
// the form object directly with no name translation (the previous form used
// vessel_name / eta / notes, none of which are columns — they were dropped on
// every save). The date ladder mirrors the logistics team's tracker:
//   ready_date (ETD @ source) → vessel_sailing_date (ATD @ source)
//   → port_arrival_date (ATA @ India) → warehouse_receipt_date (ATA @ store)
//   → customer_delivery_date (direct-to-customer / HSS delivery).
const SHIPMENT_FORM_BLANK = () => ({
  shipment_number: "",
  mode: "SEA",
  carrier: "",
  vessel_or_flight: "",
  shipper_invoice_no: "",
  port_of_loading: "",
  port_of_discharge: "",
  ready_date: "",
  vessel_sailing_date: "",
  port_arrival_date: "",
  warehouse_receipt_date: "",
  customer_delivery_date: "",
  status: "PLANNED",
  pod_received: false,
  remarks: "",
  order_id: "",
  source_po_id: "",
});

// Coerce a persisted row (which may carry legacy field names from before the
// drift fix, or an already-correct row) into the form shape.
export const shipmentToForm = (row: any) => {
  const f: any = { ...SHIPMENT_FORM_BLANK(), ...row };
  f.mode = String(row.mode || "SEA").toUpperCase();
  // Legacy rows may have stashed a vessel under vessel_name; the ambiguous
  // single `eta` maps to the estimated port-arrival hop.
  if (!f.vessel_or_flight && (row.vessel_name || row.flight_number || row.vehicle_number)) {
    f.vessel_or_flight = row.vessel_name || row.flight_number || row.vehicle_number;
  }
  if (!f.port_arrival_date && row.eta) f.port_arrival_date = row.eta;
  if (!f.remarks && row.notes) f.remarks = row.notes;
  for (const k of ["ready_date", "vessel_sailing_date", "port_arrival_date", "warehouse_receipt_date", "customer_delivery_date"]) {
    f[k] = (f[k] || "").slice(0, 10);
  }
  return f;
};

const shipReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
};

// Show the furthest-along hop we have an actual date for, so the list reads as a
// progress column instead of a single ambiguous ETA. Falls back to the legacy
// `eta` for rows written before the delivery-ladder fields existed.
export const shipmentLatestDate = (r: any) => {
  const hops: Array<[string, any]> = [
    ["Customer", r.customer_delivery_date],
    ["Store", r.warehouse_receipt_date],
    ["India", r.port_arrival_date],
    ["Sailed", r.vessel_sailing_date],
    ["Ready", r.ready_date],
  ];
  for (const [label, v] of hops) {
    if (v) return `${label}: ${String(v).slice(0, 10)}`;
  }
  return r.eta ? `ETA: ${String(r.eta).slice(0, 10)}` : "—";
};

const statusChipKind = (status: string) =>
  status === "DELIVERED" || status === "POD_RECEIVED" ? "good"
    : status === "EXCEPTION" ? "bad"
      : status === "IN_TRANSIT" || status === "AT_PORT" ? "warn" : "ghost";

const SummaryStat = ({ label, value, tone }: { label: string; value: any; tone?: string }) => (
  <div style={{ minWidth: 92 }}>
    <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{label}</div>
    <div style={{ fontSize: 20, fontWeight: 700, color: tone === "warn" ? "var(--warn, #b8860b)" : "var(--ink)" }}>{value ?? 0}</div>
  </div>
);

// Import-from-workbook panel (Part C). Parses the logistics sheet client-side,
// pre-filters the huge line sheets to the invoices in play, previews the exact
// upsert plan (insert/update, project link, per-line receipts), then applies.
const ShipmentImportPanel = ({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) => {
  const [parsing, setParsing] = React.useState(false);
  const [parsed, setParsed] = React.useState<{ pending: any[]; lines: any[]; fileNames: string[] } | null>(null);
  const [preview, setPreview] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const onPick = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return;
    setParsing(true); setErr(null); setPreview(null); setParsed(null);
    try {
      let sheets: any[] = [];
      const fileNames: string[] = [];
      for (const f of Array.from(fileList)) {
        fileNames.push(f.name);
        sheets = sheets.concat(await fileToSheets(f));
      }
      const { pending, lines } = parseSheets(sheets);
      // The per-country line sheets carry years of history; only the rows whose
      // invoice is in the pending set matter, so drop the rest before posting.
      const pendInv = new Set(pending.map((p: any) => p.shipper_invoice_no));
      const relevantLines = lines.filter((l: any) => pendInv.has(l.shipper_invoice_no));
      setParsed({ pending, lines: relevantLines, fileNames });
      if (!pending.length) {
        setErr("No shipment rows found — expected a sheet with a 'Shipper Invoice No.' header (the Daily Shipment Reports / Pending sheet).");
      }
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setParsing(false); }
  };

  const call = async (mode: "preview" | "apply") =>
    AnvilBackend?.sales?.shipmentImport?.({ mode, pending: parsed!.pending, lines: parsed!.lines });

  const runPreview = async () => {
    if (!parsed) return;
    setBusy(true); setErr(null);
    try { setPreview(await call("preview")); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const runApply = async () => {
    if (!parsed) return;
    setBusy(true); setErr(null);
    try {
      const r: any = await call("apply");
      const s = r?.summary || {};
      window.notifySuccess?.("Sheet imported", `${s.inserted || 0} new · ${s.updated || 0} updated · ${s.line_receipts_applied || 0} receipts`);
      onApplied();
    } catch (e: any) { setErr(e?.message || String(e)); window.notifyError?.("Import failed", e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const s = preview?.summary;
  return (
    <Card title="Import from logistics sheet" eyebrow="upsert shipments from the daily workbook — no re-keying"
          right={<Btn sm icon kind="ghost" onClick={onClose} aria-label="Close">{Icon.x}</Btn>}>
      <Banner kind="info">
        Drop the logistics team's <b>Daily Shipment Reports</b> (and, to link shipments to their project + mark
        lines received, also the <b>In Transit Items Details</b>) workbook. Shipments match on invoice number.
        Nothing is written until you press <b>Apply</b>.
      </Banner>
      <div className="row" style={{ gap: 10, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
        <input type="file" accept=".xlsx,.xls" multiple onChange={(e) => onPick(e.target.files)} disabled={parsing || busy} />
        {parsing && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>Parsing…</span>}
      </div>
      {err && <Banner kind="bad" icon={Icon.alert} title="Import problem"><span className="mono-sm">{err}</span></Banner>}
      {parsed && (
        <div className="mono-sm" style={{ marginTop: 10, color: "var(--ink-3)" }}>
          Parsed {parsed.fileNames.join(", ")} → <b style={{ color: "var(--ink)" }}>{parsed.pending.length}</b> shipment row(s), <b style={{ color: "var(--ink)" }}>{parsed.lines.length}</b> matching line row(s).
        </div>
      )}
      {parsed && !preview && (
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <Btn kind="primary" disabled={busy || !parsed.pending.length} onClick={runPreview}>{busy ? "…" : "Preview"}</Btn>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        </div>
      )}
      {preview && (
        <>
          <div className="row" style={{ gap: 16, marginTop: 14, flexWrap: "wrap" }}>
            <SummaryStat label="Insert" value={s.to_insert} />
            <SummaryStat label="Update" value={s.to_update} />
            <SummaryStat label="Linked to project" value={s.linked_to_project} />
            <SummaryStat label="Unlinked" value={s.unlinked} tone={s.unlinked ? "warn" : undefined} />
            <SummaryStat label="Line receipts" value={s.line_receipts_matched} />
          </div>
          <table className="tbl" style={{ marginTop: 12 }}>
            <thead><tr><th>Invoice</th><th>Action</th><th>Supplier · items</th><th>Ladder</th><th>Status</th><th>Project link</th></tr></thead>
            <tbody>
              {(preview.shipments || []).map((p: any) => (
                <tr key={p.shipper_invoice_no}>
                  <td className="mono-sm"><span className="pri">{p.shipper_invoice_no}</span></td>
                  <td><Chip k={p.action === "insert" ? "good" : "info"}>{p.action}</Chip></td>
                  <td className="mono-sm">{[p.preview?.supplier, p.preview?.items].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="mono-sm">{[["S", p.preview?.vessel_sailing_date], ["I", p.preview?.port_arrival_date], ["W", p.preview?.warehouse_receipt_date]].filter(([, d]) => d).map(([k, d]) => `${k}:${String(d).slice(5)}`).join(" ") || "—"}</td>
                  <td><Chip k={statusChipKind(p.preview?.status) as any}>{String(p.preview?.status || "").toLowerCase().replace(/_/g, " ")}</Chip></td>
                  <td className="mono-sm">{p.linked ? <Chip k="good">{p.matched_po_ref}</Chip> : <span style={{ color: "var(--ink-3)" }}>unlinked</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <Btn kind="primary" disabled={busy} onClick={runApply}>{busy ? "Applying…" : `Apply — ${s.to_insert} new, ${s.to_update} updated`}</Btn>
            <Btn kind="ghost" disabled={busy} onClick={() => setPreview(null)}>Back</Btn>
            <Btn kind="ghost" disabled={busy} onClick={onClose}>Cancel</Btn>
          </div>
        </>
      )}
    </Card>
  );
};

const WiredShipmentsCRUD = ({ viewToggle }: { viewToggle?: React.ReactNode } = {}) => {
  const { useState: u, useEffect: e } = React;
  const params = shipReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";

  const [list, setList] = u({ rows: [], loading: true, error: null });
  const [active, setActive] = u("all");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [busy, setBusy] = u(false);
  const [importOpen, setImportOpen] = u(false);

  const reload = () => {
    setList((s) => ({ ...s, loading: true }));
    Promise.resolve(AnvilBackend?.sales?.listShipments?.() || { shipments: [] })
      .then((r) => {
        const rows = Array.isArray(r) ? r : (r?.shipments || r?.rows || []);
        setList({ rows, loading: false, error: null });
      })
      .catch((err) => setList({ rows: [], loading: false, error: err }));
  };

  e(reload, []);

  // Sync form state when query param changes
  e(() => {
    if (isNew) {
      setForm(SHIPMENT_FORM_BLANK());
      setEditing("__new__");
      return;
    }
    if (editId) {
      const found = list.rows.find((r) => r.id === editId);
      if (found) {
        setForm(shipmentToForm(found));
        setEditing(editId);
      }
      return;
    }
    setForm(null);
    setEditing(null);
  }, [editId, isNew, list.rows.length]);

  const closeForm = () => {
    setForm(null);
    setEditing(null);
    window.location.hash = "#/shipments";
  };

  const submit = async () => {
    if (!form) return;
    if (!form.shipment_number?.trim()) {
      window.notifyError?.("Shipment number is required");
      return;
    }
    setBusy(true);
    try {
      const payload = { ...form };
      if (editing && editing !== "__new__") payload.id = editing;
      // Try the dedicated client wrappers if exposed; otherwise direct fetch.
      const fn = (editing && editing !== "__new__")
        ? (AnvilBackend?.sales?.updateShipment || AnvilBackend?.sales?.upsertShipment)
        : (AnvilBackend?.sales?.createShipment || AnvilBackend?.sales?.upsertShipment);
      let result;
      if (typeof fn === "function") {
        result = await fn(payload);
      } else {
        const cfg = (AnvilBackend?.getConfig?.() || {});
        const session = (AnvilBackend?.getSession?.() || null);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
        const url = cfg.url.replace(/\/+$/, "") + "/api/sales/shipments";
        const resp = await fetch(url, {
          method: editing && editing !== "__new__" ? "PATCH" : "POST",
          headers,
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()));
        result = await resp.json();
      }
      window.notifySuccess?.(editing === "__new__" ? "Shipment created" : "Shipment updated", result?.shipment?.shipment_number || form.shipment_number);
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Save failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id, num) => {
    if (!window.confirm(`Delete shipment ${num || id}? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const fn = AnvilBackend?.sales?.deleteShipment;
      if (typeof fn === "function") {
        await fn(id);
      } else {
        const cfg = (AnvilBackend?.getConfig?.() || {});
        const session = (AnvilBackend?.getSession?.() || null);
        const headers: Record<string, string> = {};
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
        const url = cfg.url.replace(/\/+$/, "") + "/api/sales/shipments?id=" + encodeURIComponent(id);
        const resp = await fetch(url, { method: "DELETE", headers });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
      }
      window.notifySuccess?.("Shipment deleted", num || id);
      reload();
      closeForm();
    } catch (err) {
      window.notifyError?.("Delete failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Quick status update
  const setStatus = async (id, status) => {
    setBusy(true);
    try {
      const fn = AnvilBackend?.sales?.updateShipment || AnvilBackend?.sales?.upsertShipment;
      if (typeof fn === "function") {
        await fn({ id, status });
      } else {
        const cfg = (AnvilBackend?.getConfig?.() || {});
        const session = (AnvilBackend?.getSession?.() || null);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
        const url = cfg.url.replace(/\/+$/, "") + "/api/sales/shipments";
        await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ id, status }) });
      }
      window.notifySuccess?.("Status updated", status);
      reload();
    } catch (err) {
      window.notifyError?.("Status update failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const togglePod = async (row) => {
    await setStatus(row.id, row.pod_received ? row.status : "POD_RECEIVED");
  };

  const tabs = [
    { id: "all",          label: "All",          match: () => true },
    { id: "PLANNED",      label: "Planned",      match: (s) => s.status === "PLANNED" },
    { id: "READY",        label: "Ready",        match: (s) => s.status === "READY" },
    { id: "IN_TRANSIT",   label: "In transit",   match: (s) => s.status === "IN_TRANSIT" },
    { id: "AT_PORT",      label: "At port",      match: (s) => s.status === "AT_PORT" || s.status === "CLEARED" },
    { id: "DELIVERED",    label: "Delivered",    match: (s) => s.status === "DELIVERED" },
    { id: "POD_RECEIVED", label: "POD",          match: (s) => s.status === "POD_RECEIVED" },
    { id: "EXCEPTION",    label: "Exception",    match: (s) => s.status === "EXCEPTION" },
  ];
  const matcher = tabs.find((t) => t.id === active)?.match || (() => true);
  const filtered = list.rows.filter(matcher);
  const counts = Object.fromEntries(tabs.map((t) => [t.id, list.rows.filter(t.match).length]));

  return (
    <>
      <WSTitle
        eyebrow="Sales · Shipments"
        title="Shipments"
        meta={`${list.rows.length} total · ${counts.IN_TRANSIT || 0} in transit · ${counts.EXCEPTION || 0} exceptions`}
        right={<>
          {viewToggle}
          <Btn sm kind="ghost" onClick={() => setImportOpen((v) => !v)} title="Import from the logistics team's daily workbook">{Icon.upload || Icon.plus} Import sheet</Btn>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/shipments?new=1"}>{Icon.plus} New shipment</Btn>
        </>}
      />
      <WSTabs tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))} active={active} onChange={setActive} />

      <div className="ws-content">
        {list.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load shipments" action={<Btn sm onClick={reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        )}

        {importOpen && (
          <ShipmentImportPanel
            onClose={() => setImportOpen(false)}
            onApplied={() => { setImportOpen(false); reload(); }}
          />
        )}

        {form && (
          <Card title={editing === "__new__" ? "New shipment" : "Edit " + form.shipment_number}
                eyebrow="form"
                right={<Btn sm icon kind="ghost" onClick={closeForm} aria-label="Close">{Icon.x}</Btn>}>
            <div className="form-grid">
              <div>
                <label htmlFor="sh-num" className="label">Shipment number *</label>
                <input id="sh-num" className="input mono" value={form.shipment_number}
                       onChange={(ev) => setForm({ ...form, shipment_number: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-mode" className="label">Mode</label>
                <select id="sh-mode" className="select" value={form.mode} onChange={(ev) => setForm({ ...form, mode: ev.target.value })}>
                  {SHIPMENT_MODES.map((m) => <option key={m} value={m}>{m.charAt(0) + m.slice(1).toLowerCase()}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sh-carr" className="label">Carrier</label>
                <input id="sh-carr" className="input" value={form.carrier} onChange={(ev) => setForm({ ...form, carrier: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-status" className="label">Status</label>
                <select id="sh-status" className="select" value={form.status} onChange={(ev) => setForm({ ...form, status: ev.target.value })}>
                  {SHIPMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="sh-vessel" className="label">Vessel / flight</label>
                <input id="sh-vessel" className="input mono" value={form.vessel_or_flight} onChange={(ev) => setForm({ ...form, vessel_or_flight: ev.target.value })} placeholder="e.g., XIN MEI ZHOU" />
              </div>
              <div>
                <label htmlFor="sh-inv" className="label">Shipper invoice no.</label>
                <input id="sh-inv" className="input mono" value={form.shipper_invoice_no} onChange={(ev) => setForm({ ...form, shipper_invoice_no: ev.target.value })} placeholder="e.g., OK-CO-26-0166" />
              </div>
              <div>
                <label htmlFor="sh-pol" className="label">Port of loading</label>
                <input id="sh-pol" className="input" value={form.port_of_loading} onChange={(ev) => setForm({ ...form, port_of_loading: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-pod" className="label">Port of discharge</label>
                <input id="sh-pod" className="input" value={form.port_of_discharge} onChange={(ev) => setForm({ ...form, port_of_discharge: ev.target.value })} placeholder="e.g., Nhava Sheva" />
              </div>
              <div className="span-2">
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 4 }}>Delivery ladder — source → India port → store → customer</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 150px" }}>
                    <label htmlFor="sh-ready" className="label">Ready / ETD @ source</label>
                    <input id="sh-ready" type="date" className="input mono" value={form.ready_date || ""} onChange={(ev) => setForm({ ...form, ready_date: ev.target.value })} />
                  </div>
                  <div style={{ flex: "1 1 150px" }}>
                    <label htmlFor="sh-sail" className="label">Sailed / ATD @ source</label>
                    <input id="sh-sail" type="date" className="input mono" value={form.vessel_sailing_date || ""} onChange={(ev) => setForm({ ...form, vessel_sailing_date: ev.target.value })} />
                  </div>
                  <div style={{ flex: "1 1 150px" }}>
                    <label htmlFor="sh-arr" className="label">Arrived @ India port</label>
                    <input id="sh-arr" type="date" className="input mono" value={form.port_arrival_date || ""} onChange={(ev) => setForm({ ...form, port_arrival_date: ev.target.value })} />
                  </div>
                  <div style={{ flex: "1 1 150px" }}>
                    <label htmlFor="sh-whse" className="label">Received @ store</label>
                    <input id="sh-whse" type="date" className="input mono" value={form.warehouse_receipt_date || ""} onChange={(ev) => setForm({ ...form, warehouse_receipt_date: ev.target.value })} />
                  </div>
                  <div style={{ flex: "1 1 150px" }}>
                    <label htmlFor="sh-cust" className="label">Delivered @ customer</label>
                    <input id="sh-cust" type="date" className="input mono" value={form.customer_delivery_date || ""} onChange={(ev) => setForm({ ...form, customer_delivery_date: ev.target.value })} />
                  </div>
                </div>
              </div>
              <div>
                <label htmlFor="sh-order" className="label">Order id (link)</label>
                <input id="sh-order" className="input mono" placeholder="UUID — links to project / owner" value={form.order_id || ""} onChange={(ev) => setForm({ ...form, order_id: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-spo" className="label">Source PO id (link)</label>
                <input id="sh-spo" className="input mono" placeholder="UUID — links to import PO lines" value={form.source_po_id || ""} onChange={(ev) => setForm({ ...form, source_po_id: ev.target.value })} />
              </div>
              <div className="span-2">
                <label className="label">
                  <input type="checkbox" checked={!!form.pod_received}
                         onChange={(ev) => setForm({ ...form, pod_received: ev.target.checked, status: ev.target.checked ? "POD_RECEIVED" : form.status })} />
                  {" "}POD received
                </label>
              </div>
              <div className="span-2">
                <label htmlFor="sh-notes" className="label">Remarks</label>
                <textarea id="sh-notes" className="input" rows={3} value={form.remarks || ""} onChange={(ev) => setForm({ ...form, remarks: ev.target.value })} />
              </div>
            </div>
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <Btn kind="primary" disabled={busy} onClick={submit}>{busy ? "Saving…" : editing === "__new__" ? "Create" : "Save"}</Btn>
              <Btn kind="ghost" onClick={closeForm}>Cancel</Btn>
              <span style={{ flex: 1 }} />
              {editing && editing !== "__new__" && (
                <Btn kind="danger" disabled={busy} onClick={() => remove(editing, form.shipment_number)}>{Icon.x} Delete</Btn>
              )}
            </div>
          </Card>
        )}

        <Card flush>
          {list.loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading shipments…</div>
          ) : filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {list.rows.length === 0 ? "No shipments yet." :
                <>No shipments in this view. <button type="button" onClick={() => setActive("all")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</button></>}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Number</th>
                <th>Invoice</th>
                <th>Mode</th>
                <th>Vessel · flight</th>
                <th>Route</th>
                <th>Next / last date</th>
                <th>Status</th>
                <th style={{ width: 200 }}></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const modeLc = String(r.mode || "").toLowerCase();
                  return (
                  <tr key={r.id}>
                    <td className="mono"><span className="pri">{r.shipment_number || (r.id ? r.id.slice(0, 12) : "—")}</span></td>
                    <td className="mono-sm">{r.shipper_invoice_no || "—"}</td>
                    <td><Chip k={modeLc === "air" ? "live" : modeLc === "courier" ? "plum" : "info"}>{r.mode || "—"}</Chip></td>
                    <td className="mono-sm">{r.vessel_or_flight || r.vessel_name || r.flight_number || r.vehicle_number || "—"}</td>
                    <td className="mono-sm">{(r.port_of_loading || r.origin || "—") + " → " + (r.port_of_discharge || r.destination || "—")}</td>
                    <td className="mono-sm">{shipmentLatestDate(r)}</td>
                    <td><Chip k={r.status === "DELIVERED" || r.status === "POD_RECEIVED" ? "good" : r.status === "EXCEPTION" ? "bad" : r.status === "IN_TRANSIT" || r.status === "AT_PORT" ? "warn" : "ghost"}>{(r.status || "PLANNED").toLowerCase().replace(/_/g, " ")}</Chip></td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                        <Btn sm kind="ghost" onClick={() => window.location.hash = `#/shipments?id=${r.id}`} title="Edit">{Icon.eye}</Btn>
                        {r.status !== "POD_RECEIVED" && (
                          <Btn sm kind="ghost" onClick={() => togglePod(r)} title="Mark POD received" disabled={busy}>{Icon.check}</Btn>
                        )}
                        <Btn sm kind="ghost" onClick={() => remove(r.id, r.shipment_number)} disabled={busy} title="Delete">{Icon.x}</Btn>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};

// ============================================================
// Account-owner tracker — "By project" view
// Read-only lens over /api/sales/shipment_tracking that groups a caller's
// imported-equipment shipments by project (opportunity), so a sales engineer
// can follow delivery + commissioning without the logistics team's spreadsheet.
// ============================================================

const LADDER_HOPS: Array<[string, string]> = [
  ["Ready", "ready_date"],
  ["Sailed", "vessel_sailing_date"],
  ["India port", "port_arrival_date"],
  ["Store", "warehouse_receipt_date"],
  ["Customer", "customer_delivery_date"],
];

const ITEM_TYPE_CHIP: Record<string, { k: string; label: string }> = {
  project: { k: "info", label: "Project material" },
  spares: { k: "plum", label: "Spares" },
  internal: { k: "ghost", label: "Internal" },
  unknown: { k: "ghost", label: "Unclassified" },
};

// The delivery ladder as a row of hop pills; reached hops carry their date and
// are highlighted, pending hops read as a faint placeholder.
const ShipmentLadder = ({ s }: { s: any }) => (
  <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
    {LADDER_HOPS.map(([label, key], i) => {
      const v = s[key];
      const reached = !!v;
      return (
        <React.Fragment key={key}>
          {i > 0 && <span className="mono-sm" style={{ color: "var(--ink-4, var(--ink-3))" }}>›</span>}
          <span
            className="mono-sm"
            title={label}
            style={{
              padding: "1px 7px", borderRadius: 6, whiteSpace: "nowrap",
              border: "1px solid var(--hairline-2)",
              background: reached ? "var(--good-bg, rgba(40,167,69,0.12))" : "transparent",
              color: reached ? "var(--ink)" : "var(--ink-3)",
              fontWeight: reached ? 600 : 400,
            }}
          >
            {label}{reached ? " " + String(v).slice(0, 10) : ""}
          </span>
        </React.Fragment>
      );
    })}
  </div>
);

const ViewToggle = ({ view, setView }: { view: string; setView: (v: "list" | "projects") => void }) => (
  <div className="row" style={{ gap: 2 }} role="tablist" aria-label="Shipments view">
    <Btn sm kind={view === "list" ? "primary" : "ghost"} onClick={() => setView("list")} aria-pressed={view === "list"}>Logistics list</Btn>
    <Btn sm kind={view === "projects" ? "primary" : "ghost"} onClick={() => setView("projects")} aria-pressed={view === "projects"}>By project</Btn>
  </div>
);

const trackerGroupKey = (r: any) => r.opportunity_id || (r.customer_id ? "cust:" + r.customer_id : "none");

const ShipmentTracker = ({ viewToggle, onOpen }: { viewToggle?: React.ReactNode; onOpen: (id: string) => void }) => {
  const [state, setState] = React.useState<{ rows: any[]; loading: boolean; error: any }>({ rows: [], loading: true, error: null });
  const [mine, setMine] = React.useState(true);

  const load = React.useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    const params: any = mine ? { mine: "1" } : undefined;
    Promise.resolve(AnvilBackend?.sales?.shipmentTracking?.(params) || { shipments: [] })
      .then((r: any) => setState({ rows: Array.isArray(r) ? r : (r?.shipments || []), loading: false, error: null }))
      .catch((err: any) => setState({ rows: [], loading: false, error: err }));
  }, [mine]);

  React.useEffect(() => { load(); }, [load]);

  // Group by project (opportunity), else by customer, else "Direct / unassigned".
  const groups: Array<{ key: string; project: string; customer: string | null; owner: string | null; item_type: string; rows: any[] }> = [];
  const byKey = new Map<string, number>();
  for (const r of state.rows) {
    const key = trackerGroupKey(r);
    let idx = byKey.get(key);
    if (idx == null) {
      idx = groups.length;
      byKey.set(key, idx);
      groups.push({
        key,
        project: r.project_name || r.customer_name || "Direct / unassigned",
        customer: r.customer_name || null,
        owner: r.owner_name || null,
        item_type: r.item_type || "unknown",
        rows: [],
      });
    }
    groups[idx].rows.push(r);
  }

  const total = state.rows.length;
  const delivered = state.rows.filter((r) => r.status === "DELIVERED" || r.status === "POD_RECEIVED").length;
  const inTransit = state.rows.filter((r) => r.status === "IN_TRANSIT" || r.status === "AT_PORT").length;

  return (
    <>
      <WSTitle
        eyebrow="Sales · Shipments"
        title="Shipments by project"
        meta={`${total} shipment${total === 1 ? "" : "s"} · ${inTransit} in transit · ${delivered} delivered`}
        right={<>
          {viewToggle}
          <Btn sm kind={mine ? "primary" : "ghost"} onClick={() => setMine((m) => !m)} title="Toggle between only my projects and all">
            {mine ? "My projects" : "All projects"}
          </Btn>
          <Btn icon kind="ghost" sm onClick={load} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />
      <div className="ws-content">
        {state.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load tracking" action={<Btn sm onClick={load}>Retry</Btn>}>
            <span className="mono-sm">{String(state.error?.message || state.error)}</span>
          </Banner>
        )}
        {state.loading ? (
          <Card><div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading tracking…</div></Card>
        ) : groups.length === 0 ? (
          <Card>
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {mine
                ? "No shipments on your projects yet. Shipments link to a project via their order → opportunity owner."
                : "No shipments yet."}
            </div>
          </Card>
        ) : (
          groups.map((g) => {
            const it = ITEM_TYPE_CHIP[g.item_type] || ITEM_TYPE_CHIP.unknown;
            return (
              <Card
                key={g.key}
                title={g.project}
                eyebrow={[g.customer, g.owner ? "owner: " + g.owner : null].filter(Boolean).join(" · ") || "unassigned"}
                right={<Chip k={it.k as any}>{it.label}</Chip>}
              >
                <table className="tbl">
                  <thead><tr>
                    <th>Invoice / no.</th>
                    <th>Mode</th>
                    <th>Delivery ladder</th>
                    <th>Lines</th>
                    <th>Promised</th>
                    <th>Status</th>
                    <th style={{ width: 70 }}></th>
                  </tr></thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.id}>
                        <td className="mono-sm">
                          <span className="pri">{r.shipper_invoice_no || r.shipment_number || (r.id ? r.id.slice(0, 8) : "—")}</span>
                          {r.vessel_or_flight ? <div style={{ color: "var(--ink-3)" }}>{r.vessel_or_flight}</div> : null}
                        </td>
                        <td><Chip k={String(r.mode || "").toLowerCase() === "air" ? "live" : String(r.mode || "").toLowerCase() === "courier" ? "plum" : "info"}>{r.mode || "—"}</Chip></td>
                        <td><ShipmentLadder s={r} /></td>
                        <td className="mono-sm">{r.lines ? `${r.lines.received}/${r.lines.total}` : "—"}</td>
                        <td className="mono-sm">{r.committed_delivery_date ? String(r.committed_delivery_date).slice(0, 10) : "—"}</td>
                        <td><Chip k={statusChipKind(r.status) as any}>{(r.status || "PLANNED").toLowerCase().replace(/_/g, " ")}</Chip></td>
                        <td>
                          <Btn sm kind="ghost" onClick={() => onOpen(r.id)} title="Open in logistics editor">{Icon.eye}</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
};

// Top-level screen: toggles between the logistics-team CRUD list and the
// account-owner "by project" tracker. The view is reflected in the hash so it
// survives a refresh / deep link, without clobbering the CRUD's ?id / ?new.
const ShipmentsScreen = () => {
  const [view, setView] = React.useState<"list" | "projects">(
    () => (shipReadParams().get("view") === "projects" ? "projects" : "list"),
  );
  const toggle = <ViewToggle view={view} setView={setView} />;
  if (view === "projects") {
    return (
      <ShipmentTracker
        viewToggle={toggle}
        onOpen={(id: string) => { window.location.hash = `#/shipments?id=${id}`; setView("list"); }}
      />
    );
  }
  return <WiredShipmentsCRUD viewToggle={toggle} />;
};

export default ShipmentsScreen;
