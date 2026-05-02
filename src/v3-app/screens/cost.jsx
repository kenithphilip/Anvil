import React, { useEffect, useState } from "react";
import { ageLabel, fmtINRShort, useFetch } from "../lib/helpers.js";
import { Banner, Btn, Card, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives.jsx";
import { Icon } from "../lib/icons.jsx";
import { ObaraBackend } from "../lib/api.js";

// ============================================================
// ANVIL v3 — wired Cost & Margin
// Wave D · Finance
// Tabs:
//   Breakdown  — ObaraBackend.cost.breakdown()  + by-month bar chart
//   Simulator  — ObaraBackend.cost.simulator(...) per-scenario projection
//   History    — ObaraBackend.cost.marginHistory(customerId) sparkline
// ============================================================

const COST_TABS = [
  { id: "breakdown", label: "Breakdown" },
  { id: "sim",       label: "Simulator" },
  { id: "hist",      label: "Margin history" },
];

const COST_SCENARIOS = [
  { id: "full_sonnet",         label: "Full Sonnet" },
  { id: "haiku_pf_sonnet_gen", label: "Haiku preflight + Sonnet generation" },
  { id: "template_dry_run",    label: "Template dry run" },
  { id: "cached_duplicate",    label: "Cached duplicate" },
  { id: "opus_complex",        label: "Opus reasoning fallback" },
];

const SIMULATOR_TOKEN_ESTIMATE = { totalInput: 8000, call2Output: 1200 };

const usdToInr = (n) => `₹ ${(Number(n) * 83).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const fmtUsd = (n) => `$ ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---------- Breakdown tab --------------------------------
const CostBreakdown = () => {
  const breakdown = useFetch(() => ObaraBackend?.cost?.breakdown?.() || Promise.resolve({}), []);

  if (breakdown.loading) {
    return <Card><div className="body">Loading breakdown…</div></Card>;
  }
  if (breakdown.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Failed to load cost breakdown" action={<Btn sm onClick={breakdown.reload}>Retry</Btn>}>
        <span className="mono-sm">{String(breakdown.error.message || breakdown.error)}</span>
      </Banner>
    );
  }

  const data = breakdown.data || {};
  const byMonth = Array.isArray(data.byMonth) ? data.byMonth : [];
  const totalUsd      = Number(data.totalUsd) || 0;
  const totalSuccess  = Number(data.totalSuccess) || 0;
  const totalFields   = Number(data.totalFields) || 0;
  const costPerSuccess = Number(data.costPerSuccess) || 0;

  // Inline SVG bar chart for byMonth.usd.
  const W = 600, H = 180, P = 24;
  const max = byMonth.reduce((m, r) => Math.max(m, Number(r.usd) || 0), 0) || 1;
  const barW = byMonth.length ? (W - P * 2) / byMonth.length - 6 : 0;

  return (
    <>
      <KPIRow cols={4}>
        <KPI lbl="USD spent"      v={fmtUsd(totalUsd)}                 d={`≈ ${usdToInr(totalUsd)}`} />
        <KPI lbl="₹/successful SO" v={usdToInr(costPerSuccess)}        d={`${totalSuccess} successes`} dKind={costPerSuccess ? "up" : ""} />
        <KPI lbl="Total fields"    v={String(totalFields)}             d="evidence captured" />
        <KPI lbl="Total successes" v={String(totalSuccess)}            d="approved → tally" live={totalSuccess > 0} />
      </KPIRow>

      <Card title="Spend by month" eyebrow="USD">
        {byMonth.length === 0 ? (
          <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>No monthly data yet.</div>
        ) : (
          <>
            <div role="img" aria-label="Monthly USD spend bar chart" style={{ height: H, position: "relative" }}>
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none">
                <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="var(--hairline-2)" />
                {byMonth.map((r, i) => {
                  const v = Number(r.usd) || 0;
                  const h = ((H - P * 2) * v) / max;
                  const x = P + i * (barW + 6);
                  const y = H - P - h;
                  return (
                    <g key={r.month || i}>
                      <rect x={x} y={y} width={barW} height={h} fill="var(--ink)" />
                      <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--ink-3)">{(r.month || "").slice(2)}</text>
                      <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--ink-2)">{fmtUsd(v).replace("$ ", "$")}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
            <div className="divider" />
            <table className="tbl">
              <thead><tr>
                <th scope="col">Month</th>
                <th scope="col" className="r">USD</th>
                <th scope="col" className="r">Orders</th>
                <th scope="col" className="r">Successes</th>
              </tr></thead>
              <tbody>
                {byMonth.map((r) => (
                  <tr key={r.month}>
                    <td className="mono">{r.month}</td>
                    <td className="r mono">{fmtUsd(r.usd)}</td>
                    <td className="r mono">{r.count}</td>
                    <td className="r mono">{r.successCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
};

// ---------- Simulator tab --------------------------------
const CostSimulator = () => {
  const [scenarioId, setScenarioId] = useState(COST_SCENARIOS[0].id);
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState(null);
  const [err,  setErr]  = useState(null);

  // Prime the simulator with current cost-per-success so we can show a delta.
  const breakdown = useFetch(() => ObaraBackend?.cost?.breakdown?.() || Promise.resolve({}), []);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setErr(null);
    Promise.resolve(ObaraBackend?.cost?.simulator?.({ tokenEstimate: SIMULATOR_TOKEN_ESTIMATE }))
      .then((r) => { if (!cancelled) setResp(r); })
      .catch((e) => { if (!cancelled) setErr(e); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  const scenarios = (resp && Array.isArray(resp.scenarios)) ? resp.scenarios : [];
  const picked = scenarios.find((s) => s.id === scenarioId) || null;
  const baselineUsd = Number((breakdown.data || {}).costPerSuccess) || 0;
  const deltaUsd = picked ? (Number(picked.usd) || 0) - baselineUsd : 0;
  const deltaKind = picked ? (deltaUsd < 0 ? "up" : deltaUsd > 0 ? "down" : "") : "";

  return (
    <>
      <Card title="₹/SO simulator" eyebrow="what-if · per-routing scenario">
        <div className="row" style={{ alignItems: "center", gap: 10 }}>
          <label htmlFor="cost-sim-scenario" className="mono-sm">Scenario</label>
          <select
            id="cost-sim-scenario"
            className="input"
            value={scenarioId}
            onChange={(ev) => setScenarioId(ev.target.value)}
            style={{ height: 28 }}
          >
            {COST_SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <span style={{ flex: 1 }} />
          <span className="mono-sm">tokens · in {SIMULATOR_TOKEN_ESTIMATE.totalInput.toLocaleString()} · out {SIMULATOR_TOKEN_ESTIMATE.call2Output.toLocaleString()}</span>
        </div>

        {busy && <div className="body" style={{ padding: 12 }}>Simulating…</div>}
        {err && (
          <Banner kind="bad" icon={Icon.alert} title="Simulator failed">
            <span className="mono-sm">{String(err.message || err)}</span>
          </Banner>
        )}

        {picked && (
          <>
            <div className="divider" />
            <KPIRow cols={3}>
              <KPI lbl="Projected · USD" v={fmtUsd(picked.usd)} d={picked.label} />
              <KPI lbl="Projected · INR" v={usdToInr(picked.usd)} d="@ ₹83/$" />
              <KPI lbl="Δ vs current"
                   v={deltaUsd === 0 ? "—" : (deltaUsd > 0 ? "+ " : "− ") + fmtUsd(Math.abs(deltaUsd))}
                   d={baselineUsd > 0 ? `current ${fmtUsd(baselineUsd)}/SO` : "no baseline yet"}
                   dKind={deltaKind} />
            </KPIRow>
          </>
        )}

        {scenarios.length > 0 && (
          <>
            <div className="divider" />
            <table className="tbl">
              <thead><tr>
                <th scope="col">Scenario</th>
                <th scope="col" className="r">USD</th>
                <th scope="col" className="r">INR</th>
              </tr></thead>
              <tbody>
                {scenarios.map((s) => (
                  <tr key={s.id} style={{ background: s.id === scenarioId ? "var(--paper-2)" : "" }}>
                    <td>{s.label}</td>
                    <td className="r mono">{fmtUsd(s.usd)}</td>
                    <td className="r mono">{usdToInr(s.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
};

// ---------- Margin history tab ---------------------------
const CostMarginHistory = () => {
  const customers = useFetch(() => ObaraBackend?.customers?.list?.() || Promise.resolve({ customers: [] }), []);
  const [customerId, setCustomerId] = useState("");
  const [history, setHistory] = useState({ data: null, error: null, loading: false });

  const customerList = (customers.data && Array.isArray(customers.data.customers))
    ? customers.data.customers
    : (Array.isArray(customers.data) ? customers.data : []);

  useEffect(() => {
    if (!customerId) {
      setHistory({ data: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setHistory({ data: null, error: null, loading: true });
    Promise.resolve(ObaraBackend?.cost?.marginHistory?.(customerId))
      .then((d) => { if (!cancelled) setHistory({ data: d, error: null, loading: false }); })
      .catch((e) => { if (!cancelled) setHistory({ data: null, error: e, loading: false }); });
    return () => { cancelled = true; };
  }, [customerId]);

  const data = history.data || {};
  const recent = Array.isArray(data.recent) ? data.recent.slice().reverse() : [];

  // Inline SVG sparkline of marginPct over time (oldest left, newest right).
  const W = 480, H = 80, P = 6;
  const pcts = recent.map((r) => Number(r.marginPct) || 0);
  const min = pcts.length ? Math.min(...pcts) : 0;
  const max = pcts.length ? Math.max(...pcts) : 1;
  const span = (max - min) || 1;
  const points = recent.map((r, i) => {
    const x = P + (i / Math.max(1, recent.length - 1)) * (W - P * 2);
    const y = H - P - ((Number(r.marginPct) - min) / span) * (H - P * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <>
      <Card title="Margin history" eyebrow="per customer">
        <div className="row" style={{ alignItems: "center", gap: 10 }}>
          <label htmlFor="cost-margin-customer" className="mono-sm">Customer</label>
          <select
            id="cost-margin-customer"
            className="input"
            value={customerId}
            onChange={(ev) => setCustomerId(ev.target.value)}
            style={{ height: 28, minWidth: 280 }}
            disabled={customers.loading || !!customers.error}
          >
            <option value="">{customers.loading ? "Loading customers…" : "Select a customer…"}</option>
            {customerList.map((c) => <option key={c.id} value={c.id}>{c.customer_name || c.customer_key || c.id.slice(0, 8)}</option>)}
          </select>
        </div>

        {customers.error && (
          <Banner kind="bad" icon={Icon.alert} title="Failed to load customers">
            <span className="mono-sm">{String(customers.error.message || customers.error)}</span>
          </Banner>
        )}

        {history.loading && <div className="body" style={{ padding: 12 }}>Loading margin history…</div>}
        {history.error && (
          <Banner kind="bad" icon={Icon.alert} title="Margin history failed">
            <span className="mono-sm">{String(history.error.message || history.error)}</span>
          </Banner>
        )}

        {customerId && !history.loading && !history.error && (data.sample === 0 || !recent.length) && (
          <div className="body" style={{ padding: 12, color: "var(--ink-3)" }}>
            No price-composition history for this customer yet.
          </div>
        )}

        {recent.length > 0 && (
          <>
            <div className="divider" />
            <KPIRow cols={3}>
              <KPI lbl="Median margin" v={`${(Number(data.medianMarginPct) || 0).toFixed(1)}%`} d={`${data.sample || recent.length} orders`} />
              <KPI lbl="Low (P10-ish)" v={`${(Number(data.lowMarginPct) || 0).toFixed(1)}%`} d="worst observed" dKind={Number(data.lowMarginPct) < 10 ? "down" : ""} />
              <KPI lbl="High (P90-ish)" v={`${(Number(data.highMarginPct) || 0).toFixed(1)}%`} d="best observed" dKind="up" />
            </KPIRow>

            <div className="divider" />
            <div role="img" aria-label="Margin percent sparkline over recent orders" style={{ height: H, padding: "10px 0" }}>
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="none">
                <line x1="0" y1={H / 2} x2={W} y2={H / 2} stroke="var(--hairline-2)" strokeDasharray="3 3" />
                <polyline fill="none" stroke="var(--ink)" strokeWidth="2" points={points} />
                {recent.map((r, i) => {
                  const x = P + (i / Math.max(1, recent.length - 1)) * (W - P * 2);
                  const y = H - P - ((Number(r.marginPct) - min) / span) * (H - P * 2);
                  return <circle key={i} cx={x} cy={y} r={2.5} fill={Number(r.marginPct) < 10 ? "var(--rust)" : "var(--ink)"} />;
                })}
              </svg>
            </div>

            <div className="divider" />
            <table className="tbl">
              <thead><tr>
                <th scope="col">Order</th>
                <th scope="col" className="r">Margin %</th>
                <th scope="col" className="r">Selling ₹</th>
                <th scope="col" className="r">Landed ₹</th>
                <th scope="col">When</th>
              </tr></thead>
              <tbody>
                {data.recent && data.recent.map((r, i) => (
                  <tr key={r.orderId || i}>
                    <td className="mono-sm">{(r.orderId || "").slice(0, 8)}</td>
                    <td className="r mono">{(Number(r.marginPct) || 0).toFixed(1)}%</td>
                    <td className="r mono">{fmtINRShort(Number(r.selling) || 0)}</td>
                    <td className="r mono">{fmtINRShort(Number(r.landed) || 0)}</td>
                    <td className="mono-sm">{r.at ? ageLabel(r.at) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
};

const WiredCostMargin = () => {
  const [active, setActive] = useState("breakdown");
  return (
    <>
      <WSTitle
        eyebrow="Finance · Cost & Margin"
        title="Cost & margin"
        meta="breakdown · simulator · margin history"
      />
      <WSTabs
        tabs={COST_TABS}
        active={active}
        onChange={setActive}
      />
      <div className="ws-content">
        {active === "breakdown" && <CostBreakdown />}
        {active === "sim"       && <CostSimulator />}
        {active === "hist"      && <CostMarginHistory />}
      </div>
    </>
  );
};


export default WiredCostMargin;
