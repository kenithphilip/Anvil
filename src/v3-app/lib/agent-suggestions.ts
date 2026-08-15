// Suggested actions for the Ask Anvil panel, derived from signals the screen
// ALREADY has.
//
// The alternative — asking a model what to suggest on every screen load — would
// cost a call per navigation across every module, add seconds of latency before
// the operator has asked anything, and mostly be thrown away unread. Everything
// below is computed from data the SO workspace has already fetched: zero calls,
// zero latency, and each suggestion carries the name of the check that produced
// it so the operator can tell where it came from.
//
// A suggestion is a QUESTION, not an instruction. Clicking one seeds the
// composer; nothing is sent and nothing runs until the operator hits send. The
// panel is read-only in this slice regardless.

export type Severity = "error" | "warn" | "info";

export interface Suggestion {
  id: string;
  severity: Severity;
  /** The prompt text seeded into the composer. */
  text: string;
  /** Which check produced this, shown under the chip. */
  source: string;
}

interface AnomalyLike { code?: string; severity?: string; detail?: string; actual?: unknown; expected?: unknown }
interface FindingLike { code?: string; rule_id?: string; severity?: string; message?: string; line_index?: number }

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const inr = (n: number): string => "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

const sevOf = (s?: string): Severity =>
  s === "error" ? "error" : s === "warn" || s === "warning" ? "warn" : "info";

// Anomalies carry a machine `code`, so each gets a question written for it
// rather than the raw detail string — an operator reading "line items are
// probably missing or mis-read" does not know what to ASK next.
const ANOMALY_PROMPTS: Record<string, (a: AnomalyLike) => string> = {
  printed_line_number_gap: (a) => {
    const e = num(a.expected); const g = num(a.actual);
    return e != null && g != null
      ? `The PO numbers its items to ${e} but only ${g} were extracted. Which one is missing?`
      : "The PO numbers more line items than were extracted. Which one is missing?";
  },
  document_total_shortfall: (a) => {
    const e = num(a.expected); const g = num(a.actual);
    return e != null && g != null
      ? `Extracted lines total ${inr(g)} against a printed ${inr(e)}. Where is the ${inr(e - g)} gap?`
      : "The extracted lines do not add up to the printed document total. Where is the gap?";
  },
  parser_conservation_gap: () => "The parser dropped rows it had accepted. Were any of them real line items?",
  parser_rows_misaligned: () => "Some table rows could not be aligned to the header. What was on them?",
  line_count_shortfall: () => "Fewer lines were extracted than the PO declares. Which are missing?",
  line_arithmetic_mismatch: () => "A line's amount does not match quantity × unit price. Which line, and which number is wrong?",
  unit_price_zero: () => "A line has a zero unit price. Is that a real free-of-charge item?",
  quantity_zero: () => "A line has zero quantity. Should it be there at all?",
  currency_inconsistent_with_lines: () => "The header currency disagrees with the line currency. Which is right?",
};

export const suggestionsForOrder = (input: {
  anomalies?: AnomalyLike[] | null;
  findings?: FindingLike[] | null;
  lines?: Array<Record<string, unknown>> | null;
  poNumber?: string | null;
}): Suggestion[] => {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const push = (s: Suggestion) => {
    if (seen.has(s.id)) return;      // one chip per check, however many rows tripped it
    seen.add(s.id);
    out.push(s);
  };

  for (const a of input.anomalies || []) {
    const code = String(a?.code || "");
    if (!code) continue;
    const write = ANOMALY_PROMPTS[code];
    // An unmapped anomaly still deserves a chip — a missing entry here should
    // degrade to the raw detail, not to silence.
    const text = write ? write(a) : (a.detail ? `${a.detail}. Can you explain this?` : null);
    if (!text) continue;
    push({ id: "anomaly:" + code, severity: sevOf(a.severity), text, source: code + " · anomalies" });
  }

  const findings = input.findings || [];
  if (findings.length) {
    const errs = findings.filter((f) => sevOf(f.severity) === "error").length;
    push({
      id: "findings:all",
      severity: errs ? "error" : "warn",
      text: `${findings.length} validation ${findings.length === 1 ? "issue was" : "issues were"} raised on these lines. Walk me through them.`,
      source: "rule_findings",
    });
  }

  // Unmatched lines block the whole downstream flow (pricing, Tally push), so
  // they are worth a chip even though no rule reports them as an issue.
  const lines = input.lines || [];
  const unmatched = lines.filter((l) => !l?.item_id && !l?.itemId && !l?.matched_item_id).length;
  if (lines.length && unmatched) {
    push({
      id: "lines:unmatched",
      severity: "warn",
      text: `${unmatched} of ${lines.length} lines have no item-master match. What are the closest candidates?`,
      source: "line item_id",
    });
  }

  // Always leave one thing to ask. A panel that opens empty reads as broken,
  // and this is the question an engineer opens the screen to answer anyway.
  if (!out.length) {
    push({
      id: "default:summarise",
      severity: "info",
      text: input.poNumber
        ? `Summarise PO ${input.poNumber} — totals, terms, and anything that looks off.`
        : "Summarise this order — totals, terms, and anything that looks off.",
      source: "always available",
    });
  }

  // Errors first, then warnings: the panel shows a few and the badge counts
  // them, so ordering decides what an operator sees without scrolling.
  const rank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]).slice(0, 5);
};
