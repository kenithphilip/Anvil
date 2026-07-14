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

const monSevChip = (s: string) => (
  <Chip k={s === "critical" || s === "bad" ? "bad" : s === "warn" ? "warn" : "ghost"}>{s}</Chip>
);

// Persistent, SLA-tracked exceptions raised by the logistics monitor cron
// (distinct from the on-demand scan above). Config-driven; enabled + tuned in
// Admin -> Logistics monitor. Supports ack (captures first response) + resolve.
const MonitoredExceptions: React.FC = () => {
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const r: any = await ObaraBackend?.logistics?.listExceptions?.({ status: "open" });
      setRows(r?.exceptions || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const act = async (id: string, kind: "ack" | "resolve") => {
    setBusy(id);
    try {
      if (kind === "ack") await ObaraBackend?.logistics?.ackException?.(id);
      else await ObaraBackend?.logistics?.resolveException?.(id, "");
      await load();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(null); }
  };

  const now = Date.now();
  const breachedCount = rows.filter((e) => e.breached_at).length;

  return (
    <Card title="Monitored exceptions" eyebrow={`persistent · SLA-tracked${breachedCount ? ` · ${breachedCount} breached` : ""}`}
          right={<Btn icon kind="ghost" sm onClick={load} title="Refresh">{Icon.cycle}</Btn>} flush style={{ marginTop: 12 }}>
      {err && <Banner kind="bad" title="Monitor">{err}</Banner>}
      {loading ? (
        <div className="body" style={{ padding: 16 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="body" style={{ padding: 18, textAlign: "center", color: "var(--ink-3)" }}>
          No open monitored exceptions. Enable + configure the monitor in Admin → Logistics monitor.
        </div>
      ) : (
        <table className="tbl">
          <thead><tr>
            <th>Reference</th><th>Kind</th><th>Severity</th><th>SLA</th><th className="r">Elapsed</th><th>Detail</th><th />
          </tr></thead>
          <tbody>
            {rows.map((e) => {
              const breached = !!e.breached_at;
              const overdueSoon = e.sla_target_at && !breached && new Date(e.sla_target_at).getTime() < now;
              return (
                <tr key={e.id}>
                  <td className="mono">{e.ref_label || (e.object_id ? String(e.object_id).slice(0, 8) : "—")}</td>
                  <td><Chip k="info">{e.rule_kind}</Chip></td>
                  <td>{monSevChip(e.severity)}</td>
                  <td>{breached ? <Chip k="bad">breached</Chip> : e.sla_target_at ? <Chip k={overdueSoon ? "warn" : "ghost"}>{new Date(e.sla_target_at).toLocaleDateString()}</Chip> : "—"}</td>
                  <td className="r mono">{e.detail?.elapsed_days != null ? e.detail.elapsed_days + "d" : "—"}</td>
                  <td className="mono-sm" style={{ color: "var(--ink-2)" }}>{e.detail?.detail_text || ""}</td>
                  <td>
                    <Btn sm kind="ghost" disabled={busy === e.id} onClick={() => act(e.id, "ack")}>ack</Btn>{" "}
                    <Btn sm disabled={busy === e.id} onClick={() => act(e.id, "resolve")}>resolve</Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
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

  return (
    <>
      <WSTitle
        eyebrow="Procurement · Delays"
        title="Delays"
        meta={`${total} flagged · ${high} high-severity`}
        right={<Btn icon kind="ghost" sm onClick={load} title="Refresh">{Icon.cycle}</Btn>}
      />
      <KPIRow cols={5}>
        <KPI lbl="Total flagged"    v={String(total)} live={total > 0} />
        <KPI lbl="High severity"    v={String(high)} dKind={high > 0 ? "bad" : "ghost"} />
        <KPI lbl="Foreign POs"      v={String(byKind.po_source_country || 0)} />
        <KPI lbl="Work orders"      v={String(byKind.work_order_manufacturing || 0)} />
        <KPI lbl="Orphan ETAs"      v={String(byKind.ready_date_orphan || 0)} />
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
                <th>Detail</th>
                <th />
              </tr></thead>
              <tbody>
                {filtered.map((f) => (
                  <tr key={f.kind + ":" + f.ref_id}>
                    <td className="mono">
                      <a href={refRoute(f)} className="link">{f.ref_label}</a>
                    </td>
                    <td><Chip k="info">{KIND_LABEL[f.kind]}</Chip></td>
                    <td>{f.supplier || "—"}{f.country ? <span className="mono-sm" style={{ color: "var(--ink-3)", marginLeft: 6 }}>· {f.country}</span> : null}</td>
                    <td>{SEV_CHIP(f.severity)}</td>
                    <td className="r mono">{f.elapsed_days != null ? f.elapsed_days + "d" : "—"}</td>
                    <td className="r mono">{f.sla_days ? f.sla_days + "d" : "—"}</td>
                    <td className="mono-sm" style={{ color: "var(--ink-2)" }}>{f.detail}</td>
                    <td>
                      <Btn sm onClick={() => { window.location.hash = refRoute(f).slice(1); }}>open</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <MonitoredExceptions />
      </div>
    </>
  );
};

export default Delays;
