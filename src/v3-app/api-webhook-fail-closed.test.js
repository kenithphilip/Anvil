// Regression tests for SO-processing audit #16: the inbound chat webhooks and
// their config endpoint must FAIL CLOSED — an active channel with no verification
// secret must not accept forged/unsigned inbound (and must not be creatable).

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT = "00000000-0000-0000-0000-0000000000aa";

// ── in-memory supabase shim ──────────────────────────────────────────
let tables;
const makeSvc = () => ({
  from(table) {
    const ds = tables[table] || (tables[table] = []);
    let rows = [...ds];
    let mode = "select"; let payload = null; let single = false;
    const b = {
      select: () => b,
      eq: (c, v) => { rows = rows.filter((r) => String(r[c]) === String(v)); return b; },
      in: () => b, or: () => b, order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return b; },
      single: () => { single = true; return b; },
      update: (patch) => { mode = "update"; payload = patch; return b; },
      insert: (row) => { mode = "insert"; payload = row; return b; },
      upsert: (row) => { mode = "upsert"; payload = row; return b; },
      then: (fn) => Promise.resolve(fn(terminal())),
    };
    const terminal = () => {
      if (mode === "update") { for (const r of rows) Object.assign(r, payload); return { data: single ? rows[0] || null : rows, error: null }; }
      if (mode === "insert" || mode === "upsert") { const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id || "id-" + (ds.length + 1), ...r })); ds.push(...arr); return { data: single ? arr[0] : arr, error: null }; }
      return { data: single ? rows[0] || null : rows, error: null };
    };
    return b;
  },
});

vi.mock("../api/_lib/cors.js", () => ({
  applyCors: () => {}, handlePreflight: () => false,
  readBody: async (req) => req._body,
  json: (res, status, body) => { res._status = status; res._json = body; return res; },
  sendError: (res, err) => { res._status = err.status || 500; res._json = { error: { message: err.message } }; return res; },
}));
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => makeSvc() }));
vi.mock("../api/_lib/audit.js", () => ({ recordAudit: async () => {}, recordEvent: async () => {} }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: async () => ({ tenantId: TENANT, user: { id: "u1" }, role: "admin" }),
  requirePermission: () => {},
}));

const ingest = vi.fn(async () => ({ id: "m1" }));
vi.mock("../api/_lib/inbound-chat.js", () => ({
  decryptChatCreds: (c) => (c && c.creds_plain) || {},
  encryptChatCreds: (_ch, creds) => ({ creds_plain: creds, creds_enc: null, creds_iv: null }),
  ingestInboundMessage: (...a) => ingest(...a),
  verifySlackSignature: () => true,   // signature itself is valid; the SECRET presence is what we test
}));
vi.mock("../api/_lib/sanitize.js", () => ({ isAlphaNumDashUnderscore: () => true, timingSafeEqual: () => true }));

import slack from "../api/inbound/slack/webhook.js";
import configure from "../api/inbound/chat/configure.js";

const slackReq = (payload, headers = {}) => {
  const raw = JSON.stringify(payload);
  return {
    method: "POST", url: "/api/inbound/slack/webhook", headers,
    setEncoding() {},
    on(ev, cb) { if (ev === "data") cb(raw); if (ev === "end") cb(); return this; },
  };
};
const run = async (handler, req) => { const res = { setHeader() {}, _status: 0, _json: null }; await handler(req, res); return res; };

beforeEach(() => { tables = {}; ingest.mockClear(); });

describe("slack webhook fails closed", () => {
  const EVENT = { type: "event_callback", team_id: "T1", event: { type: "message", user: "U1", text: "PO 500 units", ts: "9.9" } };

  it("rejects (403) a matched config that has NO signing secret, and does NOT ingest", async () => {
    tables.inbound_chat_configs = [{ tenant_id: TENANT, channel: "slack", active: true, creds_plain: { team_id: "T1" } }];
    const res = await run(slack, slackReq(EVENT));
    expect(res._status).toBe(403);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("still ingests (200) when the signing secret IS configured and the signature verifies", async () => {
    tables.inbound_chat_configs = [{ tenant_id: TENANT, channel: "slack", active: true, creds_plain: { team_id: "T1", signing_secret: "shh" } }];
    const res = await run(slack, slackReq(EVENT));
    expect(res._status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
  });
});

describe("chat/configure enforces the secret on active webhook channels", () => {
  const post = (body) => run(configure, { method: "POST", query: {}, _body: body });

  it("rejects an active slack config with no signing_secret", async () => {
    const res = await post({ channel: "slack", active: true, creds: { team_id: "T1" } });
    expect(res._status).toBe(400);
  });
  it("rejects an active whatsapp config with no auth_token, and teams with no webhook_secret", async () => {
    expect((await post({ channel: "whatsapp", active: true, creds: { from_number: "+1" } }))._status).toBe(400);
    expect((await post({ channel: "teams", active: true, creds: { app_id: "x" } }))._status).toBe(400);
  });
  it("accepts an active slack config WITH a signing_secret", async () => {
    const res = await post({ channel: "slack", active: true, creds: { team_id: "T1", signing_secret: "shh" } });
    expect(res._status).toBe(200);
  });
  it("allows an INACTIVE config without a secret (it accepts no traffic)", async () => {
    const res = await post({ channel: "slack", active: false, creds: { team_id: "T1" } });
    expect(res._status).toBe(200);
  });
  it("leaves wechat unconstrained (no inbound webhook)", async () => {
    const res = await post({ channel: "wechat", active: true, creds: { app_id: "x" } });
    expect(res._status).toBe(200);
  });
});
