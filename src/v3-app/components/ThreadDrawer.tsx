// Thread drawer: per-order activity timeline. Replaces the static demo
// drawer in Shell.tsx with live data from ObaraBackend.
//
// Reads the active order id from the URL hash query (`#/so?id=...`).
// When no order is active, shows an empty state explaining that the
// drawer follows the order currently in focus.
//
// Loads in parallel:
//   - ObaraBackend.orders.get(id)              -> order envelope (PO, quote, status)
//   - ObaraBackend.audit.list({ object_id })   -> audit events for this order
//   - ObaraBackend.events.list(id)             -> processing_events
//   - ObaraBackend.communications.list?.(id)   -> communications (optional)
//
// Each event is normalized to `{ ts, kind, title, detail }` and merged
// chronologically. Click an event to navigate to the order. Esc / click-
// outside / X-button close the drawer.

import React, { useEffect, useState } from "react";
import { Icon } from "../lib/icons";
import { Chip } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { ageLabel, stageOf, draftLabel } from "../lib/helpers";

export interface ThreadDrawerProps {
  open: boolean;
  onClose: () => void;
}

interface ThreadEvent {
  ts: string | null;
  // Two-letter timeline codes from the design package. The 8
  // canonical ones (PO / QU / VA / AP / TA / SP / SH / EI) flow
  // left-to-right in the strip. AU / CM / PR / OT are catch-all
  // bins for audit / communication / processing / other events
  // that don't map cleanly to a numbered stage.
  kind: "PO" | "QU" | "VA" | "AP" | "TA" | "SP" | "SH" | "EI" | "AU" | "CM" | "PR" | "OT";
  title: string;
  detail?: string;
}

const ORDER_FROM_HASH = (): string | null => {
  const hash = (typeof window !== "undefined" && window.location.hash) || "";
  const q = hash.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("id");
};

const classify = (action: string): ThreadEvent["kind"] => {
  const a = (action || "").toLowerCase();
  if (a.includes("communication") || a.startsWith("comm.")) return "CM";
  if (a.includes("approve") || a.includes("approval"))      return "AP";
  if (a.includes("tally"))                                  return "TA";
  if (a.includes("shipment"))                               return "SH";
  if (a.includes("einvoice") || a.includes("e_invoice"))    return "EI";
  // SP - the upstream purchase order to the supplier (a separate
  // doc from the customer PO that opened the case). The audit
  // verbs landed in src/api/source_pos/.
  if (a.includes("source_po") || a.includes("source-po"))   return "SP";
  // VA - validation. Covers pre-push rule findings + the
  // re-validation step that runs after operator edits.
  if (a.includes("validat") || a.includes("finding") || a.includes("rule_fire")) return "VA";
  if (a.includes("po"))                                     return "PO";
  if (a.includes("quote"))                                  return "QU";
  return "AU";
};

const mergedTimeline = (audit: any[], events: any[], comms: any[]): ThreadEvent[] => {
  const merged: ThreadEvent[] = [];
  for (const a of audit || []) {
    const action = String(a.action || "");
    merged.push({
      ts: a.created_at || a.at || null,
      kind: classify(action),
      title: action || "event",
      detail: [a.object_type, a.object_id ? String(a.object_id).slice(0, 8) : null, a.detail].filter(Boolean).join(" · "),
    });
  }
  for (const p of events || []) {
    merged.push({
      ts: p.created_at || p.at || p.timestamp || null,
      kind: "PR",
      title: p.event_type || p.action || p.type || "processing",
      detail: [p.stage, p.detail || p.message || (p.payload && typeof p.payload === "string" ? p.payload : null)].filter(Boolean).join(" · "),
    });
  }
  for (const c of comms || []) {
    merged.push({
      ts: c.created_at || c.sent_at || null,
      kind: "CM",
      title: c.subject || c.template || "communication",
      detail: [c.channel, c.recipient, c.status].filter(Boolean).join(" · "),
    });
  }
  merged.sort((x, y) => {
    const tx = x.ts ? new Date(x.ts).getTime() : 0;
    const ty = y.ts ? new Date(y.ts).getTime() : 0;
    return ty - tx;
  });
  return merged;
};

const KIND_CHIP_KIND = (k: ThreadEvent["kind"]): string => {
  if (k === "AP") return "warn";
  if (k === "TA" || k === "EI") return "info";
  if (k === "CM") return "good";
  return "ghost";
};

export const ThreadDrawer: React.FC<ThreadDrawerProps> = ({ open, onClose }) => {
  const [orderId, setOrderId] = useState<string | null>(null);
  const [order, setOrder] = useState<{ data: any; loading: boolean; error: Error | null }>({ data: null, loading: false, error: null });
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);

  // Track the order id from the hash so reopening the drawer on a
  // different SO immediately reloads.
  useEffect(() => {
    if (!open) return;
    setOrderId(ORDER_FROM_HASH());
    const onHash = () => setOrderId(ORDER_FROM_HASH());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Load order envelope.
  useEffect(() => {
    if (!open || !orderId) { setOrder({ data: null, loading: false, error: null }); return; }
    let cancel = false;
    setOrder({ data: null, loading: true, error: null });
    Promise.resolve(ObaraBackend?.orders?.get?.(orderId))
      .then((r) => {
        if (cancel) return;
        setOrder({ data: r?.order || r, loading: false, error: null });
      })
      .catch((err) => { if (!cancel) setOrder({ data: null, loading: false, error: err }); });
    return () => { cancel = true; };
  }, [open, orderId]);

  // Load + merge audit + events + communications.
  useEffect(() => {
    if (!open || !orderId) { setEvents([]); return; }
    let cancel = false;
    setEventsLoading(true);
    Promise.all([
      Promise.resolve(ObaraBackend?.audit?.list?.({ object_id: orderId, limit: 200 }) || []).catch(() => []),
      Promise.resolve(ObaraBackend?.events?.list?.(orderId) || []).catch(() => []),
      Promise.resolve(ObaraBackend?.communications?.list?.(orderId) || []).catch(() => []),
    ])
      .then(([audit, events, comms]) => {
        if (cancel) return;
        const auditRows = Array.isArray(audit) ? audit : ((audit as any)?.events || (audit as any)?.rows || []);
        const eventRows = Array.isArray(events) ? events : ((events as any)?.rows || (events as any)?.events || []);
        const commRows = Array.isArray(comms) ? comms : ((comms as any)?.rows || (comms as any)?.communications || []);
        setEvents(mergedTimeline(auditRows, eventRows, commRows));
      })
      .finally(() => { if (!cancel) setEventsLoading(false); });
    return () => { cancel = true; };
  }, [open, orderId]);

  if (!open) return null;

  const o = order.data || {};
  // When the drawer is opened with an id but the order hasn't loaded
  // yet, pass a synthetic shape so draftLabel still returns something
  // meaningful (DRAFT-NEW-<id4>) rather than the empty string.
  const headerLabel = draftLabel(order.data ? o : (orderId ? { id: orderId } : null));
  const customer = o.customer?.customer_name || o.customer_id || "";
  const stage = stageOf(o.status);

  return (
    <div
      className="cmdk-bg"
      style={{ padding: 0, alignItems: "stretch", justifyItems: "end" }}
      onClick={onClose}
      role="presentation"
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={headerLabel ? `Thread for ${headerLabel}` : "Thread"}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-h">
          {orderId ? (
            <div>
              <div className="h-eyebrow">Thread {headerLabel ? "· " + headerLabel : ""}</div>
              <div className="h2" style={{ marginTop: 2 }}>
                {customer || "—"}
                {o.status && <span style={{ marginLeft: 8 }}><Chip k={stage.k}>{stage.label}</Chip></span>}
              </div>
            </div>
          ) : (
            <div>
              <div className="h-eyebrow">Thread</div>
              <div className="h2" style={{ marginTop: 2 }}>No order in focus</div>
            </div>
          )}
          <button
            type="button"
            className="btn icon sm ghost"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close thread drawer"
            title="Close (Esc)"
          >
            {Icon.x}
          </button>
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto", flex: 1 }}>
          {!orderId && (
            <div className="body" style={{ color: "var(--ink-3)" }}>
              Open an order from the Sales Orders list to see its thread here.
              The drawer follows the order currently in focus, with audit
              events, processing logs, and communications merged into one
              chronological feed.
            </div>
          )}
          {orderId && (eventsLoading || order.loading) && (
            <div className="body" style={{ color: "var(--ink-3)" }}>Loading thread…</div>
          )}
          {orderId && order.error && (
            <div className="body" style={{ color: "var(--rust)" }}>
              Could not load order. {String(order.error.message || order.error)}
            </div>
          )}
          {orderId && !eventsLoading && events.length === 0 && (
            <div className="body" style={{ color: "var(--ink-3)" }}>No events yet for this order.</div>
          )}
          {events.map((ev, i) => (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: "32px 1fr auto",
                gap: 10,
                alignItems: "start",
                padding: 10,
                border: "1px solid var(--hairline)",
                borderRadius: 6,
                background: "var(--paper)",
              }}
            >
              <div
                style={{
                  width: 28, height: 28, display: "grid", placeItems: "center",
                  background: "var(--paper-3)",
                  borderRadius: 4, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, color: "var(--ink)",
                }}
                aria-hidden="true"
              >{ev.kind}</div>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{ev.title}</div>
                <div className="mono-sm" style={{ color: "var(--ink-3)" }}>
                  {ev.detail || "—"}
                  {ev.ts && <span style={{ marginLeft: 8 }}>· {ageLabel(ev.ts)} ago</span>}
                </div>
              </div>
              <Chip k={KIND_CHIP_KIND(ev.kind)}>{ev.kind.toLowerCase()}</Chip>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
