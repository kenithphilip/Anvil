import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, WSTabs, WSTitle } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// Audit P8.5: list + minimal CRUD UI for the P7.6 recurring invoice
// schedule endpoint. Operators set cadence + amount + start/end and
// the daily cron generates an invoices row per cycle.

const STATUS_TONES: Record<string, "good" | "warn" | "bad" | "info"> = {
  ACTIVE: "good",
  PAUSED: "warn",
  CANCELLED: "bad",
};

const CADENCES = ["MONTHLY", "QUARTERLY", "BIANNUAL", "ANNUAL"];

type Row = {
  id: string;
  customer_id: string;
  contract_id: string | null;
  cadence: string;
  amount: number;
  currency: string;
  start_date: string;
  next_invoice_date: string;
  end_date: string | null;
  invoice_count: number;
  max_invoices: number | null;
  status: string;
  description: string | null;
  last_invoice_id: string | null;
  last_invoiced_at: string | null;
  last_error: string | null;
};

const RecurringInvoicesScreen: React.FC = () => {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    customer_id: "",
    contract_id: "",
    cadence: "QUARTERLY",
    amount: "",
    currency: "INR",
    start_date: new Date().toISOString().slice(0, 10),
    end_date: "",
    max_invoices: "",
    description: "",
    net_days: "30",
  });

  const reload = () => {
    setLoading(true);
    Promise.resolve(AnvilBackend?.billingRecurring?.list?.())
      .then((r: any) => {
        const list = Array.isArray(r?.schedules) ? r.schedules : (Array.isArray(r) ? r : []);
        setRows(list);
        setLoading(false);
        setError(null);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  };

  useEffect(reload, []);

  const filtered = rows.filter((r) => filter === "all" ? true : r.status === filter);

  const setStatus = async (id: string, action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      if (action === "pause") await AnvilBackend?.billingRecurring?.pause?.(id);
      else if (action === "resume") await AnvilBackend?.billingRecurring?.resume?.(id);
      else await AnvilBackend?.billingRecurring?.cancel?.(id);
      reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const createSchedule = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!form.customer_id) throw new Error("customer_id required");
      const amount = Number(form.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be a positive number");
      await AnvilBackend?.billingRecurring?.create?.({
        customer_id: form.customer_id,
        contract_id: form.contract_id || null,
        cadence: form.cadence,
        amount,
        currency: form.currency,
        start_date: form.start_date,
        end_date: form.end_date || null,
        max_invoices: form.max_invoices ? Number(form.max_invoices) : null,
        description: form.description || null,
        net_days: Number(form.net_days) || 30,
      });
      setCreating(false);
      reload();
      window.notifySuccess?.("Recurring schedule created");
    } catch (e) {
      setError((e as Error).message);
      window.notifyError?.("Could not create schedule: " + (e as Error).message);
    }
    finally { setBusy(false); }
  };

  return (
    <div className="ws">
      <WSTitle title="Recurring invoices" meta="Audit P7.6: cadence + amount; daily cron materialises invoices" />
      <WSTabs
        tabs={[
          { id: "all", label: "All (" + rows.length + ")" },
          { id: "ACTIVE", label: "Active" },
          { id: "PAUSED", label: "Paused" },
          { id: "CANCELLED", label: "Cancelled" },
        ]}
        active={filter}
        onChange={setFilter}
      />
      {error && <Banner kind="bad">{error}</Banner>}
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <Btn onClick={() => setCreating(true)}>New schedule</Btn>
        <Btn onClick={reload} kind="ghost">Refresh</Btn>
      </div>
      {creating && (
        <Card>
          <h4>New recurring schedule</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>Customer id <input value={form.customer_id} onChange={(e) => setForm({ ...form, customer_id: e.target.value })} /></label>
            <label>Contract id <input value={form.contract_id} onChange={(e) => setForm({ ...form, contract_id: e.target.value })} placeholder="(optional)" /></label>
            <label>Cadence
              <select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>
                {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>Amount <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} type="number" /></label>
            <label>Currency
              <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                <option>INR</option><option>USD</option><option>EUR</option><option>GBP</option>
              </select>
            </label>
            <label>Net days <input value={form.net_days} onChange={(e) => setForm({ ...form, net_days: e.target.value })} type="number" /></label>
            <label>Start date <input value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} type="date" /></label>
            <label>End date <input value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} type="date" placeholder="(optional)" /></label>
            <label>Max invoices <input value={form.max_invoices} onChange={(e) => setForm({ ...form, max_invoices: e.target.value })} type="number" placeholder="(optional cap)" /></label>
            <label style={{ gridColumn: "1 / -1" }}>Description <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <Btn onClick={createSchedule} disabled={busy}>{busy ? "Creating..." : "Create schedule"}</Btn>
            <Btn onClick={() => setCreating(false)} kind="ghost">Cancel</Btn>
          </div>
        </Card>
      )}
      {loading ? (
        <Card><div style={{ padding: 16 }}>Loading schedules...</div></Card>
      ) : (
        <Card>
          <table>
            <thead>
              <tr>
                <th>Cadence</th><th>Amount</th><th>Status</th><th>Next</th><th>Sent</th><th>Cap</th>
                <th>Customer</th><th>Last error</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>{r.cadence}</td>
                  <td>{r.currency} {Number(r.amount).toFixed(2)}</td>
                  <td><Chip k={STATUS_TONES[r.status] || "info"}>{r.status}</Chip></td>
                  <td>{r.next_invoice_date}</td>
                  <td>{r.invoice_count}</td>
                  <td>{r.max_invoices ?? "-"}</td>
                  <td><code>{r.customer_id?.slice(0, 8) || "-"}</code></td>
                  <td>{r.last_error ? <span style={{ color: "#a00" }}>{r.last_error.slice(0, 60)}</span> : "-"}</td>
                  <td>
                    {r.status === "ACTIVE" && <Btn kind="ghost" onClick={() => setStatus(r.id, "pause")} disabled={busy}>Pause</Btn>}
                    {r.status === "PAUSED" && <Btn kind="ghost" onClick={() => setStatus(r.id, "resume")} disabled={busy}>Resume</Btn>}
                    {r.status !== "CANCELLED" && <Btn kind="ghost" onClick={() => setStatus(r.id, "cancel")} disabled={busy}>Cancel</Btn>}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={9} style={{ padding: 16, color: "#666" }}>No schedules match this filter.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
};

export default RecurringInvoicesScreen;
