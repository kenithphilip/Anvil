// Inventory Planning Dashboard (S1).
//
// 12-week shortage timeline + KPI strip + top exceptions feed.
// Reads /api/inventory/positions, /api/inventory/forecasts,
// /api/inventory/plans, /api/inventory/exceptions in parallel and
// renders the same primitives the rest of the app uses.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle, Stream } from "../lib/primitives";
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
    } catch (err: any) {
      window.notifyError?.("Replan failed", err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

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
        <WSTabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "by-item", label: "By item" },
            { id: "exceptions", label: "Exceptions" },
            { id: "calibration", label: "Calibration" },
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
          <Card>
            <div className="h2" style={{ marginBottom: 8 }}>Forecast calibration</div>
            <div className="body" style={{ color: "var(--ink-3)" }}>
              Mean WAPE 8w: <b>{fmtPct(kpis.meanWape)}</b>. Per-item WAPE breakdown
              and stage-probability calibration land in Phase 3.5.
            </div>
          </Card>
        )}
        <div className="row gap-sm" style={{ marginTop: 16 }}>
          <Btn kind="primary" disabled={busy} onClick={onReplan}>
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
    </>
  );
};

export default InventoryPlanningScreen;
