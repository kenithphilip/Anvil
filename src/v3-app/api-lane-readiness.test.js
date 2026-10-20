// GET /api/admin/lane_readiness (plan C-8): is the Mode B lane ready for the
// pilot? Requests go through the real router. auth.js is the REAL module, with
// only resolveContext overridden, so the admin gate is exercised. The mailer is
// real except for the two provider reads. Every address is example.com.
//
// H.missing names a table ("orders") or a table.column ("orders.payment_terms")
// and the PostgREST code a select that names it returns, as a database
// without that migration answers. H.fail does the same with an unrelated error.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  ctx: null, store: {}, users: {}, missing: {}, fail: {}, writes: [], queries: [], mail: "brevo",
}));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, emailProvider: () => H.mail, emailConfigured: () => !!H.mail };
});

const makeSvc = () => ({
  auth: { admin: { getUserById: async (id) => ({ data: { user: H.users[id] || null }, error: null }) } },
  from(table) {
    const q = { table, cols: "*", opts: null, filters: {}, preds: [], single: false };
    H.queries.push(q);
    const write = (mode) => () => { H.writes.push({ table, mode }); return b; };
    const run = () => {
      const named = q.cols.split(",").map((s) => s.trim());
      for (const key of [table, ...named.map((c) => table + "." + c)]) {
        if (H.missing[key]) return { data: null, count: null, error: { code: H.missing[key], message: key + " does not exist" } };
        if (H.fail[key]) return { data: null, count: null, error: { code: H.fail[key], message: "canceling statement due to statement timeout" } };
      }
      const rows = (H.store[table] || []).filter((r) => q.preds.every((p) => p(r))).map((r) => ({ ...r }));
      if (q.opts && q.opts.head) return { data: null, count: rows.length, error: null };
      return { data: q.single ? rows[0] || null : rows, error: null };
    };
    const b = {
      select(cols, opts) { q.cols = cols || "*"; q.opts = opts || null; return b; },
      eq(c, v) { q.filters[c] = v; q.preds.push((r) => r[c] === v); return b; },
      in(c, vs) { q.preds.push((r) => vs.includes(r[c])); return b; },
      gte(c, v) { q.preds.push((r) => String(r[c]) >= String(v)); return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { q.single = true; return Promise.resolve(run()); },
      insert: write("insert"), upsert: write("upsert"), update: write("update"), delete: write("delete"),
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  },
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));

const { dispatch } = await import("../api/router.js");

const call = async (method = "GET") => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await dispatch({ method, headers: {}, url: "/api/admin/lane_readiness", body: {} }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

const T1 = "tenant-1";
const T2 = "tenant-2";
const as = (role, tenantId = T1) => { H.ctx = { user: { id: "u-admin" }, tenantId, role, anonymous: false }; };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const MIN = 60000;
const DAY = 86400000;
const STEPS = ["create_order", "order_reconcile_quotes", "order_terms_checked", "order_term_decided", "approve_order", "so_pdf_downloaded", "order_sales_order_attached"];
const TENANT_TABLES = new Set(["tenant_settings", "tenant_members", "order_term_checks", "orders", "admin_notifications", "audit_events"]);

const byId = (body, id) => body.checks.find((c) => c.id === id);
const status = (body, id) => byId(body, id)?.status;

let savedClam;
beforeEach(() => {
  savedClam = process.env.CLAMAV_URL;
  process.env.CLAMAV_URL = "http://clamav.example.com";
  H.missing = {};
  H.fail = {};
  H.writes = [];
  H.queries = [];
  H.mail = "brevo";
  H.users = { "u-op1": { id: "u-op1", email: "ops1@example.com", user_metadata: {} } };
  H.store = {
    tenant_settings: [
      { tenant_id: T1, so_processing_mode: "B", terms_check_mode: "shadow", order_handoff_enabled: true, order_handoff_to: ["orders@example.com", "role:operator"], order_handoff_cc: [] },
      { tenant_id: T2, so_processing_mode: "A", terms_check_mode: "off", order_handoff_enabled: false, order_handoff_to: [], order_handoff_cc: [] },
    ],
    tenant_members: [{ tenant_id: T1, user_id: "u-op1", role: "operator", status: "approved" }],
    order_term_checks: [],
    orders: [{ tenant_id: T1, id: "o1", handoff_status: null, payment_terms: null }],
    admin_notifications: [],
    cron_health: [
      { worker: "cron/tick", last_run_at: ago(2 * MIN), last_status: "ok", consecutive_failures: 0 },
      { worker: "cron/daily", last_run_at: ago(3 * 60 * MIN), last_status: "ok", consecutive_failures: 0 },
    ],
    audit_events: [
      ...STEPS.map((action) => ({ tenant_id: T1, action, created_at: ago(DAY) })),
      { tenant_id: T1, action: "create_order", created_at: ago(2 * DAY) },
      { tenant_id: T1, action: "approve_order", created_at: ago(10 * DAY) },
      { tenant_id: T2, action: "approve_order", created_at: ago(DAY) },
    ],
  };
  as("admin");
});
afterEach(() => {
  if (savedClam === undefined) delete process.env.CLAMAV_URL; else process.env.CLAMAV_URL = savedClam;
});

describe("a ready lane", () => {
  it("reports every check ok, with the values that make it so", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.summary).toEqual({ ok: r.body.checks.length, warn: 0, missing: 0 });
    expect(byId(r.body, "so_processing_mode").value).toBe("B");
    expect(byId(r.body, "terms_check_mode").value).toBe("shadow");
    expect(byId(r.body, "order_handoff_enabled").value).toBe(true);
    expect(byId(r.body, "mail_provider").value).toBe("brevo");
    expect(byId(r.body, "handoff_recipients").value).toEqual({ to: 2, cc: 0, dropped: 0 });
    expect(r.body.checks.filter((c) => c.group === "migrations").map((c) => [c.id, c.status])).toEqual([
      ["221_so_processing_mode", "ok"], ["250_order_terms", "ok"], ["251_order_handoff", "ok"], ["253_notification_recipient", "ok"],
    ]);
    expect(r.body.checks.filter((c) => c.group === "cron").map((c) => [c.id, c.status])).toEqual([["cron/tick", "ok"], ["cron/daily", "ok"]]);
  });

  it("counts each step in the last 7 days for this tenant only", async () => {
    const r = await call();
    const usage = Object.fromEntries(r.body.checks.filter((c) => c.group === "usage").map((c) => [c.id, c.value]));
    expect(usage).toEqual({
      create_order: 2, order_reconcile_quotes: 1, order_terms_checked: 1, order_term_decided: 1,
      approve_order: 1, so_pdf_downloaded: 1, order_sales_order_attached: 1,
    });
  });

  it("writes nothing, and filters every tenant-table query by the caller's tenant", async () => {
    await call();
    expect(H.writes).toEqual([]);
    const tenantQueries = H.queries.filter((q) => TENANT_TABLES.has(q.table));
    expect(tenantQueries.length).toBeGreaterThan(10);
    for (const q of tenantQueries) expect([q.table, q.filters.tenant_id]).toEqual([q.table, T1]);
  });
});

describe("the gate", () => {
  it.each(["sales_manager", "sales_engineer", "operator", "viewer"])("refuses %s with 403 before any read", async (role) => {
    as(role);
    const r = await call();
    expect(r.status).toBe(403);
    expect(H.queries).toEqual([]);
  });

  it("refuses a session with no tenant", async () => {
    as("admin", null);
    const r = await call();
    expect(r.status).toBe(400);
    expect(H.queries).toEqual([]);
  });

  it("answers 405 to a write method", async () => {
    const r = await call("PATCH");
    expect(r.status).toBe(405);
    expect(H.writes).toEqual([]);
  });
});

describe("each probe reports missing when the database lacks the object", () => {
  it.each([
    ["tenant_settings.so_processing_mode", "42703", ["so_processing_mode", "221_so_processing_mode"]],
    ["tenant_settings.terms_check_mode", "42703", ["terms_check_mode"]],
    ["tenant_settings.order_handoff_enabled", "PGRST204", ["order_handoff_enabled", "handoff_recipients"]],
    ["order_term_checks", "42P01", ["250_order_terms"]],
    ["orders.handoff_status", "42703", ["251_order_handoff"]],
    ["admin_notifications.recipient_user_id", "42703", ["253_notification_recipient"]],
    ["orders.payment_terms", "42703", ["orders_payment_terms"]],
    ["order_term_checks", "PGRST205", ["250_order_terms"]],
  ])("%s (%s)", async (key, code, ids) => {
    H.missing = { [key]: code };
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.checks.filter((c) => c.status === "missing").map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(r.body.summary.missing).toBe(ids.length);
  });

  it("says warn, not ok and not missing, when a probe fails for another reason", async () => {
    H.fail = { "orders.payment_terms": "57014" };
    const r = await call();
    expect(status(r.body, "orders_payment_terms")).toBe("warn");
    expect(byId(r.body, "orders_payment_terms").reason).toMatch(/Could not probe/);
  });
});

describe("flags", () => {
  it("warns on Mode A, terms off and handoff off", async () => {
    Object.assign(H.store.tenant_settings[0], { so_processing_mode: "A", terms_check_mode: "off", order_handoff_enabled: false });
    const r = await call();
    expect([status(r.body, "so_processing_mode"), status(r.body, "terms_check_mode"), status(r.body, "order_handoff_enabled")]).toEqual(["warn", "warn", "warn"]);
  });

  it("reads Mode A and terms off when the tenant has no settings row", async () => {
    H.store.tenant_settings = [];
    const r = await call();
    expect(byId(r.body, "so_processing_mode")).toMatchObject({ status: "warn", value: "A" });
    expect(byId(r.body, "terms_check_mode")).toMatchObject({ status: "warn", value: "off" });
  });
});

describe("cron_health", () => {
  it("is missing when nothing has run the tick", async () => {
    H.store.cron_health = H.store.cron_health.filter((w) => w.worker !== "cron/tick");
    const r = await call();
    expect(status(r.body, "cron/tick")).toBe("missing");
    expect(status(r.body, "cron/daily")).toBe("ok");
  });

  it("warns when the tick is stale or the daily run failed", async () => {
    H.store.cron_health = [
      { worker: "cron/tick", last_run_at: ago(45 * MIN), last_status: "ok", consecutive_failures: 0 },
      { worker: "cron/daily", last_run_at: ago(60 * MIN), last_status: "error", consecutive_failures: 2 },
    ];
    const r = await call();
    expect(byId(r.body, "cron/tick")).toMatchObject({ status: "warn", reason: expect.stringMatching(/45 min ago\. Expected every 5 minutes/) });
    expect(byId(r.body, "cron/daily")).toMatchObject({ status: "warn", reason: expect.stringMatching(/status error, 2 failure/) });
  });

  it("warns when cron_health cannot be read", async () => {
    H.missing = { cron_health: "42P01" };
    const r = await call();
    expect([status(r.body, "cron/tick"), status(r.body, "cron/daily")]).toEqual(["warn", "warn"]);
  });
});

describe("mail, recipients and ClamAV", () => {
  it("is missing with no mail provider", async () => {
    H.mail = null;
    const r = await call();
    expect(byId(r.body, "mail_provider")).toMatchObject({ status: "missing", value: null });
  });

  it("is missing with no To list, and when no To entry resolves", async () => {
    H.store.tenant_settings[0].order_handoff_to = [];
    expect(status((await call()).body, "handoff_recipients")).toBe("missing");
    H.store.tenant_settings[0].order_handoff_to = ["role:finance"];
    const r = await call();
    expect(byId(r.body, "handoff_recipients")).toMatchObject({ status: "missing", value: { to: 0, cc: 0, dropped: 1 } });
  });

  it("warns when some entries resolve to nobody, and never returns the addresses", async () => {
    H.store.tenant_settings[0].order_handoff_cc = ["role:procurement"];
    const r = await call();
    expect(byId(r.body, "handoff_recipients")).toMatchObject({ status: "warn", value: { to: 2, cc: 0, dropped: 1 } });
    expect(JSON.stringify(r.body)).not.toMatch(/@example\.com/);
  });

  it("does not count another tenant's members as recipients", async () => {
    H.store.tenant_members = [{ tenant_id: T2, user_id: "u-op1", role: "operator", status: "approved" }];
    const r = await call();
    expect(byId(r.body, "handoff_recipients")).toMatchObject({ status: "warn", value: { to: 1, cc: 0, dropped: 1 } });
  });

  it("is missing when CLAMAV_URL is not set", async () => {
    delete process.env.CLAMAV_URL;
    const r = await call();
    expect(status(r.body, "clamav")).toBe("missing");
  });
});

describe("use in the last 7 days", () => {
  it("warns on a step nobody used, and does not count older rows", async () => {
    H.store.audit_events = [{ tenant_id: T1, action: "approve_order", created_at: ago(8 * DAY) }];
    const r = await call();
    expect(byId(r.body, "approve_order")).toMatchObject({ status: "warn", value: 0 });
  });
});
