// SO Workspace review cells — extracted verbatim from screens/so-workspace.tsx.
// The recon-cell rendering components (field pill, provenance chip, extraction-
// quality card, editable cell). Kept at module scope so their identity is stable
// across renders (focus survives edits); order-scoped values come in as props.

import React, { useState, useRef } from "react";
import { Banner, Btn, Card, Chip, KPI, KPIRow } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { FieldSource, getFieldSource, ExtractionIndex, issuesForCanonicalCell, worstSeverity, IssueEntry } from "../lib/field-sources";
import { LINE_ALIAS } from "../lib/line-totals";

export const FieldPill: React.FC<{ src: FieldSource | null }> = ({ src }) => {
  if (src === "ocr") return <Chip k="ghost">OCR</Chip>;
  if (src === "human") return <Chip k="info">edited</Chip>;
  return null;
};

// Wave 4.1: adapter + confidence chip for a recon cell, coloured by the
// worst validator/anomaly severity touching that cell. The tooltip
// carries the adapter, confidence, and any issue messages so the
// operator can see why a field is flagged without leaving the row.
export const ProvenanceChip: React.FC<{
  canonicalKey: string; lineIndex: number; extractionIndex: ExtractionIndex;
}> = ({ canonicalKey, lineIndex, extractionIndex }) => {
  const prov = extractionIndex.lineProvenance(lineIndex, canonicalKey);
  const cellIssues = issuesForCanonicalCell(extractionIndex.lineIssues(lineIndex), canonicalKey);
  const sev = worstSeverity(cellIssues);
  if (!prov && !sev) return null;
  const tone = sev === "error" ? "bad" : sev === "warn" ? "warn" : "ghost";
  const confPct = prov?.confidence != null ? Math.round(prov.confidence * 100) + "%" : null;
  const voted = (prov?.voters?.length || 0) > 1;
  const label = sev
    ? (sev === "error" ? "check" : "review")
    : (prov?.source || "src");
  const title = [
    prov?.source ? `source: ${prov.source}${voted ? " (voted)" : ""}` : null,
    confPct ? `confidence: ${confPct}` : null,
    ...cellIssues.map((x) => `${x.severity}: ${x.message || x.code}`),
  ].filter(Boolean).join("\n");
  return (
    <span title={title} style={{ display: "inline-flex" }}>
      <Chip k={tone as any}>{label}{confPct && !sev ? ` ${confPct}` : ""}</Chip>
    </span>
  );
};

// The anomaly code run.js records when a fallback parser read the document
// because every LLM was busy (src/api/_lib/docai/llm-fallback.js).
const LLM_UNAVAILABLE_CODE = "llm_unavailable_fallback_parse";

// The attempt status the dispatcher records when the provider circuit breaker
// skipped a model that was overloaded within the last N minutes
// (src/api/_lib/docai/circuit-breaker.js).
const CIRCUIT_OPEN_STATUS = "skipped_circuit_open";

const clockTime = (iso: any): string | null => {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

// What the card says when the breaker skipped a model: which model, why, and
// when Anvil tries it again. A chunked PO records one skip per chunk, so each
// model is named once.
const circuitSkipSentence = (attempts: any): string | null => {
  const byAdapter = new Map<string, any>();
  for (const a of Array.isArray(attempts) ? attempts : []) {
    if (a?.status === CIRCUIT_OPEN_STATUS && a.adapter && !byAdapter.has(a.adapter)) byAdapter.set(a.adapter, a);
  }
  if (!byAdapter.size) return null;
  const skips = [...byAdapter.values()];
  const one = skips.length === 1;
  const list = (xs: string[]) => (xs.length === 1 ? xs[0] : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
  const minutes = skips.map((a) => Number(a.window_minutes)).find((n) => Number.isFinite(n) && n > 0);
  const again = skips
    .map((a) => ({ adapter: a.adapter, at: clockTime(a.half_open_at) }))
    .filter((x) => x.at)
    .map((x, i) => (i === 0 ? `${x.adapter} again from ${x.at}` : `${x.adapter} from ${x.at}`));
  return `This run skipped ${list(skips.map((a) => a.adapter))} because ${one ? "it was" : "they were"} overloaded`
    + ` in the last ${minutes || "few"} minutes. The next engine got ${one ? "its" : "their"} time.`
    + (again.length ? ` Anvil tries ${list(again)}.` : "");
};

// Wave 4.1: extraction-quality summary for the recon tab. Surfaces the
// winning adapter, overall confidence, validator + anomaly counts, and
// an expandable list of every flagged field so the operator knows where
// to look before approving.
export const ExtractionQualityCard: React.FC<{
  extractionRun: any; extractionIndex: ExtractionIndex;
}> = ({ extractionRun, extractionIndex }) => {
  const [open, setOpen] = React.useState(false);
  if (!extractionRun) return null;
  const s = extractionIndex.summary;
  const issues: IssueEntry[] = extractionIndex.allIssues;
  const confPct = s.confidence != null ? Math.round(s.confidence * 100) + "%" : "—";
  const sevChip = (sev: string) =>
    <Chip k={sev === "error" ? "bad" : sev === "warn" ? "warn" : "ghost"}>{sev}</Chip>;
  // The models were busy and a parser read this PO. A parse like that can
  // miss the header and split items, and running extraction again later
  // usually reaches a model, so say both plainly above the numbers.
  const llmUnavailable = (Array.isArray(extractionRun.anomalies) ? extractionRun.anomalies : [])
    .find((a: any) => a?.code === LLM_UNAVAILABLE_CODE);
  // A model skipped because it was overloaded a few minutes earlier. Said
  // inside the busy-models banner when there is one, else on its own.
  const circuitSkip = circuitSkipSentence(extractionRun.adapter_attempts);
  return (
    <Card
      title="Extraction quality"
      eyebrow="docai provenance · validators · anomalies"
      right={issues.length
        ? <Btn sm kind="ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "hide" : `${issues.length} flagged field${issues.length === 1 ? "" : "s"}`}
          </Btn>
        : <Chip k="good">clean</Chip>}
    >
      {llmUnavailable && (
        <Banner kind="warn" icon={Icon.alert} title="Read by the fallback parser">
          The AI models were busy, so the fallback parser
          ({String(llmUnavailable.actual || s.adapter || "parser")}) read this PO.
          It can miss header fields and split one item into several lines. Check
          the header and the lines. Run extraction again later for a better result.
          {circuitSkip && <> {circuitSkip}</>}
        </Banner>
      )}
      {!llmUnavailable && circuitSkip && (
        <Banner kind="info" icon={Icon.info} title="Skipped a busy model">
          {circuitSkip}
        </Banner>
      )}
      <KPIRow cols={4}>
        <KPI lbl="Adapter" v={s.adapter || "—"} d={s.voterUsed ? "cross-adapter vote" : ""} />
        <KPI lbl="Confidence" v={confPct}
             dKind={s.confidence == null ? "" : (s.confidence >= 0.8 ? "up" : s.confidence < 0.5 ? "down" : "")} />
        <KPI lbl="Validator" v={String(s.validator.total)}
             d={`${s.validator.error} err · ${s.validator.warn} warn`}
             dKind={s.validator.error ? "down" : ""} />
        <KPI lbl="Anomalies" v={String(s.anomalies.total)}
             d={`${s.anomalies.error} blocker${s.anomalies.error === 1 ? "" : "s"}`}
             dKind={s.anomalies.error ? "down" : ""} />
      </KPIRow>
      {open && issues.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Field</th><th>Check</th><th>Severity</th><th>Detail</th></tr></thead>
          <tbody>
            {issues.slice(0, 100).map((iss, n) => (
              <tr key={iss.field + ":" + iss.code + ":" + n}>
                <td className="mono-sm">{iss.field}</td>
                <td className="mono-sm">{iss.kind === "anomaly" ? "anomaly" : "validator"} · {iss.code}</td>
                <td>{sevChip(iss.severity)}</td>
                <td>{iss.message || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
};

export const EditableCell: React.FC<{
  line: any; i: number; canonicalKey: string;
  type: "text" | "number"; align?: "left" | "right";
  placeholder?: string;
  canEditLines: boolean;
  extractionIndex: ExtractionIndex;
  onEditLine: (i: number, canonicalKey: string, value: any) => void;
  recordFieldCorrection: (i: number, canonicalKey: string, before: string, after: string) => void;
}> = ({ line, i, canonicalKey, type, align, placeholder, canEditLines, extractionIndex, onEditLine, recordFieldCorrection }) => {
  const src = getFieldSource(line, canonicalKey);
  const raw = LINE_ALIAS[canonicalKey]
    .map((k) => line[k])
    .find((v) => v != null && v !== "");
  const value = raw == null ? "" : String(raw);
  // Snapshot the value at focus so blur can tell whether the operator
  // actually changed it (and feed the docai correction loop only when
  // they did).
  const focusValue = React.useRef<string>(value);
  // Tighter input styling: no implicit browser styling, no outline
  // ring, no min-width that would render an empty box for short / blank
  // values. The cell shows the value as plain text until clicked; the
  // hairline appears on focus.
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: align === "right" ? "flex-end" : "flex-start" }}>
      <input
        className={align === "right" ? "input mono-sm r" : "input mono-sm"}
        style={{
          background: "transparent",
          border: "1px solid transparent",
          outline: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          appearance: "none" as any,
          padding: "2px 4px",
          textAlign: align === "right" ? "right" : "left",
          width: "100%",
          minWidth: 0,
          boxShadow: "none",
        }}
        value={value}
        placeholder={placeholder || ""}
        disabled={!canEditLines}
        onFocus={(e) => {
          focusValue.current = value;
          e.currentTarget.style.border = "1px solid var(--hairline-2)";
          e.currentTarget.style.background = "var(--paper)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = "1px solid transparent";
          e.currentTarget.style.background = "transparent";
          recordFieldCorrection(i, canonicalKey, focusValue.current, e.currentTarget.value);
        }}
        onChange={(e) => {
          const v = type === "number"
            ? (e.target.value === "" ? null : Number(e.target.value))
            : e.target.value;
          onEditLine(i, canonicalKey, v);
        }}
      />
      {src && <FieldPill src={src} />}
      <ProvenanceChip canonicalKey={canonicalKey} lineIndex={i} extractionIndex={extractionIndex} />
    </div>
  );
};
