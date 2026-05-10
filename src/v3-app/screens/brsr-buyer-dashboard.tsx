// BRSR buyer-side dashboard. Bet 7.
//
// Reads /api/brsr/buyer/dashboard and renders the tier-2 supplier
// coverage view. Headline: how much of the buyer's spend is on
// suppliers reporting through Anvil, what their attributed Scope
// 3 contribution is, and whether the 75% materiality threshold
// per SEBI Annexure I has been reached.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const fmt = (n: number | null | undefined, d = 2) =>
  (n == null || !Number.isFinite(Number(n))) ? "—" : Number(n).toFixed(d);

const currentFy = (() => {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return "FY" + y + "-" + String((y + 1) % 100).padStart(2, "0");
})();

const BrsrBuyerDashboardScreen: React.FC = () => {
  const [fy, setFy] = useState(currentFy);
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState<{ data: any; loading: boolean; error: any }>({ data: null, loading: true, error: null });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ supplier_tenant_id: "", buyer_purchase_share_pct: "" });
  const [submitting, setSubmitting] = useState(false);

  const reload = () => {
    setData((s) => ({ ...s, loading: true }));
    Promise.resolve((ObaraBackend as any)?.brsr?.buyerDashboard?.(fy))
      .then((d: any) => setData({ data: d, loading: false, error: null }))
      .catch((err: any) => setData({ data: null, loading: false, error: err }));
  };

  useEffect(reload, [fy]);

  const exportCsv = () => {
    const url = (ObaraBackend as any)?.brsr?.exportUrl?.(fy, "csv");
    if (url) (window as any).open(url, "_blank");
  };

  const exportXbrl = () => {
    const url = (ObaraBackend as any)?.brsr?.exportUrl?.(fy, "xbrl");
    if (url) (window as any).open(url, "_blank");
  };

  const sendInvite = async () => {
    if (!invite.supplier_tenant_id) return;
    setSubmitting(true);
    try {
      await (ObaraBackend as any)?.brsr?.invite?.({
        supplier_tenant_id: invite.supplier_tenant_id,
        buyer_purchase_share_pct: invite.buyer_purchase_share_pct
          ? Number(invite.buyer_purchase_share_pct) : null,
        relationship_type: "upstream",
      });
      (window as any).notifySuccess?.("Invite sent", "Supplier must accept before the link is active.");
      setInviteOpen(false);
      setInvite({ supplier_tenant_id: "", buyer_purchase_share_pct: "" });
      reload();
    } catch (err: any) {
      (window as any).notifyError?.("Invite failed", err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const kpis = useMemo(() => {
    if (!data.data) return null;
    return {
      suppliers: data.data.suppliers?.length || 0,
      material: data.data.coverage?.material_count || 0,
      reporting: data.data.coverage?.reporting_count || 0,
      sharePct: data.data.coverage?.total_share_pct || 0,
      attributed: data.data.rollup?.total_attributed_tco2e || 0,
      reached75: data.data.coverage?.reached_75_pct || false,
    };
  }, [data.data]);

  if (data.loading) {
    return (
      <>
        <WSTitle eyebrow="Sustainability" title="BRSR Value Chain" meta="loading" />
        <div className="ws-content">
          <Card><div className="body">Loading buyer dashboard…</div></Card>
        </div>
      </>
    );
  }

  return (
    <>
      <WSTitle eyebrow="Sustainability" title="BRSR Value Chain" meta={fy} />
      <div className="ws-content">
        {kpis && (
          <KPIRow>
            <KPI lbl="Suppliers connected" v={String(kpis.suppliers)} d={kpis.material + " material"} />
            <KPI lbl="Reporting" v={String(kpis.reporting)} d="submitted / locked / assured" />
            <KPI lbl="Coverage share" v={fmt(kpis.sharePct, 1) + "%"}
                 d={kpis.reached75 ? "75% threshold reached" : "below 75%"}
                 dKind={kpis.reached75 ? "up" : "down"} />
            <KPI lbl="Attributed Scope 3" v={fmt(kpis.attributed, 2)} d="tCO2e spend-weighted" />
          </KPIRow>
        )}
        {!kpis?.reached75 && (kpis?.suppliers || 0) > 0 && (
          <Banner kind="warn" icon={Icon.alert} title="Coverage below 75%">
            <span className="mono-sm">
              SEBI BRSR Core requires value-chain disclosure for partners that cumulatively cover
              75% of your purchases. You are at {fmt(kpis.sharePct, 1)}%. Invite more tier-2
              suppliers under Relationships to reach the threshold before the FY assurance deadline.
            </span>
          </Banner>
        )}
        <Card>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label className="mono-sm">FY
              <select value={fy} onChange={(e) => setFy(e.target.value)} className="mono"
                style={{ marginLeft: 8, padding: "4px 6px" }}>
                {[0, -1, -2].map((delta) => {
                  const now = new Date();
                  const y = (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) + delta;
                  const v = "FY" + y + "-" + String((y + 1) % 100).padStart(2, "0");
                  return <option key={v} value={v}>{v}</option>;
                })}
              </select>
            </label>
            <Btn sm kind="primary" onClick={() => setInviteOpen(true)}>Invite supplier</Btn>
            <Btn sm kind="ghost" onClick={exportCsv}>Export BRSR Core CSV</Btn>
            <Btn sm kind="ghost" onClick={exportXbrl}>Export XBRL stub</Btn>
          </div>
          <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 6 }}>
            CSV is mandatory P0 and matches SEBI Annexure I column order. The XBRL export uses a
            placeholder namespace until SEBI publishes the final BRSR Core taxonomy.
          </div>
        </Card>
        <WSTabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "material", label: "Material only" },
            { id: "below", label: "Below 2%" },
          ]}
          active={tab}
          onChange={setTab}
        />
        <Card flush>
          {(!data.data?.suppliers || data.data.suppliers.length === 0) ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No suppliers linked yet. Use <b>Invite supplier</b> above to send a value-chain
              consent request. Once they accept, their BRSR Core disclosure rolls up here.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Supplier tenant</th>
                <th className="r">Share %</th>
                <th>Material</th>
                <th>Period</th>
                <th>Status</th>
                <th className="r">Scope 1</th>
                <th className="r">Scope 2</th>
                <th>Last updated</th>
              </tr></thead>
              <tbody>
                {(data.data?.suppliers || []).filter((s: any) => {
                  if (tab === "material") return s.is_material;
                  if (tab === "below") return !s.is_material;
                  return true;
                }).map((s: any) => (
                  <tr key={s.supplier_tenant_id}>
                    <td>
                      <a className="link" href={"#/brsr-disclosure-detail?supplier=" + encodeURIComponent(s.supplier_tenant_id) + "&fy=" + encodeURIComponent(fy)}>
                        {s.supplier_tenant_id.slice(0, 8)}…
                      </a>
                    </td>
                    <td className="r mono">{fmt(s.share_pct, 1)}</td>
                    <td><Chip k={s.is_material ? "good" : "info"}>{s.is_material ? "yes" : "no"}</Chip></td>
                    <td className="mono-sm">{s.period?.fiscal_year || "—"}</td>
                    <td>
                      {s.period?.status
                        ? <Chip k={s.period.status === "assured" ? "good"
                                : s.period.status === "locked" ? "good"
                                : s.period.status === "submitted" ? "info"
                                : "warn"}>{s.period.status}</Chip>
                        : <Chip k="warn">no period</Chip>}
                    </td>
                    <td className="r mono">{fmt(s.disclosure?.scope1_tco2e, 2)}</td>
                    <td className="r mono">{fmt(s.disclosure?.scope2_tco2e, 2)}</td>
                    <td className="mono-sm">
                      {s.disclosure?.updated_at
                        ? new Date(s.disclosure.updated_at).toLocaleDateString("en-IN")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {inviteOpen && (
          <div className="modal-backdrop" onClick={() => setInviteOpen(false)}>
            <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 480 }}>
              <div className="modal-h">
                <span className="ti">Invite supplier to value chain</span>
                <Btn icon kind="ghost" sm onClick={() => setInviteOpen(false)} aria-label="Close">{Icon.close}</Btn>
              </div>
              <div className="modal-body" style={{ display: "grid", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm">Supplier tenant ID (UUID)</span>
                  <input type="text" className="mono"
                    value={invite.supplier_tenant_id}
                    onChange={(e) => setInvite((p) => ({ ...p, supplier_tenant_id: e.target.value }))}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    style={{ padding: "6px 8px", border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
                  />
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm">Share of your purchases (%)</span>
                  <input type="number" className="mono" min="0" max="100" step="0.01"
                    value={invite.buyer_purchase_share_pct}
                    onChange={(e) => setInvite((p) => ({ ...p, buyer_purchase_share_pct: e.target.value }))}
                    placeholder="2.5"
                    style={{ padding: "6px 8px", border: "1px solid var(--hairline-2)", background: "transparent", color: "inherit", borderRadius: 4 }}
                  />
                </label>
                <Banner kind="info" icon={Icon.info} title="2% materiality threshold">
                  <span className="mono-sm">
                    SEBI Annexure I requires reporting only for suppliers that account for at
                    least 2% of your purchases by value, capped at the 75% cumulative top-spend.
                  </span>
                </Banner>
              </div>
              <div className="modal-f">
                <Btn kind="ghost" onClick={() => setInviteOpen(false)}>Cancel</Btn>
                <Btn kind="primary" disabled={submitting || !invite.supplier_tenant_id} onClick={sendInvite}>
                  {submitting ? "Sending…" : "Send invite"}
                </Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default BrsrBuyerDashboardScreen;
