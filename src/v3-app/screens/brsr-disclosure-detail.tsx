// Read-only BRSR disclosure detail view. Bet 7.
//
// Two callers:
//
//   1. Supplier reviewing a locked submission ("audit pack" for
//      their own assurance firm).
//   2. Buyer reviewing a tier-2 supplier disclosure they have
//      accepted-consent on. The buyer-side fetch goes through the
//      same buyer dashboard query and the RLS policy on
//      supplier_disclosures permits the read.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const fmt = (n: number | null | undefined, d = 2) =>
  (n == null || !Number.isFinite(Number(n))) ? "—" : Number(n).toFixed(d);

const parseQuery = () => {
  const hash = window.location.hash || "";
  const q = hash.split("?")[1] || "";
  const params = new URLSearchParams(q);
  return {
    supplier: params.get("supplier") || "",
    fy: params.get("fy") || "",
  };
};

const BrsrDisclosureDetail: React.FC = () => {
  const q = parseQuery();
  const [data, setData] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });

  useEffect(() => {
    if (!q.supplier) return;
    Promise.resolve((ObaraBackend as any)?.brsr?.buyerDashboard?.(q.fy))
      .then((d: any) => {
        const row = (d?.suppliers || []).find((s: any) => s.supplier_tenant_id === q.supplier);
        setData({ data: row || null, loading: false, error: null });
      })
      .catch((err: any) => setData({ data: null, loading: false, error: err }));
  }, [q.supplier, q.fy]);

  const totals = useMemo(() => {
    const d = data.data?.disclosure;
    if (!d) return null;
    return {
      total: (Number(d.scope1_tco2e) || 0) + (Number(d.scope2_tco2e) || 0),
      revenue: Number(d.revenue_inr) || 0,
    };
  }, [data.data]);

  if (!q.supplier) {
    return (
      <>
        <WSTitle eyebrow="Sustainability" title="BRSR Disclosure" />
        <div className="ws-content">
          <Banner kind="warn" icon={Icon.alert} title="Missing supplier in URL">
            Open this screen from the buyer dashboard via the supplier table link.
          </Banner>
        </div>
      </>
    );
  }
  if (data.loading) {
    return (
      <>
        <WSTitle eyebrow="Sustainability" title="BRSR Disclosure" meta="loading" />
        <div className="ws-content">
          <Card><div className="body">Loading disclosure…</div></Card>
        </div>
      </>
    );
  }
  if (!data.data) {
    return (
      <>
        <WSTitle eyebrow="Sustainability" title="BRSR Disclosure" meta={q.supplier.slice(0, 8) + "…"} />
        <div className="ws-content">
          <Banner kind="info" icon={Icon.info} title="No data accessible">
            This supplier either has no disclosure on file for the chosen FY or has not accepted
            your relationship invite. Check Relationships and the invite status.
          </Banner>
        </div>
      </>
    );
  }

  const d = data.data.disclosure;
  return (
    <>
      <WSTitle eyebrow="Sustainability · Supplier" title={q.supplier.slice(0, 8) + "…"}
        meta={data.data.period?.fiscal_year || q.fy || "—"} />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Scope 1" v={fmt(d?.scope1_tco2e, 2)} d="tCO2e direct" />
          <KPI lbl="Scope 2" v={fmt(d?.scope2_tco2e, 2)} d="tCO2e electricity" />
          <KPI lbl="Total" v={fmt(totals?.total, 2)} d="tCO2e Scope 1+2" />
          <KPI lbl="Share of buyer spend" v={fmt(data.data.share_pct, 1) + "%"}
            d={data.data.is_material ? "material" : "below 2%"} />
        </KPIRow>
        <Card title="Period">
          <KV rows={[
            ["Fiscal year", data.data.period?.fiscal_year || "—"],
            ["Status", data.data.period?.status || "—"],
            ["Submitted", data.data.period?.submitted_at
              ? new Date(data.data.period.submitted_at).toLocaleString("en-IN") : "—"],
            ["Locked", data.data.period?.locked_at
              ? new Date(data.data.period.locked_at).toLocaleString("en-IN") : "—"],
            ["Assured", data.data.period?.assured_at
              ? new Date(data.data.period.assured_at).toLocaleString("en-IN") : "—"],
          ]} />
        </Card>
        <Card title="BRSR Core Annexure I values">
          {!d ? (
            <div className="body" style={{ color: "var(--ink-3)" }}>
              No disclosure body. The supplier may have not submitted yet.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Attribute</th><th>Parameter</th><th>Unit</th><th className="r">Value</th>
              </tr></thead>
              <tbody>
                {[
                  ["1 GHG",           "Scope 1 emissions",                "tCO2e", d.scope1_tco2e],
                  ["1 GHG",           "Scope 2 emissions",                "tCO2e", d.scope2_tco2e],
                  ["2 Water",         "Withdrawal",                       "kL",    d.water_withdrawal_kl],
                  ["2 Water",         "Consumption",                      "kL",    d.water_consumption_kl],
                  ["2 Water",         "Discharge",                        "kL",    d.water_discharge_kl],
                  ["3 Energy",        "Electricity",                      "kWh",   d.electricity_kwh],
                  ["3 Energy",        "Renewable share",                  "%",     d.electricity_renewable_pct],
                  ["4 Circularity",   "Waste generated",                  "MT",    d.waste_total_mt],
                  ["4 Circularity",   "Waste recycled",                   "MT",    d.waste_recycled_mt],
                  ["5 Gender",        "Women in workforce",               "%",     d.women_pct_workforce],
                  ["5 Gender",        "POSH complaints",                  "count", d.posh_complaints],
                  ["6 Inclusion",     "MSME input share",                 "%",     d.msme_input_pct],
                  ["6 Inclusion",     "India sourcing share",             "%",     d.india_sourcing_pct],
                  ["8 Openness",      "Related-party purchases",          "%",     d.related_party_purchases_pct],
                  ["9 Wages",         "Wages to women",                   "Rs",    d.wages_paid_to_women_inr],
                  ["9 Wages",         "Wages in tier 3-6 cities",         "Rs",    d.wages_paid_smaller_towns_inr],
                ].map(([attr, param, unit, val]: any, i) => (
                  <tr key={i}>
                    <td className="mono-sm">{attr}</td>
                    <td>{param}</td>
                    <td className="mono-sm">{unit}</td>
                    <td className="r mono">{fmt(val, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <div className="row gap-sm" style={{ marginTop: 16 }}>
          <Btn kind="ghost" onClick={() => (window.location.hash = "#/brsr-buyer-dashboard")}>back to dashboard</Btn>
        </div>
      </div>
    </>
  );
};

export default BrsrDisclosureDetail;
