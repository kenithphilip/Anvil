// EA-1: connect, list, resume and disconnect a user mailbox. The OAuth state
// binds tenant, user, provider and purpose; tokens never reach a response.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createMemoryDb, callHandler } from "./test-memory-supabase";

const H = vi.hoisted(() => {
  process.env.ANVIL_SECRETS_KEY = "b".repeat(64);
  process.env.PUBLIC_APP_URL = "https://app.example";
  return { db: null, ctx: null, respond: null };
});
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.db.svc() }));
vi.mock("../api/_lib/auth.js", async (orig) => ({ ...(await orig()), resolveContext: vi.fn(async () => H.ctx) }));

let connections, callback, verifyState, signState, encryptField, decryptField;
beforeAll(async () => {
  connections = (await import("../api/email/connections.js")).default;
  callback = (await import("../api/email/connect_callback.js")).default;
  ({ verifyState, signState } = await import("../api/_lib/graph-client.js"));
  ({ encryptField, decryptField } = await import("../api/_lib/secrets.js"));
});

const settings = () => ({
  tenant_id: "t1", email_accountability_enabled: true,
  graph_tenant_id: "directory.example", graph_client_id: "client-1",
  graph_client_secret_enc: encryptField("client-secret"),
});
const member = (user_id, role = "sales_engineer") => ({ tenant_id: "t1", user_id, role, status: "approved" });
const mailbox = (extra = {}) => ({
  id: "m1", tenant_id: "t1", provider: "outlook", owner_user_id: "u1", address: "rep@seller.example",
  status: "active", checkpoint: { inbox: "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta?$deltatoken=x" },
  access_token_enc: encryptField("AT"), refresh_token_enc: encryptField("RT"),
  created_at: "2026-10-01T00:00:00Z", ...extra,
});
const seed = (tables = {}) => {
  H.db = createMemoryDb({
    tenant_settings: [settings()],
    tenant_members: [member("u1"), member("u2"), member("admin-1", "admin")],
    mailbox_connections: [],
    audit_events: [],
    ...tables,
  }, {}, { project: true });
};
const as = (userId, role = "sales_engineer") => { H.ctx = { tenantId: "t1", user: { id: userId }, role }; };

const runCallback = async (query) => {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } };
  await callback({ method: "GET", headers: {}, query }, res);
  return { status: res.statusCode, location: res.headers.Location || "" };
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => H.respond(String(url), init)));
});

describe("POST /api/email/connections", () => {
  it("returns an authorize URL with the read-only scopes and a mailbox state for this user", async () => {
    seed();
    as("u1");
    const r = await callHandler(connections, { method: "POST", body: { provider: "outlook" } });
    expect(r.status).toBe(200);
    const url = new URL(r.body.authorize_url);
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Read");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/api/email/connect/callback");
    const state = url.searchParams.get("state");
    expect(verifyState(state, "mailbox")).toEqual({ tenantId: "t1", userId: "u1", provider: "outlook" });
    // The tenant send-connection callback refuses a mailbox state.
    expect(verifyState(state)).toBeNull();
  });

  it("refuses a viewer and an unknown provider", async () => {
    seed();
    as("v1", "viewer");
    expect((await callHandler(connections, { method: "POST", body: { provider: "outlook" } })).status).toBe(403);
    as("u1");
    expect((await callHandler(connections, { method: "POST", body: { provider: "imap" } })).status).toBe(400);
  });
});

describe("GET /api/email/connections", () => {
  it("lists only the caller's mailboxes and never a token or checkpoint", async () => {
    seed({ mailbox_connections: [mailbox(), mailbox({ id: "m2", owner_user_id: "u2", address: "other@seller.example" })] });
    as("u1");
    const r = await callHandler(connections, { method: "GET" });
    expect(r.body.mailboxes.map((m) => m.id)).toEqual(["m1"]);
    expect(r.body.providers).toEqual({ outlook: true });
    const keys = Object.keys(r.body.mailboxes[0]);
    expect(keys).not.toContain("access_token_enc");
    expect(keys).not.toContain("refresh_token_enc");
    expect(keys).not.toContain("checkpoint");
  });

  it("shows an admin every mailbox of the tenant", async () => {
    seed({ mailbox_connections: [mailbox(), mailbox({ id: "m2", owner_user_id: "u2", address: "other@seller.example" })] });
    as("admin-1", "admin");
    const r = await callHandler(connections, { method: "GET" });
    expect(r.body.mailboxes.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("PATCH and DELETE /api/email/connections", () => {
  it("another user cannot see, resume or disconnect a mailbox", async () => {
    seed({ mailbox_connections: [mailbox({ status: "paused", pause_reason: "failures" })] });
    as("u2");
    expect((await callHandler(connections, { method: "PATCH", body: { id: "m1", resume: true } })).status).toBe(404);
    expect((await callHandler(connections, { method: "DELETE", query: { id: "m1" } })).status).toBe(404);
    expect(H.db.tables.mailbox_connections[0].status).toBe("paused");
  });

  it("the owner resumes a paused mailbox; only an admin changes the limits", async () => {
    seed({ mailbox_connections: [mailbox({ status: "paused", pause_reason: "failures", consecutive_failures: 10 })] });
    as("u1");
    const r = await callHandler(connections, { method: "PATCH", body: { id: "m1", resume: true } });
    expect(r.status).toBe(200);
    expect(H.db.tables.mailbox_connections[0]).toMatchObject({ status: "active", pause_reason: null, consecutive_failures: 0 });
    expect((await callHandler(connections, { method: "PATCH", body: { id: "m1", daily_request_budget: 9000 } })).status).toBe(403);

    as("admin-1", "admin");
    expect((await callHandler(connections, { method: "PATCH", body: { id: "m1", poll_interval_minutes: 1 } })).status).toBe(400);
    expect((await callHandler(connections, { method: "PATCH", body: { id: "m1", daily_request_budget: 500 } })).status).toBe(200);
    expect(H.db.tables.mailbox_connections[0].daily_request_budget).toBe(500);
    expect(H.db.tables.audit_events.map((a) => a.action)).toEqual(["mailbox_resumed", "mailbox_limits_changed"]);
  });

  it("a resume cannot fix a mailbox that needs a new sign-in", async () => {
    seed({ mailbox_connections: [mailbox({ status: "reauth_required" })] });
    as("u1");
    expect((await callHandler(connections, { method: "PATCH", body: { id: "m1", resume: true } })).status).toBe(409);
  });

  it("disconnect deletes the tokens and the checkpoint at once", async () => {
    seed({ mailbox_connections: [mailbox()] });
    as("u1");
    expect((await callHandler(connections, { method: "DELETE", query: { id: "m1" } })).status).toBe(200);
    expect(H.db.tables.mailbox_connections[0]).toMatchObject({
      status: "disconnected", access_token_enc: null, refresh_token_enc: null, checkpoint: {}, next_sync_at: null,
    });
    expect(H.db.tables.audit_events[0]).toMatchObject({ action: "mailbox_disconnected", object_id: "m1" });
  });
});

describe("GET /api/email/connect/callback", () => {
  const graphOk = (address = "Rep@Seller.example") => (url) => {
    if (url.startsWith("https://login.microsoftonline.com/")) {
      return new Response(JSON.stringify({ access_token: "AT-new", refresh_token: "RT-new", expires_in: 3600, scope: "User.Read Mail.Read" }), { status: 200 });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      return new Response(JSON.stringify({ id: "graph-user-1", mail: address, displayName: "Rep" }), { status: 200 });
    }
    throw new Error("unexpected " + url);
  };
  const state = (userId = "u1") => signState("t1", 600_000, { k: "mailbox", u: userId, p: "outlook" });

  it("stores a new mailbox with encrypted tokens and a lower-case address", async () => {
    seed();
    H.respond = graphOk();
    const r = await runCallback({ code: "c1", state: state() });
    expect(r.location).toBe("https://app.example/#/admin?tab=communications&mailbox=connected");
    const row = H.db.tables.mailbox_connections[0];
    expect(row).toMatchObject({ provider: "outlook", owner_user_id: "u1", address: "rep@seller.example", status: "active" });
    expect(row.refresh_token_enc).not.toContain("RT-new");
    expect(decryptField(row.refresh_token_enc)).toBe("RT-new");
    expect(H.db.tables.audit_events[0]).toMatchObject({ action: "mailbox_connected", actor: "u1" });
  });

  it("refuses a state minted for the tenant send connection", async () => {
    seed();
    H.respond = graphOk();
    const r = await runCallback({ code: "c1", state: signState("t1") });
    expect(r.location).toMatch(/mailbox=invalid_state$/);
    expect(H.db.tables.mailbox_connections).toHaveLength(0);
  });

  it("refuses an address another user has connected", async () => {
    seed({ mailbox_connections: [mailbox({ owner_user_id: "u2" })] });
    H.respond = graphOk();
    const r = await runCallback({ code: "c1", state: state("u1") });
    expect(r.location).toMatch(/mailbox=address_taken$/);
    expect(H.db.tables.mailbox_connections[0].owner_user_id).toBe("u2");
    expect(decryptField(H.db.tables.mailbox_connections[0].refresh_token_enc)).toBe("RT");
  });

  it("refuses a user who has left the tenant since the state was minted", async () => {
    seed({ tenant_members: [member("admin-1", "admin")] });
    H.respond = graphOk();
    const r = await runCallback({ code: "c1", state: state("u1") });
    expect(r.location).toMatch(/mailbox=not_member$/);
  });

  it("a reconnect by the same owner keeps the checkpoint and clears the sign-in state", async () => {
    seed({ mailbox_connections: [mailbox({ status: "reauth_required", consecutive_failures: 4 })] });
    H.respond = graphOk();
    await runCallback({ code: "c1", state: state("u1") });
    const row = H.db.tables.mailbox_connections[0];
    expect(row).toMatchObject({ status: "active", consecutive_failures: 0 });
    expect(row.checkpoint.inbox).toMatch(/deltatoken=x$/);
    expect(decryptField(row.access_token_enc)).toBe("AT-new");
  });

  it("never connects without a refresh token", async () => {
    seed();
    H.respond = (url) => {
      if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
      throw new Error("unexpected " + url);
    };
    const r = await runCallback({ code: "c1", state: state() });
    expect(r.location).toMatch(/mailbox=no_refresh_token$/);
    expect(H.db.tables.mailbox_connections).toHaveLength(0);
  });
});
