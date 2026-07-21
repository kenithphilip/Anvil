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
 * POST body: { suite?, tenant_id?, limit? }
 *   suite      default "po-extraction"
 *   tenant_id  the golden corpus tenant; default EVAL_GOLDEN_TENANT_ID or caller
 *   limit      max cases to score (default 500)
 */

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { EVAL_PIPELINE_VERSION_FALLBACK } from "../_lib/eval-attestation.js";
import { scoreCase, attestAndPersistRun } from "./run.js";
import { normalizedToScorable } from "./eval-normalize.js";

// Line recall for one scored case: how many expected lines were matched.
const lineRecallFromChecks = (checks, expectedLineCount) => {
  if (!expectedLineCount) return null;
  const matched = checks.filter((c) => /^line\[\d+\]\.partNo$/.test(c.name) && c.ok).length;
  return matched / expectedLineCount;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const suite = body.suite || "po-extraction";
    const targetTenantId = body.tenant_id || process.env.EVAL_GOLDEN_TENANT_ID || ctx.tenantId;
    const limit = Math.min(2000, Math.max(1, Number(body.limit) || 500));

    const svc = serviceClient();

    const casesQ = await svc.from("eval_cases")
      .select("case_id, expected, documents")
      .eq("tenant_id", targetTenantId)
      .eq("suite", suite)
      .eq("enabled", true)
      .limit(limit);
    if (casesQ.error) return json(res, 500, { error: { message: casesQ.error.message } });
    const cases = Array.isArray(casesQ.data) ? casesQ.data : [];
    if (!cases.length) {
      return json(res, 200, { suite, tenant_id: targetTenantId, scored: 0, skipped: [], message: "no enabled golden cases for this suite/tenant" });
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
      const srcTenant = prov.source_tenant_id || targetTenantId;

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
      return json(res, 200, { suite, tenant_id: targetTenantId, scored: 0, skipped, message: "no golden case had a re-scorable stored extract" });
    }

    const { runId, score, persistErrors, attestation } = await attestAndPersistRun(svc, {
      tenantId: targetTenantId,
      suite,
      totalPass,
      totalFail,
      caseResults,
      promptVersion: String(body.prompt_version || "offline-rescore"),
      modelVersion: "offline-rescore",
      pipelineVersion: String(body.pipeline_version || EVAL_PIPELINE_VERSION_FALLBACK),
      serverVerified: true,
    });

    await recordAudit(ctx, {
      action: "eval_rescore",
      objectType: "eval_suite",
      objectId: suite,
      detail: "scored=" + caseResults.length + " skipped=" + skipped.length + " score=" + score.toFixed(3),
    });

    return json(res, 200, {
      suite,
      tenant_id: targetTenantId,
      runId,
      scored: caseResults.length,
      totals: { pass: totalPass, fail: totalFail, score },
      line_recall_avg: recallN ? recallSum / recallN : null,
      cases: caseResults,
      skipped,
      persistErrors,
      attestation,
    });
  } catch (err) {
    sendError(res, err);
  }
}
