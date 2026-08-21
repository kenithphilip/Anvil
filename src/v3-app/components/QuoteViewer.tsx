// Read the quotation next to what Anvil read out of it.
//
// The card answers "did the upload work". This answers the question that comes
// straight after: "are those line items actually right?" — which cannot be
// settled from a row count, only by putting the document and the extraction
// side by side and letting the operator's eye do the comparison.
//
// The left pane is ReviewDocPane, the SAME component the PO review tab uses —
// not a second viewer. It resolves the document itself, renders PDF via pdf.js
// (an iframe would be blocked: the CSP declares no frame-src, so it falls back
// to default-src 'self' and a cross-origin PDF cannot load), carries the zoom
// controls, falls back by mime type, and ships its own download button.
//
// It also RE-SIGNS the URL every nine minutes. The signed URLs this app issues
// live for ten, so a viewer that resolved one once — as an earlier draft of
// this file did — renders a broken page for anyone who leaves the modal open
// while they check the figures. Which is the entire use case.

import React, { useEffect, useState } from "react";
import { Banner, Btn, Chip, Modal } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";
import { ReviewDocPane } from "./ReviewPane";

interface Line {
  line_index: number | null;
  part_no: string | null;
  customer_part_number: string | null;
  description: string | null;
  qty: number | null;
  uom: string | null;
  hsn_sac: string | null;
  listed_unit_price: number | null;
  discounted_unit_price: number | null;
  discount_pct: number | null;
  line_amount: number | null;
  cgst_pct: number | null;
  sgst_pct: number | null;
  igst_pct: number | null;
  remark: string | null;
}

const num = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: dp });

const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v).toFixed(2).replace(/\.00$/, "")}%`;

export const QuoteViewer: React.FC<{
  orderId: string;
  documentId: string | null;
  onClose: () => void;
  onDetached?: () => void;
}> = ({ orderId, documentId, onClose, onDetached }) => {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDetach, setConfirmDetach] = useState(false);

  useEffect(() => {
    if (!documentId) return;
    let live = true;
    setData(null); setErr(null); setConfirmDetach(false);
    (async () => {
      try {
        const r: any = await AnvilBackend?.orders?.attachedQuote?.(orderId, documentId);
        if (live) setData(r);
      } catch (e: any) {
        // Guarded: an error set on a component that has closed is an error
        // nobody sees, and this modal unmounts the moment Escape is pressed.
        if (live) setErr(e?.message || String(e));
      }
    })();
    return () => { live = false; };
  }, [orderId, documentId]);

  const detach = async () => {
    setBusy(true);
    try {
      await AnvilBackend?.orders?.detachQuote?.(orderId, documentId);
      onDetached?.();
      onClose();
    } catch (e: any) {
      setErr(e?.message || String(e));
      setConfirmDetach(false);
    } finally {
      setBusy(false);
    }
  };

  const doc = data?.document;
  const quote = data?.quote;
  const lines: Line[] = Array.isArray(data?.lines) ? data.lines : [];
  const superseded = data?.superseded_by || null;

  return (
    <Modal
      open={!!documentId}
      onClose={onClose}
      maxWidth="min(1400px, 96vw)"
      title={doc?.filename || "Quote"}
      ariaLabel="Uploaded quote"
    >
      <Modal.Body>
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Could not open this quote">
            <span className="mono-sm">{err}</span>
          </Banner>
        )}

        {!data && !err && <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Loading…</div>}

        {data && (
          <>
            <div className="row mono-sm" style={{ gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
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
              {/* Download lives inside ReviewDocPane's own header, beside the
                  filename — one download control, not two competing ones. */}
            </div>

            {/* Document left, extraction right — the whole point is comparing
                them without switching context. Stacks on a narrow viewport. */}
            <div className="qv-split">
              <div className="qv-doc">
                <ReviewDocPane docId={documentId} />
              </div>

              <div className="qv-lines">
                {lines.length === 0 ? (
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
                              {/* List shown only when it differs — a single-price
                                  quote should not imply a discount it never had. */}
                              <td style={{ textAlign: "right", color: "var(--ink-3)" }}>
                                {l.listed_unit_price != null && l.listed_unit_price !== l.discounted_unit_price
                                  ? num(l.listed_unit_price) : "—"}
                              </td>
                              <td style={{ textAlign: "right", fontWeight: 600 }}>{num(l.discounted_unit_price)}</td>
                              <td style={{ textAlign: "right" }}>{num(l.line_amount)}</td>
                              <td style={{ textAlign: "right" }}>{gst ? pct(gst) : "—"}</td>
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
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        {superseded && (
          confirmDetach ? (
            <>
              <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
                Remove this duplicate from the order? The file itself is kept.
              </span>
              <Btn sm kind="danger" disabled={busy} onClick={detach}>Remove duplicate</Btn>
              <Btn sm kind="ghost" disabled={busy} onClick={() => setConfirmDetach(false)}>Cancel</Btn>
            </>
          ) : (
            <Btn sm kind="ghost" disabled={busy} onClick={() => setConfirmDetach(true)}>Remove duplicate…</Btn>
          )
        )}
        <span style={{ flex: 1 }} />
        <Btn sm kind="ghost" onClick={onClose}>Close</Btn>
      </Modal.Footer>
    </Modal>
  );
};

export default QuoteViewer;
