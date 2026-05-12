// L6 cross-adapter voter.
//
// Phase C of EXTRACTION_PIPELINE_PLAN.md. The dispatcher's default
// path runs adapters serially and stops at the first ok+confident
// one. That's cheap and works for clean extractions, but when two
// adapters disagree on a single field (Reducto reads "PO-12345"
// while Claude reads "PO-12346") the dispatcher's first-wins logic
// hides the disagreement.
//
// The voter runs the dispatch chain in PARALLEL when at least two
// adapters are configured AND the caller asked for a vote, then
// reduces the per-adapter outputs into a single normalized
// extraction with per-field provenance:
//
//   - For scalar customer fields: pick the most common non-null
//     value across adapters; ties broken by per-adapter
//     confidence; ties on confidence broken by adapter rank
//     (operator's docai_provider_order).
//
//   - For lines: align by partNumber when present (canonical key)
//     or by description-similarity-then-row-index when absent.
//     Each aligned bucket is voted independently.
//
// Output:
//   { normalized, field_provenance, voter_lines, confidences,
//     attempts, ok, voter_used: true }
//
// Pure: no DB writes, no I/O. Caller persists field_provenance +
// voter_lines.

const FIELD_PATHS = [
  "customer.name", "customer.email", "customer.phone",
  "customer.po_number", "customer.po_date", "customer.gstin",
  "customer.state_code", "customer.currency", "customer.payment_terms",
  "customer.bill_to_address", "customer.ship_to_address",
];

const get = (obj, path) => {
  if (!obj) return null;
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur == null ? null : cur;
};

const set = (obj, path, value) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
};

// Group adapter outputs by their reported value for a single field.
// We treat string-equal values as the same vote, with case +
// whitespace normalisation.
const normaliseScalar = (v) => {
  if (v == null) return null;
  if (typeof v === "string") return v.trim();
  return v;
};

const buildVoterEntries = (adapterResults) =>
  adapterResults
    .filter((r) => r && r.ok && r.normalized)
    .map((r) => ({
      adapter: r.adapter_used,
      ok: !!r.ok,
      confidence: Number(r.confidence_overall ?? 0) || 0,
      normalized: r.normalized,
      rank: r._rank ?? 99,        // dispatcher attaches ordering
    }));

// Vote a single scalar field across the entries. Returns the
// chosen { value, source, confidence, voters }.
const voteScalar = (entries, fieldPath) => {
  const voters = entries.map((e) => ({
    adapter: e.adapter,
    value: normaliseScalar(get(e.normalized, fieldPath)),
    confidence: e.confidence,
    ok: e.ok,
  }));
  // Group by stringified value (excluding null).
  const buckets = new Map();
  for (const v of voters) {
    if (v.value == null || v.value === "") continue;
    const key = JSON.stringify(v.value);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(v);
  }
  if (buckets.size === 0) {
    return {
      field: fieldPath,
      value: null,
      source: null,
      confidence: 0,
      voters,
    };
  }
  // Pick the bucket with most votes; ties broken by max confidence
  // in the bucket; ties on confidence broken by lowest rank
  // (dispatcher order).
  const ranked = Array.from(buckets.entries())
    .map(([_key, members]) => ({
      members,
      count: members.length,
      maxConf: Math.max(...members.map((m) => m.confidence)),
      minRankIndex: Math.min(
        ...members.map((m) => entries.findIndex((e) => e.adapter === m.adapter)),
      ),
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.maxConf !== a.maxConf) return b.maxConf - a.maxConf;
      return a.minRankIndex - b.minRankIndex;
    });
  const winner = ranked[0];
  const winningValue = winner.members[0].value;
  const winningEntry = winner.members.reduce(
    (best, m) => (m.confidence > best.confidence ? m : best),
    winner.members[0],
  );
  return {
    field: fieldPath,
    value: winningValue,
    source: winningEntry.adapter,
    confidence: winningEntry.confidence,
    voters,
  };
};

// Align lines across adapters. Strategy:
//
//   1. Collect all unique partNumbers from all adapters.
//   2. For each partNumber, gather every adapter's line that has
//      that partNumber. Vote on each line field (description, qty,
//      unitPrice, hsn, gst_pct).
//   3. Lines with NO partNumber on any adapter (e.g. all adapters
//      returned generic "Item 1", "Item 2") align by row index.
//   4. Lines that exist in only one adapter still carry through;
//      provenance shows that adapter alone supplied them.
const LINE_FIELDS = ["partNumber", "description", "quantity", "unitPrice", "uom", "hsn", "gst_pct"];

const stringifyKey = (v) => (v == null ? "" : String(v).trim().toLowerCase());

const groupLinesByPartNumber = (entries) => {
  const groups = new Map();
  // Lines that lack a partNumber go into a positional bucket
  // ("__pos:N") so we still align by row order.
  for (const e of entries) {
    const lines = Array.isArray(e.normalized?.lines) ? e.normalized.lines : [];
    lines.forEach((l, i) => {
      const pn = stringifyKey(l?.partNumber);
      const key = pn || ("__pos:" + i);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ adapter: e.adapter, line: l, idx: i, conf: e.confidence });
    });
  }
  return groups;
};

const voteLine = (members) => {
  // Per-field vote across all adapter members of this line bucket.
  const out = {};
  const provenance = {};
  for (const f of LINE_FIELDS) {
    const voters = members.map((m) => ({
      adapter: m.adapter,
      value: normaliseScalar(m.line?.[f]),
      confidence: m.conf,
      ok: true,
    }));
    const buckets = new Map();
    for (const v of voters) {
      if (v.value == null || v.value === "") continue;
      const key = JSON.stringify(v.value);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(v);
    }
    if (buckets.size === 0) {
      out[f] = null;
      provenance[f] = { source: null, confidence: 0, voters };
      continue;
    }
    const ranked = Array.from(buckets.entries())
      .map(([_k, members2]) => ({
        members: members2,
        count: members2.length,
        maxConf: Math.max(...members2.map((m) => m.confidence)),
      }))
      .sort((a, b) => (b.count - a.count) || (b.maxConf - a.maxConf));
    const winner = ranked[0];
    const wEntry = winner.members.reduce(
      (best, m) => (m.confidence > best.confidence ? m : best),
      winner.members[0],
    );
    out[f] = wEntry.value;
    provenance[f] = { source: wEntry.adapter, confidence: wEntry.confidence, voters };
  }
  return { line: out, provenance };
};

const voteLines = (entries) => {
  const groups = groupLinesByPartNumber(entries);
  const lines = [];
  const lineProvenance = [];
  // Stable sort: positional bucket order, then partNumber.
  const orderedKeys = Array.from(groups.keys()).sort((a, b) => {
    const aPos = a.startsWith("__pos:");
    const bPos = b.startsWith("__pos:");
    if (aPos && bPos) return Number(a.slice(6)) - Number(b.slice(6));
    if (aPos) return -1;
    if (bPos) return 1;
    return a.localeCompare(b);
  });
  let lineIdx = 0;
  for (const key of orderedKeys) {
    const members = groups.get(key);
    const { line, provenance } = voteLine(members);
    if (Object.values(line).every((v) => v == null)) continue;
    lines.push(line);
    lineProvenance.push({
      line_idx: lineIdx,
      bucket: key,
      sources: members.map((m) => ({ adapter: m.adapter, idx: m.idx })),
      fields: provenance,
    });
    lineIdx++;
  }
  return { lines, lineProvenance };
};

import { augmentVoterOutput } from "./field-voter.js";

// Reduce N adapter results into a single voted output. Returns the
// canonical { ok, normalized, confidences, field_provenance,
// voter_lines, voter_used: true, attempts }.
export const voteAcrossAdapters = (adapterResults) => {
  const entries = buildVoterEntries(adapterResults);
  if (entries.length < 2) {
    // No quorum to vote against. Caller falls back to first-wins.
    return null;
  }

  // Customer scalar fields.
  const fieldProvenance = FIELD_PATHS.map((p) => voteScalar(entries, p));
  const customer = {};
  for (const fp of fieldProvenance) {
    if (fp.value != null) {
      const subPath = fp.field.replace(/^customer\./, "");
      customer[subPath] = fp.value;
    }
  }

  // Classification: pick majority; ties broken by max confidence.
  const classProvenance = voteScalar(entries, "classification");
  const classification = classProvenance.value || null;

  // Lines.
  const { lines, lineProvenance } = voteLines(entries);

  // Aggregate confidences. Per-field confidence comes from the
  // winning entry's confidence; overall is mean of non-null
  // winners.
  const confidences = { overall: 0 };
  fieldProvenance.forEach((p) => {
    if (p.value != null) confidences[p.field] = p.confidence;
  });
  lineProvenance.forEach((lp, i) => {
    const lineConf = Object.values(lp.fields)
      .filter((f) => f.confidence > 0)
      .reduce((acc, f) => acc + f.confidence, 0)
      / Math.max(1, Object.values(lp.fields).filter((f) => f.confidence > 0).length);
    confidences["lines[" + i + "]"] = Number.isFinite(lineConf) ? lineConf : 0;
  });
  const winnerConfs = [
    ...fieldProvenance.filter((p) => p.value != null).map((p) => p.confidence),
    ...lineProvenance.map((_lp, i) => confidences["lines[" + i + "]"] || 0),
  ].filter((c) => c > 0);
  confidences.overall = winnerConfs.length
    ? winnerConfs.reduce((a, b) => a + b, 0) / winnerConfs.length
    : 0;

  // Wave 3.2: field-level numeric voter. Augments the merged
  // output by re-voting on numeric line / totals fields with
  // tolerance + median + agreement-confidence-boost. The string-
  // vote above stays authoritative for customer block fields
  // (name, GSTIN, address); numeric fields benefit from the
  // tolerance grouping. Mutates the merged normalized in place
  // and returns its own per-field provenance.
  const augmented = augmentVoterOutput(
    { classification, customer: Object.keys(customer).length ? customer : null, lines },
    adapterResults,
  );
  const numericProvenance = augmented.fieldProvenance || [];
  // Recompute confidence_overall to fold in the boosted figures.
  if (numericProvenance.length) {
    for (const fp of numericProvenance) {
      confidences[fp.field] = fp.confidence;
    }
    const allConfs = Object.entries(confidences)
      .filter(([k, v]) => k !== "overall" && v > 0)
      .map(([, v]) => v);
    if (allConfs.length) {
      confidences.overall = allConfs.reduce((a, b) => a + b, 0) / allConfs.length;
    }
  }

  return {
    ok: true,
    voter_used: true,
    adapter_used: "voter",
    normalized: {
      classification,
      customer: Object.keys(customer).length ? customer : null,
      lines,
    },
    confidences,
    confidence_overall: confidences.overall,
    field_provenance: [
      ...fieldProvenance,
      { ...classProvenance, field: "classification" },
      ...numericProvenance,
    ],
    voter_lines: lineProvenance,
    attempts: adapterResults.map((r) => ({
      adapter: r.adapter_used,
      status: r.ok ? "ok" : "failed",
      confidence: r.confidence_overall,
    })),
  };
};

// Exported for tests.
export const __test__ = {
  voteScalar, voteLines, groupLinesByPartNumber, FIELD_PATHS,
};

// Convenience used by the run helper.
export const setNested = set;
