import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, sevOf, stageOf, draftLabel } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, Sev, WSTabs, WSTitle, rowActivateProps } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — wired Sales Orders list
// ============================================================

// Read the current user's id for the "Mine" tab filter. Matches
// the same pattern used in admin.tsx: localStorage profile cache
// first, session fallback. Returns null when no user is signed in
// so the Mine tab degrades gracefully (no rows match).
const readCurrentUserId = (): string | null => {
  try {
    const cached = JSON.parse(localStorage.getItem("obara:auth_profile") || "null");
    if (cached?.user?.id) return String(cached.user.id);
  } catch (_) { /* ignore */ }
  try {
    const session = (ObaraBackend?.getSession?.() || null) as { user?: { id?: string } } | null;
    if (session?.user?.id) return String(session.user.id);
  } catch (_) { /* ignore */ }
  return null;
};

const WiredSOList = () => {
  const { useState: u, useEffect: e } = React;
  const [orders, setOrders] = u({ rows: [], loading: true, error: null });
  const [active, setActive] = u("all");
  const [query, setQuery] = u("");
  // Filter chip state. Design package's strip has mode / customer /
  // currency / approver. Approver is omitted here because the audit
  // row carries a UUID rather than a name and showing UUIDs to
  // operators is bad UX; reinstate once the API joins
  // approved_by -> auth_users.email. "" = unfiltered ("any").
  const [modeFilter, setModeFilter] = u("");
  const [customerFilter, setCustomerFilter] = u("");
  const [currencyFilter, setCurrencyFilter] = u("");
  // Audit P13.B follow-up. The Mine tab was a TODO until now: it
  // matched every row because the user id was not plumbed. The
  // orders table has no `created_by` column (only `approved_by`),
  // so "Mine" today means "orders this user approved." Once a
  // `created_by` / `assigned_to` column lands, broaden the match.
  const meId = readCurrentUserId();

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
    Promise.resolve(ObaraBackend?.orders?.list?.({ limit: 200, slim: 1 }) || [])
      .then((data) => {
        if (cancel) return;
        setOrders({ rows: toRows(data), loading: false, error: null });
      })
      .catch((err) => { if (!cancel) setOrders({ rows: [], loading: false, error: err }); });
    return () => { cancel = true; };
  }, []);

  const tabs = [
    { id: "all",      label: "All",        match: () => true },
    { id: "mine",     label: "Mine",       match: (o) => !!meId && (o.approved_by === meId) },
    { id: "intake",   label: "Intake",     match: (o) => o.status === "DRAFT" },
    { id: "validate", label: "Validate",   match: (o) => o.status === "PENDING_REVIEW" },
    { id: "approval", label: "Approval",   match: (o) => o.status === "APPROVED" },
    { id: "tally",    label: "Tally",      match: (o) => o.status === "EXPORTED_TO_TALLY" || o.status === "FAILED_TALLY_IMPORT" },
    { id: "shipped",  label: "Shipped",    match: (o) => o.status === "RECONCILED" },
    { id: "blocked",  label: "Blocked",    match: (o) => o.status === "BLOCKED" || o.status === "DUPLICATE" },
    { id: "closed",   label: "Closed",     match: (o) => o.status === "CANCELLED" },
  ];

  const orderCurrency = (o: any) => o.result?.salesOrder?.currency || o.currency || "INR";
  const orderMode = (o: any) => o.order_mode || "";
  const orderCustomerName = (o: any) => o.customer?.customer_name || "";

  // Distinct value pools for the filter chip dropdowns. Deduped +
  // sorted alphabetically so the dropdown reads consistently.
  const distinctSorted = (vals: string[]) => Array.from(new Set(vals.filter(Boolean))).sort();
  const modeOptions = distinctSorted((orders.rows || []).map(orderMode));
  const customerOptions = distinctSorted((orders.rows || []).map(orderCustomerName));
  const currencyOptions = distinctSorted((orders.rows || []).map(orderCurrency));
  const anyFilterActive = !!(modeFilter || customerFilter || currencyFilter);

  const filtered = (orders.rows || [])
    .filter(tabs.find((t) => t.id === active)?.match || (() => true))
    .filter((o) => !modeFilter || orderMode(o) === modeFilter)
    .filter((o) => !customerFilter || orderCustomerName(o) === customerFilter)
    .filter((o) => !currencyFilter || orderCurrency(o) === currencyFilter)
    .filter((o) => {
      if (!query) return true;
      const q = query.toLowerCase();
      return (
        (o.po_number || "").toLowerCase().includes(q) ||
        (o.quote_number || "").toLowerCase().includes(q) ||
        (o.customer?.customer_name || "").toLowerCase().includes(q) ||
        (o.id || "").toLowerCase().includes(q) ||
        // Include the synthesised draft label so an operator typing
        // "HYUND" or "DRAFT-19MAY" finds the matching row even when
        // the order has no PO# yet.
        draftLabel(o).toLowerCase().includes(q)
      );
    });

  const counts = Object.fromEntries(tabs.map((t) => [t.id, (orders.rows || []).filter(t.match).length]));

  // Aggregate KPIs
  const total = (orders.rows || []).length;
  const inFlight = (orders.rows || []).filter((o) => !["RECONCILED", "CANCELLED"].includes(o.status)).length;
  const completed = (orders.rows || []).filter((o) => o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED");
  const sumValue = completed.reduce((s, o) => s + (Number(o.result?.salesOrder?.grandTotal) || 0), 0);
  const blocked = (orders.rows || []).filter((o) => o.status === "BLOCKED").length;
  // Push success rate: of every order that has been pushed (or
  // failed to push), what share succeeded. RECONCILED counts as
  // success because it only reaches that status post-push.
  const pushedRows = (orders.rows || []).filter((o) => ["EXPORTED_TO_TALLY", "RECONCILED", "FAILED_TALLY_IMPORT"].includes(o.status));
  const pushedSuccess = pushedRows.filter((o) => o.status !== "FAILED_TALLY_IMPORT").length;
  const pushSuccessPct = pushedRows.length > 0 ? Math.round((pushedSuccess / pushedRows.length) * 100) : null;

  // Audit P13.B.2.1 follow-up (May 2026): the design package
  // calls for 5 KPIs (Cycle median, First-pass rate, Push success,
  // Pushed MTD, Avg margin). First-pass rate needs a
  // `was_manually_edited` line-item flag the schema does not
  // carry; avg margin needs a `margin_pct` column we don't
  // populate. The plan explicitly says "do not fabricate", so we
  // ship the 3 metrics we can compute honestly (cycle median,
  // push success, pushed MTD) plus the operationally useful
  // Blocked count, in cols={4}. Total + In flight were dropped
  // because they're already in the WSTitle meta strip
  // ("N total · N active").
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
            const p = ObaraBackend?.orders?.list?.({ limit: 200, slim: 1 });
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

      {/* Filter chip strip per the design package. Each control is
          a small select styled to read as a chip; the value reads
          "mode: any" / "mode: PROJECT_HSS" / etc. Tabs still drive
          the status axis, so we don't duplicate it here. Clear
          button only renders when something is active. */}
      <div className="row gap-sm" style={{
        padding: "8px 16px",
        borderTop: "1px solid var(--hairline)",
        borderBottom: "1px solid var(--hairline)",
        alignItems: "center", flexWrap: "wrap",
        background: "var(--paper)",
      }}>
        <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
          {Icon.filter} filter
        </span>
        <Chip k={modeFilter ? "fill" : undefined}>
          mode:&nbsp;
          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value)}
            aria-label="Filter orders by order mode"
            style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", outline: "none", cursor: "pointer", padding: 0 }}
          >
            <option value="">any</option>
            {modeOptions.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </Chip>
        <Chip k={customerFilter ? "fill" : undefined}>
          customer:&nbsp;
          <select
            value={customerFilter}
            onChange={(e) => setCustomerFilter(e.target.value)}
            aria-label="Filter orders by customer"
            style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", outline: "none", cursor: "pointer", padding: 0, maxWidth: 200 }}
          >
            <option value="">any</option>
            {customerOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Chip>
        <Chip k={currencyFilter ? "fill" : undefined}>
          currency:&nbsp;
          <select
            value={currencyFilter}
            onChange={(e) => setCurrencyFilter(e.target.value)}
            aria-label="Filter orders by currency"
            style={{ background: "transparent", border: "none", color: "inherit", font: "inherit", outline: "none", cursor: "pointer", padding: 0 }}
          >
            <option value="">any</option>
            {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Chip>
        {anyFilterActive && (
          <button
            type="button"
            onClick={() => { setModeFilter(""); setCustomerFilter(""); setCurrencyFilter(""); }}
            style={{ background: "none", border: "none", color: "var(--ink-3)", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}
          >clear filters</button>
        )}
        <span style={{ flex: 1 }} />
        <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
          {filtered.length} match{filtered.length === 1 ? "" : "es"}
        </span>
      </div>

      <div className="ws-content">
        <KPIRow cols={4}>
          <KPI
            lbl="Cycle median"
            v={cycleMedian == null ? "—" : (cycleMedian < 60 ? cycleMedian + "m" : Math.round(cycleMedian / 60) + "h")}
            d={cycleMedian == null ? "no completed orders" : `${completed.length} completed orders`}
          />
          <KPI
            lbl="Push success"
            v={pushSuccessPct == null ? "—" : pushSuccessPct + "%"}
            d={pushSuccessPct == null ? "no pushes yet" : `${pushedSuccess} of ${pushedRows.length} pushes`}
            dKind={pushSuccessPct == null ? "" : (pushSuccessPct >= 95 ? "up" : pushSuccessPct < 80 ? "down" : "")}
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
                    `Open order ${draftLabel(o)}`,
                  )}>
                    <td><Sev k={sevOf(o)} /></td>
                    <td className="mono"><span className="pri">{draftLabel(o)}</span></td>
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
