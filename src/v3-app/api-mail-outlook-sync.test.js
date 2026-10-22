// EA-1: the Outlook mailbox sync. Request tests [13] outage and invalid
// checkpoint, [14] expired and revoked token, [16] throttling, [17] the
// cost-safety budget. Graph and the token endpoint are mocked; no live
// credentials.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb } from "./test-memory-supabase";

const H = vi.hoisted(() => {
  process.env.ANVIL_SECRETS_KEY = "a".repeat(64);
  return { db: null, respond: null, calls: [] };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));

let runEmailSync, encryptField, decryptField, syncSince, syncConnection, normalise, outlook;
beforeAll(async () => {
  ({ runEmailSync } = await import("../api/email/sync.js"));
  ({ encryptField, decryptField } = await import("../api/_lib/secrets.js"));
  ({ syncSince, syncConnection } = await import("../api/_lib/mail/sync.js"));
  outlook = await import("../api/_lib/mail/outlook.js");
  ({ normalise } = outlook);
});

const GRAPH = "https://graph.microsoft.com/v1.0";
const D_IN = GRAPH + "/me/mailFolders('inbox')/messages/delta?$deltatoken=in-1";
const D_SENT = GRAPH + "/me/mailFolders('sentitems')/messages/delta?$deltatoken=sent-1";
const HOUR = 3_600_000;

const reply = (status, body, headers = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers });
const page = (value, links) => reply(200, { value, ...links });
const msg = (id, extra = {}) => ({
  id,
  internetMessageId: "<" + id + "@mail.example>",
  conversationId: "conv-1",
  from: { emailAddress: { address: "Buyer@Customer.example", name: "Buyer" } },
  toRecipients: [{ emailAddress: { address: "rep@seller.example" } }],
  subject: "Order status",
  bodyPreview: "Please confirm",
  receivedDateTime: "2026-10-22T05:00:00Z",
  ...extra,
});

const isInboxStart = (u) => u.startsWith(GRAPH + "/me/mailFolders/inbox/messages/delta?");
const isSentStart = (u) => u.startsWith(GRAPH + "/me/mailFolders/sentitems/messages/delta?");
const graphCalls = () => H.calls.filter((c) => c.url.startsWith(GRAPH));

// The happy path for both folders; a test overrides one URL at a time.
const okRoutes = (over = {}) => (url, init) => {
  for (const [match, fn] of Object.entries(over)) if (url.startsWith(match) || url === match) return fn(url, init);
  if (isInboxStart(url) || url === D_IN) return page([msg("in-1"), msg("in-2")], { "@odata.deltaLink": D_IN });
  if (isSentStart(url) || url === D_SENT) return page([msg("out-1")], { "@odata.deltaLink": D_SENT });
  throw new Error("unexpected fetch " + url);
};

const conn = (extra = {}) => ({
  id: "m1", tenant_id: "t1", provider: "outlook", kind: "user", owner_user_id: "u1",
  address: "rep@seller.example", status: "active", checkpoint: {},
  access_token_enc: encryptField("AT1"), refresh_token_enc: encryptField("RT1"),
  token_expires_at: new Date(Date.now() + HOUR).toISOString(),
  consecutive_failures: 0, quota_errors: 0, checkpoint_resets: 0,
  requests_today: 0, requests_date: null, daily_request_budget: 1500,
  poll_interval_minutes: 5, initial_lookback_hours: 72,
  next_sync_at: null, sync_lease_until: null, last_success_at: null,
  ...extra,
});

const seed = ({ connection = conn(), enabled = true } = {}) => {
  H.db = createMemoryDb({
    tenant_settings: [{
      tenant_id: "t1", email_accountability_enabled: enabled,
      graph_tenant_id: "directory.example", graph_client_id: "client-1",
      graph_client_secret_enc: encryptField("client-secret"),
    }],
    mailbox_connections: [connection],
    tenant_members: [{ tenant_id: "t1", user_id: "admin-1", role: "admin", status: "approved" }],
    admin_notifications: [],
  });
};
const row = () => H.db.tables.mailbox_connections[0];
const alerts = () => H.db.tables.admin_notifications;

const sleeps = [];
const sync = (now = new Date()) => runEmailSync(H.db.svc(), { now, sleep: async (ms) => { sleeps.push(ms); } });

beforeEach(() => {
  H.calls = [];
  sleeps.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    H.calls.push({ url: String(url), init });
    return H.respond(String(url), init);
  }));
});

describe("Outlook sync: the happy path", () => {
  it("reads Inbox then Sent from a bounded start and saves both delta links", async () => {
    seed();
    H.respond = okRoutes();
    const now = new Date();
    const out = await sync(now);

    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ ok: true, requests: 2, stats: { inbound: 2, outbound: 1, complete: true } });
    const [inbox, sent] = graphCalls();
    expect(isInboxStart(inbox.url)).toBe(true);
    expect(isSentStart(sent.url)).toBe(true);
    const q = new URL(inbox.url).searchParams;
    expect(q.get("changeType")).toBe("created");
    expect(q.get("$filter")).toBe("receivedDateTime ge " + new Date(now.getTime() - 72 * HOUR).toISOString());
    expect(q.get("$select")).not.toMatch(/isRead/);
    expect(inbox.init.headers.Authorization).toBe("Bearer AT1");
    expect(inbox.init.headers.Prefer).toMatch(/IdType="ImmutableId"/);

    expect(row().checkpoint).toEqual({ inbox: D_IN, sent: D_SENT });
    expect(row()).toMatchObject({
      requests_today: 2, requests_date: now.toISOString().slice(0, 10),
      consecutive_failures: 0, last_success_at: now.toISOString(), sync_lease_until: null,
      next_sync_at: new Date(now.getTime() + 5 * 60_000).toISOString(),
    });
  });

  it("normalises a message: lower-case addresses, In-Reply-To and References from the MAPI properties", () => {
    const m = normalise(msg("in-9", {
      ccRecipients: [{ emailAddress: { address: "Other@Customer.example" } }],
      singleValueExtendedProperties: [
        { id: "String 0x1042", value: "<parent@mail.example>" },
        { id: "String 0x1039", value: "<root@mail.example> <parent@mail.example>" },
      ],
    }), "sent");
    expect(m).toMatchObject({
      direction: "out", from: "buyer@customer.example", to: ["rep@seller.example"], cc: ["other@customer.example"],
      inReplyTo: "<parent@mail.example>", references: ["<root@mail.example>", "<parent@mail.example>"],
      internetMessageId: "<in-9@mail.example>",
    });
  });

  it("never polls a tenant that has not turned the module on", async () => {
    seed({ enabled: false });
    H.respond = okRoutes();
    const out = await sync();
    expect(out.mailboxes).toBe(0);
    expect(H.calls).toHaveLength(0);
  });

  it("skips a mailbox another run holds, so two ticks never sync it twice", async () => {
    seed({ connection: conn({ sync_lease_until: new Date(Date.now() + 60_000).toISOString() }) });
    H.respond = okRoutes();
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "leased" });
    expect(H.calls).toHaveLength(0);
  });

  it("never sends the token to a stored checkpoint that is not a Graph mail-folder URL", async () => {
    seed({ connection: conn({ checkpoint: { inbox: "https://elsewhere.example/collect" } }) });
    H.respond = okRoutes();
    await sync();
    expect(H.calls.some((c) => c.url.includes("elsewhere.example"))).toBe(false);
    expect(isInboxStart(graphCalls()[0].url)).toBe(true);
  });
});

describe("Outlook sync: recovery [13]", () => {
  it("an outage keeps the checkpoint and backs off; the next run resumes from the checkpoint", async () => {
    seed({ connection: conn({ checkpoint: { inbox: D_IN, sent: D_SENT }, last_success_at: new Date(Date.now() - HOUR).toISOString() }) });
    H.respond = () => { throw new Error("connect ECONNREFUSED"); };
    const now = new Date();
    const out = await sync(now);

    expect(out.results[0]).toMatchObject({ ok: false, code: "transient", requests: 3 });
    expect(sleeps).toEqual([1000, 4000]);
    expect(row()).toMatchObject({
      checkpoint: { inbox: D_IN, sent: D_SENT }, consecutive_failures: 1,
      next_sync_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
    expect(row().last_error).toMatch(/^transient/);

    H.calls = [];
    H.respond = okRoutes();
    const later = new Date(now.getTime() + 11 * 60_000);
    const again = await sync(later);
    expect(again.results[0].ok).toBe(true);
    expect(graphCalls()[0].url).toBe(D_IN);
    expect(row().consecutive_failures).toBe(0);
  });

  it("an invalid checkpoint is cleared, is not a failure, and the next round starts an hour before the last success", async () => {
    const lastOk = new Date(Date.now() - 26 * HOUR).toISOString();
    seed({ connection: conn({ checkpoint: { inbox: D_IN, sent: D_SENT }, last_success_at: lastOk }) });
    H.respond = okRoutes({ [D_IN]: () => reply(410, { error: { code: "syncStateNotFound" } }) });
    const out = await sync();

    expect(out.results[0]).toMatchObject({ ok: false, code: "checkpoint" });
    expect(row().checkpoint).toEqual({ inbox: null, sent: D_SENT });
    expect(row()).toMatchObject({ checkpoint_resets: 1, consecutive_failures: 0 });
    expect(graphCalls().some((c) => c.url === D_SENT)).toBe(false);

    H.calls = [];
    H.respond = okRoutes();
    await sync(new Date(Date.now() + 1000));
    const q = new URL(graphCalls()[0].url).searchParams;
    expect(q.get("$filter")).toBe("receivedDateTime ge " + new Date(Date.parse(lastOk) - HOUR).toISOString());
    expect(row().checkpoint.inbox).toBe(D_IN);
  });

  it("recovers at most 7 days back after a long outage", () => {
    const now = new Date();
    const since = syncSince({ last_success_at: new Date(now.getTime() - 30 * 24 * HOUR).toISOString() }, now);
    expect(since).toBe(new Date(now.getTime() - 168 * HOUR).toISOString());
  });

  it("a failure on page 2 keeps page 1's checkpoint, and an unfinished Inbox does not read Sent", async () => {
    const N1 = GRAPH + "/me/mailFolders('inbox')/messages/delta?$skiptoken=p2";
    seed();
    H.respond = (url, init) => {
      if (isInboxStart(url)) return page([msg("in-1")], { "@odata.nextLink": N1 });
      if (url === N1) return reply(500, { error: { code: "ServerError" } });
      return okRoutes()(url, init);
    };
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "transient" });
    expect(row().checkpoint).toEqual({ inbox: N1 });
    expect(graphCalls().some((c) => isSentStart(c.url))).toBe(false);
  });

  it("a run out of time stops cleanly: no request, no failure, due again at once", async () => {
    seed();
    H.respond = okRoutes();
    const now = new Date();
    const out = await syncConnection(H.db.svc(), row(), {
      adapter: outlook, settings: H.db.tables.tenant_settings[0], now, deadline: Date.now() - 1, sleep: async () => {},
    });
    expect(out).toMatchObject({ ok: true, requests: 0, stats: { complete: false } });
    expect(H.calls).toHaveLength(0);
    expect(row()).toMatchObject({ consecutive_failures: 0, last_error: null, next_sync_at: now.toISOString() });
  });

  it("claims no mailbox in the last 3 seconds of the run", async () => {
    seed();
    H.respond = okRoutes();
    const out = await runEmailSync(H.db.svc(), { deadline: Date.now() + 2_000, sleep: async () => {} });
    expect(out.results).toHaveLength(0);
    expect(row().sync_lease_until).toBeNull();
  });

  it("stops after 3 pages of one folder, keeps the place, and leaves Sent for the next run", async () => {
    seed();
    let n = 0;
    H.respond = (url) => {
      if (url.includes("/mailFolders/inbox/") || url.includes("skiptoken")) {
        n += 1;
        return page([msg("in-" + n)], { "@odata.nextLink": GRAPH + "/me/mailFolders('inbox')/messages/delta?$skiptoken=p" + (n + 1) });
      }
      throw new Error("Sent must wait: " + url);
    };
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: true, requests: 3, stats: { pages: 3, complete: false } });
    expect(row().checkpoint.inbox).toMatch(/skiptoken=p4$/);
  });
});

describe("Outlook sync: tokens [14]", () => {
  it("refreshes an expired access token and stores the new tokens encrypted", async () => {
    seed({ connection: conn({ token_expires_at: new Date(Date.now() - 1000).toISOString() }) });
    H.respond = okRoutes({
      "https://login.microsoftonline.com/": () => reply(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 3600, scope: "User.Read Mail.Read" }),
    });
    const out = await sync();

    expect(out.results[0].ok).toBe(true);
    const tokenCall = H.calls.find((c) => c.url.startsWith("https://login.microsoftonline.com/directory.example/oauth2/v2.0/token"));
    const form = new URLSearchParams(tokenCall.init.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("scope")).toBe("offline_access User.Read Mail.Read");
    expect(graphCalls()[0].init.headers.Authorization).toBe("Bearer AT2");
    expect(row().access_token_enc).not.toContain("AT2");
    expect(decryptField(row().access_token_enc)).toBe("AT2");
    expect(decryptField(row().refresh_token_enc)).toBe("RT2");
  });

  it("a revoked grant marks the mailbox reauth_required, alerts the admin once, and reads no mail", async () => {
    seed({ connection: conn({ token_expires_at: new Date(Date.now() - 1000).toISOString() }) });
    H.respond = okRoutes({ "https://login.microsoftonline.com/": () => reply(400, { error: "invalid_grant" }) });
    const out = await sync();

    expect(out.results[0]).toMatchObject({ ok: false, code: "auth", alert: "reauth" });
    expect(row().status).toBe("reauth_required");
    expect(graphCalls()).toHaveLength(0);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({ kind: "mailbox_sync", object_id: "m1" });
    expect(alerts()[0].body).not.toMatch(/invalid_grant/);

    H.calls = [];
    await sync(new Date(Date.now() + 10 * 60_000));
    expect(H.calls).toHaveLength(0);
    expect(alerts()).toHaveLength(1);
  });

  it("a 401 from Graph during the sync also stops the mailbox", async () => {
    seed();
    H.respond = okRoutes({ [GRAPH + "/me/mailFolders/inbox/"]: () => reply(401, { error: { code: "InvalidAuthenticationToken" } }) });
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "auth" });
    expect(row().status).toBe("reauth_required");
    expect(graphCalls()).toHaveLength(1);
  });
});

describe("Outlook sync: throttling [16]", () => {
  it("a short Retry-After is retried at most twice, then the mailbox pauses", async () => {
    seed();
    H.respond = okRoutes({ [GRAPH + "/me/mailFolders/inbox/"]: () => reply(429, null, { "Retry-After": "2" }) });
    const now = new Date();
    const out = await sync(now);

    expect(out.results[0]).toMatchObject({ ok: false, code: "throttle", requests: 3 });
    expect(graphCalls()).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
    // The pause is at least one minute, whatever the header said.
    expect(row()).toMatchObject({
      pause_reason: "throttled", quota_errors: 1, consecutive_failures: 0, status: "active",
      paused_until: new Date(now.getTime() + 60_000).toISOString(),
      next_sync_at: new Date(now.getTime() + 60_000).toISOString(),
    });

    H.calls = [];
    await sync(new Date(now.getTime() + 30_000));
    expect(H.calls).toHaveLength(0);
  });

  it("a long Retry-After is not waited for inside the run", async () => {
    seed();
    H.respond = okRoutes({ [GRAPH + "/me/mailFolders/inbox/"]: () => reply(429, null, { "Retry-After": "120" }) });
    const now = new Date();
    const out = await sync(now);
    expect(out.results[0]).toMatchObject({ code: "throttle", requests: 1 });
    expect(sleeps).toEqual([]);
    expect(row().paused_until).toBe(new Date(now.getTime() + 120_000).toISOString());
  });

  it("a client error is not retried", async () => {
    seed();
    H.respond = okRoutes({ [GRAPH + "/me/mailFolders/inbox/"]: () => reply(404, { error: { code: "ErrorItemNotFound" } }) });
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "http", requests: 1 });
    expect(row().consecutive_failures).toBe(1);
  });
});

describe("Outlook sync: the cost-safety budget [17]", () => {
  it("a spent daily budget makes no request, pauses to 00:00 UTC, and alerts once", async () => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    seed({ connection: conn({ requests_today: 1500, requests_date: today }) });
    H.respond = okRoutes();
    const out = await sync(now);

    expect(out.results[0]).toMatchObject({ ok: false, code: "budget", requests: 0, alert: "budget" });
    expect(H.calls).toHaveLength(0);
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    expect(row()).toMatchObject({ pause_reason: "budget", paused_until: midnight.toISOString(), requests_today: 1500 });
    expect(alerts()).toHaveLength(1);

    await sync(new Date(now.getTime() + 60_000));
    expect(H.calls).toHaveLength(0);
    expect(alerts()).toHaveLength(1);

    // The next UTC day starts a fresh count.
    const tomorrow = new Date(midnight.getTime() + 60_000);
    const next = await sync(tomorrow);
    expect(next.results[0].ok).toBe(true);
    expect(row()).toMatchObject({ requests_today: 2, requests_date: tomorrow.toISOString().slice(0, 10), pause_reason: null });
  });

  it("a budget that runs out mid-run stops at the limit and keeps the finished folder", async () => {
    seed({ connection: conn({ daily_request_budget: 1 }) });
    H.respond = okRoutes();
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "budget", requests: 1 });
    expect(graphCalls()).toHaveLength(1);
    expect(row().checkpoint).toEqual({ inbox: D_IN });
    expect(row().requests_today).toBe(1);
  });

  it("alerts the admin when failures reach 3, not on every failure after that", async () => {
    seed({ connection: conn({ consecutive_failures: 2 }) });
    H.respond = okRoutes({ [GRAPH + "/me/mailFolders/inbox/"]: () => reply(404, null) });
    const first = await sync();
    expect(first.results[0].alert).toBe("failing");
    expect(alerts()).toHaveLength(1);
    const second = await sync(new Date(Date.now() + 24 * HOUR));
    expect(row().consecutive_failures).toBe(4);
    expect(second.results[0].alert).toBeNull();
    expect(alerts()).toHaveLength(1);
  });

  it("ten failures in a row pause the mailbox until a person resumes it", async () => {
    seed({ connection: conn({ consecutive_failures: 9 }) });
    H.respond = okRoutes({ [GRAPH + "/me/mailFolders/inbox/"]: () => reply(404, null) });
    const out = await sync();
    expect(out.results[0].alert).toBe("paused");
    expect(row()).toMatchObject({ status: "paused", pause_reason: "failures", consecutive_failures: 10 });
    H.calls = [];
    await sync(new Date(Date.now() + 24 * HOUR));
    expect(H.calls).toHaveLength(0);
  });
});
