import React, { useEffect, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";

// Does the invoice agree with the customer's purchase order?
//
// #467 built this check and shipped it with no caller. It has been correct and
// unreachable since — the exact habit the rest of this codebase keeps paying
// for, and the reason "nothing yet checks invoices against POs in practice"
// sat in the backlog under a merged PR.
//
// Why it matters commercially: a large buyer books an incoming invoice against
// the PO it was raised for. If the lines, quantities or prices disagree, no
// goods receipt is raised — and no GRN means no payment. The invoice is not
// rejected, it simply is not paid, and nobody tells you. This answers the
// question before it is sent, which is the only time the answer is cheap.
//
// READ-ONLY, deliberately. Refusing to send on a blocking verdict is PR3 of
// the reconciler scope, and it is gated on three decisions the owner has not
// made — a price tolerance, who may accept a variance, and whether a GST-rate
// difference is a hard block. Showing the check needs none of those answers,
// so it ships now and stops being invisible.

type Line = {
  part_no?: string | null;
  description?: string | null;
  verdict: string;
  blocking?: boolean;
  invoice_qty?: number | null;
  po_qty?: number | null;
  po_rate?: number | null;
  invoice_rate?: number | null;
  price_delta_pct?: number | null;
  previously_billed_qty?: number | null;
  cumulative_billed_qty?: number | null;
  over_by?: number | null;
  ambiguous?: boolean;
  detail?: string | null;
};
type Result = {
  order_po_number?: string | null;
  invoice?: { invoice_number?: string | null; status?: string | null };
  can_send: boolean;
  summary: { blocking: number; not_invoiced: number; total?: number; matched?: number };
  lines: Line[];
  not_invoiced: { part_no?: string | null; description?: string | null; remaining_qty?: number | null }[];
  totals?: { invoice_total?: number | null; po_line_total?: number | null; delta_pct?: number | null; mismatch?: boolean };
  po_reference?: string | null;
  prior_invoices?: { invoice_number?: string | null; status?: string | null; counted?: boolean }[];
};

// The API's vocabulary is precise and tells an AP clerk nothing. Each verdict
// says what is wrong AND what it costs, because "price_mismatch" does not
// convey that the invoice will sit unpaid.
const VERDICT: Record<string, { label: string; k: string; why: string }> = {
  matched:              { label: "Agrees",              k: "ok",   why: "" },
  description_mismatch: { label: "Wording differs",     k: "warn", why: "The description does not match the PO. Not usually a payment blocker, but a buyer matching on text may query it." },
  price_mismatch:       { label: "Price differs",       k: "bad",  why: "The rate does not match the PO. A buyer's system will hold this for a price query and no GRN will be raised." },
  qty_over_ordered:     { label: "Over-ordered",        k: "bad",  why: "This invoice bills more than the PO allows, counting what earlier invoices already billed. It cannot be received." },
  not_on_po:            { label: "Not on the PO",       k: "bad",  why: "The buyer's PO has no such line, so there is nothing to receive it against." },
};

const n = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
const pct = (v?: number | null) => (v == null ? "—" : `${Math.round(v * 100) / 100}%`);

export const InvoicePoCheck: React.FC<{ orderId: string; invoiceId?: string | null }> = ({ orderId, invoiceId }) => {
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!orderId) return;
    setBusy(true); setErr(null);
    Promise.resolve(AnvilBackend?.orders?.reconcileInvoice?.(orderId, invoiceId ? { invoice_id: invoiceId } : undefined))
      .then((r: any) => setRes(r || null))
      .catch((e: any) => setErr(e?.message || String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(load, [orderId, invoiceId]);

  if (err) return <Banner kind="bad" title="Could not check the invoice against the PO">{err}</Banner>;
  if (busy && !res) return <Card><div className="body mono-sm" style={{ padding: 18 }}>Checking…</div></Card>;
  if (!res) return null;

  const problems = (res.lines || []).filter((l) => l.verdict !== "matched");
  const agreed = (res.lines || []).filter((l) => l.verdict === "matched");

  return (
    <Card
      title="Invoice vs purchase order"
      eyebrow={`${res.invoice?.invoice_number || "proposed invoice"} against PO ${res.order_po_number || "—"}`}
      right={<Btn sm kind="ghost" onClick={load} disabled={busy}>Re-check</Btn>}
    >
      {/* The headline is the commercial consequence, not the count. */}
      {res.can_send ? (
        <Banner kind="ok" title="Nothing here should stop this being received">
          <span className="mono-sm">
            Every invoiced line matches the PO on part, quantity and price within tolerance.
          </span>
        </Banner>
      ) : (
        <Banner kind="bad" title={`${res.summary.blocking} line${res.summary.blocking === 1 ? "" : "s"} a buyer cannot receive`}>
          <span className="mono-sm">
            A buyer books an invoice against the PO it was raised for. Where they disagree no goods receipt is
            raised, and no receipt means no payment — the invoice is not rejected, it just sits.
          </span>
        </Banner>
      )}

      <KPIRow>
        <KPI lbl="Invoice total" v={n(res.totals?.invoice_total)} />
        <KPI lbl="PO line total" v={n(res.totals?.po_line_total)} />
        <KPI lbl="Difference" v={pct(res.totals?.delta_pct)} />
        <KPI lbl="Lines that disagree" v={String(res.summary.blocking)} />
      </KPIRow>

      {res.po_reference === null && (
        // Migration 214 put the buyer's PO number on the invoice. Without it
        // the buyer has nothing to book against, whatever the lines say.
        <Banner kind="warn" title="This invoice does not carry the buyer's PO number">
          <span className="mono-sm">
            Their AP system matches on it. An invoice without it is keyed by hand or returned.
          </span>
        </Banner>
      )}

      {problems.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="tbl" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Part</th><th>Verdict</th><th>Invoice qty</th><th>PO qty</th>
                <th>Invoice rate</th><th>PO rate</th><th>What it means</th>
              </tr>
            </thead>
            <tbody>
              {problems.map((l, i) => {
                const v = VERDICT[l.verdict] || { label: l.verdict, k: "warn", why: "" };
                return (
                  <tr key={(l.part_no || "") + i}>
                    <td className="mono-sm">
                      {n(l.part_no)}
                      {l.ambiguous && (
                        // The PO lists this part twice, so "which line did you
                        // mean" has no answer. Reported, never guessed.
                        <> <Chip k="warn">ambiguous on the PO</Chip></>
                      )}
                    </td>
                    <td><Chip k={v.k as never}>{v.label}</Chip></td>
                    <td className="mono-sm" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n(l.invoice_qty)}</td>
                    <td className="mono-sm" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n(l.po_qty)}</td>
                    <td className="mono-sm" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n(l.invoice_rate)}</td>
                    <td className="mono-sm" style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{n(l.po_rate)}</td>
                    <td className="mono-sm" style={{ opacity: 0.8 }}>
                      {l.detail || v.why}
                      {l.over_by != null && l.over_by > 0 && ` Over by ${l.over_by}, counting ${n(l.previously_billed_qty)} already billed.`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {res.not_invoiced?.length > 0 && (
        // NOT a defect — it is the normal state of a partial invoice — so it is
        // reported separately and never counted as a discrepancy.
        <div className="mono-sm" style={{ marginTop: 12, opacity: 0.85 }}>
          <strong>Ordered but not on this invoice:</strong>{" "}
          {res.not_invoiced.map((x) => `${x.part_no || x.description}${x.remaining_qty != null ? ` (${x.remaining_qty} left)` : ""}`).join(", ")}.
          Normal on a partial invoice.
        </div>
      )}

      {agreed.length > 0 && problems.length > 0 && (
        <div className="mono-sm" style={{ marginTop: 8, opacity: 0.7 }}>
          {agreed.length} other line{agreed.length === 1 ? "" : "s"} agree with the PO.
        </div>
      )}

      {(res.prior_invoices?.length ?? 0) > 0 && (
        <div className="mono-sm" style={{ marginTop: 8, opacity: 0.7 }}>
          Counting {res.prior_invoices!.filter((p) => p.counted).length} earlier invoice
          {res.prior_invoices!.filter((p) => p.counted).length === 1 ? "" : "s"} toward what has already been billed.
        </div>
      )}

      {/* Said out loud rather than implied by the absence of a button. */}
      <div className="mono-sm" style={{ marginTop: 12, opacity: 0.6 }}>
        This is a check, not a gate — nothing here stops the invoice being sent.
      </div>
    </Card>
  );
};
