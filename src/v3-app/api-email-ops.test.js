// EA-8: operations. The onboarding reply check, the health and cost view,
// the content purge, and request test [17] end to end: the cost-safety
// budget stops further requests, alerts the admin, and the health view
// shows it. Providers are mocked; no live credentials.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => {
  process.env.ANVIL_SECRETS_KEY = "f".repeat(64);
  process.env.CRON_SECRET = "cron-secret";
  return { db: null, ctx: null, respond: null, calls: [] };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));

let replyHeaderReport, purgeContent, checkApi, healthApi, purgeApi, runEmailSync, encryptField;
beforeAll(async () => {
  ({ replyHeaderReport } = await import("../api/_lib/email-accountability/onboarding.js"));
  ({ purgeContent } = await import("../api/_lib/email-accountability/retention.js"));
  checkApi = (await import("../api/email/check.js")).default;
  healthApi = (await import("../api/email/health.js")).default;
  purgeApi = (await import("../api/email/purge.js")).default;
  ({ runEmailSync } = await import("../api/email/sync.js"));
  ({ encryptField } = await import("../api/_lib/secrets.js"));
});

const GRAPH = "https://graph.microsoft.com/v1.0";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const HOUR = 3_600_000;
const root = Buffer.alloc(22, 4).toString("base64");
const child = Buffer.concat([Buffer.alloc(22, 4), Buffer.alloc(5, 1)]).toString("base64");
const reply = (status, body) => new Response(body == null ? null : JSON.stringify(body), { status });

const conn = (extra = {}) => ({
  id: "m1", tenant_id: "t1", provider: "outlook", owner_user_id: "u1", address: "rep@seller.example",
  status: "active", checkpoint: {}, access_token_enc: encryptField("AT"), refresh_token_enc: encryptField("RT"),
  token_expires_at: new Date(Date.now() + HOUR).toISOString(), consecutive_failures: 0, quota_errors: 0,
  checkpoint_resets: 0, requests_today: 0, requests_date: null, daily_request_budget: 1500,
  poll_interval_minutes: 5, initial_lookback_hours: 72, next_sync_at: null, sync_lease_until: null, last_sync_stats: {},
  ...extra,
});

const seed = (tables = {}) => {
  H.db = createMemoryDb({
    tenant_settings: [{
      tenant_id: "t1", email_accountability_enabled: true, email_actions_mode: "observe", email_content_retention_days: 30,
      graph_tenant_id: "directory.example", graph_client_id: "client-1", graph_client_secret_enc: encryptField("s"),
      google_oauth_client_id: "1-x.apps.googleusercontent.com", google_oauth_client_secret_enc: encryptField("g"),
    }],
    mailbox_connections: [conn()],
    tenant_members: [{ tenant_id: "t1", user_id: "adm", role: "admin", status: "approved" }],
    admin_notifications: [], audit_events: [], cron_health: [], email_action_evidence: [], email_action_notices: [], work_items: [], email_actions: [],
    ...tables,
  }, {}, { project: true });
};
const as = (id, role) => { H.ctx = { tenantId: "t1", user: { id }, role }; };
const row = () => H.db.tables.mailbox_connections[0];

beforeEach(() => {
  H.calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    H.calls.push(String(url));
    return H.respond(String(url), init);
  }));
});

describe("the reply-header report", () => {
  const m = (subject, extra = {}) => ({ subject, inReplyTo: null, references: [], conversationIndex: null, ...extra });
  it("headers on every reply: headers_ok", () => {
    const r = replyHeaderReport("outlook", [m("RE: order", { inReplyTo: "<a@x>" }), m("New quote")]);
    expect(r).toMatchObject({ sampled: 2, replies: 1, with_headers: 1, verdict: "headers_ok" });
  });
  it("headers on only some replies is not ok", () => {
    expect(replyHeaderReport("gmail", [m("Re: a", { inReplyTo: "<a@x>" }), m("Re: b")]).verdict).toBe("headers_missing");
  });

  it("Outlook with no headers but an index step on every reply: index_only", () => {
    expect(replyHeaderReport("outlook", [m("RE: order", { conversationIndex: child })]).verdict).toBe("index_only");
    expect(replyHeaderReport("outlook", [m("RE: order", { conversationIndex: root })]).verdict).toBe("headers_missing");
  });
  it("Gmail never counts an index; no replies in the sample says so", () => {
    expect(replyHeaderReport("gmail", [m("Re: order", { conversationIndex: child })])).toMatchObject({ verdict: "headers_missing", with_index: 0 });
    expect(replyHeaderReport("gmail", [m("Re: order", { references: ["<a@x>"] })]).verdict).toBe("headers_ok");
    expect(replyHeaderReport("gmail", [m("Weekly update")]).verdict).toBe("no_replies_in_sample");
  });
});

describe("POST /api/email/check", () => {
  it("Outlook: reads the newest sent items once and reports; the request counts against the budget; audited", async () => {
    seed();
    as("u1", "sales_engineer");
    H.respond = (url) => {
      expect(url.startsWith(GRAPH + "/me/mailFolders/sentitems/messages?")).toBe(true);
      return reply(200, { value: [
        { id: "s1", subject: "RE: order 4501", conversationIndex: child, singleValueExtendedProperties: [{ id: "String 0x1042", value: "<po@x>" }] },
        { id: "s2", subject: "Quote attached" },
      ] });
    };
    const r = await callHandler(checkApi, { method: "POST", body: { id: "m1" } });
    expect(r.status).toBe(200);
    expect(r.body.report).toMatchObject({ verdict: "headers_ok", replies: 1, with_headers: 1, with_index: 1 });
    expect(new URL(H.calls[0]).searchParams.get("$expand")).toMatch(/String 0x1042/);
    expect(row().requests_today).toBe(1);
    expect(H.db.tables.audit_events[0]).toMatchObject({ action: "mailbox_reply_check", object_id: "m1" });
  });

  it("Gmail: lists SENT and reads each one as metadata", async () => {
    seed({ mailbox_connections: [conn({ provider: "gmail" })] });
    as("u1", "sales_engineer");
    H.respond = (url) => {
      if (url.startsWith(GMAIL + "/messages?")) return reply(200, { messages: [{ id: "g1" }] });
      if (url.startsWith(GMAIL + "/messages/g1?")) {
        expect(url).toContain("format=metadata");
        return reply(200, { id: "g1", labelIds: ["SENT"], payload: { headers: [{ name: "Subject", value: "Re: order" }, { name: "In-Reply-To", value: "<po@x>" }] } });
      }
      throw new Error("unexpected " + url);
    };
    const r = await callHandler(checkApi, { method: "POST", body: { id: "m1" } });
    expect(r.body.report).toMatchObject({ provider: "gmail", verdict: "headers_ok" });
    expect(row().requests_today).toBe(2);
  });

  it("another user's mailbox is 404; a mailbox that needs a sign-in is 409; a spent budget is 429 with no request", async () => {
    seed();
    as("u2", "sales_engineer");
    expect((await callHandler(checkApi, { method: "POST", body: { id: "m1" } })).status).toBe(404);
    seed({ mailbox_connections: [conn({ status: "reauth_required" })] });
    as("u1", "sales_engineer");
    expect((await callHandler(checkApi, { method: "POST", body: { id: "m1" } })).status).toBe(409);
    seed({ mailbox_connections: [conn({ requests_today: 1500, requests_date: new Date().toISOString().slice(0, 10) })] });
    H.respond = () => { throw new Error("no request may be made"); };
    expect((await callHandler(checkApi, { method: "POST", body: { id: "m1" } })).status).toBe(429);
    expect(H.calls).toHaveLength(0);
  });
});

describe("GET /api/email/health", () => {
  it("is for email.rules only", async () => {
    seed();
    as("mgr", "sales_manager");
    expect((await callHandler(healthApi, { method: "GET" })).status).toBe(403);
  });

  it("totals the mailboxes, the waiting evidence, failed notices, states, schedulers and the policy; no token", async () => {
    const today = new Date().toISOString().slice(0, 10);
    seed({
      mailbox_connections: [
        conn({ requests_today: 40, requests_date: today, last_sync_stats: { would_create: 3, would_verify: 1 } }),
        conn({ id: "m2", address: "rep2@seller.example", status: "reauth_required" }),
        conn({ id: "m3", address: "rep3@seller.example", pause_reason: "budget", quota_errors: 2, requests_today: 900, requests_date: "2000-01-01" }),
      ],
      email_action_evidence: [{ id: "e1", tenant_id: "t1", status: "ambiguous" }, { id: "e2", tenant_id: "t1", status: "verified" }, { id: "e3", tenant_id: "t2", status: "claimed" }],
      email_action_notices: [{ id: "n1", tenant_id: "t1", status: "failed" }, { id: "n2", tenant_id: "t1", status: "sent" }],
      work_items: [{ id: "w1", tenant_id: "t1", subject_type: "email_action", status: "pending" }, { id: "w2", tenant_id: "t1", subject_type: "email_action", status: "performed" }, { id: "w3", tenant_id: "t1", subject_type: "order", status: "x" }],
      cron_health: [{ worker: "email/sync", last_run_at: new Date().toISOString(), last_status: "ok", consecutive_failures: 0 }, { worker: "other/job", last_run_at: "x" }],
    });
    as("adm", "admin");
    const r = await callHandler(healthApi, { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body.totals).toMatchObject({ mailboxes: 3, active: 1, paused: 1, reauth_required: 1, requests_today: 40, budget_today: 4500, quota_errors: 2 });
    expect(r.body).toMatchObject({ waiting_for_a_person: 1, failed_notices: 1, actions_by_status: { pending: 1, performed: 1 } });
    expect(r.body.last_sync_counts).toMatchObject({ would_create: 3, would_verify: 1 });
    expect(r.body.crons.map((c) => c.worker)).toEqual(["email/sync"]);
    expect(r.body.policy.due_minutes.critical).toBe(240);
    expect(JSON.stringify(r.body)).not.toMatch(/token_enc|checkpoint"/);
  });
});

describe("content purge", () => {
  const ea = (id, created, extra = {}) => ({ id, tenant_id: "t1", preview: "Please confirm the price", created_at: created, content_purged_at: null, subject: "Order", ...extra });
  it("clears the preview past retention, keeps the subject, and leaves newer and purged rows alone", async () => {
    const now = new Date("2026-10-26T00:00:00Z");
    seed({ email_actions: [
      ea("old", "2026-09-01T00:00:00Z"),
      ea("new", "2026-10-20T00:00:00Z"),
      ea("done", "2026-08-01T00:00:00Z", { preview: null, content_purged_at: "2026-09-01T00:00:00Z" }),
      ea("other", "2026-08-01T00:00:00Z", { tenant_id: "t2" }),
    ] });
    const out = await purgeContent(H.db.svc(), { now });
    expect(out.results[0]).toMatchObject({ retention_days: 30, purged: 1 });
    const byId = Object.fromEntries(H.db.tables.email_actions.map((r) => [r.id, r]));
    expect(byId.old).toMatchObject({ preview: null, content_purged_at: now.toISOString(), subject: "Order" });
    expect(byId.new.preview).toBe("Please confirm the price");
    expect(byId.done.content_purged_at).toBe("2026-09-01T00:00:00Z");
    expect(byId.other.preview).toBe("Please confirm the price");
  });

  it("a tenant's own retention applies; the cron endpoint needs the secret", async () => {
    seed({ email_actions: [ea("a", "2026-10-20T00:00:00Z")] });
    H.db.tables.tenant_settings[0].email_content_retention_days = 3;
    const out = await purgeContent(H.db.svc(), { now: new Date("2026-10-26T00:00:00Z") });
    expect(out.results[0].purged).toBe(1);
    const res = await callHandler(purgeApi, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe("[17] the cost-safety threshold, end to end", () => {
  it("a small budget stops the sync at the limit, alerts the admin once, makes no further request, and health shows it", async () => {
    seed({ mailbox_connections: [conn({ daily_request_budget: 3 })] });
    let n = 0;
    H.respond = (url) => {
      n += 1;
      if (url.includes("/mailFolders/inbox/") || url.includes("skiptoken")) {
        return reply(200, { value: [], "@odata.nextLink": GRAPH + "/me/mailFolders('inbox')/messages/delta?$skiptoken=p" + n });
      }
      return reply(200, { value: [], "@odata.deltaLink": GRAPH + "/me/mailFolders('sentitems')/messages/delta?$deltatoken=1" });
    };
    const now = new Date();
    await runEmailSync(H.db.svc(), { now, sleep: async () => {} });
    // Run 1 makes 3 requests (the page cap) and is due again at once. Run 2
    // has no budget left: it makes no request, pauses and alerts.
    await runEmailSync(H.db.svc(), { now, sleep: async () => {} });
    expect(H.calls).toHaveLength(3);
    expect(row()).toMatchObject({ requests_today: 3, pause_reason: "budget" });
    expect(H.db.tables.admin_notifications).toHaveLength(1);

    await runEmailSync(H.db.svc(), { now: new Date(now.getTime() + 60_000), sleep: async () => {} });
    expect(H.calls).toHaveLength(3);
    expect(H.db.tables.admin_notifications).toHaveLength(1);

    as("adm", "admin");
    const h = await callHandler(healthApi, { method: "GET" });
    expect(h.body.totals).toMatchObject({ paused: 1, requests_today: 3, budget_today: 3 });
  });
});
