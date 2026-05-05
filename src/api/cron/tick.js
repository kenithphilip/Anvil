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
import { runCronGroup, shouldRunOnMinute } from "../_lib/cron-mux.js";

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

    // ALWAYS: every-5-min items.
    const alwaysGroup = [
      { name: "push/send",            fn: pushSend,     opts: { path: "/api/push/send" } },
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

    const results = [...groupAlways, ...groupSyncs, ...groupAgents];
    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;
    return json(res, 200, {
      ran_at: startedAt.toISOString(),
      minute,
      ran_syncs: ranSyncs,
      ran_agents: ranAgents,
      total: results.length,
      ok: okCount,
      failed: errCount,
      duration_ms: Date.now() - startedAt.getTime(),
      results,
    });
  } catch (err) { sendError(res, err); }
}
