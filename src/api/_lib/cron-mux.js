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

// Call a handler with a synthetic cron-authed request. Captures
// status + body + duration + thrown errors. Never throws to the
// caller.
export const runCronHandler = async (name, handler, opts = {}) => {
  const t0 = Date.now();
  const req = makeMockReq({
    path: opts.path || "/",
    method: opts.method || "GET",
    query: opts.query || {},
    body: opts.body || null,
  });
  const { res, _outcome } = makeMockRes();
  try {
    await handler(req, res);
    const ok = _outcome.statusCode >= 200 && _outcome.statusCode < 300;
    return {
      name, ok,
      status: _outcome.statusCode,
      duration_ms: Date.now() - t0,
      body_preview: typeof _outcome.body === "string"
        ? _outcome.body.slice(0, 240)
        : null,
    };
  } catch (err) {
    return {
      name, ok: false,
      status: err?.status || 500,
      duration_ms: Date.now() - t0,
      error: (err?.message || String(err)).slice(0, 400),
    };
  }
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
