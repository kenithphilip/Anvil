// Format-template marketplace consumer dashboard. Bet 2.
//
// Two views:
//   - Browse the global library (approved templates, anonymous
//     publishers by default).
//   - Your imports: every global template this tenant has used,
//     with confirm + revert actions. Confirm bumps the promotion
//     counter; once N confirms accumulate (default 5) the template
//     auto-promotes from hint mode to full skip-LLM on the
//     dispatcher's L3.5 step.
//
// Operator-side report-this-template flow lives here too.

import React, { useEffect, useMemo, useState } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { AnvilBackend } from "../lib/api";

const REPORT_REASONS: Array<{ id: string; label: string }> = [
  { id: "mis_extracts_value", label: "Mis-extracts a value" },
  { id: "exfiltrates_data",   label: "Captures unrelated data" },
  { id: "pii_leak",           label: "Leaks PII in labels" },
  { id: "redos_pattern",      label: "Regex looks malicious" },
  { id: "irrelevant_template",label: "Irrelevant template" },
  { id: "other",              label: "Other" },
];

const MarketplaceScreen: React.FC = () => {
  const [tab, setTab] = useState("imports");
  const [list, setList] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [imports, setImports] = useState<{ data: any[]; loading: boolean }>({ data: [], loading: true });
  const [bump, setBump] = useState(0);
  const [reportFor, setReportFor] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState("mis_extracts_value");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      Promise.resolve((AnvilBackend as any)?.marketplace?.list?.()),
      Promise.resolve((AnvilBackend as any)?.marketplace?.imports?.()),
    ]).then(([l, i]) => {
      if (cancelled) return;
      setList({ data: l.status === "fulfilled" ? (l.value?.templates || []) : [], loading: false });
      setImports({ data: i.status === "fulfilled" ? (i.value?.imports || []) : [], loading: false });
    });
    return () => { cancelled = true; };
  }, [bump]);

  const confirm = async (id: string) => {
    setBusyId(id);
    try {
      await (AnvilBackend as any)?.marketplace?.confirmImport?.(id);
      (window as any).notifySuccess?.("Confirmed", "Confirmation count incremented; promotion to skip-LLM happens after the configured threshold.");
      setBump((n) => n + 1);
    } catch (err: any) {
      (window as any).notifyError?.("Confirm failed", err?.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const revert = async (id: string) => {
    setBusyId(id);
    try {
      await (AnvilBackend as any)?.marketplace?.revertImport?.(id, "consumer_revert");
      (window as any).notifySuccess?.("Reverted", "The global template will no longer be used for this tenant; the LLM resumes the full extraction path.");
      setBump((n) => n + 1);
    } catch (err: any) {
      (window as any).notifyError?.("Revert failed", err?.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const sendReport = async () => {
    if (!reportFor) return;
    setBusyId(reportFor);
    try {
      await (AnvilBackend as any)?.marketplace?.report?.(reportFor, reportReason, {});
      (window as any).notifySuccess?.("Report filed", "Super-admin will review. Three confirmed reports auto-suspend the publisher.");
      setReportFor(null);
      setBump((n) => n + 1);
    } catch (err: any) {
      (window as any).notifyError?.("Report failed", err?.message || String(err));
    } finally {
      setBusyId(null);
    }
  };

  const kpis = useMemo(() => {
    const total = imports.data.length;
    const active = imports.data.filter((i) => !i.reverted_at).length;
    const promoted = imports.data.filter((i) => i.use_mode === "skip_llm").length;
    const totalGlobal = list.data.length;
    return { total, active, promoted, totalGlobal };
  }, [imports.data, list.data]);

  if (list.loading || imports.loading) {
    return (
      <>
        <WSTitle eyebrow="Quality" title="Template Marketplace" meta="loading" />
        <div className="ws-content">
          <Card><div className="body">Loading marketplace…</div></Card>
        </div>
      </>
    );
  }

  return (
    <>
      <WSTitle eyebrow="Quality" title="Template Marketplace" meta="global format-template library" />
      <div className="ws-content">
        <Banner kind="info" icon={Icon.info} title="Marketplace defaults to hint mode">
          <span className="mono-sm">
            Global templates fired by the dispatcher do NOT skip the LLM by default. Each
            extraction still runs the full L4 LLM dispatch; the global template provides
            known-fields hints. After your operator has confirmed N successful imports
            (configurable, default 5), the template promotes to skip-LLM. You can
            revert any import at any time.
          </span>
        </Banner>
        <KPIRow>
          <KPI lbl="Approved global templates" v={String(kpis.totalGlobal)} d="all kinds" />
          <KPI lbl="Imports this tenant" v={String(kpis.total)} d={kpis.active + " active"} />
          <KPI lbl="Promoted to skip-LLM" v={String(kpis.promoted)} d="after operator confirms" />
        </KPIRow>
        <WSTabs
          tabs={[
            { id: "imports", label: "Your imports", count: kpis.total },
            { id: "browse",  label: "Browse library", count: kpis.totalGlobal },
          ]}
          active={tab}
          onChange={setTab}
        />
        {tab === "imports" && (
          <Card flush>
            {imports.data.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No imports yet. As your extractions match approved global templates, rows appear here.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Global ID</th>
                  <th>Mode</th>
                  <th className="r">Score</th>
                  <th className="r">Confirmed</th>
                  <th>Status</th>
                  <th>First used</th>
                  <th>Actions</th>
                </tr></thead>
                <tbody>
                  {imports.data.map((row: any) => (
                    <tr key={row.id}>
                      <td className="mono-sm">{row.global_id.slice(0, 8)}…</td>
                      <td>
                        <Chip k={row.use_mode === "skip_llm" ? "good" : "info"}>
                          {row.use_mode}
                        </Chip>
                      </td>
                      <td className="r mono">{Number(row.match_score).toFixed(2)}</td>
                      <td className="r mono">{row.operator_confirmed_count || 0}</td>
                      <td>
                        {row.reverted_at
                          ? <Chip k="warn">reverted</Chip>
                          : <Chip k="good">active</Chip>}
                      </td>
                      <td className="mono-sm">{new Date(row.created_at).toLocaleDateString("en-IN")}</td>
                      <td>
                        {!row.reverted_at && (
                          <div className="row gap-sm">
                            <Btn sm kind="ghost" disabled={busyId === row.id} onClick={() => confirm(row.id)}>
                              Confirm
                            </Btn>
                            <Btn sm kind="ghost" disabled={busyId === row.id} onClick={() => revert(row.id)}>
                              Revert
                            </Btn>
                            <Btn sm kind="ghost" disabled={busyId === row.id} onClick={() => setReportFor(row.global_id)}>
                              Report
                            </Btn>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}
        {tab === "browse" && (
          <Card flush>
            {list.data.length === 0 ? (
              <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
                No approved templates yet. Once publishers opt in and pass review,
                approved templates show here.
              </div>
            ) : (
              <table className="tbl">
                <thead><tr>
                  <th>Template</th>
                  <th>Kind</th>
                  <th>Publisher</th>
                  <th className="r">Anonymity (k)</th>
                  <th className="r">Hits</th>
                  <th className="r">Misses</th>
                  <th>Created</th>
                </tr></thead>
                <tbody>
                  {list.data.map((g: any) => (
                    <tr key={g.id}>
                      <td className="mono-sm">{g.id.slice(0, 8)}…</td>
                      <td className="mono-sm">{g.kind}</td>
                      <td className="mono-sm">
                        {g.anonymise_publisher ? "Anonymous" : (g.publisher_display || "Verified publisher")}
                      </td>
                      <td className="r mono">{g.k_anonymity}</td>
                      <td className="r mono">{g.hit_count}</td>
                      <td className="r mono">{g.miss_count}</td>
                      <td className="mono-sm">{new Date(g.created_at).toLocaleDateString("en-IN")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {reportFor && (
          <div className="modal-backdrop" onClick={() => setReportFor(null)}>
            <div className="modal" role="dialog" aria-modal="true" onClick={(ev) => ev.stopPropagation()} style={{ maxWidth: 480 }}>
              <div className="modal-h">
                <span className="ti">Report template</span>
                <Btn icon kind="ghost" sm onClick={() => setReportFor(null)} aria-label="Close">{Icon.close}</Btn>
              </div>
              <div className="modal-body" style={{ display: "grid", gap: 10 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <span className="mono-sm">Why are you reporting this template?</span>
                  <select className="mono"
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value)}
                    style={{ padding: "6px 8px" }}>
                    {REPORT_REASONS.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </label>
                <Banner kind="info" icon={Icon.info} title="What happens next">
                  <span className="mono-sm">
                    Super-admin reviews this report. If confirmed, the template is revoked + the
                    publisher's reputation takes a hit. Three confirmed reports auto-suspend
                    the publisher.
                  </span>
                </Banner>
              </div>
              <div className="modal-f">
                <Btn kind="ghost" onClick={() => setReportFor(null)}>Cancel</Btn>
                <Btn kind="primary" onClick={sendReport}>Send report</Btn>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default MarketplaceScreen;
