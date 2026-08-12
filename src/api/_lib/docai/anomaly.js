// Anomaly-on-extraction (Wave 3.1 / #9).
//
// validateExtraction (validators.js) does per-field shape checks:
// is GSTIN well-formed, is gst_pct a number, is currency a known
// code. That's necessary but not sufficient. The extractor still
// occasionally returns lines that PASS shape validation but FAIL
// basic accounting reality:
//
//   - quantity=10, unitPrice=100, amount=9000 (off by an order of
//     magnitude; model OCR'd 1000 from a smudged 1,000.00).
//   - tax_amount=18 on a 10000 base when gst_pct=18 (the model
//     dropped two zeroes from the tax).
//   - HSN code "841234" on a screw (HSN 7318 is the right family;
//     841234 is industrial machinery).
//   - quantity=-5 (the model captured a credit-memo entry as a PO
//     line).
//   - unitPrice=0 for a real part (the model parsed "Rate" header
//     value 0 from a column it shouldn't have).
//   - PO date 2099-12-31 (the model swapped DD/MM and YY-as-YYYY).
//
// This module runs AFTER the shape validators and produces a
// separate list of `anomalies` with severity + suggested action.
// Anomalies are persisted on extraction_runs.anomalies and
// surfaced to the UI as a sticky banner.
//
// The dispatcher does NOT downgrade confidence on anomalies; that
// would trip the existing low-confidence fallback unnecessarily.
// Instead anomalies are surfaced to the operator and routed to
// the review queue (Wave 4.1) when severity = 'error'.

const KNOWN_GST_SLABS = new Set([0, 0.1, 0.25, 3, 5, 12, 18, 28]);

// HSN code top-level chapter validity. A real HSN is 4-8 digits.
// The first 2 digits are the chapter; chapters 1-97 are the
// World Customs Organization HS classification. Chapters 98-99
// are India-specific. We accept 01-99.
const HSN_REGEX = /^\d{4,8}$/;

// Plausible PO-line price range (INR). Operator can override via
// settings.docai_anomaly_max_unit_price_inr. The default 5 crore
// covers heavy capex; below 0.50 paise is implausible.
const DEFAULT_MAX_UNIT_PRICE = 50_000_000;       // 5 crore INR
const DEFAULT_MIN_UNIT_PRICE = 0.5;              // 0.50 INR

const numberOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Arithmetic check for a single line. Returns null when no
// anomaly; otherwise returns { code, severity, expected, actual,
// detail }.
//
// Two-step:
//   1. compute expected = qty * unitPrice (or use line.amount when
//      provided).
//   2. if line.amount is set, compare to expected within 1.5%
//      tolerance OR 1 paise (whichever is larger).
const lineArithmetic = (line) => {
  const qty = numberOrNull(line.quantity);
  const price = numberOrNull(line.unitPrice);
  const amount = numberOrNull(line.amount);
  if (qty == null || price == null) return null;
  if (amount == null) return null;
  const expected = qty * price;
  // Apply discount when present.
  const discountPct = numberOrNull(line.discount_pct);
  const adjExpected = discountPct != null && discountPct > 0
    ? expected * (1 - discountPct / 100)
    : expected;
  const tolerance = Math.max(0.01, Math.abs(adjExpected) * 0.015);
  const diff = Math.abs(adjExpected - amount);
  if (diff <= tolerance) return null;
  // The off-by-OOM check: if the diff is approximately a factor of
  // 10 / 100 / 1000, that's a misplaced decimal.
  const ratio = amount && adjExpected ? amount / adjExpected : null;
  let detail = "qty*unit_price = " + adjExpected.toFixed(2) + ", line amount = " + amount.toFixed(2);
  if (ratio != null) {
    if (ratio > 9 && ratio < 11) detail += " (off by 10x; likely decimal slip)";
    if (ratio > 99 && ratio < 101) detail += " (off by 100x; likely decimal slip)";
  }
  return {
    code: "line_arithmetic_mismatch",
    severity: diff / Math.max(Math.abs(adjExpected), 1) > 0.10 ? "error" : "warn",
    expected: adjExpected,
    actual: amount,
    detail,
  };
};

const linePriceSanity = (line, opts) => {
  const price = numberOrNull(line.unitPrice);
  if (price == null) return null;
  if (price < 0) return { code: "unit_price_negative", severity: "error", actual: price };
  if (price === 0) return { code: "unit_price_zero", severity: "warn", actual: price };
  const max = Number(opts.maxUnitPrice || DEFAULT_MAX_UNIT_PRICE);
  if (price > max) {
    return {
      code: "unit_price_implausibly_high",
      severity: "warn",
      actual: price,
      threshold: max,
    };
  }
  const min = Number(opts.minUnitPrice || DEFAULT_MIN_UNIT_PRICE);
  if (price > 0 && price < min) {
    return {
      code: "unit_price_implausibly_low",
      severity: "warn",
      actual: price,
      threshold: min,
    };
  }
  return null;
};

const lineQtySanity = (line) => {
  const qty = numberOrNull(line.quantity);
  if (qty == null) return null;
  if (qty < 0) return { code: "quantity_negative", severity: "error", actual: qty };
  if (qty === 0) return { code: "quantity_zero", severity: "warn", actual: qty };
  // Integer-UOM check: NOS / PCS / PIECES / SET / EACH usually
  // come as integers; a fractional quantity is suspicious.
  const uom = String(line.uom || "").toUpperCase().trim();
  const integerUoms = new Set(["NOS", "PCS", "PIECE", "PIECES", "SET", "EACH", "EA", "UNIT", "UNITS"]);
  if (integerUoms.has(uom) && !Number.isInteger(qty)) {
    return {
      code: "quantity_fractional_for_unit_uom",
      severity: "warn",
      actual: qty,
      detail: "uom=" + uom + " typically requires integer quantity",
    };
  }
  return null;
};

const lineHsnSanity = (line) => {
  if (line.hsn == null) return null;
  const hsn = String(line.hsn).trim();
  if (!hsn) return null;
  if (!HSN_REGEX.test(hsn)) {
    return {
      code: "hsn_malformed",
      severity: "warn",
      actual: line.hsn,
      detail: "HSN must be 4-8 digits; got '" + hsn + "'",
    };
  }
  const chapter = Number(hsn.slice(0, 2));
  if (chapter < 1 || chapter > 99) {
    return {
      code: "hsn_chapter_out_of_range",
      severity: "warn",
      actual: line.hsn,
      detail: "HSN chapter " + chapter + " is outside the 01-99 World Customs Organization range",
    };
  }
  return null;
};

const lineGstSanity = (line) => {
  const g = numberOrNull(line.gst_pct);
  if (g == null) return null;
  if (g < 0 || g > 100) {
    return { code: "gst_pct_out_of_range", severity: "error", actual: g };
  }
  if (!KNOWN_GST_SLABS.has(g)) {
    return {
      code: "gst_pct_non_standard_slab",
      severity: "info",
      actual: g,
      detail: "GST percentage " + g + " is not a standard slab; verify cess / compensation rate",
    };
  }
  return null;
};

const lineDiscountSanity = (line) => {
  const d = numberOrNull(line.discount_pct);
  if (d == null) return null;
  if (d < 0 || d > 100) {
    return { code: "discount_pct_out_of_range", severity: "error", actual: d };
  }
  return null;
};

// Aggregate per-line anomaly check.
export const checkLine = (line, index, opts = {}) => {
  if (!line) return [];
  const issues = [];
  const push = (issue) => {
    if (issue) issues.push({ ...issue, path: "lines[" + index + "]." + (issue.code.split("_")[0]), line_index: index });
  };
  push(lineArithmetic(line));
  push(linePriceSanity(line, opts));
  push(lineQtySanity(line));
  push(lineHsnSanity(line));
  push(lineGstSanity(line));
  push(lineDiscountSanity(line));
  return issues;
};

// Header-level checks: PO date plausibility, currency mismatch
// between customer block and lines, tax-amount vs computed sum.
const checkPoDate = (customer) => {
  if (!customer) return null;
  const d = customer.po_date || customer.order_date || customer.date;
  if (!d) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) {
    return { code: "po_date_unparseable", severity: "warn", actual: d };
  }
  const year = parsed.getUTCFullYear();
  const now = new Date();
  const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // +1y tolerance
  if (year < 2000) {
    return { code: "po_date_implausibly_old", severity: "warn", actual: d };
  }
  if (parsed > future) {
    return { code: "po_date_future", severity: "warn", actual: d };
  }
  return null;
};

const checkTotals = (normalized) => {
  if (!normalized?.totals) return [];
  const subtotal = numberOrNull(normalized.totals.subtotal);
  const tax = numberOrNull(normalized.totals.tax_amount);
  const grand = numberOrNull(normalized.totals.grand_total);
  const issues = [];
  if (subtotal != null && grand != null && tax != null) {
    const expected = subtotal + tax;
    const tolerance = Math.max(1, Math.abs(grand) * 0.005);
    if (Math.abs(expected - grand) > tolerance) {
      issues.push({
        code: "grand_total_mismatch",
        severity: "error",
        path: "totals.grand_total",
        actual: grand,
        expected,
        detail: "subtotal " + subtotal.toFixed(2) + " + tax " + tax.toFixed(2) + " != grand_total " + grand.toFixed(2),
      });
    }
  }
  // Sum of line amounts vs subtotal.
  if (Array.isArray(normalized.lines) && subtotal != null) {
    const lineSum = normalized.lines.reduce((s, l) => {
      const a = numberOrNull(l.amount);
      return a == null ? s : s + a;
    }, 0);
    const tolerance = Math.max(1, Math.abs(subtotal) * 0.01);
    if (Math.abs(lineSum - subtotal) > tolerance) {
      issues.push({
        code: "subtotal_does_not_match_lines",
        severity: "warn",
        path: "totals.subtotal",
        actual: subtotal,
        expected: lineSum,
        detail: "sum(line.amount) " + lineSum.toFixed(2) + " != subtotal " + subtotal.toFixed(2),
      });
    }
  }
  return issues;
};

// CM P3: line-count completeness — the single highest-value
// missing detector. When the PO DECLARES more line items than
// extraction returned (the silent "6 of 190 lines" failure that
// looks complete), raise a blocking finding so the run is forced
// into the review queue instead of shipping short. Deterministic:
// compares the model-reported normalized.stated_line_count (the
// PO's own printed total / highest serial) against lines.length.
//   opts.lineCountShortfallEnabled === false -> disabled.
//   opts.lineCountShortfallSlack (default 0) -> tolerated gap;
//     0 means any shortfall blocks.
const checkLineCountShortfall = (normalized, opts = {}) => {
  if (opts.lineCountShortfallEnabled === false) return [];
  const declared = numberOrNull(normalized?.stated_line_count);
  // Only fire on a trustworthy declaration of at least 2. A PO that
  // declares 1 item and yields 0 is already caught by the run-level
  // empty_lines path; and a null/zero declaration is no signal.
  if (declared == null || declared < 2) return [];
  const extracted = Array.isArray(normalized?.lines) ? normalized.lines.length : 0;
  const slackRaw = Number(opts.lineCountShortfallSlack);
  const slack = Number.isFinite(slackRaw) ? Math.max(0, slackRaw) : 0;
  if (extracted >= declared - slack) return [];
  const short = declared - extracted;
  return [{
    code: "line_count_shortfall",
    severity: "error",
    path: "lines",
    actual: extracted,
    expected: declared,
    detail: "PO declares " + declared + " line items; extraction returned " + extracted + " (short by " + short + ")",
  }];
};

// CM P0 (Aug 2026): the money-completeness guard.
//
// Every other detector in this file — checkLineCountShortfall above very much
// included — consumes a number the MODEL wrote. That is fine until the model
// truncates, because normalized.stated_line_count is emitted AFTER the line
// array: the lines and the declaration that would have caught the missing
// lines are lost in the same breath, so the detector no-ops and the run
// reports "clean". On the incident: 1 extracted line worth 80,716.72 against
// a PO printing 458,859.52 — 95% confidence, 0 anomalies, 0 validator errors.
//
// This check reads the document's PRINTED grand total straight out of the L1/L2
// text layer (opts.bodyText) — evidence the extractor does not author — and
// asks whether the lines we returned account for that money. Verified against
// the incident document: its four real line totals sum to the printed grand
// total exactly, so the comparison is arithmetic rather than heuristic.
// Measured against 20 realistic Indian PO phrasings, the original pattern hit
// 10/20. The misses were all ordinary: "Total:", "PO Total:", "Order Total:",
// "Net Total:", "Total (INR):", "Gross Total:". On any of those the guard
// no-ops silently — and it is the last line of defence, so a miss is a short
// voucher nobody is warned about.
//
// The qualifier is now optional (`(?:grand|net|gross|po|order|...)?\s*total`),
// which also lets a bare "Total" match. Two deliberate consequences:
//   - "Sub Total" / "Subtotal" are EXCLUDED by a negative lookbehind. A
//     subtotal is not the grand total, and matching it would understate the
//     document and fire false blockers.
//   - Bare "Total" is a weak label that can appear on a column header or a
//     per-section line. That is safe here ONLY because printedDocumentTotal
//     takes the MAXIMUM match in the document, so a section total can never
//     beat the real grand total. Do not change that max() to a first-match.
const DOC_TOTAL_RE = /(?<!sub[\s-]?)(?:(?:grand|net|gross|po|order|purchase\s*order|invoice)\s*)?total(?:\s*(?:amount|value|invoice\s*value|po\s*value|order\s*value|purchase\s*order\s*value|amount\s*payable))?\b|net\s*amount\s*payable\b|amount\s*payable\b|net\s*payable\b/gi;

// Matched label -> the money figure that follows it. ANCHORED (^): the money
// must come straight after the label, separated only by punctuation/currency.
// Unanchored, prose like "no totals here, just 12,345.67" matched — the word
// "total" plus any number later in the sentence.
const MONEY_AFTER_LABEL_RE = /^\s*(?:\([^)]{0,24}\))?\s*[:\-]?\s*(?:INR|Rs\.?|₹|USD|US\$|\$|EUR|€|JPY|KRW)?\s*\(?\s*([0-9][0-9,]{2,}(?:\.[0-9]{1,3})?)/;

// The grand total is the largest labelled figure in the document: a PO that
// prints per-section subtotals under the same words still yields the true
// total as the maximum. Returns null when nothing is labelled -> check no-ops.
const printedDocumentTotal = (text) => {
  if (typeof text !== "string" || text.length < 20) return null;
  let best = null;
  // Two-stage: find a total-ish LABEL, then read the money immediately after
  // it. One combined pattern cannot express "optional qualifier + optional
  // suffix" without the suffix alternation swallowing the number.
  for (const m of text.matchAll(DOC_TOTAL_RE)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 48);
    const money = after.match(MONEY_AFTER_LABEL_RE);
    if (!money) continue;
    const n = Number(String(money[1]).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    if (best == null || n > best) best = n;
  }
  return best;
};

const TAX_AMOUNT_KEYS = ["cgst_amount", "sgst_amount", "igst_amount", "utgst_amount", "cess_amount", "excise_amount", "ed_cess_amount"];
const AUX_AMOUNT_KEYS = ["tooling_amount", "p_and_f_amount", "others_amount"];

// Per-line gross. The tax/aux amounts on a PO line are PER UNIT (that is how
// the stacked multi-row layouts print them: Ex-Price 34,202 + SGST 3,078.18 +
// CGST 3,078.18 = Unit Price 40,358.36, x qty 2 = TotAmt 80,716.72), so they
// are multiplied by qty alongside the rate. Falls back to gst_pct when no
// explicit tax amounts were captured.
const lineGross = (l) => {
  const qty = numberOrNull(l?.quantity ?? l?.qty) ?? 0;
  const rate = numberOrNull(l?.unitPrice ?? l?.rate) ?? 0;
  const taxable = qty * rate;
  let perUnit = 0;
  let taxSeen = false;
  for (const k of [...TAX_AMOUNT_KEYS, ...AUX_AMOUNT_KEYS]) {
    const v = numberOrNull(l?.[k]);
    if (v != null && v > 0) { perUnit += v; taxSeen = true; }
  }
  if (taxSeen) return { taxable, gross: taxable + qty * perUnit, taxSeen: true };
  const pct = numberOrNull(l?.gst_pct);
  if (pct != null && pct > 0) return { taxable, gross: taxable * (1 + pct / 100), taxSeen: true };
  return { taxable, gross: taxable, taxSeen: false };
};

// When extraction captured no tax at all, the printed total is probably
// tax-inclusive while our sum is not. Widen the ceiling past the highest
// Indian slab (28%) so that case can never manufacture a blocker.
const MAX_TAX_INFLATION = 1.30;

//   opts.documentTotalCheckEnabled === false -> disabled.
//   opts.documentTotalErrorCoverage (default 0.80) -> below this = error.
//   opts.documentTotalWarnCoverage  (default 0.98) -> below this = warn.
const checkDocumentTotalShortfall = (normalized, opts = {}) => {
  if (opts.documentTotalCheckEnabled === false) return [];
  if (opts.kind && opts.kind !== "po" && opts.kind !== "rfq") return [];
  const printed = printedDocumentTotal(opts.bodyText);
  if (printed == null) return [];
  const lines = Array.isArray(normalized?.lines) ? normalized.lines : [];
  // 0 lines already fails the run outright; don't double-report it.
  if (!lines.length) return [];
  let gross = 0;
  let anyTax = false;
  let anyMoney = false;
  for (const l of lines) {
    const t = lineGross(l);
    gross += t.gross;
    if (t.taxSeen) anyTax = true;
    if (t.taxable > 0) anyMoney = true;
  }
  if (!anyMoney) return [];
  const ceiling = anyTax ? gross : gross * MAX_TAX_INFLATION;
  const coverage = ceiling / printed;
  const errAt = numberOrNull(opts.documentTotalErrorCoverage) ?? 0.80;
  const warnAt = numberOrNull(opts.documentTotalWarnCoverage) ?? 0.98;
  if (coverage >= warnAt) return [];
  const acct = Math.round(ceiling * 100) / 100;
  return [{
    code: "document_total_shortfall",
    severity: coverage < errAt ? "error" : "warn",
    path: "lines",
    actual: acct,
    expected: printed,
    detail: "document prints a total of " + printed.toFixed(2) + " but the " + lines.length
      + " extracted line" + (lines.length === 1 ? "" : "s") + " account for only " + acct.toFixed(2)
      + " (" + (coverage * 100).toFixed(1) + "%) — line items are probably missing or mis-read",
  }];
};

const checkCurrencyConsistency = (normalized) => {
  if (!normalized) return null;
  const headerCurr = normalized.customer?.currency;
  const lineCurrs = Array.isArray(normalized.lines)
    ? Array.from(new Set(normalized.lines.map((l) => l.currency).filter(Boolean)))
    : [];
  if (headerCurr && lineCurrs.length === 1 && lineCurrs[0] !== headerCurr) {
    return {
      code: "currency_inconsistent_with_lines",
      severity: "warn",
      path: "customer.currency",
      actual: headerCurr,
      expected: lineCurrs[0],
      detail: "customer.currency='" + headerCurr + "' but every line carries '" + lineCurrs[0] + "'",
    };
  }
  if (lineCurrs.length > 1) {
    return {
      code: "currency_mixed_in_lines",
      severity: "warn",
      path: "lines",
      actual: lineCurrs,
      detail: "lines carry mixed currencies: " + lineCurrs.join(", "),
    };
  }
  return null;
};

// Public entry. Returns an envelope:
//   {
//     anomalies: [{ code, severity, path, line_index?, actual,
//                   expected?, detail }],
//     summary: { error, warn, info, total },
//     has_blockers: bool,        // true when any severity='error'
//   }
//
// Designed to be persisted onto extraction_runs.anomalies
// (jsonb). The dispatcher writes the summary into the audit
// event so a diagnostics dashboard can chart anomaly rates over
// time. has_blockers drives the recon UI's blocking banner.
export const detectAnomalies = (normalized, opts = {}) => {
  if (!normalized) return { anomalies: [], summary: { error: 0, warn: 0, info: 0, total: 0 }, has_blockers: false };
  const anomalies = [];
  const lines = Array.isArray(normalized.lines) ? normalized.lines : [];
  for (let i = 0; i < lines.length; i++) {
    for (const issue of checkLine(lines[i], i, opts)) anomalies.push(issue);
  }
  const headerDate = checkPoDate(normalized.customer);
  if (headerDate) anomalies.push({ ...headerDate, path: "customer.po_date" });
  const currIssue = checkCurrencyConsistency(normalized);
  if (currIssue) anomalies.push(currIssue);
  anomalies.push(...checkTotals(normalized));
  anomalies.push(...checkLineCountShortfall(normalized, opts));
  anomalies.push(...checkDocumentTotalShortfall(normalized, opts));

  const summary = { error: 0, warn: 0, info: 0, total: anomalies.length };
  for (const a of anomalies) {
    if (a.severity === "error") summary.error++;
    else if (a.severity === "warn") summary.warn++;
    else if (a.severity === "info") summary.info++;
  }
  return {
    anomalies,
    summary,
    has_blockers: summary.error > 0,
  };
};

export const __test = { lineArithmetic, linePriceSanity, lineQtySanity, lineHsnSanity, lineGstSanity, checkTotals, checkLineCountShortfall, checkDocumentTotalShortfall, printedDocumentTotal, lineGross, KNOWN_GST_SLABS };
