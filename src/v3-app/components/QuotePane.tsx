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
import { ReviewPaneSelectionProvider, useReviewPaneSelection } from "./ReviewPaneContext";
import { lineFieldPath, lineFieldFor, coerceCorrection } from "../lib/quote-field-paths";
import { notifyError, notifySuccess } from "../lib/toasts";
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

// One cell of the line table, correctable in place.
//
// A correction here does NOT rewrite the quote. quote_lines is what the
// supplier's document was read as, and the PO-vs-quote reconciliation is
// computed from it — silently rewriting a line would move a commercial
// comparison under the operator's feet. What a correction writes is ground
// truth ABOUT the extraction: it lands in extraction_corrections, feeds the
// customer-hints loop that primes the next extraction, and (since #489) seeds a
// golden fixture from a document the pipeline got WRONG. That is the whole
// point — the golden set otherwise fills up with documents we already handle.
//
// So the cell shows the corrected value with a marker rather than pretending
// the table changed, and the note above the table says which is which.
const CorrectableCell: React.FC<{
  column: string;
  lineIndex: number | null;
  /** The extract line this row came from, or null when it cannot be resolved. */
  extractLine: any;
  display: string;
  align?: "left" | "right";
  style?: React.CSSProperties;
}> = ({ column, lineIndex, extractLine, display, align = "left", style }) => {
  const { canCorrect, extractionRunId, submitCorrection } = useReviewPaneSelection();
  const spec = lineFieldFor(column);
  const path = lineFieldPath(column, lineIndex);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [corrected, setCorrected] = useState<string | null>(null);

  // The value the MODEL produced, not the value the ingest stored. Without an
  // extract line we cannot state it, so the cell stays read-only rather than
  // recording a fabricated original.
  const original = spec && extractLine && typeof extractLine === "object"
    ? extractLine[spec.extractKey] ?? null
    : undefined;

  const editable = !!(canCorrect && extractionRunId && spec && path && original !== undefined);
  const shown = corrected ?? display;

  if (!editable) {
    return <td style={{ textAlign: align, ...style }}>{shown}</td>;
  }

  const open = () => {
    // Prefill with what the model produced, not the rendered cell: the table
    // shows an em-dash for a null list price and a MOQ tag the ingest appended,
    // neither of which is text the operator should be editing.
    setDraft(original == null ? "" : String(original));
    setEditing(true);
  };

  const save = async () => {
    const c = coerceCorrection(draft, spec!.type);
    if (!c.ok) { notifyError("Could not save correction", c.error); return; }
    setSaving(true);
    const res = await submitCorrection({
      fieldPath: path!,
      originalValue: original,
      correctedValue: c.value,
      reason: "operator corrected on the Quote tab",
    });
    setSaving(false);
    if (res.ok) {
      setCorrected(c.value == null ? "—" : String(c.value));
      setEditing(false);
      notifySuccess("Correction recorded", `${spec!.label} → ${c.value == null ? "blank" : c.value}`);
    } else {
      notifyError("Could not save correction", res.error || "unknown error");
    }
  };

  if (editing) {
    return (
      <td style={{ textAlign: align, ...style }}>
        <span className="qp-edit">
          <input
            className="input mono-sm qp-edit-input"
            value={draft}
            autoFocus
            disabled={saving}
            aria-label={`Correct ${spec!.label}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void save(); }
              if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
            }}
          />
          <button type="button" className="btn sm" disabled={saving} onClick={() => void save()}>Save</button>
          <button type="button" className="btn ghost sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        </span>
      </td>
    );
  }

  return (
    <td style={{ textAlign: align, ...style }}>
      <button
        type="button"
        className={"qp-cell" + (corrected != null ? " is-corrected" : "")}
        onClick={open}
        title={corrected != null
          ? `Corrected. Recorded as ${path}`
          : `Click to correct ${spec!.label} — records what the document says`}
      >
        {shown}
        {corrected != null && <span className="qp-cell-mark" aria-label="corrected">*</span>}
      </button>
    </td>
  );
};

export const QuotePane: React.FC<{
  orderId: string;
  attached: AttachedQuote[];
  selectedDocId: string | null;
  onSelect: (documentId: string) => void;
  onChanged?: () => void;
  /** Whether this operator may record corrections (so.approve, as on Reconcile). */
  canCorrect?: boolean;
}> = ({ orderId, attached, selectedDocId, onSelect, onChanged, canCorrect = false }) => {
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
  // The extract's own lines, addressed by line_index — the same index the
  // ingest stamped, so a row that survived the hollow-line filter still points
  // at the line the model produced.
  const extractLines: any[] | null = Array.isArray(data?.extracted_lines) ? data.extracted_lines : null;
  const extractLineFor = (idx: number | null) =>
    extractLines && idx != null && idx >= 0 && idx < extractLines.length ? extractLines[idx] : null;
  const superseded = data?.superseded_by || null;

  const extractionRunId: string | null = data?.extraction_run_id || null;

  return (
    // One provider per document: switching quotes must not carry the previous
    // document's correction state onto the next one's cells.
    <ReviewPaneSelectionProvider
      key={docId || "none"}
      canCorrect={canCorrect}
      extractionRunId={extractionRunId}
    >
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
            <>
            {canCorrect && extractionRunId && (
              // Said plainly, because the alternative is an operator typing a
              // fix, watching the table not change, and concluding it broke.
              <div className="qp-correct-note mono-sm">
                Click a cell to record what the document actually says. That teaches the next
                extraction and adds this quote to the regression set — it does not change the quote.
              </div>
            )}
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
                        <CorrectableCell
                          column="part_no" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)}
                          display={(l.part_no || "—") + (l.customer_part_number ? ` / ${l.customer_part_number}` : "")}
                        />
                        <CorrectableCell
                          column="description" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)}
                          display={l.description || "—"}
                        />
                        <CorrectableCell
                          column="qty" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)} align="right"
                          display={num(l.qty, 3) + (l.uom ? ` ${l.uom}` : "")}
                        />
                        {/* List shown only where it differs — a single-price
                            quote must not imply a discount it never carried.
                            It stays correctable either way: a list price the
                            extractor MISSED is exactly the #462 defect, and a
                            cell that renders "—" is the only place to say so. */}
                        <CorrectableCell
                          column="listed_unit_price" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)}
                          align="right" style={{ color: "var(--ink-3)" }}
                          display={l.listed_unit_price != null && l.listed_unit_price !== l.discounted_unit_price
                            ? num(l.listed_unit_price) : "—"}
                        />
                        <CorrectableCell
                          column="discounted_unit_price" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)}
                          align="right" style={{ fontWeight: 600 }}
                          display={num(l.discounted_unit_price)}
                        />
                        <CorrectableCell
                          column="line_amount" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)}
                          align="right" display={num(l.line_amount)}
                        />
                        {/* GST is the sum of three extracted fields, so a
                            correction typed here could not be attributed to
                            one. Read-only until the column is split. */}
                        <td style={{ textAlign: "right" }}>{gst ? `${gst.toFixed(2).replace(/\.00$/, "")}%` : "—"}</td>
                        <CorrectableCell
                          column="remark" lineIndex={l.line_index} extractLine={extractLineFor(l.line_index)}
                          style={{ color: "var(--ink-3)" }} display={l.remark || ""}
                        />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </div>
      </div>
    </div>
    </ReviewPaneSelectionProvider>
  );
};

export default QuotePane;
