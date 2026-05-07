// Quotes list screen.
//
// Audit P10 (May 2026). Phase 6.x already shipped the backend
// (migration 068_quotes_object.sql created the table + status
// enum, and src/api/quotes/{index,convert,expire,pdf,send}.js
// expose the lifecycle). The frontend was the open gap: no
// screen drove the client.quotes namespace, so the operator
// experience was "create a draft via API or it doesn't exist."
// This screen wires the namespace to a list + KPI summary.
//
// Lifecycle bands map to status enum values from the migration:
//
//   DRAFT, PENDING_INTERNAL_APPROVAL  -> "Draft" tab
//   SENT                              -> "Sent" tab
//   ACCEPTED, CONVERTED               -> "Won" tab
//   DECLINED                          -> "Lost" tab
//   EXPIRED                           -> "Expired" tab
//   CANCELLED                         -> "Cancelled" tab
//
// "All" + "Open" tabs are virtual: All shows everything, Open
// shows the actionable subset (draft + sent + pending-internal).

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { ageLabel, fmtINRShort } from "../lib/helpers";
import { ObaraBackend } from "../lib/api";

interface Quote {
  id: string;
  quote_number: string;
  version: number;
  status: string;
  customer_id: string | null;
  customer_name?: string | null;
  customer?: { customer_name?: string | null } | null;
  currency?: string | null;
  grand_total?: number | string | null;
  validity_days?: number | null;
  expires_at?: string | null;
  sent_at?: string | null;
  accepted_at?: string | null;
  declined_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const STATUS_TONE: Record<string, "info" | "good" | "bad" | "ghost" | "warn"> = {
  DRAFT: "info",
  PENDING_INTERNAL_APPROVAL: "warn",
  SENT: "info",
  ACCEPTED: "good",
  CONVERTED: "good",
  DECLINED: "bad",
  EXPIRED: "bad",
  CANCELLED: "ghost",
};

const TABS = [
  { id: "all",        label: "All",        match: (_q: Quote) => true },
  { id: "open",       label: "Open",       match: (q: Quote) => ["DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT"].includes(q.status) },
  { id: "draft",      label: "Draft",      match: (q: Quote) => q.status === "DRAFT" || q.status === "PENDING_INTERNAL_APPROVAL" },
  { id: "sent",       label: "Sent",       match: (q: Quote) => q.status === "SENT" },
  { id: "won",        label: "Won",        match: (q: Quote) => q.status === "ACCEPTED" || q.status === "CONVERTED" },
  { id: "lost",       label: "Lost",       match: (q: Quote) => q.status === "DECLINED" },
  { id: "expired",    label: "Expired",    match: (q: Quote) => q.status === "EXPIRED" },
  { id: "cancelled",  label: "Cancelled",  match: (q: Quote) => q.status === "CANCELLED" },
];

const toRows = (data: any): Quote[] => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.quotes)) return data.quotes;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
};

const Quotes: React.FC = () => {
  const [rows, setRows] = useState<Quote[] | null>(null);
  const [active, setActive] = useState("all");
  const [query, setQuery] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    setRows(null);
    setErr(null);
    Promise.resolve(ObaraBackend?.quotes?.list?.({ limit: 200 }))
      .then((data: any) => setRows(toRows(data)))
      .catch((e: any) => setErr(e?.message || String(e)));
  };
  useEffect(reload, []);

  const filtered = useMemo(() => {
    const tab = TABS.find((t) => t.id === active) || TABS[0];
    return (rows || [])
      .filter(tab.match)
      .filter((q) => {
        if (!query) return true;
        const v = query.toLowerCase();
        return (
          (q.quote_number || "").toLowerCase().includes(v) ||
          (q.customer?.customer_name || q.customer_name || "").toLowerCase().includes(v)
        );
      });
  }, [rows, active, query]);

  const counts = useMemo(() => Object.fromEntries(
    TABS.map((t) => [t.id, (rows || []).filter(t.match).length])
  ), [rows]);

  // KPIs. Open = sum of grand_total for actionable rows. Sent MTD =
  // count of quotes whose sent_at falls in the current month. Win
  // rate = ACCEPTED+CONVERTED divided by all closed (won + lost).
  const kpis = useMemo(() => {
    const list = rows || [];
    const open = list.filter((q) => ["DRAFT", "PENDING_INTERNAL_APPROVAL", "SENT"].includes(q.status));
    const openValue = open.reduce((s, q) => s + (Number(q.grand_total) || 0), 0);
    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const sentMtd = list.filter((q) =>
      q.sent_at && new Date(q.sent_at).getTime() >= monthStart.getTime());
    const won = list.filter((q) => q.status === "ACCEPTED" || q.status === "CONVERTED").length;
    const lost = list.filter((q) => q.status === "DECLINED").length;
    const winRate = (won + lost) ? Math.round((won / (won + lost)) * 100) : null;
    return { openCount: open.length, openValue, sentMtdCount: sentMtd.length, winRate };
  }, [rows]);

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Quotes"
        title="Quotes"
        meta={`${(rows || []).length} total · ${kpis.openCount} open`}
        right={<>
          <input
            className="input"
            placeholder="search quote number, customer..."
            aria-label="Search quotes"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            style={{ width: 260, height: 28 }}
          />
          <Btn sm kind="ghost" onClick={reload}>Refresh</Btn>
        </>}
      />
      <WSTabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] || 0 }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        <KPIRow cols={3}>
          <KPI lbl="Open value" v={fmtINRShort(kpis.openValue)} d={`${kpis.openCount} open quote${kpis.openCount === 1 ? "" : "s"}`} />
          <KPI lbl="Sent MTD"   v={String(kpis.sentMtdCount)} d="this month" dKind={kpis.sentMtdCount ? "up" : ""} />
          <KPI lbl="Win rate"   v={kpis.winRate == null ? "—" : kpis.winRate + "%"} d="accepted of closed" />
        </KPIRow>

        {err && <Banner kind="bad" title="Could not load quotes">{err}</Banner>}

        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th>Quote</th>
              <th>Customer</th>
              <th>Status</th>
              <th className="r">Value</th>
              <th className="r">Expires</th>
              <th className="r">Updated</th>
            </tr></thead>
            <tbody>
              {rows == null ? (
                <tr><td colSpan={6} className="muted">Loading...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="muted">
                  {(rows || []).length === 0
                    ? "No quotes yet. Start a draft from a customer or opportunity."
                    : "No quotes match the current filter."}
                </td></tr>
              ) : filtered.map((q) => (
                <tr key={q.id}>
                  <td>
                    <span className="mono-sm">{q.quote_number}</span>
                    {q.version > 1 && <Chip k="ghost">v{q.version}</Chip>}
                  </td>
                  <td>{q.customer?.customer_name || q.customer_name || "—"}</td>
                  <td><Chip k={STATUS_TONE[q.status] || "ghost"}>{q.status}</Chip></td>
                  <td className="r">{fmtINRShort(Number(q.grand_total) || 0)}</td>
                  <td className="r">{q.expires_at ? ageLabel(q.expires_at) : "—"}</td>
                  <td className="r">{ageLabel(q.updated_at || q.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
};

export default Quotes;
