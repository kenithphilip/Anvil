// Turning a "quoted but not ordered" gap into a line the operator can act on.
//
// P3's reverse walk reports each quoted part the customer's PO does not
// contain, carrying the agreed commercial terms. Until now an operator read
// that report and re-typed it into the grid — copying a part number and a price
// by hand, which is exactly the kind of transcription this product exists to
// remove.
//
// WHAT THIS LINE MEANS, AND WHY IT IS NOT ORDINARY
//
// The values come from the QUOTE, not from the customer's PO. The buyer has not
// ordered this. So the line is stamped `quote_variance`, which:
//   - renders as "not on PO" rather than "added" in the grid
//   - is refused by the Tally push with quote_variance_unresolved
//   - survives re-extraction (mergeExtractedLines), because extraction can
//     never find a line that is not in the document
//
// It resolves one of two ways, both human: the customer issues an amended PO
// (extraction then reports the line itself and the operator's copy is
// superseded), or the short order is accepted and the line removed.

export interface QuoteGap {
  part_no?: string | null;
  description?: string | null;
  qty?: number | null;
  unit_price?: number | null;
  uom?: string | null;
  hsn?: string | null;
  customer_part_number?: string | null;
  source_quote_id?: string | null;
  source_quote_number?: string | null;
}

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  return s ? s : null;
};
const numOrNull = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Build the line to seed into the draft.
//
// Field names match what the recon grid and the Tally emitter read — the same
// canonical vocabulary the adapter boundary conforms every extractor to. Both
// spellings of quantity and rate are written, because different consumers still
// read different aliases and a variance line must not be the one that trips
// over that.
export const varianceLineFromGap = (gap: QuoteGap | null | undefined): Record<string, unknown> | null => {
  if (!gap) return null;
  const part = clean(gap.part_no);
  const desc = clean(gap.description);
  // A gap with neither an identity nor a description cannot become a usable
  // line — seeding a blank row here would just be a confusing empty entry.
  if (!part && !desc) return null;

  const qty = numOrNull(gap.qty);
  const rate = numOrNull(gap.unit_price);

  return {
    _origin: "quote_variance",
    _added_at: new Date().toISOString(),
    // Provenance: which quote says this is owed. An operator asked to justify
    // the line months later should not have to reconstruct that.
    _variance_source: {
      quote_id: clean(gap.source_quote_id),
      quote_number: clean(gap.source_quote_number),
    },
    partNumber: part,
    itemCode: part,
    customerItemCode: clean(gap.customer_part_number),
    description: desc,
    quantity: qty,
    qty,
    unitPrice: rate,
    rate,
    uom: clean(gap.uom),
    hsn: clean(gap.hsn),
  };
};

// Which reported gaps are still outstanding.
//
// Once a variance line exists on the order for a part, the gap is being acted
// on and must stop offering itself — otherwise an operator clicking twice
// silently double-orders. Matching is on the normalised part number, the same
// key the reconciliation engine uses in both directions.
const normPart = (v: unknown): string =>
  String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const outstandingGaps = (
  gaps: QuoteGap[] | null | undefined,
  lines: Array<Record<string, unknown>> | null | undefined,
): QuoteGap[] => {
  const present = new Set<string>();
  for (const l of lines || []) {
    const k = normPart(l?.partNumber ?? l?.itemCode ?? l?.part_no);
    if (k) present.add(k);
  }
  return (gaps || []).filter((g) => {
    const k = normPart(g?.part_no);
    // A gap with no part number can never be matched against a line, so it
    // stays offered rather than silently disappearing.
    return !k || !present.has(k);
  });
};
