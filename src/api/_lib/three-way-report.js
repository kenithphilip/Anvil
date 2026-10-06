// The PO, Anvil and the ERP, put side by side.
//
// Mode A/B PR 4, and the first caller adjudicateField has ever had outside its
// own test. The adjudicator settled WHO WAS RIGHT for one field; this decides
// which fields to ask about, and which three values to ask with.
//
// The three sides are closer to hand than they look. The reconciler already
// preserves the PO's own figures on each line it produces — `_match.po_qty`
// and `_match.po_rate` — so an Anvil line carries both what the customer asked
// for and what Anvil would do. Only the third side has to be brought: the
// sales order the ERP actually produced.
//
// Pure. The caller supplies the three inputs and the customer-part map.

import { adjudicateField, scoreAdjudications, VERDICT } from "./three-way-adjudicate.js";
import { partKey } from "./plm-impact.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const first = (...vals) => {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return null;
};

// Align an Anvil line with the ERP's line for the same item.
//
// Aligned on the CUSTOMER's part code, not ours. That is deliberate and it is
// the point of the exercise: the customer's code is the one printed on the
// purchase order, so it is the identifier both sides genuinely share. Aligning
// on OUR part number would use the very field the comparison exists to check —
// two documents would agree by construction, and the mapping a person
// performed by hand would never be examined.
//
// Falls back to our part number only when a line carries no customer code at
// all, because an unaligned line is worse than one aligned on a weaker key.
export const alignLines = (anvilLines, erpLines) => {
  const byCustomer = new Map();
  const byOurs = new Map();
  for (const e of erpLines || []) {
    const ck = partKey(first(e?.customerPartNumber, e?.customer_part_number));
    const ok = partKey(first(e?.partNumber, e?.part_no));
    if (ck && !byCustomer.has(ck)) byCustomer.set(ck, e);
    if (ok && !byOurs.has(ok)) byOurs.set(ok, e);
  }

  const pairs = [];
  const usedErp = new Set();
  for (const a of anvilLines || []) {
    const ck = partKey(first(a?.customer_part_number, a?.customerPartNumber));
    const ok = partKey(first(a?.part_no, a?.partNumber));
    let erp = ck ? byCustomer.get(ck) : null;
    let on = erp ? "customer_part_number" : null;
    if (!erp && ok) { erp = byOurs.get(ok) || null; on = erp ? "part_no" : null; }
    if (erp) usedErp.add(erp);
    pairs.push({ anvil: a, erp: erp || null, aligned_on: on });
  }
  // Lines the ERP has that Anvil does not. Reported, never dropped: a line
  // somebody added by hand in the ERP is one of the more interesting things
  // this comparison can find, and it is invisible from Anvil's side alone.
  const erpOnly = (erpLines || []).filter((e) => !usedErp.has(e));
  return { pairs, erpOnly };
};

// Which line fields get adjudicated, and by whose authority.
//
// Quantity is the clean case: the PO states it, Anvil should carry it, the ERP
// should record it, and all three are directly comparable.
//
// Rate is NOT clean, and pretending otherwise would make the report lie. Anvil
// prices from the agreed QUOTE, deliberately — that is what quote-authoritative
// reconciliation means — so on a line where the PO's rate disagrees with the
// quote, Anvil differs from the PO on purpose and the reconciler has already
// said so. Adjudicating it here would report that same disagreement a second
// time, as an Anvil error. So it is skipped on exactly those lines, with the
// existing verdict named as the reason.
const lineFieldSpecs = (pair) => {
  const a = pair.anvil || {};
  const e = pair.erp || {};
  const m = a._match || {};
  const specs = [];

  specs.push({
    key: "qty",
    spec: { key: "qty", authority: "po", compare: "number" },
    truth: num(m.po_qty),
    anvil: num(first(a.qty, a.quantity)),
    tally: num(first(e.quantity, e.qty)),
  });

  const priceAlreadyFlagged = m.verdict === "price_mismatch";
  specs.push({
    key: "rate",
    spec: {
      key: "rate",
      // "none" makes it not_applicable rather than a silent pass: the field is
      // shown, and it is explicitly not being scored.
      authority: priceAlreadyFlagged ? "none" : "po",
      compare: "number",
    },
    truth: num(m.po_rate),
    anvil: num(first(a.discounted_unit_price, a.rate, a.unit_price)),
    tally: num(first(e.rate, e.unitPrice)),
    note: priceAlreadyFlagged
      ? "Not scored: the reconciler already reports this line as a price mismatch against the agreed quote, and Anvil prices from the quote by design."
      : null,
  });

  return specs;
};

// Our own part number — the mapping a person performed by hand.
//
// The authority is item_master, NOT the purchase order. The PO carries the
// buyer's code and never states ours; judged against the PO this field would
// be permanently undecidable, and it is the single most valuable thing in the
// comparison. `customerPartMap` is the caller's resolution of the buyer's code
// through item_customer_parts.
const ourPartSpec = (pair, customerPartMap) => {
  const a = pair.anvil || {};
  const e = pair.erp || {};
  const ck = partKey(first(a.customer_part_number, a.customerPartNumber, e.customerPartNumber, e.customer_part_number));
  const truth = ck && customerPartMap ? (customerPartMap.get(ck) ?? null) : null;
  return {
    key: "ourPartNo",
    spec: { key: "ourPartNo", authority: "item_master", compare: "text" },
    truth,
    anvil: first(a.part_no, a.partNumber),
    tally: first(e.partNumber, e.part_no),
  };
};

// Header fields. Payment terms only, for now, and deliberately.
//
// The scope's worked example turned on payment terms — a PO stating 60 days
// against a sales order recording 30 — so it earns its place. Delivery dates
// do not, yet: comparing "within 6-8 weeks" against a specific date needs a
// normaliser that turns a phrase and an order date into a window, and per the
// adjudicator's phasing rule an interpreted field stays out until its
// normaliser exists and is tested. A field guessed at is worse than one absent.
const headerSpecs = ({ poTerms, anvilTerms, erpTerms }) => ([
  {
    key: "paymentTerms",
    spec: {
      key: "paymentTerms",
      authority: "po",
      compare: "text",
      // Fold "AFTER 60 DAYS ON RECEIPT OF GOODS", "Net 60" and "60 Days" onto
      // one value. Falls back to the trimmed text when no figure is present,
      // so "against delivery" still compares as itself rather than collapsing
      // to empty and reading as agreement.
      normalise: (v) => {
        const s = String(v ?? "");
        const m = s.match(/\d+/);
        return m ? m[0] : s.trim().toLowerCase();
      },
    },
    truth: poTerms,
    anvil: anvilTerms,
    tally: erpTerms,
  },
]);

// Build the whole report.
//
// `input`: { anvilLines, erpLines, poTerms, anvilTerms, erpTerms, customerPartMap }
export const buildThreeWayReport = (input = {}) => {
  const { pairs, erpOnly } = alignLines(input.anvilLines, input.erpLines);
  const rows = [];

  for (const [i, pair] of pairs.entries()) {
    const label = first(
      pair.anvil?.customer_part_number, pair.anvil?.part_no, pair.anvil?.description,
    ) || `line ${i + 1}`;

    if (!pair.erp) {
      // On the PO and in Anvil, absent from the ERP. Not adjudicated field by
      // field — there is nothing on the other side to adjudicate against — but
      // it is the most consequential single finding this report produces: a
      // line the customer ordered that nobody entered.
      rows.push({ line: label, aligned_on: null, missing_from_erp: true, fields: [] });
      continue;
    }

    const specs = [ourPartSpec(pair, input.customerPartMap), ...lineFieldSpecs(pair)];
    rows.push({
      line: label,
      aligned_on: pair.aligned_on,
      missing_from_erp: false,
      fields: specs.map((s) => ({
        ...adjudicateField({ truth: s.truth, anvil: s.anvil, tally: s.tally }, s.spec),
        ...(s.note ? { note: s.note } : {}),
      })),
    });
  }

  const header = headerSpecs(input).map((s) =>
    adjudicateField({ truth: s.truth, anvil: s.anvil, tally: s.tally }, s.spec));

  const allFields = [...header, ...rows.flatMap((r) => r.fields)];
  const score = scoreAdjudications(allFields);

  return {
    header,
    lines: rows,
    // Lines present in the ERP and nowhere else. Somebody added them by hand;
    // whether that was right is a question for a person, not this function.
    erp_only: erpOnly.map((e) => ({
      part_no: first(e.partNumber, e.part_no),
      customer_part_no: first(e.customerPartNumber, e.customer_part_number),
      description: e.description ?? null,
      quantity: num(first(e.quantity, e.qty)),
    })),
    missing_from_erp: rows.filter((r) => r.missing_from_erp).length,
    score,
    // Surfaced separately because it is the finding a two-way comparison
    // cannot make, and the one most likely to be acted on.
    both_deviated: allFields.filter((f) => f.verdict === VERDICT.BOTH_DEVIATE).map((f) => f.key),
  };
};
