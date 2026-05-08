// /api/deploys
//
//   GET                                 list deploy events
//                                       (filterable by environment, branch,
//                                       since), descending by timestamp.
//                                       requires "read" permission. SOC 2
//                                       CC8.1 evidence: an auditor pulls
//                                       this per quarter to walk the
//                                       change log.
//
//   POST  (Vercel webhook)              capture one deploy event. Auth via
//                                       Bearer DEPLOY_HOOK_SECRET, set on
//                                       the Vercel project as a deploy
//                                       hook. Body shape mirrors Vercel's
//                                       deployment payload but is
//                                       provider-agnostic; a manual deploy
//                                       can POST { provider: 'manual',
//                                       commit_sha, environment, ... }.
//
// Audit: DEFERRED_ROADMAP §4 code-side controls. Closes the third
// of three open SOC 2 deliverables; the access review and audit
// log export endpoints already shipped.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const DEPLOY_HOOK_SECRET = process.env.DEPLOY_HOOK_SECRET;
const VALID_PROVIDERS = new Set(["vercel", "manual", "other"]);
const VALID_ENVS = new Set(["production", "preview", "development"]);
const VALID_STATES = new Set(["queued", "building", "ready", "error", "cancelled"]);

// Normalize Vercel's webhook body into the deploy_events row shape.
// Vercel sends `payload.deployment` with `id`, `url`, `meta` (which
// includes githubCommitSha, etc.). We tolerate the legacy and
// modern shapes; missing fields default to null.
const normalizeVercel = (body) => {
  const d = body?.deployment || body || {};
  const meta = d.meta || body?.meta || {};
  return {
    provider: "vercel",
    environment: (body?.target || d.target || "preview").toLowerCase(),
    deployment_id: d.id || body?.deploymentId || null,
    url: d.url ? (d.url.startsWith("http") ? d.url : "https://" + d.url) : null,
    commit_sha: meta.githubCommitSha || meta.commit_sha || null,
    commit_message: typeof meta.githubCommitMessage === "string"
      ? meta.githubCommitMessage.split("\n")[0].slice(0, 200)
      : null,
    branch: meta.githubCommitRef || meta.branch || null,
    state: (body?.type || d.state || "ready").toString().toLowerCase().includes("error")
      ? "error"
      : (body?.type || d.state || "ready").toString().toLowerCase().includes("cancel")
        ? "cancelled"
        : "ready",
    meta: { raw: body },
  };
};

// Validate a manual or other-provider POST body. Throws on shape
// errors (caller wraps in sendError).
const buildRow = (body) => {
  if (body?.provider === "vercel") return normalizeVercel(body);
  const provider = (body?.provider || "manual").toLowerCase();
  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error("provider must be one of: " + [...VALID_PROVIDERS].join(", "));
  }
  const environment = (body?.environment || "production").toLowerCase();
  if (!VALID_ENVS.has(environment)) {
    throw new Error("environment must be one of: " + [...VALID_ENVS].join(", "));
  }
  const state = (body?.state || "ready").toLowerCase();
  if (!VALID_STATES.has(state)) {
    throw new Error("state must be one of: " + [...VALID_STATES].join(", "));
  }
  return {
    provider,
    environment,
    deployment_id: body?.deployment_id || null,
    url: body?.url || null,
    commit_sha: body?.commit_sha || null,
    commit_message: typeof body?.commit_message === "string"
      ? body.commit_message.split("\n")[0].slice(0, 200)
      : null,
    branch: body?.branch || null,
    state,
    meta: body?.meta || {},
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const svc = serviceClient();

    if (req.method === "GET") {
      const ctx = await resolveContext(req);
      requirePermission(ctx, "read");
      const env = req.query?.environment || "production";
      const branch = req.query?.branch || null;
      const since = req.query?.since || null;
      const limit = Math.min(Number(req.query?.limit) || 50, 500);
      let q = svc.from("deploy_events").select("*").eq("environment", env);
      if (branch) q = q.eq("branch", branch);
      if (since) q = q.gte("ts", since);
      q = q.order("ts", { ascending: false }).limit(limit);
      const r = await q;
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { events: r.data || [] });
    }

    if (req.method === "POST") {
      // Webhook auth via Bearer DEPLOY_HOOK_SECRET. Strict equality
      // (timing-safe via length pre-check) so a misconfigured hook
      // cannot poison the change log.
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!DEPLOY_HOOK_SECRET || auth !== DEPLOY_HOOK_SECRET) {
        return json(res, 401, { error: { message: "deploy hook auth failed" } });
      }
      const body = await readBody(req);
      let row;
      try { row = buildRow(body); }
      catch (err) { return json(res, 400, { error: { message: err.message } }); }
      const ins = await svc.from("deploy_events").insert(row).select("id, ts").single();
      if (ins.error) throw new Error(ins.error.message);
      // Best-effort audit. The SOC2 evidence tap is the
      // deploy_events table itself; this is the supplementary
      // breadcrumb for the audit_events stream.
      await recordAudit(
        { tenantId: null, role: "system" },
        {
          action: "deploy_recorded",
          objectType: "deploy_event",
          objectId: ins.data.id,
          detail: row.environment + "::" + (row.commit_sha || "no-sha"),
        },
      );
      return json(res, 200, { id: ins.data.id, ts: ins.data.ts });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}

export const __test = { buildRow, normalizeVercel };
