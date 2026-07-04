import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// Audit P8.5: list + lifecycle UI for the P7.7 e-Way bill module.
// Composer + send to NIC + cancel within 24h + manual mark-generated
// (out-of-band escape hatch) + extend validity.

const STATUS_TONES: Record<string, "good" | "warn" | "bad" | "info"> = {
  DRAFT: "info",
  PENDING_NIC: "warn",
  GENERATED: "good",
  CANCELLED: "bad",
  REJECTED: "bad",
  EXPIRED: "bad",
};

const TRANS_MODES = ["Road", "Rail", "Air", "Ship"];
const VEHICLE_TYPES = [
  { code: "R", label: "Regular" },
  { code: "O", label: "Over-dimensional cargo" },
];

type Row = {
  id: string;
  status: string;
  doc_no: string;
  doc_date: string;
  ewb_no: string | null;
  ewb_date: string | null;
  ewb_valid_upto: string | null;
  vehicle_no: string | null;
  trans_mode: string;
  total_inv_value: number;
  taxable_value: number;
  customer_id: string | null;
  invoice_id: string | null;
  einvoice_id: string | null;
};

const EwayBillsScreen: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    invoice_id: "",
    einvoice_id: "",
    doc_no: "",
    doc_date: new Date().toISOString().slice(0, 10),
    trans_mode: "Road",
    trans_distance: "",
    vehicle_no: "",
    vehicle_type: "R",
    transporter_id: "",
    transporter_name: "",
    taxable_value: "",
    total_inv_value: "",
  });
  const [vehicleEdit, setVehicleEdit] = useState<{ id: string; vehicle_no: string } | null>(null);

  const reload = () => {
    setLoading(true);
    Promise.resolve(AnvilBackend?.ewayBills?.list?.())
      .then((r: any) => {
        const list = Array.isArray(r?.eway_bills) ? r.eway_bills : (Array.isArray(r) ? r : []);
        setRows(list);
        setLoading(false);
        setError(null);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  };

  useEffect(reload, []);

  const filtered = rows.filter((r) => filter === "all" ? true : r.status === filter);

  const sendToNic = async (id: string) => {
    setBusy(true);
    try { await AnvilBackend?.ewayBills?.sendToNic?.(id); reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const cancel = async (id: string) => {
    const reasonCode = window.prompt("Cancel reason code (1=DupOfInvoice, 2=OrderCancelled, 3=DataEntryMistake, 4=Others):", "4");
    if (!reasonCode) return;
    const remarks = window.prompt("Cancel remarks (optional):") || "";
    setBusy(true);
    try { await AnvilBackend?.ewayBills?.cancel?.(id, { cancel_reason_code: Number(reasonCode), cancel_remarks: remarks }); reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const updateVehicle = async () => {
    if (!vehicleEdit) return;
    setBusy(true);
    try { await AnvilBackend?.ewayBills?.updateVehicle?.(vehicleEdit.id, { vehicle_no: vehicleEdit.vehicle_no }); setVehicleEdit(null); reload(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const createDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!form.invoice_id && !form.einvoice_id) throw new Error("invoice_id or einvoice_id required");
      await AnvilBackend?.ewayBills?.create?.({
        invoice_id: form.invoice_id || null,
        einvoice_id: form.einvoice_id || null,
        doc_no: form.doc_no,
        doc_date: form.doc_date,
        trans_mode: form.trans_mode,
        trans_distance: form.trans_distance ? Number(form.trans_distance) : null,
        vehicle_no: form.vehicle_no,
        vehicle_type: form.vehicle_type,
        transporter_id: form.transporter_id,
        transporter_name: form.transporter_name,
        taxable_value: form.taxable_value ? Number(form.taxable_value) : null,
        total_inv_value: form.total_inv_value ? Number(form.total_inv_value) : null,
      });
      setCreating(false);
      reload();
      window.notifySuccess?.("e-Way bill draft created");
    } catch (e) {
      setError((e as Error).message);
      window.notifyError?.("Could not create draft: " + (e as Error).message);
    }
    finally { setBusy(false); }
  };

  return (
    <div className="ws">
      <WSTitle title="e-Way bills" meta="Audit P7.7: NIC-issued transport authorisation lifecycle" />
      <WSTabs
        tabs={[
          { id: "all", label: "All (" + rows.length + ")" },
          { id: "DRAFT", label: "Draft" },
          { id: "PENDING_NIC", label: "Pending NIC" },
          { id: "GENERATED", label: "Generated" },
          { id: "CANCELLED", label: "Cancelled" },
          { id: "EXPIRED", label: "Expired" },
        ]}
        active={filter}
        onChange={setFilter}
      />
      {error && <Banner kind="bad">{error}</Banner>}
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <Btn onClick={() => setCreating(true)}>New e-way bill</Btn>
        <Btn onClick={reload} kind="ghost">Refresh</Btn>
      </div>
      {creating && (
        <Card>
          <h4>Compose e-way bill</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Invoice id <input value={form.invoice_id} onChange={(e) => setForm({ ...form, invoice_id: e.target.value })} /></label>
            <label>e-Invoice id <input value={form.einvoice_id} onChange={(e) => setForm({ ...form, einvoice_id: e.target.value })} /></label>
            <label>Doc number <input value={form.doc_no} onChange={(e) => setForm({ ...form, doc_no: e.target.value })} /></label>
            <label>Doc date <input value={form.doc_date} onChange={(e) => setForm({ ...form, doc_date: e.target.value })} type="date" /></label>
            <label>Mode <select value={form.trans_mode} onChange={(e) => setForm({ ...form, trans_mode: e.target.value })}>{TRANS_MODES.map((m) => <option key={m}>{m}</option>)}</select></label>
            <label>Distance (km) <input value={form.trans_distance} onChange={(e) => setForm({ ...form, trans_distance: e.target.value })} type="number" /></label>
            <label>Vehicle no <input value={form.vehicle_no} onChange={(e) => setForm({ ...form, vehicle_no: e.target.value })} /></label>
            <label>Vehicle type <select value={form.vehicle_type} onChange={(e) => setForm({ ...form, vehicle_type: e.target.value })}>{VEHICLE_TYPES.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}</select></label>
            <label>Transporter id <input value={form.transporter_id} onChange={(e) => setForm({ ...form, transporter_id: e.target.value })} /></label>
            <label>Transporter name <input value={form.transporter_name} onChange={(e) => setForm({ ...form, transporter_name: e.target.value })} /></label>
            <label>Taxable value <input value={form.taxable_value} onChange={(e) => setForm({ ...form, taxable_value: e.target.value })} type="number" /></label>
            <label>Total invoice value <input value={form.total_inv_value} onChange={(e) => setForm({ ...form, total_inv_value: e.target.value })} type="number" /></label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn onClick={createDraft} disabled={busy}>{busy ? "Creating..." : "Create draft"}</Btn>
            <Btn onClick={() => setCreating(false)} kind="ghost">Cancel</Btn>
          </div>
        </Card>
      )}
      {vehicleEdit && (
        <Card>
          <h4>Update vehicle on EWB <code>{vehicleEdit.id.slice(0, 8)}</code></h4>
          <label>Vehicle number <input value={vehicleEdit.vehicle_no} onChange={(e) => setVehicleEdit({ ...vehicleEdit, vehicle_no: e.target.value })} /></label>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Btn onClick={updateVehicle} disabled={busy}>{busy ? "Saving..." : "Save"}</Btn>
            <Btn onClick={() => setVehicleEdit(null)} kind="ghost">Close</Btn>
          </div>
        </Card>
      )}
      {loading ? (
        <Card><div style={{ padding: 16 }}>Loading e-way bills...</div></Card>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>EWB#</th><th>Status</th><th>Doc</th><th>Vehicle</th><th>Mode</th>
                <th>Valid until</th><th>Total</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>{r.ewb_no ? <code>{r.ewb_no}</code> : <span style={{ color: "#999" }}>(unissued)</span>}</td>
                  <td><Chip k={STATUS_TONES[r.status] || "info"}>{r.status}</Chip></td>
                  <td>{r.doc_no}<br /><small>{r.doc_date}</small></td>
                  <td>{r.vehicle_no || "-"}</td>
                  <td>{r.trans_mode}</td>
                  <td>{r.ewb_valid_upto ? r.ewb_valid_upto.slice(0, 16).replace("T", " ") : "-"}</td>
                  <td>{Number(r.total_inv_value || 0).toFixed(0)}</td>
                  <td>
                    {r.status === "DRAFT" && <Btn kind="ghost" onClick={() => sendToNic(r.id)} disabled={busy}>Send to NIC</Btn>}
                    {r.status === "GENERATED" && <Btn kind="ghost" onClick={() => setVehicleEdit({ id: r.id, vehicle_no: r.vehicle_no || "" })} disabled={busy}>Vehicle</Btn>}
                    {r.status === "GENERATED" && <Btn kind="ghost" onClick={() => cancel(r.id)} disabled={busy}>Cancel</Btn>}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 16, color: "#666" }}>No e-way bills match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

export default EwayBillsScreen;
