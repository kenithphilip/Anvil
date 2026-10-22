// EA-2: the Gmail mailbox sync. Request tests [13], [14], [16] and [17] for
// Gmail. The Gmail API and Google's token endpoint are mocked; no live
// credentials.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => {
  process.env.ANVIL_SECRETS_KEY = "c".repeat(64);
  process.env.PUBLIC_APP_URL = "https://app.example";
  return { db: null, ctx: null, respond: null, calls: [] };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));

let runEmailSync, encryptField, decryptField, normalise, connections, callback, googleApp, signState;
beforeAll(async () => {
  ({ runEmailSync } = await import("../api/email/sync.js"));
  ({ encryptField, decryptField } = await import("../api/_lib/secrets.js"));
  ({ normalise } = await import("../api/_lib/mail/gmail.js"));
  connections = (await import("../api/email/connections.js")).default;
  callback = (await import("../api/email/connect_callback.js")).default;
  googleApp = (await import("../api/email/google_app.js")).default;
  ({ signState } = await import("../api/_lib/graph-client.js"));
});

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN = "https://oauth2.googleapis.com/token";
const HOUR = 3_600_000;

const reply = (status, body, headers = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers });
const gmsg = (id, labels = ["INBOX"], extra = {}) => ({
  id, threadId: "thread-1", labelIds: labels, snippet: "Please confirm the PO &amp; dates",
  internalDate: String(Date.parse("2026-10-22T05:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "Message-ID", value: "<" + id + "@mail.example>" },
      { name: "From", value: '"Buyer" <Buyer@Customer.example>' },
      { name: "To", value: "rep@seller.example, Other <other@seller.example>" },
      { name: "Subject", value: "PO 4501" },
      { name: "Date", value: "Wed, 22 Oct 2026 10:30:00 +0530" },
      ...(extra.headers || []),
    ],
  },
  ...extra.message,
});

const isGet = (u) => u.startsWith(API + "/messages/") && u.includes("format=metadata");
const idOf = (u) => decodeURIComponent(u.slice((API + "/messages/").length).split("?")[0]);
const mailCalls = () => H.calls.filter((c) => c.url.startsWith(API));

const conn = (extra = {}) => ({
  id: "g1", tenant_id: "t1", provider: "gmail", kind: "user", owner_user_id: "u1",
  address: "rep@seller.example", status: "active", checkpoint: {},
  access_token_enc: encryptField("GAT1"), refresh_token_enc: encryptField("GRT1"),
  token_expires_at: new Date(Date.now() + HOUR).toISOString(),
  consecutive_failures: 0, quota_errors: 0, checkpoint_resets: 0,
  requests_today: 0, requests_date: null, daily_request_budget: 1500,
  poll_interval_minutes: 5, initial_lookback_hours: 72,
  next_sync_at: null, sync_lease_until: null, last_success_at: null,
  ...extra,
});
const settings = () => ({
  tenant_id: "t1", email_accountability_enabled: true,
  google_oauth_client_id: "123-abc.apps.googleusercontent.com",
  google_oauth_client_secret_enc: encryptField("google-secret"),
});
const seed = (connection = conn(), more = {}) => {
  H.db = createMemoryDb({
    tenant_settings: [settings()],
    mailbox_connections: connection ? [connection] : [],
    tenant_members: [
      { tenant_id: "t1", user_id: "admin-1", role: "admin", status: "approved" },
      { tenant_id: "t1", user_id: "u1", role: "sales_engineer", status: "approved" },
    ],
    admin_notifications: [],
    audit_events: [],
    ...more,
  }, {}, { project: true });
};
const row = () => H.db.tables.mailbox_connections[0];
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

describe("Gmail sync: first sync and history", () => {
  it("first sync: the historyId before the list, then a bounded list of Inbox and Sent, metadata only", async () => {
    seed();
    H.respond = (url) => {
      if (url === API + "/profile") return reply(200, { emailAddress: "rep@seller.example", historyId: "900" });
      if (url.startsWith(API + "/messages?")) return reply(200, { messages: [{ id: "a1" }, { id: "s1" }] });
      if (isGet(url)) return reply(200, idOf(url) === "s1" ? gmsg("s1", ["SENT"]) : gmsg("a1"));
      throw new Error("unexpected " + url);
    };
    const now = new Date();
    const out = await sync(now);

    expect(out.results[0]).toMatchObject({ ok: true, requests: 4, stats: { inbound: 1, outbound: 1, complete: true } });
    const list = new URL(mailCalls()[1].url).searchParams;
    const since = Math.floor((now.getTime() - 72 * HOUR) / 1000);
    expect(list.get("q")).toBe("after:" + since + " (in:inbox OR in:sent)");
    expect(mailCalls().filter((c) => isGet(c.url))).toHaveLength(2);
    expect(mailCalls().every((c) => !c.url.includes("format=full") && !c.url.includes("format=raw"))).toBe(true);
    expect(row().checkpoint).toEqual({ all: { historyId: "900" } });
  });

  it("normalises headers, labels and the snippet", () => {
    const m = normalise(gmsg("s9", ["SENT"], { headers: [
      { name: "In-Reply-To", value: "<parent@mail.example>" },
      { name: "References", value: "<root@mail.example>\r\n <parent@mail.example>" },
      { name: "Cc", value: "Finance <Finance@Seller.example>" },
    ] }), "rep@seller.example");
    expect(m).toMatchObject({
      provider: "gmail", direction: "out", conversationId: "thread-1",
      internetMessageId: "<s9@mail.example>", inReplyTo: "<parent@mail.example>",
      references: ["<root@mail.example>", "<parent@mail.example>"],
      from: "buyer@customer.example", fromName: "Buyer",
      to: ["rep@seller.example", "other@seller.example"], cc: ["finance@seller.example"],
      preview: "Please confirm the PO & dates",
      sentAt: "2026-10-22T05:00:00.000Z", receivedAt: "2026-10-22T05:00:00.000Z",
      hasAttachments: false,
    });
    expect(m.webLink).toBe("https://mail.google.com/mail/?authuser=rep%40seller.example#all/s9");
  });

  it("history: fetches only Inbox and Sent messages and moves the historyId", async () => {
    seed(conn({ checkpoint: { all: { historyId: "900" } } }));
    H.respond = (url) => {
      if (url.startsWith(API + "/history?")) {
        return reply(200, {
          historyId: "955",
          history: [
            { messagesAdded: [{ message: { id: "n1", labelIds: ["INBOX", "UNREAD"] } }] },
            { messagesAdded: [{ message: { id: "d1", labelIds: ["DRAFT"] } }] },
            { messagesAdded: [{ message: { id: "s2", labelIds: ["SENT"] } }, { message: { id: "n1", labelIds: ["INBOX"] } }] },
          ],
        });
      }
      if (isGet(url)) return reply(200, gmsg(idOf(url), idOf(url) === "s2" ? ["SENT"] : ["INBOX"]));
      throw new Error("unexpected " + url);
    };
    const out = await sync();
    expect(new URL(mailCalls()[0].url).searchParams.get("startHistoryId")).toBe("900");
    expect(mailCalls().filter((c) => isGet(c.url)).map((c) => idOf(c.url))).toEqual(["n1", "s2"]);
    expect(out.results[0].stats).toMatchObject({ inbound: 1, outbound: 1 });
    expect(row().checkpoint).toEqual({ all: { historyId: "955" } });
  });

  it("a message deleted after the history read is skipped, not a failure", async () => {
    seed(conn({ checkpoint: { all: { historyId: "900" } } }));
    H.respond = (url) => {
      if (url.startsWith(API + "/history?")) return reply(200, { historyId: "901", history: [{ messagesAdded: [{ message: { id: "x1", labelIds: ["INBOX"] } }] }] });
      if (isGet(url)) return reply(404, { error: { code: 404, message: "Requested entity was not found." } });
      throw new Error("unexpected " + url);
    };
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: true, stats: { inbound: 0 } });
    expect(row().consecutive_failures).toBe(0);
    expect(row().checkpoint).toEqual({ all: { historyId: "901" } });
  });
});

describe("Gmail sync: recovery [13]", () => {
  it("an invalid historyId is cleared; the next run lists again from an hour before the last success", async () => {
    const lastOk = new Date(Date.now() - 30 * HOUR).toISOString();
    seed(conn({ checkpoint: { all: { historyId: "12" } }, last_success_at: lastOk }));
    H.respond = (url) => {
      if (url.startsWith(API + "/history?")) return reply(404, { error: { code: 404 } });
      throw new Error("unexpected " + url);
    };
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "checkpoint" });
    expect(row()).toMatchObject({ checkpoint: { all: null }, checkpoint_resets: 1, consecutive_failures: 0 });

    H.calls = [];
    H.respond = (url) => {
      if (url === API + "/profile") return reply(200, { historyId: "990" });
      if (url.startsWith(API + "/messages?")) return reply(200, { resultSizeEstimate: 0 });
      throw new Error("unexpected " + url);
    };
    await sync(new Date(Date.now() + 1000));
    const q = new URL(mailCalls()[1].url).searchParams.get("q");
    expect(q).toBe("after:" + Math.floor((Date.parse(lastOk) - HOUR) / 1000) + " (in:inbox OR in:sent)");
    expect(row().checkpoint).toEqual({ all: { historyId: "990" } });
  });

  it("a long first list continues on the next page with the same historyId", async () => {
    seed();
    H.respond = (url) => {
      if (url === API + "/profile") return reply(200, { historyId: "700" });
      if (url.startsWith(API + "/messages?")) {
        const pt = new URL(url).searchParams.get("pageToken");
        return reply(200, pt === "p2" ? { messages: [{ id: "b" }] } : { messages: [{ id: "a" }], nextPageToken: "p2" });
      }
      if (isGet(url)) return reply(200, gmsg(idOf(url)));
      throw new Error("unexpected " + url);
    };
    await sync();
    expect(mailCalls().filter((c) => c.url === API + "/profile")).toHaveLength(1);
    expect(row().checkpoint).toEqual({ all: { historyId: "700" } });
  });
});

describe("Gmail sync: tokens [14]", () => {
  it("refreshes with Google's token endpoint and keeps the refresh token Google did not rotate", async () => {
    seed(conn({ token_expires_at: new Date(Date.now() - 1000).toISOString(), checkpoint: { all: { historyId: "900" } } }));
    H.respond = (url) => {
      if (url === TOKEN) return reply(200, { access_token: "GAT2", expires_in: 3599, scope: "https://www.googleapis.com/auth/gmail.readonly" });
      if (url.startsWith(API + "/history?")) return reply(200, { historyId: "900" });
      throw new Error("unexpected " + url);
    };
    const out = await sync();
    expect(out.results[0].ok).toBe(true);
    const form = new URLSearchParams(H.calls[0].init.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_secret")).toBe("google-secret");
    expect(mailCalls()[0].init.headers.Authorization).toBe("Bearer GAT2");
    expect(decryptField(row().access_token_enc)).toBe("GAT2");
    expect(decryptField(row().refresh_token_enc)).toBe("GRT1");
  });

  it("a revoked grant marks the mailbox reauth_required and reads no mail", async () => {
    seed(conn({ token_expires_at: new Date(Date.now() - 1000).toISOString() }));
    H.respond = (url) => {
      if (url === TOKEN) return reply(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      throw new Error("unexpected " + url);
    };
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "auth", alert: "reauth" });
    expect(row().status).toBe("reauth_required");
    expect(mailCalls()).toHaveLength(0);
    expect(H.db.tables.admin_notifications[0].body).not.toMatch(/revoked/);
  });

  it("a 403 that is not a rate or quota limit is an access problem", async () => {
    seed(conn({ checkpoint: { all: { historyId: "900" } } }));
    H.respond = () => reply(403, { error: { errors: [{ reason: "insufficientPermissions" }] } });
    const out = await sync();
    expect(out.results[0].code).toBe("auth");
    expect(row().status).toBe("reauth_required");
  });
});

describe("Gmail sync: throttling and quota [16] [17]", () => {
  it("rateLimitExceeded is retried at most twice, then the mailbox pauses", async () => {
    seed(conn({ checkpoint: { all: { historyId: "900" } } }));
    H.respond = () => reply(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } });
    const out = await sync();
    expect(out.results[0]).toMatchObject({ code: "throttle", requests: 3 });
    expect(sleeps).toEqual([1000, 4000]);
    expect(row()).toMatchObject({ pause_reason: "throttled", status: "active" });
  });

  it("dailyLimitExceeded pauses to 00:00 UTC without a retry, and alerts", async () => {
    seed(conn({ checkpoint: { all: { historyId: "900" } } }));
    H.respond = () => reply(403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } });
    const now = new Date();
    const out = await sync(now);
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    expect(out.results[0]).toMatchObject({ code: "quota", requests: 1, alert: "quota" });
    expect(row()).toMatchObject({ pause_reason: "quota", paused_until: midnight.toISOString(), quota_errors: 1 });
  });

  it("the budget stops inside a page; the page is not marked done", async () => {
    seed(conn({ checkpoint: { all: { historyId: "900" } }, daily_request_budget: 3 }));
    H.respond = (url) => {
      if (url.startsWith(API + "/history?")) {
        return reply(200, { historyId: "999", history: ["m1", "m2", "m3"].map((id) => ({ messagesAdded: [{ message: { id, labelIds: ["INBOX"] } }] })) });
      }
      if (isGet(url)) return reply(200, gmsg(idOf(url)));
      throw new Error("unexpected " + url);
    };
    const out = await sync();
    expect(out.results[0]).toMatchObject({ ok: false, code: "budget", requests: 3 });
    expect(mailCalls()).toHaveLength(3);
    expect(row().checkpoint).toEqual({ all: { historyId: "900" } });
    expect(row().requests_today).toBe(3);
  });
});

describe("Gmail connect", () => {
  const runCallback = async (query) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } };
    await callback({ method: "GET", headers: {}, query }, res);
    return res.headers.Location || "";
  };

  it("the authorize URL asks for gmail.readonly only, offline, with consent", async () => {
    seed(null);
    H.ctx = { tenantId: "t1", user: { id: "u1" }, role: "sales_engineer" };
    const r = await callHandler(connections, { method: "POST", body: { provider: "gmail" } });
    const url = new URL(r.body.authorize_url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("client_id")).toBe("123-abc.apps.googleusercontent.com");
  });

  it("the callback stores a Gmail mailbox under the address from the profile", async () => {
    seed(null);
    H.respond = (url) => {
      if (url === TOKEN) return reply(200, { access_token: "GAT", refresh_token: "GRT", expires_in: 3599 });
      if (url === API + "/profile") return reply(200, { emailAddress: "Rep@Seller.example", historyId: "5" });
      throw new Error("unexpected " + url);
    };
    const loc = await runCallback({ code: "c", state: signState("t1", 600_000, { k: "mailbox", u: "u1", p: "gmail" }) });
    expect(loc).toMatch(/mailbox=connected$/);
    expect(row()).toMatchObject({ provider: "gmail", address: "rep@seller.example", owner_user_id: "u1", scopes: ["https://www.googleapis.com/auth/gmail.readonly"] });
    expect(decryptField(row().refresh_token_enc)).toBe("GRT");
  });
});

describe("/api/email/google_app", () => {
  it("admin only; stores the secret encrypted and never returns it", async () => {
    seed(null, { tenant_settings: [{ tenant_id: "t1" }] });
    H.ctx = { tenantId: "t1", user: { id: "u1" }, role: "sales_manager" };
    expect((await callHandler(googleApp, { method: "GET" })).status).toBe(403);

    H.ctx = { tenantId: "t1", user: { id: "admin-1" }, role: "admin" };
    expect((await callHandler(googleApp, { method: "PUT", body: { client_id: "not-a-google-id", client_secret: "s" } })).status).toBe(400);
    const put = await callHandler(googleApp, { method: "PUT", body: { client_id: "999-x.apps.googleusercontent.com", client_secret: "top-secret" } });
    expect(put.status).toBe(200);
    const s = H.db.tables.tenant_settings[0];
    expect(s.google_oauth_client_secret_enc).not.toContain("top-secret");
    expect(decryptField(s.google_oauth_client_secret_enc)).toBe("top-secret");

    const get = await callHandler(googleApp, { method: "GET" });
    expect(get.body).toEqual({ ok: true, configured: true, client_id: "999-x.apps.googleusercontent.com", redirect_uri: "https://app.example/api/email/connect/callback" });
    expect(H.db.tables.audit_events[0]).toMatchObject({ action: "google_app_configured" });
  });
});
