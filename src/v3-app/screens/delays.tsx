// Delays screen.
//
// Operator-facing view of the foolproof delay detector. Polls
// /api/delays/scan and groups flags by kind into 5 WSTabs:
//
//   po-source    Foreign-supplier POs sent but not acknowledged
//   po-local     Domestic-supplier POs sent but not acknowledged
//   work-order   Internal work orders approved but not dispatched
//   no-eta       POs acknowledged but no ready_date / ETA recorded
//   orphan       ETA on file but no shipment plan references it
//
// Each row has clickthrough to the relevant source PO / internal SO
// workspace so the operator can act. Top KPIs show totals + by-kind
// breakdown. Severity chip uses the same pattern as the anomaly
// screen (red=high, amber=medium, ghost=low).

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

interface DelayFlag {
  kind: "po_source_country" | "po_local_supplier" | "work_order_manufacturing" | "ready_date_missing" | "ready_date_orphan";
  severity: "high" | "medium" | "low";
  ref_type: "source_po" | "internal_so";
  ref_id: string;
  ref_label: string;
  supplier: string | null;
  country: string | null;
  customer_id: string | null;
  order_id: string | null;
  elapsed_days: number | null;
  sla_days: number;
  detail: string;
  // Predictor enhancements (additive; older API responses ignore these).
  delay_probability?: number;     // 0..1
  eta_predicted?: string | null;  // ISO date
  criticality?: number;           // 1.0 standalone, 1.25 / 1.5 with deps
  risk_score?: number;            // 0..100
  sla_source?: "default" | "learned";
  supplier_samples?: number;
}

const TABS: Array<{ id: string; label: string; kind: DelayFlag["kind"][] }> = [
  { id: "all",       label: "All",            kind: [] },
  { id: "po-source", label: "Foreign POs",    kind: ["po_source_country"] },
  { id: "po-local",  label: "Local POs",      kind: ["po_local_supplier"] },
  { id: "work",      label: "Work orders",    kind: ["work_order_manufacturing"] },
  { id: "no-eta",    label: "No ready date",  kind: ["ready_date_missing"] },
  { id: "orphan",    label: "Orphan ETAs",    kind: ["ready_date_orphan"] },
];

const SEV_CHIP = (s: DelayFlag["severity"]) => (
  <Chip k={s === "high" ? "bad" : s === "medium" ? "warn" : "ghost"}>{s}</Chip>
);

const KIND_LABEL: Record<DelayFlag["kind"], string> = {
  po_source_country: "Foreign supplier PO",
  po_local_supplier: "Local supplier PO",
  work_order_manufacturing: "Work order",
  ready_date_missing: "Ready date missing",
  ready_date_orphan: "Orphan ETA",
};

const refRoute = (f: DelayFlag): string => {
  if (f.ref_type === "source_po") return "#/spo?id=" + f.ref_id;
  if (f.ref_type === "internal_so") return "#/internal?id=" + f.ref_id;
  return "#/home";
};

const Delays: React.FC = () => {
  const [tab, setTab] = useState("all");
  const [data, setData] = useState<{ delays: DelayFlag[]; summary: { total: number; byKind: Record<string, number> } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const cfg = (ObaraBackend?.getConfig?.() || {}) as { url?: string };
      const session = (ObaraBackend?.getSession?.() || null) as { access_token?: string } | null;
      if (!cfg.url) throw new Error("Backend URL not configured");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (session?.access_token) headers["Authorization"] = "Bearer " + session.access_token;
      const resp = await fetch(cfg.url.replace(/\/+$/, "") + "/api/delays/scan", {
        method: "POST",
        headers,
        body: "{}",
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const json = await resp.json();
      setData(json);
    } catch (e: any) {
      setErr(e?.message || "Could not scan delays");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!data) return [];
    const t = TABS.find((x) => x.id === tab);
    if (!t || t.id === "all") return data.delays;
    return data.delays.filter((d) => t.kind.includes(d.kind));
  }, [data, tab]);

  const tabs = TABS.map((t) => {
    if (t.id === "all") return { id: t.id, label: t.label, count: data?.summary?.total || 0 };
    const count = t.kind.reduce((acc, k) => acc + (data?.summary?.byKind?.[k] || 0), 0);
    return { id: t.id, label: t.label, count };
  });

  if (loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Procurement · Delays" title="Delays" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Scanning…</div></Card></div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Procurement · Delays" title="Delays" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not scan delays"
                  action={<Btn sm onClick={load}>Retry</Btn>}>
            <span className="mono-sm">{err}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const total = data?.summary?.total || 0;
  const byKind = data?.summary?.byKind || {};
  const high = (data?.delays || []).filter((d) => d.severity === "high").length;
  const risks = (data?.delays || []).map((d) => Number(d.risk_score || 0)).filter((n) => Number.isFinite(n));
  const maxRisk = risks.length ? Math.max(...risks) : 0;
  const critical = (data?.delays || []).filter((d) => (d.criticality || 1) >= 1.25).length;

  return (
    <>
      <WSTitle
        eyebrow="Procurement · Delays"
        title="Delays"
        meta={`${total} flagged · ${high} high-severity`}
        right={<Btn icon kind="ghost" sm onClick={load} title="Refresh">{Icon.cycle}</Btn>}
      />
      <KPIRow cols={6}>
        <KPI lbl="Total flagged"    v={String(total)} live={total > 0} />
        <KPI lbl="High severity"    v={String(high)} dKind={high > 0 ? "bad" : "ghost"} />
        <KPI lbl="Max risk score"   v={String(maxRisk)} dKind={maxRisk >= 75 ? "bad" : maxRisk >= 50 ? "warn" : "ghost"} />
        <KPI lbl="Critical-path"    v={String(critical)} dKind={critical > 0 ? "warn" : "ghost"} />
        <KPI lbl="Foreign POs"      v={String(byKind.po_source_country || 0)} />
        <KPI lbl="Work orders"      v={String(byKind.work_order_manufacturing || 0)} />
      </KPIRow>
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />
      <div className="ws-content">
        <Card flush>
          {filtered.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              No delays in this bucket. The line is clean.
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Reference</th>
                <th>Kind</th>
                <th>Supplier</th>
                <th>Severity</th>
                <th className="r">Elapsed</th>
                <th className="r">SLA</th>
                <th className="r" title="Logistic delay probability">Risk</th>
                <th>Predicted ETA</th>
                <th>Detail</th>
                <th />
              </tr></thead>
              <tbody>
                {filtered.map((f) => {
                  const score = Math.round(Number(f.risk_score || 0));
                  const scoreKind = score >= 75 ? "bad" : score >= 50 ? "warn" : "ghost";
                  const slaSrc = f.sla_source === "learned" ? " (learned)" : "";
                  const isCritical = (f.criticality || 1) >= 1.25;
                  return (
                    <tr key={f.kind + ":" + f.ref_id}>
                      <td className="mono">
                        <a href={refRoute(f)} className="link">{f.ref_label}</a>
                        {isCritical ? (
                          <span style={{ marginLeft: 6 }}>
                            <Chip k="warn">critical-path</Chip>
                          </span>
                        ) : null}
                      </td>
                      <td><Chip k="info">{KIND_LABEL[f.kind]}</Chip></td>
                      <td>
                        {f.supplier || "—"}
                        {f.country ? <span className="mono-sm" style={{ color: "var(--ink-3)", marginLeft: 6 }}>· {f.country}</span> : null}
                        {f.supplier_samples ? <span className="mono-sm" style={{ color: "var(--ink-3)", marginLeft: 6 }} title="Historical samples used to learn this supplier's SLA">· n={f.supplier_samples}</span> : null}
                      </td>
                      <td>{SEV_CHIP(f.severity)}</td>
                      <td className="r mono">{f.elapsed_days != null ? f.elapsed_days + "d" : "—"}</td>
                      <td className="r mono" title={f.sla_source === "learned" ? "Learned from supplier history" : "Static default"}>
                        {f.sla_days ? f.sla_days + "d" + slaSrc : "—"}
                      </td>
                      <td className="r">
                        <Chip k={scoreKind}>{score}</Chip>
                      </td>
                      <td className="mono-sm">{f.eta_predicted || "—"}</td>
                      <td className="mono-sm" style={{ color: "var(--ink-2)" }}>{f.detail}</td>
                      <td>
                        <Btn sm onClick={() => { window.location.hash = refRoute(f).slice(1); }}>open</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
};

export default Delays;
