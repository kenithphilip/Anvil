// Cron multiplexer.
//
// The Hobby Vercel plan caps cron jobs at 2. Anvil ships ~23
// per-handler cron schedules. Rather than maintain a custom external
// scheduler, we expose two consolidated cron endpoints
// (/api/cron/tick every 5 min and /api/cron/daily once a day) that
// fan out to every existing per-handler cron path internally.
//
// The fan-out is by direct module import + synthetic req/res, NOT
// by HTTP self-call. That keeps it cheap (no extra invocations) and
// preserves the per-handler cron-mode auth check.
//
// Each handler is wrapped in try/catch so one failure does not
// block siblings. Promise.allSettled is used for parallel ERP
// fan-outs to keep wall time inside the function timeout.

// Build a synthetic Node-style req that satisfies what cron handlers
// actually read: method, url, headers (especially authorization),
// and the .on() event interface used by readBody (no-op here since
// cron paths don't read a body).
//
// CRON_SECRET is read at call time, not module load, so a rotated
// secret takes effect on the next tick without a redeploy.
export const makeMockReq = ({ path = "/", method = "GET", body = null, query = {} } = {}) => {
  const req = {
    method,
    url: path,
    headers: { authorization: "Bearer " + (process.env.CRON_SECRET || "") },
    query,
    body,
    on: (_event, _cb) => req,
  };
  return req;
};

// Build a synthetic res that captures everything the handlers do
// (res.status(n).send/json(body), res.setHeader, res.end). All
// methods chain. The captured outcome is exposed via _outcome.
export const makeMockRes = () => {
  const out = { statusCode: 0, headers: {}, body: null };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; return res; },
    status: (n) => { out.statusCode = n || 200; return res; },
    send: (b) => {
      out.body = b;
      if (!out.statusCode) out.statusCode = 200;
      return res;
    },
    json: (b) => {
      out.body = typeof b === "string" ? b : JSON.stringify(b);
      out.headers["Content-Type"] = "application/json";
      if (!out.statusCode) out.statusCode = 200;
      return res;
    },
    end: (b) => {
      if (b !== undefined) out.body = b;
      if (!out.statusCode) out.statusCode = 200;
      return res;
    },
  };
  return { res, _outcome: out };
};

// Phase 1 F10: per-handler timeout budgets. Without these, one
// slow ERP retry (a Tally bridge with a TCP socket leak, a
// NetSuite tenant stuck on OAuth1 rotation) starves every other
// handler in the same runCronGroup tick. Vercel's 60-second
// dispatch ceiling kills the whole tick before later handlers
// run. Per-handler budgets enforce a fair slice; the group cap
// (sum) sits inside dispatch headroom.
//
// Budgets are matched by handler-name prefix ("sap/retry" -> 25s
// because the SAP OAuth chain is the slowest). Anything not in
// the map gets DEFAULT_BUDGET_MS.
const CRON_HANDLER_BUDGETS = {
  "sap/":           25000,
  "netsuite/":      20000,
  "d365/":          20000,
  "acumatica/":     20000,
  "p21/":           15000,
  "eclipse/":       15000,
  "sxe/":           15000,
  "sage_x3/":       15000,
  "oracle_ebs/":    25000,
  "oracle_fusion/": 20000,
  "jde/":           25000,
  "plex/":          20000,
  "jobboss/":       20000,
  "ifs/":           25000,
  "ramco/":         20000,
  "proalpha/":      20000,
  "tally/":         30000,
};
const DEFAULT_BUDGET_MS = 20000;
export const cronHandlerBudgetMs = (name) => {
  if (!name) return DEFAULT_BUDGET_MS;
  for (const prefix of Object.keys(CRON_HANDLER_BUDGETS)) {
    if (name.startsWith(prefix)) return CRON_HANDLER_BUDGETS[prefix];
  }
  return DEFAULT_BUDGET_MS;
};

// timeoutPromise rejects with a tagged Error after `ms`. The
// caller races it against the handler with Promise.race. When
// the timeout wins, the handler keeps running in the background
// until the Vercel function exits; that's fine because cron
// work is idempotent and we'd rather abandon a slow handler than
// starve the rest.
const timeoutPromise = (ms, name) => new Promise((_, reject) => {
  setTimeout(() => {
    const err = new Error("timeout after " + ms + "ms");
    err.code = "CRON_HANDLER_TIMEOUT";
    err.name = "CronHandlerTimeout";
    err.handlerName = name;
    reject(err);
  }, ms);
});

// Call a handler with a synthetic cron-authed request. Captures
// status + body + duration + thrown errors. Never throws to the
// caller. Phase 1 F10 adds per-handler Promise.race timeout
// using cronHandlerBudgetMs() and writes an inline heartbeat so
// even when the dispatch function gets killed at the Vercel
// ceiling, the heartbeat for every handler that started lands
// in cron_health.
export const runCronHandler = async (name, handler, opts = {}) => {
  const t0 = Date.now();
  const budgetMs = opts.timeoutMs != null ? opts.timeoutMs : cronHandlerBudgetMs(name);
  const req = makeMockReq({
    path: opts.path || "/",
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body || null,
  });
  const { res, _outcome } = makeMockRes();
  let result;
  try {
    await Promise.race([
      handler(req, res),
      timeoutPromise(budgetMs, name),
    ]);
    const ok = _outcome.statusCode >= 200 && _outcome.statusCode < 300;
    result = {
      name, ok,
      status: _outcome.statusCode,
      duration_ms: Date.now() - t0,
      budget_ms: budgetMs,
      body_preview: typeof _outcome.body === "string"
        ? _outcome.body.slice(0, 240)
        : null,
    };
  } catch (err) {
    const isTimeout = err && err.code === "CRON_HANDLER_TIMEOUT";
    if (isTimeout) {
      // eslint-disable-next-line no-console
      console.warn("[cron] handler '" + name + "' timed out after " + budgetMs + "ms");
    }
    result = {
      name, ok: false,
      status: isTimeout ? 504 : (err?.status || 500),
      duration_ms: Date.now() - t0,
      budget_ms: budgetMs,
      error: isTimeout ? "timeout" : (err?.message || String(err)).slice(0, 400),
      timed_out: !!isTimeout,
    };
  }
  // Inline heartbeat. Per the audit's "write per-handler
  // heartbeats inline (in the result loop) rather than after
  // the group" recommendation: if Vercel kills the dispatch
  // function at 60s, every handler that started still leaves a
  // trail in cron_health. Suppressed under vitest so unit-test
  // runs don't hit the (missing) service-role credentials.
  if (opts.writeHeartbeat !== false && !process.env.VITEST) {
    recordCronHeartbeat(name, {
      status: result.ok ? "ok" : (result.timed_out ? "timeout" : "error"),
      durationMs: result.duration_ms,
      metadata: {
        budget_ms: result.budget_ms,
        timed_out: !!result.timed_out,
        last_error: result.error || null,
      },
    }).catch(() => { /* heartbeat write failures already log */ });
  }
  return result;
};

// Run a list of handlers in parallel. Each item is { name, fn, opts? }.
export const runCronGroup = async (items) => {
  const results = await Promise.allSettled(items.map(({ name, fn, opts }) =>
    runCronHandler(name, fn, opts || {})));
  return results.map((r) => r.status === "fulfilled" ? r.value : {
    name: "unknown", ok: false, status: 500, duration_ms: 0,
    error: String(r.reason).slice(0, 400),
  });
};

// Schedule helper. Decides whether a given gated handler should run
// on this tick based on the current minute.
export const shouldRunOnMinute = (minute, every) => {
  // every=30 means "every 30 minutes when minute % 30 === 0".
  // every=60 means "on the hour".
  return Number.isFinite(every) && every > 0 && (minute % every === 0);
};

// Audit P5.1 (May 2026). Record a heartbeat on the cron_health
// table so /api/health can probe last-tick freshness. The 5-min
// /api/cron/tick is documented to live on cron-job.org because
// Hobby tier limits Vercel cron to once per day; without this
// heartbeat, a silent external-cron failure (account expired,
// billing lapse) is invisible until orders pile up.
//
// Failures here log + swallow. Cron correctness must not depend
// on the heartbeat write succeeding.
import { serviceClient } from "./supabase.js";

export const recordCronHeartbeat = async (worker, { status, durationMs, metadata } = {}) => {
  try {
    const svc = serviceClient();
    const ok = status === "ok";
    const row = {
      worker,
      last_run_at: new Date().toISOString(),
      last_status: status || "ok",
      last_duration_ms: durationMs || 0,
      consecutive_failures: 0,
      metadata: metadata || {},
      updated_at: new Date().toISOString(),
    };
    if (!ok) {
      // Bump consecutive_failures by reading the current value.
      const cur = await svc.from("cron_health").select("consecutive_failures").eq("worker", worker).maybeSingle();
      row.consecutive_failures = (cur.data?.consecutive_failures || 0) + 1;
    }
    await svc.from("cron_health").upsert(row, { onConflict: "worker" });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[cron] heartbeat write failed for " + worker + ": " + (err.message || err));
  }
};
