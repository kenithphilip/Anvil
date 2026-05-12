// Field-level voter augmentation (Wave 3.2 / #10).
//
// voter.js already does line-level + scalar-field voting across
// adapters: it groups adapter outputs by stringified value and
// picks the bucket with the most votes. That works well for
// strings (GSTIN, customer name) but is brittle for numerics:
//
//   - Adapter A returns line.unitPrice = 100.0
//   - Adapter B returns line.unitPrice = 100.05 (1.5% rounding)
//   - Adapter C returns line.unitPrice = 100.00
//
//   String comparison says each is unique. The dispatcher's
//   tie-break picks the lowest-rank adapter. The true consensus
//   (~100) is lost.
//
// This module adds:
//
//   1. Numeric-tolerance grouping. Two values within
//      OPTS.tolerance_pct (default 1%) of each other land in the
//      same bucket. Tolerance is symmetric and falls back to a
//      fixed-cents floor for sub-1 prices.
//
//   2. Median-fallback. When no bucket has 2+ votes, return the
//      median of the candidates. Median is robust to a single
//      adapter's bad OCR.
//
//   3. Confidence boost on agreement. When 2+ adapters agree on
//      a field within tolerance, raise the field's confidence
//      to min(1, max(agreeing_confidences) * 1.10). The voter's
//      consumer (run.js) lifts validator-adjusted confidence
//      floor accordingly.
//
//   4. Provenance trail per field. Each output field carries
//      { adapters, mode: 'majority'|'median'|'single',
//        agreement_count, confidence_boosted }.
//
// The augmentation is non-destructive: it runs AFTER voter.js
// produces its merged normalized output and OVERWRITES only the
// numeric fields where the augmenter has stronger evidence.

const DEFAULT_TOLERANCE_PCT = 0.01;          // 1%
const DEFAULT_TOLERANCE_FLOOR = 0.05;        // 5 paise
const AGREEMENT_CONFIDENCE_BOOST = 1.10;

const isNumeric = (v) => {
  if (v == null) return false;
  const n = Number(v);
  return Number.isFinite(n);
};

const median = (xs) => {
  if (!xs.length) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// Group candidates within tolerance. Returns an array of buckets
// where each bucket = { center, members: [{value, confidence, adapter}] }.
//
// Simple greedy bucketing: sort, walk left to right, start a new
// bucket whenever the gap exceeds tolerance. This is O(n log n)
// and good enough for the n <= 6 case the voter sees.
export const groupNumericByTolerance = (candidates, tolerancePct, toleranceFloor) => {
  const pct = Number.isFinite(tolerancePct) ? tolerancePct : DEFAULT_TOLERANCE_PCT;
  const floor = Number.isFinite(toleranceFloor) ? toleranceFloor : DEFAULT_TOLERANCE_FLOOR;
  const sorted = candidates.slice().sort((a, b) => a.value - b.value);
  const buckets = [];
  for (const c of sorted) {
    if (!buckets.length) {
      buckets.push({ center: c.value, members: [c] });
      continue;
    }
    const last = buckets[buckets.length - 1];
    const lastCenter = last.center;
    const tol = Math.max(floor, Math.abs(lastCenter) * pct);
    if (Math.abs(c.value - lastCenter) <= tol) {
      last.members.push(c);
      // Re-center as running mean for stability.
      last.center = last.members.reduce((s, m) => s + m.value, 0) / last.members.length;
    } else {
      buckets.push({ center: c.value, members: [c] });
    }
  }
  return buckets;
};

// Cast a single field across multiple adapter outputs. Returns:
//   { value, mode, agreement_count, confidence, source_adapters }
//
// modes:
//   'single'   one adapter returned a value
//   'majority' two or more adapters agreed within tolerance
//   'median'   no agreement; we used the median of all candidates
//   'none'     no candidates at all
export const voteNumericField = (candidates, opts = {}) => {
  // candidates: [{ value, confidence, adapter }]
  const filtered = candidates.filter((c) => isNumeric(c.value));
  if (!filtered.length) return { value: null, mode: "none", agreement_count: 0, confidence: 0, source_adapters: [] };
  const numerics = filtered.map((c) => ({ value: Number(c.value), confidence: Number(c.confidence) || 0, adapter: c.adapter }));
  if (numerics.length === 1) {
    return {
      value: numerics[0].value,
      mode: "single",
      agreement_count: 1,
      confidence: numerics[0].confidence,
      source_adapters: [numerics[0].adapter],
      confidence_boosted: false,
    };
  }
  const buckets = groupNumericByTolerance(numerics, opts.tolerancePct, opts.toleranceFloor);
  buckets.sort((a, b) => b.members.length - a.members.length || Math.max(...b.members.map((m) => m.confidence)) - Math.max(...a.members.map((m) => m.confidence)));
  const top = buckets[0];
  if (top.members.length >= 2) {
    const maxConf = Math.max(...top.members.map((m) => m.confidence));
    const boosted = Math.min(1, maxConf * AGREEMENT_CONFIDENCE_BOOST);
    return {
      value: top.center,
      mode: "majority",
      agreement_count: top.members.length,
      confidence: boosted,
      source_adapters: top.members.map((m) => m.adapter),
      confidence_boosted: boosted > maxConf,
    };
  }
  // No agreement; median fallback. Median is robust to one bad
  // adapter; mean is not.
  const med = median(numerics.map((n) => n.value));
  return {
    value: med,
    mode: "median",
    agreement_count: 0,
    confidence: Math.max(...numerics.map((m) => m.confidence)) * 0.85,  // small de-rate
    source_adapters: numerics.map((m) => m.adapter),
    confidence_boosted: false,
  };
};

// Public augmenter: scan the per-adapter outputs and replace
// numeric fields on the merged normalized output with the
// field-voted value. Mutates the merged object in place to keep
// the merge step idempotent.
const NUMERIC_LINE_FIELDS = ["quantity", "unitPrice", "amount", "discount_pct", "gst_pct", "tax_amount"];
const NUMERIC_HEADER_FIELDS = ["totals.subtotal", "totals.tax_amount", "totals.grand_total"];

const getPath = (obj, path) => {
  if (!obj) return null;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
};
const setPath = (obj, path, v) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = v;
};

export const augmentVoterOutput = (mergedNormalized, adapterResults, opts = {}) => {
  if (!mergedNormalized || !Array.isArray(adapterResults)) return { adjusted: 0, fieldProvenance: [] };
  const okResults = adapterResults.filter((r) => r && r.ok && r.normalized);
  if (okResults.length < 2) return { adjusted: 0, fieldProvenance: [] };
  const fieldProvenance = [];
  let adjusted = 0;
  // Header / totals fields.
  for (const path of NUMERIC_HEADER_FIELDS) {
    const candidates = okResults.map((r) => ({
      value: getPath(r.normalized, path),
      confidence: Number(r.confidence_overall || 0),
      adapter: r.adapter_used,
    }));
    const out = voteNumericField(candidates, opts);
    if (out.value != null) {
      setPath(mergedNormalized, path, out.value);
      fieldProvenance.push({ field: path, ...out });
      adjusted++;
    }
  }
  // Per-line numeric fields. Match lines across adapters by index
  // (the voter already aligns lines via the part_no / line_index
  // grouping; here we just hit the merged line at index i and
  // look up the equivalent on each adapter's normalized.lines[i]).
  if (Array.isArray(mergedNormalized.lines)) {
    for (let i = 0; i < mergedNormalized.lines.length; i++) {
      const mergedLine = mergedNormalized.lines[i];
      for (const fld of NUMERIC_LINE_FIELDS) {
        const candidates = okResults
          .map((r) => {
            const lines = Array.isArray(r.normalized.lines) ? r.normalized.lines : [];
            const line = lines[i];
            return line ? {
              value: line[fld],
              confidence: Number(r.confidence_overall || 0),
              adapter: r.adapter_used,
            } : null;
          })
          .filter(Boolean);
        const out = voteNumericField(candidates, opts);
        if (out.value != null) {
          mergedLine[fld] = out.value;
          fieldProvenance.push({ field: "lines[" + i + "]." + fld, ...out });
          adjusted++;
        }
      }
    }
  }
  return { adjusted, fieldProvenance };
};

export const __test = {
  groupNumericByTolerance, median,
  DEFAULT_TOLERANCE_PCT, AGREEMENT_CONFIDENCE_BOOST,
};
