import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, sevOf, stageOf } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, Sev, WSTabs, WSTitle, rowActivateProps } from "../lib/primitives";
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

  // Normalise the API response into a flat array. The /api/orders
  // endpoint returns { orders: [...] }; some callers expect
  // { rows: [...] }, and a couple of older code paths return a bare
  // array. Accept all three so a future endpoint refactor doesn't
  // silently empty this list again (which is what shipped before
  // and made the sidebar badge say 12 while this view showed 0).
  const toRows = (data: any): any[] => {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.rows)) return data.rows;
    if (Array.isArray(data?.orders)) return data.orders;
    return [];
  };

  e(() => {
    let cancel = false;
    setOrders((s) => ({ ...s, loading: true }));
    Promise.resolve(ObaraBackend?.orders?.list?.({ limit: 200 }) || [])
      .then((data) => {
        if (cancel) return;
        setOrders({ rows: toRows(data), loading: false, error: null });
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
  const completed = (orders.rows || []).filter((o) => o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED");
  const sumValue = completed.reduce((s, o) => s + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);
  const blocked = (orders.rows || []).filter((o) => o.status === "BLOCKED").length;

  // Audit P13.B.2.1: cycle median (created_at -> updated_at on
  // completed orders), and ₹ pushed MTD. The audit's plan called
  // for 4 numeric KPIs (cycle median, first-pass rate, pushed
  // MTD, avg margin); we ship the two we can compute from the
  // /api/orders payload + skip first-pass-rate (no
  // was_manually_edited flag in schema) and avg-margin (no
  // margin_pct field). The plan explicitly says "do not
  // fabricate" so leaving the slot honest is correct.
  const cycleMins = completed
    .map((o) => {
      const c = o.created_at ? new Date(o.created_at).getTime() : 0;
      const u = o.updated_at ? new Date(o.updated_at).getTime() : 0;
      if (!c || !u || u < c) return null;
      return Math.round((u - c) / 60000);
    })
    .filter((n): n is number => n != null && Number.isFinite(n))
    .sort((a, b) => a - b);
  const cycleMedian = cycleMins.length
    ? (cycleMins.length % 2 === 0
        ? Math.round((cycleMins[cycleMins.length / 2 - 1] + cycleMins[cycleMins.length / 2]) / 2)
        : cycleMins[Math.floor(cycleMins.length / 2)])
    : null;

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const pushedMtd = completed.filter((o) => {
    const t = o.updated_at || o.created_at;
    return t && new Date(t).getTime() >= monthStart.getTime();
  });
  const pushedValueMtd = pushedMtd.reduce((s, o) => s + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);

  return (
    <>
      <WSTitle
        eyebrow="Workflows · Sales Orders"
        title="Sales Orders"
        meta={`${total} total · ${inFlight} active`}
        right={<>
          <input className="input" placeholder="search reference, customer…" value={query}
                 aria-label="Search orders by reference or customer"
                 onChange={(ev) => setQuery(ev.target.value)} style={{ width: 260, height: 28 }} />
          <Btn sm kind="ghost" onClick={() => {
            setOrders((s) => ({ ...s, loading: true }));
            const p = ObaraBackend?.orders?.list?.({ limit: 200 });
            if (p) p.then((d: any) => setOrders({ rows: toRows(d), loading: false, error: null }));
          }}>{Icon.cycle} refresh</Btn>
          <Btn sm kind="primary" onClick={() => window.location.hash = "#/so?new=1"}>{Icon.plus} New from PO</Btn>
        </>}
      />
      <WSTabs
        tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
        active={active}
        onChange={setActive}
      />

      <div className="ws-content">
        <KPIRow cols={5}>
          <KPI lbl="Total" v={String(total)} d="all-time in scope" />
          <KPI lbl="In flight" v={String(inFlight)} d="not yet shipped" live={inFlight > 0} />
          <KPI
            lbl="Cycle median"
            v={cycleMedian == null ? "—" : (cycleMedian < 60 ? cycleMedian + "m" : Math.round(cycleMedian / 60) + "h")}
            d={cycleMedian == null ? "no completed orders" : `${completed.length} completed orders`}
          />
          <KPI lbl="₹ pushed MTD" v={fmtINRShort(pushedValueMtd)} d={`${pushedMtd.length} this month`} dKind={pushedMtd.length ? "up" : ""} />
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
                  <tr key={o.id} {...rowActivateProps(
                    () => { window.location.hash = `#/so?id=${o.id}`; },
                    `Open order ${o.po_number || o.quote_number || o.id?.slice(0, 8) || "draft"}`,
                  )}>
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
