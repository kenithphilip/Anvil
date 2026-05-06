// Invoices list + detail screen.
//
// Reads /api/invoices for the tenant's invoices, lets the operator
// open a detail view for any row, send the invoice to the customer
// (queues a comms row + flips status to sent), download the PDF,
// regenerate the share link, mark paid, void.

import React, { useEffect, useMemo, useState } from "react";
import { ageLabel, fmtCurrency, fmtDate } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
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

const WiredInvoices = () => {
  const [tab, setTab] = useState("all");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: string; msg: string } | null>(null);

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

  const markPaid = async (row: any) => {
    setBusy(row.id);
    try {
      await ObaraBackend?.invoices?.update?.(row.id, { status: "paid", paid_amount: row.grand_total });
      setFlash({ kind: "good", msg: "Marked " + row.invoice_number + " paid" });
      await load();
    } catch (err: any) {
      setFlash({ kind: "bad", msg: err.message || String(err) });
    } finally { setBusy(null); }
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
                          <Btn sm kind="ghost" disabled={busy === r.id} onClick={() => markPaid(r)}>{Icon.check} paid</Btn>
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
              <code> sent</code>. <code>Mark paid</code> records the full amount and flips to <code>paid</code>.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
};

export default WiredInvoices;
