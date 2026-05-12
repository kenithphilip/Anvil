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
  hsn: ["hsn", "hsn_sac"],
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
