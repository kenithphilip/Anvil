// Side-by-side document review pane for the SO Workspace.
//
// Phase A (this file): READ-ONLY split view.
//   Left  60%: source document (PDF rendered via native <embed>, image
//              via <img>, other mime types via a download fallback).
//   Right 40%: extracted-field list grouped by namespace
//              (customer / order / lines / totals / seller / other)
//              with a colour-coded vertical stripe per field, so the
//              operator can pattern-match groups at a glance.
//
// The pane is purely additive: it sits behind a new "Review" tab on
// the workspace and is only mounted when that tab is active. Other
// tabs, existing data flow, and the upload/extract/approval paths are
// untouched.
//
// What this file is NOT yet:
//   - It does NOT overlay bboxes on the rendered PDF. Native <embed>
//     is opaque; we'll switch to PDF.js / react-pdf when Phase B adds
//     bidirectional click-to-locate.
//   - It does NOT mutate the order. Per-field confirm/flag and the
//     correction drawer are Phase C.
//   - It does NOT integrate the template-anchor preview or live
//     extraction stream. Those are Phase D.
//
// Stable hooks for the next phases:
//   - Every field row carries `data-field-path` so a Phase B selection
//     context can wire field<->bbox highlighting without touching this
//     file's render tree.
//   - The colour-group mapping is exported (`FIELD_GROUPS`,
//     `groupForFieldPath`) so the Phase B BboxOverlay can paint each
//     bbox in the same colour as its field row.

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Chip } from "../lib/primitives";
import { Icon } from "../lib/icons";
import { ObaraBackend } from "../lib/api";
import {
  ReviewPaneSelectionProvider,
  useReviewPaneSelection,
} from "./ReviewPaneContext";
import type { EvidenceBbox } from "./PdfPagePreview";

// Lazy-load PdfPagePreview so the ~280KB pdfjs payload only lands in
// the chunk that mounts when the Review tab opens a PDF. Other
// screens, and the Review tab on image-only documents, do not pay
// the bundle cost.
const PdfPagePreview = lazy(() => import("./PdfPagePreview"));

// Shape of an entry in `orders.evidence_by_field`. Kept loose because
// historical orders may have rows missing `page`, `line`, or `confidence`.
export interface EvidenceEntry {
  value?: unknown;
  page?: number | null;
  line?: number | null;
  confidence?: number | null;
  // "template" when the value came from a deterministic
  // customer_format_templates anchor, "llm" when the model extracted
  // it. Drives the dotted-vs-solid field stripe so the operator can
  // tell pattern-matched fields (this customer has been seen before)
  // from fresh LLM guesses.
  source?: "template" | "llm" | "ocr" | null;
}
export type EvidenceByField = Record<string, EvidenceEntry | null | undefined>;

// Group → token name in styles.css. Each token defines the stripe
// colour AND (in Phase B) the matching bbox stroke colour, so the
// operator sees the same hue for a field and its source rectangle.
export const FIELD_GROUPS = {
  customer: { label: "Customer",    cssVar: "--lapis" },
  order:    { label: "Order",       cssVar: "--plum"  },
  lines:    { label: "Line items",  cssVar: "--accent-2" },
  totals:   { label: "Totals",      cssVar: "--amber" },
  seller:   { label: "Seller",      cssVar: "--sage"  },
  other:    { label: "Other",       cssVar: "--ink-4" },
} as const;
export type FieldGroupId = keyof typeof FIELD_GROUPS;

// Resolve the first dotted/bracketed segment of a field path to a
// group. Tolerates the existing path conventions: `customer.gstin`,
// `lines[3].partNumber`, `totals.grand_inr`, `seller.name`,
// `order.po_number`. Anything unrecognised falls through to "other".
export const groupForFieldPath = (path: string): FieldGroupId => {
  const head = String(path || "").split(".")[0].split("[")[0].toLowerCase();
  if (head === "customer" || head === "buyer") return "customer";
  if (head === "order" || head === "header" || head === "po") return "order";
  if (head === "lines" || head === "line" || head === "items") return "lines";
  if (head === "totals" || head === "total" || head === "grand") return "totals";
  if (head === "seller" || head === "vendor" || head === "supplier") return "seller";
  return "other";
};

const formatValue = (v: unknown): string => {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  try { return JSON.stringify(v); } catch (_) { return String(v); }
};

const formatPageLine = (e: EvidenceEntry | null | undefined): string => {
  if (!e) return "";
  if (e.page == null && e.line == null) return "";
  if (e.page != null && e.line != null) return `p${e.page}·l${e.line}`;
  if (e.page != null) return `p${e.page}`;
  return `l${e.line}`;
};

const confidenceChipKind = (c: number | null | undefined): "good" | "info" | "warn" | "bad" | "ghost" => {
  if (c == null) return "ghost";
  if (c >= 0.9)  return "good";
  if (c >= 0.7)  return "info";
  if (c >= 0.5)  return "warn";
  return "bad";
};

// Internal hook: resolve the document's signed download URL.
// Refreshes at 9 minutes (the API issues 10-minute URLs). Bails to
// `{ url: null, error }` when no docId is supplied or the fetch fails,
// so the parent can render a graceful empty state.
interface DocResolution {
  url: string | null;
  mime: string | null;
  filename: string | null;
  loading: boolean;
  error: Error | null;
}
const useSignedDoc = (docId: string | null | undefined): DocResolution => {
  const [state, setState] = useState<DocResolution>({
    url: null, mime: null, filename: null, loading: !!docId, error: null,
  });
  useEffect(() => {
    if (!docId) {
      setState({ url: null, mime: null, filename: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let refreshTimer: number | undefined;
    const load = async () => {
      try {
        const doc: any = await ObaraBackend?.documents?.fetch?.(docId);
        if (cancelled) return;
        setState({
          url: doc?.downloadUrl || null,
          mime: doc?.mime_type || doc?.mimeType || null,
          filename: doc?.filename || null,
          loading: false,
          error: null,
        });
        // Re-sign at 9 minutes to avoid the URL expiring while the
        // operator is mid-review.
        refreshTimer = window.setTimeout(load, 9 * 60 * 1000) as unknown as number;
      } catch (error: any) {
        if (cancelled) return;
        setState({ url: null, mime: null, filename: null, loading: false, error });
      }
    };
    setState((s) => ({ ...s, loading: true }));
    load();
    return () => {
      cancelled = true;
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [docId]);
  return state;
};

const FieldRow: React.FC<{
  path: string;
  entry: EvidenceEntry;
  group: FieldGroupId;
}> = ({ path, entry, group }) => {
  const {
    hoveredField, selectedField, setHoveredField, setSelectedField,
    statusOf, setFieldStatus, canCorrect, submitCorrection,
  } = useReviewPaneSelection();
  const rowRef = useRef<HTMLDivElement | null>(null);
  const isActive = path === hoveredField || path === selectedField;
  const status = statusOf(path);
  // Phase C: inline correction editor state. Opens when the operator
  // flags a field; prefilled with the extracted value so a small typo
  // fix is one edit away.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // When the bbox side (the SVG overlay on the PDF) selects this
  // field, scroll the row into view so the operator does not have to
  // hunt for it in the right pane. Skipped on mere hover to avoid
  // jumpy scrolling.
  useEffect(() => {
    if (path !== selectedField || !rowRef.current) return;
    rowRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [path, selectedField]);
  const stripeColour = `var(${FIELD_GROUPS[group].cssVar})`;
  const pageLine = formatPageLine(entry);
  const conf = entry?.confidence ?? null;
  // Template-anchored fields get a dotted stripe (deterministic
  // pattern-match: this customer's PO has been seen before) vs a solid
  // stripe for LLM-extracted fields. A dotted stripe quietly absent on
  // a field that's usually anchored is the operator's first hint that
  // the customer's PO format has drifted.
  const isTemplate = entry?.source === "template";
  const stripeStyle: React.CSSProperties = isTemplate
    ? { backgroundImage: `repeating-linear-gradient(to bottom, ${stripeColour} 0 3px, transparent 3px 6px)` }
    : { background: stripeColour };

  const onConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFieldStatus(path, status === "confirmed" ? "pending" : "confirmed");
    setEditing(false);
  };
  const onFlag = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === "flagged") { setFieldStatus(path, "pending"); setEditing(false); return; }
    setFieldStatus(path, "flagged");
    setDraft(formatValue(entry?.value));
    setEditing(true);
  };
  const onSaveCorrection = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    const res = await submitCorrection({
      fieldPath: path,
      originalValue: entry?.value ?? null,
      correctedValue: draft,
      reason: "operator flagged on Review tab",
    });
    setSaving(false);
    if (res.ok) {
      (window as any).notifySuccess?.("Correction saved", path + " → " + draft);
      setEditing(false);
    } else {
      (window as any).notifyError?.("Could not save correction", res.error || "unknown error");
    }
  };

  // Phase D: confidence wash. Only un-verified (pending) rows get a
  // tint, and only when confidence is below the comfortable band, so
  // the operator's eye is drawn to the fields that actually need a
  // look. Confirmed/flagged rows keep their Phase C status tint.
  const confBand = status !== "pending" || conf == null
    ? ""
    : conf < 0.5 ? " rp-conf-low"
      : conf < 0.7 ? " rp-conf-mid"
        : "";
  return (
    <div
      ref={rowRef}
      data-field-path={path}
      data-field-group={group}
      data-field-status={status}
      className={"rp-field-row rp-status-" + status + confBand + (isActive ? " is-active" : "")}
      onMouseEnter={() => setHoveredField(path)}
      onMouseLeave={() => setHoveredField(null)}
      onClick={() => setSelectedField(path === selectedField ? null : path)}
    >
      <span
        className={"rp-field-stripe" + (isTemplate ? " rp-field-stripe-anchored" : "")}
        style={stripeStyle}
        aria-hidden="true"
      />
      <div className="rp-field-body">
        <div className="rp-field-name mono-sm" title={path}>
          {path}
          {isTemplate && (
            <span className="rp-anchor-badge" title="Pulled by a saved per-customer template anchor (deterministic, not the LLM)">anchor</span>
          )}
        </div>
        <div className="rp-field-value">{formatValue(entry?.value)}</div>
        {editing && (
          <div className="rp-field-edit" onClick={(e) => e.stopPropagation()}>
            <input
              className="input mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="corrected value"
              aria-label={"Corrected value for " + path}
            />
            <button type="button" className="btn primary sm" disabled={saving || !canCorrect} onClick={onSaveCorrection}
              title={canCorrect ? "Save this correction (feeds the per-customer learning loop)" : "Needs sales_manager / finance / admin to persist corrections"}>
              {saving ? "saving…" : "save fix"}
            </button>
            <button type="button" className="btn ghost sm" disabled={saving} onClick={(e) => { e.stopPropagation(); setEditing(false); }}>
              cancel
            </button>
          </div>
        )}
      </div>
      <div className="rp-field-meta">
        {pageLine && <span className="mono-sm" style={{ color: "var(--ink-4)" }}>{pageLine}</span>}
        {conf != null && (
          <Chip k={confidenceChipKind(conf)}>{Math.round(conf * 100)}%</Chip>
        )}
        <div className="rp-field-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={"rp-act rp-act-confirm" + (status === "confirmed" ? " on" : "")}
            onClick={onConfirm}
            aria-pressed={status === "confirmed"}
            title="Confirm this field is correct"
          >✓</button>
          <button
            type="button"
            className={"rp-act rp-act-flag" + (status === "flagged" ? " on" : "")}
            onClick={onFlag}
            aria-pressed={status === "flagged"}
            title="Flag this field as wrong and correct it"
          >!</button>
        </div>
      </div>
    </div>
  );
};

const FieldGroupSection: React.FC<{
  group: FieldGroupId;
  entries: Array<[string, EvidenceEntry]>;
}> = ({ group, entries }) => {
  if (!entries.length) return null;
  const meta = FIELD_GROUPS[group];
  return (
    <section className="rp-field-group" aria-label={meta.label}>
      <header className="rp-field-group-header">
        <span className="rp-field-group-swatch" style={{ background: `var(${meta.cssVar})` }} aria-hidden="true" />
        <span className="rp-field-group-label">{meta.label}</span>
        <span className="rp-field-group-count mono-sm">{entries.length}</span>
      </header>
      {entries.map(([path, entry]) => (
        <FieldRow key={path} path={path} entry={entry} group={group} />
      ))}
    </section>
  );
};

// ErrorBoundary that catches a PdfPagePreview crash (worker failure,
// corrupt PDF, etc.) and lets the parent fall back to the opaque
// native <embed>. Localised so other parts of the workspace never
// see the boundary.
class PdfErrorBoundary extends React.Component<
  { onError: () => void; children: React.ReactNode },
  { errored: boolean }
> {
  constructor(props: { onError: () => void; children: React.ReactNode }) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError() { return { errored: true }; }
  componentDidCatch() { this.props.onError(); }
  render() { return this.state.errored ? null : this.props.children; }
}

// Render whichever preview matches the document mime. PDFs prefer
// PdfPagePreview (PDF.js + bbox overlays); if that fails for any
// reason we fall through to the opaque-but-reliable native <embed>
// so the operator never loses access to the source document.
// Images render with <img>. Other mimes fall back to a download link.
interface DocumentPreviewProps {
  doc: DocResolution;
  evidenceRows: EvidenceBbox[];
  colourForField: (fieldPath: string) => string;
}
const DocumentPreview: React.FC<DocumentPreviewProps> = ({ doc, evidenceRows, colourForField }) => {
  // Tracks whether the PDF.js path crashed; once flipped we render
  // the native <embed> for the remainder of this component's life.
  const [pdfFailed, setPdfFailed] = useState(false);

  if (doc.loading) {
    return (
      <div className="rp-pdf-loading mono-sm">
        Loading document preview…
      </div>
    );
  }
  if (doc.error) {
    return (
      <Banner kind="bad" icon={Icon.alert} title="Could not load document">
        <span className="mono-sm">{String(doc.error.message || doc.error)}</span>
      </Banner>
    );
  }
  if (!doc.url) {
    return (
      <Banner kind="info" icon={Icon.alert} title="No source document attached">
        <span className="mono-sm">
          This order has no PO file. Attach one from intake to enable the
          side-by-side review.
        </span>
      </Banner>
    );
  }
  const mime = (doc.mime || "").toLowerCase();
  const isPdf = mime === "application/pdf" || /\.pdf(\?|$)/i.test(doc.url);
  if (isPdf) {
    if (pdfFailed) {
      // PDF.js bailed; native viewer keeps the document accessible
      // even though we can no longer overlay bboxes on it.
      return (
        <embed
          src={doc.url}
          type="application/pdf"
          title={doc.filename || "Source PO"}
          className="rp-pdf-embed"
        />
      );
    }
    return (
      <PdfErrorBoundary onError={() => setPdfFailed(true)}>
        <Suspense fallback={<div className="rp-pdf-loading mono-sm">Loading PDF viewer…</div>}>
          <PdfPagePreview
            url={doc.url}
            filename={doc.filename}
            evidenceRows={evidenceRows}
            colourForField={colourForField}
          />
        </Suspense>
      </PdfErrorBoundary>
    );
  }
  if (mime.startsWith("image/") || /\.(png|jpe?g|webp|tiff?|gif|bmp)(\?|$)/i.test(doc.url)) {
    return (
      <div className="rp-image-wrap">
        <img src={doc.url} alt={doc.filename || "Source PO"} className="rp-image" />
      </div>
    );
  }
  // Unsupported preview type (DOCX, XLSX, ZIP, ...). Don't pretend
  // we can render it; offer the download link the operator already
  // has via the documents library.
  return (
    <Banner kind="info" icon={Icon.alert} title="Preview not supported for this file type">
      <span className="mono-sm">
        Open it directly: <a href={doc.url} target="_blank" rel="noopener noreferrer">{doc.filename || "download"}</a>
      </span>
    </Banner>
  );
};

// Internal hook: fetch the document's per-token bbox evidence rows
// (from the Mistral OCR pipeline at /api/documents/<id>/evidence)
// alongside the order's flat evidence_by_field map. Used in Phase B
// to paint clickable rectangles on the rendered PDF/image. Bails to
// an empty array when no docId is supplied or the fetch fails, so
// the caller can render fields without overlays in those cases.
const useDocumentEvidence = (docId: string | null | undefined): EvidenceBbox[] => {
  const [rows, setRows] = useState<EvidenceBbox[]>([]);
  useEffect(() => {
    if (!docId) { setRows([]); return; }
    let cancelled = false;
    Promise.resolve(ObaraBackend?.documents?.evidence?.(docId))
      .then((resp: any) => {
        if (cancelled) return;
        const list: any[] = Array.isArray(resp?.rows) ? resp.rows : [];
        // Filter to rows with usable bboxes; a row without geometry
        // cannot be highlighted on the page so it's dead weight in
        // the overlay loop.
        setRows(list.filter((r) => r && r.bbox && r.bbox.page_width && r.bbox.page_height));
      })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [docId]);
  return rows;
};

interface ReviewPaneProps {
  docId: string | null | undefined;
  evidenceByField: EvidenceByField | null | undefined;
  // Phase C: the run a correction attaches to, and whether the
  // current role may persist corrections (approve permission).
  extractionRunId?: string | null;
  canCorrect?: boolean;
}

const ReviewPaneInner: React.FC<ReviewPaneProps> = ({ docId, evidenceByField }) => {
  const doc = useSignedDoc(docId);
  const evidenceRows = useDocumentEvidence(docId);
  const { counts, confirmAll, selectedField, setSelectedField, setFieldStatus } = useReviewPaneSelection();

  // Group + stable-sort fields once per render. Sorted alphabetically
  // within each group so the operator can predict where a field will
  // be on subsequent visits.
  const grouped = useMemo(() => {
    const buckets: Record<FieldGroupId, Array<[string, EvidenceEntry]>> = {
      customer: [], order: [], lines: [], totals: [], seller: [], other: [],
    };
    const map = evidenceByField || {};
    for (const [path, entry] of Object.entries(map)) {
      if (!entry) continue;
      buckets[groupForFieldPath(path)].push([path, entry as EvidenceEntry]);
    }
    (Object.keys(buckets) as FieldGroupId[]).forEach((g) =>
      buckets[g].sort(([a], [b]) => a.localeCompare(b))
    );
    return buckets;
  }, [evidenceByField]);

  const totalFields = useMemo(
    () => (Object.values(grouped) as Array<Array<unknown>>).reduce((s, arr) => s + arr.length, 0),
    [grouped]
  );

  // Flat list of every field path, for the verification progress
  // counter + the "mark all correct" bulk action.
  const allPaths = useMemo(
    () => (Object.values(grouped) as Array<Array<[string, EvidenceEntry]>>).flatMap((arr) => arr.map(([p]) => p)),
    [grouped]
  );
  const c = counts(allPaths);

  // Phase D: keyboard navigation. Mounts only while the Review tab is
  // open (this component unmounts on tab change), so the listener is
  // naturally scoped. Ignored while the operator is typing in the
  // inline corrector. J/K (or arrows) move a cursor through the field
  // list; Y/N confirm/flag the cursor row; Cmd/Ctrl+Enter marks all
  // correct; Escape clears the cursor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      if (!allPaths.length) return;
      const idx = selectedField ? allPaths.indexOf(selectedField) : -1;
      const move = (delta: number) => {
        const next = idx < 0 ? (delta > 0 ? 0 : allPaths.length - 1) : (idx + delta + allPaths.length) % allPaths.length;
        setSelectedField(allPaths[next]);
      };
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (k === "y" && selectedField) { e.preventDefault(); setFieldStatus(selectedField, "confirmed"); }
      else if (k === "n" && selectedField) { e.preventDefault(); setFieldStatus(selectedField, "flagged"); }
      else if (k === "enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); confirmAll(allPaths); }
      else if (e.key === "Escape" && selectedField) { setSelectedField(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allPaths, selectedField, setSelectedField, setFieldStatus, confirmAll]);

  // Stable colour function passed to the PDF overlay so each bbox
  // adopts the same hue as the corresponding field-list group.
  const colourForField = useCallback(
    (fieldPath: string) => `var(${FIELD_GROUPS[groupForFieldPath(fieldPath)].cssVar})`,
    [],
  );

  return (
    <div className="rp-grid">
      {/* Left: source document preview. */}
      <div className="rp-pane rp-pane-doc">
        <header className="rp-pane-header">
          <span className="h-eyebrow">Source document</span>
          {doc.filename && <span className="mono-sm" style={{ color: "var(--ink-3)" }}>{doc.filename}</span>}
        </header>
        <div className="rp-pane-body rp-pane-body-doc">
          <DocumentPreview
            doc={doc}
            evidenceRows={evidenceRows}
            colourForField={colourForField}
          />
        </div>
      </div>

      {/* Right: extracted-field list, grouped. */}
      <div className="rp-pane rp-pane-fields">
        <header className="rp-pane-header">
          <span className="h-eyebrow">Extracted fields</span>
          <span className="mono-sm" style={{ color: "var(--ink-3)" }}>
            {totalFields} {totalFields === 1 ? "field" : "fields"}
          </span>
        </header>
        {totalFields > 0 && (
          <div className="rp-verify-bar">
            <div className="rp-verify-progress" aria-hidden="true">
              <span
                className="rp-verify-progress-fill"
                style={{ width: `${c.total ? Math.round((c.confirmed / c.total) * 100) : 0}%` }}
              />
            </div>
            <span className="mono-sm rp-verify-count">
              {c.confirmed}/{c.total} confirmed{c.flagged ? ` · ${c.flagged} flagged` : ""}
            </span>
            <button
              type="button"
              className="btn ghost sm"
              disabled={c.pending === 0}
              onClick={() => confirmAll(allPaths)}
              title="Mark every still-pending field as correct"
            >
              {Icon.check} mark all correct
            </button>
            <span className="mono-sm rp-kbd-hint" title="Keyboard: J/K move · Y confirm · N flag · ⌘↵ all">
              J/K · Y · N
            </span>
          </div>
        )}
        <div className="rp-pane-body">
          {totalFields === 0 ? (
            <div className="mono-sm" style={{ color: "var(--ink-3)", padding: 16 }}>
              No extracted fields yet. Once extraction runs, every
              recognised field appears here with its source page and a
              confidence score.
            </div>
          ) : (
            <>
              <FieldGroupSection group="customer" entries={grouped.customer} />
              <FieldGroupSection group="order"    entries={grouped.order} />
              <FieldGroupSection group="lines"    entries={grouped.lines} />
              <FieldGroupSection group="totals"   entries={grouped.totals} />
              <FieldGroupSection group="seller"   entries={grouped.seller} />
              <FieldGroupSection group="other"    entries={grouped.other} />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const ReviewPane: React.FC<ReviewPaneProps> = (props) => (
  <ReviewPaneSelectionProvider canCorrect={!!props.canCorrect} extractionRunId={props.extractionRunId ?? null}>
    <ReviewPaneInner {...props} />
  </ReviewPaneSelectionProvider>
);

export default ReviewPane;
