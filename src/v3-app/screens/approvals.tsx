// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useState } from "react";
import { fmtINRShort } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { RBAC } from "../lib/rbac";

// ============================================================
// ANVIL v3 — wired Approvals queue
// Pulls quote_approvals via /api/admin/quote_approvals?type=approvals
// (no client wrapper exists yet, so direct fetch.)
// ============================================================

const WiredApprovals = () => {
  const { useState: u, useEffect: e } = React;
  const [state, setState] = u({ data: null, loading: true, error: null });
  const [bump, setBump] = u(0);

  const fetchApprovals = async () => {
    const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
    const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
    if (!cfg.url) throw new Error("Backend URL not configured");
    const headers = { "Content-Type": "application/json" };
    if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
    if (cfg.tenantId) headers["x-obara-tenant"] = cfg.tenantId;
    const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/admin/quote_approvals?type=approvals", { headers });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    return resp.json();
  };

  const decideApproval = async (id, order_id, approver_role, status) => {
    const cfg = JSON.parse(localStorage.getItem("obara:backend_config") || "{}");
    const session = JSON.parse(localStorage.getItem("obara:backend_session") || "null");
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
  const onDecide = async (a, decision) => {
    try {
      await decideApproval(a.id, a.order_id, a.approver_role || "sales_manager", decision);
      reload();
    } catch (err) {
      window.alert("Could not record decision: " + (err.message || err));
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
            <table className="tbl">
              <thead><tr>
                <th>Reference</th>
                <th>Customer</th>
                <th>Mode</th>
                <th>Why</th>
                <th className="r">Value</th>
                <th className="r">Margin</th>
                <th className="r">Expires</th>
                {canApprove && <th style={{ width: 200 }}>Actions</th>}
              </tr></thead>
              <tbody>
                {pending.map((a) => {
                  const margin = Number(a.margin_pct) || 0;
                  return (
                    <tr key={a.id}>
                      <td className="mono"><span className="pri">{a.po_number || a.order_reference || (a.order_id ? a.order_id.slice(0, 12) : "—")}</span></td>
                      <td>{a.customer_name || "—"}</td>
                      <td><Chip k={a.order_mode === "INTERNAL" ? "plum" : (a.order_mode || "").startsWith("PROJECT") ? "info" : "ghost"}>{a.order_mode || "—"}</Chip></td>
                      <td><Chip k="warn">{reasonOf(a)}</Chip></td>
                      <td className="r mono">{a.value_inr ? fmtINRShort(Number(a.value_inr)) : "—"}</td>
                      <td className="r mono" style={{ color: margin > 0 && margin < 10 ? "var(--rust)" : "var(--ink)", fontWeight: 600 }}>
                        {margin > 0 ? margin.toFixed(1) + "%" : "—"}
                      </td>
                      <td className="r mono" style={{ color: a.expires_at && new Date(a.expires_at).getTime() - Date.now() < 6 * 3600 * 1000 ? "var(--rust)" : "var(--ink-3)" }}>
                        {expiresLabel(a.expires_at)}
                      </td>
                      {canApprove && (
                        <td className="row gap-sm">
                          <Btn sm kind="ghost" onClick={() => window.location.hash = `#/so?id=${a.order_id}`}>review</Btn>
                          <Btn sm kind="primary" onClick={() => onDecide(a, "APPROVED")}>{Icon.check} approve</Btn>
                          <Btn sm kind="danger" onClick={() => onDecide(a, "REJECTED")}>reject</Btn>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredApprovals;
