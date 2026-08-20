// What quotes are on this PO, standing on the order rather than in a toast.
//
// Attaching a quotation reported success in the upload panel and then, once
// that panel re-rendered, the order said nothing at all: not which quote, not
// what it was worth, not when it was issued. "I am unable to understand if
// quote upload works" is the accurate summary of that state.
//
// The reconcile banner is not the answer either — it names the quotes that
// MATCHED, which is exactly the wrong set. A quote that attached but extracted
// nothing is the case an operator most needs to see, and it appears nowhere in
// a reconciliation result.

import React, { useEffect, useState } from "react";
import { Banner, Card, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

interface QuoteInfo {
  id: string;
  quote_number: string | null;
  version?: number | null;
  revision?: string | null;
  status?: string | null;
  currency?: string | null;
  grand_total?: number | null;
  line_count: number;
  line_total?: number | null;
  effective_date?: string | null;
  effective_date_is_revision?: boolean;
  authored_in_anvil?: boolean | null;
}

interface Superseded {
  document_id: string;
  basis: "content_hash" | "same_name_and_size";
  certain: boolean;
}

interface Attached {
  document_id: string;
  filename: string;
  uploaded_at?: string | null;
  ingested: boolean;
  // An earlier copy of a document that DID ingest — not a failure.
  superseded_by?: Superseded | null;
  quote: QuoteInfo | null;
}

const fmtMoney = (v?: number | null, ccy?: string | null) => {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency", currency: ccy || "INR", maximumFractionDigits: 0,
    }).format(Number(v));
  } catch {
    // An unrecognised currency code must not blank the value.
    return `${ccy || ""} ${Math.round(Number(v)).toLocaleString("en-IN")}`.trim();
  }
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? String(iso).slice(0, 10)
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export const AttachedQuotesCard: React.FC<{ orderId: string; refreshKey?: number }> = ({ orderId, refreshKey }) => {
  const [rows, setRows] = useState<Attached[] | null>(null);
  const [other, setOther] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r: any = await AnvilBackend?.orders?.attachedQuotes?.(orderId);
        if (!live) return;
        setRows(Array.isArray(r?.attached) ? r.attached : []);
        setOther(Array.isArray(r?.other_quotes) ? r.other_quotes : []);
        setErr(null);
      } catch (e: any) {
        // Written to state only while still mounted. An error set on a
        // component that unmounts in the same tick is an error nobody sees,
        // which is how "it silently did nothing" happens.
        if (live) setErr(e?.message || String(e));
      }
    })();
    return () => { live = false; };
  }, [orderId, refreshKey]);

  if (rows === null && !err) return null;

  const nothing = !err && rows !== null && rows.length === 0 && other.length === 0;

  return (
    <Card title="Quotes on this PO" eyebrow="what was uploaded, and what it says">
      {err && (
        <Banner kind="bad" icon={Icon.alert} title="Could not read the attached quotes">
          <span className="mono-sm">{err}</span>
        </Banner>
      )}

      {nothing && (
        <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
          No quote attached yet. Attach the quotation this order was placed against to compare it
          line by line.
        </div>
      )}

      {(rows || []).map((a) => (
        <div key={a.document_id} className="mono-sm"
             style={{ display: "flex", flexDirection: "column", gap: 2, padding: "6px 0", borderTop: "1px solid var(--hairline-3)" }}>
          <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <Chip k={a.ingested ? "good" : a.superseded_by ? "info" : "warn"}>
              {a.ingested ? "read" : a.superseded_by ? "duplicate" : "not read"}
            </Chip>
            <span style={{ fontWeight: 600, wordBreak: "break-all" }}>{a.filename}</span>
            {a.quote?.quote_number && <span style={{ color: "var(--ink-3)" }}>{a.quote.quote_number}</span>}
            {a.quote?.revision && <Chip k="info">{a.quote.revision}</Chip>}
            {a.quote?.authored_in_anvil && <Chip k="info">from Anvil</Chip>}
          </div>

          {a.ingested && a.quote ? (
            <div className="row" style={{ gap: 14, flexWrap: "wrap", color: "var(--ink-3)" }}>
              <span>
                <b style={{ color: "var(--ink)" }}>{a.quote.line_count}</b> line{a.quote.line_count === 1 ? "" : "s"}
              </span>
              <span>
                <b style={{ color: "var(--ink)" }}>{fmtMoney(a.quote.grand_total ?? a.quote.line_total, a.quote.currency)}</b>
                {/* Say so when the figure is summed from the lines rather than
                    read off the document — a derived total presented as the
                    quoted total is a number the operator cannot check. */}
                {a.quote.grand_total == null && a.quote.line_total != null && " (from lines)"}
              </span>
              <span>
                {fmtDate(a.quote.effective_date)}
                {a.quote.effective_date_is_revision && " (revised)"}
              </span>
              {a.quote.status && <span>{String(a.quote.status).toLowerCase()}</span>}
            </div>
          ) : a.superseded_by ? (
            <div style={{ color: "var(--ink-3)" }}>
              {a.superseded_by.certain
                ? "The same file, uploaded more than once. The copy above carries the quote — nothing is missing."
                : "Looks like another copy of the same file (same name and size). The copy above carries the quote."}
            </div>
          ) : (
            <div style={{ color: "var(--amber, var(--ink-3))" }}>
              Attached, but nothing was read from it — so it is not being compared against this PO.
              Re-attach it, or check the document is a quotation.
            </div>
          )}
        </div>
      ))}

      {other.length > 0 && (
        <div className="mono-sm" style={{ marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--hairline-2)", color: "var(--ink-3)" }}>
          {/* These price the PO too. Omitting them would imply the reconciler
              had only the uploads to work with. */}
          Also priced from {other.length} quote{other.length === 1 ? "" : "s"} for this customer with no
          attached PDF: {other.slice(0, 4).map((q) => q.quote_number).filter(Boolean).join(", ")}
          {other.length > 4 ? ` and ${other.length - 4} more` : ""}.
        </div>
      )}
    </Card>
  );
};

export default AttachedQuotesCard;
