// Extraction grounding verifier — pure logic.
//
// Cross-checks the extracted customer against Anvil's own `customers`
// registry via the GSTIN (a high-precision 15-char, Mod-36-checksummed key
// that also encodes the state). Returns field patches + confidence
// floors/caps + flags, which the caller applies with the same conservative
// "fill blanks only, never clobber operator-visible values" rule the
// template and override merges use. See docs/EXTRACTION_GROUNDING_DESIGN.md.
//
// This module is I/O-free: the caller does validateGstin() + findByGstin()
// and passes the results in, so the decision logic is fully unit-testable.

const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

// Significant tokens of a company name for a loose same-entity check.
// Drops punctuation + common legal-form / filler words so "ACME Pvt Ltd"
// and "Acme Private Limited" still overlap.
const STOP = new Set([
  "pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "corp",
  "corporation", "the", "and", "of", "industries", "enterprises", "&",
]);
const nameTokens = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));

// True when the two names clearly do NOT refer to the same entity: both are
// non-trivial and share no significant token. Conservative on purpose — the
// GSTIN is the strong key, name variants ("Acme" vs "Acme Steels") are
// common, so we only flag a hard disagreement.
export const nameConflicts = (a, b) => {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  return !ta.some((t) => setB.has(t));
};

// Confidence bands used by the pin (kept named so the intent is legible).
const CONF = {
  gstin_corroborated: 0.98, // registry confirmed the GSTIN
  state_from_gstin: 0.98,   // state code is deterministic from the GSTIN
  filled_from_registry: 0.9,
  filled_terms: 0.85,
  gstin_bad_checksum: 0.3,  // cap so it surfaces in review
};

// Compute the customer-identity pin.
//   extractedCustomer : out.normalized.customer (may be partial)
//   matchedCustomer   : the customers row from findByGstin(), or null
//   gstinValidation   : { ok, normalized?, code? } from validateGstin()
//   stateFromGstin    : gstinStateCode(normalized) or null
// Returns:
//   { patch, confidenceFloors, confidenceCaps, flags, matched_customer_id }
// `patch` is fill-blanks-only (the caller must not overwrite non-blank values).
export const computeGstinPin = ({ extractedCustomer, matchedCustomer, gstinValidation, stateFromGstin }) => {
  const cust = extractedCustomer || {};
  const patch = {};
  const confidenceFloors = {};
  const confidenceCaps = {};
  const flags = [];

  // 1. Bad checksum: cannot trust the GSTIN itself. Cap its confidence so
  //    the field is surfaced for review; do not attempt a registry match.
  if (!gstinValidation || gstinValidation.ok !== true) {
    confidenceCaps["customer.gstin"] = CONF.gstin_bad_checksum;
    // Covers any validation failure (bad shape, unknown state code, or failed
    // Mod-36 checksum); the specific reason is preserved in `detail`.
    flags.push({ code: "gstin_invalid", detail: gstinValidation?.code || "invalid" });
    return { patch, confidenceFloors, confidenceCaps, flags, matched_customer_id: null };
  }

  // The state code is deterministic from a valid GSTIN regardless of the
  // registry, so derive it into a blank state_code with high confidence.
  if (stateFromGstin && blank(cust.state_code)) {
    patch.state_code = stateFromGstin;
    confidenceFloors["customer.state_code"] = CONF.state_from_gstin;
  }

  // 2. Valid GSTIN, but not in the registry -> a new customer. Clean signal
  //    for the operator to create one; no pin.
  if (!matchedCustomer) {
    flags.push({ code: "gstin_valid_unknown_customer", detail: gstinValidation.normalized });
    return { patch, confidenceFloors, confidenceCaps, flags, matched_customer_id: null };
  }

  // 3. Registry match -> this customer is known and authoritative.
  confidenceFloors["customer.gstin"] = CONF.gstin_corroborated;

  const canonicalName = matchedCustomer.customer_name || matchedCustomer.display_name || null;
  if (canonicalName) {
    if (blank(cust.name)) {
      patch.name = canonicalName;
      confidenceFloors["customer.name"] = CONF.filled_from_registry;
    } else if (nameConflicts(cust.name, canonicalName)) {
      // Do NOT overwrite — the GSTIN might be a typo, or this is a
      // subsidiary. Surface it for the operator to resolve.
      flags.push({ code: "customer_name_gstin_mismatch", extracted: cust.name, canonical: canonicalName });
    }
  }

  // Registry state_code corroborates the GSTIN-derived one; fill if still blank.
  if (blank(patch.state_code) && blank(cust.state_code) && matchedCustomer.state_code) {
    patch.state_code = matchedCustomer.state_code;
    confidenceFloors["customer.state_code"] = CONF.filled_from_registry;
  }

  // Customer defaults fill blanks only (never override what the PO prints).
  const terms = matchedCustomer.default_payment_terms || matchedCustomer.payment_terms || null;
  if (terms && blank(cust.payment_terms)) {
    patch.payment_terms = terms;
    confidenceFloors["customer.payment_terms"] = CONF.filled_terms;
  }

  return { patch, confidenceFloors, confidenceCaps, flags, matched_customer_id: matchedCustomer.id || null };
};
