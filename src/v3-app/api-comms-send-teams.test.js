// Teams outbound and the copilot "draft and send" confirm report what really
// happened.
//
// The shared send core (_lib/comms-send.js) answered a Teams row with
// ok: true and status 202 although nothing was sent (a Teams reply needs the
// service_url from an inbound activity, which this path never has). The row
// was marked sent, and the copilot confirm screen said "Done". Now a Teams
// row is failed with a not_configured reason, never falls through to the
// email providers, and the confirm result carries sent: false with the
// reason.
//
// These tests run the real send core and the real confirm handler. Only the
// mail provider (_lib/mailer.js sendEmail), the audit writer and the database
// are faked. Invented fixtures.

import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, store: null, seq: 0, sendEmail: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendEmail: (...args) => H.sendEmail(...args) };
});

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));

// In-memory PostgREST stand-in: select / insert / update with eq, gt and in
// filters, single / maybeSingle, and a thenable for plain awaits.
const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    const q = {
      _f: [], _op: "select", _payload: null,
      select() { return this; },
      eq(c, v) { this._f.push((r) => r[c] === v); return this; },
      gt(c, v) { this._f.push((r) => r[c] != null && String(r[c]) > String(v)); return this; },
      in(c, vs) { this._f.push((r) => vs.includes(r[c])); return this; },
      order() { return this; },
      limit() { return this; },
      insert(p) { this._op = "insert"; this._payload = p; return this; },
      update(p) { this._op = "update"; this._payload = p; return this; },
      _run() {
        if (this._op === "insert") {
          return (Array.isArray(this._payload) ? this._payload : [this._payload]).map((p) => {
            H.seq += 1;
            const created = { id: table + "-" + H.seq, ...p };
            rows().push(created);
            return created;
          });
        }
        const hit = rows().filter((r) => this._f.every((fn) => fn(r)));
        if (this._op === "update") for (const r of hit) Object.assign(r, this._payload);
        return hit;
      },
      single() { const d = this._run(); return Promise.resolve(d[0] ? { data: d[0], error: null } : { data: null, error: { message: "no rows" } }); },
      maybeSingle() { const d = this._run(); return Promise.resolve({ data: d[0] || null, error: null }); },
      then(res, rej) { return Promise.resolve({ data: this._run(), error: null }).then(res, rej); },
    };
    return q;
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { sendCommunication } = await import("../api/_lib/comms-send.js");
const { createProposal } = await import("../api/_lib/action-proposals.js");
const { default: confirmHandler } = await import("../api/copilot/confirm.js");

const confirm = async (token) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await confirmHandler({ method: "POST", headers: {}, url: "/api/copilot/confirm", body: { confirm_token: token } }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const propose = async (args) => {
  const p = await createProposal(makeSvc(), { tenantId: "t-1", userId: "u-mgr", action: "draft_and_send_comms", args });
  return p.confirm_token;
};

beforeEach(() => {
  H.seq = 0;
  H.ctx = { user: { id: "u-mgr" }, tenantId: "t-1", role: "admin" };
  H.sendEmail = vi.fn(async () => ({ ok: true, provider: "resend", status: 200 }));
  H.store = {
    communications: [],
    tenant_settings: [],
    action_proposals: [],
    // A Teams chat config exists, so the old code reached its Teams branch
    // and answered ok: true.
    inbound_chat_configs: [{ id: "cfg-1", tenant_id: "t-1", channel: "teams", active: true }],
  };
});

describe("sendCommunication: Teams", () => {
  it("does not mark a Teams row sent: it is failed with a not_configured reason", async () => {
    H.store.communications.push({ id: "c-1", tenant_id: "t-1", direction: "outbound", channel: "teams", to_addr: "19:thread@thread.v2", subject: "Hi", body: "Status update", status: "draft", metadata: {} });
    const r = await sendCommunication(makeSvc(), H.ctx, "c-1");
    expect(r.configured).toBe(false);
    expect(r.error).toMatch(/^not_configured: Teams outbound is not available/);
    expect(r.communication.status).toBe("failed");
    expect(r.communication.sent_at).toBeNull();
    expect(H.store.communications[0].status).toBe("failed");
    // Never handed to the email providers with a Teams address.
    expect(H.sendEmail).not.toHaveBeenCalled();
  });

  it("with no Teams config either, still fails it and does not email the Teams address", async () => {
    H.store.inbound_chat_configs = [];
    H.store.communications.push({ id: "c-2", tenant_id: "t-1", direction: "outbound", channel: "teams", to_addr: "19:thread@thread.v2", body: "x", status: "draft", metadata: {} });
    const r = await sendCommunication(makeSvc(), H.ctx, "c-2");
    expect(r.communication.status).toBe("failed");
    expect(H.sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/copilot/confirm: draft_and_send_comms reports whether it was sent", () => {
  it("a Teams send returns sent: false with the reason, and the row is not sent", async () => {
    const token = await propose({ channel: "teams", to_addr: "19:thread@thread.v2", subject: "Hi", body: "Status update" });
    const r = await confirm(token);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result.sent).toBe(false);
    expect(r.body.result.configured).toBe(false);
    expect(r.body.result.send_error).toMatch(/not_configured/);
    expect(r.body.result.communication.status).toBe("failed");
    expect(H.store.communications.filter((c) => c.status === "sent")).toEqual([]);
  });

  it("an email with no mail provider configured returns sent: false, never sent", async () => {
    H.sendEmail = vi.fn(async () => ({ ok: false, provider: null, skipped: true, reason: "not_configured" }));
    const token = await propose({ channel: "email", to_addr: "buyer@acme.test", subject: "Hi", body: "Hello" });
    const r = await confirm(token);
    expect(r.body.result.sent).toBe(false);
    expect(r.body.result.send_error).toMatch(/No provider is configured/);
    expect(r.body.result.communication.status).toBe("queued");
  });

  it("an email a provider accepted returns sent: true and no error", async () => {
    const token = await propose({ channel: "email", to_addr: "buyer@acme.test", subject: "Hi", body: "Hello" });
    const r = await confirm(token);
    expect(r.body.result).toMatchObject({ sent: true, send_error: null, provider: "resend" });
    expect(r.body.result.communication.status).toBe("sent");
    expect(H.sendEmail).toHaveBeenCalledTimes(1);
  });
});
