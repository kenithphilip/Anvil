// Planned-PO Release Queue (S2).
//
// Lists procurement_plans with their rationale + approve / release
// / cancel actions. Each row's "Why?" expands to show the
// rationale jsonb the engine stamped, plus a button to call the
// Haiku-tier LLM for a plain-English explanation.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, KV, RailPanel, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

const STATUS_CHIP: Record<string, "good" | "info" | "warn" | "bad"> = {
  draft:      "info",
  approved:   "warn",
  released:   "good",
  received:   "good",
  cancelled:  "bad",
  superseded: "bad",
};

const InventoryPlansScreen: React.FC = () => {
  const [tab, setTab] = useState("draft");
  const [plans, setPlans] = useState<{ data: any[]; loading: boolean; error: any }>({ data: [], loading: true, error: null });
  const [selected, setSelected] = useState<any | null>(null);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const params = tab === "all" ? {} : { status: tab };
    Promise.resolve(ObaraBackend?.inventory?.plans?.list?.(params))
      .then((r: any) => { if (!cancelled) setPlans({ data: r?.plans || [], loading: false, error: null }); })
      .catch((err: any) => { if (!cancelled) setPlans({ data: [], loading: false, error: err }); });
    return () => { cancelled = true; };
  }, [tab, bump]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { draft: 0, approved: 0, released: 0, cancelled: 0 };
    for (const p of plans.data) map[p.status] = (map[p.status] || 0) + 1;
    return map;
  }, [plans.data]);

  const onApprove = async (id: string) => {
    setBusy("approve:" + id);
    try {
      await (ObaraBackend as any)?.inventory?.plans?.approve?.(id);
      window.notifySuccess?.("Plan approved", id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Approve failed", err?.message || String(err));
    } finally { setBusy(null); }
  };

  const onRelease = async (id: string) => {
    if (!confirm("Release this plan to a source PO? This creates a draft source_pos record.")) return;
    setBusy("release:" + id);
    try {
      const r = await (ObaraBackend as any)?.inventory?.plans?.release?.(id);
      window.notifySuccess?.("Released to source PO", r?.source_po_id?.slice(0, 8) || id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Release failed", err?.message || String(err));
    } finally { setBusy(null); }
  };

  const onCancel = async (id: string) => {
    const reason = prompt("Cancel reason (optional):") || null;
    setBusy("cancel:" + id);
    try {
      await (ObaraBackend as any)?.inventory?.plans?.cancel?.(id, reason);
      window.notifySuccess?.("Plan cancelled", id.slice(0, 8));
      setBump((n) => n + 1);
    } catch (err: any) {
      window.notifyError?.("Cancel failed", err?.message || String(err));
    } finally { setBusy(null); }
  };

  const onExplain = async (id: string) => {
    setExplanation("loading…");
    try {
      const r: any = await (ObaraBackend as any)?.inventory?.plans?.explain?.(id);
      setExplanation(r?.explanation || "(no explanation)");
    } catch (err: any) {
      setExplanation("Explanation unavailable: " + (err?.message || String(err)));
    }
  };

  return (
    <>
      <WSTitle eyebrow="Procurement" title="Planned POs" meta={plans.data.length + " in view"} />
      <div className="ws-content">
        <KPIRow>
          <KPI lbl="Pending"  v={String(counts.draft || 0)} d="draft" />
          <KPI lbl="Approved" v={String(counts.approved || 0)} d="awaiting release" />
          <KPI lbl="Released" v={String(counts.released || 0)} d="this view" />
          <KPI lbl="Cancelled" v={String(counts.cancelled || 0)} d="this view" />
        </KPIRow>
        <WSTabs
          tabs={[
            { id: "draft",      label: "Pending",   count: counts.draft },
            { id: "approved",   label: "Approved",  count: counts.approved },
            { id: "released",   label: "Released",  count: counts.released },
            { id: "cancelled",  label: "Cancelled", count: counts.cancelled },
            { id: "all",        label: "All" },
          ]}
          active={tab}
          onChange={(id) => { setTab(id); setSelected(null); setExplanation(null); }}
        />
        {plans.loading ? (
          <Card><div className="body">Loading plans…</div></Card>
        ) : plans.data.length === 0 ? (
          <Banner kind="info" icon={Icon.info} title="No plans here">
            The weekly cron emits draft plans when a shortage is detected.
            Run replan from the dashboard to populate this queue.
          </Banner>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 360px" : "1fr", gap: 12 }}>
            <Card flush>
              <table className="tbl">
                <thead><tr>
                  <th>#</th>
                  <th>Item</th>
                  <th className="r">Qty</th>
                  <th>Order date</th>
                  <th>ETA</th>
                  <th>Policy</th>
                  <th>Status</th>
                  <th></th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {plans.data.map((p, i) => (
                    <tr key={p.id} className={selected?.id === p.id ? "row-active" : ""}>
                      <td className="mono-sm" style={{ color: "var(--ink-3)" }}>{i + 1}</td>
                      <td>
                        <a className="link" href={"#/inventory-item?part_no=" + encodeURIComponent(p.part_no)}>
                          {p.part_no}
                        </a>
                      </td>
                      <td className="r mono">{Number(p.recommended_qty)}</td>
                      <td className="mono-sm">{p.recommended_order_date}</td>
                      <td className="mono-sm">{p.expected_arrival_date}</td>
                      <td className="mono-sm">{(p.policy_source || "").replace(/^rule_based_/, "")}</td>
                      <td><Chip k={STATUS_CHIP[p.status] || "info"}>{p.status}</Chip></td>
                      <td>
                        <Btn sm kind="ghost" onClick={() => { setSelected(p); setExplanation(null); }}>
                          why?
                        </Btn>
                      </td>
                      <td className="row gap-sm">
                        {p.status === "draft" && (
                          <Btn sm kind="primary" disabled={busy === "approve:" + p.id} onClick={() => onApprove(p.id)}>
                            approve
                          </Btn>
                        )}
                        {p.status === "approved" && (
                          <Btn sm kind="primary" disabled={busy === "release:" + p.id} onClick={() => onRelease(p.id)}>
                            release
                          </Btn>
                        )}
                        {(p.status === "draft" || p.status === "approved") && (
                          <Btn sm kind="ghost" disabled={busy === "cancel:" + p.id} onClick={() => onCancel(p.id)}>
                            cancel
                          </Btn>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            {selected && (
              <RailPanel
                title={"Plan rationale · " + selected.part_no}
                action={<Btn sm kind="ghost" onClick={() => setSelected(null)}>{Icon.x}</Btn>}
              >
                <KV
                  rows={[
                    ["Recommended qty", String(Number(selected.recommended_qty))],
                    ["Net requirement", String(Number(selected.net_requirement))],
                    ["Order by", selected.recommended_order_date],
                    ["Expected arrival", selected.expected_arrival_date],
                    ["Policy", selected.policy_source],
                    ["For week", selected.for_week],
                    ["Lead time (weeks)", String(selected.rationale?.lead_time_weeks ?? "—")],
                    ["Coverage (weeks)", String(selected.rationale?.coverage_weeks ?? "—")],
                    ["Service level", String(selected.rationale?.service_level ?? "—")],
                    ["EOQ Wilson", String(selected.rationale?.eoq_candidates?.wilson ?? "—")],
                    ["EOQ Coverage", String(selected.rationale?.eoq_candidates?.coverage ?? "—")],
                  ]}
                />
                {Array.isArray(selected.rationale?.top_opps) && selected.rationale.top_opps.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="h3" style={{ marginBottom: 6 }}>Top contributing opportunities</div>
                    {selected.rationale.top_opps.map((o: any, idx: number) => (
                      <div key={idx} className="mono-sm" style={{ padding: "4px 0", borderTop: idx ? "1px dashed var(--hairline-2)" : undefined }}>
                        {o.opportunity_name || o.opp_id?.slice(0, 8)} ·
                        {" "}<Chip k="info">{o.stage}</Chip>{" "}
                        · qty {o.qty} × p {Math.round((o.probability || 0) * 100)}%
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 12 }}>
                  <Btn sm kind="ghost" onClick={() => onExplain(selected.id)}>
                    {Icon.bolt} ask AI to explain
                  </Btn>
                  {explanation && (
                    <div style={{ marginTop: 8, padding: 10, background: "var(--ink-bg-2)", borderRadius: 6, whiteSpace: "pre-wrap" }}>
                      {explanation}
                    </div>
                  )}
                </div>
              </RailPanel>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default InventoryPlansScreen;
