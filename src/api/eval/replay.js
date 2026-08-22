/* CM P4: live-model REPLAY — the last gap the offline re-score can't cover.
 *
 * rescore.js re-scores each golden's FROZEN normalized_extract, so it catches
 * regressions in the deterministic layers but NOT in the model / prompt. Replay
 * fetches the golden's ORIGINAL source PDF and RE-RUNS the live extraction model
 * on it, scoring the fresh output against the human-verified `expected`. That is
 * what catches a model swap or a prompt change that quietly degrades accuracy.
 *
 * Design (see the exploration notes):
 *  - Drives chunkedExtract, NOT runExtractionPipeline: the latter unconditionally
 *    writes a production extraction_runs row + review-queue/template/event side
 *    effects. chunkedExtract writes nothing; stripping tenant_id from settings
 *    suppresses even the per-day usage counter, so replay is ZERO-DB-WRITE.
 *  - Bytes are fetched from the SOURCE tenant's storage; the model runs with the
 *    source tenant's provider order + key (faithful) but tenant_id stripped.
 *  - Cost-bounded per case via createRunCostAccumulator; maxCases caps the batch.
 *  - Scores MODEL-OWNED fields only (header + part/qty/rate + line-recall);
 *    grandTotal (no totals in raw normalized) and item-master-backfilled hsn are
 *    dropped so deterministic enrichment can't cause a false model regression.
 *  - LLM output isn't fully deterministic even at temp 0, so the "regression"
 *    signal is a CORPUS-level line-recall floor, not per-case exact match.
 *  - Persisted via the same attestAndPersistRun as rescore, but tagged
 *    prompt_version/model_version so live-replay runs are distinct in the trend.
 *  - Triggered deliberately: operator POST (primary) + an OPTIONAL slow daily
 *    cron gated by EVAL_REPLAY_ENABLED. NEVER in CI (it burns real LLM calls).
 */

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { notifyAdmins } from "../_lib/notifications.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { EVAL_PIPELINE_VERSION_FALLBACK } from "../_lib/eval-attestation.js";
import { attestAndPersistRun } from "./run.js";
import { scoreCase } from "./score.js";
import { profileForExpected, toScorableFor, modelOwnedFor, profileFor, SCORABLE_KINDS, KIND_PROFILES } from "./kind-profiles.js";
import { chunkedExtract } from "../_lib/docai/chunked-extract.js";
import { tenantSettings } from "../_lib/stripe-client.js";
import { createRunCostAccumulator } from "../_lib/docai/run-cost.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const CRON_SECRET = process.env.CRON_SECRET;
const DEFAULT_LINE_RECALL_FLOOR = 0.95;

// Strip fields the MODEL does not own so live replay isn't tripped by
// deterministic enrichment. Which fields those are is per-kind now (the PO
// profile drops grandTotal — the raw adapter normalized has no totals — and
// per-line hsn, often item-master-backfilled into the golden). The gate then
// measures what the model actually produces.
export const modelOwnedExpected = (expected, profile) =>
  modelOwnedFor(expected, profile || profileFor("po"));

// Per-line recall. The identity check is named after the profile's identity
// field, so it is found by the `identity` flag the scorer stamps rather than
// by matching a PO-shaped check name.
const lineRecallFromChecks = (checks, expectedLineCount) => {
  if (!expectedLineCount) return null;
  const matched = checks.filter((c) => (c.identity || /^line\[\d+\]\.partNo$/.test(c.name)) && c.ok).length;
  return matched / expectedLineCount;
};

// Fetch a source document's raw bytes from storage (service-role, cross-tenant).
// Returns { bytes, mime, filename, sha256 } or null.
export const fetchDocBytes = async (svc, sourceTenantId, documentId) => {
  const d = await svc.from("documents")
    .select("storage_bucket, storage_path, mime_type, filename, sha256")
    .eq("tenant_id", sourceTenantId)
    .eq("id", documentId)
    .maybeSingle();
  if (d.error || !d.data) return null;
  const doc = d.data;
  const signed = await svc.storage.from(doc.storage_bucket).createSignedUrl(doc.storage_path, 300);
  if (signed.error || !signed.data || !signed.data.signedUrl) return null;
  const resp = await safeFetch(signed.data.signedUrl);
  if (!resp.ok) return null;
  const bytes = Buffer.from(await resp.arrayBuffer());
  // Do NOT fabricate a .pdf filename: guessSourceType reads the extension
  // first, so "po.pdf" would route a spreadsheet packing list to the PDF
  // parser. An absent filename is better than a wrong one — the mime and the
  // byte sniff still decide.
  return { bytes, mime: doc.mime_type || null, filename: doc.filename || null, sha256: doc.sha256 || null };
};

// Pure core: re-extract each golden's source with the LIVE model and score
// against expected. No req/res — callable from the handler and the cron.
export const replayGoldens = async (svc, { suite = "po-extraction", tenantId, maxCases = 10, lineRecallFloor = DEFAULT_LINE_RECALL_FLOOR } = {}) => {
  const cap = Math.min(200, Math.max(1, Number(maxCases) || 10));
  const casesQ = await svc.from("eval_cases")
    .select("case_id, expected, documents")
    .eq("tenant_id", tenantId)
    .eq("suite", suite)
    .eq("enabled", true)
    .limit(cap);
  if (casesQ.error) return { suite, tenant_id: tenantId, scored: 0, error: casesQ.error.message };
  const cases = Array.isArray(casesQ.data) ? casesQ.data : [];
  if (!cases.length) return { suite, tenant_id: tenantId, scored: 0, skipped: [], message: "no enabled golden cases for this suite/tenant" };

  let totalPass = 0;
  let totalFail = 0;
  const caseResults = [];
  const skipped = [];
  const modelsSeen = {};
  let recallSum = 0;
  let recallN = 0;
  const settingsCache = new Map();

  for (const gc of cases) {
    const expected = gc.expected || {};
    const prov = expected._provenance || {};
    // Which document kind this golden is. A case whose kind has no scoring
    // profile is SKIPPED, not scored against the purchase-order vocabulary:
    // a confident number computed with the wrong field set is worse than a
    // missing one.
    const profile = profileForExpected(expected);
    if (!profile) { skipped.push({ case_id: gc.case_id, reason: "unsupported_kind: " + (prov.extraction_kind || "?") }); continue; }
    const srcTenant = prov.source_tenant_id;
    const docs = Array.isArray(gc.documents) ? gc.documents : [];
    const doc = docs.find((d) => d && d.role === profile.docRole) || docs[0];
    const documentId = doc && doc.documentId;
    if (!srcTenant || !documentId) { skipped.push({ case_id: gc.case_id, reason: "no_source_document" }); continue; }

    let src = null;
    try { src = await fetchDocBytes(svc, srcTenant, documentId); }
    catch (e) { skipped.push({ case_id: gc.case_id, reason: "fetch_failed: " + (e && e.message || e) }); continue; }
    if (!src || !src.bytes || !src.bytes.length) { skipped.push({ case_id: gc.case_id, reason: "no_bytes" }); continue; }

    // Source-tenant settings (real provider order + key), tenant_id stripped so
    // the replay writes nothing and debits no customer's daily budget.
    let baseSettings = settingsCache.get(srcTenant);
    if (baseSettings === undefined) {
      try { baseSettings = await tenantSettings(svc, srcTenant); } catch (_) { baseSettings = {}; }
      settingsCache.set(srcTenant, baseSettings || {});
    }
    const settings = { ...(baseSettings || {}) };
    delete settings.tenant_id;

    const runCost = createRunCostAccumulator(settings.docai_per_extraction_cost_cap_usd);

    let out = null;
    try {
      out = await chunkedExtract({
        // sourceType is LEFT UNSET on purpose. dispatchExtract resolves it as
        // `source.sourceType || guessSourceType(source)`, so an explicit "pdf"
        // WON over the guess and sent every xlsx / docx / image golden to the
        // PDF chunker — and quotes and packing lists routinely arrive as
        // spreadsheets, which are exactly the kinds this PR adds. guessSourceType
        // falls back to "pdf" anyway, so a PO PDF is unaffected.
        source: { bytes: src.bytes, mime: src.mime, filename: src.filename },
        settings,
        customerId: prov.customer_id || null,
        // THE load-bearing line for non-PO goldens. hints.expectedKind is what
        // selects the extraction schema, and it defaults to "po" — so without
        // this a quote or packing-list golden was re-extracted with the
        // purchase-order schema and scored against a quote's expected output.
        hints: { expectedKind: profile.kind },
        runCost,
      });
    } catch (e) { skipped.push({ case_id: gc.case_id, reason: "extract_failed: " + (e && e.message || e) }); continue; }

    if (!out || !out.ok || !out.normalized) {
      skipped.push({ case_id: gc.case_id, reason: (out && out.reason) || "extract_not_ok", model: (out && out.selected_model) || null });
      continue;
    }

    const actual = toScorableFor(out.normalized, profile);
    const scoreExpected = modelOwnedFor(expected, profile);
    const scored = scoreCase(scoreExpected, actual, profile);
    totalPass += scored.pass;
    totalFail += scored.fail;
    const expectedLineCount = Array.isArray(scoreExpected.lineItems) ? scoreExpected.lineItems.length : 0;
    const lineRecall = lineRecallFromChecks(scored.checks, expectedLineCount);
    if (lineRecall != null) { recallSum += lineRecall; recallN++; }
    const model = out.selected_model || "unknown";
    modelsSeen[model] = (modelsSeen[model] || 0) + 1;
    caseResults.push({
      case_id: gc.case_id,
      kind: profile.kind,
      ...scored,
      actual_line_count: Array.isArray(actual.lineItems) ? actual.lineItems.length : 0,
      expected_line_count: expectedLineCount,
      line_recall: lineRecall,
      model,
      model_selection_reason: out.model_selection_reason || null,
      cost_usd: runCost && typeof runCost.totalUsd === "number" ? runCost.totalUsd : null,
    });
  }

  if (!caseResults.length) return { suite, tenant_id: tenantId, scored: 0, skipped, message: "no golden case could be replayed" };

  const dominant = Object.entries(modelsSeen).sort((a, b) => b[1] - a[1])[0];
  const modelVersion = Object.keys(modelsSeen).length > 1
    ? "live-replay:mixed:" + (dominant ? dominant[0] : "?")
    : "live-replay:" + (dominant ? dominant[0] : "?");

  const { runId, score, persistErrors, attestation } = await attestAndPersistRun(svc, {
    tenantId,
    suite,
    totalPass,
    totalFail,
    caseResults,
    promptVersion: "live-replay",
    modelVersion,
    pipelineVersion: EVAL_PIPELINE_VERSION_FALLBACK,
    serverVerified: true,
  });

  const lineRecallAvg = recallN ? recallSum / recallN : null;
  const regression = lineRecallAvg != null && lineRecallAvg < lineRecallFloor;

  // TELL SOMEBODY.
  //
  // This function has always computed `regression` and returned it to a cron
  // loop that reads only `r.ok` — so a replay that ran perfectly and found
  // accuracy had FALLEN was indistinguishable from one that found nothing
  // wrong. A quality signal nobody is told about is not a quality signal.
  //
  // Raised here rather than in cron/daily.js because that file is a mux with
  // no service client and no tenant; this one has both.
  if (regression) {
    try {
      await notifyAdmins(svc, tenantId, {
        kind: "eval_replay_regression",
        title: "Extraction accuracy fell on the golden corpus",
        body: `Live replay line-recall ${lineRecallAvg.toFixed(3)} is below the floor ${lineRecallFloor} across ${caseResults.length} case(s).`,
      }, {
        // One alert per day per corpus, not one per replay run.
        dedupKey: "eval_replay_regression:" + suite,
      });
    } catch (e) {
      // Never let the alert fail the replay — but say so, because a swallowed
      // alert is exactly the failure this block exists to prevent.
      console.warn("[eval/replay] regression alert failed:", e?.message || e);
    }
  }

  return {
    suite,
    tenant_id: tenantId,
    runId,
    scored: caseResults.length,
    totals: { pass: totalPass, fail: totalFail, score },
    line_recall_avg: lineRecallAvg,
    line_recall_floor: lineRecallFloor,
    regression,
    models: modelsSeen,
    total_cost_usd: caseResults.reduce((s, c) => s + (c.cost_usd || 0), 0),
    cases: caseResults,
    skipped,
    persistErrors,
    attestation,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST" && req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    // Cron path: gated (EVAL_REPLAY_ENABLED) + capped, re-runs the shared corpus.
    if (isCron) {
      if (!process.env.EVAL_REPLAY_ENABLED) return json(res, 200, { via: "cron", skipped: "disabled", message: "EVAL_REPLAY_ENABLED not set" });
      const tenantId = process.env.EVAL_GOLDEN_TENANT_ID;
      if (!tenantId) return json(res, 200, { via: "cron", skipped: "no_corpus_tenant", message: "EVAL_GOLDEN_TENANT_ID not set" });
      const maxCases = Number(process.env.EVAL_REPLAY_MAX_CASES) || 5;
      // Every kind's suite. Replay burns real LLM calls, so EVAL_REPLAY_MAX_CASES
      // stays a TOTAL budget shared across suites rather than a per-suite one —
      // adding a document kind must not silently multiply the nightly bill.
      const suites = [...new Set(SCORABLE_KINDS.map((k) => KIND_PROFILES[k].suite))];
      const reports = [];
      let budget = maxCases;
      for (const s of suites) {
        if (budget <= 0) { reports.push({ suite: s, scored: 0, skipped: [{ reason: "replay_budget_exhausted" }] }); continue; }
        const r = await replayGoldens(svc, { suite: s, tenantId, maxCases: budget });
        if (r && (r.scored > 0 || r.error)) reports.push(r);
        budget -= (r && r.scored) || 0;
      }
      return json(res, 200, {
        via: "cron",
        suites: suites.length,
        max_cases: maxCases,
        scored: reports.reduce((a, r) => a + (r.scored || 0), 0),
        reports,
      });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const suite = body.suite || "po-extraction";
    const tenantId = body.tenant_id || process.env.EVAL_GOLDEN_TENANT_ID || ctx.tenantId;
    const report = await replayGoldens(svc, { suite, tenantId, maxCases: body.maxCases });

    if (report.scored > 0) {
      await recordAudit(ctx, {
        action: "eval_replay",
        objectType: "eval_suite",
        objectId: suite,
        detail: "scored=" + report.scored + " recall=" + (report.line_recall_avg != null ? report.line_recall_avg.toFixed(3) : "n/a") + " cost=$" + (report.total_cost_usd || 0).toFixed(3),
      });
    }
    return json(res, 200, report);
  } catch (err) {
    sendError(res, err);
  }
}
