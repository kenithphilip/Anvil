// Pipeline kanban view.
//
// Per the v1 design package (`screens-overview.jsx`, view C), the
// operator can see all in-flight orders as a 6-column kanban:
// Inbox -> OCR -> Validate -> Approve -> Push -> Closed. Each card is
// a sales order in that state. Drag-drop is a follow-up; clicking a
// card hops to the SO Workspace.
//
// Data comes from the existing `orders` API. We bucket each order by
// its current stage (derived from `stageOf` in lib/helpers, or a
// status field on the row). Counts at the column heads are real
// (length of the bucket).

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { ObaraBackend } from "../lib/api";
import { stageOf, ageLabel } from "../lib/helpers";

interface Order {
  id: string;
  po_number?: string | null;
  quote_number?: string | null;
  customer_name?: string | null;
  status?: string | null;
  stage?: string | null;
  grand_total?: number | string | null;
  margin_pct?: number | null;
  line_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}

const COLUMNS: Array<{ id: string; label: string; tones: Array<string> }> = [
  { id: "inbox",    label: "Inbox",    tones: ["received", "intake", "queued"] },
  { id: "ocr",      label: "OCR",      tones: ["extracting", "ocr", "preflight"] },
  { id: "validate", label: "Validate", tones: ["extracted", "validating", "review"] },
  { id: "approve",  label: "Approve",  tones: ["pending_approval", "approval", "approved"] },
  { id: "push",     label: "Push",     tones: ["pushing", "pending_push", "retry"] },
  { id: "closed",   label: "Closed",   tones: ["pushed", "closed", "shipped", "paid"] },
];

const bucketOf = (order: Order): string => {
  // stageOf returns a chip {label, k}; here we want the raw status string
  // for tone-matching, falling back to whatever the row carries.
  const raw = (order.status || order.stage || "").toLowerCase();
  for (const col of COLUMNS) {
    if (col.tones.some((t) => raw.includes(t))) return col.id;
  }
  // Use the chip label as a secondary fallback (it's a friendly form
  // of the status; e.g. "Approved" / "Pushed").
  const chipLabel = (stageOf(order.status || null)?.label || "").toLowerCase();
  for (const col of COLUMNS) {
    if (col.tones.some((t) => chipLabel.includes(t))) return col.id;
  }
  return "inbox";
};

const fmtMoney = (v: number | string | null | undefined): string => {
  if (v == null || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n >= 100000) return "₹" + (n / 100000).toFixed(1) + "L";
  return "₹" + n.toLocaleString("en-IN");
};

const PipelineKanban: React.FC = () => {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await ObaraBackend?.orders?.list?.({ limit: 200 });
        const list = Array.isArray(resp?.orders) ? resp.orders
                   : Array.isArray(resp?.rows)   ? resp.rows
                   : Array.isArray(resp)          ? resp
                   : [];
        if (!cancelled) setOrders(list);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message || "Could not load orders");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const byCol = useMemo(() => {
    const out: Record<string, Order[]> = {};
    for (const c of COLUMNS) out[c.id] = [];
    for (const o of orders || []) {
      const k = bucketOf(o);
      (out[k] || (out[k] = [])).push(o);
    }
    return out;
  }, [orders]);

  const totals = useMemo(() => ({
    open: (orders || []).filter((o) => bucketOf(o) !== "closed").length,
    today: (orders || []).filter((o) => o.created_at && Date.now() - Date.parse(o.created_at) < 86400000).length,
    flagged: 0, // wired when anomaly_findings is joined to orders
  }), [orders]);

  return (
    <div className="page">
      <WSTitle eyebrow="Pipeline" title="Kanban" meta="all in-flight orders" />
      <KPIRow cols={3}>
        <KPI lbl="Open"            v={String(totals.open)} />
        <KPI lbl="Started today"   v={String(totals.today)} />
        <KPI lbl="Flagged"         v={String(totals.flagged)} />
      </KPIRow>
      {err && <Banner kind="bad">{err}</Banner>}
      <div className="kanban">
        {COLUMNS.map((col) => (
          <div key={col.id} className="kanban-col">
            <div className="kanban-col-h">
              <span className="kanban-col-l">{col.label}</span>
              <span className="kanban-col-c">{(byCol[col.id] || []).length}</span>
            </div>
            <div className="kanban-col-body">
              {(byCol[col.id] || []).map((o) => (
                <a
                  key={o.id}
                  href={"#/so?id=" + o.id}
                  className="kanban-card"
                >
                  <div className="kanban-card-h">
                    <span className="kanban-card-id">{o.po_number || o.quote_number || ("SO-" + o.id.slice(0, 6))}</span>
                    {o.line_count != null && (
                      <Chip k="info">{o.line_count} lines</Chip>
                    )}
                  </div>
                  <div className="kanban-card-c">{o.customer_name || "—"}</div>
                  <div className="kanban-card-foot">
                    <span>{fmtMoney(o.grand_total)}</span>
                    <span className="kanban-card-age">{ageLabel(o.updated_at || o.created_at)}</span>
                  </div>
                </a>
              ))}
              {(byCol[col.id] || []).length === 0 && (
                <div className="kanban-empty">empty</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PipelineKanban;
