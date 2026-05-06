// POST /api/format_profile/check
//
// Customer-PO format pre-check. Given an extracted document payload
// and the relevant customer's stored format profile, runs a layered
// validation pass and returns a structured result the OCR-review UI
// can render as a banner / per-field tint / per-line warning.
//
// Layers (industry-standard, all deterministic and unit-testable):
//
//   1. Required-fields presence: profile.recipe.required_headers
//      lists header keys the PO must include (e.g. po_number,
//      buyer_gst, ship_to). Missing keys => HIGH severity.
//
//   2. Per-field regex pre-check: profile.recipe.field_patterns is
//      a { field_path: pattern } map. Each value must match.
//      Mismatches => MEDIUM severity, with the pattern + value
//      surfaced for the operator.
//
//   3. Fuzzy alias resolution: profile.learned_rules.aliases maps
//      observed alias text -> canonical SKU/term. Levenshtein
//      distance with normalised strings finds a best match within
//      threshold (default 2). Each line's part_number is resolved
//      to canonical and a `suggested_value` returned when it isn't
//      already canonical.
//
//   4. Cross-field arithmetic: enforces
//        line_total ≈ qty * unit_price        (tolerance 0.01)
//        subtotal ≈ Σ line_total              (tolerance 0.05)
//        gst ≈ subtotal * gst_rate            (tolerance 0.05)
//        grand_total ≈ subtotal + gst         (tolerance 0.05)
//      Mismatches => MEDIUM severity. All comparisons use a
//      configurable tolerance (relative + absolute) so we don't
//      flag rounding noise.
//
//   5. Header-fingerprint drift: hashes the keys observed in the
//      doc and compares to profile.fingerprint.headers. A drifted
//      fingerprint is a LOW severity nudge ("looks like the layout
//      changed"). Doesn't block, but recommends a profile refresh.
//
// All exports are pure: `runChecks(payload, profile, opts)` is a
// function of its inputs. The HTTP wrapper is just IO and audit.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// === Levenshtein with early-exit at threshold =============================
// Two-row dynamic programming. Returns Infinity early when the row
// minimum exceeds the supplied threshold so we don't waste cycles
// on obvious non-matches against a 5,000-SKU dictionary.
const levenshtein = (a, b, threshold = Infinity) => {
  const A = String(a || "");
  const B = String(b || "");
  if (A === B) return 0;
  if (!A.length) return B.length;
  if (!B.length) return A.length;
  if (Math.abs(A.length - B.length) > threshold) return Infinity;
  let prev = new Array(B.length + 1);
  let cur = new Array(B.length + 1);
  for (let j = 0; j <= B.length; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= B.length; j++) {
      const cost = A.charCodeAt(i - 1) === B.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + cost,
      );
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > threshold) return Infinity;
    [prev, cur] = [cur, prev];
  }
  return prev[B.length];
};

// Casefold + collapse runs of spaces / dashes so "BR-6204 ZZ" and
// "br 6204-zz" are treated as the same input for distance scoring.
const normalisePart = (s) =>
  String(s || "").toLowerCase().replace(/[\s\-_/]+/g, "").trim();

// === Numeric tolerance ====================================================
// Allow 1% relative OR 0.01 absolute, whichever is larger. Picks up
// real arithmetic errors while ignoring penny-rounding.
const closeEnough = (a, b, opts = {}) => {
  const rel = opts.rel != null ? opts.rel : 0.01;
  const abs = opts.abs != null ? opts.abs : 0.01;
  const A = Number(a);
  const B = Number(b);
  if (!Number.isFinite(A) || !Number.isFinite(B)) return false;
  const diff = Math.abs(A - B);
  return diff <= Math.max(abs, rel * Math.max(Math.abs(A), Math.abs(B)));
};

// === Stable header fingerprint ============================================
// Canonical sorted-keys join, then a 32-bit FNV-1a so different
// header sets give different fingerprints. Avoids depending on
// crypto in the browser-shared bundle.
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

const headerFingerprint = (header = {}) => {
  const keys = Object.keys(header || {}).map((k) => k.toLowerCase()).sort();
  return fnv1a(keys.join("|"));
};

// === Per-layer checks =====================================================

const checkRequired = (header = {}, recipe = {}) => {
  const required = Array.isArray(recipe.required_headers) ? recipe.required_headers : [];
  const issues = [];
  required.forEach((k) => {
    const v = header[k];
    const missing = v == null || (typeof v === "string" && !v.trim());
    if (missing) {
      issues.push({
        layer: "required_fields",
        severity: "high",
        field_path: "header." + k,
        message: "Required header `" + k + "` missing or blank",
      });
    }
  });
  return issues;
};

const checkPatterns = (header = {}, recipe = {}) => {
  const patterns = recipe.field_patterns || {};
  const issues = [];
  Object.keys(patterns).forEach((k) => {
    const v = header[k];
    if (v == null || v === "") return; // missingness handled by checkRequired
    let re;
    try { re = new RegExp(patterns[k]); } catch (_) { return; }
    if (!re.test(String(v))) {
      issues.push({
        layer: "field_pattern",
        severity: "medium",
        field_path: "header." + k,
        message: "Value does not match expected pattern",
        observed_value: String(v),
        expected_pattern: patterns[k],
      });
    }
  });
  return issues;
};

const resolveAliases = (lines = [], learnedRules = {}, opts = {}) => {
  const aliases = learnedRules.aliases || {};
  const threshold = opts.aliasThreshold != null ? opts.aliasThreshold : 2;
  // Pre-normalise dictionary once.
  const dict = Object.keys(aliases).map((k) => ({
    raw: k, norm: normalisePart(k), canonical: aliases[k],
  }));
  const issues = [];
  const suggestions = [];
  lines.forEach((ln, idx) => {
    const part = ln && ln.part_number;
    if (part == null || part === "") return;
    const norm = normalisePart(part);
    // Direct hit on canonical (already in aliases as a key whose
    // value equals itself, or already canonical anywhere).
    const canonValues = Object.values(aliases);
    if (canonValues.indexOf(part) >= 0) return;
    // Direct alias hit.
    const direct = dict.find((d) => d.norm === norm);
    if (direct) {
      suggestions.push({
        line_index: idx,
        field_path: "lines[" + idx + "].part_number",
        observed_value: part,
        suggested_value: direct.canonical,
        confidence: 1.0,
        method: "alias_direct",
      });
      return;
    }
    // Fuzzy alias hit within threshold.
    let best = { dist: Infinity, canonical: null, raw: null };
    dict.forEach((d) => {
      const dist = levenshtein(norm, d.norm, threshold);
      if (dist < best.dist) best = { dist, canonical: d.canonical, raw: d.raw };
    });
    if (best.dist <= threshold && best.canonical) {
      const conf = Math.max(0, 1 - best.dist / Math.max(1, norm.length));
      suggestions.push({
        line_index: idx,
        field_path: "lines[" + idx + "].part_number",
        observed_value: part,
        suggested_value: best.canonical,
        suggested_alias: best.raw,
        confidence: Number(conf.toFixed(2)),
        method: "alias_fuzzy",
        edit_distance: best.dist,
      });
      issues.push({
        layer: "alias_fuzzy",
        severity: "low",
        field_path: "lines[" + idx + "].part_number",
        message: "Possible alias match: `" + part + "` -> `" + best.canonical + "`",
      });
    }
  });
  return { issues, suggestions };
};

const checkArithmetic = (payload = {}, opts = {}) => {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const header = payload.header || {};
  const issues = [];
  let computedSubtotal = 0;
  lines.forEach((ln, idx) => {
    const qty = Number(ln.qty);
    const price = Number(ln.unit_price);
    const total = Number(ln.line_total);
    if (Number.isFinite(qty) && Number.isFinite(price)) {
      const expected = qty * price;
      if (Number.isFinite(total) && !closeEnough(total, expected, opts)) {
        issues.push({
          layer: "line_arithmetic",
          severity: "medium",
          field_path: "lines[" + idx + "].line_total",
          message: "Line total " + total + " ≠ qty × unit_price (" + expected.toFixed(2) + ")",
          observed_value: total,
          expected_value: Number(expected.toFixed(2)),
        });
      }
      computedSubtotal += Number.isFinite(total) ? total : expected;
    }
  });
  const subtotal = Number(header.subtotal);
  if (Number.isFinite(subtotal) && lines.length && !closeEnough(subtotal, computedSubtotal, { rel: 0.005, abs: 0.05 })) {
    issues.push({
      layer: "subtotal_sum",
      severity: "medium",
      field_path: "header.subtotal",
      message: "Header subtotal " + subtotal + " ≠ Σ line totals (" + computedSubtotal.toFixed(2) + ")",
      observed_value: subtotal,
      expected_value: Number(computedSubtotal.toFixed(2)),
    });
  }
  const gst = Number(header.gst);
  const gstRate = Number(header.gst_rate);
  if (Number.isFinite(gst) && Number.isFinite(gstRate) && Number.isFinite(subtotal)) {
    const expectedGst = subtotal * gstRate;
    if (!closeEnough(gst, expectedGst, { rel: 0.01, abs: 0.05 })) {
      issues.push({
        layer: "gst_consistency",
        severity: "medium",
        field_path: "header.gst",
        message: "GST " + gst + " ≠ subtotal × gst_rate (" + expectedGst.toFixed(2) + ")",
        observed_value: gst,
        expected_value: Number(expectedGst.toFixed(2)),
      });
    }
  }
  const grand = Number(header.grand_total);
  if (Number.isFinite(grand) && Number.isFinite(subtotal)) {
    const expectedGrand = subtotal + (Number.isFinite(gst) ? gst : 0);
    if (!closeEnough(grand, expectedGrand, { rel: 0.005, abs: 0.05 })) {
      issues.push({
        layer: "grand_total",
        severity: "medium",
        field_path: "header.grand_total",
        message: "Grand total " + grand + " ≠ subtotal + gst (" + expectedGrand.toFixed(2) + ")",
        observed_value: grand,
        expected_value: Number(expectedGrand.toFixed(2)),
      });
    }
  }
  return issues;
};

const checkFingerprint = (payload = {}, profile = {}) => {
  const expected = profile.fingerprint && profile.fingerprint.headers;
  if (!expected) return [];
  const observed = headerFingerprint(payload.header || {});
  if (observed === expected) return [];
  return [{
    layer: "header_fingerprint",
    severity: "low",
    field_path: "header",
    message: "Header layout fingerprint changed (" + expected + " -> " + observed + "); profile may need a refresh",
    observed_value: observed,
    expected_value: expected,
  }];
};

// === Top-level orchestrator ===============================================
// Returns:
//   {
//     ok: bool,                      // no high-severity issues
//     summary: { high, medium, low, total },
//     issues: [...],                 // every issue, ordered by severity
//     suggestions: [...],            // alias replacements the UI can offer
//     fingerprint: { observed, expected, drift },
//   }
const runChecks = (payload = {}, profile = null, opts = {}) => {
  const recipe = (profile && profile.recipe) || {};
  const learned = (profile && profile.learned_rules) || {};
  const issues = [];
  issues.push(...checkRequired(payload.header || {}, recipe));
  issues.push(...checkPatterns(payload.header || {}, recipe));
  const arith = checkArithmetic(payload, opts);
  issues.push(...arith);
  const aliasOut = resolveAliases(payload.lines || [], learned, opts);
  issues.push(...aliasOut.issues);
  issues.push(...checkFingerprint(payload, profile || {}));

  const sevRank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  const summary = { high: 0, medium: 0, low: 0, total: issues.length };
  issues.forEach((i) => { summary[i.severity] = (summary[i.severity] || 0) + 1; });

  const observedFp = headerFingerprint(payload.header || {});
  const expectedFp = (profile && profile.fingerprint && profile.fingerprint.headers) || null;

  return {
    ok: summary.high === 0,
    summary,
    issues,
    suggestions: aliasOut.suggestions,
    fingerprint: {
      observed: observedFp,
      expected: expectedFp,
      drift: !!(expectedFp && expectedFp !== observedFp),
    },
  };
};

// Test export.
export const __test = {
  levenshtein, normalisePart, closeEnough, headerFingerprint,
  checkRequired, checkPatterns, resolveAliases, checkArithmetic,
  checkFingerprint, runChecks,
};

export {
  levenshtein, normalisePart, closeEnough, headerFingerprint,
  checkRequired, checkPatterns, resolveAliases, checkArithmetic,
  checkFingerprint, runChecks,
};

// === HTTP handler =========================================================
// POST /api/format_profile/check
// Body: { customer_id, payload: { header, lines, ... }, profile? }
// If `profile` is supplied (used by tests / callers that already
// have it), we skip the database fetch.
export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    if (!body || !body.payload) {
      return json(res, 400, { error: { message: "payload required" } });
    }
    let profile = body.profile || null;
    if (!profile && body.customer_id) {
      const svc = serviceClient();
      const r = await svc.from("customer_format_profiles")
        .select("fingerprint, recipe, learned_rules, version, trusted")
        .eq("tenant_id", ctx.tenantId)
        .eq("customer_id", body.customer_id)
        .eq("is_current", true)
        .maybeSingle();
      if (r.error) throw new Error(r.error.message);
      profile = r.data || null;
    }
    const result = runChecks(body.payload, profile || null, body.opts || {});
    return json(res, 200, { ...result, profile_present: !!profile });
  } catch (err) {
    sendError(res, err);
  }
}
