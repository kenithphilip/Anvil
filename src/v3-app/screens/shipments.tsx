// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Shipments CRUD overlay
// Adds create / edit / status-update / POD-toggle / delete on top
// of the read-only list in wired-shipments-b.jsx. Wins via load order.
// ============================================================

const SHIPMENT_MODES = ["sea", "air", "road", "courier"];
const SHIPMENT_STATUSES = [
  "PLANNED", "READY", "IN_TRANSIT", "AT_PORT", "CLEARED",
  "DELIVERED", "POD_RECEIVED", "EXCEPTION",
];

const SHIPMENT_FORM_BLANK = () => ({
  shipment_number: "",
  mode: "sea",
  carrier: "",
  vessel_name: "",
  flight_number: "",
  vehicle_number: "",
  port_of_loading: "",
  port_of_discharge: "",
  eta: "",
  status: "PLANNED",
  pod_received: false,
  notes: "",
  order_id: "",
});

const shipReadParams = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1];
  return new URLSearchParams(q || "");
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
    Promise.resolve(ObaraBackend?.sales?.listShipments?.() || { shipments: [] })
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
        setForm({ ...SHIPMENT_FORM_BLANK(), ...found });
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
        ? (ObaraBackend?.sales?.updateShipment || ObaraBackend?.sales?.upsertShipment)
        : (ObaraBackend?.sales?.createShipment || ObaraBackend?.sales?.upsertShipment);
      let result;
      if (typeof fn === "function") {
        result = await fn(payload);
      } else {
        const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
        const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
        const headers = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
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
      const fn = ObaraBackend?.sales?.deleteShipment;
      if (typeof fn === "function") {
        await fn(id);
      } else {
        const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
        const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
        const headers = {};
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
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
      const fn = ObaraBackend?.sales?.updateShipment || ObaraBackend?.sales?.upsertShipment;
      if (typeof fn === "function") {
        await fn({ id, status });
      } else {
        const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
        const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
        const headers = { "Content-Type": "application/json" };
        if (session?.access_token) headers.Authorization = "Bearer " + session.access_token;
        if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
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
                  {SHIPMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
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
                <label htmlFor="sh-vessel" className="label">Vessel name</label>
                <input id="sh-vessel" className="input mono" value={form.vessel_name} onChange={(ev) => setForm({ ...form, vessel_name: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-flight" className="label">Flight / vehicle</label>
                <input id="sh-flight" className="input mono" value={form.flight_number || form.vehicle_number || ""}
                       onChange={(ev) => setForm({ ...form, flight_number: ev.target.value, vehicle_number: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-pol" className="label">Port of loading</label>
                <input id="sh-pol" className="input" value={form.port_of_loading} onChange={(ev) => setForm({ ...form, port_of_loading: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-pod" className="label">Port of discharge</label>
                <input id="sh-pod" className="input" value={form.port_of_discharge} onChange={(ev) => setForm({ ...form, port_of_discharge: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-eta" className="label">ETA</label>
                <input id="sh-eta" type="date" className="input mono" value={(form.eta || "").slice(0, 10)} onChange={(ev) => setForm({ ...form, eta: ev.target.value })} />
              </div>
              <div>
                <label htmlFor="sh-order" className="label">Order id (optional)</label>
                <input id="sh-order" className="input mono" placeholder="UUID" value={form.order_id || ""} onChange={(ev) => setForm({ ...form, order_id: ev.target.value })} />
              </div>
              <div className="span-2">
                <label className="label">
                  <input type="checkbox" checked={!!form.pod_received}
                         onChange={(ev) => setForm({ ...form, pod_received: ev.target.checked, status: ev.target.checked ? "POD_RECEIVED" : form.status })} />
                  {" "}POD received
                </label>
              </div>
              <div className="span-2">
                <label htmlFor="sh-notes" className="label">Notes</label>
                <textarea id="sh-notes" className="input" rows={3} value={form.notes || ""} onChange={(ev) => setForm({ ...form, notes: ev.target.value })} />
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
                <>No shipments in this view. <a onClick={() => setActive("all")} style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</a></>}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Number</th>
                <th>Mode</th>
                <th>Carrier</th>
                <th>Vessel · flight</th>
                <th>Route</th>
                <th>ETA</th>
                <th>Status</th>
                <th style={{ width: 200 }}></th>
              </tr></thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => (
                  <tr key={r.id}>
                    <td className="mono"><span className="pri">{r.shipment_number || (r.id ? r.id.slice(0, 12) : "—")}</span></td>
                    <td><Chip k={r.mode === "air" ? "live" : r.mode === "courier" ? "plum" : "info"}>{r.mode || "—"}</Chip></td>
                    <td className="mono-sm">{r.carrier || "—"}</td>
                    <td className="mono-sm">{r.vessel_name || r.flight_number || r.vehicle_number || "—"}</td>
                    <td className="mono-sm">{(r.port_of_loading || r.origin || "—") + " → " + (r.port_of_discharge || r.destination || "—")}</td>
                    <td className="mono-sm">{(r.eta || "").slice(0, 10) || "—"}</td>
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
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredShipmentsCRUD;
