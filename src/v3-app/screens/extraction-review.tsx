import React, { useState } from "react";
import { ageLabel, useFetch } from "../lib/helpers";
import { Banner, Btn, Card, Chip, KPI, KPIRow, WSTabs, WSTitle } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";

// ============================================================
// ANVIL v3 — Extraction Review Queue (Wave 4.1 operator surface)
//
// The docai pipeline enqueues every run that needs operator eyes
// (low confidence, anomaly blockers, parse failures, suspected
// handwriting) into extraction_review_queue. Until this screen the
// queue had a backend but no UI, so the rows piled up invisibly.
// Operators triage from here: claim a row, jump to the order's
// workspace to fix it, then resolve it confirmed / rejected.
//
// Data: ObaraBackend.docai.listReviewQueue({status}) -> { queue, summary }
//       ObaraBackend.docai.reviewDecide({ id, action, resolution? })
// ============================================================

type QueueRow = {
  id: string;
  customer_id?: string | null;
  extraction_run_id?: string | null;
  case_id?: string | null;
  reason: string;
  severity: "low" | "medium" | "high" | "critical";
  triggered_by?: string | null;
  preview?: {
    classification?: string | null;
    customer?: { name?: string; gstin?: string; po_number?: string } | null;
    line_count?: number;
    totals?: { grand_total?: number | string } | null;
  } | null;
  metrics?: {
    confidence_overall?: number | null;
    anomaly_count?: number;
    anomaly_error_count?: number;
    adapter_used?: string | null;
    voter_used?: boolean;
    handwriting_score?: number | null;
  } | null;
  status: string;
  notes?: string | null;
  created_at?: string;
};

const SEV_CHIP = (s: string) => {
  const k = s === "critical" ? "bad" : s === "high" ? "bad" : s === "medium" ? "warn" : "ghost";
  return <Chip k={k}>{s || "low"}</Chip>;
};

// Human-readable label for each queue reason emitted by
// classifyForQueue in src/api/_lib/docai/review-queue.js.
const REASON_LABEL: Record<string, string> = {
  low_confidence: "Low confidence",
  anomalies: "Anomaly blocker",
  parse_failed: "Parse failed",
  non_po: "Not a PO",
  image_pdf_no_text: "Image PDF · no text",
  empty_lines: "No line items",
  handwriting: "Handwriting suspected",
};

const pctOrDash = (v: number | null | undefined) =>
  v == null || Number.isNaN(Number(v)) ? "—" : Math.round(Number(v) * 100) + "%";

const STATUS_BY_TAB: Record<string, string> = {
  open: "open",
  in_review: "in_review",
  resolved: "resolved",
};

const ExtractionReview = () => {
  const [tab, setTab] = useState("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);

  // Re-fetch whenever the tab changes. The Open tab shows the
  // actionable backlog (the endpoint defaults to open + in_review
  // when no status is passed), so we only pass an explicit status
  // for the In-review and Resolved tabs.
  const list = useFetch(async () => {
    const q = tab === "open" ? undefined : { status: STATUS_BY_TAB[tab] };
    const r: any = await ObaraBackend?.docai?.listReviewQueue?.(q);
    return r || { queue: [], summary: {} };
  }, [tab]);

  const decide = async (id: string, action: string, resolution?: string) => {
    setBusy(id);
    setActionError(null);
    try {
      await ObaraBackend?.docai?.reviewDecide?.({ id, action, resolution });
      list.reload();
    } catch (err: any) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  const openWorkspace = (row: QueueRow) => {
    if (row.case_id) location.hash = `#/so?id=${row.case_id}`;
  };

  if (list.loading) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Extraction Review" title="Extraction Review" meta="loading…" />
        <div className="ws-content"><Card><div className="body">Loading review queue…</div></Card></div>
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="ws ws-no-rail">
        <WSTitle eyebrow="Quality · Extraction Review" title="Extraction Review" meta="error" />
        <div className="ws-content">
          <Banner kind="bad" icon={Icon.alert} title="Could not load the review queue"
                  action={<Btn sm onClick={list.reload}>Retry</Btn>}>
            <span className="mono-sm">{String(list.error.message || list.error)}</span>
          </Banner>
        </div>
      </div>
    );
  }

  const data = (list.data as any) || {};
  const rows: QueueRow[] = Array.isArray(data.queue) ? data.queue : [];
  const summary = data.summary || { low: 0, medium: 0, high: 0, critical: 0, total: 0 };

  const tabs = [
    { id: "open", label: "Open", count: summary.total || 0 },
    { id: "in_review", label: "In review" },
    { id: "resolved", label: "Resolved" },
  ];

  return (
    <>
      <WSTitle
        eyebrow="Quality · Extraction Review"
        title="Extraction Review"
        meta={`${summary.total || 0} awaiting review`}
        right={<Btn icon kind="ghost" sm onClick={list.reload} title="Refresh">{Icon.cycle}</Btn>}
      />
      <WSTabs tabs={tabs} active={tab} onChange={setTab} />

      <div className="ws-content">
        {actionError && (
          <Banner kind="bad" icon={Icon.alert} title="Action failed">
            <span className="mono-sm">{String(actionError.message || actionError)}</span>
          </Banner>
        )}

        {tab === "open" && (summary.total || 0) > 0 && (
          <KPIRow cols={4}>
            <KPI lbl="Critical" v={String(summary.critical || 0)} dKind={summary.critical ? "down" : ""} />
            <KPI lbl="High" v={String(summary.high || 0)} dKind={summary.high ? "down" : ""} />
            <KPI lbl="Medium" v={String(summary.medium || 0)} />
            <KPI lbl="Low" v={String(summary.low || 0)} />
          </KPIRow>
        )}

        <Card flush>
          {rows.length === 0 ? (
            <div className="body" style={{ padding: 22, textAlign: "center", color: "var(--ink-3)" }}>
              {tab === "open" ? "All clear · nothing awaiting review." : `No ${tab.replace("_", " ")} items.`}
            </div>
          ) : (
            <table className="tbl">
              <thead><tr>
                <th>Customer / PO</th>
                <th>Reason</th>
                <th>Severity</th>
                <th className="r">Confidence</th>
                <th>Adapter</th>
                <th className="r">Lines</th>
                <th className="r">Age</th>
                <th style={{ width: 220 }}></th>
              </tr></thead>
              <tbody>
                {rows.slice(0, 200).map((r) => {
                  const cust = r.preview?.customer;
                  const custLabel = cust?.name || (r.customer_id ? r.customer_id.slice(0, 8) : "—");
                  const po = cust?.po_number;
                  const conf = r.metrics?.confidence_overall;
                  const adapter = r.metrics?.adapter_used || "—";
                  const isBusy = busy === r.id;
                  return (
                    <tr key={r.id}>
                      <td>
                        <div><span className="pri">{custLabel}</span></div>
                        {po && <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{po}</div>}
                      </td>
                      <td>{REASON_LABEL[r.reason] || r.reason}</td>
                      <td>{SEV_CHIP(r.severity)}</td>
                      <td className="r mono-sm">{pctOrDash(conf)}</td>
                      <td className="mono-sm">
                        {adapter}{r.metrics?.voter_used ? <Chip k="info">voted</Chip> : null}
                      </td>
                      <td className="r mono-sm">{r.preview?.line_count ?? "—"}</td>
                      <td className="r mono">{r.created_at ? ageLabel(r.created_at) : "—"}</td>
                      <td style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        {r.case_id && (
                          <Btn sm kind="ghost" onClick={() => openWorkspace(r)} title="Open the order workspace">
                            open {Icon.arrowR}
                          </Btn>
                        )}
                        {tab !== "resolved" ? (
                          <>
                            {r.status === "open" && (
                              <Btn sm kind="ghost" disabled={isBusy} onClick={() => decide(r.id, "claim")}>
                                claim
                              </Btn>
                            )}
                            <Btn sm disabled={isBusy} onClick={() => decide(r.id, "resolve", "confirmed")}
                                 title="Mark the extraction confirmed and close the review">
                              {isBusy ? "…" : "confirm"}
                            </Btn>
                            <Btn sm kind="ghost" disabled={isBusy} onClick={() => decide(r.id, "resolve", "rejected")}
                                 title="Reject the extraction and close the review">
                              reject
                            </Btn>
                          </>
                        ) : (
                          <Btn sm kind="ghost" disabled={isBusy} onClick={() => decide(r.id, "reopen")}>
                            reopen
                          </Btn>
                        )}
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

export default ExtractionReview;
