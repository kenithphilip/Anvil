import React, { useEffect, useState } from "react";
import { Banner, Chip } from "../lib/primitives";
import { ageLabel } from "../lib/helpers";
import { AnvilBackend } from "../lib/api";

// Read-only timeline of audit_events for one quote. Reads via the
// existing /api/audit endpoint (object_type=quote, object_id=quote.id).
// Render-only -- no writes, no side effects.

const ACTION_LABEL: Record<string, string> = {
  quote_create: "Created",
  quote_update: "Updated header",
  quote_auto_populate: "Auto-filled",
  quote_send: "Sent to customer",
  quote_revise: "Revised (new version)",
  quote_cancel: "Cancelled",
  quote_margin_override: "Margin override",
  quote_send_pdf_render_failed: "PDF render failed",
  quote_send_portal_token_failed: "Portal token failed",
  quote_status_draft: "Status > DRAFT",
  quote_status_pending_internal_approval: "Status > PENDING APPROVAL",
  quote_status_sent: "Status > SENT",
  quote_status_accepted: "Status > ACCEPTED",
  quote_status_declined: "Status > DECLINED",
  quote_status_expired: "Status > EXPIRED",
  quote_status_converted: "Status > CONVERTED",
  quote_status_cancelled: "Status > CANCELLED",
};

const TONE: Record<string, "info" | "good" | "bad" | "warn" | "ghost"> = {
  quote_create: "info",
  quote_send: "good",
  quote_status_sent: "good",
  quote_status_accepted: "good",
  quote_status_converted: "good",
  quote_cancel: "bad",
  quote_status_cancelled: "bad",
  quote_status_declined: "bad",
  quote_status_expired: "bad",
  quote_margin_override: "warn",
  quote_auto_populate: "ghost",
  quote_send_pdf_render_failed: "bad",
  quote_send_portal_token_failed: "bad",
};

const detailFor = (e: any): string => {
  if (e.detail) return String(e.detail);
  if (e.action === "quote_auto_populate" && e?.after?.auto_filled) {
    return Object.entries(e.after.auto_filled).map(([k, v]) => k + " < " + v).join(", ");
  }
  if (e.action === "quote_update" && e?.before?.status && e?.after?.status && e.before.status !== e.after.status) {
    return e.before.status + " > " + e.after.status;
  }
  return "";
};

export const QuoteHistoryTab: React.FC<{ quoteId: string }> = ({ quoteId }) => {
  const [events, setEvents] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!quoteId) return;
    setEvents(null);
    setErr(null);
    Promise.resolve(AnvilBackend?.audit?.list?.({ object_type: "quote", object_id: quoteId, limit: 200 }))
      .then((resp: any) => setEvents(Array.isArray(resp) ? resp : resp?.events || []))
      .catch((e: any) => setErr(e?.message || String(e)));
  }, [quoteId]);

  if (err) return <Banner kind="bad" title="Could not load history">{err}</Banner>;
  if (events == null) return <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 10 }}>Loading history...</div>;
  if (events.length === 0) return <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 10 }}>No history yet for this quote.</div>;

  return (
    <table className="tbl" style={{ fontSize: 12 }}>
      <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
      <tbody>
        {events.map((e: any) => {
          const label = ACTION_LABEL[e.action] || e.action;
          const tone = TONE[e.action] || "ghost";
          const detail = detailFor(e);
          return (
            <tr key={e.id}>
              <td className="mono-sm" style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}>{ageLabel(e.created_at)}</td>
              <td><Chip k={tone}>{label}</Chip></td>
              <td className="mono-sm">{detail || "-"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

export default QuoteHistoryTab;
