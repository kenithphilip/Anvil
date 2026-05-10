// Inventory Planning Dashboard (S1).
//
// 12-week shortage timeline + KPI strip + top exceptions feed.
// Reads /api/inventory/positions, /api/inventory/forecasts,
// /api/inventory/plans, /api/inventory/exceptions in parallel and
// renders the same primitives the rest of the app uses.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTabs, WSTitle, Stream } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const SEV_TONE: Record<string, "good" | "info" | "warn" | "bad"> = {
  info: "info", warn: "warn", bad: "bad", critical: "bad",
};

const fmtPct = (n: number | null | undefined) =>
  (n == null || !Number.isFinite(n)) ? "n/a" : (Math.round(n * 1000) / 10).toFixed(1) + "%";

const InventoryPlanningScreen: React.FC = () => {
  const [tab, setTab] = useState("overview");
  const [positions, setPositions] = useState<{ data: any[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [plans, setPlans]         = useState<{ data: any[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [exceptions, setExceptions] = useState<{ data: any[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [forecasts, setForecasts] = useState<{ data: any[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [busy, setBusy] = useState(false);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      Promise.resolve(ObaraBackend?.inventory?.positions?.()),
      Promise.resolve(ObaraBackend?.inventory?.plans?.list?.({ status: "draft" })),
      Promise.resolve(ObaraBackend?.inventory?.exceptions?.list?.({ status: "open" })),
      Promise.resolve(ObaraBackend?.inventory?.forecasts?.({ horizon_weeks: 12 })),
    ]).then(([p, pl, ex, fc]) => {
      if (cancelled) return;
      setPositions({ data: p.status === "fulfilled" ? (p.value?.positions || []) : [], loading: false, error: p.status === "rejected" ? p.reason : null });
      setPlans({ data: pl.status === "fulfilled" ? (pl.value?.plans || []) : [], loading: false, error: pl.status === "rejected" ? pl.reason : null });
      setExceptions({ data: ex.status === "fulfilled" ? (ex.value?.exceptions || []) : [], loading: false, error: ex.status === "rejected" ? ex.reason : null });
      setForecasts({ data: fc.status === "fulfilled" ? (fc.value?.forecasts || []) : [], loading: false, error: fc.status === "rejected" ? fc.reason : null });
    });
    return () => { cancelled = true; };
  }, [bump]);

  const kpis = useMemo(() => {
    const itemsAtRisk = positions.data.filter((p) => Number(p.net_available_qty || 0) < Number(p.reorder_point || 0)).length;
    const plansPending = plans.data.length;
    const openExceptions = exceptions.data.length;
    const critical = exceptions.data.filter((e) => e.severity === "critical" || e.severity === "bad").length;
    const wapeValues = forecasts.data.map((f) => Number(f.wape_8w)).filter((v) => Number.isFinite(v));
    const meanWape = wapeValues.length ? wapeValues.reduce((s, v) => s + v, 0) / wapeValues.length : null;
    return { itemsAtRisk, plansPending, openExceptions, critical, meanWape };
  }, [positions.data, plans.data, exceptions.data, forecasts.data]);

  const onReplan = async () => {
    setBusy(true);
    try {
      await (ObaraBackend as any)?.inventory?.replan?.();
      window.notifySuccess?.("Replan complete", "New forecasts and plans persisted.");
      setBump((n) => n + 1);
      setReplanConfirm(false);
    } catch (err: any) {
      window.notifyError?.("Replan failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  // Phase 3.5 calibration data + forecast-runs history.
  const [calibration, setCalibration] = useState<{ data: any; loading: boolean }>({ data: null, loading: true });
  const [forecastRuns, setForecastRuns] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [replanConfirm, setReplanConfirm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve((ObaraBackend as any)?.inventory?.calibration?.())
      .then((d: any) => { if (!cancelled) setCalibration({ data: d, loading: false }); })
      .catch(() => { if (!cancelled) setCalibration({ data: null, loading: false }); });
    return () => { cancelled = true; };
  }, [bump]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve((ObaraBackend as any)?.inventory?.forecastRuns?.(20))
      .then((d: any) => { if (!cancelled) setForecastRuns({ data: d?.runs || [], loading: false }); })
      .catch(() => { if (!cancelled) setForecastRuns({ data: [], loading: false }); });
    return () => { cancelled = true; };
  }, [bump]);

  // Positions staleness: max(as_of) across positions.
  const positionsStaleness = React.useMemo(() => {
    const stamps: number[] = [];
    for (const p of positions.data || []) {
      const t = p.as_of || p.updated_at || p.last_synced_at;
      if (t) stamps.push(new Date(t).getTime());
    }
    if (!stamps.length) return null;
    const newest = Math.max(...stamps);
    const ageMin = Math.floor((Date.now() - newest) / 60_000);
    return { newestAt: new Date(newest).toISOString(), ageMin };
  }, [positions.data]);

  const onExceptionAck = async (id: string) => {
    try {
      await (ObaraBackend as any)?.inventory?.exceptions?.ack?.(id);
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Ack failed", err?.message || String(err));
    }
  };

  if (positions.loading || plans.loading || exceptions.loading) {
    return (
      <>
        <WSTitle eyebrow="Procurement" title="Inventory Planning" meta="loading" />
        <div className="ws-content">
          <Card><div className="body">Loading planning surface…</div></Card>
        </div>
      </>
    );
  }

  return (
    <>
      <WSTitle eyebrow="Procurement" title="Inventory Planning" meta="12-week horizon" />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Items at risk (12w)" v={String(kpis.itemsAtRisk)} d="below ROP" />
          <KPI lbl="Plans pending"       v={String(kpis.plansPending)} d="draft" />
          <KPI lbl="Open exceptions"     v={String(kpis.openExceptions)} d={kpis.critical + " critical"} dKind={kpis.critical > 0 ? "down" : ""} />
          <KPI lbl="Forecast WAPE (8w)"  v={fmtPct(kpis.meanWape)} d="mean across items" />
        </KPIRow>
        {positionsStaleness && positionsStaleness.ageMin > 60 && (
          <Banner kind="warn" icon={Icon.alert} title={`Positions data is ${positionsStaleness.ageMin > 1440 ? Math.floor(positionsStaleness.ageMin / 1440) + " day(s)" : Math.floor(positionsStaleness.ageMin / 60) + " hour(s)"} stale`}>
            <span className="mono-sm">
              Newest position snapshot: {new Date(positionsStaleness.newestAt).toLocaleString("en-IN")}.
              The /api/cron/inventory-positions cron runs every 30 minutes; if positions are
              older than that, the cron may be paused or your ERP staging tables aren't refreshing.
            </span>
          </Banner>
        )}
        <WSTabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "by-item", label: "By item" },
            { id: "exceptions", label: "Exceptions" },
            { id: "calibration", label: "Calibration" },
            { id: "forecast-history", label: "Forecast history" },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === "overview" && (
          <>
            <Card flush>
              <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
                <span className="h2">12-week shortage timeline</span>
                <span className="mono-sm" style={{ marginLeft: 12, color: "var(--ink-3)" }}>
                  {positions.data.length} planning-enabled items
                </span>
              </div>
              {positions.data.length === 0 ? (
                <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                  No planning-enabled items yet. Mark items in Item Master as planning_enabled to start.
                </div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Item</th>
                    <th className="r">On hand</th>
                    <th className="r">In transit</th>
                    <th className="r">Allocated</th>
                    <th className="r">Net avail</th>
                    <th className="r">ROP</th>
                    <th className="r">SS</th>
                    <th>Status</th>
                  </tr></thead>
                  <tbody>
                    {positions.data.map((p) => {
                      const net = Number(p.net_available_qty || 0);
                      const rop = Number(p.reorder_point || 0);
                      const ss = Number(p.safety_stock || 0);
                      const tone = net < ss ? "bad" : net < rop ? "warn" : "good";
                      const label = net < ss ? "stockout risk" : net < rop ? "below ROP" : "OK";
                      return (
                        <tr key={p.id}>
                          <td>
                            <a className="link" href={"#/inventory-item?part_no=" + encodeURIComponent(p.part_no)}>
                              {p.part_no}
                            </a>
                          </td>
                          <td className="r mono">{Number(p.on_hand_qty)}</td>
                          <td className="r mono">{Number(p.in_transit_qty)}</td>
                          <td className="r mono">{Number(p.allocated_qty)}</td>
                          <td className="r mono">{net}</td>
                          <td className="r mono">{rop}</td>
                          <td className="r mono">{ss}</td>
                          <td><Chip k={tone as any}>{label}</Chip></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Card>
            <Card>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span className="h2">Top exceptions</span>
                <Btn sm kind="ghost" onClick={() => (window.location.hash = "#/inventory-exceptions")}>
                  see all
                </Btn>
              </div>
              {exceptions.data.length === 0 ? (
                <div className="body" style={{ padding: 8, color: "var(--ink-3)" }}>
                  No open exceptions. The engine will surface stockout risk + supplier delays here.
                </div>
              ) : (
                <Stream
                  rows={exceptions.data.slice(0, 6).map((e) => ({
                    t: new Date(e.created_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
                    a: (e.severity || "info").toUpperCase().slice(0, 4),
                    m: `<b>${(e.exception_kind || "exception").replace(/_/g, " ")}</b>` +
                       ` · ${e.part_no || "—"}` +
                       ` · <span class="chip ${SEV_TONE[e.severity] || "info"}">${e.severity}</span>`,
                  }))}
                />
              )}
            </Card>
          </>
        )}
        {tab === "by-item" && (
          <Banner kind="info" icon={Icon.info} title="Per-item drilldown">
            Click any row in the Overview table to open the per-item planning view.
          </Banner>
        )}
        {tab === "exceptions" && (
          <Banner kind="info" icon={Icon.info} title="Exceptions feed">
            Full exceptions feed lives at <a className="link" href="#/inventory-exceptions">Stock Exceptions</a>.
          </Banner>
        )}
        {tab === "calibration" && (
          <>
            <Card>
              <div className="h2" style={{ marginBottom: 8 }}>Forecast calibration</div>
              <div className="body" style={{ color: "var(--ink-3)" }}>
                Mean WAPE 8w: <b>{fmtPct(kpis.meanWape)}</b>. Per-stage opportunity-conversion
                probabilities below feed the pipeline-demand calculation.
              </div>
            </Card>
            <Card title="Stage conversion probabilities" eyebrow="from /api/inventory/calibration">
              {calibration.loading ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>Loading calibration…</div>
              ) : !calibration.data ? (
                <div className="body" style={{ color: "var(--ink-3)" }}>No calibration data.</div>
              ) : (
                <table className="tbl">
                  <thead><tr>
                    <th>Stage</th>
                    <th className="r">Sample</th>
                    <th className="r">Won</th>
                    <th className="r">Conversion %</th>
                    <th className="r">Used in pipeline</th>
                  </tr></thead>
                  <tbody>
                    {Object.entries(calibration.data.stage_probabilities || {}).map(([stage, info]: any) => (
                      <tr key={stage}>
                        <td className="mono">{stage}</td>
                        <td className="r mono">{info?.sample_count ?? "—"}</td>
                        <td className="r mono">{info?.won_count ?? "—"}</td>
                        <td className="r mono">{info?.conversion_rate != null ? (Number(info.conversion_rate) * 100).toFixed(1) + "%" : "—"}</td>
                        <td className="r mono">{info?.used_probability != null ? (Number(info.used_probability) * 100).toFixed(1) + "%" : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </>
        )}
        {tab === "forecast-history" && (
          <Card flush>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--hairline-2)" }}>
              <span className="h2">Forecast generation runs</span>
              <span className="mono-sm" style={{ marginLeft: 12, color: "var(--ink-3)" }}>
                {forecastRuns.data.length} recent run{forecastRuns.data.length === 1 ? "" : "s"}
              </span>
            </div>
            {forecastRuns.loading ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>Loading runs…</div>
            ) : forecastRuns.data.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No forecast runs recorded. The weekly cron writes runs here on Mondays at 02:00 IST.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Status</th>
                  <th className="r">Items</th>
                  <th>Best models</th>
                  <th>Notes</th>
                </tr></thead>
                <tbody>
                  {forecastRuns.data.map((r: any) => (
                    <tr key={r.id}>
                      <td className="mono-sm">{r.started_at ? new Date(r.started_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td className="mono-sm">{r.finished_at ? new Date(r.finished_at).toLocaleString("en-IN", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}</td>
                      <td><Chip k={r.status === "ok" ? "good" : r.status === "partial_failure" ? "warn" : "bad"}>{r.status}</Chip></td>
                      <td className="r mono">{r.items_count ?? "—"}</td>
                      <td className="mono-sm" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.models_evaluated ? Object.keys(r.models_evaluated).join(", ") : "—"}
                      </td>
                      <td className="mono-sm">{r.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
        <div className="row gap-sm" style={{ marginTop: 16 }}>
          <Btn kind="primary" disabled={busy} onClick={() => setReplanConfirm(true)}>
            {busy ? "running…" : "Run replan now"}
          </Btn>
          <Btn kind="ghost" onClick={() => (window.location.hash = "#/inventory-plans")}>
            see planned POs
          </Btn>
          <Btn kind="ghost" onClick={() => (window.location.hash = "#/inventory-suppliers")}>
            suppliers
          </Btn>
        </div>
      </div>

      {/* Replan confirmation modal: replan rebuilds every active
          item's forecast + plan from scratch. Operators should
          understand the impact before triggering. */}
      {replanConfirm && (
        <div className="modal-backdrop" onClick={() => setReplanConfirm(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 540 }}>
            <div className="modal-h">
              <span className="ti">Confirm replan</span>
              <Btn icon kind="ghost" sm onClick={() => setReplanConfirm(false)} aria-label="Close" title="Close (Esc)">{Icon.close}</Btn>
            </div>
            <div className="modal-body" style={{ display: "grid", gap: 10 }}>
              <div className="body">
                Replan rebuilds every active item's <b>demand_forecasts</b> from the latest demand
                signal (committed + pipeline + baseline) and recreates draft replenishment plans.
                The weekly cron does this automatically on Mondays at 02:00 IST.
              </div>
              <Banner kind="warn" icon={Icon.alert} title="What gets touched">
                <span className="mono-sm">
                  · Forecast horizon: 12 weeks per item · Plans: existing DRAFT plans replaced;
                  APPROVED / RELEASED plans stay · Estimated runtime: 30-90s for &lt; 200 items
                </span>
              </Banner>
              <KV rows={[
                ["Items at risk before replan", String(kpis.itemsAtRisk)],
                ["Open exceptions", String(kpis.openExceptions)],
                ["Mean WAPE 8w", fmtPct(kpis.meanWape)],
              ]} />
            </div>
            <div className="modal-f">
              <Btn kind="ghost" onClick={() => setReplanConfirm(false)}>Cancel</Btn>
              <Btn kind="primary" disabled={busy} onClick={onReplan}>{busy ? "Running…" : "Run replan"}</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default InventoryPlanningScreen;
