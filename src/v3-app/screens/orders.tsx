// @ts-nocheck — converted screen, types follow in a focused TS pass
import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, sevOf, stageOf } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, Sev, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Sales Orders list
// ============================================================

const WiredSOList = () => {
  const { useState: u, useEffect: e } = React;
  const [orders, setOrders] = u({ rows: [], loading: true, error: null });
  const [active, setActive] = u("all");
  const [query, setQuery] = u("");

  e(() => {
    let cancel = false;
    setOrders((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.orders?.list?.({ limit: 200 }) || [])
      .then((data) => {
        if (cancel) return;
        const rows = Array.isArray(data) ? data : (data?.rows || []);
        setOrders({ rows, loading: false, error: null });
      })
      .catch((err) => { if (!cancel) setOrders({ rows: [], loading: false, error: err }); });
    return () => { cancel = true; };
  }, []);

  const tabs = [
    { id: "all",      label: "All",        match: () => true },
    { id: "mine",     label: "Mine",       match: (_o) => true /* TODO: when user id is plumbed, filter by owner */ },
    { id: "intake",   label: "Intake",     match: (o) => o.status === "DRAFT" },
    { id: "validate", label: "Validate",   match: (o) => o.status === "PENDING_REVIEW" },
    { id: "approval", label: "Approval",   match: (o) => o.status === "APPROVED" },
    { id: "tally",    label: "Tally",      match: (o) => o.status === "EXPORTED_TO_TALLY" || o.status === "FAILED_TALLY_IMPORT" },
    { id: "shipped",  label: "Shipped",    match: (o) => o.status === "RECONCILED" },
    { id: "blocked",  label: "Blocked",    match: (o) => o.status === "BLOCKED" || o.status === "DUPLICATE" },
    { id: "closed",   label: "Closed",     match: (o) => o.status === "CANCELLED" },
  ];

  const filtered = (orders.rows || [])
    .filter(tabs.find((t) => t.id === active)?.match || (() => true))
    .filter((o) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        (o.po_number || "").toLowerCase().includes(q) ||
        (o.quote_number || "").toLowerCase().includes(q) ||
        (o.customer?.customer_name || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q)
      );
    });

  const counts = Object.fromEntries(tabs.map((t) => [t.id, (orders.rows || []).filter(t.match).length]));

  // Aggregate KPIs
  const total = (orders.rows || []).length;
  const inFlight = (orders.rows || []).filter((o) => !["RECONCILED", "CANCELLED"].includes(o.status)).length;
  const sumValue = (orders.rows || [])
    .filter((o) => o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED")
    .reduce((s, o) => s + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);
  const blocked = (orders.rows || []).filter((o) => o.status === "BLOCKED").length;

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Sales Orders"
        title="Sales Orders"
        meta={`${total} total · ${inFlight} active`}
        right={<>
          <input className="input" placeholder="search reference, customer…" value={query}
                 onChange={(ev) => setQuery(ev.target.value)} style={{ width: 260, height: 28 }} />
          <Btn sm kind="ghost" onClick={() => setOrders((s) => ({ ...s, loading: true })) || ObaraBackend?.orders?.list?.({ limit: 200 }).then((d) => setOrders({ rows: Array.isArray(d) ? d : (d?.rows || []), loading: false, error: null }))}>{Icon.cycle} refresh</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/intake"}>{Icon.plus} New from PO</Btn>
        </>}
      />
      <WSTabs
        tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI lbl="Total" v={String(total)} d="all-time in scope" />
          <KPI lbl="In flight" v={String(inFlight)} d="not yet shipped" live={inFlight > 0} />
          <KPI lbl="₹ pushed" v={fmtINRShort(sumValue)} d="completed orders" dKind="up" />
          <KPI lbl="Blocked" v={String(blocked)} d="needs attention" dKind={blocked ? "down" : ""} />
        </KPIRow>

        {orders.error ? (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load orders">
            <span className="mono-sm">{String(orders.error.message || orders.error)}</span>
          </Banner>
        ) : null}

        <Card flush>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 22 }}></th>
              <th>Reference</th>
              <th>Customer</th>
              <th>Mode</th>
              <th>Stage</th>
              <th className="r">Lines</th>
              <th className="r">Value</th>
              <th className="r">Updated</th>
            </tr></thead>
            <tbody>
              {orders.loading ? (
                <tr><td colSpan={8} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading orders…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No orders in this view. {active !== "all" && <button type="button" onClick={() => setActive("all")} className="link-btn" style={{ color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>show all</button>}
                </td></tr>
              ) : filtered.slice(0, 100).map((o) => {
                const st = stageOf(o.status);
                const lines = (o.result?.salesOrder?.lineItems || []).length;
                const value = Number(o.result?.salesOrder?.grandTotal) || 0;
                const mode = o.order_mode || (o.result?.salesOrder?.mode) || "—";
                return (
                  <tr key={o.id} onClick={() => window.location.hash = `#/so?id=${o.id}`} style={{ cursor: "pointer" }}>
                    <td><Sev k={sevOf(o)} /></td>
                    <td className="mono"><span className="pri">{o.po_number || o.quote_number || "draft"}</span></td>
                    <td>{o.customer?.customer_name || "—"}<div className="mono-sm">{o.customer?.state_code || ""}</div></td>
                    <td><Chip k={mode === "INTERNAL" ? "plum" : mode.startsWith("PROJECT") ? "info" : "ghost"}>{mode}</Chip></td>
                    <td><Chip k={st.k}>{st.label}</Chip></td>
                    <td className="r mono">{lines || "—"}</td>
                    <td className="r mono">{value ? fmtINRShort(value) : "—"}</td>
                    <td className="r mono">{ageLabel(o.updated_at || o.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length > 100 && (
            <div className="mono-sm" style={{ padding: 12, textAlign: "center", color: "var(--ink-3)", borderTop: "1px solid var(--hairline-2)" }}>
              Showing 100 of {filtered.length} · refine the search to narrow.
            </div>
          )}
        </Card>
      </div>
    </>
  );
};


export default WiredSOList;
