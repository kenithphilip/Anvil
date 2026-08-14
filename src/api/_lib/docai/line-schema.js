// The canonical line-item shape, and the one place adapter vocabularies are
// reconciled with it.
//
// WHY THIS EXISTS
//
// Ten adapters each invented their own field names and nothing checked them
// against what the consumers read. The failure mode is silent and expensive:
// llamaparse emits `line_total` + `tax_amount`; computeLineTotals reads
// `lineTotal` and a set of per-component tax keys; lineGross (the completeness
// guard) reads the same components. So a perfectly extracted 44-line PO
// displayed a grand total of Rs 15,15,691.80 against a printed Rs 18,25,261.52
// — the entire tax column silently dropped — AND the guard that exists to
// catch exactly that concluded "no tax captured", applied its 1.30 tax-
// inflation allowance, and reported the run clean.
//
// Nothing was broken in a way any single test could see. Every adapter test
// passed on the adapter's own vocabulary; every consumer test passed on the
// consumer's. The defect lived in the gap between them, which is precisely the
// gap this module closes.
//
// THE RULE: an adapter may speak any dialect it likes, but it is translated at
// the dispatcher boundary and anything unrecognised is REPORTED, never dropped.
// Silent field loss is the thing we are eliminating; replacing it with silent
// field *deletion* would be no better.

// Absolute (per-line) money, in the document's currency.
//   taxTotal  — total tax for the line, all components combined
//   lineTotal — gross for the line: taxable + tax + auxiliary
// These are what a TABLE parser can read directly off the page. They are
// deliberately distinct from the per-UNIT component keys below, which is what
// an LLM adapter reconstructs from a stacked layout. Conflating them was the
// bug; a line may legitimately carry either or both.
export const CANONICAL_LINE_FIELDS = Object.freeze([
  // identity
  "partNumber", "customerItemCode", "description", "specification", "lineNo",
  // measure
  "quantity", "uom",
  // money
  "unitPrice", "taxTotal", "lineTotal", "currency",
  // classification
  "hsn", "gst_pct",
  // per-UNIT tax components (the LLM adapters' shape)
  "cgst_amount", "sgst_amount", "igst_amount", "utgst_amount",
  "cess_amount", "excise_amount", "ed_cess_amount",
  // per-UNIT auxiliary costs
  "tooling_amount", "p_and_f_amount", "others_amount",
]);

const CANONICAL = new Set(CANONICAL_LINE_FIELDS);

// alias -> canonical. Every entry here is a name some adapter actually emits;
// this is a record of observed reality, not a wish list. Add to it when an
// adapter is added, and the conformance test will tell you if you forgot.
// Deliberately conservative. Only names an adapter actually emits, or that a
// consumer already reads, appear here. A speculative alias is worse than a
// missing one: a missing alias shows up in `unknown` and gets fixed, whereas a
// WRONG alias silently moves money into the wrong field. That is why generic
// words — `total`, `amount`, `price`, `taxes` — are absent despite looking
// plausible: none of them is unambiguously the field it resembles.
//
// Pure case variants ("PartNumber", "unitprice") are NOT listed: canonical
// matching is already case-insensitive, so they are corrected without an entry.
export const FIELD_ALIASES = Object.freeze({
  // measure — unstructured + docling emit `qty`; consumers read `qty ?? quantity`
  qty: "quantity",
  // money — consumers read `rate ?? unitPrice`
  rate: "unitPrice",
  unit_price: "unitPrice",
  // llamaparse's table columns, which no consumer could read before this
  line_total: "lineTotal",
  tax_amount: "taxTotal",
  tax_total: "taxTotal",
  // identity
  part_number: "partNumber",
  part_no: "partNumber",
  customer_part_number: "customerItemCode",
  customer_item_code: "customerItemCode",
  line_no: "lineNo",
  lineNumber: "lineNo",
  // classification
  hsn_code: "hsn",
  hsn_sac: "hsn",
  gstRate: "gst_pct",
  gst_rate: "gst_pct",
});

// Underscore-prefixed keys are Anvil's own annotations (_evidence,
// _part_split, _source, _conformance) rather than document data. They pass
// through untouched and never count as unknown.
const isInternal = (k) => typeof k === "string" && k.startsWith("_");

// Aliases are matched case-insensitively, because "TaxAmount" and "tax_amount"
// are the same mistake and neither should reach a consumer.
const ALIAS_LOOKUP = new Map();
for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
  ALIAS_LOOKUP.set(alias.toLowerCase(), canonical);
}
const CANONICAL_LOOKUP = new Map();
for (const f of CANONICAL_LINE_FIELDS) CANONICAL_LOOKUP.set(f.toLowerCase(), f);

// Canonicalise ONE line.
//
// Never drops a key. A value under an unrecognised name is kept verbatim and
// listed in `unknown` so it shows up in diagnostics — an adapter emitting a
// field nobody reads is a bug to fix, not data to discard.
export const canonicaliseLine = (line) => {
  if (!line || typeof line !== "object" || Array.isArray(line)) {
    return { line, renamed: [], unknown: [], conflicts: [] };
  }
  const out = {};
  const renamed = [];
  const unknown = [];
  const conflicts = [];

  // Canonical keys first, so an alias can never clobber a value the adapter
  // already supplied under the right name.
  for (const [k, v] of Object.entries(line)) {
    if (isInternal(k)) { out[k] = v; continue; }
    const canonical = CANONICAL_LOOKUP.get(String(k).toLowerCase());
    if (canonical && canonical === k) out[k] = v;
  }

  for (const [k, v] of Object.entries(line)) {
    if (isInternal(k)) continue;
    const lower = String(k).toLowerCase();
    const exact = CANONICAL_LOOKUP.get(lower);
    if (exact === k) continue;                       // already copied above

    // A canonical name in the wrong case ("PartNumber"): fix the case.
    if (exact) {
      if (Object.prototype.hasOwnProperty.call(out, exact)) {
        if (out[exact] !== v) conflicts.push(k);
        continue;
      }
      out[exact] = v;
      renamed.push(k + "->" + exact);
      continue;
    }

    const target = ALIAS_LOOKUP.get(lower);
    if (target) {
      // The adapter supplied both the alias and the canonical name. Keep the
      // canonical value — it is the one the adapter chose deliberately — and
      // record the collision rather than silently preferring either.
      if (Object.prototype.hasOwnProperty.call(out, target)) {
        if (out[target] !== v) conflicts.push(k + " vs " + target);
        continue;
      }
      out[target] = v;
      renamed.push(k + "->" + target);
      continue;
    }

    out[k] = v;               // keep the data
    unknown.push(k);          // and report it
  }

  return { line: out, renamed, unknown, conflicts };
};

// Canonicalise every line on a normalized extraction.
//
// Returns { normalized, diag }. `diag` is null when there was nothing to say,
// so the common case adds no noise to the run row.
export const conformLines = (normalized) => {
  if (!normalized || !Array.isArray(normalized.lines)) return { normalized, diag: null };
  const renamed = new Set();
  const unknown = new Set();
  const conflicts = new Set();
  let touched = 0;

  const lines = normalized.lines.map((l) => {
    const r = canonicaliseLine(l);
    r.renamed.forEach((x) => renamed.add(x));
    r.unknown.forEach((x) => unknown.add(x));
    r.conflicts.forEach((x) => conflicts.add(x));
    if (r.renamed.length || r.conflicts.length) touched++;
    return r.line;
  });

  const diag = (renamed.size || unknown.size || conflicts.size)
    ? {
      lines: lines.length,
      lines_touched: touched,
      renamed: [...renamed].sort(),
      unknown: [...unknown].sort(),
      conflicts: [...conflicts].sort(),
    }
    : null;

  return { normalized: { ...normalized, lines }, diag };
};

export const __test = { isInternal, ALIAS_LOOKUP, CANONICAL_LOOKUP };
