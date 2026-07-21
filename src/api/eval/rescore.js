/* CM P4: offline golden re-scorer.
 *
 * The plain /api/eval/run scores caller-submitted `actual` JSON — it can be
 * gamed and never touches the pipeline. This endpoint closes the loop WITHOUT
 * burning LLM calls: for every golden eval_case (harvested from an approved
 * order by eval/promote.js), it fetches the case's stored extraction_runs.
 * normalized_extract — the exact output the pipeline produced — renames it into
 * the scorer vocabulary, and scores it against the human-verified `expected`.
 * The result is the corpus's accuracy vs ground truth (the escape/error rate),
 * persisted as an attested eval_run with server_verified=true.
 *
 * Deterministic + free: re-scores frozen normalized output, so it measures how
 * far raw extraction sat from the corrected truth and gives a stable baseline
 * to trend. (Re-exercising the model on the source bytes is a later phase.)
 *
 * Runnable two ways:
 *   - POST /api/eval/rescore { suite?, tenant_id?, limit? } (operator/UI), OR
 *   - the hourly cron (Bearer CRON_SECRET) which re-scores the shared corpus
 *     (EVAL_GOLDEN_TENANT_ID) so accuracy vs ground truth trends automatically.
 */

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { EVAL_PIPELINE_VERSION_FALLBACK } from "../_lib/eval-attestation.js";
import { attestAndPersistRun } from "./run.js";
import { scoreCase } from "./score.js";
import { normalizedToScorable } from "./eval-normalize.js";

const CRON_SECRET = process.env.CRON_SECRET;

// Line recall for one scored case: how many expected lines were matched.
const lineRecallFromChecks = (checks, expectedLineCount) => {
  if (!expectedLineCount) return null;
  const matched = checks.filter((c) => /^line\[\d+\]\.partNo$/.test(c.name) && c.ok).length;
  return matched / expectedLineCount;
};

// Core: re-score every enabled golden case in (tenantId, suite) against its
// stored normalized_extract, persist an attested eval_run, return the report.
// No req/res/auth — callable from the handler AND the cron.
export const rescoreGoldens = async (svc, { suite = "po-extraction", tenantId, limit = 500 } = {}) => {
  const cap = Math.min(2000, Math.max(1, Number(limit) || 500));
  const casesQ = await svc.from("eval_cases")
    .select("case_id, expected, documents")
    .eq("tenant_id", tenantId)
    .eq("suite", suite)
    .eq("enabled", true)
    .limit(cap);
  if (casesQ.error) return { suite, tenant_id: tenantId, scored: 0, error: casesQ.error.message };
  const cases = Array.isArray(casesQ.data) ? casesQ.data : [];
  if (!cases.length) {
    return { suite, tenant_id: tenantId, scored: 0, skipped: [], message: "no enabled golden cases for this suite/tenant" };
  }

  let totalPass = 0;
  let totalFail = 0;
  const caseResults = [];
  const skipped = [];
  let recallSum = 0;
  let recallN = 0;

  for (const gc of cases) {
    const expected = gc.expected || {};
    const prov = expected._provenance || {};
    const runId = prov.extraction_run_id || null;
    if (!runId) { skipped.push({ case_id: gc.case_id, reason: "no_extraction_run" }); continue; }
    const srcTenant = prov.source_tenant_id || tenantId;

    const runQ = await svc.from("extraction_runs")
      .select("normalized_extract")
      .eq("tenant_id", srcTenant)
      .eq("id", runId)
      .maybeSingle();
    if (runQ.error || !runQ.data || !runQ.data.normalized_extract) {
      skipped.push({ case_id: gc.case_id, reason: "no_normalized_extract" });
      continue;
    }

    const actual = normalizedToScorable(runQ.data.normalized_extract);
    const scored = scoreCase(expected, actual);
    totalPass += scored.pass;
    totalFail += scored.fail;
    const expectedLineCount = Array.isArray(expected.lineItems) ? expected.lineItems.length : 0;
    const lineRecall = lineRecallFromChecks(scored.checks, expectedLineCount);
    if (lineRecall != null) { recallSum += lineRecall; recallN++; }
    caseResults.push({
      case_id: gc.case_id,
      ...scored,
      actual_line_count: Array.isArray(actual.lineItems) ? actual.lineItems.length : 0,
      expected_line_count: expectedLineCount,
      line_recall: lineRecall,
    });
  }

  if (!caseResults.length) {
    return { suite, tenant_id: tenantId, scored: 0, skipped, message: "no golden case had a re-scorable stored extract" };
  }

  const { runId, score, persistErrors, attestation } = await attestAndPersistRun(svc, {
    tenantId,
    suite,
    totalPass,
    totalFail,
    caseResults,
    promptVersion: "offline-rescore",
    modelVersion: "offline-rescore",
    pipelineVersion: EVAL_PIPELINE_VERSION_FALLBACK,
    serverVerified: true,
  });

  return {
    suite,
    tenant_id: tenantId,
    runId,
    scored: caseResults.length,
    totals: { pass: totalPass, fail: totalFail, score },
    line_recall_avg: recallN ? recallSum / recallN : null,
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

    // Cron path: re-score the shared corpus automatically (no user context).
    if (isCron) {
      const tenantId = process.env.EVAL_GOLDEN_TENANT_ID;
      if (!tenantId) return json(res, 200, { via: "cron", skipped: "no_corpus_tenant", message: "EVAL_GOLDEN_TENANT_ID not set" });
      const report = await rescoreGoldens(svc, { suite: "po-extraction", tenantId });
      return json(res, 200, { ...report, via: "cron" });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const suite = body.suite || "po-extraction";
    const targetTenantId = body.tenant_id || process.env.EVAL_GOLDEN_TENANT_ID || ctx.tenantId;
    const report = await rescoreGoldens(svc, { suite, tenantId: targetTenantId, limit: body.limit });

    if (report.scored > 0) {
      await recordAudit(ctx, {
        action: "eval_rescore",
        objectType: "eval_suite",
        objectId: suite,
        detail: "scored=" + report.scored + " score=" + (report.totals?.score ?? 0).toFixed(3),
      });
    }
    return json(res, 200, report);
  } catch (err) {
    sendError(res, err);
  }
}
