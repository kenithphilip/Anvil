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
  const ops = useFetch(async () => { const r: any = await AnvilBackend?.analytics?.opsKpis?.(); return r || null; }, []);
  const [granularity, setGranularity] = React.useState<"day" | "week" | "month">("week");
  const pipeline = useFetch(async () => { const r: any = await AnvilBackend?.analytics?.pipeline?.({ granularity }); return r || null; }, [granularity]);

  const loading = funnel.loading || winloss.loading || forecast.loading || ops.loading || pipeline.loading;
  const reloadAll = () => { funnel.reload(); winloss.reload(); forecast.reload(); ops.reload(); pipeline.reload(); };

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

  const ok: any = ops.data || {};
  const aging: any = ok.ar_aging || {};
  const cyc: any = ok.cycle_time || {};
  const agingBuckets: any[] = Array.isArray(aging.buckets) ? aging.buckets : [];
  const repRev: any[] = Array.isArray(ok.revenue_by_rep) ? ok.revenue_by_rep : [];
  const dOrDash = (s: any) => (s && s.median != null ? `${s.median}d` : "—");

  const pl: any = pipeline.data || {};
  const plTotals: any = pl.totals || {};
  const plCohort: any = pl.cohort || {};
  const plTrend: any[] = Array.isArray(pl.trend) ? pl.trend : [];
  const plStalled: any[] = Array.isArray(pl.stalled) ? pl.stalled : [];

  const anyError = funnel.error || winloss.error || forecast.error || ops.error || pipeline.error;

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

        {/* ---- P2: Pipeline conversion — quotes sent → orders processed → sales completed (paid) ---- */}
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 2, marginBottom: 8 }}>
          <div className="mono-sm" style={{ color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Pipeline conversion{pl.scoped_to_self ? " · your accounts" : ""}
          </div>
          <div className="row" style={{ gap: 4 }}>
            {(["day", "week", "month"] as const).map((gr) => (
              <Btn key={gr} sm kind={granularity === gr ? "primary" : "ghost"} onClick={() => setGranularity(gr)}>{gr}</Btn>
            ))}
          </div>
        </div>

        <KPIRow cols={4}>
          <KPI lbl="Quotes sent" v={String(plTotals.quotes_sent?.count || 0)} d={`${fmtINRShort(plTotals.quotes_sent?.value || 0)} · ${plTotals.distinct_opportunities_quoted || 0} deals`} live={(plTotals.quotes_sent?.count || 0) > 0} />
          <KPI lbl="Orders processed" v={String(plTotals.orders_processed?.count || 0)} d="approved SOs" />
          <KPI lbl="Sales completed" v={String(plTotals.paid?.count || 0)} d={`${fmtINRShort(plTotals.paid?.value || 0)} paid`} dKind={(plTotals.paid?.value || 0) > 0 ? "up" : ""} />
          <KPI lbl="Quote → won" v={pctOrDash(plCohort.quote_to_won_pct)} d={`${plCohort.won || 0}/${plCohort.quoted || 0} deals · win ${pctOrDash(plCohort.win_rate_pct)}`} dKind={plCohort.quote_to_won_pct != null ? (plCohort.quote_to_won_pct >= 25 ? "up" : "down") : ""} />
        </KPIRow>

        <div className="row" style={{ gap: 12, marginTop: 12, marginBottom: 4, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Card title="Conversion trend" eyebrow={`quotes → orders → paid · by ${pl.granularity || granularity}`} style={{ flex: "2 1 460px", minWidth: 340 }} flush>
            {plTrend.length === 0 ? (
              <div className="body" style={{ padding: 16, color: "var(--ink-3)" }}>
                No quotes sent in this window. <span className="mono-sm">(Needs migration 203 applied + quotes tracked on opportunities.)</span>
              </div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr>
                  <th>Period</th><th className="r">Quotes</th><th className="r">Q value</th>
                  <th className="r">Orders</th><th className="r">Paid</th><th className="r">Paid value</th>
                </tr></thead>
                <tbody>
                  {plTrend.map((p: any) => (
                    <tr key={p.period}>
                      <td className="mono-sm">{p.period}</td>
                      <td className="r mono">{p.quotes_sent_count}</td>
                      <td className="r mono-sm">{fmtINRShort(p.quotes_sent_value)}</td>
                      <td className="r mono">{p.orders_processed_count}</td>
                      <td className="r mono">{p.paid_count}</td>
                      <td className="r mono-sm">{fmtINRShort(p.paid_value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Stalled quotes" eyebrow="sent · still open · no order yet" style={{ flex: "1 1 300px", minWidth: 280 }} flush>
            {plStalled.length === 0 ? (
              <div className="body" style={{ padding: 16, color: "var(--ink-3)" }}>No stalled quotes.</div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr><th>Opportunity</th><th className="r">Age</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {plStalled.slice(0, 10).map((s: any) => (
                    <tr key={s.opportunity_id}>
                      <td className="mono-sm">{String(s.opportunity_id).slice(0, 8)}{s.revisions > 1 ? ` · v${s.revisions}` : ""}</td>
                      <td className="r"><Chip k={s.age_days > 60 ? "bad" : s.age_days > 30 ? "warn" : "good"}>{s.age_days}d</Chip></td>
                      <td className="r mono-sm">{fmtINRShort(s.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

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

        {/* Cash & cycle-time — the KPI/SLA substrate (live-computed) */}
        <KPIRow cols={4}>
          <KPI lbl="Outstanding AR" v={fmtINRShort(aging.total_outstanding || 0)} d="unpaid invoices" live={(aging.total_outstanding || 0) > 0} />
          <KPI lbl="Overdue AR" v={fmtINRShort(aging.overdue_outstanding || 0)} d={`${aging.overdue_count || 0} invoices · ${pctOrDash(aging.overdue_rate)}`} dKind={(aging.overdue_rate || 0) > 0 ? "down" : ""} />
          <KPI lbl="Quote → accept" v={dOrDash(cyc.sent_to_accepted)} d={`sent→accepted · p90 ${cyc.sent_to_accepted?.p90 ?? "—"}d`} />
          <KPI lbl="Order → approve" v={dOrDash(cyc.order_to_approved)} d={`created→approved · p90 ${cyc.order_to_approved?.p90 ?? "—"}d`} />
        </KPIRow>

        <div className="row" style={{ gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
          {/* AR aging buckets */}
          <Card title="AR aging" eyebrow="outstanding by days past due" style={{ flex: "1 1 320px", minWidth: 280 }} flush>
            {agingBuckets.length === 0 || (aging.total_outstanding || 0) === 0 ? (
              <div className="body" style={{ padding: 16, color: "var(--ink-3)" }}>No outstanding AR.</div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr><th>Bucket</th><th className="r">Invoices</th><th className="r">Outstanding</th></tr></thead>
                <tbody>
                  {agingBuckets.map((b: any, i: number) => (
                    <tr key={i}>
                      <td><Chip k={b.label === "current" ? "good" : b.label === "90+" ? "bad" : "warn"}>{b.label === "current" ? "Current" : b.label + " days"}</Chip></td>
                      <td className="r mono">{b.count}</td>
                      <td className="r mono">{fmtINRShort(b.outstanding)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          {/* Revenue by rep (accepted quotes) */}
          <Card title="Revenue by rep" eyebrow="accepted quotes · this window" style={{ flex: "1 1 360px", minWidth: 320 }} flush>
            {repRev.length === 0 ? (
              <div className="body" style={{ padding: 16, color: "var(--ink-3)" }}>No accepted quotes in window.</div>
            ) : (
              <table className="tbl" style={{ fontSize: 12 }}>
                <thead><tr><th>Rep</th><th className="r">Accepted</th><th className="r">Value</th></tr></thead>
                <tbody>
                  {repRev.slice(0, 8).map((r: any, i: number) => (
                    <tr key={i}>
                      <td className="mono-sm">{r.rep_id === "unassigned" ? "Unassigned" : String(r.rep_id).slice(0, 8)}</td>
                      <td className="r mono">{r.count}</td>
                      <td className="r mono">{fmtINRShort(r.accepted_value)}</td>
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
