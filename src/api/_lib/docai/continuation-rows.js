// Fold printed continuation rows back into the line item they belong to.
//
// WHY THIS EXISTS
//
// Many OEM purchase orders print ONE line item across several physical rows:
// the part number, quantity and price on the first row, then rows that carry
// only a description, a drawing or specification code, a requisition (PR)
// number, a delivery date or the line total. When an extractor reads each
// physical row as an item, a 25-item PO comes back as about 100 lines: one
// real line per item, each followed by three "lines" with no quantity. Every
// one of those lands on the sales order with a review flag, and nothing
// downstream merged or removed them. One of them even carried the item's line
// total in its unit-price slot, copied from the row it sat under.
//
// The prompt rule (CONTINUATION_ROW_RULE in claude.js, which gemini.js
// imports) asks the model not to do this. This pass is the deterministic
// backstop for when a model does it anyway, whichever adapter it was.
//
// WHAT COUNTS AS A CONTINUATION ROW. All of these must hold:
//   1. It has no quantity of its own (null, blank or 0).
//   2. It has no amount of its own (lineTotal, amount or taxTotal).
//   3. It has no unit price of its own. A unit price equal to the amount of
//      the line above it is a copy of that amount, not a price.
//   4. It prints no line number of its own. A lineNo that differs from the
//      line above means a separately numbered item.
//   5. The line above it (after any earlier folds) is a real line: it has its
//      own quantity. A row with no real line above it is left alone.
// A row with its own quantity is never folded, whatever else it lacks. So a
// real line with a quantity and no price (a free-of-charge item) survives, and
// so does every row with its own quantity and its own rate or amount.
//
// NOTHING IS LOST
//
// The folded row is kept whole on the line it joins, in `_folded_rows`. Its
// description, specification and requisition number fill the same field on
// that line when the line has none. Any other text the line does not already
// carry is appended to the line's description, so it stays visible. Numbers on
// a folded row (a copied total, a stray tax figure) never move into the line's
// money fields; they stay in `_folded_rows` for audit. A summary goes on
// normalized.continuation_folds, which anomaly.js reports, and anomaly.js then
// checks the folded lines against the document's printed total.
//
// SCOPE. Purchase orders only (kind 'po', not classified 'rfq'). An RFQ can
// legitimately print an item with no quantity under one that has a quantity.
//
// PURE. No I/O. Returns new objects and never mutates its input.

const num = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const nonZero = (v) => {
  const n = num(v);
  return n != null && n !== 0 ? n : null;
};
const text = (v) => (v == null ? "" : String(v).trim());
// Comparison key: case and punctuation do not make two values different.
const keyOf = (v) => text(v).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const qtyOf = (l) => num(l?.quantity ?? l?.qty);
const rateOf = (l) => num(l?.unitPrice ?? l?.rate);

// Per-UNIT tax and auxiliary amounts, the shape the LLM adapters return for a
// stacked layout (see line-schema.js). Used only to rebuild the gross amount
// the line above prints, so a copy of it can be recognised.
const PER_UNIT_KEYS = Object.freeze([
  "cgst_amount", "sgst_amount", "igst_amount", "utgst_amount", "cess_amount",
  "excise_amount", "ed_cess_amount", "tooling_amount", "p_and_f_amount", "others_amount",
]);

const hasOwnQuantity = (l) => {
  const q = qtyOf(l);
  return q != null && q !== 0;
};

const hasOwnAmount = (l) => nonZero(l?.lineTotal) != null
  || nonZero(l?.amount) != null
  || nonZero(l?.taxTotal) != null;

// Every figure the line above can print as its amount: a printed total, qty x
// rate, and qty x (rate + per-unit taxes), or qty x rate x (1 + GST%).
const amountsOf = (l) => {
  const out = [];
  const push = (v) => {
    const n = nonZero(v);
    if (n != null) out.push(n);
  };
  push(l?.lineTotal);
  push(l?.amount);
  const q = qtyOf(l);
  const r = rateOf(l);
  if (q && r) {
    push(q * r);
    let perUnit = 0;
    for (const k of PER_UNIT_KEYS) {
      const v = nonZero(l?.[k]);
      if (v != null && v > 0) perUnit += v;
    }
    if (perUnit > 0) push(q * (r + perUnit));
    const pct = nonZero(l?.gst_pct);
    if (pct != null && pct > 0) push(q * r * (1 + pct / 100));
  }
  return out;
};

// Two printed money figures are the same figure when they agree to the paisa
// (after float noise) or within 0.05%.
const sameMoney = (a, b) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.0005);

// Why `row` is a continuation of `anchor`, or null when it is not one.
export const continuationReason = (row, anchor) => {
  if (!row || typeof row !== "object" || !anchor || typeof anchor !== "object") return null;
  if (!hasOwnQuantity(anchor)) return null;            // 5: nothing real to join
  if (hasOwnQuantity(row)) return null;                // 1
  if (hasOwnAmount(row)) return null;                  // 2
  const ownLineNo = text(row.lineNo);
  if (ownLineNo && ownLineNo !== text(anchor.lineNo)) return null;   // 4
  const rate = nonZero(rateOf(row));
  if (rate == null) return "no_quantity_no_amount";
  // 3: a "rate" that is the amount of the line above was copied from it.
  if (amountsOf(anchor).some((a) => sameMoney(rate, a))) return "rate_copies_amount_above";
  return null;
};

// Text a continuation row carries, in the order it is folded in. The
// description, specification and requisition number may fill the same empty
// field on the line. partNumber and customerItemCode never do: on a row the
// model wrongly read as an item, those slots hold whatever text led the row
// (a description, a drawing code), not an identifier.
const TEXT_SOURCES = Object.freeze([
  ["partNumber", null],
  ["customerItemCode", null],
  ["description", "description"],
  ["raw_description", null],
  ["specification", "specification"],
  ["requisition_no", "requisition_no"],
]);
// Short codes: fill the same empty field, never appended as text.
const CODE_FIELDS = Object.freeze(["uom", "hsn"]);
// Where a value already on the line is looked for before it is added again.
const LINE_TEXT_FIELDS = Object.freeze([
  "partNumber", "customerItemCode", "description", "raw_description", "specification", "requisition_no",
]);

const DESCRIPTION_JOINER = " | ";

// The folded row as it was, minus empty values and Anvil's own annotations.
const snapshotOf = (row, reason, index) => {
  const snap = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === "") continue;
    if (k === "_folded_rows") continue;
    snap[k] = v;
  }
  snap._fold_reason = reason;
  snap._source_index = index;
  return snap;
};

const mergeInto = (anchor, row, reason, index) => {
  const next = { ...anchor };
  const seen = LINE_TEXT_FIELDS.map((f) => keyOf(next[f])).filter(Boolean);
  const already = (k) => seen.some((s) => s.includes(k));
  const appended = [];
  for (const [field, target] of TEXT_SOURCES) {
    const value = text(row[field]);
    const k = keyOf(value);
    if (!k || already(k)) continue;
    if (target && !text(next[target])) {
      next[target] = value;
    } else {
      appended.push(value);
    }
    seen.push(k);
  }
  if (appended.length) {
    next.description = [text(next.description), ...appended].filter(Boolean).join(DESCRIPTION_JOINER);
  }
  for (const f of CODE_FIELDS) {
    if (!text(next[f]) && text(row[f])) next[f] = row[f];
  }
  const prior = Array.isArray(anchor._folded_rows) ? anchor._folded_rows : [];
  next._folded_rows = [...prior, snapshotOf(row, reason, index)];
  return next;
};

// Public. Fold continuation rows into the line above them.
//
// Returns { normalized, folded, keptIndices }:
//   normalized   a new normalized block (the input when nothing folded)
//   folded       how many rows were folded
//   keptIndices  for each output line, its index in the input lines, so a
//                caller can re-key per-line maps (see remapLineKeys)
export const foldContinuationRows = (normalized, opts = {}) => {
  const lines = Array.isArray(normalized?.lines) ? normalized.lines : null;
  const identity = {
    normalized,
    folded: 0,
    keptIndices: lines ? lines.map((_l, i) => i) : [],
  };
  if (!lines || lines.length < 2) return identity;
  const kind = opts.kind == null ? "po" : String(opts.kind);
  if (kind !== "po") return identity;
  if (normalized.classification === "rfq") return identity;

  const out = [];
  const keptIndices = [];
  const into = new Map();       // output index -> rows folded into it
  let rateCopies = 0;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    const anchorAt = out.length - 1;
    const reason = anchorAt >= 0 ? continuationReason(row, out[anchorAt]) : null;
    if (reason) {
      out[anchorAt] = mergeInto(out[anchorAt], row, reason, i);
      into.set(anchorAt, (into.get(anchorAt) || 0) + 1);
      if (reason === "rate_copies_amount_above") rateCopies++;
      continue;
    }
    out.push(row);
    keptIndices.push(i);
  }
  const folded = lines.length - out.length;
  if (!folded) return identity;

  const prior = normalized.continuation_folds && typeof normalized.continuation_folds === "object"
    ? normalized.continuation_folds
    : null;
  const summary = {
    rows_folded: (Number(prior?.rows_folded) || 0) + folded,
    rate_copies: (Number(prior?.rate_copies) || 0) + rateCopies,
    lines_before: Number.isFinite(Number(prior?.lines_before)) ? Number(prior.lines_before) : lines.length,
    lines_after: out.length,
    into: [...into.entries()].map(([line_index, rows]) => ({ line_index, rows })),
  };
  return {
    normalized: { ...normalized, lines: out, continuation_folds: summary },
    folded,
    keptIndices,
  };
};

// Public. Re-key a per-line map ({ "lines[3]": .., "lines[3].hsn": .. }) after
// a fold. A key for a folded row is dropped, because that row is no longer a
// line; every other key moves to its line's new index. Keys that are not
// per-line are copied unchanged.
const LINE_KEY = /^lines\[(\d+)\](.*)$/;
export const remapLineKeys = (map, keptIndices) => {
  if (!map || typeof map !== "object" || !Array.isArray(keptIndices)) return map;
  const newIndexOf = new Map(keptIndices.map((oldIdx, newIdx) => [oldIdx, newIdx]));
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const m = LINE_KEY.exec(k);
    if (!m) { out[k] = v; continue; }
    const to = newIndexOf.get(Number(m[1]));
    if (to == null) continue;
    out["lines[" + to + "]" + m[2]] = v;
  }
  return out;
};

export const __test = { amountsOf, sameMoney, hasOwnQuantity, hasOwnAmount, DESCRIPTION_JOINER };
