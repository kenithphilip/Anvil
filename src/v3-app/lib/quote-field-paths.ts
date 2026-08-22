// Which quote cells an operator may correct, and where the correction lands.
//
// A correction is addressed by (extraction_run_id, field_path) and is applied
// against the run's `normalized_extract` — NOT against quote_lines. So the
// Quote tab, which renders quote_lines, has to translate: the operator fixes
// the cell labelled "Net", and what gets recorded is `lines[3].unitPrice`.
//
// Getting that translation wrong is not a cosmetic bug. eval/harvest-corrected
// applies each correction to the extract to build a golden fixture, so a path
// pointing at the wrong field writes a WRONG ground truth into the regression
// gate — and a poisoned golden is worse than no golden, because it fails the
// build for the model being right.
//
// Two guards, therefore:
//
//   1. Every path below is the literal property name in QUOTE_TOOL's schema
//      (_lib/docai/claude.js), not the quote_lines column name. They differ on
//      almost every field: qty→quantity, hsn_sac→hsn, discounted_unit_price→
//      unitPrice. The DB column names are the ones on screen; the schema names
//      are the ones that exist in the extract.
//
//   2. Only EXTRACTED fields appear. quote_lines also carries derived columns —
//      discount_pct is computed by quote-ingest from list and net, and
//      authored-in-Anvil quotes have no extract at all.
//
//      There is NO safety net downstream for getting this wrong. harvest-
//      corrected's pathExists deliberately stops one segment short — "the leaf
//      may be absent/null", because a correction that fills in a field the
//      model left null is the most ordinary correction there is. So it
//      validates that `lines[3]` exists and then writes whatever leaf name it
//      was given. A misspelt leaf is not skipped; it is materialised as a
//      phantom field on the golden. The map below, and the test that grounds
//      it against the extractor, ARE the guard.
//
// The ORIGINAL value is the third piece, and it does not come from the table.
// quote_lines is not a faithful copy of the extract: the ingest writes
// `listed_unit_price: list ?? governing`, so a single-price quote stores the
// net price in the list column while the extract holds null, and it appends
// " · MOQ=n" to remark. Recording a column value as `original_value` would put
// a number the model never produced into the RLHF row and into the no-op guard
// that decides whether a correction counts as one. So the route sends the
// extract's own lines and the cell reads the original from there — and a cell
// with no extract entry stays read-only rather than guessing.
//
// The row index is the other half. quote_lines.line_index is stamped by
// toQuoteLineRow(line, index) BEFORE the hollow-line filter runs, so it stays a
// faithful pointer into normalized_extract.lines[] even when the ingest drops
// rows — which is what makes `lines[${line_index}]` correct rather than merely
// usually correct. Never substitute the row's position in the rendered table.

/** How a corrected value should be typed before it is sent. */
export type QuoteFieldType = "text" | "number";

export interface QuoteFieldSpec {
  /** The quote_lines column / quotes column the UI renders. */
  column: string;
  /** The property name inside the extraction's normalized_extract. */
  extractKey: string;
  /** Column heading, for the correction control's label. */
  label: string;
  type: QuoteFieldType;
}

/** Per-line correctable fields, keyed by the quote_lines column name. */
export const QUOTE_LINE_FIELDS: QuoteFieldSpec[] = [
  { column: "part_no", extractKey: "partNumber", label: "Part", type: "text" },
  { column: "customer_part_number", extractKey: "customerPartNumber", label: "Customer part", type: "text" },
  { column: "description", extractKey: "description", label: "Description", type: "text" },
  { column: "qty", extractKey: "quantity", label: "Qty", type: "number" },
  { column: "uom", extractKey: "uom", label: "UOM", type: "text" },
  // The two price columns. #462 shipped because a quote printing a list price
  // beside a discounted one had the discounted one silently dropped, so both
  // have to be correctable — fixing only the one on screen would re-create the
  // same blind spot from the other direction.
  { column: "listed_unit_price", extractKey: "listUnitPrice", label: "List", type: "number" },
  { column: "discounted_unit_price", extractKey: "unitPrice", label: "Net", type: "number" },
  { column: "line_amount", extractKey: "amount", label: "Amount", type: "number" },
  { column: "hsn_sac", extractKey: "hsn", label: "HSN", type: "text" },
  { column: "remark", extractKey: "remark", label: "Remark", type: "text" },
  // GST is deliberately absent. The extract carries cgst_pct/sgst_pct/igst_pct
  // separately, but the table renders their SUM in one "GST" column, so a
  // correction typed there could not be attributed to a component — 18% is
  // 9+9 intra-state or 18 inter-state, and picking wrong writes a wrong
  // ground truth. Splitting the column is a display change, not a correction
  // one, so it does not belong in this change.
];

// There is deliberately no header map here. The header (quote number, currency,
// grand total) is rendered as a chip strip, not a table, so making it
// correctable is a real interaction change rather than another cell — and
// shipping a tested-but-unmounted export is the exact habit this whole effort
// exists to break. Header corrections are the next widening, not this one.

const LINE_BY_COLUMN = new Map(QUOTE_LINE_FIELDS.map((f) => [f.column, f]));

export const lineFieldFor = (column: string): QuoteFieldSpec | null =>
  LINE_BY_COLUMN.get(String(column || "")) || null;

/**
 * The field_path for a line cell — `lines[<line_index>].<extractKey>`.
 *
 * Returns null when the column is not correctable or the row carries no
 * line_index. A null line_index means the row cannot be located in the extract
 * array, so there is no honest path to write; the caller renders the cell
 * read-only rather than guessing at the row's ordinal position.
 */
export const lineFieldPath = (column: string, lineIndex: number | null | undefined): string | null => {
  const spec = lineFieldFor(column);
  if (!spec) return null;
  if (lineIndex == null || !Number.isInteger(lineIndex) || lineIndex < 0) return null;
  return `lines[${lineIndex}].${spec.extractKey}`;
};

/**
 * The result of typing an operator's draft. Shaped like ReviewPaneContext's
 * CorrectionResult — a flat { ok, error? } — because the repo compiles with
 * `strict: false`, where a discriminated union does not narrow.
 */
export interface CoercedCorrection {
  ok: boolean;
  /** The typed value, present when ok. Null means "record this field as blank". */
  value?: string | number | null;
  /** Why the draft was refused, present when not ok. */
  error?: string;
}

/**
 * Type the operator's typed string the way the extract holds it.
 *
 * The PO review pane sends the raw draft string, so a corrected price is
 * recorded as "1250" rather than 1250. That survives scoring — the scorer
 * coerces with Number() — but it lands a string in the golden's `expected`,
 * where the extract holds a number. Coercing here keeps a harvested quote
 * fixture type-faithful to the document it was built from.
 *
 * An empty draft means "this field should be null", which is a real
 * correction: the extractor inventing a value that is not on the page is a
 * defect worth recording. A number field that will not parse returns
 * { ok: false } so the caller can refuse the save rather than write NaN.
 */
export const coerceCorrection = (raw: string, type: QuoteFieldType): CoercedCorrection => {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: true, value: null };
  if (type === "number") {
    // Operators paste from a document that prints thousands separators.
    const cleaned = trimmed.replace(/,/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return { ok: false, error: "Enter a number, or clear the field to record it as blank." };
    return { ok: true, value: n };
  }
  return { ok: true, value: trimmed };
};
