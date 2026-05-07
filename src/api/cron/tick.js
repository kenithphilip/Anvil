// GET /api/cron/tick
//
// Runs every 5 minutes (Hobby-tier-friendly consolidation). Fans
// out to every per-handler cron path that needs sub-hourly cadence:
//
//   ALWAYS (every 5 min tick):
//     - Push notification queue drain
//     - Inbound email parse
//     - All ERP retry queue drains (in parallel)
//
//   WHEN current minute % 30 === 0 (i.e. on the hour and half-hour):
//     - All ERP syncs (in parallel)
//
//   WHEN current minute === 0 (i.e. on the hour):
//     - Autonomous agent run
//
// Auth: Bearer CRON_SECRET (Vercel injects this for scheduled crons).
// One sub-handler failure does not block siblings (Promise.allSettled
// + per-handler try/catch).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { runCronGroup, shouldRunOnMinute, recordCronHeartbeat } from "../_lib/cron-mux.js";

import netsuiteSync     from "../netsuite/sync.js";
import netsuiteRetry    from "../netsuite/retry.js";
import tallySync        from "../tally/sync.js";
import tallyRetry       from "../tally/retry.js";
import sapSync          from "../sap/sync.js";
import sapRetry         from "../sap/retry.js";
import d365Sync         from "../d365/sync.js";
import d365Retry        from "../d365/retry.js";
import acuSync          from "../acumatica/sync.js";
import acuRetry         from "../acumatica/retry.js";
import p21Sync          from "../p21/sync.js";
import p21Retry         from "../p21/retry.js";
import eclipseSync      from "../eclipse/sync.js";
import eclipseRetry     from "../eclipse/retry.js";
import sxeSync          from "../sxe/sync.js";
import sxeRetry         from "../sxe/retry.js";
import sageX3Sync       from "../sage_x3/sync.js";
import sageX3Retry      from "../sage_x3/retry.js";
// Phase 5.4b cluster A (OAuth2): IFS, Oracle Fusion, Ramco.
import ifsSync          from "../ifs/sync.js";
import ifsRetry         from "../ifs/retry.js";
import oracleFusionSync from "../oracle_fusion/sync.js";
import oracleFusionRetry from "../oracle_fusion/retry.js";
import ramcoSync        from "../ramco/sync.js";
import ramcoRetry       from "../ramco/retry.js";
// Phase 5.4b cluster B (token-pair): JDE, Plex, JobBoss.
import jdeSync          from "../jde/sync.js";
import jdeRetry         from "../jde/retry.js";
import plexSync         from "../plex/sync.js";
import plexRetry        from "../plex/retry.js";
import jobbossSync      from "../jobboss/sync.js";
import jobbossRetry     from "../jobboss/retry.js";
// Phase 5.4b cluster C (HTTP Basic): Oracle EBS, proALPHA.
import oracleEbsSync    from "../oracle_ebs/sync.js";
import oracleEbsRetry   from "../oracle_ebs/retry.js";
import proalphaSync     from "../proalpha/sync.js";
import proalphaRetry    from "../proalpha/retry.js";
// Phase 6 cron entries: agent eval (weekly) + prospecting (every tick).
import agentEval        from "../eval/agent_eval.js";
import prospectingRun   from "../prospecting/run.js";
import plmSync          from "../plm/sync.js";
import pushSend         from "../push/send.js";
import inboundParse     from "../inbound/email/parse.js";
import agentsRun        from "../agents/run.js";

const CRON_SECRET = process.env.CRON_SECRET;

const RETRIES = [
  { name: "netsuite/retry",  fn: netsuiteRetry,  opts: { path: "/api/netsuite/retry"  } },
  { name: "tally/retry",     fn: tallyRetry,     opts: { path: "/api/tally/retry"     } },
  { name: "sap/retry",       fn: sapRetry,       opts: { path: "/api/sap/retry"       } },
  { name: "d365/retry",      fn: d365Retry,      opts: { path: "/api/d365/retry"      } },
  { name: "acumatica/retry", fn: acuRetry,       opts: { path: "/api/acumatica/retry" } },
  { name: "p21/retry",       fn: p21Retry,       opts: { path: "/api/p21/retry"       } },
  { name: "eclipse/retry",   fn: eclipseRetry,   opts: { path: "/api/eclipse/retry"   } },
  { name: "sxe/retry",       fn: sxeRetry,       opts: { path: "/api/sxe/retry"       } },
  { name: "sage_x3/retry",   fn: sageX3Retry,    opts: { path: "/api/sage_x3/retry"   } },
  { name: "ifs/retry",            fn: ifsRetry,           opts: { path: "/api/ifs/retry" } },
  { name: "oracle_fusion/retry",  fn: oracleFusionRetry,  opts: { path: "/api/oracle_fusion/retry" } },
  { name: "ramco/retry",          fn: ramcoRetry,         opts: { path: "/api/ramco/retry" } },
  { name: "jde/retry",            fn: jdeRetry,           opts: { path: "/api/jde/retry" } },
  { name: "plex/retry",           fn: plexRetry,          opts: { path: "/api/plex/retry" } },
  { name: "jobboss/retry",        fn: jobbossRetry,       opts: { path: "/api/jobboss/retry" } },
  { name: "oracle_ebs/retry",     fn: oracleEbsRetry,     opts: { path: "/api/oracle_ebs/retry" } },
  { name: "proalpha/retry",       fn: proalphaRetry,      opts: { path: "/api/proalpha/retry" } },
];

const SYNCS = [
  { name: "netsuite/sync",  fn: netsuiteSync,  opts: { path: "/api/netsuite/sync"  } },
  { name: "tally/sync",     fn: tallySync,     opts: { path: "/api/tally/sync"     } },
  { name: "sap/sync",       fn: sapSync,       opts: { path: "/api/sap/sync"       } },
  { name: "d365/sync",      fn: d365Sync,      opts: { path: "/api/d365/sync"      } },
  { name: "acumatica/sync", fn: acuSync,       opts: { path: "/api/acumatica/sync" } },
  { name: "p21/sync",       fn: p21Sync,       opts: { path: "/api/p21/sync"       } },
  { name: "eclipse/sync",   fn: eclipseSync,   opts: { path: "/api/eclipse/sync"   } },
  { name: "sxe/sync",       fn: sxeSync,       opts: { path: "/api/sxe/sync"       } },
  { name: "sage_x3/sync",   fn: sageX3Sync,    opts: { path: "/api/sage_x3/sync"   } },
  { name: "ifs/sync",            fn: ifsSync,           opts: { path: "/api/ifs/sync" } },
  { name: "oracle_fusion/sync", fn: oracleFusionSync,  opts: { path: "/api/oracle_fusion/sync" } },
  { name: "ramco/sync",          fn: ramcoSync,         opts: { path: "/api/ramco/sync" } },
  { name: "jde/sync",            fn: jdeSync,           opts: { path: "/api/jde/sync" } },
  { name: "plex/sync",           fn: plexSync,          opts: { path: "/api/plex/sync" } },
  { name: "jobboss/sync",        fn: jobbossSync,       opts: { path: "/api/jobboss/sync" } },
  { name: "oracle_ebs/sync",     fn: oracleEbsSync,     opts: { path: "/api/oracle_ebs/sync" } },
  { name: "proalpha/sync",       fn: proalphaSync,      opts: { path: "/api/proalpha/sync" } },
  // Phase 5.5: PLM sync. Same 30m cadence as the ERPs since BOM /
  // ECO churn is similar in volume.
  { name: "plm/sync",       fn: plmSync,       opts: { path: "/api/plm/sync", method: "POST" } },
];

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!CRON_SECRET || auth !== CRON_SECRET) {
      return json(res, 401, { error: { message: "tick is cron-only" } });
    }
    const startedAt = new Date();
    const minute = startedAt.getUTCMinutes();
    const ranSyncs = shouldRunOnMinute(minute, 30);
    const ranAgents = shouldRunOnMinute(minute, 60);
    // Run the agent-eval harness once per hour at minute 5 (off the
    // hour-on-the-hour traffic spike). Phase 6 (C.3) — drift trend
    // chart in Diagnostics is fed from `agent_eval_runs`.
    const ranAgentEval = minute === 5;

    // ALWAYS: every-5-min items.
    const alwaysGroup = [
      { name: "push/send",            fn: pushSend,     opts: { path: "/api/push/send" } },
      // Prospecting dispatch runs every tick; the inner send-window
      // + daily-cap checks gate which campaigns actually fire (C.6).
      { name: "prospecting/run",      fn: prospectingRun, opts: { path: "/api/prospecting/run", method: "POST" } },
      { name: "inbound/email/parse",  fn: inboundParse, opts: { path: "/api/inbound/email/parse" } },
      ...RETRIES,
    ];
    const groupAlways = await runCronGroup(alwaysGroup);

    // ON 30-MIN: ERP syncs in parallel.
    let groupSyncs = [];
    if (ranSyncs) groupSyncs = await runCronGroup(SYNCS);

    // ON HOUR: agents.
    let groupAgents = [];
    if (ranAgents) {
      groupAgents = await runCronGroup([
        { name: "agents/run", fn: agentsRun, opts: { path: "/api/agents/run" } },
      ]);
    }

    // ON minute=5 (hourly off-peak): agent eval harness.
    let groupAgentEval = [];
    if (ranAgentEval) {
      groupAgentEval = await runCronGroup([
        { name: "eval/agent_eval", fn: agentEval, opts: { path: "/api/eval/agent_eval" } },
      ]);
    }

    const results = [...groupAlways, ...groupSyncs, ...groupAgents, ...groupAgentEval];
    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;
    const durationMs = Date.now() - startedAt.getTime();

    // Audit P5.1: heartbeat after the work, not before, so a tick
    // that crashes mid-run does not falsely advertise the worker
    // as healthy. We record per-sub-handler heartbeats too via the
    // results array so on-call can see which specific drain went
    // dark instead of just "tick stopped firing".
    await recordCronHeartbeat("cron/tick", {
      status: errCount === 0 ? "ok" : (okCount > 0 ? "partial" : "error"),
      durationMs,
      metadata: {
        minute, ran_syncs: ranSyncs, ran_agents: ranAgents,
        ran_agent_eval: ranAgentEval, total: results.length,
        ok: okCount, failed: errCount,
      },
    });
    for (const r of results) {
      await recordCronHeartbeat(r.name, {
        status: r.ok ? "ok" : "error",
        durationMs: r.duration_ms || 0,
        metadata: r.error ? { error: String(r.error).slice(0, 200) } : { status: r.status },
      });
    }

    return json(res, 200, {
      ran_at: startedAt.toISOString(),
      minute,
      ran_syncs: ranSyncs,
      ran_agents: ranAgents,
      ran_agent_eval: ranAgentEval,
      total: results.length,
      ok: okCount,
      failed: errCount,
      duration_ms: durationMs,
      results,
    });
  } catch (err) {
    // Heartbeat the failure so the health probe reports it.
    await recordCronHeartbeat("cron/tick", { status: "error", metadata: { error: String(err.message || err).slice(0, 200) } });
    sendError(res, err);
  }
}
