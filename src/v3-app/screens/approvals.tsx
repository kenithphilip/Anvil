import React, { useEffect, useState } from "react";
import { ageLabel, approvalPatch, isStaleApproval, isBlockingException, BLOCKING_EXCEPTION_TITLE, NO_PAYLOAD_HASH_MESSAGE, STALE_APPROVAL_MESSAGE } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle, fmtINR } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { RBAC } from "../lib/rbac";
import { AnvilBackend } from "../lib/api";

// One order waiting for approval, as GET /api/admin/quote_approvals?type=queue
// returns it. `thresholds` are the open quote_approvals rows for the order: the
// policy reasons it needs a sign-off. An order with none is still listed: it
// was sent for approval, and that is the decision this screen exists for.
export interface QueueThreshold { id: string; approver_role?: string | null; comments?: string | null; created_at?: string | null }
export interface QueueRow {
  order_id: string;
  status?: string;
  payload_hash?: string | null;
  po_number?: string | null;
  quote_number?: string | null;
  order_mode?: string | null;
  customer_name?: string | null;
  state_code?: string | null;
  line_count?: number | null;
  value_inr?: number | null;
  margin_pct?: number | null;
  margin_state?: string | null;
  margin_lines_matched?: number | null;
  margin_lines_total?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  thresholds?: QueueThreshold[];
}

const refOf = (r: QueueRow) => r.po_number || r.quote_number || (r.order_id ? r.order_id.slice(0, 12) : "this order");

// Why the order is in front of the approver, worst first. A loss outranks a
// thin margin, and both outrank the policy rows. Each open threshold row is a
// reason of its own; an order with none was simply sent for approval. "Not
// costed" comes last: it is not why the order is here, but the approver has to
// be able to tell it from a healthy margin.
export const reasonsOf = (r: QueueRow): Array<{ label: string; k: string }> => {
  const out: Array<{ label: string; k: string }> = [];
  const m = Number(r.margin_pct);
  if (r.margin_pct != null && Number.isFinite(m) && m < 0) out.push({ label: "below cost", k: "bad" });
  else if (r.margin_pct != null && Number.isFinite(m) && m < 10) out.push({ label: "margin breach", k: "warn" });
  const thresholds = r.thresholds || [];
  for (const t of thresholds) out.push({ label: (t.approver_role || "approver").replace(/_/g, " ") + " sign-off", k: "warn" });
  if (!thresholds.length) out.push({ label: "sent for approval", k: "info" });
  if (r.margin_state === "not_costed") out.push({ label: "not costed", k: "ghost" });
  return out;
};

// In-page SO preview drawer used by the Approvals queue. It fetches the order
// through /api/orders/[id] and shows a read-only summary, so the approver can
// decide without leaving the queue. Approve and Return for fix land back on
// the parent, which changes the ORDER. There is no reject: what reject means
// is an open owner decision (3), and until it is made the screen offers none.
const SOReviewDrawer: React.FC<{
  row: QueueRow;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReturnForCorrection: (reason: string) => void;
}> = ({ row, busy, onClose, onApprove, onReturnForCorrection }) => {
  const orderId = row.order_id;
  const [state, setState] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const [reason, setReason] = useState("");
  const [showReasonBox, setShowReasonBox] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    Promise.resolve(AnvilBackend?.orders?.get?.(orderId))
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setState({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
    // The hash too: after a stale approval the queue reloads, and the drawer
    // must show the order as it is now, not as it was.
  }, [orderId, row.payload_hash]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const order = state.data?.order || state.data;
  const lines = order?.result?.salesOrder?.lineItems || [];
  const grandTotal = Number(order?.result?.salesOrder?.grandTotal) || 0;
  const customer = order?.result?.salesOrder?.customer || {};
  const submitNote = String(order?.preflight_payload?.submit_note || "").trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review sales order"
      style={{
        position: "fixed", inset: 0, background: "rgba(8,10,12,0.55)",
        display: "flex", justifyContent: "flex-end", zIndex: 200,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100vw)", height: "100vh",
          background: "var(--bg)", borderLeft: "1px solid var(--line)",
          padding: 18, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14,
        }}
      >
        <div className="row" style={{ alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Approvals . Review SO</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{refOf(row)}</div>
          </div>
          <Btn sm kind="ghost" onClick={onClose}>close</Btn>
        </div>

        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {reasonsOf(row).map((r, i) => <Chip key={i} k={r.k}>{r.label}</Chip>)}
        </div>

        {state.loading && <div className="body">Loading order...</div>}
        {state.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load order">
            <span className="mono-sm">{String(state.error.message || state.error)}</span>
          </Banner>
        )}
        {order && (
          <>
            {submitNote && (
              <Banner kind="info" icon={Icon.alert} title="Note from the engineer">
                <span className="mono-sm" style={{ whiteSpace: "pre-wrap" }}>{submitNote}</span>
              </Banner>
            )}
            <Card title="Customer" eyebrow="from PO header">
              <div className="mono-sm" style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 4 }}>
                <div style={{ color: "var(--ink-3)" }}>Name</div><div>{customer.name || order.customer?.customer_name || row.customer_name || "-"}</div>
                <div style={{ color: "var(--ink-3)" }}>GSTIN</div><div className="mono">{customer.gstin || "-"}</div>
                <div style={{ color: "var(--ink-3)" }}>State</div><div>{customer.state_code || "-"}</div>
                <div style={{ color: "var(--ink-3)" }}>Bill to</div><div style={{ whiteSpace: "pre-wrap" }}>{customer.bill_to_address || customer.bill_to || "-"}</div>
                <div style={{ color: "var(--ink-3)" }}>Ship to</div><div style={{ whiteSpace: "pre-wrap" }}>{customer.ship_to_address || customer.ship_to || "-"}</div>
                <div style={{ color: "var(--ink-3)" }}>Pay terms</div><div>{customer.payment_terms || "-"}</div>
              </div>
            </Card>

            <Card title={`Line items (${lines.length})`} eyebrow={`grand total ${grandTotal ? fmtINR(grandTotal) : "-"}`}>
              {lines.length === 0 ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No lines extracted on this order.</div>
              ) : (
                <table className="tbl" style={{ fontSize: 12 }}>
                  <thead><tr>
                    <th>#</th><th>Item</th><th className="r">Qty</th><th className="r">Rate</th><th className="r">Line</th>
                  </tr></thead>
                  <tbody>
                    {lines.slice(0, 30).map((ln: any, i: number) => {
                      const rate = Number(ln.rate || ln.unitPrice || 0);
                      const qty = Number(ln.qty || ln.quantity || 0);
                      const total = Number(ln.lineTotal) || qty * rate;
                      return (
                        <tr key={i}>
                          <td className="mono">{i + 1}</td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{ln.description || ln.name || ln.item || "-"}</div>
                            {(ln.itemCode || ln.sku) && <div className="mono-sm">SKU {ln.itemCode || ln.sku}</div>}
                          </td>
                          <td className="r mono">{qty || "-"}</td>
                          <td className="r mono">{rate ? fmtINR(rate) : "-"}</td>
                          <td className="r mono"><span className="pri">{total ? fmtINR(total) : "-"}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              {lines.length > 30 && (
                <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 6 }}>
                  Showing first 30 of {lines.length} lines. Open the full workspace for the rest.
                </div>
              )}
            </Card>

            {order.correction_reason && (
              <Banner kind="warn" icon={Icon.alert} title="Previous correction request">
                <span className="mono-sm">{order.correction_reason}</span>
              </Banner>
            )}
          </>
        )}

        <div className="row" style={{ gap: 8, marginTop: "auto", justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Btn sm kind="ghost" onClick={() => { window.location.hash = `#/so?id=${orderId}`; }}>open full workspace</Btn>
          <Btn sm kind="ghost" disabled={busy} onClick={() => setShowReasonBox((v) => !v)}>{showReasonBox ? "cancel return" : "return for fix"}</Btn>
          <Btn sm kind="primary" disabled={busy} onClick={onApprove} title="Approve this order">{Icon.check} approve</Btn>
        </div>
        {/* The reason for a return, typed here rather than in a browser
            prompt (a browser can suppress native dialogs). Required: the
            engineer has to know what to fix. */}
        {showReasonBox && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <label className="mono-sm" style={{ color: "var(--ink-3)" }} htmlFor="approvals-return-reason">
              What needs to be fixed? The engineer sees this on the order.
            </label>
            <textarea
              id="approvals-return-reason"
              className="input"
              rows={3}
              value={reason}
              placeholder="e.g. Ship-to address is wrong, should be Plant 2, not Plant 1."
              onChange={(e) => setReason(e.target.value)}
              style={{ width: "100%", padding: 6 }}
            />
            <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
              <Btn
                sm
                kind="primary"
                disabled={busy || !reason.trim()}
                onClick={() => {
                  onReturnForCorrection(reason.trim());
                  setReason("");
                  setShowReasonBox(false);
                }}
              >
                send back for fix
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================
// ANVIL v3: the wired Approvals queue
//
// Lists EVERY order waiting for approval (PENDING_REVIEW), with the
// quote_approvals threshold rows shown as its reasons. It used to list the
// threshold rows only, and its approve and reject wrote quote_approvals and
// never the order: the order stayed PENDING_REVIEW after "approve".
//
// Approve now sends the SO workspace's request (approvalPatch: the order's
// payload hash) to PATCH /api/orders/<id>, then closes the order's open
// threshold rows. Return for fix sends the workspace's return body.
// ============================================================

const WiredApprovals = () => {
  const [state, setState] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const [bump, setBump] = useState(0);
  // Approval review previously route-navigated to /so?id= which lost
  // queue context. The drawer renders an in-page summary so the
  // reviewer can decide without leaving the screen.
  const [reviewing, setReviewing] = useState<QueueRow | null>(null);
  // The row whose approve is waiting for its second click. An in-app
  // confirm, not window.confirm: a browser can suppress native dialogs, and
  // then the approve did nothing and said nothing.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve(AnvilBackend?.admin?.listApprovalQueue?.())
      .then((data: any) => {
        if (cancelled) return;
        if (!data) throw new Error("Approvals queue is not available");
        setState({ data, loading: false, error: null });
        // An open drawer follows its order to the fresh row (its hash may
        // have moved), and closes when the order has left the queue.
        const fresh: QueueRow[] = Array.isArray(data?.orders) ? data.orders : [];
        setReviewing((cur) => (cur ? fresh.find((r) => r.order_id === cur.order_id) || null : cur));
      })
      .catch((error) => { if (!cancelled) setState({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [bump]);

  const reload = () => setBump((n) => n + 1);

  // Close the order's open threshold rows once the order itself is decided,
  // so the policy record says who decided and when. The order's status is
  // the decision; a row that fails to close is reported, not retried.
  const closeThresholds = async (row: QueueRow, status: "APPROVED" | "REJECTED", comments: string | null) => {
    let failed = 0;
    for (const t of row.thresholds || []) {
      try {
        await AnvilBackend?.admin?.decideApprovalRequest?.({
          id: t.id, order_id: row.order_id, approver_role: t.approver_role || "sales_manager", status, comments,
        });
      } catch (_) { failed += 1; }
    }
    return failed;
  };

  const onApprove = async (row: QueueRow) => {
    setConfirming(null);
    const patch = approvalPatch(row);
    if (!patch) {
      window.notifyError?.("Approve failed", NO_PAYLOAD_HASH_MESSAGE);
      return;
    }
    setBusy(row.order_id);
    try {
      await AnvilBackend?.orders?.update?.(row.order_id, patch);
    } catch (err: any) {
      // The order moved after the queue read it (409 STALE_APPROVAL). Reload
      // the queue, and with it the drawer, so the approver sees it as it is.
      if (isStaleApproval(err)) {
        window.notifyWarn?.(STALE_APPROVAL_MESSAGE, refOf(row) + " has been reloaded. Review it, then approve again.");
        reload();
      } else if (isBlockingException(err)) {
        // 409 ORDER_HAS_BLOCKING_EXCEPTION: the server's message names the
        // rows, which are decided on the order.
        window.notifyWarn?.(BLOCKING_EXCEPTION_TITLE, refOf(row) + ": " + (err?.message || String(err)));
        reload();
      } else {
        window.notifyError?.("Approve failed", err?.message || String(err));
      }
      setBusy(null);
      return;
    }
    const failed = await closeThresholds(row, "APPROVED", null);
    if (failed) {
      window.notifyWarn?.("Order approved", refOf(row) + " . " + failed + " policy row" + (failed === 1 ? "" : "s") + " could not be closed");
    } else {
      window.notifySuccess?.("Order approved", refOf(row));
    }
    setBusy(null);
    setReviewing(null);
    reload();
  };

  // Return for fix: the same PATCH the SO workspace sends. The order goes back
  // to DRAFT with the reason, which the server audits as
  // manager_requested_correction and the workspace shows as a banner. Nobody
  // is notified yet (plan PR 14), so the toast does not claim it.
  const onReturnForCorrection = async (row: QueueRow, reason: string) => {
    setBusy(row.order_id);
    try {
      await AnvilBackend?.orders?.update?.(row.order_id, {
        status: "DRAFT",
        correction_reason: reason,
        correction_requested_by: RBAC?.role?.() || "sales_manager",
        correction_requested_at: new Date().toISOString(),
      });
    } catch (err: any) {
      window.notifyError?.("Return-for-correction failed", err?.message || String(err));
      setBusy(null);
      return;
    }
    await closeThresholds(row, "REJECTED", "Returned for fix: " + reason);
    window.notifySuccess?.("Sent back for correction", refOf(row) + " . the reason shows on the order");
    setBusy(null);
    setReviewing(null);
    reload();
  };

  const canApprove = RBAC?.canApprove?.("approvals") === true;

  if (state.loading && !state.data) {
    return (
      <>
        <WSTitle eyebrow="Workflows · Approvals" title="Approvals" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading queue…</div></Card></div>
      </>
    );
  }

  if (state.error) {
    return (
      <>
        <WSTitle eyebrow="Workflows · Approvals" title="Approvals" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load approvals" action={<Btn sm onClick={reload}>retry</Btn>}>
            <span className="mono-sm">{String(state.error.message || state.error)}</span>
          </Banner>
        </div>
      </>
    );
  }

  const pending: QueueRow[] = Array.isArray(state.data?.orders) ? state.data.orders : [];
  const withPolicy = pending.filter((r) => (r.thresholds || []).length > 0).length;
  const marginBreaches = pending.filter((r) => r.margin_pct != null && Number(r.margin_pct) < 10).length;
  const waitingDay = pending.filter((r) => r.updated_at && Date.now() - new Date(r.updated_at).getTime() > 24 * 3600 * 1000).length;

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Approvals"
        title="Approvals"
        meta={`${pending.length} pending · ${withPolicy} with a policy match`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Pending" v={String(pending.length)} d={pending.length ? "needs decision" : "queue clear"} live={pending.length > 0} />
          <KPI lbl="Policy match" v={String(withPolicy)} d={withPolicy ? "threshold rows open" : "none"} />
          <KPI lbl="Margin breaches" v={String(marginBreaches)} d={marginBreaches ? "below floor" : "all healthy"} dKind={marginBreaches ? "down" : ""} />
          <KPI lbl="Waiting > 1 day" v={String(waitingDay)} d={waitingDay ? "act now" : "no rush"} dKind={waitingDay ? "down" : ""} />
        </KPIRow>

        <Card flush>
          {pending.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              Queue is empty. An order appears here when it is sent for approval.
            </div>
          ) : (
            // Wrap the table in a horizontally scrollable container so the
            // Actions column is never clipped on a laptop-width viewport.
            <div style={{ overflowX: "auto" }}>
            <table className="tbl" style={{ minWidth: 1040 }}>
              <thead><tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Mode</th>
                <th className="r">Lines</th>
                <th>Why</th>
                <th className="r">Value</th>
                <th className="r">Margin</th>
                <th className="r">Waiting</th>
                {canApprove && <th style={{ minWidth: 260 }} className="r">Actions</th>}
              </tr></thead>
              <tbody>
                {pending.map((r) => {
                  // NOT `|| 0`: a negative margin is a loss, and zero-ing it
                  // would paint the worst orders as merely unremarkable.
                  const margin = Number.isFinite(Number(r.margin_pct)) ? Number(r.margin_pct) : 0;
                  const rowBusy = busy === r.order_id;
                  return (
                    <tr key={r.order_id} data-testid={"approvals-row-" + r.order_id}>
                      <td className="mono"><span className="pri">{refOf(r)}</span></td>
                      <td>{r.customer_name || "-"}{r.state_code ? <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{r.state_code}</div> : null}</td>
                      <td><Chip k={r.order_mode === "INTERNAL" ? "plum" : (r.order_mode || "").startsWith("PROJECT") ? "info" : "ghost"}>{r.order_mode || "-"}</Chip></td>
                      <td className="r mono" style={{ color: r.line_count === 0 ? "var(--rust)" : "var(--ink)" }}>{r.line_count != null ? r.line_count : "-"}</td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                          {reasonsOf(r).map((x, i) => <Chip key={i} k={x.k}>{x.label}</Chip>)}
                        </div>
                      </td>
                      <td className="r mono">{r.value_inr ? fmtINR(Number(r.value_inr)) : "-"}</td>
                      {/* A blank used to mean two very different things: a thin
                          margin and an order nobody costed. */}
                      <td className="r mono" style={{ color: margin > 0 && margin < 10 ? "var(--rust)" : "var(--ink)", fontWeight: 600 }}>
                        {r.margin_state === "hidden" ? (
                          <span style={{ color: "var(--ink-4)", fontWeight: 400 }} title="Margin is cost data, and your role cannot see cost">
                            hidden
                          </span>
                        ) : r.margin_state === "not_costed" ? (
                          <span style={{ color: "var(--ink-4)", fontWeight: 400 }} title="No price composition on this order, so the margin cannot be computed">
                            not costed
                          </span>
                        ) : (
                          <>
                            {margin.toFixed(1)}%
                            {r.margin_state === "partial" && (
                              <span
                                style={{ color: "var(--amber)", fontWeight: 400 }}
                                title={`Only ${r.margin_lines_matched} of ${r.margin_lines_total} lines are costed. This is the margin on the costed part, not on the order`}
                              > ·{r.margin_lines_matched}/{r.margin_lines_total}</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="r mono" style={{ color: "var(--ink-3)" }} title="Since the order was last changed">
                        {ageLabel(r.updated_at || r.created_at)}
                      </td>
                      {canApprove && (
                        <td>
                          <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <Btn sm kind="ghost" disabled={rowBusy} onClick={() => setReviewing(r)}>review</Btn>
                            {confirming === r.order_id ? (
                              <>
                                <Btn sm kind="ghost" disabled={rowBusy} onClick={() => setConfirming(null)}>cancel</Btn>
                                <Btn sm kind="primary" disabled={rowBusy} onClick={() => onApprove(r)} title={"Confirm: approve " + refOf(r)}>
                                  {Icon.check} confirm approve
                                </Btn>
                              </>
                            ) : (
                              <Btn sm kind="primary" disabled={rowBusy} onClick={() => setConfirming(r.order_id)} title={"Approve " + refOf(r)}>
                                {Icon.check} approve
                              </Btn>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
        </Card>
      </div>
      {reviewing && (
        <SOReviewDrawer
          row={reviewing}
          busy={busy === reviewing.order_id}
          onClose={() => setReviewing(null)}
          onApprove={() => onApprove(reviewing)}
          onReturnForCorrection={(reason) => onReturnForCorrection(reviewing, reason)}
        />
      )}
    </>
  );
};


export default WiredApprovals;
