// L5 shared validators.
//
// Phase A of EXTRACTION_PIPELINE_PLAN.md. Every adapter (Claude /
// Reducto / Azure DI / Unstructured / Excel / GAEB) returns an
// extraction in the canonical normalized shape:
//
//   { customer: { name, gstin, state_code, currency, ... },
//     lines:    [{ partNumber, description, quantity, unitPrice, hsn, gst_pct, ... }] }
//
// This module runs domain rules over that shape and emits a
// structured list of issues. Each issue has:
//
//   { field, code, severity, message, value }
//
// Severities:
//   - error: malformed data; downgrades the run to low_confidence.
//     Operator must accept or correct before push.
//   - warn:  suspicious but plausible (negative qty, missing HSN
//     when other lines have it). Surfaced in the workspace banner
//     but doesn't block.
//   - info:  informational (currency inferred from symbol). Useful
//     for the diagnostics tab; doesn't change confidence.
//
// The same module is called from:
//   - /api/docai/extract               (after dispatchExtract)
//   - /api/orders                       (when an order is updated
//                                       inline; not Phase A but
//                                       grounded in shape).
//   - /api/inbound/email/...            (Phase F).
//
// Every regex / list here is the source of truth. The Claude
// adapter's prompt copies the GSTIN regex by reference (verbatim
// in the system prompt) so the model and the validator agree on
// what "valid" means.

// ---- regex / table constants ----------------------------------

// 15-character Indian GST identifier. <state><PAN><entity-no><Z><checksum>
// Spec: https://www.gst.gov.in/help/cbic/specs (we keep the regex
// in step with claude.js's system prompt.)
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// HSN/SAC: 4-8 digits. Real PO line items overwhelmingly use 4 or
// 8; the 6-digit variant is also legal. The spec allows 2-digit at
// the chapter level but POs almost never carry a 2-digit HSN, so
// we treat <4 as malformed.
export const HSN_REGEX = /^\d{4,8}$/;

// ISO 4217 codes we commonly see in Indian B2B exports. Anything
// outside this list is downgraded to a warn ("non-standard
// currency") rather than rejected outright; the operator may have
// a real European or LATAM customer.
export const COMMON_CURRENCIES = new Set([
  "INR", "USD", "EUR", "GBP", "JPY", "AUD", "SGD", "AED", "CAD", "CHF", "CNY",
]);

// State-code -> name. The first two digits of a GSTIN must match
// one of these. Source: Indian GST state code list (CBIC).
// Keeping the structure as an immutable map so future India state-
// reorg lands in one place.
export const STATE_CODES = Object.freeze({
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
  "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram",
  "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "28": "Andhra Pradesh", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh (New)",
  "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
});

// ---- field-level validators ------------------------------------

// Returns null on valid; otherwise an issue. Each helper takes
// `(value)` and returns `{ code, severity, message } | null`.

const checkGstin = (value) => {
  if (value == null || value === "") return null;       // null is fine
  if (typeof value !== "string") {
    return { code: "gstin_not_string", severity: "error", message: "GSTIN must be a string" };
  }
  if (!GSTIN_REGEX.test(value)) {
    return {
      code: "gstin_malformed",
      severity: "error",
      message: "GSTIN does not match /^\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/",
    };
  }
  // Cross-check the embedded state code.
  const sc = value.slice(0, 2);
  if (!STATE_CODES[sc]) {
    return {
      code: "gstin_state_unknown",
      severity: "warn",
      message: `GSTIN state-code prefix '${sc}' is not in the CBIC list`,
    };
  }
  return null;
};

const checkStateCode = (value, gstin) => {
  if (value == null || value === "") return null;
  const sc = String(value).padStart(2, "0").slice(0, 2);
  if (!STATE_CODES[sc]) {
    return {
      code: "state_code_unknown",
      severity: "warn",
      message: `state_code '${value}' is not in the CBIC list`,
    };
  }
  if (gstin && typeof gstin === "string" && gstin.slice(0, 2) !== sc) {
    return {
      code: "state_code_gstin_mismatch",
      severity: "error",
      message: `state_code '${sc}' does not match GSTIN prefix '${gstin.slice(0, 2)}'`,
    };
  }
  return null;
};

// Country -> expected currency (used to flag obvious mismatches like
// "country=JP, currency=INR"). NULL country is treated as IN.
const COUNTRY_DEFAULT_CURRENCY = {
  IN: "INR", US: "USD", GB: "GBP", JP: "JPY", KR: "KRW", CN: "CNY",
  SG: "SGD", AU: "AUD", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR",
  NL: "EUR", AT: "EUR", BE: "EUR", FI: "EUR", IE: "EUR", PT: "EUR",
};

// Known set widened to include KRW + CNY (international PO support).
const KNOWN_CURRENCIES = new Set([...COMMON_CURRENCIES, "KRW", "CNY"]);

const checkCurrency = (value, country) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    return { code: "currency_not_string", severity: "error", message: "currency must be a string" };
  }
  const upper = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) {
    return { code: "currency_malformed", severity: "error", message: "currency must be 3 uppercase letters (ISO 4217)" };
  }
  // Tier 1: unknown currency code is `currency_uncommon` regardless
  // of country (preserves the pre-096 contract for ZAR / NGN / etc.).
  if (!KNOWN_CURRENCIES.has(upper)) {
    return {
      code: "currency_uncommon",
      severity: "warn",
      message: `currency '${upper}' is outside the common set; verify`,
    };
  }
  // Tier 2: known currency that disagrees with the buyer's country.
  // A Japanese PO billed in USD is fine; a Japanese PO billed in INR
  // is suspicious. NULL country defaults to IN for back-compat.
  const c = (country || "IN").toUpperCase();
  const expected = COUNTRY_DEFAULT_CURRENCY[c];
  if (expected && upper !== expected && upper !== "USD" && upper !== "EUR") {
    return {
      code: "currency_country_mismatch",
      severity: "warn",
      message: `currency '${upper}' is unexpected for country '${c}' (expected ${expected}, USD, or EUR); verify`,
    };
  }
  return null;
};

// Country code: ISO 3166-1 alpha-2. NULL is OK (treated as IN for
// back-compat); anything else must be exactly two upper-case letters.
const checkCountry = (value) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    return { code: "country_not_string", severity: "error", message: "country must be a string" };
  }
  if (!/^[A-Z]{2}$/.test(value)) {
    return {
      code: "country_malformed",
      severity: "warn",
      message: `country '${value}' should be ISO 3166-1 alpha-2 (2 upper-case letters)`,
    };
  }
  return null;
};

// tax_id_type: must be one of the enum values when present.
const TAX_ID_TYPES = new Set(["pan", "brn", "jp_corp", "eu_vat", "us_ein", "de_steuernummer", "other"]);
const checkTaxIdType = (value) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !TAX_ID_TYPES.has(value)) {
    return {
      code: "tax_id_type_unknown",
      severity: "warn",
      message: `tax_id_type '${value}' is not in the enum (pan|brn|jp_corp|eu_vat|us_ein|de_steuernummer|other)`,
    };
  }
  return null;
};

const checkHsn = (value) => {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!HSN_REGEX.test(s)) {
    return {
      code: "hsn_malformed",
      severity: "error",
      message: "hsn must be 4-8 digits (HSN/SAC code)",
    };
  }
  return null;
};

const checkQuantity = (value) => {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { code: "qty_not_number", severity: "error", message: "quantity must be a number" };
  }
  if (n <= 0) {
    return { code: "qty_non_positive", severity: "warn", message: "quantity is zero or negative" };
  }
  return null;
};

const checkUnitPrice = (value) => {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { code: "unit_price_not_number", severity: "error", message: "unitPrice must be a number" };
  }
  if (n < 0) {
    return { code: "unit_price_negative", severity: "warn", message: "unitPrice is negative" };
  }
  return null;
};

const checkGstPct = (value) => {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { code: "gst_pct_not_number", severity: "error", message: "gst_pct must be a number" };
  }
  // Standard Indian GST slabs: 0, 5, 12, 18, 28. Anything else is
  // suspicious but not impossible (cess can push effective rate
  // above 28). Warn, don't reject.
  const valid = [0, 0.1, 0.25, 3, 5, 12, 18, 28];
  if (!valid.includes(n)) {
    return {
      code: "gst_pct_uncommon",
      severity: "warn",
      message: `gst_pct '${n}' is outside the standard slabs (0/0.1/0.25/3/5/12/18/28); verify cess applies`,
    };
  }
  return null;
};

// ---- top-level validator --------------------------------------

const buildIssue = (field, info, value) => ({
  field,
  code: info.code,
  severity: info.severity,
  message: info.message,
  value: value === undefined ? null : value,
});

const validateCustomer = (customer) => {
  if (!customer || typeof customer !== "object") return [];
  const issues = [];
  // NULL country = treat as IN for back-compat with old extractor
  // outputs that didn't carry the field.
  const country = (customer.country || "IN").toUpperCase();

  const countryIssue = checkCountry(customer.country);
  if (countryIssue) issues.push(buildIssue("customer.country", countryIssue, customer.country));

  if (country === "IN") {
    // Indian PO: GSTIN + state_code apply.
    const gstinIssue = checkGstin(customer.gstin);
    if (gstinIssue) issues.push(buildIssue("customer.gstin", gstinIssue, customer.gstin));
    const stateIssue = checkStateCode(customer.state_code, customer.gstin);
    if (stateIssue) issues.push(buildIssue("customer.state_code", stateIssue, customer.state_code));
  } else {
    // Non-Indian PO: GSTIN must be NULL (extractor sometimes
    // hallucinates one when the buyer is foreign).
    if (customer.gstin) {
      issues.push(buildIssue("customer.gstin", {
        code: "gstin_unexpected",
        severity: "warn",
        message: `GSTIN should be null when country='${country}' != IN (Indian GST does not apply)`,
      }, customer.gstin));
    }
    // tax_id_type is the canonical id-type field for foreign POs.
    const taxIdTypeIssue = checkTaxIdType(customer.tax_id_type);
    if (taxIdTypeIssue) issues.push(buildIssue("customer.tax_id_type", taxIdTypeIssue, customer.tax_id_type));
  }

  // Currency check is country-aware.
  const currIssue = checkCurrency(customer.currency, country);
  if (currIssue) issues.push(buildIssue("customer.currency", currIssue, customer.currency));

  // Bill-to corroboration: if name is set and bill_to_address is set,
  // the name should appear (case-insensitive, alpha-num normalized)
  // inside the bill-to. When it doesn't, the extractor probably
  // picked up the project / end-customer name.
  if (customer.name && customer.bill_to_address) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const n = norm(customer.name);
    const b = norm(customer.bill_to_address);
    if (n.length >= 4 && !b.includes(n)) {
      issues.push(buildIssue("customer.name", {
        code: "name_not_in_bill_to",
        severity: "warn",
        message: `customer.name '${customer.name}' does not appear inside bill_to_address; the extractor may have picked an end-customer or project reference`,
      }, customer.name));
    }
  }

  return issues;
};

const validateLine = (line, idx) => {
  if (!line || typeof line !== "object") return [];
  const path = `lines[${idx}]`;
  const issues = [];
  const qty = checkQuantity(line.quantity);
  if (qty) issues.push(buildIssue(`${path}.quantity`, qty, line.quantity));
  const up = checkUnitPrice(line.unitPrice);
  if (up) issues.push(buildIssue(`${path}.unitPrice`, up, line.unitPrice));
  const hsn = checkHsn(line.hsn);
  if (hsn) issues.push(buildIssue(`${path}.hsn`, hsn, line.hsn));
  const gst = checkGstPct(line.gst_pct);
  if (gst) issues.push(buildIssue(`${path}.gst_pct`, gst, line.gst_pct));
  // Line-math: if the adapter populated `lineTotal` and qty + unit
  // price are present, verify within 1 paise.
  if (
    line.lineTotal != null
    && Number.isFinite(Number(line.quantity))
    && Number.isFinite(Number(line.unitPrice))
  ) {
    const expected = Number(line.quantity) * Number(line.unitPrice);
    const actual = Number(line.lineTotal);
    if (Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) > 0.01) {
      issues.push(buildIssue(`${path}.lineTotal`, {
        code: "line_total_mismatch",
        severity: "error",
        message: `lineTotal ${actual} != quantity * unitPrice (${expected.toFixed(2)})`,
      }, line.lineTotal));
    }
  }
  if (!line.partNumber && !line.description) {
    issues.push(buildIssue(`${path}`, {
      code: "line_empty",
      severity: "warn",
      message: "line has neither partNumber nor description",
    }, null));
  }
  // A part code is a single token. When partNumber is a whole phrase the
  // extractor failed to split "OBARA STD SHANK TWS-092-90-2" into code +
  // description — and nothing used to notice, so the sentence flowed on into
  // item_customer_parts as a permanent lookup key and into customer-hints as a
  // learned prefix. part-split.js repairs this before validation; a surviving
  // finding means the repair could not identify a code token either.
  if (typeof line.partNumber === "string" && /\s/.test(line.partNumber.trim())) {
    issues.push(buildIssue(`${path}.partNumber`, {
      code: "part_number_not_a_code",
      severity: "warn",
      message: "partNumber looks like a phrase, not a part code — the code was not split out of the description",
    }, line.partNumber));
  }
  return issues;
};

const summarise = (issues) => {
  const summary = { error: 0, warn: 0, info: 0, total: issues.length };
  for (const i of issues) {
    if (i.severity === "error") summary.error++;
    else if (i.severity === "warn") summary.warn++;
    else if (i.severity === "info") summary.info++;
  }
  return summary;
};

// Adjust the run's confidence based on validator output.
//   - any error              -> downgrade to min(0.69, conf) so the
//                              dispatcher's 0.7 threshold flips us
//                              to low_confidence.
//   - 3+ warns               -> downgrade to min(0.79, conf) so the
//                              workspace shows a soft warning banner.
//   - otherwise              -> conf unchanged.
const adjustConfidence = (currentConf, summary) => {
  const c = currentConf == null ? null : Number(currentConf);
  if (c == null || !Number.isFinite(c)) return null;
  if (summary.error > 0) return Math.min(0.69, c);
  if (summary.warn >= 3) return Math.min(0.79, c);
  return c;
};

// Test-only exports so unit tests can lock the country-conditional
// rules without standing up the whole validator pipeline.
export const __test = {
  validateCustomer,
  checkCountry,
  checkCurrency,
  checkTaxIdType,
};

// Public API. Pass a normalized extraction result; we return the
// list of issues, the summary, and the adjusted confidence. Caller
// persists the output on extraction_runs.validator_issues +
// validator_summary; the dispatcher persists the adjusted
// confidence to confidence_overall.
//
// Pure: no I/O, no DB access. Safe to call from anywhere.
export const validateExtraction = (normalized, opts = {}) => {
  const customerIssues = validateCustomer(normalized?.customer);
  const lineIssues = (Array.isArray(normalized?.lines) ? normalized.lines : [])
    .flatMap((l, i) => validateLine(l, i));
  const issues = [...customerIssues, ...lineIssues];
  const summary = summarise(issues);
  const adjustedConfidence = adjustConfidence(opts.currentConfidence, summary);
  return { issues, summary, adjustedConfidence };
};

// Convenience: compute a stable, human-readable headline from the
// summary. The Pipeline Diagnostics tab uses this on the latest-run
// banner so an operator can read the situation without expanding
// the issues list.
export const summariseIssuesHeadline = (summary) => {
  if (!summary || summary.total === 0) return "no validator issues";
  const parts = [];
  if (summary.error) parts.push(`${summary.error} error${summary.error === 1 ? "" : "s"}`);
  if (summary.warn) parts.push(`${summary.warn} warning${summary.warn === 1 ? "" : "s"}`);
  if (summary.info) parts.push(`${summary.info} info`);
  return parts.join(", ");
};
