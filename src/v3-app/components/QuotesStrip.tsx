// One strip instead of three stacked cards.
//
// Attaching, what is attached, and whether it agrees with the PO were three
// separate Cards, each with its own eyebrow and title, stacked down the page.
// Together they used most of a screen to say what fits on two lines — and the
// operator reads all three as one question anyway: "is this PO backed by a
// quote, and does it match?"
//
// Three columns: the action, the evidence, the verdict. The detail — the
// document itself and its line items — lives in the Quotes tab, because
// verifying line items needs room and an overlay on top of a workspace is the
// opposite of less overwhelming.

import React, { useEffect, useRef, useState } from "react";
import { Banner, Btn, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

export interface AttachedQuote {
  document_id: string;
  filename: string;
  ingested: boolean;
  superseded_by?: { document_id: string; basis: string; certain: boolean } | null;
  quote: {
    id: string;
    quote_number: string | null;
    revision?: string | null;
    currency?: string | null;
    grand_total?: number | null;
    line_count: number;
    line_total?: number | null;
    effective_date?: string | null;
    effective_date_is_revision?: boolean;
  } | null;
}

const money = (v?: number | null, ccy?: string | null) => {
  if (v == null || !Number.isFinite(Number(v))) return null;
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: ccy || "INR", maximumFractionDigits: 0 }).format(Number(v));
  } catch {
    return `${ccy || ""} ${Math.round(Number(v)).toLocaleString("en-IN")}`.trim();
  }
};

const shortDate = (iso?: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
};

// Queue the full read of a quotation too long for one request.
//
// Raw fetch, not the AnvilBackend client, because that is the shape the two
// existing enqueue sites use (so-intake, so-workspace) and there is no client
// method for this route. Deliberately mirrored rather than improved: a third
// spelling of the same call is how the next drift starts.
//
// Returns whether it was queued. The caller tells the operator either way —
// an unqueued long quote is silently short, which is the failure this exists
// to remove.
const enqueueFullRead = async (orderId: string, documentId: string, filename: string): Promise<boolean> => {
  try {
    const cfg: any = (AnvilBackend as any)?.getConfig?.() || {};
    const session: any = (AnvilBackend as any)?.getSession?.() || null;
    const headers: any = { "Content-Type": "application/json" };
    if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
    const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/orders/extraction_jobs", {
      method: "POST",
      headers,
      // kind is what makes this a QUOTE job: without it the worker infers 'po'
      // from the order id and would extract a quotation against the
      // purchase-order schema, then refuse to write it back.
      body: JSON.stringify({ order_id: orderId, document_id: documentId, kind: "quote", source_filename: filename }),
    });
    // resp.ok alone is not enough. A 409 means an extraction of a different
    // kind is already in flight on this order and ours was NOT queued; a 200
    // carrying someone else's job would be the same lie one status code up.
    if (!resp.ok) return false;
    const body: any = await resp.json().catch(() => null);
    return !!body?.job && (body.job.extraction_kind || "po") === "quote";
  } catch { return false; }
};

export const QuotesStrip: React.FC<{
  orderId: string;
  /**
   * The order's customer. Passed as the id, not a boolean: the extraction run
   * needs it stamped, because every downstream learning path is gated on it —
   * correction.js only promotes a customer-field override `if (customerId)`,
   * and customer-hints refuses to prime the next extraction without one. A
   * quote run with a null customer records corrections that can never change
   * an extraction.
   */
  customerId: string | null;
  refreshKey?: number;
  /** Verdict column, rendered by the workspace which owns the reconcile state. */
  verdict?: React.ReactNode;
  onAttached?: () => void;
  /** Open the Quotes tab focused on this document. */
  onOpen?: (documentId: string) => void;
  /** Hand the loaded list up — the Quotes tab reads it rather than refetching. */
  onLoaded?: (rows: AttachedQuote[]) => void;
}> = ({ orderId, customerId, refreshKey, verdict, onAttached, onOpen, onLoaded }) => {
  const hasCustomer = !!customerId;
  const [rows, setRows] = useState<AttachedQuote[] | null>(null);
  const [other, setOther] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r: any = await AnvilBackend?.orders?.attachedQuotes?.(orderId);
        if (!live) return;
        const list = Array.isArray(r?.attached) ? r.attached : [];
        setRows(list);
        setOther(Array.isArray(r?.other_quotes) ? r.other_quotes : []);
        onLoaded?.(list);
      } catch (e: any) {
        // Only while mounted: an error set on a unmounted component is an
        // error nobody sees.
        if (live) setErr(e?.message || String(e));
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, refreshKey]);

  // Returns a reason string when the attach did not ingest, else null.
  const attachOne = async (file: File): Promise<string | null> => {
    setStep("uploading");
    const up: any = await AnvilBackend?.documents?.upload?.(file, "quote", { autoScan: false });
    const documentId = up?.documentId;
    if (!documentId) throw new Error("Upload did not return a document id");

    // Preflight: link it and ask whether a model is needed at all. Anvil's own
    // quote answers no, and we stop here having spent nothing.
    setStep("checking");
    const pre: any = await AnvilBackend?.orders?.attachQuote?.(orderId, documentId, null, false);
    if (pre && pre.needs_extraction === false) return null;

    setStep("reading");
    let extracted: any = null;
    // Set when the extractor reports it read only page 1; surfaced to the
    // operator at the end whether or not the ingest itself succeeded.
    let largePdfPages: number | null = null;
    let largePdfQueued = false;
    try {
      // Pass the document id. extraction_runs.source_id is the ONLY link from
      // a run back to the file it read — the PO flow passes it (so-intake.tsx)
      // and this one did not, so no quote extraction could be traced to its
      // document, replayed against the live model, or harvested into the
      // golden set. The id is already in hand from the upload above.
      const out: any = await AnvilBackend?.documents?.extract?.(file, {
        kind: "quote",
        source_id: documentId,
        // Stamps extraction_runs.customer_id. Without it a correction on this
        // quote reaches extraction_corrections and stops there: the override
        // promotion and the hint priming are both gated on a customer.
        customer_id: customerId || undefined,
      });
      extracted = out?.normalized || null;
      // TELL THE OPERATOR THE DOCUMENT WAS CUT SHORT.
      //
      // /api/docai/extract downscopes any PDF over 40 pages to page 1 and
      // returns large_pdf, and its own comment says the caller must then
      // enqueue a background job for the rest. The two PO screens do. This one
      // never read the flag, so a long quotation was silently ingested from
      // its first page — and a quote missing most of its lines does not fail
      // quietly: the reconciler compares it against the PO and reports every
      // absent line as one the customer ordered but was never quoted.
      //
      // So enqueue the rest. The worker re-runs the same ingest with the
      // complete extract, and because ingestQuote is keyed on
      // (tenant, quote_number, version) and replaces a quote's lines
      // wholesale, the full set SUPERSEDES the page-1 lines attached below
      // rather than piling up next to them.
      if (out?.large_pdf) {
        largePdfPages = out.total_pages || null;
        largePdfQueued = await enqueueFullRead(orderId, documentId, file.name);
      }
    } catch {
      extracted = null;   // non-fatal: attach anyway and report below
    }
    setStep("attaching");
    const res: any = await AnvilBackend?.orders?.attachQuote?.(orderId, documentId, extracted, true);
    // attachQuote RESOLVES with ingested:false and a reason — a rejected line
    // insert, a document that did not read as a quotation. It does not throw,
    // so without this the catch below never fires and the operator is left
    // with a bare "unread" chip and no cause.
    // A long quotation ingests page 1 here and the rest arrives from the
    // worker. Both outcomes are worth saying out loud: "still reading" is not
    // the same promise as "we read one page and gave up", and an operator who
    // is not told the difference will act on a short quote either way.
    const largePdfNote = largePdfPages === null && !largePdfQueued ? null
      : largePdfQueued
        ? "This quotation runs to " + (largePdfPages || "several") + " pages, so the rest is being read in the"
          + " background. Page 1 is attached now; the remaining lines appear here shortly."
        : "Only page 1 of " + (largePdfPages || "many")
          + " was read, and the background read could not be queued — so lines beyond the first page are"
          + " missing. Re-upload to try again.";
    if (res && res.ingested === false && !res.matched_authored) {
      const why = res.reason || res?.report?.reports?.[0]?.error || "The document was attached but nothing could be read from it.";
      return largePdfNote ? why + " " + largePdfNote : why;
    }
    return largePdfNote;
  };

  const onPick = async (files: File[]) => {
    if (!files.length) return;
    setErr(null);
    try {
      // Sequential: each attach ingests into quotes/quote_lines, and several at
      // once would race the same customer's quote numbering.
      const reasons: string[] = [];
      for (const f of files) {
        const why = await attachOne(f);
        if (why) reasons.push(files.length > 1 ? `${f.name}: ${why}` : why);
      }
      if (reasons.length) setErr(reasons.join(" · "));
      onAttached?.();
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setStep(null);
    }
  };

  const busy = step !== null;
  const list = rows || [];
  const readCount = list.filter((r) => r.ingested).length;

  return (
    <div className="qs">
      {err && (
        <Banner kind="bad" icon={Icon.alert} title="Attached, but not read">
          <span className="mono-sm">{err}</span>
        </Banner>
      )}

      <div className="qs-grid">
        {/* 1 — the action */}
        <div className="qs-col">
          <div className="qs-lbl">Quotes</div>
          {hasCustomer ? (
            <>
              <label className="btn btn-sm" style={{ cursor: busy ? "wait" : "pointer" }}>
                {busy ? `${step}…` : <>{Icon.upload || "↑"} Attach quote PDF</>}
                <input
                  ref={inputRef}
                  type="file" accept=".pdf,.PDF" multiple disabled={busy} style={{ display: "none" }}
                  onChange={(e) => {
                    // COPY before resetting: e.target.files is the input's own
                    // LIVE FileList, and setting value = "" empties that same
                    // object in place.
                    const fs = Array.from(e.target.files || []);
                    e.target.value = "";
                    onPick(fs);
                  }}
                />
              </label>
              <div className="qs-hint">Several can back one PO.</div>
            </>
          ) : (
            <div className="qs-hint">Set the customer first — quotes match to a PO by customer.</div>
          )}
        </div>

        {/* 2 — what is attached */}
        <div className="qs-col qs-col-list">
          <div className="qs-lbl">
            Attached{list.length ? ` · ${readCount}/${list.length} read` : ""}
          </div>
          {rows === null ? (
            <div className="qs-hint">Loading…</div>
          ) : list.length === 0 ? (
            <div className="qs-hint">None yet. Attach the quotation this order was placed against.</div>
          ) : (
            list.map((a) => (
              <button
                key={a.document_id}
                type="button"
                className="qs-row"
                onClick={() => onOpen?.(a.document_id)}
                title="Open in the Quotes tab to check its line items"
              >
                <Chip k={a.ingested ? "good" : a.superseded_by ? "info" : "warn"}>
                  {a.ingested ? "read" : a.superseded_by ? "dup" : "unread"}
                </Chip>
                <span className="qs-file">{a.quote?.quote_number || a.filename}</span>
                {a.quote?.revision && <span className="qs-rev">{a.quote.revision}</span>}
                {a.ingested && a.quote && (
                  <span className="qs-facts">
                    {a.quote.line_count} ln
                    {money(a.quote.grand_total ?? a.quote.line_total, a.quote.currency) &&
                      /* "~" when the figure was summed from the lines rather
                         than read off the document — a derived total shown as
                         the quoted total is a number nobody can check. */
                      ` · ${a.quote.grand_total == null ? "~" : ""}${money(a.quote.grand_total ?? a.quote.line_total, a.quote.currency)}`}
                    {shortDate(a.quote.effective_date) && ` · ${shortDate(a.quote.effective_date)}`}
                    {a.quote.effective_date_is_revision && " rev"}
                  </span>
                )}
              </button>
            ))
          )}
          {other.length > 0 && (
            <div className="qs-hint">
              +{other.length} quote{other.length === 1 ? "" : "s"} for this customer with no PDF
            </div>
          )}
        </div>

        {/* 3 — the verdict */}
        <div className="qs-col qs-col-verdict">
          <div className="qs-lbl">Against this PO</div>
          {verdict || <div className="qs-hint">Not compared yet.</div>}
        </div>
      </div>
    </div>
  );
};

export default QuotesStrip;
