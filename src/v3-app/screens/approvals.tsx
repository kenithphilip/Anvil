import React, { useEffect, useState } from "react";
import { fmtINRShort } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle, fmtINR } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { RBAC } from "../lib/rbac";
import { AnvilBackend } from "../lib/api";

// In-page SO preview drawer used by the Approvals queue. Replaces
// the prior "review" button that route-navigated to /so?id= and
// lost the queue context. The drawer fetches the order via the
// existing /api/orders/[id] handler and renders a read-only
// summary (customer, line totals, key fields). Approve / Reject /
// Return-for-correction land back on the parent screen so the
// reviewer can decide without leaving the queue.
const SOReviewDrawer: React.FC<{
  orderId: string;
  approval: any;
  onClose: () => void;
  onDecide: (decision: "APPROVED" | "REJECTED") => void;
  onReturnForCorrection: (reason: string) => void;
}> = ({ orderId, approval, onClose, onDecide, onReturnForCorrection }) => {
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
  }, [orderId]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const order = state.data?.order || state.data;
  const lines = order?.result?.salesOrder?.lineItems || [];
  const grandTotal = Number(order?.result?.salesOrder?.grandTotal) || 0;
  const customer = order?.result?.salesOrder?.customer || {};

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
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {approval.po_number || approval.order_reference || (approval.order_id ? approval.order_id.slice(0, 12) : "SO")}
            </div>
          </div>
          <Btn sm kind="ghost" onClick={onClose}>close</Btn>
        </div>

        {state.loading && <div className="body">Loading order...</div>}
        {state.error && (
          <Banner kind="bad" icon={Icon.alert} title="Could not load order">
            <span className="mono-sm">{String(state.error.message || state.error)}</span>
          </Banner>
        )}
        {order && (
          <>
            <Card title="Customer" eyebrow="from PO header">
              <div className="mono-sm" style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 4 }}>
                <div style={{ color: "var(--ink-3)" }}>Name</div><div>{customer.name || order.customer_name || "-"}</div>
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

            <div className="row" style={{ gap: 8, marginTop: "auto", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <Btn sm kind="ghost" onClick={() => { window.location.hash = `#/so?id=${orderId}`; }}>open full workspace</Btn>
              <Btn sm kind="danger" onClick={() => onDecide("REJECTED")}>reject</Btn>
              <Btn sm kind="ghost" onClick={() => setShowReasonBox((v) => !v)}>{showReasonBox ? "cancel return" : "return for fix"}</Btn>
              <Btn sm kind="primary" onClick={() => onDecide("APPROVED")}>{Icon.check} approve</Btn>
            </div>
            {showReasonBox && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <label className="mono-sm" style={{ color: "var(--ink-3)" }}>Reason (shared with operator)</label>
                <textarea
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
                    disabled={!reason.trim()}
                    onClick={() => {
                      onReturnForCorrection(reason.trim());
                      setReason("");
                      setShowReasonBox(false);
                    }}
                  >
                    send back to operator
                  </Btn>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// ============================================================
// ANVIL v3 — wired Approvals queue
// Pulls quote_approvals via /api/admin/quote_approvals?type=approvals
// (no client wrapper exists yet, so direct fetch.)
// ============================================================

const WiredApprovals = () => {
  const { useState: u, useEffect: e } = React;
  const [state, setState] = u({ data: null, loading: true, error: null });
  const [bump, setBump] = u(0);
  // Approval review previously route-navigated to /so?id= which lost
  // queue context. The drawer renders an in-page summary so the
  // reviewer can decide without leaving the screen.
  const [reviewing, setReviewing] = u<any | null>(null);

  const fetchApprovals = async () => {
    const cfg = (AnvilBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string };
    const session = (AnvilBackend?.getSession?.() || null) as { access_token?: string } | null;
    if (!cfg.url) throw new Error("Backend URL not configured");
    const headers = { "Content-Type": "application/json" };
    if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
    const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/admin/quote_approvals?type=approvals", { headers });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  };

  const decideApproval = async (id, order_id, approver_role, status) => {
    const cfg = (AnvilBackend?.getConfig?.() || {}) as { url?: string; tenantId?: string };
    const session = (AnvilBackend?.getSession?.() || null) as { access_token?: string } | null;
    if (!cfg.url) throw new Error("Backend URL not configured");
    const headers = { "Content-Type": "application/json" };
    if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
    const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/admin/quote_approvals?type=approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({ id, order_id, approver_role, status }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  };

  e(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetchApprovals()
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (!cancelled) setState({ data: null, loading: false, error }); });
    return () => { cancelled = true; };
  }, [bump]);

  const reload = () => setBump((n) => n + 1);
  // Approval decisions are non-trivial (they unblock or block a sales
  // order); confirm before sending so a stray click doesn't auto-
  // approve. Errors flow into a notify toast (visible, dismissable)
  // instead of `window.alert` (modal, blocking, ugly).
  const onDecide = async (a, decision) => {
    const ref = a.po_number || a.order_reference || (a.order_id ? a.order_id.slice(0, 12) : "this order");
    const verb = decision === "APPROVED" ? "approve" : "reject";
    if (!window.confirm(`Are you sure you want to ${verb} ${ref}?`)) return;
    try {
      await decideApproval(a.id, a.order_id, a.approver_role || "sales_manager", decision);
      window.notifySuccess?.(decision === "APPROVED" ? "Approved" : "Rejected", ref);
      reload();
      setReviewing(null);
    } catch (err: any) {
      window.notifyError?.("Could not record decision", err?.message || String(err));
    }
  };

  // Return-for-correction from the in-page drawer. Flips the order
  // back to DRAFT and stamps the reason; the operator sees a banner
  // next time they open the SO workspace. The matching approval row
  // is decided as REJECTED so the queue stops surfacing it.
  const onReturnForCorrection = async (a, reason: string) => {
    const ref = a.po_number || a.order_reference || (a.order_id ? a.order_id.slice(0, 12) : "this order");
    try {
      await AnvilBackend?.orders?.update?.(a.order_id, {
        status: "DRAFT",
        correction_reason: reason,
        correction_requested_by: RBAC?.role?.() || "sales_manager",
        correction_requested_at: new Date().toISOString(),
      });
      try {
        await decideApproval(a.id, a.order_id, a.approver_role || "sales_manager", "REJECTED");
      } catch (_) { /* best-effort: status flip already succeeded */ }
      window.notifySuccess?.("Sent back for correction", ref + " . operator notified");
      reload();
      setReviewing(null);
    } catch (err: any) {
      window.notifyError?.("Return-for-correction failed", err?.message || String(err));
    }
  };

  const canApprove = RBAC?.canApprove?.("approvals") !== false;

  if (state.loading) {
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

  const all = state.data?.approvals || [];
  const pending = all.filter((a) => (a.status || "").toUpperCase() === "PENDING");
  const decided = all.filter((a) => (a.status || "").toUpperCase() !== "PENDING");

  // KPI math
  const expiringSoon = pending.filter((a) => {
    if (!a.expires_at) return false;
    const ms = new Date(a.expires_at).getTime() - Date.now();
    return ms > 0 && ms < 6 * 3600 * 1000;
  }).length;
  const marginBreaches = pending.filter((a) => Number(a.margin_pct) > 0 && Number(a.margin_pct) < 10).length;
  const approvedToday = decided.filter((a) => {
    const t = a.decided_at;
    return t && new Date(t).toDateString() === new Date().toDateString() && (a.status === "APPROVED");
  }).length;

  const expiresLabel = (iso) => {
    if (!iso) return "—";
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "expired";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins - hrs * 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs - days * 24}h`;
  };

  const reasonOf = (a) => {
    if (a.reasons && Array.isArray(a.reasons) && a.reasons.length) return a.reasons[0];
    if (Number(a.margin_pct) > 0 && Number(a.margin_pct) < 10) return "margin breach";
    if (a.over_threshold) return "value > threshold";
    return a.comments || "policy match";
  };

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Approvals"
        title="Approvals"
        meta={`${pending.length} pending · ${expiringSoon} expiring soon`}
        right={<>
          <Btn icon kind="ghost" sm onClick={reload} title="Refresh">{Icon.cycle}</Btn>
        </>}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Pending" v={String(pending.length)} d={pending.length ? "needs decision" : "queue clear"} live={pending.length > 0} />
          <KPI lbl="Expiring < 6h" v={String(expiringSoon)} d={expiringSoon ? "act now" : "no rush"} dKind={expiringSoon ? "down" : ""} />
          <KPI lbl="Margin breaches" v={String(marginBreaches)} d={marginBreaches ? "below floor" : "all healthy"} dKind={marginBreaches ? "down" : ""} />
          <KPI lbl="Approved today" v={String(approvedToday)} d="auto + manual" />
        </KPIRow>

        <Card flush>
          {pending.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              Queue is empty. Pending approvals appear here when an SO breaches policy.
            </div>
          ) : (
            // Wrap the table in a horizontally scrollable container.
            // The Actions column carries 3 buttons (review, approve,
            // reject) plus generous gaps; on standard laptop widths
            // (1280px) the rightmost button was being clipped by the
            // viewport edge because the Card had no overflow guard.
            // overflow-x: auto lets the user scroll if the columns
            // exceed the Card width without ever hiding actions.
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
                <th className="r">Expires</th>
                {canApprove && <th style={{ minWidth: 300 }} className="r">Actions</th>}
              </tr></thead>
              <tbody>
                {pending.map((a) => {
                  const margin = Number(a.margin_pct) || 0;
                  return (
                    <tr key={a.id}>
                      <td className="mono"><span className="pri">{a.po_number || a.order_reference || (a.order_id ? a.order_id.slice(0, 12) : "—")}</span></td>
                      <td>{a.customer_name || "—"}{a.state_code ? <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{a.state_code}</div> : null}</td>
                      <td><Chip k={a.order_mode === "INTERNAL" ? "plum" : (a.order_mode || "").startsWith("PROJECT") ? "info" : "ghost"}>{a.order_mode || "—"}</Chip></td>
                      <td className="r mono" style={{ color: a.line_count === 0 ? "var(--rust)" : "var(--ink)" }}>{a.line_count != null ? a.line_count : "—"}</td>
                      <td><Chip k="warn">{reasonOf(a)}</Chip></td>
                      <td className="r mono">{a.value_inr ? fmtINR(Number(a.value_inr)) : "—"}</td>
                      <td className="r mono" style={{ color: margin > 0 && margin < 10 ? "var(--rust)" : "var(--ink)", fontWeight: 600 }}>
                        {margin > 0 ? margin.toFixed(1) + "%" : "—"}
                      </td>
                      <td className="r mono" style={{ color: a.expires_at && new Date(a.expires_at).getTime() - Date.now() < 6 * 3600 * 1000 ? "var(--rust)" : "var(--ink-3)" }}>
                        {expiresLabel(a.expires_at)}
                      </td>
                      {canApprove && (
                        <td>
                          <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                            <Btn sm kind="ghost" onClick={() => setReviewing(a)}>review</Btn>
                            <Btn sm kind="primary" onClick={() => onDecide(a, "APPROVED")}>{Icon.check} approve</Btn>
                            <Btn sm kind="danger" onClick={() => onDecide(a, "REJECTED")}>reject</Btn>
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
          orderId={reviewing.order_id}
          approval={reviewing}
          onClose={() => setReviewing(null)}
          onDecide={(decision) => onDecide(reviewing, decision)}
          onReturnForCorrection={(reason) => onReturnForCorrection(reviewing, reason)}
        />
      )}
    </>
  );
};


export default WiredApprovals;
