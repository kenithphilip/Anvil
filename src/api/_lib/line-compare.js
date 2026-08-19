// Comparing two lists of order lines — the part that is not about quotes.
//
// WHY THIS EXISTS. reconcilePoAgainstQuotes (quote-reconcile.js) answers "does
// this customer PO agree with the quotes we sent?". The next question the
// business needs answered is "does the invoice we are about to send agree with
// the PO?" — and a customer who cannot reconcile our invoice to their PO does
// not raise a goods receipt, which means they do not pay.
//
// Those are the same comparison over different inputs. What they share is
// mechanical and worth having in exactly one place: how a part code is
// normalised before matching, how loosely two descriptions may agree, how a
// price difference becomes a percentage, and the fact that any of qty /
// quantity, rate / unit_price / unitPrice may be the field actually present.
//
// WHAT DELIBERATELY DID NOT MOVE. The matching LOOP itself stays in
// quote-reconcile.js. It is not generic and pretending otherwise would be
// worse than duplicating a little: it enriches each PO line with
// quote-authoritative HSN, tax rates, source country and discount, records
// which quote priced which line, and runs a reverse walk for quoted-but-not-
// ordered. None of that has any meaning when the second list is an invoice.
// This module holds the primitives; each caller keeps its own semantics.
//
// FIELD-NAME TOLERANCE IS THE POINT. Order lines live in
// orders.result.salesOrder.lineItems and invoice lines in invoices.line_items,
// both JSONB, both written by several code paths over time. The same line may
// carry partNumber or part_no, quantity or qty, rate or unitPrice. Reading
// them through these accessors is what stops the next comparison silently
// matching nothing because it guessed one spelling.

// First non-empty value. Note the deliberate `!== ""`: an empty string is a
// missing field here, not a value.
export const pick = (...vals) => vals.find((v) => v != null && v !== "");

export const num = (v) => (v == null || v === "" ? null : Number(v));

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Part codes are compared with punctuation and case removed, so BP8/3S and
// bp8-3s are the same part. Note this does NOT make BP8/35 and BP8/3S equal —
// a digit is not a letter, and a near-miss on a part code is a different SKU.
export const normPart = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");

// Token overlap, 0..1, or null when either side has nothing to compare.
// Deliberately crude: it exists to catch a description that has completely
// changed, not to score prose.
// Token overlap, 0..1, or null when either side has nothing to compare.
// Deliberately crude: it exists to catch a description that has completely
// changed, not to score prose.
//
// COPIED VERBATIM from quote-reconcile.js, including Math.MIN rather than max.
// min asks "is the shorter description contained in the longer?", which is the
// right question when a PO abbreviates what the quote spells out. Retyping
// this from memory rather than copying it silently flipped min to max on the
// first attempt and turned a matched line into a description_mismatch — the
// existing tests caught it, which is exactly why they must pass unmodified.
export const descAgreement = (a, b) => {
  const t = (s) => new Set(String(s || "").toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length > 2));
  const A = t(a), B = t(b);
  if (!A.size || !B.size) return null;
  let hit = 0; A.forEach((w) => { if (B.has(w)) hit += 1; });
  return round2(hit / Math.min(A.size, B.size));
};

// Below this, two descriptions are treated as describing different things.
export const DESC_AGREEMENT_FLOOR = 0.34;

// ---- alias-tolerant accessors -------------------------------------------
// Every alias below was observed in this repo, not invented: the aliases come
// from what quote-reconcile.js already reads and what pdf-renderer.js's
// LineItems already renders.

export const lineKey = (ln) => normPart(pick(ln?.part_no, ln?.partNumber, ln?.itemCode));

export const linePartNo = (ln) => pick(ln?.part_no, ln?.partNumber, ln?.itemCode) || null;

export const lineQty = (ln) => num(pick(ln?.qty, ln?.quantity));

export const lineDesc = (ln) => pick(ln?.description, ln?.itemName) || null;

// discounted_unit_price first, because that is the price the order is actually
// placed at when a quote carried both a list and a net price.
export const lineRate = (ln) =>
  num(pick(ln?.discounted_unit_price, ln?.rate, ln?.unit_price, ln?.unitPrice, ln?.ex_price));

// The printed line total, or the product when only the parts are present.
export const lineAmount = (ln) => {
  const direct = num(pick(ln?.total, ln?.amount, ln?.line_amount));
  if (direct != null) return direct;
  const q = lineQty(ln);
  const r = lineRate(ln);
  return q != null && r != null ? round2(q * r) : null;
};

// ---- comparison primitives ----------------------------------------------

// Index a line list by normalised part key.
//
// `ambiguous` carries keys that appeared more than once. The FIRST occurrence
// wins, which makes the caller's ordering meaningful — quote-reconcile.js
// sorts newest-quote-first so the most recent price wins, and a caller that
// does not care simply ignores the set. Ambiguity is REPORTED rather than
// resolved: silently picking one of two prices for the same part is exactly
// the kind of quiet wrong answer this codebase has shipped before.
export const indexByPart = (lines, keyOf = lineKey) => {
  const byPart = new Map();
  const ambiguous = new Set();
  for (const ln of lines || []) {
    const key = keyOf(ln);
    if (!key) continue;
    if (byPart.has(key)) { ambiguous.add(key); continue; }
    byPart.set(key, ln);
  }
  return { byPart, ambiguous };
};

// Signed percentage difference of `actual` against `expected`, and whether it
// exceeds tolerance.
//
// A zero expected price is NOT a price. The spare-matrix feed writes
// listed_unit_price: 0 by design ("priced downstream"), and treating that as
// real did two silent things: 0 is falsy so no check ran and the line reported
// a clean match, and downstream enrichment then overwrote a real rate with 0.
// `comparable` says whether the question could be asked at all.
export const comparePrice = (actual, expected, tolerancePct = 0.5) => {
  const a = num(actual);
  const e = num(expected);
  const comparable = a != null && e != null && Number(e) !== 0;
  if (!comparable) return { comparable: false, delta_pct: null, mismatch: false };
  const delta = round2(((a - e) / e) * 100);
  return { comparable: true, delta_pct: delta, mismatch: Math.abs(delta) > Number(tolerancePct) };
};

// Do two descriptions still describe the same thing?
export const compareDescription = (a, b, floor = DESC_AGREEMENT_FLOOR) => {
  const score = descAgreement(a, b);
  return { score, mismatch: score != null && score < floor };
};
