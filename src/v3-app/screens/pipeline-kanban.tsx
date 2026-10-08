// Pipeline kanban view.
//
// Per the v1 design package (`screens-overview.jsx`, view C), the
// operator can see all in-flight orders as a 6-column kanban:
// Inbox -> OCR -> Validate -> Approve -> Push -> Closed. Each card is
// a sales order in that state.
//
// Audit P13.B.3.1. HTML5 native drag-and-drop. Cards are draggable;
// columns whose `target` is a real order status are drop targets.
// On drop, the screen optimistically updates local state, fires
// orders.update with the new status, and reverts on error. The
// state machine in src/api/orders/[id].js enforces forward-only
// progression with one-step backward; if the operator drops into
// a forbidden column the API rejects with INVALID_TRANSITION and
// we revert + flash a toast.
//
// A drag never cancels an order. "Closed" used to be a drop target
// whose status was CANCELLED, so a card dropped there to mark it done
// was cancelled. Closed is now read-only: it shows the orders that
// have left the pipeline (in Tally, reconciled or cancelled), and the
// only way to cancel is the confirmed cancel button in the SO
// workspace.
//
// Data comes from the existing `orders` API. Each order_status value
// (migration 001) maps to exactly one column through COLUMN_OF_STATUS.
// Counts at the column heads are real (length of the bucket).

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { RBAC } from "../lib/rbac";
import { stageOf, ageLabel, approvalPatch, NO_PAYLOAD_HASH_MESSAGE } from "../lib/helpers";

interface Order {
  id: string;
  po_number?: string | null;
  quote_number?: string | null;
  customer_name?: string | null;
  status?: string | null;
  grand_total?: number | string | null;
  margin_pct?: number | null;
  line_count?: number | null;
  payload_hash?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

// Each column carries a `target` status: the value to PATCH the
// dragged order's `status` to when dropped here. Columns with
// `target: null` are view-only (no real one-step status transition
// exists for the bucket they represent). OCR has no order_status of
// its own; extraction runs while the order is still DRAFT.
const COLUMNS: Array<{ id: string; label: string; target: string | null }> = [
  { id: "inbox",    label: "Inbox",    target: "DRAFT" },
  { id: "ocr",      label: "OCR",      target: null },
  { id: "validate", label: "Validate", target: "PENDING_REVIEW" },
  { id: "approve",  label: "Approve",  target: "APPROVED" },
  { id: "push",     label: "Push",     target: null },
  { id: "closed",   label: "Closed",   target: null },
];

// Every order_status value, and the one column it shows in. BLOCKED,
// DUPLICATE and REUSED wait for an operator decision, so they sit in
// Validate with the orders under review (the server lets each of them
// go back to DRAFT, so none is terminal). FAILED_TALLY_IMPORT waits
// for a retry in Push. Closed holds the statuses that have left the
// pipeline.
const COLUMN_OF_STATUS: Record<string, string> = {
  DRAFT: "inbox",
  PENDING_REVIEW: "validate",
  BLOCKED: "validate",
  DUPLICATE: "validate",
  REUSED: "validate",
  APPROVED: "approve",
  FAILED_TALLY_IMPORT: "push",
  EXPORTED_TO_TALLY: "closed",
  RECONCILED: "closed",
  CANCELLED: "closed",
};

// A row with no status, or a status this screen does not know yet,
// shows in Inbox so it is never hidden.
const bucketOf = (order: Order): string =>
  COLUMN_OF_STATUS[String(order.status || "").toUpperCase()] || "inbox";

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
  // Audit P13.B.3.1. Drag state: which order is being dragged + which
  // column the cursor is currently over. Updated on dragstart /
  // dragenter / dragleave. The dropped status update is
  // optimistic: we mutate local state, fire the PATCH, and revert
  // on failure.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropOverCol, setDropOverCol] = useState<string | null>(null);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  // Approving is a manager action (so.approve), and the server checks
  // "approve" too. For anyone else the Approve column is view-only,
  // so the board never offers a move the API would refuse.
  const canApprove = RBAC?.canDo?.("so.approve") === true;
  const targetOf = (col: { id: string; target: string | null }): string | null =>
    col.id === "approve" && !canApprove ? null : col.target;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp: any = await AnvilBackend?.orders?.list?.({ limit: 200 });
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

  const onCardDragStart = (id: string) => (ev: React.DragEvent<HTMLAnchorElement>) => {
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", id);
    setDragId(id);
  };
  const onCardDragEnd = () => {
    setDragId(null);
    setDropOverCol(null);
  };
  const onColDragOver = (colId: string, target: string | null) => (ev: React.DragEvent<HTMLDivElement>) => {
    if (!target) return;          // view-only column; reject
    ev.preventDefault();          // allow drop
    ev.dataTransfer.dropEffect = "move";
    if (dropOverCol !== colId) setDropOverCol(colId);
  };
  const onColDragLeave = (colId: string) => () => {
    if (dropOverCol === colId) setDropOverCol(null);
  };
  const onColDrop = (target: string | null) => async (ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    setDropOverCol(null);
    if (!target) return;
    const id = ev.dataTransfer.getData("text/plain");
    if (!id) return;
    setDragId(null);
    const order = (orders || []).find((o) => o.id === id);
    if (!order) return;
    // A drop that would not change the status is not a move. On
    // Approve it would re-stamp the approval and push its expiry out.
    // (A BLOCKED card dropped on Validate does move: to PENDING_REVIEW.)
    if (order.status === target) return;
    // Approve sends the same body as the SO workspace's approve button:
    // the server refuses an approval without the order's payload hash.
    let patch: Record<string, unknown> = { status: target };
    if (target === "APPROVED") {
      const approval = approvalPatch(order);
      if (!approval) {
        setMoveErr(NO_PAYLOAD_HASH_MESSAGE);
        return;
      }
      patch = { ...approval };
    }
    setMoveErr(null);
    // Optimistic local update so the card jumps columns instantly.
    setOrders((prev) => {
      if (!prev) return prev;
      return prev.map((o) => o.id === id ? { ...o, status: target } : o);
    });
    try {
      // The orders API hangs status updates off the singleton row
      // endpoint (PATCH /api/orders/<id>); fall back to update() if
      // the client surfaces it.
      if (AnvilBackend?.orders?.update) {
        await AnvilBackend.orders.update(id, patch);
      } else {
        const cfg = AnvilBackend?.getConfig?.() || {};
        const session = AnvilBackend?.getSession?.() || null;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if ((session as any)?.access_token) headers["Authorization"] = "Bearer " + (session as any).access_token;
        if (cfg.tenantId) headers["x-anvil-tenant"] = cfg.tenantId;
        const url = (cfg.url || "").replace(/\/+$/, "") + "/api/orders/" + encodeURIComponent(id);
        const resp = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(patch) });
        if (!resp.ok) throw new Error("HTTP " + resp.status + ": " + (await resp.text()).slice(0, 200));
      }
    } catch (e: any) {
      // Revert by reloading.
      setMoveErr(String(e?.message || e));
      try {
        const resp: any = await AnvilBackend?.orders?.list?.({ limit: 200 });
        const list = Array.isArray(resp?.orders) ? resp.orders
                   : Array.isArray(resp?.rows)   ? resp.rows
                   : Array.isArray(resp)          ? resp
                   : [];
        setOrders(list);
      } catch { /* ignore reload error */ }
    }
  };

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
      {moveErr && <Banner kind="bad" title="Move rejected">{moveErr} The card stays in its column.</Banner>}
      <div className="kanban">
        {COLUMNS.map((col) => {
          const target = targetOf(col);
          const dropTarget = !!target;
          const isOver = dropOverCol === col.id && dropTarget;
          return (
            <div
              key={col.id}
              role="region"
              aria-label={col.label}
              className={"kanban-col" + (isOver ? " kanban-col-over" : "") + (dropTarget ? "" : " kanban-col-readonly")}
              onDragOver={onColDragOver(col.id, target)}
              onDragLeave={onColDragLeave(col.id)}
              onDrop={onColDrop(target)}
              aria-dropeffect={dropTarget ? "move" : "none"}
              style={isOver ? { outline: "2px dashed var(--accent-2)", outlineOffset: -2 } : undefined}
            >
              <div className="kanban-col-h">
                <span className="kanban-col-l">{col.label}</span>
                <span className="kanban-col-c">{(byCol[col.id] || []).length}</span>
                {!dropTarget && (
                  <Chip k="ghost">view-only</Chip>
                )}
              </div>
              <div className="kanban-col-body">
                {(byCol[col.id] || []).map((o) => (
                  <a
                    key={o.id}
                    href={"#/so?id=" + o.id}
                    className="kanban-card"
                    // A closed order has left the pipeline: no column
                    // can take it, so it is not offered as draggable.
                    draggable={col.id !== "closed"}
                    onDragStart={onCardDragStart(o.id)}
                    onDragEnd={onCardDragEnd}
                    style={dragId === o.id ? { opacity: 0.5 } : undefined}
                  >
                    <div className="kanban-card-h">
                      <span className="kanban-card-id">{o.po_number || o.quote_number || ("SO-" + o.id.slice(0, 6))}</span>
                      {o.line_count != null && (
                        <Chip k="info">{o.line_count} lines</Chip>
                      )}
                      {/* Name the status when the column holds more than
                          one (a blocked order in Validate, a cancelled
                          one in Closed). */}
                      {o.status && o.status !== col.target && (
                        <Chip k={stageOf(o.status).k}>{stageOf(o.status).label}</Chip>
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
          );
        })}
      </div>
    </div>
  );
};

export default PipelineKanban;
