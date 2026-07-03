import React, { useEffect, useState } from "react";
import { Banner, Chip } from "../lib/primitives";
import { ageLabel, fmtINRShort } from "../lib/helpers";
import { AnvilBackend } from "../lib/api";

// Lists every quote that points at a given opportunity. Read-only --
// click navigates to the Quotes screen (no per-quote deep-link exists
// today; future PR can add URL-state to the quotes screen).
//
// Backed by quotes.list({ opportunity_id }) which now filters
// server-side (PR 3B).

const STATUS_TONE: Record<string, "info" | "good" | "bad" | "warn" | "ghost"> = {
  DRAFT: "info",
  PENDING_INTERNAL_APPROVAL: "warn",
  SENT: "info",
  ACCEPTED: "good",
  CONVERTED: "good",
  DECLINED: "bad",
  EXPIRED: "bad",
  CANCELLED: "ghost",
};

export const OpportunityQuotesPanel: React.FC<{ opportunityId: string }> = ({ opportunityId }) => {
  const [quotes, setQuotes] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!opportunityId) return;
    setQuotes(null);
    setErr(null);
    Promise.resolve(AnvilBackend?.quotes?.list?.({ opportunity_id: opportunityId, limit: 200 }))
      .then((resp: any) => setQuotes(Array.isArray(resp) ? resp : resp?.quotes || []))
      .catch((e: any) => setErr(e?.message || String(e)));
  }, [opportunityId]);

  return (
    <div>
      <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>
        Quotes {quotes ? `(${quotes.length})` : ""}
      </div>
      {err && <Banner kind="bad" title="Could not load quotes">{err}</Banner>}
      {quotes == null ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 6 }}>Loading...</div>
      ) : quotes.length === 0 ? (
        <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 6 }}>No quotes yet for this opportunity.</div>
      ) : (
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead><tr><th>Quote</th><th>Status</th><th className="r">Value</th><th className="r">Expires</th><th className="r">Updated</th></tr></thead>
          <tbody>
            {quotes.map((q: any) => (
              <tr key={q.id}>
                <td>
                  <span className="mono-sm">{q.quote_number}</span>
                  {q.version > 1 && <Chip k="ghost">v{q.version}</Chip>}
                </td>
                <td><Chip k={STATUS_TONE[q.status] || "ghost"}>{q.status}</Chip></td>
                <td className="r">{fmtINRShort(Number(q.grand_total) || 0)}</td>
                <td className="r">{q.expires_at ? ageLabel(q.expires_at) : "-"}</td>
                <td className="r">{ageLabel(q.updated_at || q.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default OpportunityQuotesPanel;
