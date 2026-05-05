// /api/eval/agent_eval
//
//   GET   list recent agent_eval runs with their drift scores.
//   POST  body: { since? }. Replays historical agent runs against
//         current ground-truth (rlhf_feedback) and scores the
//         current model output. Designed to be invoked weekly by
//         cron.
//
// Phase 6 (C.3) — agent regression harness. Reuses existing `agent_runs`
// (autonomous agent v1) + `rlhf_feedback` tables; we don't add new
// ingestion paths. The harness writes one `agent_eval_runs` row per
// invocation.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const CRON_SECRET = process.env.CRON_SECRET;

// Compute drift between two outputs. Both are JSON objects produced
// by the agent runner. We score on three axes:
//   - decision parity: did the agent pick the same action?
//   - confidence delta: |conf_old - conf_new|
//   - rationale similarity: char-trigram Jaccard, cheap proxy
const charTrigrams = (s) => {
  const out = new Set();
  const t = String(s || "").toLowerCase();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
};
const jaccard = (a, b) => {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
};
const scoreDrift = (expected, actual) => {
  const expAction = expected?.action || expected?.decision || null;
  const actAction = actual?.action || actual?.decision || null;
  const decisionParity = expAction && actAction
    ? (expAction === actAction ? 1 : 0)
    : 0.5;
  const expConf = Number(expected?.confidence ?? 0);
  const actConf = Number(actual?.confidence ?? 0);
  const confDelta = Math.abs(expConf - actConf);
  const tA = charTrigrams(expected?.rationale || expected?.thought || "");
  const tB = charTrigrams(actual?.rationale || actual?.thought || "");
  const rationaleSim = jaccard(tA, tB);
  // Composite score: decision parity weighted highest, then
  // rationale similarity, then inverse confidence delta.
  const score = decisionParity * 0.6 + rationaleSim * 0.3 + (1 - Math.min(confDelta, 1)) * 0.1;
  return { decisionParity, confDelta, rationaleSim, score };
};

const runEval = async (svc, tenantId, opts = {}) => {
  const since = opts.since || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  // Pull a held-out slice of agent runs that already have operator
  // feedback. Reusing rlhf_feedback as the ground-truth source.
  const fbQ = await svc.from("rlhf_feedback").select("*")
    .eq("tenant_id", tenantId)
    .gte("created_at", since)
    .limit(200);
  if (fbQ.error) throw new Error("rlhf_feedback read: " + fbQ.error.message);

  const cases = fbQ.data || [];
  const results = [];
  for (const fb of cases) {
    // Pull the run referenced by the feedback. Different feedback
    // shapes carry the run id under different keys, so we accept a
    // few aliases.
    const runId = fb.run_id || fb.agent_run_id || fb.target_id || fb.object_id;
    if (!runId) continue;
    const runQ = await svc.from("agent_runs").select("id, output, model")
      .eq("id", runId).maybeSingle();
    if (!runQ.data) continue;
    const expected = fb.expected_output || fb.corrected_output || fb.label || {};
    const actual = runQ.data.output || {};
    const s = scoreDrift(expected, actual);
    results.push({ run_id: runId, model: runQ.data.model || "unknown", ...s });
  }

  // Aggregate metrics.
  const n = results.length;
  const avg = (key) => n ? results.reduce((a, r) => a + (Number(r[key]) || 0), 0) / n : 0;
  const summary = {
    cases: n,
    avg_score: avg("score"),
    avg_decision_parity: avg("decisionParity"),
    avg_rationale_sim: avg("rationaleSim"),
    avg_conf_delta: avg("confDelta"),
    by_model: {},
  };
  for (const r of results) {
    const m = r.model || "unknown";
    if (!summary.by_model[m]) summary.by_model[m] = { count: 0, score_sum: 0 };
    summary.by_model[m].count += 1;
    summary.by_model[m].score_sum += r.score;
  }
  for (const m of Object.keys(summary.by_model)) {
    const slot = summary.by_model[m];
    slot.avg_score = slot.count ? slot.score_sum / slot.count : 0;
  }

  await svc.from("agent_eval_runs").insert({
    tenant_id: tenantId,
    ran_at: new Date().toISOString(),
    cases_evaluated: n,
    avg_score: summary.avg_score,
    summary,
    sample: results.slice(0, 50),
  });

  return summary;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();

    if (isCron) {
      // Run for every tenant that has at least one agent run in the
      // window. Cheap: one query per tenant.
      const tenants = await svc.from("agent_runs").select("tenant_id")
        .gte("created_at", new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
      const uniq = Array.from(new Set((tenants.data || []).map((r) => r.tenant_id))).filter(Boolean);
      const out = [];
      for (const tid of uniq) {
        try {
          out.push({ tenant_id: tid, ...await runEval(svc, tid) });
        } catch (err) {
          out.push({ tenant_id: tid, error: err.message });
        }
      }
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }

    const ctx = await resolveContext(req);
    requirePermission(ctx, "admin");

    if (req.method === "GET") {
      const r = await svc.from("agent_eval_runs")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("ran_at", { ascending: false })
        .limit(50);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { runs: r.data || [] });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const summary = await runEval(svc, ctx.tenantId, body || {});
      await recordAudit(ctx, {
        action: "agent_eval_run",
        objectType: "agent_eval",
        objectId: null,
        detail: "cases=" + summary.cases + "::avg_score=" + summary.avg_score.toFixed(3),
      });
      return json(res, 200, { ok: true, summary });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
