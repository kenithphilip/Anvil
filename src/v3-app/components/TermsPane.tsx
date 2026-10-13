import React from "react";
import { Banner, Btn, Card, Chip } from "../lib/primitives";
import { AnvilBackend } from "../lib/api";
import { canDo } from "../lib/rbac";
import { fmtDate } from "../lib/helpers";
import { ReviewDocPane } from "./ReviewPane";
import { ReviewPaneSelectionProvider, useReviewPaneSelection } from "./ReviewPaneContext";
import type { EvidenceBbox } from "./PdfPagePreview";

// ============================================================
// ANVIL v3: the Terms tab of the SO workspace
// docs/SO_TERMS_AND_HANDOFF_SCOPE.md 6.6. Per flag: the PO wording beside
// the quote wording, each with where it came from, the severity, why it was
// flagged, and the decision history. Four decisions, each with a required
// reason. The buttons offered are the ones the server says this caller may
// make (owner decision 2); the server checks again on every decision.
// Hovering a flag highlights its wording on the PO where a box exists.
// Data: GET /api/orders/terms, POST /api/orders/terms_check and
// /api/orders/terms_decide.
// ============================================================

export const MIN_REASON = 10;

export const DECISION_LABEL: Record<string, string> = {
  accept: "Accept",
  request_amendment: "Request amendment",
  reject_term: "Reject term",
  not_a_deviation: "Not a deviation",
};

const DECISION_DONE: Record<string, string> = {
  accept: "accepted",
  request_amendment: "amendment requested",
  reject_term: "term rejected",
  not_a_deviation: "not a deviation",
};

const SEVERITY_CHIP: Record<string, string> = { critical: "bad", high: "bad", warn: "warn", info: "info" };
const DIRECTION_TEXT: Record<string, string> = { against_us: "against us", for_us: "for us", neutral: "neutral" };

const outcomeText = (f: any): string => {
  switch (f.outcome) {
    case "deviates": return "differs" + (f.direction ? ", " + (DIRECTION_TEXT[f.direction] || f.direction) : "");
    case "po_only": return "PO only, the quote is silent";
    case "quote_only": return "quote only, the PO is silent";
    case "unknown": return "could not be compared";
    case "not_read": return "PO terms not read";
    default: return f.outcome || "";
  }
};

// The PO highlight for every flag whose PO wording has a box. Keyed
// "terms.<flag id>", which is what hovering the flag selects.
export const termEvidence = (flags: any[]): EvidenceBbox[] => {
  const out: EvidenceBbox[] = [];
  for (const f of flags || []) {
    const po = f && f.po;
    const norm = po && Array.isArray(po.bbox_norm) ? po.bbox_norm.map(Number) : null;
    if (!norm || norm.length < 4 || !norm.every((n: number) => Number.isFinite(n))) continue;
    const [x0, y0, x1, y1] = norm;
    out.push({
      id: "term-" + f.id,
      page_number: Number(po.page) || 1,
      field_path: "terms." + f.id,
      value: f.clause_label || f.clause || null,
      confidence: po.confidence != null ? Number(po.confidence) : null,
      bbox: { x0, y0, x1, y1, page_width: 1, page_height: 1 },
    });
  }
  return out;
};

// The status line at the top of the tab. Never "no deviations" when the
// PO's terms were not read.
export const termsStatusLine = (view: any): string => {
  const c = view?.check;
  if (!c) return "Terms not checked yet.";
  const flags = Array.isArray(view.flags) ? view.flags : [];
  const undecided = flags.filter((f: any) => f.state === "undecided").length;
  const tail = flags.length
    ? `${flags.length} flag${flags.length === 1 ? "" : "s"}, ${undecided} to decide.`
    : "No flags.";
  if (c.po_terms_status === "not_read") {
    const nr = flags.find((f: any) => f.outcome === "not_read");
    return "PO terms not read" + (nr?.rationale ? ". " + nr.rationale : ".");
  }
  const clauses = `${c.clause_count} clause${c.clause_count === 1 ? "" : "s"}`;
  if (c.po_source === "extraction") {
    return `Header terms only: the PO's terms and conditions were not read. ${clauses} from the order header, ${tail}`;
  }
  if (c.po_terms_status === "partial") return `Terms partly read: ${clauses}, ${tail}`;
  return `Terms read: ${clauses}, ${tail}`;
};

const describeValue = (rec: any): string | null => {
  const v = rec && rec.value;
  if (!v || typeof v !== "object") return null;
  if (rec.clause === "validity") {
    return [v.days != null ? `valid ${v.days} days` : null, v.expires_at ? `expires ${v.expires_at}` : null].filter(Boolean).join(", ") || null;
  }
  return null;
};

const Side: React.FC<{ title: string; rec: any; silent: string }> = ({ title, rec, silent }) => {
  const text = rec?.text || describeValue(rec);
  return (
    <div className="terms-side" style={{ minWidth: 0 }}>
      <div className="h-eyebrow" style={{ marginBottom: 4 }}>{title}</div>
      {text
        ? <div className="body" style={{ whiteSpace: "pre-wrap" }}>{text}</div>
        : <div className="body" style={{ color: "var(--ink-3)" }}>{silent}</div>}
      {rec?.label && <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 4 }}>{rec.label}</div>}
      {rec?.printed_note && <div className="mono-sm" style={{ color: "var(--ink-3)" }}>{rec.printed_note}</div>}
    </div>
  );
};

const History: React.FC<{ decisions: any[] }> = ({ decisions }) => {
  if (!decisions || !decisions.length) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="h-eyebrow" style={{ marginBottom: 4 }}>Decision history</div>
      <ol className="terms-history" style={{ margin: 0, paddingLeft: 18 }}>
        {decisions.map((d: any) => (
          <li key={d.id} className="mono-sm">
            <span className="pri">{DECISION_DONE[d.decision] || d.decision}</span>
            {d.decided_role ? ` by ${d.decided_role}` : ""}
            {d.decided_at ? ` on ${fmtDate(d.decided_at)}` : ""}
            {d.carried_from ? " (carried from the previous check)" : ""}
            <div style={{ color: "var(--ink-2)" }}>{d.reason}</div>
          </li>
        ))}
      </ol>
    </div>
  );
};

const FlagCard: React.FC<{ flag: any; orderId: string; canDecide: boolean; onDecided: (flag: any) => void }> = ({ flag, orderId, canDecide, onDecided }) => {
  const { setHoveredField, setSelectedField } = useReviewPaneSelection();
  const [choice, setChoice] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fp = "terms." + flag.id;
  const allowed: string[] = Array.isArray(flag.allowed) ? flag.allowed : [];
  const reasonOk = reason.trim().length >= MIN_REASON;
  const highOnly = (flag.severity === "high" || flag.severity === "critical") && !allowed.includes("accept") && allowed.length > 0;

  const submit = async () => {
    if (!choice || !reasonOk || busy) return;
    setBusy(true); setError(null);
    try {
      const out: any = await AnvilBackend?.orders?.termsDecide?.(orderId, flag.id, choice, reason.trim());
      if (!out?.flag) throw new Error("The decision was not recorded.");
      onDecided(out.flag);
      setChoice(null); setReason("");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally { setBusy(false); }
  };

  const stateChip = flag.state === "undecided" ? <Chip k="warn">to decide</Chip>
    : flag.state === "amendment_requested" ? <Chip k="info">amendment requested</Chip>
      : flag.state === "decided" ? <Chip k="good">{DECISION_DONE[flag.decision?.decision] || "decided"}</Chip>
        : <Chip k="ghost">for information</Chip>;

  return (
    <div
      data-testid={"term-flag-" + flag.id}
      onMouseEnter={() => setHoveredField(fp)}
      onMouseLeave={() => setHoveredField(null)}
    >
      <Card
        title={flag.clause_label}
        eyebrow={<Chip k={SEVERITY_CHIP[flag.severity] as any}>{flag.severity}</Chip>}
        right={stateChip}
      >
        <div className="mono-sm" style={{ color: "var(--ink-3)", marginBottom: 8 }}>{outcomeText(flag)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16 }}>
          <Side title="PO wording" rec={flag.po} silent={flag.outcome === "not_read" ? "not read" : "the PO is silent"} />
          <Side
            title={"Quote wording" + (flag.quote?.quote_number ? " · " + flag.quote.quote_number + (flag.quote.primary ? " (primary)" : "") : "")}
            rec={flag.quote}
            silent={flag.quote ? "the quote is silent" : "no quote is linked"}
          />
        </div>
        {flag.po?.page && flag.po?.bbox_norm && (
          <button type="button" className="link-btn mono-sm" onClick={() => setSelectedField(fp)}
                  style={{ background: "none", border: "none", padding: 0, marginTop: 6, color: "var(--ink)", cursor: "pointer", textDecoration: "underline" }}>
            Show on the PO, page {flag.po.page}
          </button>
        )}
        {flag.baseline && (
          <div className="mono-sm" style={{ marginTop: 8 }}>
            Baseline: {flag.baseline.text || "not stated"} <span style={{ color: "var(--ink-3)" }}>({flag.baseline.label})</span>
          </div>
        )}
        {flag.rationale && (
          <div className="body" style={{ marginTop: 8 }}>
            <span className="h-eyebrow">Why flagged ({flag.method === "llm" ? "LLM" : "rule"}): </span>{flag.rationale}
          </div>
        )}
        <History decisions={flag.decisions} />
        {canDecide && allowed.length > 0 && (
          <div className="terms-decide" style={{ marginTop: 12, borderTop: "1px solid var(--hairline-2)", paddingTop: 10 }}>
            <div className="row gap-sm" role="group" aria-label={"Decision on " + flag.clause_label} style={{ flexWrap: "wrap" }}>
              {allowed.map((d) => (
                <Btn key={d} sm kind={choice === d ? "primary" : "ghost"} onClick={() => setChoice(choice === d ? null : d)}>
                  {DECISION_LABEL[d] || d}
                </Btn>
              ))}
            </div>
            {highOnly && (
              <div className="mono-sm" style={{ color: "var(--ink-3)", marginTop: 6 }}>
                Accepting a {flag.severity} flag needs a sales manager or an admin.
              </div>
            )}
            {choice && (
              <div style={{ marginTop: 8 }}>
                <textarea
                  aria-label={"Reason for " + (DECISION_LABEL[choice] || choice)}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder={`Why? A reason is required (at least ${MIN_REASON} characters).`}
                  style={{ width: "100%", font: "inherit" }}
                />
                <div className="row gap-sm" style={{ marginTop: 6, alignItems: "center" }}>
                  <Btn sm kind="primary" disabled={!reasonOk || busy} onClick={submit}>
                    {busy ? "Recording…" : "Record: " + (DECISION_LABEL[choice] || choice)}
                  </Btn>
                  {!reasonOk && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>A reason of at least {MIN_REASON} characters is required.</span>}
                </div>
              </div>
            )}
            {error && <div className="mono-sm" role="alert" style={{ color: "var(--bad, #b42318)", marginTop: 6 }}>{error}</div>}
          </div>
        )}
      </Card>
    </div>
  );
};

const stateCounts = (flags: any[]) => ({
  undecided: flags.filter((f) => f.state === "undecided").length,
  amendment_requested: flags.filter((f) => f.state === "amendment_requested").length,
  decided: flags.filter((f) => f.state === "decided").length,
});

export const TermsPane: React.FC<{
  orderId: string;
  sourceDocId: string | null;
  view: any;
  isAdmin: boolean;
  canWrite: boolean;
  onView: (view: any) => void;
}> = ({ orderId, sourceDocId, view, isAdmin, canWrite, onView }) => {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const flags: any[] = Array.isArray(view?.flags) ? view.flags : [];
  const evidence = React.useMemo(() => termEvidence(flags), [flags]);
  const canDecide = canWrite && canDo("order.terms_decide");

  const recheck = async () => {
    setBusy(true); setError(null);
    try {
      const out: any = await AnvilBackend?.orders?.termsCheck?.(orderId, { includeShadow: isAdmin && !!view?.shadow });
      if (out && typeof out === "object") onView(out);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally { setBusy(false); }
  };

  const onDecided = (updated: any) => {
    const next = flags.map((f) => (f.id === updated.id ? updated : f));
    onView({ ...view, flags: next, counts: { ...(view?.counts || {}), ...stateCounts(next) } });
  };

  return (
    <ReviewPaneSelectionProvider key={orderId}>
      <div className="row gap-sm" style={{ alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <span className="h2">Terms</span>
        {view?.shadow && <Chip k="warn">shadow</Chip>}
        <span className="mono-sm" data-testid="terms-status">{termsStatusLine(view)}</span>
        <span style={{ flex: 1 }} />
        {canWrite && <Btn sm kind="ghost" onClick={recheck} disabled={busy}>{busy ? "Checking…" : "Re-check terms"}</Btn>}
      </div>
      {view?.shadow && (
        <Banner kind="info" title="Shadow mode">
          Engineers do not see these flags. They are stored to measure how often a flag is right before anyone acts on one.
        </Banner>
      )}
      {error && (
        <Banner kind="bad" title="Could not re-check the terms">
          <span className="mono-sm">{error}</span>
        </Banner>
      )}
      <div className={"recon-split " + (sourceDocId ? "recon-view-split" : "recon-view-lines")}>
        {sourceDocId && (
          <div className="recon-doc">
            <ReviewDocPane docId={sourceDocId} extraEvidence={evidence} />
          </div>
        )}
        <div className="recon-right">
          {flags.length === 0 && view?.check && (
            <div className="mono-sm" style={{ color: "var(--ink-3)" }}>Nothing differs from the quote in the terms that were read.</div>
          )}
          {flags.map((f) => (
            <FlagCard key={f.id} flag={f} orderId={orderId} canDecide={canDecide} onDecided={onDecided} />
          ))}
        </div>
      </div>
    </ReviewPaneSelectionProvider>
  );
};

export default TermsPane;
