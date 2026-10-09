// GET /api/cron/tick
//
// Meant to be called every 5 minutes by an EXTERNAL scheduler: vercel.json
// schedules only /api/cron/daily, because the Hobby tier rejects a sub-daily
// cron. docs/CRONS.md lists the schedulers and the one-time setup.
//
// Two gates decide what a call runs, and a handler must pass both:
//
//   1. The allow-list, CRON_TICK_HANDLERS (comma-separated handler names).
//      Unset or blank: ONLY "extraction/jobs". "all": every handler below.
//      "none": nothing. A list: exactly those names; a name that is not
//      registered is reported in the response and ignored.
//
//      The default is narrow on purpose. Most of these drains never ran in
//      production, so their queues hold months of backlog, and several of
//      them act on it: they send queued customer email, place calls, bill
//      metered usage and create draft orders. docs/CRONS.md has the per-handler
//      inventory and the cleanup each one needs before it is widened.
//
//   2. The cadence, from the current UTC minute:
//        always       every call
//        half_hourly  minute % 30 === 0 (the ERP and PLM syncs)
//        hourly       minute === 0 (agents/run, drift-meter)
//        hourly_at_5  minute === 5 (the eval harness, off the hour spike)
//
// The response names every registered handler exactly once: in `ran`, in
// `skipped_by_gate`, or in `not_due` (allowed, but not due this minute).
//
// Auth: Bearer CRON_SECRET; with the secret unset every call is refused.
// One sub-handler failure does not block siblings (Promise.allSettled
// + per-handler try/catch in cron-mux).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { runCronGroup, shouldRunOnMinute, recordCronHeartbeat } from "../_lib/cron-mux.js";

import netsuiteSync     from "../netsuite/sync.js";
import netsuiteRetry    from "../netsuite/retry.js";
import tallySync        from "../tally/sync.js";
import tallyRetry       from "../tally/retry.js";
import tallyReconcileCron from "./tally-reconcile.js";
import extractionJobsCron from "./extraction_jobs.js";
import driftMeterCron     from "./drift-meter.js";
import logisticsMonitorTick from "./logistics-monitor-tick.js";
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
import evalRescore      from "../eval/rescore.js";
import prospectingRun   from "../prospecting/run.js";
import plmSync          from "../plm/sync.js";
import pushSend         from "../push/send.js";
import inboundParse     from "../inbound/email/parse.js";
import agentsRun        from "../agents/run.js";
// Phase 2 of the audit roadmap: queue consumers that turn the
// previously-dead-letter producer queues into working flows.
import inboundEmailDraftOrders from "../inbound/email/draft_orders.js";
import inboundEmailPersistAttachments from "../inbound/email/persist_attachments.js";
import voiceProcessActions     from "../voice/process_actions.js";
import inboundProcessMessages  from "../inbound/process_messages.js";
import inboundAutoOcr          from "../inbound/auto_ocr.js";
// Audit P6.8: reply-handling worker drains inbound_emails with
// actionable classified_intent (payment_acknowledge, etc.) and
// updates the matching agent_goals.
import agentsHandleReplies from "../agents/handle_replies.js";

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
  // Phase F.6: drift-check the previously-pushed Tally vouchers
  // against the just-synced mirror state. Runs after tally/sync so
  // tally_voucher_state has the freshest data to compare against.
  { name: "tally/reconcile", fn: tallyReconcileCron, opts: { path: "/api/cron/tally-reconcile" } },
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

// Cadences. isTickHandlerDue() is the only place that reads them.
export const ALWAYS = "always";
export const HALF_HOURLY = "half_hourly";
export const HOURLY = "hourly";
export const HOURLY_AT_5 = "hourly_at_5";

// Groups run one after another in this order; the handlers inside a group run
// in parallel. Same order as before the allow-list existed.
const CADENCE_ORDER = [ALWAYS, HALF_HOURLY, HOURLY, HOURLY_AT_5];

export const isTickHandlerDue = (cadence, minute) => {
  if (cadence === ALWAYS) return true;
  if (cadence === HALF_HOURLY) return shouldRunOnMinute(minute, 30);
  if (cadence === HOURLY) return shouldRunOnMinute(minute, 60);
  // The agent-eval harness runs once an hour at minute 5, off the
  // hour-on-the-hour traffic spike. Phase 6 (C.3): the drift trend chart in
  // Diagnostics is fed from `agent_eval_runs`.
  if (cadence === HOURLY_AT_5) return minute === 5;
  return false;
};

// Every handler tick can run. `name` is the allow-list key AND the worker row
// in cron_health, so renaming one orphans its heartbeat history.
export const TICK_HANDLERS = [
  { name: "push/send",            cadence: ALWAYS, fn: pushSend,     opts: { path: "/api/push/send" } },
  // Phase C: drain the extraction_jobs queue. Runs every
  // tick so a large-PDF background extraction makes
  // progress promptly. The worker bounds itself to ~18s
  // per tick (inside the cron-mux 20s budget) and processes
  // up to MAX_JOBS_PER_TICK jobs per invocation.
  { name: "extraction/jobs",      cadence: ALWAYS, fn: extractionJobsCron, opts: { path: "/api/cron/extraction_jobs" } },
  // Prospecting dispatch runs every tick; the inner send-window
  // + daily-cap checks gate which campaigns actually fire (C.6).
  { name: "prospecting/run",      cadence: ALWAYS, fn: prospectingRun, opts: { path: "/api/prospecting/run", method: "POST" } },
  { name: "inbound/email/parse",  cadence: ALWAYS, fn: inboundParse, opts: { path: "/api/inbound/email/parse" } },
  // Phase 2 (audit): drain the four producer-without-consumer
  // queues every tick. Order matters: the linked-email worker
  // creates orders that the inbound_messages consumer also
  // touches, but they pick from disjoint tables so concurrent
  // execution is safe. auto_ocr runs after the order-creating
  // workers so newly-linked documents are picked up the same
  // tick.
  // Audit P5.4: persist_attachments runs BEFORE draft_orders so
  // any inline attachment bytes are uploaded to storage and a
  // documents row is created; then draft_orders links the
  // documents into the new order via order_documents and
  // auto_ocr picks them up downstream.
  { name: "inbound/email/persist_attachments", cadence: ALWAYS, fn: inboundEmailPersistAttachments, opts: { path: "/api/inbound/email/persist_attachments" } },
  { name: "inbound/email/draft_orders", cadence: ALWAYS, fn: inboundEmailDraftOrders, opts: { path: "/api/inbound/email/draft_orders" } },
  { name: "voice/process_actions",      cadence: ALWAYS, fn: voiceProcessActions,     opts: { path: "/api/voice/process_actions" } },
  { name: "inbound/process_messages",   cadence: ALWAYS, fn: inboundProcessMessages,  opts: { path: "/api/inbound/process_messages" } },
  { name: "inbound/auto_ocr",           cadence: ALWAYS, fn: inboundAutoOcr,          opts: { path: "/api/inbound/auto_ocr" } },
  // Audit P6.8: drain inbound_emails with actionable
  // classified_intent values (payment_acknowledge etc.) and
  // update the matching agent_goals.
  { name: "agents/handle_replies", cadence: ALWAYS, fn: agentsHandleReplies, opts: { path: "/api/agents/handle_replies" } },
  // Logistics monitor: detect delay/SLA exceptions + escalate. Gated to
  // tenants with logistics_monitor_enabled (none by default); idempotent.
  { name: "logistics/monitor",    cadence: ALWAYS, fn: logisticsMonitorTick, opts: { path: "/api/cron/logistics-monitor-tick" } },
  ...RETRIES.map((h) => ({ ...h, cadence: ALWAYS })),
  // ERP + PLM syncs, in parallel.
  ...SYNCS.map((h) => ({ ...h, cadence: HALF_HOURLY })),
  { name: "agents/run", cadence: HOURLY, fn: agentsRun, opts: { path: "/api/agents/run" } },
  // Bet 5: drain unreported tally_drift_billing_meter rows to
  // Stripe meters / Razorpay add-ons. Idempotent; safe to run
  // every hour even when there's nothing to drain.
  { name: "drift-meter", cadence: HOURLY, fn: driftMeterCron, opts: { path: "/api/cron/drift-meter" } },
  // Agent eval harness + golden-set re-score. The re-score measures live
  // extraction accuracy vs the human-verified golden corpus
  // (EVAL_GOLDEN_TENANT_ID); it no-ops cheaply when unset.
  { name: "eval/agent_eval", cadence: HOURLY_AT_5, fn: agentEval, opts: { path: "/api/eval/agent_eval" } },
  { name: "eval/rescore", cadence: HOURLY_AT_5, fn: evalRescore, opts: { path: "/api/eval/rescore", method: "POST", body: {} } },
];

// What runs when CRON_TICK_HANDLERS is unset. extraction/jobs only advances
// extraction work a user already queued for one of their own orders: it sends
// nothing outside Anvil and creates nothing new.
export const DEFAULT_TICK_HANDLERS = Object.freeze(["extraction/jobs"]);

// Parse CRON_TICK_HANDLERS against the registered names.
//   mode     "default" | "all" | "none" | "list"
//   allowed  Set of registered names that may run
//   unknown  names in the list that are not registered (reported, ignored)
// A blank value counts as unset. "none" and "all" win over any names listed
// beside them, and "none" wins over "all": an off switch must not be undone
// by a stray word.
export const resolveTickAllowList = (raw, registeredNames) => {
  const registered = new Set(registeredNames);
  const tokens = String(raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    return {
      mode: "default",
      allowed: new Set(DEFAULT_TICK_HANDLERS.filter((n) => registered.has(n))),
      unknown: [],
    };
  }
  if (tokens.includes("none")) return { mode: "none", allowed: new Set(), unknown: [] };
  if (tokens.includes("all")) return { mode: "all", allowed: registered, unknown: [] };
  const unique = [...new Set(tokens)];
  return {
    mode: "list",
    allowed: new Set(unique.filter((t) => registered.has(t))),
    unknown: unique.filter((t) => !registered.has(t)),
  };
};

// The handler, with its collaborators injectable so the gate can be tested
// without running the real drains. Production uses the defaults.
export const createTickHandler = ({
  handlers = TICK_HANDLERS,
  secret = CRON_SECRET,
  runGroup = runCronGroup,
  heartbeat = recordCronHeartbeat,
  now = () => new Date(),
  env = process.env,
} = {}) => async function tickHandler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!secret || auth !== secret) {
      return json(res, 401, { error: { message: "tick is cron-only" } });
    }
    const startedAt = now();
    const minute = startedAt.getUTCMinutes();
    const gate = resolveTickAllowList(env.CRON_TICK_HANDLERS, handlers.map((h) => h.name));

    const results = [];
    const skippedByGate = [];
    const notDue = [];
    for (const cadence of CADENCE_ORDER) {
      const due = isTickHandlerDue(cadence, minute);
      const toRun = [];
      for (const h of handlers.filter((x) => x.cadence === cadence)) {
        if (!gate.allowed.has(h.name)) skippedByGate.push(h.name);
        else if (!due) notDue.push(h.name);
        else toRun.push(h);
      }
      if (toRun.length) results.push(...await runGroup(toRun));
    }

    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;
    const durationMs = now().getTime() - startedAt.getTime();
    const ranSyncs = isTickHandlerDue(HALF_HOURLY, minute);
    const ranAgents = isTickHandlerDue(HOURLY, minute);
    const ranAgentEval = isTickHandlerDue(HOURLY_AT_5, minute);

    // Audit P5.1: heartbeat after the work, not before, so a tick
    // that crashes mid-run does not falsely advertise the worker
    // as healthy. We record per-sub-handler heartbeats too via the
    // results array so on-call can see which specific drain went
    // dark instead of just "tick stopped firing". A handler the
    // gate skipped writes no heartbeat, because it did not run.
    await heartbeat("cron/tick", {
      status: errCount === 0 ? "ok" : (okCount > 0 ? "partial" : "error"),
      durationMs,
      metadata: {
        minute, ran_syncs: ranSyncs, ran_agents: ranAgents,
        ran_agent_eval: ranAgentEval, total: results.length,
        ok: okCount, failed: errCount,
        gate_mode: gate.mode, skipped_by_gate: skippedByGate.length,
      },
    });
    for (const r of results) {
      await heartbeat(r.name, {
        status: r.ok ? "ok" : "error",
        durationMs: r.duration_ms || 0,
        metadata: r.error ? { error: String(r.error).slice(0, 200) } : { status: r.status },
      });
    }

    return json(res, 200, {
      ran_at: startedAt.toISOString(),
      minute,
      // These three say which cadences were DUE this minute. Whether their
      // handlers ran also depends on the gate, so read `ran` for that.
      ran_syncs: ranSyncs,
      ran_agents: ranAgents,
      ran_agent_eval: ranAgentEval,
      gate: {
        mode: gate.mode,
        handlers: handlers.map((h) => h.name).filter((n) => gate.allowed.has(n)),
        unknown: gate.unknown,
      },
      ran: results.map((r) => r.name),
      skipped_by_gate: skippedByGate,
      not_due: notDue,
      total: results.length,
      ok: okCount,
      failed: errCount,
      duration_ms: durationMs,
      results,
    });
  } catch (err) {
    // Heartbeat the failure so the health probe reports it.
    await heartbeat("cron/tick", { status: "error", metadata: { error: String(err.message || err).slice(0, 200) } });
    sendError(res, err);
  }
};

export default createTickHandler();
