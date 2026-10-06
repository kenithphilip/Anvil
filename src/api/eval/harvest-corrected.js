// PR 4 of docs/EXTRACTION_QUALITY.md — harvest goldens from CORRECTED runs.
//
// §8 of that assessment names the way a golden set rots:
//
//   "The golden set drifts to what we already pass. It harvests from APPROVED
//    orders, so it fills with documents the pipeline handled well. Guard:
//    harvest corrected runs too, deliberately."
//
// That is exactly right. promote.js snapshots an order the moment a human
// APPROVES it — which selects, by construction, for documents the extractor
// got right first time. Run that for a year and the regression gate is a
// museum of easy PDFs.
//
// The opposite signal is already in the database and unused: extraction_corrections
// stores field_path + corrected_value for every field an operator had to fix.
// Apply those corrections back onto the run's normalized_extract and you have
// human-verified ground truth for a document the pipeline got WRONG — the
// single most valuable kind of fixture, and free.
//
// It is also KIND-AGNOSTIC in a way the approved-order harvest can never be:
// it reads extraction_runs, so it works for a quote, a packing list or an
// invoice without a join to `orders`. Today only the SO workspace has a
// correction UI, so in practice it fires on POs; the moment PR 5 lands
// correction on the other review surfaces, this starts self-populating for
// them with no further work.

import { profileFor, toScorableFor } from "./kind-profiles.js";

// ── pure: the field_path grammar ─────────────────────────────────────
//
// Corrections address fields as "customer.po_number" and "lines[3].quantity".
// _lib/docai/overrides.js has a get/set pair that splits on "." only, so it
// cannot reach into an array — it would create a literal "lines[3]" key on the
// object and leave the real line untouched. This one understands brackets.
export const parsePath = (path) => {
  const out = [];
  for (const seg of String(path || "").split(".")) {
    if (!seg) continue;
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(seg);
    if (!m) return null;                       // not a shape we understand
    if (m[1]) out.push(m[1]);
    for (const idx of m[2].match(/\d+/g) || []) out.push(Number(idx));
  }
  return out.length ? out : null;
};

const setPath = (root, parts, value) => {
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const nextIsIndex = typeof parts[i + 1] === "number";
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = nextIsIndex ? [] : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
};

// Does the path address something that actually exists? A correction against a
// line the extract never produced cannot be applied by writing it — that would
// invent a line and score the model against a document it never saw. Such a
// correction is reported as skipped, not silently materialised.
const pathExists = (root, parts) => {
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== "object") return false;
    if (typeof parts[i] === "number" && !Array.isArray(cur)) return false;
    if (i === parts.length - 1) return true;   // the leaf may be absent/null
    cur = cur[parts[i]];
  }
  return true;
};

// Apply an operator's corrections back onto the extract that produced them.
// PURE. `corrections` are applied in the order given, so the caller should
// pass them oldest-first and the last edit of a field wins.
export const applyCorrections = (normalized, corrections) => {
  const base = normalized && typeof normalized === "object" ? JSON.parse(JSON.stringify(normalized)) : null;
  if (!base) return { normalized: null, applied: [], skipped: [], fields: [] };
  const applied = [];
  const skipped = [];
  for (const c of corrections || []) {
    const parts = parsePath(c && c.field_path);
    if (!parts) { skipped.push({ field_path: c && c.field_path, reason: "unparseable_path" }); continue; }
    if (!pathExists(base, parts)) { skipped.push({ field_path: c.field_path, reason: "path_not_in_extract" }); continue; }
    setPath(base, parts, c.corrected_value === undefined ? null : c.corrected_value);
    applied.push(c.field_path);
  }
  // Distinct field paths, last-write-wins already applied above.
  const fields = [...new Set(applied)];
  return { normalized: base, applied, skipped, fields };
};

// ── the harvest ──────────────────────────────────────────────────────

// Runs whose output is real enough to be ground truth once corrected. A failed
// run has nothing to correct; a dedupe replay is a copy of another run.
const HARVESTABLE_STATUS = new Set(["ok", "low_confidence"]);
const EXCLUDED_STATUS_REASONS = new Set(["empty_lines", "non_po", "dedupe_hit", "non_ack"]);

// A stable case id: the document's own identifier where the profile declares
// one, so re-correcting the same document REFRESHES its golden rather than
// accumulating a new case per edit session. Falls back to the run id.
export const caseIdFor = (scorable, profile, runId) => {
  const first = profile.header[0];
  const v = first ? scorable[first.key] : null;
  const s = v == null ? "" : String(v).trim();
  return s || String(runId);
};

// Snapshot one corrected extraction run into a golden eval_case.
// Returns { promoted, reason?, case_id?, suite?, corrected_fields? } and never
// throws — the caller records a correction first and must not lose it because
// a harvest failed.
export const promoteCorrectedRun = async (svc, { tenantId, extractionRunId, targetTenantId, nowIso } = {}) => {
  if (!tenantId || !extractionRunId) return { promoted: false, reason: "missing_args" };

  const runQ = await svc.from("extraction_runs")
    .select("id, tenant_id, extraction_kind, status, status_reason, normalized_extract, source_id, content_hash, customer_id, prompt_version")
    .eq("tenant_id", tenantId)
    .eq("id", extractionRunId)
    .maybeSingle();
  if (runQ.error) return { promoted: false, reason: runQ.error.message };
  const run = runQ.data;
  if (!run) return { promoted: false, reason: "run_not_found" };
  if (!HARVESTABLE_STATUS.has(run.status)) return { promoted: false, reason: "status_" + run.status };
  if (EXCLUDED_STATUS_REASONS.has(run.status_reason)) return { promoted: false, reason: run.status_reason };
  if (!run.normalized_extract) return { promoted: false, reason: "no_normalized_extract" };

  const profile = profileFor(run.extraction_kind);
  if (!profile) return { promoted: false, reason: "no_profile_for_kind:" + run.extraction_kind };

  // Without a source document the golden cannot be REPLAYED against the live
  // model — it could still be re-scored offline, but a fixture that can only
  // be half-used is a fixture that quietly stops meaning what it looks like.
  //
  // extraction_runs.source_id is set only when the CALLER passes a document id,
  // and until now the quote flow did not (QuotesStrip uploaded, got an id, and
  // dropped it). Rather than write off every run recorded before that fix, fall
  // back to the content hash: extraction_runs.content_hash and documents.sha256
  // are the same SHA-256 hex of the same bytes, and both columns are indexed.
  let documentId = run.source_id || null;
  if (!documentId && run.content_hash) {
    const d = await svc.from("documents")
      .select("id")
      .eq("tenant_id", run.tenant_id)
      .eq("sha256", run.content_hash)
      .limit(1);
    if (!d.error && Array.isArray(d.data) && d.data.length) documentId = d.data[0].id;
  }
  if (!documentId) return { promoted: false, reason: "no_source_document" };

  const corrQ = await svc.from("extraction_corrections")
    .select("field_path, corrected_value, applied_at")
    .eq("tenant_id", tenantId)
    .eq("extraction_run_id", extractionRunId)
    .order("applied_at", { ascending: true })
    .limit(2000);
  if (corrQ.error) return { promoted: false, reason: corrQ.error.message };
  const corrections = Array.isArray(corrQ.data) ? corrQ.data : [];
  if (!corrections.length) return { promoted: false, reason: "no_corrections" };

  const { normalized: truth, fields, skipped } = applyCorrections(run.normalized_extract, corrections);
  if (!truth) return { promoted: false, reason: "no_normalized_extract" };

  const expected = toScorableFor(truth, profile);
  if (!Array.isArray(expected.lineItems) || !expected.lineItems.length) {
    return { promoted: false, reason: "no_lines" };
  }

  const stamp = nowIso || new Date().toISOString();
  // Provenance rides inside `expected` under a key the scorer ignores, so no
  // migration is needed — the same channel promote.js uses.
  expected._provenance = {
    extraction_kind: profile.kind,
    harvest: "corrected_run",
    extraction_run_id: run.id,
    source_tenant_id: run.tenant_id,
    customer_id: run.customer_id || null,
    prompt_version: run.prompt_version || null,
    // Which fields a human EXPLICITLY fixed, as opposed to looked at and let
    // stand. Both are scored — but when this golden later fails, the reader
    // needs to know which half of it was actually verified.
    corrected_fields: fields,
    corrections_not_applied: skipped,
    promoted_at: stamp,
  };

  const caseId = caseIdFor(expected, profile, run.id);
  const row = {
    tenant_id: targetTenantId || run.tenant_id,
    suite: profile.suite,
    case_id: caseId,
    description: profile.label + " " + caseId + " — corrected by an operator (" + fields.length + " field" + (fields.length === 1 ? "" : "s") + ")",
    documents: [{ documentId, role: profile.docRole, sha256: run.content_hash || null }],
    expected,
    enabled: true,
  };

  const up = await svc.from("eval_cases")
    .upsert(row, { onConflict: "tenant_id,suite,case_id" })
    .select("id")
    .single();
  if (up.error) return { promoted: false, reason: up.error.message };
  return {
    promoted: true,
    case_id: caseId,
    suite: profile.suite,
    kind: profile.kind,
    corrected_fields: fields,
    eval_case_id: up.data.id,
  };
};
