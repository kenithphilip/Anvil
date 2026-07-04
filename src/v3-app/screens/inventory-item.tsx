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
import { AnvilBackend } from "../lib/api";

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
  // Bet 3: per-SKU conformal-diagnostics payload (residuals, latest
  // interval, empirical coverage). Loaded lazily; null until the
  // user opens the Coverage tab so the page-load cost stays small.
  const [conformal, setConformal] = useState<{ data: any; loading: boolean }>({ data: null, loading: false });
  const [savingCoverage, setSavingCoverage] = useState(false);

  useEffect(() => {
    if (!partNo) return;
    let cancelled = false;
    Promise.allSettled([
      Promise.resolve(AnvilBackend?.inventory?.positions?.({ part_no: partNo })),
      Promise.resolve(AnvilBackend?.inventory?.forecasts?.({ part_no: partNo, horizon_weeks: 12 })),
      Promise.resolve(AnvilBackend?.inventory?.plans?.list?.({ part_no: partNo })),
      Promise.resolve(AnvilBackend?.inventory?.exceptions?.list?.({ status: "all" })),
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

  // Load conformal diagnostics when the Coverage tab opens.
  useEffect(() => {
    if (tab !== "coverage" || !partNo) return;
    let cancelled = false;
    setConformal({ data: null, loading: true });
    Promise.resolve((AnvilBackend as any)?.inventory?.conformalDiagnostics?.(partNo))
      .then((d: any) => { if (!cancelled) setConformal({ data: d, loading: false }); })
      .catch(() => { if (!cancelled) setConformal({ data: null, loading: false }); });
    return () => { cancelled = true; };
  }, [tab, partNo]);

  const saveCoverage = async (coverage: number | null, methodOverride: string | null) => {
    if (!partNo) return;
    setSavingCoverage(true);
    try {
      await (AnvilBackend as any)?.inventory?.setConformalOverride?.(partNo, {
        conformal_coverage: coverage,
        conformal_method_override: methodOverride,
      });
      window.notifySuccess?.("Coverage saved", "Takes effect on the next planning cron run.");
      // Refresh.
      const d = await (AnvilBackend as any)?.inventory?.conformalDiagnostics?.(partNo);
      setConformal({ data: d, loading: false });
    } catch (err: any) {
      window.notifyError?.("Save failed", err?.message || String(err));
    } finally {
      setSavingCoverage(false);
    }
  };

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
            { id: "coverage",   label: "Coverage" },
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
                  Math.max(
                    Number(r.forecast_total) || 0,
                    Number(r.quantile_90) || 0,
                    Number(r.interval_hi) || 0,
                  )
                )
              );
              // Bet 3: CP interval band, drawn behind the stacked
              // areas. Only renders when interval_lo/hi are present
              // on every row (i.e. the cron has run with CP on).
              const cpVisible = rows.every((r) => r.interval_lo != null && r.interval_hi != null);
              const cpHiLine = rows.map((r, i) => x(i) + "," + y(Number(r.interval_hi) || 0)).join(" ");
              const cpLoLine = rows.map((r, i) => x(i) + "," + y(Number(r.interval_lo) || 0)).join(" ");
              const cpBand = cpVisible
                ? rows.map((r, i) => x(i) + "," + y(Number(r.interval_hi) || 0)).join(" ")
                  + " "
                  + rows.slice().reverse().map((r, idx) => {
                      const realIdx = rows.length - 1 - idx;
                      return x(realIdx) + "," + y(Number(r.interval_lo) || 0);
                    }).join(" ")
                : null;
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
                    {cpVisible ? " · Shaded band: CP interval (Bet 3)" : ""}
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
                    {/* Bet 3: CP band drawn first so it sits behind everything else. */}
                    {cpBand && (
                      <polygon points={cpBand} fill="var(--ink-3, #888)" fillOpacity="0.12" stroke="none" />
                    )}
                    {/* Baseline area = full total */}
                    <polygon points={polyArea(stackTotal)} fill="var(--accent-2, #c8ff2b)" fillOpacity="0.18" />
                    {/* Pipeline area = committed + pipeline */}
                    <polygon points={polyArea(stackCP)} fill="url(#f-hatch)" />
                    {/* Committed area solid on top */}
                    <polygon points={polyArea(stackC)} fill="var(--accent-2, #c8ff2b)" fillOpacity="0.85" />
                    {/* q90 dashed line */}
                    <polyline points={q90Line} fill="none" stroke="var(--ink-3, #888)" strokeWidth="1.5" strokeDasharray="4 3" />
                    {cpVisible && (
                      <>
                        <polyline points={cpHiLine} fill="none" stroke="var(--ink-3, #888)" strokeWidth="1" strokeDasharray="2 4" />
                        <polyline points={cpLoLine} fill="none" stroke="var(--ink-3, #888)" strokeWidth="1" strokeDasharray="2 4" />
                      </>
                    )}
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
        {tab === "coverage" && (
          conformal.loading ? (
            <Card><div className="body">Loading conformal diagnostics…</div></Card>
          ) : !conformal.data?.conformal_enabled ? (
            <Banner kind="info" icon={Icon.info} title="Conformal-prediction safety stock is off">
              <span className="mono-sm">
                Enable it tenant-wide in settings to start writing per-SKU CP intervals. The
                weekly planning cron will fill in residuals and the band over the next 12 weeks.
              </span>
            </Banner>
          ) : (
            <>
              <Card>
                <div className="h2" style={{ marginBottom: 8 }}>Coverage target</div>
                <KV rows={[
                  ["Effective coverage", (Number(conformal.data.effective_coverage_target || 0) * 100).toFixed(0) + "%"],
                  ["Tenant default", (Number(conformal.data.tenant_default_coverage || 0) * 100).toFixed(0) + "%"],
                  ["Per-SKU override", conformal.data.item?.conformal_coverage != null
                    ? (Number(conformal.data.item.conformal_coverage) * 100).toFixed(0) + "%"
                    : "—"],
                  ["Method override", conformal.data.item?.conformal_method_override || "—"],
                  ["Residuals (own)", String((conformal.data.residuals || []).length)],
                ]} />
                <div className="row gap-sm" style={{ marginTop: 8 }}>
                  <select
                    className="mono"
                    aria-label="Per-SKU coverage target"
                    value={conformal.data.item?.conformal_coverage != null
                      ? String(conformal.data.item.conformal_coverage)
                      : "tenant"}
                    onChange={async (ev) => {
                      const val = ev.target.value;
                      if (val === "tenant") {
                        await saveCoverage(null, conformal.data.item?.conformal_method_override || null);
                      } else {
                        await saveCoverage(Number(val), conformal.data.item?.conformal_method_override || null);
                      }
                    }}
                    disabled={savingCoverage}
                  >
                    <option value="tenant">Tenant default</option>
                    <option value="0.85">85%</option>
                    <option value="0.9">90%</option>
                    <option value="0.95">95%</option>
                    <option value="0.99">99%</option>
                  </select>
                  <select
                    className="mono"
                    aria-label="Method override"
                    value={conformal.data.item?.conformal_method_override || "auto"}
                    onChange={async (ev) => {
                      const val = ev.target.value;
                      await saveCoverage(
                        conformal.data.item?.conformal_coverage != null
                          ? Number(conformal.data.item.conformal_coverage) : null,
                        val === "auto" ? null : val,
                      );
                    }}
                    disabled={savingCoverage}
                  >
                    <option value="auto">Auto (by residual count)</option>
                    <option value="nexcp">Force NEXCP</option>
                    <option value="split_cp">Force Split CP</option>
                  </select>
                  {savingCoverage && <Chip k="info">saving…</Chip>}
                </div>
              </Card>
              <Card title="Latest forecasts with intervals">
                {(conformal.data.latest_forecast || []).length === 0 ? (
                  <div className="body" style={{ color: "var(--ink-3)" }}>
                    No forecast rows with CP fields yet. Run a planning cron with conformal enabled.
                  </div>
                ) : (
                  <table className="tbl">
                    <thead><tr>
                      <th>Week</th>
                      <th>Method</th>
                      <th className="r">Residuals</th>
                      <th className="r">Coverage</th>
                      <th className="r">Lo</th>
                      <th className="r">q50</th>
                      <th className="r">Hi</th>
                    </tr></thead>
                    <tbody>
                      {(conformal.data.latest_forecast || []).map((r: any) => (
                        <tr key={r.week_start}>
                          <td className="mono-sm">{r.week_start}</td>
                          <td className="mono-sm">
                            <Chip k={r.conformal_method === "nexcp" ? "good"
                              : r.conformal_method === "split_cp" ? "info"
                              : r.conformal_method === "pooled_cold_start" ? "warn"
                              : "info"}>
                              {r.conformal_method || "—"}
                            </Chip>
                          </td>
                          <td className="r mono">{r.calibration_residuals_count ?? "—"}</td>
                          <td className="r mono">{r.coverage_target != null
                            ? (Number(r.coverage_target) * 100).toFixed(0) + "%" : "—"}</td>
                          <td className="r mono">{r.interval_lo != null ? Number(r.interval_lo).toFixed(1) : "—"}</td>
                          <td className="r mono">{r.quantile_50 != null ? Number(r.quantile_50).toFixed(1) : "—"}</td>
                          <td className="r mono">{r.interval_hi != null ? Number(r.interval_hi).toFixed(1) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              {conformal.data.empirical_coverage?.coverage != null && (
                <Card title="Empirical coverage" eyebrow="last 13 weeks">
                  <KPIRow>
                    <KPI lbl="Realised" v={((conformal.data.empirical_coverage.coverage || 0) * 100).toFixed(1) + "%"}
                         d={"n=" + conformal.data.empirical_coverage.n} />
                    <KPI lbl="Target" v={((conformal.data.effective_coverage_target || 0) * 100).toFixed(0) + "%"}
                         d="this SKU" />
                  </KPIRow>
                </Card>
              )}
            </>
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
