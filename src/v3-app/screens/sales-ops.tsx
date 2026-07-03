import React from "react";
import { fmtINRShort, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Sales Operations cockpit (manager view)
//
// One screen for the sales-ops head: probability-weighted pipeline +
// near-term outlook (forecast), funnel health / velocity / aging (the
// analytics_funnel_daily snapshots), and win/loss + leakage (the
// previously-unwired /api/analytics/winloss). Read-only rollups.
// ============================================================

const sum = (arr: any[], k: string) => (arr || []).reduce((a, x) => a + (Number(x?.[k]) || 0), 0);
const prettyStage = (s: string) => String(s || "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const pctOrDash = (v: any) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(0) + "%");

const SalesOpsCockpit = () => {
  const funnel = useFetch(async () => { const r: any = await AnvilBackend?.analytics?.funnel?.(); return r || null; }, []);
  const winloss = useFetch(async () => { const r: any = await AnvilBackend?.analytics?.winloss?.(); return r || null; }, []);
  const forecast = useFetch(async () => {
    const r: any = await (AnvilBackend?.forecast?.get ? AnvilBackend.forecast.get() : null);
    return r || null;
  }, []);

  const loading = funnel.loading || winloss.loading || forecast.loading;
  const reloadAll = () => { funnel.reload(); winloss.reload(); forecast.reload(); };

  const fd: any = funnel.data || {};
  const wl: any = winloss.data || {};
  const fc: any = forecast.data || {};
  const stages: any[] = Array.isArray(fd.stages) ? fd.stages : [];
  const buckets: any[] = Array.isArray(fc.buckets) ? fc.buckets : [];

  const weightedPipeline = buckets.length ? sum(buckets, "weighted_amount_inr") : (fd.totals?.weighted_value_in_stage || 0);
  const openPipeline = buckets.length ? sum(buckets, "open_amount_inr") : (fd.totals?.value_in_stage || 0);
  const next30 = sum(buckets, "next_30_days_amount_inr");
  const wlk: any = wl.kpis || {};
  const openOpps = fd.totals?.count_in_stage || stages.reduce((a, s) => a + (s.count_in_stage || 0), 0);

  const anyError = funnel.error || winloss.error || forecast.error;

  return (
    <>
      <WSTitle
        eyebrow="Sales · Operations"
        title="Sales Ops Cockpit"
        meta={fd.as_of ? `funnel as of ${fd.as_of}` : "pipeline · funnel · win-loss"}
        right={<Btn icon kind="ghost" sm onClick={reloadAll} title="Refresh">{Icon.cycle}</Btn>}
      />

      <div className="ws-content">
        {anyError && (
          <Banner kind="warn" icon={Icon.alert} title="Some panels could not load"
                  action={<Btn sm onClick={reloadAll}>Retry</Btn>}>
            <span className="mono-sm">Run /api/analytics/refresh + the inventory cron to populate snapshots.</span>
          </Banner>
        )}

        <KPIRow cols={4}>
          <KPI lbl="Weighted pipeline" v={fmtINRShort(weightedPipeline)} d="probability-adjusted" live={weightedPipeline > 0} />
          <KPI lbl="Next 30 days" v={fmtINRShort(next30)} d="weighted close" />
          <KPI lbl="Won (90d)" v={fmtINRShort(wlk.won_value || 0)} d={`${wlk.won || 0} orders`} dKind={wlk.won_value ? "up" : ""} />
          <KPI lbl="Win rate" v={pctOrDash(wlk.win_rate)} d="last 90 days" dKind={wlk.win_rate != null ? (wlk.win_rate >= 50 ? "up" : "down") : ""} />
        </KPIRow>

        {/* Funnel health / velocity / aging */}
        <Card title="Funnel" eyebrow={`${openOpps} open opportunities${loading ? " · loading…" : ""}`} flush>
          {stages.length === 0 ? (
            <div className="body" style={{ padding: 18, textAlign: "center", color: "var(--ink-3)" }}>
              No funnel snapshots yet. Opportunity stage events accrue daily; the snapshot builds on the nightly cron.
            </div>
          ) : (
            <table className="tbl" style={{ fontSize: 12 }}>
              <thead><tr>
                <th>Stage</th><th className="r">In stage</th><th className="r">Value</th>
                <th className="r">Weighted</th><th className="r">Median age (d)</th>
                <th className="r">Entered</th><th className="r">Exited</th>
              </tr></thead>
              <tbody>
                {stages.map((s) => (
                  <tr key={s.stage}>
                    <td>{prettyStage(s.stage)}</td>
                    <td className="r mono">{s.count_in_stage ?? 0}</td>
                    <td className="r mono-sm">{fmtINRShort(s.value_in_stage || 0)}</td>
                    <td className="r mono-sm">{fmtINRShort(s.weighted_value_in_stage || 0)}</td>
                    <td className="r mono-sm">{s.median_age_days != null ? Math.round(s.median_age_days) : "—"}</td>
                    <td className="r mono-sm">{s.entered ?? 0}</td>
                    <td className="r mono-sm">{s.exited ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* Revenue leakage — lost reasons */}
          <Card title="Lost reasons" eyebrow="last 90 days" style={{ flex: "1 1 320px", minWidth: 280 }} flush>
            {(wl.lost_reasons || []).length === 0 ? (
              <div className="body" style={{ padding: 16, color: "var(--ink-3)" }}>No losses recorded.</div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr><th>Reason</th><th className="r">Count</th></tr></thead>
                <tbody>
                  {(wl.lost_reasons || []).slice(0, 8).map((r: any, i: number) => (
                    <tr key={i}><td>{r.label || r.reason_id || "—"}</td><td className="r mono">{r.count}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Rep efficiency */}
          <Card title="Rep efficiency" eyebrow="win rate · response" style={{ flex: "1 1 360px", minWidth: 320 }} flush>
            {(wl.rep_efficiency || []).length === 0 ? (
              <div className="body" style={{ padding: 16, color: "var(--ink-3)" }}>No rep activity yet.</div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr><th>Rep</th><th className="r">Won</th><th className="r">Win rate</th><th className="r">Resp (min)</th></tr></thead>
                <tbody>
                  {(wl.rep_efficiency || []).slice(0, 8).map((r: any, i: number) => (
                    <tr key={i}>
                      <td className="mono-sm">{r.name || (r.rep_id ? String(r.rep_id).slice(0, 8) : "—")}</td>
                      <td className="r mono">{r.quotes_won ?? 0}</td>
                      <td className="r"><Chip k={(r.win_rate ?? 0) >= 50 ? "good" : "warn"}>{pctOrDash(r.win_rate)}</Chip></td>
                      <td className="r mono-sm">{r.median_response_minutes ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
};

export default SalesOpsCockpit;
