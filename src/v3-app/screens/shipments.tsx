import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

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

const WiredShipmentsCRUD = () => {
  const { useState: u, useEffect: e } = React;
  const params = shipReadParams();
  const editId = params.get("id");
  const isNew = params.get("new") === "1";

  const [list, setList] = u({ rows: [], loading: true, error: null });
  const [active, setActive] = u("all");
  const [editing, setEditing] = u(null);
  const [form, setForm] = u(null);
  const [busy, setBusy] = u(false);

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


export default WiredShipmentsCRUD;
