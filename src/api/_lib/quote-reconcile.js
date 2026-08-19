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

// The mechanical half of this comparison now lives in _lib/line-compare.js so
// the PO-vs-invoice check can share it. These four moved VERBATIM — same
// implementations, same edge cases — so nothing about this module's behaviour
// changes. What stayed here is everything that is actually about quotes.
import {
  normPart, num, round2, pick, descAgreement, DESC_AGREEMENT_FLOOR,
} from "./line-compare.js";

// Lightweight token overlap for the qualitative description check (0..1).

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

// Extract a credit-period day count from a free-text payment-terms string.
// "30 Days credit" -> 30, "Net 45" -> 45, "PAYMENT : 60 days" -> 60.
// Returns null when no day figure is present (advance / against-delivery /
// letter-of-credit style terms fall back to a normalized string compare).
export const extractPaymentDays = (s) => {
  const str = String(s == null ? "" : s).toLowerCase();
  if (!str.trim()) return null;
  let m = str.match(/(\d+)\s*days?\b/);
  if (m) return parseInt(m[1], 10);
  m = str.match(/\bnet\s*(\d+)\b/);
  if (m) return parseInt(m[1], 10);
  return null;
};

const normTerms = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();

// Header-level commercial check: does the PO's payment terms agree with
// the quote's? Compares credit days when both are numeric, else a
// normalized string compare. verdict: match | mismatch | unknown.
export const comparePaymentTerms = (poTerms, quoteTerms) => {
  const poDays = extractPaymentDays(poTerms);
  const quoteDays = extractPaymentDays(quoteTerms);
  const has = (v) => v != null && String(v).trim() !== "";
  let verdict;
  if (!has(poTerms) || !has(quoteTerms)) verdict = "unknown";
  else if (poDays != null && quoteDays != null) verdict = poDays === quoteDays ? "match" : "mismatch";
  else verdict = normTerms(poTerms) === normTerms(quoteTerms) ? "match" : "mismatch";
  return {
    po_terms: has(poTerms) ? String(poTerms) : null,
    quote_terms: has(quoteTerms) ? String(quoteTerms) : null,
    po_days: poDays, quote_days: quoteDays, verdict,
  };
};

// Incoterm rules are three-letter codes (FOB, CIF, EXW, DAP...) usually written
// with a named place: "FOB Busan", "CIF Nhava Sheva". Compare the CODE, and
// report the places separately — a changed place is a real commercial
// difference but not the same thing as a changed rule.
const INCOTERM_CODES = new Set([
  "EXW", "FCA", "FAS", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP",
  // Superseded but still written on real documents.
  "DAT", "DAF", "DES", "DEQ", "DDU",
]);

export const parseIncoterm = (v) => {
  const raw = String(v == null ? "" : v).trim();
  if (!raw) return { code: null, place: null };
  const tokens = raw.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const idx = tokens.findIndex((t) => INCOTERM_CODES.has(t));
  if (idx < 0) return { code: null, place: raw };
  const place = raw.split(/[^A-Za-z0-9]+/).filter(Boolean).slice(idx + 1).join(" ") || null;
  return { code: tokens[idx], place };
};

// Header-level commercial check on the delivery rule. verdict:
// match | mismatch | place_differs | unknown.
export const compareIncoterms = (poIncoterm, quoteIncoterm) => {
  const po = parseIncoterm(poIncoterm);
  const qt = parseIncoterm(quoteIncoterm);
  const has = (v) => v != null && String(v).trim() !== "";
  let verdict;
  if (!has(poIncoterm) || !has(quoteIncoterm)) verdict = "unknown";
  else if (!po.code || !qt.code) {
    // Neither side parsed as a known rule — fall back to a string compare so a
    // free-text difference is still reported rather than silently passing.
    verdict = normTerms(poIncoterm) === normTerms(quoteIncoterm) ? "match" : "mismatch";
  } else if (po.code !== qt.code) verdict = "mismatch";
  else if (normTerms(po.place) !== normTerms(qt.place)) verdict = "place_differs";
  else verdict = "match";
  return {
    po_incoterm: has(poIncoterm) ? String(poIncoterm) : null,
    quote_incoterm: has(quoteIncoterm) ? String(quoteIncoterm) : null,
    po_code: po.code, quote_code: qt.code,
    po_place: po.place, quote_place: qt.place,
    verdict,
  };
};

// Below this, two descriptions for the same part number are treated as
// disagreeing. Token overlap is deliberately forgiving — the same part is
// routinely written "CYLINDER ASSY" on the quote and "Cylinder Assembly, 40mm"
// on the PO — so this only fires when the wording has genuinely diverged.
// opts.priceTolerancePct: allowed |PO rate - quote rate| before flagging
// a price_mismatch (default 0.5%).
export const reconcilePoAgainstQuotes = (orderLines, quoteLines, opts = {}) => {
  const tol = opts.priceTolerancePct != null ? Number(opts.priceTolerancePct) : 0.5;
  const { byPart, ambiguous } = indexQuoteLines(quoteLines);
  const quotesUsed = new Map();
  const summary = { total: 0, matched: 0, price_mismatch: 0, description_mismatch: 0, qty_note: 0, unmatched: 0 };

  // Which quote part-keys the PO actually ordered. Anything left over is a
  // line the customer was quoted and did NOT order — see below.
  const orderedKeys = new Set();

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
    // A quoted rate of 0 is not a price — it is an unpriced draft line (the
    // spare-matrix feed writes listed_unit_price: 0 by design, "priced
    // downstream in price_composition"). Treated as a real price it did two
    // silent things: 0 is falsy so no price check ran and the line reported a
    // clean match, and the enrichment below overwrote the PO's actual rate
    // with 0 on the persisted sales order.
    const quotePriced = quoteRate != null && Number(quoteRate) !== 0;
    const deltaPct = (poRate != null && quotePriced) ? round2(((poRate - quoteRate) / quoteRate) * 100) : null;
    const priceMismatch = deltaPct != null && Math.abs(deltaPct) > tol;
    const qtyNote = poQty != null && quoteQty != null && poQty !== quoteQty;

    // Description was ALREADY computed and stored on _match, and nothing ever
    // looked at it — a part whose description had completely changed
    // reconciled as a clean match. Price wins when both differ: a wrong price
    // is the more urgent fact, and the description delta still travels on
    // _match for the UI to show alongside it.
    const descScore = descAgreement(pick(ln.description, ln.itemName), q.description);
    const descMismatch = descScore != null && descScore < DESC_AGREEMENT_FLOOR;

    let verdict = "matched";
    if (priceMismatch) { verdict = "price_mismatch"; summary.price_mismatch += 1; }
    else if (descMismatch) { verdict = "description_mismatch"; summary.description_mismatch += 1; }
    else { summary.matched += 1; if (qtyNote) summary.qty_note += 1; }

    orderedKeys.add(key);
    quotesUsed.set(q._quote_id, {
      quote_id: q._quote_id, quote_number: q._quote_number,
      lines_matched: (quotesUsed.get(q._quote_id)?.lines_matched || 0) + 1,
    });

    const enriched = {
      ...ln,
      // Quote-authoritative pricing / tax / classification:
      hsn: pick(ln.hsn, q.hsn_sac) || null,
      // Keep the PO's rate when the quote line carries no real price.
      discounted_unit_price: quotePriced ? quoteRate : (poRate ?? null),
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
        desc_agreement: descScore,
        desc_mismatch: descMismatch,
        po_description: pick(ln.description, ln.itemName) || null,
        quote_description: q.description || null,
        ambiguous: ambiguous.has(key),
        source_quote_number: q._quote_number,
      },
    };
    return enriched;
  });

  // THE REVERSE WALK: quoted, but never ordered.
  //
  // Everything above walks the PO and asks "was this quoted?". Nothing asked
  // the other question — "was anything quoted that the PO does not contain?" —
  // so a customer PO that is short against the agreed quote produced a clean
  // reconciliation with no signal at all. The operator had to notice.
  //
  // This is deliberately NOT an error. A customer ordering part of a quote is
  // ordinary commercial behaviour; only a human can say whether a gap is a
  // deliberate partial order or an omission on the buyer's side. So it is
  // reported and left for them to act on — and if they do act, the line they
  // add is a quote_variance, which cannot be invoiced until the PO is amended.
  const quotedNotOrdered = [];
  const seenQuoteLine = new Set();
  // ONLY quotes this PO actually drew from.
  //
  // The walk used to iterate the entire customer quote pool, subtracting only
  // the keys that matched. With 0 matched lines nothing was subtracted, so
  // every part in every non-cancelled quote the customer had ever received
  // became a "gap": a 2-line PO reported 411 quoted-but-not-ordered rows, each
  // offering to be added as a variance. A quote the PO matched NOTHING from is
  // not the quote this PO was placed against.
  const usedQuoteIds = new Set(quotesUsed.keys());
  for (const q of quoteLines || []) {
    if (!usedQuoteIds.has(q._quote_id)) continue;
    const key = normPart(q.part_no);
    if (!key || orderedKeys.has(key)) continue;
    // One entry per part, not per quote revision: the same part quoted three
    // times is one thing missing from the PO, not three.
    if (seenQuoteLine.has(key)) continue;
    seenQuoteLine.add(key);
    quotedNotOrdered.push({
      part_no: q.part_no || null,
      description: q.description || null,
      qty: num(q.qty),
      unit_price: num(q.discounted_unit_price) != null ? num(q.discounted_unit_price) : num(q.listed_unit_price),
      uom: q.uom || null,
      hsn: q.hsn_sac || null,
      customer_part_number: q.customer_part_number || null,
      source_quote_id: q._quote_id || null,
      source_quote_number: q._quote_number || null,
    });
  }
  summary.quoted_not_ordered = quotedNotOrdered.length;

  return {
    lines,
    summary,
    quoted_not_ordered: quotedNotOrdered,
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
        desc_agreement: l._match.desc_agreement ?? null,
        po_description: l._match.po_description ?? null,
        quote_description: l._match.quote_description ?? null,
        source_quote_number: l._match.source_quote_number ?? null,
      })),
  };
};

// local helper (kept last so the file reads top-down)
