import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";

// Audit P8.5: list + minimal CRUD UI for the P7.5 credit / debit
// notes endpoint. Operators can browse, create a draft against an
// invoice or e-invoice, and step a row through the
// DRAFT -> ISSUED -> ACKNOWLEDGED lifecycle.

const STATUS_TONES: Record<string, "good" | "warn" | "bad" | "info"> = {
  DRAFT: "info",
  ISSUED: "warn",
  ACKNOWLEDGED: "good",
  CANCELLED: "bad",
};

const KIND_LABELS: Record<string, string> = {
  CREDIT: "Credit note",
  DEBIT:  "Debit note",
};

const REASONS = [
  "price_correction", "short_shipment", "tax_correction",
  "goods_returned", "discount_applied", "rebate", "other",
];

type Row = {
  id: string;
  kind: "CREDIT" | "DEBIT";
  status: string;
  note_number: string;
  note_date: string;
  reason: string;
  customer_id: string | null;
  invoice_id: string | null;
  einvoice_id: string | null;
  currency: string;
  grand_total: number;
  issued_at?: string | null;
  acknowledged_at?: string | null;
  cancelled_at?: string | null;
};

const CreditNotesScreen: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ kind: string; reason: string; invoice_id: string; einvoice_id: string; reason_text: string; line_items: string }>({
    kind: "CREDIT",
    reason: "price_correction",
    invoice_id: "",
    einvoice_id: "",
    reason_text: "",
    line_items: "[]",
  });

  const reload = () => {
    setLoading(true);
    Promise.resolve(ObaraBackend?.creditNotes?.list?.())
      .then((r: any) => {
        const list = Array.isArray(r?.credit_notes) ? r.credit_notes : (Array.isArray(r) ? r : []);
        setRows(list);
        setLoading(false);
        setError(null);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  };

  useEffect(reload, []);

  const filtered = rows.filter((r) => filter === "all" ? true : r.status === filter);

  const transition = async (id: string, status: string) => {
    setBusy(true);
    try {
      await ObaraBackend?.creditNotes?.transition?.(id, status);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    if (!window.confirm("Cancel this credit/debit note? This is a soft cancel and cannot be undone.")) return;
    setBusy(true);
    try {
      await ObaraBackend?.creditNotes?.cancel?.(id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      let lineItems: any[] = [];
      try { lineItems = JSON.parse(form.line_items); }
      catch { throw new Error("line_items must be valid JSON array"); }
      if (!form.invoice_id && !form.einvoice_id) throw new Error("invoice_id or einvoice_id required");
      await ObaraBackend?.creditNotes?.create?.({
        kind: form.kind,
        reason: form.reason,
        reason_text: form.reason_text || null,
        invoice_id: form.invoice_id || null,
        einvoice_id: form.einvoice_id || null,
        line_items: lineItems,
      });
      setCreating(false);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws">
      <WSTitle title="Credit + debit notes" meta="Audit P7.5: lifecycle DRAFT -> ISSUED -> ACKNOWLEDGED" />
      <WSTabs
        tabs={[
          { id: "all", label: "All (" + rows.length + ")" },
          { id: "DRAFT", label: "Draft" },
          { id: "ISSUED", label: "Issued" },
          { id: "ACKNOWLEDGED", label: "Acknowledged" },
          { id: "CANCELLED", label: "Cancelled" },
        ]}
        active={filter}
        onChange={setFilter}
      />
      {error && <Banner kind="bad">{error}</Banner>}
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <Btn onClick={() => setCreating(true)}>New credit/debit note</Btn>
        <Btn onClick={reload} kind="ghost">Refresh</Btn>
      </div>
      {creating && (
        <Card>
          <h4>Draft a new credit/debit note</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Kind
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="CREDIT">Credit note</option>
                <option value="DEBIT">Debit note</option>
              </select>
            </label>
            <label>Reason
              <select value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}>
                {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label>Invoice id
              <input value={form.invoice_id} onChange={(e) => setForm({ ...form, invoice_id: e.target.value })} placeholder="(or use einvoice)" />
            </label>
            <label>e-Invoice id
              <input value={form.einvoice_id} onChange={(e) => setForm({ ...form, einvoice_id: e.target.value })} />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>Reason text
              <input value={form.reason_text} onChange={(e) => setForm({ ...form, reason_text: e.target.value })} placeholder="Free-text explanation" />
            </label>
            <label style={{ gridColumn: "1 / -1" }}>Line items (JSON)
              <textarea
                rows={4}
                value={form.line_items}
                onChange={(e) => setForm({ ...form, line_items: e.target.value })}
                placeholder='[{"description":"...","quantity":1,"unitPrice":1000,"gstRate":18}]'
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn onClick={createDraft} disabled={busy}>{busy ? "Creating..." : "Create draft"}</Btn>
            <Btn onClick={() => setCreating(false)} kind="ghost">Cancel</Btn>
          </div>
        </Card>
      )}
      {loading ? (
        <Card><div style={{ padding: 16 }}>Loading credit notes...</div></Card>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>Number</th><th>Kind</th><th>Status</th><th>Date</th><th>Reason</th>
                <th>Total</th><th>Linked</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.note_number}</code></td>
                  <td>{KIND_LABELS[r.kind] || r.kind}</td>
                  <td><Chip k={STATUS_TONES[r.status] || "info"}>{r.status}</Chip></td>
                  <td>{r.note_date}</td>
                  <td>{r.reason}</td>
                  <td>{r.currency} {Number(r.grand_total || 0).toFixed(2)}</td>
                  <td>{r.invoice_id ? "INV" : r.einvoice_id ? "EINV" : "-"}</td>
                  <td>
                    {r.status === "DRAFT" && <Btn kind="ghost" onClick={() => transition(r.id, "ISSUED")} disabled={busy}>Issue</Btn>}
                    {r.status === "ISSUED" && <Btn kind="ghost" onClick={() => transition(r.id, "ACKNOWLEDGED")} disabled={busy}>Mark ack</Btn>}
                    {r.status !== "CANCELLED" && <Btn kind="ghost" onClick={() => cancel(r.id)} disabled={busy}>Cancel</Btn>}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 16, color: "#666" }}>No credit notes match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

export default CreditNotesScreen;
