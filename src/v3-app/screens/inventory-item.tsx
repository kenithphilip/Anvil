// Per-item drilldown (S4).
//
// Reads /api/inventory/positions and /api/inventory/forecasts for a
// single part_no (from the URL hash query), and renders a stacked
// view: KPI strip (on-hand, in-transit, allocated, net, ROP, SS),
// forecast curve as a simple SVG, position history, and the open
// plans + exceptions for that item.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const ItemDrilldown: React.FC = () => {
  const partNo = (() => {
    const hash = window.location.hash || "";
    const q = hash.split("?")[1];
    return new URLSearchParams(q || "").get("part_no") || "";
  })();
  const [tab, setTab] = useState("position");
  const [positions, setPositions] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [forecasts, setForecasts] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [plans, setPlans] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [exceptions, setExceptions] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });

  useEffect(() => {
    if (!partNo) return;
    let cancelled = false;
    Promise.allSettled([
      Promise.resolve(ObaraBackend?.inventory?.positions?.({ part_no: partNo })),
      Promise.resolve(ObaraBackend?.inventory?.forecasts?.({ part_no: partNo, horizon_weeks: 12 })),
      Promise.resolve(ObaraBackend?.inventory?.plans?.list?.({ part_no: partNo })),
      Promise.resolve(ObaraBackend?.inventory?.exceptions?.list?.({ status: "all" })),
    ]).then(([p, f, pl, ex]) => {
      if (cancelled) return;
      setPositions({ data: p.status === "fulfilled" ? (p.value?.positions || []) : [], loading: false });
      setForecasts({ data: f.status === "fulfilled" ? (f.value?.forecasts || []) : [], loading: false });
      setPlans({ data: pl.status === "fulfilled" ? (pl.value?.plans || []) : [], loading: false });
      const exData = ex.status === "fulfilled" ? (ex.value?.exceptions || []) : [];
      setExceptions({ data: exData.filter((e: any) => e.part_no === partNo), loading: false });
    });
    return () => { cancelled = true; };
  }, [partNo]);

  const latest = useMemo(() => positions.data.find((p) => p.source === "union") || positions.data[0] || null, [positions.data]);

  if (!partNo) {
    return (
      <>
        <WSTitle eyebrow="Procurement" title="Inventory Item" />
        <div className="ws-content">
          <Banner kind="warn" icon={Icon.alert} title="No part_no in URL">
            Open this screen via a link from the planning dashboard, e.g.
            <span className="mono"> #/inventory-item?part_no=ATD-STD-1</span>.
          </Banner>
        </div>
      </>
    );
  }

  return (
    <>
      <WSTitle eyebrow="Procurement · Item" title={partNo} meta={latest ? "as of " + latest.as_of : "loading"} />
      <div className="ws-content">
        {latest ? (
          <KPIRow>
            <KPI lbl="On hand"     v={String(Number(latest.on_hand_qty || 0))} d="union source" />
            <KPI lbl="In transit"  v={String(Number(latest.in_transit_qty || 0))} d="open POs" />
            <KPI lbl="Allocated"   v={String(Number(latest.allocated_qty || 0))} d="reserved" />
            <KPI lbl="Net avail"   v={String(Number(latest.net_available_qty || 0))} d="generated" />
            <KPI lbl="ROP"         v={latest.reorder_point != null ? String(Number(latest.reorder_point)) : "—"} d="reorder point" />
            <KPI lbl="SS"          v={latest.safety_stock != null ? String(Number(latest.safety_stock)) : "—"} d="safety stock" />
          </KPIRow>
        ) : (
          <Card><div className="body">Loading positions…</div></Card>
        )}
        <WSTabs
          tabs={[
            { id: "position",   label: "Position",   count: positions.data.length },
            { id: "forecast",   label: "Forecast",   count: forecasts.data.length },
            { id: "plans",      label: "Plans",      count: plans.data.length },
            { id: "exceptions", label: "Exceptions", count: exceptions.data.length },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === "position" && (
          <Card flush>
            <table className="tbl">
              <thead><tr>
                <th>As of</th>
                <th>Source</th>
                <th className="r">On hand</th>
                <th className="r">In transit</th>
                <th className="r">Allocated</th>
                <th className="r">Net avail</th>
              </tr></thead>
              <tbody>
                {positions.data.map((p) => (
                  <tr key={p.id}>
                    <td className="mono-sm">{p.as_of}</td>
                    <td><Chip k={p.source === "union" ? "good" : "info"}>{p.source}</Chip></td>
                    <td className="r mono">{Number(p.on_hand_qty)}</td>
                    <td className="r mono">{Number(p.in_transit_qty)}</td>
                    <td className="r mono">{Number(p.allocated_qty)}</td>
                    <td className="r mono">{Number(p.net_available_qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        {tab === "forecast" && (
          <>
            {forecasts.data.length > 0 && (() => {
              // Phase 3.5: simple stacked-area SVG chart, doc 7.5.
              // Solid (committed) + hatched (pipeline) + light
              // (baseline) areas; q90 dashed line on top.
              const W = 720, H = 200, PAD_L = 36, PAD_R = 12, PAD_T = 16, PAD_B = 22;
              const innerW = W - PAD_L - PAD_R;
              const innerH = H - PAD_T - PAD_B;
              const rows = forecasts.data.slice().sort((a, b) =>
                a.week_start < b.week_start ? -1 : 1
              );
              const n = rows.length;
              const max = Math.max(
                1,
                ...rows.map((r) =>
                  Math.max(Number(r.forecast_total) || 0, Number(r.quantile_90) || 0)
                )
              );
              const x = (i: number) => PAD_L + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
              const y = (v: number) => PAD_T + innerH - (Math.max(0, v) / max) * innerH;
              // Cumulative stacks: committed -> +pipeline -> +baseline.
              const stackC = rows.map((r) => Number(r.forecast_committed) || 0);
              const stackCP = rows.map((r, i) =>
                stackC[i] + (Number(r.forecast_pipeline) || 0)
              );
              const stackTotal = rows.map((r) => Number(r.forecast_total) || 0);
              const polyArea = (heights: number[]) => {
                const top = heights.map((v, i) => x(i) + "," + y(v)).join(" ");
                const bottom = heights.slice().reverse().map(
                  (_, idx) => x(heights.length - 1 - idx) + "," + y(0)
                ).join(" ");
                return top + " " + bottom;
              };
              const q90Line = rows.map((r, i) =>
                x(i) + "," + y(Number(r.quantile_90) || 0)
              ).join(" ");
              return (
                <Card>
                  <div className="h2" style={{ marginBottom: 6 }}>12-week forecast</div>
                  <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 6 }}>
                    Solid: committed · Hatched: pipeline · Light: baseline · Dashed: q90
                  </div>
                  <svg width="100%" viewBox={"0 0 " + W + " " + H} role="img" aria-label="Forecast stacked-area chart">
                    <defs>
                      <pattern id="f-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent-2, #c8ff2b)" strokeWidth="2" />
                      </pattern>
                    </defs>
                    {/* Y-axis grid (5 lines). */}
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                      <line key={f}
                        x1={PAD_L} x2={W - PAD_R}
                        y1={y(f * max)} y2={y(f * max)}
                        stroke="var(--hairline-2, rgba(255,255,255,0.06))"
                        strokeWidth="1"
                      />
                    ))}
                    {/* Baseline area = full total */}
                    <polygon points={polyArea(stackTotal)} fill="var(--accent-2, #c8ff2b)" fillOpacity="0.18" />
                    {/* Pipeline area = committed + pipeline */}
                    <polygon points={polyArea(stackCP)} fill="url(#f-hatch)" />
                    {/* Committed area solid on top */}
                    <polygon points={polyArea(stackC)} fill="var(--accent-2, #c8ff2b)" fillOpacity="0.85" />
                    {/* q90 dashed line */}
                    <polyline points={q90Line} fill="none" stroke="var(--ink-3, #888)" strokeWidth="1.5" strokeDasharray="4 3" />
                    {/* X-axis week labels (every 2 weeks) */}
                    {rows.map((r, i) => (i % 2 === 0) && (
                      <text key={r.id} x={x(i)} y={H - 6}
                        fontSize="9" textAnchor="middle"
                        fill="var(--ink-3, #888)">
                        {String(r.week_start).slice(5)}
                      </text>
                    ))}
                  </svg>
                </Card>
              );
            })()}
            <Card flush>
              <table className="tbl">
                <thead><tr>
                  <th>Week</th>
                  <th className="r">Committed</th>
                  <th className="r">Pipeline</th>
                  <th className="r">Baseline</th>
                  <th className="r">Total</th>
                  <th className="r">q90</th>
                  <th>Model</th>
                </tr></thead>
                <tbody>
                  {forecasts.data.map((f) => (
                    <tr key={f.id}>
                      <td className="mono-sm">{f.week_start}</td>
                      <td className="r mono">{Number(f.forecast_committed)}</td>
                      <td className="r mono">{Number(f.forecast_pipeline)}</td>
                      <td className="r mono">{Number(f.forecast_baseline)}</td>
                      <td className="r mono"><b>{Number(f.forecast_total)}</b></td>
                      <td className="r mono">{f.quantile_90 != null ? Number(f.quantile_90).toFixed(1) : "—"}</td>
                      <td className="mono-sm">{f.model_name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}
        {tab === "plans" && (
          plans.data.length === 0 ? (
            <Banner kind="info" icon={Icon.info} title="No plans">
              No procurement plans have been emitted for this item.
            </Banner>
          ) : (
            <Card flush>
              <table className="tbl">
                <thead><tr>
                  <th>For week</th>
                  <th className="r">Qty</th>
                  <th>Order date</th>
                  <th>ETA</th>
                  <th>Status</th>
                </tr></thead>
                <tbody>
                  {plans.data.map((p) => (
                    <tr key={p.id}>
                      <td className="mono-sm">{p.for_week}</td>
                      <td className="r mono">{Number(p.recommended_qty)}</td>
                      <td className="mono-sm">{p.recommended_order_date}</td>
                      <td className="mono-sm">{p.expected_arrival_date}</td>
                      <td><Chip k="info">{p.status}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        )}
        {tab === "exceptions" && (
          exceptions.data.length === 0 ? (
            <Banner kind="good" icon={Icon.check} title="Clean">No exceptions for this item.</Banner>
          ) : (
            <Card flush>
              <table className="tbl">
                <thead><tr><th>When</th><th>Severity</th><th>Kind</th><th>Status</th></tr></thead>
                <tbody>
                  {exceptions.data.map((e) => (
                    <tr key={e.id}>
                      <td className="mono-sm">{new Date(e.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                      <td><Chip k={e.severity === "critical" || e.severity === "bad" ? "bad" : (e.severity === "warn" ? "warn" : "info")}>{e.severity}</Chip></td>
                      <td>{e.exception_kind}</td>
                      <td><Chip k="info">{e.status}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )
        )}
        <div className="row gap-sm" style={{ marginTop: 16 }}>
          <Btn kind="ghost" onClick={() => (window.location.hash = "#/inventory-planning")}>back to planning</Btn>
          <Btn kind="ghost" onClick={() => (window.location.hash = "#/inventory-allocations?part_no=" + encodeURIComponent(partNo))}>
            allocations for this item
          </Btn>
        </div>
      </div>
    </>
  );
};

export default ItemDrilldown;
