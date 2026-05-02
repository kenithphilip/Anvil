/* Golden-test runner.
 * Posts a body of the shape:
 * {
 *   suite: "po-extraction",
 *   cases: [
 *     {
 *       id: "hyundai-2024-01",
 *       documents: [{ documentId, role }],
 *       expected: {
 *         poNumber: "...",
 *         poDate: "2024-01-12",
 *         lineItems: [{ partNo: "...", qty: 100, rate: 425 }],
 *         grandTotal: 248500
 *       }
 *     }
 *   ]
 * }
 *
 * For each case, runs the existing extraction pipeline (via /api/claude/messages with model
 * routing) and scores the output against `expected`. Scores stored as `eval_runs` and
 * `eval_case_results`. Caller submits actual extraction results (since this server is generic)
 * and we just score + record. Keeping the heavy lifting in the caller lets us run the same
 * suite from the browser POC, the backend, or a future CI job.
 */

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const eq = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const nearlyEq = (a, b, tol) => {
  const av = Number(a) || 0;
  const bv = Number(b) || 0;
  if (!av && !bv) return true;
  return Math.abs(av - bv) <= Math.max(0.01, Math.abs(bv) * (tol || 0.005));
};

const scoreCase = (expected, actual) => {
  const checks = [];
  let pass = 0;
  let fail = 0;
  const expect = (name, ok) => {
    checks.push({ name, ok });
    if (ok) pass++; else fail++;
  };
  if (expected.poNumber !== undefined) expect("poNumber", eq(expected.poNumber, actual && actual.poNumber));
  if (expected.poDate !== undefined) expect("poDate", eq(expected.poDate, actual && actual.poDate));
  if (expected.customer !== undefined) expect("customer", eq(expected.customer, actual && actual.customer));
  if (expected.grandTotal !== undefined) expect("grandTotal", nearlyEq(expected.grandTotal, actual && actual.grandTotal));
  if (expected.lineItems) {
    const expLines = expected.lineItems || [];
    const actLines = (actual && actual.lineItems) || [];
    expect("lineItemCount", expLines.length === actLines.length);
    expLines.forEach((expLine, idx) => {
      const candidate = actLines.find((l) => eq(l.partNo || l.sellerPartNo, expLine.partNo) || eq(l.itemName || l.tallyItemName, expLine.itemName || expLine.partNo));
      expect("line[" + idx + "].partNo", !!candidate);
      if (candidate) {
        if (expLine.qty !== undefined) expect("line[" + idx + "].qty", nearlyEq(expLine.qty, candidate.qty));
        if (expLine.rate !== undefined) expect("line[" + idx + "].rate", nearlyEq(expLine.rate, candidate.rate));
        if (expLine.hsn !== undefined) expect("line[" + idx + "].hsn", eq(expLine.hsn, candidate.hsnCode || candidate.hsn));
      }
    });
  }
  return { pass, fail, total: pass + fail, score: pass + fail === 0 ? 0 : pass / (pass + fail), checks };
};

const ensureEvalTables = async (svc) => {
  const sql = `
    create table if not exists eval_runs (
      id uuid primary key default uuid_generate_v4(),
      tenant_id uuid not null,
      suite text not null,
      passed int not null default 0,
      failed int not null default 0,
      total_score numeric(5, 4),
      created_at timestamptz not null default now()
    );
    create table if not exists eval_case_results (
      id uuid primary key default uuid_generate_v4(),
      tenant_id uuid not null,
      run_id uuid not null references eval_runs(id) on delete cascade,
      case_id text not null,
      passed int not null default 0,
      failed int not null default 0,
      score numeric(5, 4),
      checks jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now()
    );
  `;
  try { await svc.rpc("exec_sql", { sql }); } catch (_) { /* exec_sql may not exist; tables may already be present */ }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    const suite = body.suite || "default";
    const cases = Array.isArray(body.cases) ? body.cases : [];
    if (!cases.length) return json(res, 400, { error: { message: "cases array required" } });

    const svc = serviceClient();
    await ensureEvalTables(svc);

    let totalPass = 0;
    let totalFail = 0;
    const caseResults = [];
    for (const caseInput of cases) {
      const scored = scoreCase(caseInput.expected || {}, caseInput.actual || {});
      totalPass += scored.pass;
      totalFail += scored.fail;
      caseResults.push({ case_id: caseInput.id || ("case_" + caseResults.length), ...scored });
    }
    const score = totalPass + totalFail === 0 ? 0 : totalPass / (totalPass + totalFail);

    let runId = null;
    const persistErrors = [];
    try {
      const run = await svc.from("eval_runs").insert({
        tenant_id: ctx.tenantId,
        suite,
        passed: totalPass,
        failed: totalFail,
        total_score: score,
      }).select("id").single();
      if (run.error) persistErrors.push({ stage: "eval_runs_insert", message: run.error.message });
      else {
        runId = run.data.id;
        const rows = caseResults.map((cr) => ({
          tenant_id: ctx.tenantId,
          run_id: runId,
          case_id: cr.case_id,
          passed: cr.pass,
          failed: cr.fail,
          score: cr.score,
          checks: cr.checks,
        }));
        if (rows.length) {
          const ins = await svc.from("eval_case_results").insert(rows);
          if (ins.error) persistErrors.push({ stage: "eval_case_results_insert", message: ins.error.message });
        }
      }
    } catch (e) {
      persistErrors.push({ stage: "eval_persist_exception", message: e.message });
    }

    await recordAudit(ctx, {
      action: "eval_run",
      objectType: "eval_suite",
      objectId: suite,
      detail: "pass=" + totalPass + " fail=" + totalFail + " score=" + score.toFixed(3),
    });

    return json(res, 200, { suite, runId, totals: { pass: totalPass, fail: totalFail, score }, cases: caseResults, persistErrors });
  } catch (err) {
    sendError(res, err);
  }
}
