// Per-field provenance helpers for OCR / human-edited values.
//
// The SO workspace reconciliation table renders line items that the
// DocAI extractor pulled off the customer's PO. Before this helper,
// every value was rendered identically whether it came from the
// extractor or the operator typed it. Two consequences:
//
//   - The operator could not tell which fields were OCR-sourced
//     and might still be wrong vs. which they had already
//     corrected. They asked for visibility.
//
//   - There was no in-place edit; corrections required re-uploading
//     the PO or hand-editing the JSON. They asked for editability.
//
// The contract:
//
//   line._field_sources?: { [canonical_key: string]: "ocr" | "human" }
//
// "ocr"   : the value came from the document extractor and has not
//           been touched by an operator. UI renders a subtle pill.
//   "human" : the value was entered or modified by an operator. UI
//             renders a slightly more prominent pill so reviewers can
//             see what got changed at a glance.
//   absent : no provenance recorded. Used for legacy lines or
//            derived columns the operator never sees a source for.
//
// Canonical keys (used across the reconciliation table):
//   itemCode, description, qty, rate, uom, hsn
//
// The same pattern works at the header level via
// `result.salesOrder._header_field_sources` for fields like
// `vendor_code` that the extractor populates and the operator can
// later override in the Header fields tab.

export type FieldSource = "ocr" | "human";

export interface WithFieldSources {
  _field_sources?: Record<string, FieldSource | undefined>;
}

const ALIASES: Record<string, ReadonlyArray<string>> = {
  itemCode: ["itemCode", "partNumber", "sku", "code"],
  description: ["description", "name", "item"],
  qty: ["qty", "quantity"],
  rate: ["rate", "unitPrice"],
  uom: ["uom", "unit"],
  hsn: ["hsn", "hsn_sac", "hsnCode"],
  // GST per-line: the extractor reports a single rate as gst_pct;
  // downstream item_master holds it as rate_of_duty_pct. The recon
  // table renders + edits this directly so the operator can see
  // exactly what tax basis the line is on before Tally push.
  gst_pct: ["gst_pct", "gstRate", "rate_of_duty_pct"],
};

// Canonical keys for the recon table; exported so tests + UI agree.
export const CANONICAL_LINE_FIELDS = Object.keys(ALIASES);

// Return the recorded provenance, if any, for a canonical field.
export const getFieldSource = (
  obj: WithFieldSources | null | undefined,
  canonicalKey: string,
): FieldSource | null => {
  if (!obj || !obj._field_sources) return null;
  const v = obj._field_sources[canonicalKey];
  return v === "ocr" || v === "human" ? v : null;
};

// Stamp every populated field on a freshly-extracted line as
// "ocr". Caller passes the canonical -> alias map (typically the
// default ALIASES). Lines that already have _field_sources are
// left as-is so a second extraction does not reset operator edits.
export const stampOcrSources = <T extends Record<string, unknown>>(
  line: T,
  aliases: Record<string, ReadonlyArray<string>> = ALIASES,
): T & WithFieldSources => {
  const existing = (line as WithFieldSources)._field_sources;
  if (existing) return line as T & WithFieldSources;
  const sources: Record<string, FieldSource> = {};
  for (const canonical of Object.keys(aliases)) {
    for (const alias of aliases[canonical]) {
      const v = line[alias];
      if (v != null && v !== "") {
        sources[canonical] = "ocr";
        break;
      }
    }
  }
  return { ...line, _field_sources: sources };
};

// Return a copy of the line with the canonical key marked as
// edited by a human. The underlying value should be updated by
// the caller; this only updates the source map.
export const markFieldEdited = <T extends WithFieldSources>(
  line: T,
  canonicalKey: string,
): T => {
  const next = { ...(line._field_sources || {}) };
  next[canonicalKey] = "human";
  return { ...line, _field_sources: next };
};

// ───────────────────────────────────────────────────────────────────
// Rich extraction provenance (Wave 4.1 operator surface).
//
// The binary ocr | human pill above answers "did a human touch this?".
// The docai pipeline also produces, per extraction_runs row:
//
//   field_provenance: [{ field, source, confidence, voters }]
//       which adapter (claude / reducto / template / …) won each field
//       and how confident it was. `field` is a dotted/indexed path like
//       "customer.gstin" or "lines[0].unitPrice".
//   validator_issues: [{ field, code, severity, message }]
//       per-field shape checks (GSTIN, currency, HSN, line math).
//   anomalies:        [{ code, severity, path, line_index?, detail }]
//       cross-field accounting checks (line arithmetic, totals, …).
//
// These helpers turn those arrays into cheap lookups the recon table
// can render per cell + per line, without the screen re-parsing paths.
// All pure; no I/O.

// Canonical recon key  ->  the token the extractor / validator uses in
// its field paths (e.g. recon "rate" is "unitPrice" in lines[N].*).
export const EXTRACTOR_FIELD: Record<string, string> = {
  itemCode: "partNumber",
  description: "description",
  qty: "quantity",
  rate: "unitPrice",
  uom: "uom",
  hsn: "hsn",
  gst_pct: "gst_pct",
};
const TOKEN_TO_CANONICAL: Record<string, string> = Object.fromEntries(
  Object.entries(EXTRACTOR_FIELD).map(([canonical, token]) => [token, canonical]),
);

export interface ProvenanceEntry {
  source: string | null;            // winning adapter, e.g. "claude"
  confidence: number | null;        // 0..1
  voters?: Array<{ adapter?: string; confidence?: number; value?: unknown }>;
}
export interface IssueEntry {
  field: string;                    // path the issue/anomaly is keyed on
  code: string;
  severity: string;                 // "error" | "warn" | "info"
  message?: string;
  kind: "validator" | "anomaly";
}
export interface ExtractionSummary {
  adapter: string | null;
  confidence: number | null;
  voterUsed: boolean;
  validator: { error: number; warn: number; info: number; total: number };
  anomalies: { error: number; warn: number; total: number };
}
export interface ExtractionIndex {
  headerProvenance: (path: string) => ProvenanceEntry | null;
  lineProvenance: (lineIndex: number, canonicalKey: string) => ProvenanceEntry | null;
  lineIssues: (lineIndex: number) => IssueEntry[];
  headerIssues: (path: string) => IssueEntry[];
  allIssues: IssueEntry[];
  summary: ExtractionSummary;
}

// Parse "lines[3].unitPrice" -> { lineIndex: 3, token: "unitPrice" }.
// Returns null for non-line paths.
const parseLinePath = (path: string): { lineIndex: number; token: string | null } | null => {
  const m = /^lines\[(\d+)\](?:\.(.+))?$/.exec(path || "");
  if (!m) return null;
  return { lineIndex: Number(m[1]), token: m[2] || null };
};

const SEVERITY_RANK: Record<string, number> = { error: 3, warn: 2, info: 1 };

// Pick the worst severity among a set of issues. "" when empty.
export const worstSeverity = (issues: ReadonlyArray<{ severity: string }>): string => {
  let best = "";
  let rank = 0;
  for (const i of issues) {
    const r = SEVERITY_RANK[i.severity] || 0;
    if (r > rank) { rank = r; best = i.severity; }
  }
  return best;
};

// Build the per-run index. `run` is an extraction_runs row (or null).
export const buildExtractionIndex = (run: any): ExtractionIndex => {
  const provByPath = new Map<string, ProvenanceEntry>();
  const issuesByLine = new Map<number, IssueEntry[]>();
  const issuesByHeader = new Map<string, IssueEntry[]>();
  const allIssues: IssueEntry[] = [];

  const provArr = Array.isArray(run?.field_provenance) ? run.field_provenance : [];
  for (const p of provArr) {
    if (p && typeof p.field === "string") {
      provByPath.set(p.field, {
        source: p.source ?? null,
        confidence: typeof p.confidence === "number" ? p.confidence : null,
        voters: Array.isArray(p.voters) ? p.voters : undefined,
      });
    }
  }

  const addIssue = (entry: IssueEntry) => {
    allIssues.push(entry);
    const parsed = parseLinePath(entry.field);
    if (parsed) {
      const list = issuesByLine.get(parsed.lineIndex) || [];
      list.push(entry);
      issuesByLine.set(parsed.lineIndex, list);
    } else {
      const list = issuesByHeader.get(entry.field) || [];
      list.push(entry);
      issuesByHeader.set(entry.field, list);
    }
  };

  const vIssues = Array.isArray(run?.validator_issues) ? run.validator_issues : [];
  for (const v of vIssues) {
    if (!v) continue;
    addIssue({
      field: String(v.field || ""),
      code: String(v.code || "issue"),
      severity: String(v.severity || "warn"),
      message: v.message,
      kind: "validator",
    });
  }

  const anomalies = Array.isArray(run?.anomalies) ? run.anomalies : [];
  for (const a of anomalies) {
    if (!a) continue;
    // Anomalies carry an explicit line_index for line checks; fall
    // back to the path so totals/header anomalies still land.
    const field = typeof a.line_index === "number"
      ? `lines[${a.line_index}]`
      : String(a.path || a.field || "order");
    addIssue({
      field,
      code: String(a.code || "anomaly"),
      severity: String(a.severity || "warn"),
      message: a.message || a.detail || undefined,
      kind: "anomaly",
    });
  }

  const vSummary = run?.validator_summary || {};
  const aSummary = run?.anomalies_summary || {};

  return {
    headerProvenance: (path) => provByPath.get(path) || null,
    lineProvenance: (lineIndex, canonicalKey) => {
      const token = EXTRACTOR_FIELD[canonicalKey] || canonicalKey;
      return provByPath.get(`lines[${lineIndex}].${token}`) || null;
    },
    lineIssues: (lineIndex) => issuesByLine.get(lineIndex) || [],
    headerIssues: (path) => issuesByHeader.get(path) || [],
    allIssues,
    summary: {
      adapter: run?.adapter_used ?? null,
      confidence: typeof run?.confidence_overall === "number" ? run.confidence_overall : null,
      voterUsed: !!run?.voter_used,
      validator: {
        error: Number(vSummary.error || 0),
        warn: Number(vSummary.warn || 0),
        info: Number(vSummary.info || 0),
        total: Number(vSummary.total || vIssues.length || 0),
      },
      anomalies: {
        error: Number(aSummary.error || 0),
        warn: Number(aSummary.warn || 0),
        total: Number(aSummary.total || anomalies.length || 0),
      },
    },
  };
};

// Issues on a line that map to a specific recon cell (so the cell can
// colour itself). Matches the validator/anomaly token to the canonical
// key via TOKEN_TO_CANONICAL.
export const issuesForCanonicalCell = (
  lineIssues: ReadonlyArray<IssueEntry>,
  canonicalKey: string,
): IssueEntry[] => {
  return lineIssues.filter((iss) => {
    const parsed = parseLinePath(iss.field);
    if (!parsed || !parsed.token) return false;
    return (TOKEN_TO_CANONICAL[parsed.token] || parsed.token) === canonicalKey;
  });
};
