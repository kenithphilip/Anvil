// Auto-reconcile a received PO/SO against the customer's quotes.
//
// The operator never hunts for the matching quote: given the order's PO
// lines and the POOL of the customer's quote lines (across ALL their
// quotes), this matches each PO line by part number, enriches it with the
// quoted HSN / discounted rate / tax / source, stamps which quote priced
// it, and emits a verification report:
//   - qualitative: did the part match a quote line at all (exact vs
//     normalized), and does the description agree.
//   - quantitative: does the PO's unit price match the quoted price
//     (price_mismatch beyond tolerance), and note qty differences.
//
// Pure (no I/O) so it is unit-testable; orders/reconcile_quotes.js does
// the fetch and persistence.

const normPart = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
const num = (v) => (v == null || v === "" ? null : Number(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Lightweight token overlap for the qualitative description check (0..1).
const descAgreement = (a, b) => {
  const t = (s) => new Set(String(s || "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 2));
  const A = t(a), B = t(b);
  if (!A.size || !B.size) return null;
  let hit = 0; A.forEach((w) => { if (B.has(w)) hit += 1; });
  return round2(hit / Math.min(A.size, B.size));
};

// quoteLines: quote_line rows, each augmented with _quote_id, _quote_number,
// _quote_created_at. Pre-sort by preference (most recent first) — first
// occurrence of a part wins; a part seen in >1 quote is flagged ambiguous.
const indexQuoteLines = (quoteLines) => {
  const byPart = new Map();
  const ambiguous = new Set();
  for (const q of quoteLines || []) {
    const key = normPart(q.part_no);
    if (!key) continue;
    if (byPart.has(key)) {
      // Another quote already priced this part -> ambiguous, keep the
      // first (preferred) one but record the conflict.
      if (byPart.get(key)._quote_id !== q._quote_id) ambiguous.add(key);
      continue;
    }
    byPart.set(key, q);
  }
  return { byPart, ambiguous };
};

// opts.priceTolerancePct: allowed |PO rate - quote rate| before flagging
// a price_mismatch (default 0.5%).
export const reconcilePoAgainstQuotes = (orderLines, quoteLines, opts = {}) => {
  const tol = opts.priceTolerancePct != null ? Number(opts.priceTolerancePct) : 0.5;
  const { byPart, ambiguous } = indexQuoteLines(quoteLines);
  const quotesUsed = new Map();
  const summary = { total: 0, matched: 0, price_mismatch: 0, qty_note: 0, unmatched: 0 };

  const lines = (orderLines || []).map((ln, i) => {
    summary.total += 1;
    const key = normPart(pick(ln.part_no, ln.partNumber, ln.itemCode));
    const q = key ? byPart.get(key) : null;
    const poRate = num(pick(ln.discounted_unit_price, ln.rate, ln.unit_price, ln.unitPrice, ln.ex_price));
    const poQty = num(pick(ln.qty, ln.quantity));

    if (!q) {
      summary.unmatched += 1;
      return { ...ln, _match: { verdict: "unmatched", part_no: pick(ln.part_no, ln.partNumber) || null } };
    }

    const quoteRate = num(q.discounted_unit_price) != null ? num(q.discounted_unit_price) : num(q.listed_unit_price);
    const quoteQty = num(q.qty);
    const deltaPct = (poRate != null && quoteRate) ? round2(((poRate - quoteRate) / quoteRate) * 100) : null;
    const priceMismatch = deltaPct != null && Math.abs(deltaPct) > tol;
    const qtyNote = poQty != null && quoteQty != null && poQty !== quoteQty;

    let verdict = "matched";
    if (priceMismatch) { verdict = "price_mismatch"; summary.price_mismatch += 1; }
    else { summary.matched += 1; if (qtyNote) summary.qty_note += 1; }

    quotesUsed.set(q._quote_id, {
      quote_id: q._quote_id, quote_number: q._quote_number,
      lines_matched: (quotesUsed.get(q._quote_id)?.lines_matched || 0) + 1,
    });

    const enriched = {
      ...ln,
      // Quote-authoritative pricing / tax / classification:
      hsn: pick(ln.hsn, q.hsn_sac) || null,
      discounted_unit_price: quoteRate,
      source_country: pick(ln.source_country, q.source_country) || null,
      discount_pct: q.discount_pct != null ? Number(q.discount_pct) : (ln.discount_pct ?? null),
      cgst_pct: q.cgst_pct != null ? Number(q.cgst_pct) : (ln.cgst_pct ?? null),
      sgst_pct: q.sgst_pct != null ? Number(q.sgst_pct) : (ln.sgst_pct ?? null),
      igst_pct: q.igst_pct != null ? Number(q.igst_pct) : (ln.igst_pct ?? null),
      // Keep the PO's own customer item no (the SO "Cust Part No"); only
      // fall back to the quote's if the PO didn't carry one.
      customer_part_number: pick(ln.customer_part_number, q.customer_part_number) || null,
      // Per-line provenance — which quote priced this line.
      source_quote_id: q._quote_id,
      source_quote_number: q._quote_number,
      _match: {
        verdict,
        part_no: pick(ln.part_no, ln.partNumber) || null,
        exact: String(pick(ln.part_no, ln.partNumber) || "") === String(q.part_no || ""),
        po_rate: poRate, quote_rate: quoteRate, price_delta_pct: deltaPct,
        po_qty: poQty, quote_qty: quoteQty, qty_note: qtyNote,
        desc_agreement: descAgreement(pick(ln.description, ln.itemName), q.description),
        ambiguous: ambiguous.has(key),
        source_quote_number: q._quote_number,
      },
    };
    return enriched;
  });

  return {
    lines,
    summary,
    quotes_used: Array.from(quotesUsed.values()).sort((a, b) => b.lines_matched - a.lines_matched),
    ambiguous_parts: Array.from(ambiguous),
    // Exceptions the operator should look at (everything that isn't a clean match).
    flags: lines
      .filter((l) => l._match && l._match.verdict !== "matched")
      .map((l) => ({
        line_no: l.line_no ?? null,
        part_no: l._match.part_no,
        verdict: l._match.verdict,
        po_rate: l._match.po_rate ?? null,
        quote_rate: l._match.quote_rate ?? null,
        price_delta_pct: l._match.price_delta_pct ?? null,
        source_quote_number: l._match.source_quote_number ?? null,
      })),
  };
};

// local helper (kept last so the file reads top-down)
function pick(...vals) { return vals.find((v) => v != null && v !== ""); }
