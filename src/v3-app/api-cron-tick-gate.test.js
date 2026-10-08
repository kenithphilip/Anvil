// /api/cron/tick: the CRON_TICK_HANDLERS allow-list.
//
// Nothing scheduled tick in production (vercel.json schedules only
// /api/cron/daily), so most of its drains never ran and their queues hold
// months of backlog. Several act on that backlog: agents/run reaps every
// queued customer email, voice/process_actions turns old voice actions into
// draft orders, drift-meter bills Stripe. Turning a scheduler on must not
// release all of that at once, so tick now runs only what the allow-list
// names, and runs ONLY extraction/jobs when the list is unset.
//
// The gate is tested through the real handler with the real registry
// (names + cadences); only each entry's fn is swapped for a recorder, so no
// drain touches a database. The last block runs one REAL drain (agents/run)
// against a service client that is down, to prove a crash is reported.

import { describe, it, expect, vi } from "vitest";

const SECRET = vi.hoisted(() => {
  const s = "tick-gate-test-secret";
  process.env.CRON_SECRET = s;
  return s;
});

// The real drains import the service client at module load. Any drain that
// does run in this file gets a client that is down, never a network call.
vi.mock("../api/_lib/supabase.js", async (importOriginal) => ({
  ...(await importOriginal()),
  serviceClient: () => { throw new Error("service client unavailable in this test"); },
}));

import tick, {
  createTickHandler, TICK_HANDLERS, DEFAULT_TICK_HANDLERS,
} from "../api/cron/tick.js";
import { makeMockRes } from "../api/_lib/cron-mux.js";

const RETRY_NAMES = [
  "netsuite/retry", "tally/retry", "sap/retry", "d365/retry", "acumatica/retry",
  "p21/retry", "eclipse/retry", "sxe/retry", "sage_x3/retry", "ifs/retry",
  "oracle_fusion/retry", "ramco/retry", "jde/retry", "plex/retry",
  "jobboss/retry", "oracle_ebs/retry", "proalpha/retry",
];
// Today's cadence, written out by hand so a handler that moves between
// cadences (or is added without one) fails here instead of silently.
const EVERY_TICK = [
  "push/send", "extraction/jobs", "prospecting/run", "inbound/email/parse",
  "inbound/email/persist_attachments", "inbound/email/draft_orders",
  "voice/process_actions", "inbound/process_messages", "inbound/auto_ocr",
  "agents/handle_replies", "logistics/monitor",
  ...RETRY_NAMES,
];
const HALF_HOURLY = [
  "netsuite/sync", "tally/sync", "tally/reconcile", "sap/sync", "d365/sync",
  "acumatica/sync", "p21/sync", "eclipse/sync", "sxe/sync", "sage_x3/sync",
  "ifs/sync", "oracle_fusion/sync", "ramco/sync", "jde/sync", "plex/sync",
  "jobboss/sync", "oracle_ebs/sync", "proalpha/sync", "plm/sync",
];
const ON_THE_HOUR = ["agents/run", "drift-meter"];
const AT_MINUTE_5 = ["eval/agent_eval", "eval/rescore"];
const ALL_NAMES = [...EVERY_TICK, ...HALF_HOURLY, ...ON_THE_HOUR, ...AT_MINUTE_5];

const at = (minute) => () => new Date(Date.UTC(2026, 9, 8, 10, minute, 0));

// The real registry with every fn swapped for a recorder. `overrides` replaces
// the fn for a named handler (to make it throw, fail, or stall).
const stubbed = (overrides = {}) => {
  const calls = [];
  const handlers = TICK_HANDLERS.map((h) => ({
    ...h,
    fn: async (req, res) => {
      calls.push(h.name);
      if (overrides[h.name]) return overrides[h.name](req, res);
      res.status(200).json({ ok: true });
    },
  }));
  return { handlers, calls };
};

const makeTick = ({ list, minute = 0, overrides, heartbeats = [] } = {}) => {
  const { handlers, calls } = stubbed(overrides);
  const env = list === undefined ? {} : { CRON_TICK_HANDLERS: list };
  const handler = createTickHandler({
    handlers,
    secret: SECRET,
    env,
    now: at(minute),
    heartbeat: async (worker, detail) => { heartbeats.push({ worker, ...detail }); },
  });
  return { handler, calls, heartbeats };
};

const call = async (handler, authorization = "Bearer " + SECRET) => {
  const req = {
    method: "GET",
    url: "/api/cron/tick",
    headers: authorization == null ? {} : { authorization },
    query: {},
  };
  req.on = () => req;
  const { res, _outcome } = makeMockRes();
  await handler(req, res);
  return { status: _outcome.statusCode, body: JSON.parse(_outcome.body) };
};

const sorted = (xs) => [...xs].sort();

describe("the registry", () => {
  it("is today's handler set, each on today's cadence", () => {
    expect(sorted(TICK_HANDLERS.map((h) => h.name))).toEqual(sorted(ALL_NAMES));
    expect(TICK_HANDLERS).toHaveLength(51);
  });

  it("defaults to extraction/jobs alone", () => {
    expect([...DEFAULT_TICK_HANDLERS]).toEqual(["extraction/jobs"]);
  });
});

describe("CRON_TICK_HANDLERS unset", () => {
  it("runs only extraction/jobs and reports every other handler as skipped", async () => {
    const { handler, calls } = makeTick({ minute: 0 });
    const { status, body } = await call(handler);

    expect(status).toBe(200);
    expect(calls).toEqual(["extraction/jobs"]);
    expect(body.ran).toEqual(["extraction/jobs"]);
    expect(body.gate).toEqual({ mode: "default", handlers: ["extraction/jobs"], unknown: [] });
    expect(sorted(body.skipped_by_gate)).toEqual(sorted(ALL_NAMES.filter((n) => n !== "extraction/jobs")));
    // The risky drains are named in the skipped list, not silently dropped.
    for (const n of ["agents/run", "voice/process_actions", "inbound/process_messages", "drift-meter", "prospecting/run"]) {
      expect(body.skipped_by_gate).toContain(n);
    }
    expect(body.total).toBe(1);
    expect(body.ok).toBe(1);
  });

  it("treats a blank value as unset", async () => {
    for (const list of ["", "   ", " , ,"]) {
      const { handler, calls } = makeTick({ list, minute: 0 });
      const { body } = await call(handler);
      expect(calls).toEqual(["extraction/jobs"]);
      expect(body.gate.mode).toBe("default");
    }
  });

  it("writes heartbeats only for what ran", async () => {
    const { handler, heartbeats } = makeTick({ minute: 0 });
    await call(handler);
    expect(heartbeats.map((h) => h.worker)).toEqual(["cron/tick", "extraction/jobs"]);
    expect(heartbeats[0].metadata.gate_mode).toBe("default");
    expect(heartbeats[0].metadata.skipped_by_gate).toBe(50);
  });
});

describe("CRON_TICK_HANDLERS=all", () => {
  it("between the marks (minute 7) runs every-tick handlers only", async () => {
    const { handler } = makeTick({ list: "all", minute: 7 });
    const { body } = await call(handler);
    expect(body.ran).toEqual(EVERY_TICK);
    expect(sorted(body.not_due)).toEqual(sorted([...HALF_HOURLY, ...ON_THE_HOUR, ...AT_MINUTE_5]));
    expect(body.skipped_by_gate).toEqual([]);
    expect([body.ran_syncs, body.ran_agents, body.ran_agent_eval]).toEqual([false, false, false]);
  });

  it("on the half hour adds the syncs", async () => {
    const { handler } = makeTick({ list: "all", minute: 30 });
    const { body } = await call(handler);
    expect(body.ran).toEqual([...EVERY_TICK, ...HALF_HOURLY]);
    expect(body.ran_syncs).toBe(true);
    expect(body.ran_agents).toBe(false);
  });

  it("on the hour adds the syncs, then agents/run and drift-meter, in that order", async () => {
    const { handler } = makeTick({ list: "all", minute: 0 });
    const { body } = await call(handler);
    expect(body.ran).toEqual([...EVERY_TICK, ...HALF_HOURLY, ...ON_THE_HOUR]);
    expect(body.not_due).toEqual(AT_MINUTE_5);
    expect(body.ran_agents).toBe(true);
    expect(body.ran_agent_eval).toBe(false);
  });

  it("at minute 5 adds the eval harness and nothing hourly", async () => {
    const { handler } = makeTick({ list: "all", minute: 5 });
    const { body } = await call(handler);
    expect(body.ran).toEqual([...EVERY_TICK, ...AT_MINUTE_5]);
    expect(body.ran_agent_eval).toBe(true);
    expect(body.ran_syncs).toBe(false);
  });

  it("reports mode all with every registered name", async () => {
    const { handler } = makeTick({ list: "ALL", minute: 7 });
    const { body } = await call(handler);
    expect(body.gate.mode).toBe("all");
    expect(sorted(body.gate.handlers)).toEqual(sorted(ALL_NAMES));
  });
});

describe("a custom list", () => {
  it("runs exactly the listed handlers", async () => {
    const { handler, calls } = makeTick({
      list: " agents/handle_replies,EXTRACTION/JOBS , drift-meter,tally/sync",
      minute: 0,
    });
    const { body } = await call(handler);
    expect(sorted(calls)).toEqual(sorted(["agents/handle_replies", "extraction/jobs", "tally/sync", "drift-meter"]));
    expect(body.ran).toEqual(["extraction/jobs", "agents/handle_replies", "tally/sync", "drift-meter"]);
    expect(body.gate.mode).toBe("list");
    // Registry order, whatever order the variable used.
    expect(body.gate.handlers).toEqual(["extraction/jobs", "agents/handle_replies", "tally/sync", "drift-meter"]);
    expect(body.skipped_by_gate).toHaveLength(51 - 4);
    expect(body.skipped_by_gate).not.toContain("drift-meter");
  });

  it("still waits for a listed handler's cadence", async () => {
    const { handler, calls } = makeTick({ list: "extraction/jobs,drift-meter,tally/sync", minute: 7 });
    const { body } = await call(handler);
    expect(calls).toEqual(["extraction/jobs"]);
    expect(body.not_due).toEqual(["tally/sync", "drift-meter"]);
  });

  it("replaces the default instead of adding to it", async () => {
    const { handler, calls } = makeTick({ list: "push/send", minute: 7 });
    await call(handler);
    expect(calls).toEqual(["push/send"]);
  });
});

describe("an unknown name", () => {
  it("is reported and ignored", async () => {
    const { handler, calls } = makeTick({ list: "extraction/jobs,agent/run, push/sned", minute: 0 });
    const { status, body } = await call(handler);
    expect(status).toBe(200);
    expect(calls).toEqual(["extraction/jobs"]);
    expect(body.gate.unknown).toEqual(["agent/run", "push/sned"]);
    expect(body.ran).not.toContain("agent/run");
  });

  it("on its own runs nothing; it does not fall back to the default", async () => {
    const { handler, calls } = makeTick({ list: "agent/run", minute: 0 });
    const { body } = await call(handler);
    expect(calls).toEqual([]);
    expect(body.ran).toEqual([]);
    expect(body.gate).toEqual({ mode: "list", handlers: [], unknown: ["agent/run"] });
    expect(body.skipped_by_gate).toHaveLength(51);
  });
});

describe("CRON_TICK_HANDLERS=none", () => {
  it("runs nothing, even beside all", async () => {
    for (const list of ["none", "all,none", "NONE,extraction/jobs"]) {
      const { handler, calls } = makeTick({ list, minute: 0 });
      const { status, body } = await call(handler);
      expect(status).toBe(200);
      expect(calls).toEqual([]);
      expect(body.gate.mode).toBe("none");
      expect(body.skipped_by_gate).toHaveLength(51);
    }
  });
});

describe("auth is unchanged", () => {
  it("refuses a call with no bearer", async () => {
    const { status, body } = await call(tick, null);
    expect(status).toBe(401);
    expect(body.error.message).toBe("tick is cron-only");
  });

  it("refuses a wrong bearer", async () => {
    const { status } = await call(tick, "Bearer not-the-secret");
    expect(status).toBe(401);
  });

  it("runs nothing on a refused call, whatever the allow-list says", async () => {
    const { handler, calls, heartbeats } = makeTick({ list: "all", minute: 0 });
    const { status } = await call(handler, null);
    expect(status).toBe(401);
    expect(calls).toEqual([]);
    expect(heartbeats).toEqual([]);
  });

  it("fails closed when the secret is unset", async () => {
    const { handlers, calls } = stubbed();
    const handler = createTickHandler({ handlers, secret: undefined, env: { CRON_TICK_HANDLERS: "all" }, now: at(0), heartbeat: async () => {} });
    for (const authorization of [null, "Bearer ", "Bearer undefined"]) {
      const { status } = await call(handler, authorization);
      expect(status).toBe(401);
    }
    expect(calls).toEqual([]);
  });
});

describe("per-handler isolation", () => {
  it("one handler throwing, or answering 500, does not block the others", async () => {
    const heartbeats = [];
    const { handler, calls } = makeTick({
      list: "all",
      minute: 0,
      heartbeats,
      overrides: {
        "push/send": async () => { throw new Error("push provider down"); },
        "tally/sync": async () => { throw new Error("bridge unreachable"); },
        "extraction/jobs": async (_req, res) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false }));
        },
      },
    });
    const { status, body } = await call(handler);

    expect(status).toBe(200);
    // Every due handler was started, including the groups after the failures.
    expect(sorted(calls)).toEqual(sorted([...EVERY_TICK, ...HALF_HOURLY, ...ON_THE_HOUR]));
    const byName = Object.fromEntries(body.results.map((r) => [r.name, r]));
    expect(byName["push/send"]).toMatchObject({ ok: false, status: 500 });
    expect(byName["push/send"].error).toContain("push provider down");
    expect(byName["tally/sync"].ok).toBe(false);
    expect(byName["extraction/jobs"]).toMatchObject({ ok: false, status: 500 });
    expect(byName["agents/run"].ok).toBe(true);
    expect(body.failed).toBe(3);
    expect(body.ok).toBe(body.total - 3);
    expect(heartbeats[0]).toMatchObject({ worker: "cron/tick", status: "partial" });
  });
});

describe("a real drain that crashes is reported as failed", () => {
  it("agents/run with its database down answers 500 and is counted as failed", async () => {
    // Real registry, real agents/run. It catches the service-client error and
    // answers Node-style (res.statusCode = 500; res.end). Before the cron-mux
    // fix that was recorded as { ok: true, status: 200 }.
    const handler = createTickHandler({
      secret: SECRET,
      env: { CRON_TICK_HANDLERS: "agents/run" },
      now: at(0),
      heartbeat: async () => {},
    });
    const { status, body } = await call(handler);
    expect(status).toBe(200);
    expect(body.ran).toEqual(["agents/run"]);
    expect(body.results[0]).toMatchObject({ name: "agents/run", ok: false, status: 500 });
    expect(body.results[0].body_preview).toContain("service client unavailable");
    expect(body.failed).toBe(1);
  });
});
