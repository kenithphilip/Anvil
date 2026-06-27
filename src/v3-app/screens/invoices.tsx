// Invoices list + detail screen.
//
// Reads /api/invoices for the tenant's invoices, lets the operator
// open a detail view for any row, send the invoice to the customer
// (queues a comms row + flips status to sent), download the PDF,
// regenerate the share link, mark paid, void.

import React, { useEffect, useMemo, useState } from "react";
import { ageLabel, fmtCurrency, fmtDate } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, Modal, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const STATUS_TABS = [
  { id: "all",     label: "All" },
  { id: "draft",   label: "Draft" },
  { id: "sent",    label: "Sent" },
  { id: "overdue", label: "Overdue" },
  { id: "paid",    label: "Paid" },
  { id: "void",    label: "Void" },
];

const statusChip = (s: string) => {
  if (s === "paid")    return <Chip k="live">paid</Chip>;
  if (s === "partial") return <Chip k="warn">partial</Chip>;
  if (s === "sent")    return <Chip k="info">sent</Chip>;
  if (s === "overdue") return <Chip k="bad">overdue</Chip>;
  if (s === "void")    return <Chip k="ghost">void</Chip>;
  return <Chip k="ghost">draft</Chip>;
};

// fmtMoney is a thin alias kept so the existing call sites read
// naturally; it delegates to the canonical fmtCurrency helper so
// every screen uses the same locale + symbol logic.
const fmtMoney = (amount: any, currency: string = "USD") => fmtCurrency(amount, currency);

// Payment methods offered in the manual record-payment form. Customers
// are OEMs paying through SAP AP runs, so corporate bank rails lead; the
// hosted card gateways (Stripe/Razorpay) stay as a separate optional
// online path and are not listed here. Mirrors PAYMENT_METHODS in
// src/api/_lib/payments.js.
const PAYMENT_METHOD_OPTIONS = [
  { id: "bank_transfer", label: "Bank transfer" },
  { id: "rtgs",          label: "RTGS" },
  { id: "neft",          label: "NEFT" },
  { id: "wire",          label: "Wire transfer" },
  { id: "cheque",        label: "Cheque" },
  { id: "imps",          label: "IMPS" },
  { id: "upi",           label: "UPI" },
  { id: "cash",          label: "Cash" },
  { id: "other",         label: "Other" },
];

const todayISO = () => new Date().toISOString().slice(0, 10);

const WiredInvoices = () => {
  const [tab, setTab] = useState("all");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: string; msg: string } | null>(null);
  // Record-payment modal. payRow holds the invoice being settled; the
  // form defaults amount to the outstanding balance (full payment) but
  // the operator can enter less for a partial receipt.
  const [payRow, setPayRow] = useState<any | null>(null);
  const [payForm, setPayForm] = useState<{ amount: string; tds: string; method: string; reference: string; paid_at: string; note: string }>(
    { amount: "", tds: "", method: "bank_transfer", reference: "", paid_at: todayISO(), note: "" }
  );
  const [payBusy, setPayBusy] = useState(false);

  // load() is shared by the tab-change effect and by manual refetch
  // (after a mutation). The cancel-flag pattern prevents a stale
  // response from clobbering newer state when the user flips tabs
  // faster than the API responds. Without it, switching `paid` ->
  // `draft` while the `paid` request was in flight could overwrite
  // the `draft` rows with the late `paid` response.
  const load = async (signal?: { cancelled: boolean }) => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string> = {};
      if (tab !== "all") params.status = tab;
      const resp: any = await ObaraBackend?.invoices?.list?.(params);
      if (signal?.cancelled) return;
      setRows(resp?.invoices || []);
    } catch (err: any) {
      if (signal?.cancelled) return;
      setError(err);
      setRows([]);
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  };
  useEffect(() => {
    const signal = { cancelled: false };
    load(signal);
    return () => { signal.cancelled = true; };
    /* eslint-disable-next-line */
  }, [tab]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, draft: 0, sent: 0, overdue: 0, paid: 0, void: 0, partial: 0 };
    for (const r of rows) {
      c.all++;
      if (c[r.status] != null) c[r.status]++;
    }
    return c;
  }, [rows]);

  const totals = useMemo(() => {
    const sums: Record<string, number> = { outstanding: 0, paid: 0, overdue: 0 };
    const today = new Date();
    for (const r of rows) {
      const grand = Number(r.grand_total) || 0;
      const paid = Number(r.paid_amount) || 0;
      if (r.status === "paid") sums.paid += grand;
      else if (r.status === "void") continue;
      else {
        sums.outstanding += grand - paid;
        if (r.due_date && new Date(r.due_date) < today && r.status !== "paid") {
          sums.overdue += grand - paid;
        }
      }
    }
    return sums;
  }, [rows]);

  const downloadPdf = async (row: any) => {
    setBusy(row.id);
    try {
      const blob = await ObaraBackend?.invoices?.pdfBlob?.(row.id);
      if (!blob) throw new Error("PDF helper unavailable");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "invoice-" + row.invoice_number + ".pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setFlash({ kind: "good", msg: "Saved invoice " + row.invoice_number });
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
    } finally { setBusy(null); }
  };

  const sendInvoice = async (row: any) => {
    setBusy(row.id);
    try {
      const resp: any = await ObaraBackend?.invoices?.send?.({ id: row.id });
      // Fire the queued comm immediately via the existing comms.send
      // path. Audit fix (May 2026): the previous code swallowed
      // errors silently; the operator saw "queued + sent" even when
      // the immediate-send failed and the comm sat in the queue.
      // Now we surface the queue status honestly.
      let immediateOk = true;
      let immediateErr = null;
      if (resp?.communication_id) {
        try { await ObaraBackend?.communications?.send?.({ id: resp.communication_id }); }
        catch (e: any) { immediateOk = false; immediateErr = e; }
      }
      if (immediateOk) {
        setFlash({ kind: "good", msg: "Invoice " + row.invoice_number + " queued + sent" });
        window.notifySuccess?.("Invoice sent", row.invoice_number);
      } else {
        setFlash({ kind: "warn", msg: "Invoice " + row.invoice_number + " queued. Immediate send failed: " + (immediateErr?.message || "unknown") + ". Comms reaper will retry." });
        window.notifyWarn?.("Queued, immediate send failed", immediateErr?.message || "unknown");
      }
      await load();
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
      window.notifyError?.("Send failed", err?.message || String(err));
    } finally { setBusy(null); }
  };

  const outstandingOf = (row: any) =>
    Math.max(0, (Number(row.grand_total) || 0) - (Number(row.paid_amount) || 0));

  const openPay = (row: any) => {
    setPayRow(row);
    setPayForm({
      amount: String(outstandingOf(row).toFixed(2)),
      tds: "",
      method: "bank_transfer",
      reference: "",
      paid_at: todayISO(),
      note: "",
    });
  };

  const submitPayment = async () => {
    if (!payRow) return;
    const amount = Number(payForm.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setFlash({ kind: "bad", msg: "Enter a cash-received amount greater than zero" });
      return;
    }
    const tds = payForm.tds ? Number(payForm.tds) : 0;
    if (!Number.isFinite(tds) || tds < 0) {
      setFlash({ kind: "bad", msg: "TDS must be zero or a positive number" });
      return;
    }
    setPayBusy(true);
    try {
      const resp: any = await ObaraBackend?.invoices?.recordPayment?.(payRow.id, {
        amount,
        tds: tds || undefined,
        method: payForm.method,
        reference: payForm.reference || undefined,
        paid_at: payForm.paid_at || undefined,
        note: payForm.note || undefined,
      });
      const status = resp?.status || resp?.invoice?.status;
      const tdsMsg = tds > 0 ? " (+ " + fmtMoney(tds, payRow.currency) + " TDS)" : "";
      setFlash({
        kind: "good",
        msg: "Recorded " + fmtMoney(amount, payRow.currency) + tdsMsg + " on " + payRow.invoice_number +
             (status === "paid" ? " — now fully paid" : " — partially paid"),
      });
      window.notifySuccess?.("Payment recorded", payRow.invoice_number);
      setPayRow(null);
      await load();
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
    } finally { setPayBusy(false); }
  };

  const voidInvoice = async (row: any) => {
    setBusy(row.id);
    try {
      await ObaraBackend?.invoices?.void?.(row.id);
      setFlash({ kind: "good", msg: "Voided " + row.invoice_number });
      await load();
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
    } finally { setBusy(null); }
  };

  return (
    <>
      <WSTitle
        eyebrow="Finance · Invoices"
        title="Invoices"
        meta={`${counts.all} total · ${counts.sent || 0} sent · ${counts.overdue || 0} overdue · ${counts.paid || 0} paid`}
        right={<Btn icon kind="ghost" sm onClick={() => load()} title="Refresh">{Icon.cycle}</Btn>}
      />
      <WSTabs
        tabs={STATUS_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || 0 }))}
        active={tab}
        onChange={setTab}
      />
      <div className="ws-content">
        {flash && (
          <Banner kind={flash.kind} icon={flash.kind === "bad" ? Icon.alert : Icon.check}
                  title={flash.kind === "bad" ? "Error" : "Done"}>
            <span className="mono-sm">{flash.msg}</span>
          </Banner>
        )}
        {error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load invoices" action={<Btn sm onClick={() => load()}>Retry</Btn>}>
            <span className="mono-sm">{String(error.message || error)}</span>
          </Banner>
        )}
        <KPIRow cols={3}>
          <KPI lbl="Outstanding" v={fmtMoney(totals.outstanding)} d="not yet collected" live={totals.outstanding > 0} />
          <KPI lbl="Overdue"     v={fmtMoney(totals.overdue)}     d="past due date" dKind={totals.overdue > 0 ? "down" : ""} />
          <KPI lbl="Paid"        v={fmtMoney(totals.paid)}        d="this view" />
        </KPIRow>
        <Card title="Invoices" eyebrow={tab === "all" ? "every invoice" : tab + " invoices"} flush>
          {loading ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No invoices in this view. Create one from any order's workspace.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Invoice</th>
                <th>Order</th>
                <th>Issued</th>
                <th>Due</th>
                <th className="r">Total</th>
                <th>Status</th>
                <th style={{ width: 280 }}></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.invoice_number}</td>
                    <td className="mono-sm">{r.order_id ? String(r.order_id).slice(0, 8) : "—"}</td>
                    <td className="mono-sm">{fmtDate(r.issue_date)}</td>
                    <td className="mono-sm" title={r.due_date ? ageLabel(r.due_date) : ""}>{fmtDate(r.due_date)}</td>
                    <td className="r mono">{fmtMoney(r.grand_total, r.currency)}</td>
                    <td>{statusChip(r.status)}</td>
                    <td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <Btn sm kind="ghost" disabled={busy === r.id} onClick={() => downloadPdf(r)}>{Icon.download} pdf</Btn>
                        {r.status === "draft" && (
                          <Btn sm kind="ghost" disabled={busy === r.id} onClick={() => sendInvoice(r)}>{Icon.send} send</Btn>
                        )}
                        {(r.status === "sent" || r.status === "partial" || r.status === "overdue") && (
                          <Btn sm kind="ghost" disabled={busy === r.id} onClick={() => openPay(r)}>{Icon.check} record payment</Btn>
                        )}
                        {r.status !== "paid" && r.status !== "void" && (
                          <Btn sm kind="ghost" disabled={busy === r.id} onClick={() => voidInvoice(r)}>{Icon.x} void</Btn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="How invoicing works" eyebrow="non-India · GSTN sits alongside as einvoices">
          <div className="body mono-sm" style={{ color: "var(--ink-2)" }}>
            <p style={{ margin: 0 }}>
              Click <code>New invoice</code> on any order's workspace to draft one. The number is allocated
              atomically per tenant; concurrent drafts always get distinct invoice numbers.
            </p>
            <p style={{ marginTop: 8 }}>
              <code>Send</code> renders a fresh PDF, uploads it, regenerates a 7-day share link, queues an
              email via the existing comms pipeline (SendGrid if configured), and flips status to
              <code> sent</code>. <code>Record payment</code> logs an OEM payment (bank transfer, RTGS, NEFT
              or wire) with its reference; enter the <code>cash received</code> plus any <code>TDS withheld</code>
              and the invoice clears in full (cash + TDS), matching how SAP settles an AR open item. Short
              receipts flip the invoice to <code>partial</code> until fully settled.
            </p>
          </div>
        </Card>
      </div>

      <Modal
        open={!!payRow}
        title={payRow ? "Record payment · " + payRow.invoice_number : "Record payment"}
        onClose={() => (payBusy ? null : setPayRow(null))}
        maxWidth={460}
      >
        {payRow && (
          <>
            <Modal.Body>
              <div className="mono-sm" style={{ color: "var(--ink-2)" }}>
                Total {fmtMoney(payRow.grand_total, payRow.currency)} ·
                already paid {fmtMoney(payRow.paid_amount, payRow.currency)} ·
                outstanding <strong>{fmtMoney(outstandingOf(payRow), payRow.currency)}</strong>
              </div>
              <label className="mono-sm">Cash received ({payRow.currency || "INR"})
                <input
                  type="number" min="0" step="0.01" autoFocus
                  value={payForm.amount}
                  onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>
              <label className="mono-sm">TDS withheld at source (optional)
                <input
                  type="number" min="0" step="0.01" placeholder="0.00"
                  value={payForm.tds}
                  onChange={(e) => setPayForm({ ...payForm, tds: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>
              {(() => {
                const cash = Number(payForm.amount) || 0;
                const tds = Number(payForm.tds) || 0;
                const remaining = outstandingOf(payRow) - cash - tds;
                return (
                  <div className="mono-sm" style={{ color: remaining <= 0.005 ? "var(--ok, var(--ink-2))" : "var(--ink-3)" }}>
                    Cash {fmtMoney(cash, payRow.currency)} + TDS {fmtMoney(tds, payRow.currency)} ·{" "}
                    {remaining <= 0.005
                      ? "settles the invoice in full"
                      : "leaves " + fmtMoney(remaining, payRow.currency) + " outstanding (partial)"}
                  </div>
                );
              })()}
              <label className="mono-sm">Method
                <select
                  value={payForm.method}
                  onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}
                  style={{ width: "100%" }}
                >
                  {PAYMENT_METHOD_OPTIONS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
              <label className="mono-sm">Reference (UTR / UPI ref / cheque no)
                <input
                  type="text" placeholder="optional"
                  value={payForm.reference}
                  onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>
              <label className="mono-sm">Date received
                <input
                  type="date"
                  value={payForm.paid_at}
                  onChange={(e) => setPayForm({ ...payForm, paid_at: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>
              <label className="mono-sm">Note
                <input
                  type="text" placeholder="optional"
                  value={payForm.note}
                  onChange={(e) => setPayForm({ ...payForm, note: e.target.value })}
                  style={{ width: "100%" }}
                />
              </label>
            </Modal.Body>
            <Modal.Footer>
              <Btn kind="ghost" disabled={payBusy} onClick={() => setPayRow(null)}>Cancel</Btn>
              <Btn disabled={payBusy} onClick={submitPayment}>{payBusy ? "Recording…" : "Record payment"}</Btn>
            </Modal.Footer>
          </>
        )}
      </Modal>
    </>
  );
};

export default WiredInvoices;
