// Multi-document cross-validation (Wave 3.6 / #14).
//
// Customers often send a PO accompanied by other documents: a
// spec sheet that lists the same items at the same quantities,
// a quote reference that the PO claims to acknowledge, an
// engineering drawing with the canonical part numbers stamped on
// it. When two documents both carry the same fact, we get a
// free consistency check; when they disagree, we have an
// anomaly even shape-validators couldn't catch.
//
// This module compares the extracted normalized outputs from N
// related documents (typically 2-3) and produces:
//
//   { matches:    [{ field, value, sources: [docId, docId] }],
//     conflicts:  [{ field, values: [{ docId, value }] }],
//     unique:     [{ docId, fields: [field paths only this doc has] }],
//     summary:    { match_count, conflict_count, unique_count } }
//
// Designed to be called by the order/orders handler when it
// detects multiple extraction_runs for the same case_id and they
// haven't yet been cross-validated. The result is persisted on
// the order's preflight_payload and a sticky banner surfaces
// "PO and Quote disagree on lines[2].unitPrice (PO=100, Quote=110)".
//
// Pure: no I/O, no DB writes. Caller batches the runs and feeds
// the normalized payloads in.

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

const stableEqual = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" || typeof b === "number") {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return Math.abs(na - nb) < 0.005;
    }
  }
  return String(a).trim() === String(b).trim();
};

// Flatten a normalized payload into a flat path -> value map.
// Lines unfold by index. Internal markers excluded.
const flatten = (norm) => {
  const out = {};
  if (!norm || typeof norm !== "object") return out;
  if (isPlainObject(norm.customer)) {
    for (const [k, v] of Object.entries(norm.customer)) {
      out["customer." + k] = v ?? null;
    }
  }
  if (Array.isArray(norm.lines)) {
    norm.lines.forEach((line, i) => {
      if (!isPlainObject(line)) return;
      for (const [k, v] of Object.entries(line)) {
        if (k.startsWith("_")) continue;
        out["lines[" + i + "]." + k] = v ?? null;
      }
    });
  }
  if (isPlainObject(norm.totals)) {
    for (const [k, v] of Object.entries(norm.totals)) {
      out["totals." + k] = v ?? null;
    }
  }
  return out;
};

// Public entry. docs = [{ docId, kind, normalized }] where kind
// is 'po' | 'quote' | 'invoice' | 'spec' | 'ack' | ... .
//
// Strategy:
//   - For each field path, collect the per-doc value.
//   - Group by stableEqual (numeric tolerance, whitespace trim).
//   - If all docs agree -> match.
//   - If 2+ docs disagree -> conflict (surface every distinct
//     value with the doc it came from).
//   - If only 1 doc has a value (rest null) -> unique (skipped
//     in summary because that's just incomplete data, not a
//     conflict; but recorded on the per-doc unique list).
//
// PO and Quote being the canonical pairing, conflicts on
// customer.gstin / customer.bill_to_address / lines[*].partNumber
// are flagged as high severity; conflicts on totals.grand_total
// as critical (the operator should NOT confirm a PO whose total
// differs from the linked Quote).
export const crossValidateDocuments = (docs) => {
  if (!Array.isArray(docs) || docs.length < 2) {
    return { matches: [], conflicts: [], unique: [], summary: { match_count: 0, conflict_count: 0, unique_count: 0 } };
  }
  const flats = docs.map((d) => ({ docId: d.docId, kind: d.kind, flat: flatten(d.normalized) }));
  const fields = new Set();
  for (const f of flats) for (const k of Object.keys(f.flat)) fields.add(k);
  const matches = [];
  const conflicts = [];
  const unique = flats.map((f) => ({ docId: f.docId, fields: [] }));
  for (const field of fields) {
    const valuesByDoc = flats.map((f) => ({ docId: f.docId, value: f.flat[field] }));
    const withValue = valuesByDoc.filter((v) => v.value != null && v.value !== "");
    if (withValue.length === 0) continue;
    if (withValue.length === 1) {
      // Only one doc has it. Note as unique-to-that-doc.
      const idx = flats.findIndex((f) => f.docId === withValue[0].docId);
      if (idx >= 0) unique[idx].fields.push(field);
      continue;
    }
    // Multiple docs have a value. Bucket by stableEqual.
    const buckets = [];
    for (const v of withValue) {
      let placed = false;
      for (const b of buckets) {
        if (stableEqual(b.value, v.value)) {
          b.sources.push(v.docId);
          placed = true;
          break;
        }
      }
      if (!placed) buckets.push({ value: v.value, sources: [v.docId] });
    }
    if (buckets.length === 1) {
      matches.push({ field, value: buckets[0].value, sources: buckets[0].sources });
    } else {
      conflicts.push({
        field,
        values: buckets.map((b) => ({ docs: b.sources, value: b.value })),
        severity: classifySeverity(field),
      });
    }
  }
  return {
    matches,
    conflicts,
    unique,
    summary: {
      match_count: matches.length,
      conflict_count: conflicts.length,
      unique_count: unique.reduce((s, u) => s + u.fields.length, 0),
    },
  };
};

const CRITICAL_FIELDS = new Set([
  "totals.grand_total", "totals.subtotal", "totals.tax_amount",
  "customer.gstin",
]);
const HIGH_SEVERITY_PREFIXES = ["customer.", "totals."];

const classifySeverity = (field) => {
  if (CRITICAL_FIELDS.has(field)) return "critical";
  if (HIGH_SEVERITY_PREFIXES.some((p) => field.startsWith(p))) return "high";
  if (field.startsWith("lines[") && (field.endsWith(".partNumber") || field.endsWith(".unitPrice") || field.endsWith(".quantity") || field.endsWith(".amount"))) return "high";
  return "medium";
};

export const __test = { flatten, stableEqual, classifySeverity };
