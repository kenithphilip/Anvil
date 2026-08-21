// The quote, beside what Anvil read out of it — as a TAB, not an overlay.
//
// This began life as a modal. A modal is the wrong shape for the job: checking
// line items against a document is slow, comparative work, and an overlay
// covering the workspace both steals the room the comparison needs and adds a
// layer the operator has to dismiss to see anything else. It lives in the tab
// bar beside Reconcile now, where the same PDF|Split|Lines habit already
// applies to the PO.
//
// ReviewDocPane on the left is the SAME component the Reconcile tab mounts for
// the PO: it resolves the document, renders through pdf.js (an iframe would be
// blocked — the CSP declares no frame-src), carries the zoom controls, falls
// back by mime, downloads, and re-signs the URL every nine minutes against a
// ten-minute TTL.

import React, { useEffect, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { ReviewDocPane } from "./ReviewPane";
import type { AttachedQuote } from "./QuotesStrip";

interface Line {
  line_index: number | null;
  part_no: string | null;
  customer_part_number: string | null;
  description: string | null;
  qty: number | null;
  uom: string | null;
  listed_unit_price: number | null;
  discounted_unit_price: number | null;
  line_amount: number | null;
  cgst_pct: number | null;
  sgst_pct: number | null;
  igst_pct: number | null;
  remark: string | null;
}

const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: dp });

export const QuotePane: React.FC<{
  orderId: string;
  attached: AttachedQuote[];
  selectedDocId: string | null;
  onSelect: (documentId: string) => void;
  onChanged?: () => void;
}> = ({ orderId, attached, selectedDocId, onSelect, onChanged }) => {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);

  const docId = selectedDocId || attached[0]?.document_id || null;

  useEffect(() => {
    if (!docId) return;
    let live = true;
    setData(null); setErr(null); setConfirmDetach(false);
    (async () => {
      try {
        const r: any = await AnvilBackend?.orders?.attachedQuote?.(orderId, docId);
        if (live) setData(r);
      } catch (e: any) {
        if (live) setErr(e?.message || String(e));
      }
    })();
    return () => { live = false; };
  }, [orderId, docId]);

  const detach = async () => {
    setBusy(true);
    try {
      await AnvilBackend?.orders?.detachQuote?.(orderId, docId);
      onChanged?.();
    } catch (e: any) {
      setErr(e?.message || String(e));
      setConfirmDetach(false);
    } finally {
      setBusy(false);
    }
  };

  if (!attached.length) {
    return (
      <Banner kind="info" icon={Icon.info} title="No quote attached to this PO">
        <span className="mono-sm">
          Attach the quotation this order was placed against, and its line items appear here beside the document.
        </span>
      </Banner>
    );
  }

  const quote = data?.quote;
  const lines: Line[] = Array.isArray(data?.lines) ? data.lines : [];
  const superseded = data?.superseded_by || null;

  return (
    <div className="qp">
      {/* Selector only when there is a choice to make. */}
      {attached.length > 1 && (
        <div className="qp-tabs" role="group" aria-label="Attached quotes">
          {attached.map((a) => (
            <button
              key={a.document_id}
              type="button"
              className={"qp-tab" + (a.document_id === docId ? " is-active" : "")}
              aria-pressed={a.document_id === docId}
              onClick={() => onSelect(a.document_id)}
            >
              {a.quote?.quote_number || a.filename}
              {!a.ingested && <span className="qp-tab-flag">{a.superseded_by ? "dup" : "unread"}</span>}
            </button>
          ))}
        </div>
      )}

      {err && (
        <Banner kind="bad" icon={Icon.alert} title="Could not open this quote">
          <span className="mono-sm">{err}</span>
        </Banner>
      )}

      {data && (
        <div className="qp-head mono-sm">
          {quote?.quote_number && <b>{quote.quote_number}</b>}
          {quote?.revision && <Chip k="info">{quote.revision}</Chip>}
          {superseded && <Chip k="info">duplicate</Chip>}
          {quote && (
            <span style={{ color: "var(--ink-3)" }}>
              {quote.line_count} line{quote.line_count === 1 ? "" : "s"}
              {quote.grand_total != null && ` · ${quote.currency || ""} ${num(quote.grand_total, 0)}`}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {superseded && (
            confirmDetach ? (
              <>
                <span style={{ color: "var(--ink-3)" }}>Remove this duplicate? The file itself is kept.</span>
                <Btn sm kind="danger" disabled={busy} onClick={detach}>Remove</Btn>
                <Btn sm kind="ghost" disabled={busy} onClick={() => setConfirmDetach(false)}>Cancel</Btn>
              </>
            ) : (
              <Btn sm kind="ghost" disabled={busy} onClick={() => setConfirmDetach(true)}>Remove duplicate…</Btn>
            )
          )}
        </div>
      )}

      <div className="qp-split">
        <div className="qp-doc">
          <ReviewDocPane docId={docId} />
        </div>
        <div className="qp-lines">
          {!data ? (
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Loading…</div>
          ) : lines.length === 0 ? (
            <Banner kind="warn" icon={Icon.info} title="No lines were read from this document">
              <span className="mono-sm">
                {superseded
                  ? "This is a duplicate upload — the copy that carries the quote holds the lines."
                  : "Nothing was extracted, so this quote is not being compared against the PO."}
              </span>
            </Banner>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="tbl mono-sm">
                <thead>
                  <tr>
                    <th>#</th><th>Part</th><th>Description</th>
                    <th style={{ textAlign: "right" }}>Qty</th>
                    <th style={{ textAlign: "right" }}>List</th>
                    <th style={{ textAlign: "right" }}>Net</th>
                    <th style={{ textAlign: "right" }}>Amount</th>
                    <th style={{ textAlign: "right" }}>GST</th>
                    <th>Remark</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const gst = (l.cgst_pct || 0) + (l.sgst_pct || 0) + (l.igst_pct || 0);
                    return (
                      <tr key={i}>
                        <td>{l.line_index != null ? l.line_index + 1 : i + 1}</td>
                        <td>{l.part_no || "—"}{l.customer_part_number ? ` / ${l.customer_part_number}` : ""}</td>
                        <td>{l.description || "—"}</td>
                        <td style={{ textAlign: "right" }}>{num(l.qty, 3)}{l.uom ? ` ${l.uom}` : ""}</td>
                        {/* List shown only where it differs — a single-price
                            quote must not imply a discount it never carried. */}
                        <td style={{ textAlign: "right", color: "var(--ink-3)" }}>
                          {l.listed_unit_price != null && l.listed_unit_price !== l.discounted_unit_price
                            ? num(l.listed_unit_price) : "—"}
                        </td>
                        <td style={{ textAlign: "right", fontWeight: 600 }}>{num(l.discounted_unit_price)}</td>
                        <td style={{ textAlign: "right" }}>{num(l.line_amount)}</td>
                        <td style={{ textAlign: "right" }}>{gst ? `${gst.toFixed(2).replace(/\.00$/, "")}%` : "—"}</td>
                        <td style={{ color: "var(--ink-3)" }}>{l.remark || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuotePane;
