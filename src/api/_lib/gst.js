// Shared GST resolution — the single source of truth for (a) which GST RATE
// applies to a line, (b) intra vs inter-state place of supply, and (c) the
// CGST/SGST/UTGST/IGST split. Today the split lives inline in
// tally-build-voucher.js; this module is the reusable core so the order
// pipeline, invoice, and e-invoice paths can converge on ONE implementation
// (see docs/GST_COVERAGE_ROADMAP.md for the consolidation plan).
//
// Pure module: no DB/network. Safe to unit-test.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm2 = (code) => {
  const s = String(code == null ? "" : code).replace(/\D/g, "");
  return s ? s.padStart(2, "0").slice(0, 2) : null;
};

// Union-territory state codes that levy UTGST (not SGST) on an intra-UT
// supply. Delhi(07), Puducherry(34) and J&K(01) have their own legislatures
// and levy SGST, so they are deliberately EXCLUDED here.
export const UTGST_STATE_CODES = new Set(["04", "25", "26", "31", "35", "38", "97"]);
export const isUnionTerritory = (code) => UTGST_STATE_CODES.has(norm2(code));

// Resolve the GST rate for a line. Precedence:
//   1. a rate stated on the line (PO extraction or operator edit) — always wins
//   2. exempt / nil-rated / non-GST item classification -> 0
//   3. the mapped item-master default rate (rate_of_duty_pct)
//   4. unresolved -> { rate: null } so the caller can FLAG it (do NOT silently
//      assume zero tax)
// item = { taxability_type?, rate_of_duty_pct? } (the mapped item_master row).
export const resolveGstRate = ({ line = {}, item = null } = {}) => {
  const lineRate = line.gst_pct ?? line.gstRate ?? line.rate_of_duty_pct;
  if (lineRate != null && lineRate !== "") return { rate: Number(lineRate), source: "line" };

  const tax = String(item?.taxability_type || "").toUpperCase();
  if (item && (tax === "EXEMPT" || tax === "NIL_RATED" || tax === "NON_GST")) {
    return { rate: 0, source: "exempt" };
  }
  if (item && item.rate_of_duty_pct != null && item.rate_of_duty_pct !== "") {
    return { rate: Number(item.rate_of_duty_pct), source: "item_master" };
  }
  return { rate: null, source: null };
};

// intra vs inter-state from two state codes. Unknown either side -> interstate
// (conservative: misclassifying the other way mis-routes tax jurisdiction).
export const placeOfSupply = (sellerCode, buyerCode) => {
  const s = norm2(sellerCode);
  const b = norm2(buyerCode);
  if (!s || !b) return "interstate";
  return s === b ? "intrastate" : "interstate";
};

// Split a taxable amount at ratePct into components.
//   kind: "intrastate" | "interstate"
//   opts.unionTerritory: true -> intra-UT supply uses CGST + UTGST (not SGST)
// Returns { cgst, sgst, utgst, igst } (rounded to 2dp).
export const splitTax = (taxable, ratePct, kind, opts = {}) => {
  const t = Number(taxable) || 0;
  const r = Number(ratePct) || 0;
  const out = { cgst: 0, sgst: 0, utgst: 0, igst: 0 };
  if (r <= 0 || t <= 0) return out;
  if (kind === "interstate") {
    out.igst = round2((t * r) / 100);
  } else {
    const half = round2((t * r) / 200);
    out.cgst = half;
    if (opts.unionTerritory) out.utgst = half;
    else out.sgst = half;
  }
  return out;
};

export const __test__ = { round2, norm2 };
