// POST /api/whatsapp/send says whether the message left.
//
// With no Twilio or Meta provider configured the endpoint answered ok: true
// (status "manual"), so a caller could not tell a sent message from one that
// never left. The row also had no channel, so it was stored as an email row
// with a phone number for an address. Now it answers sent: false with code
// not_configured, stores a whatsapp row marked failed (not queued, so the
// email reaper never picks it up), and a provider refusal is reported the
// same way.
//
// Runs the real handler. The database, the audit writer and the outbound
// fetch are faked. Invented fixtures.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const H = vi.hoisted(() => ({ ctx: null, store: null, seq: 0, fetch: null }));

vi.mock("../api/_lib/auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveContext: vi.fn(async () => H.ctx) };
});

vi.mock("../api/_lib/audit.js", () => ({
  recordAudit: vi.fn(async () => {}),
  recordEvent: vi.fn(async () => {}),
}));

vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: (...args) => H.fetch(...args),
}));

const makeSvc = () => ({
  from(table) {
    const rows = () => (H.store[table] = H.store[table] || []);
    return {
      _payload: null,
      insert(p) { this._payload = p; return this; },
      select() { return this; },
      single() {
        H.seq += 1;
        const created = { id: table + "-" + H.seq, ...this._payload };
        rows().push(created);
        return Promise.resolve({ data: created, error: null });
      },
    };
  },
});

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => makeSvc(),
  userClient: () => ({}),
}));

const { default: handler } = await import("../api/whatsapp/send.js");

const post = async (body) => {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(p) { this.body = p; return this; },
    end(p) { if (p != null) this.body = p; return this; },
  };
  await handler({ method: "POST", headers: {}, url: "/api/whatsapp/send", body }, res);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const PROVIDER_ENV = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "META_WHATSAPP_TOKEN", "META_WHATSAPP_PHONE_ID"];

beforeEach(() => {
  H.seq = 0;
  H.ctx = { user: { id: "u-se" }, tenantId: "t-1", role: "sales_engineer" };
  H.store = { communications: [] };
  H.fetch = vi.fn(async () => ({ ok: true, status: 201, text: async () => "{}" }));
  for (const k of PROVIDER_ENV) vi.stubEnv(k, "");
});
afterEach(() => { vi.unstubAllEnvs(); });

const useTwilio = () => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC-test");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "tok-test");
  vi.stubEnv("TWILIO_WHATSAPP_FROM", "+10000000000");
};

describe("POST /api/whatsapp/send", () => {
  it("with no provider configured answers sent: false, not_configured, and never ok", async () => {
    const r = await post({ to: "+91 98000 00000", body: "Your order is ready" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, sent: false, status: "failed", configured: false, code: "not_configured" });
    expect(r.body.error).toBe("No WhatsApp provider is configured, so the message was not sent.");
    expect(H.fetch).not.toHaveBeenCalled();
  });

  it("stores the not-sent message as a failed whatsapp row, never queued for the email reaper", async () => {
    const r = await post({ to: "+919800000000", body: "Your order is ready" });
    const row = H.store.communications.find((c) => c.id === r.body.communication_id);
    expect(row).toMatchObject({ tenant_id: "t-1", channel: "whatsapp", to_addr: "+919800000000", status: "failed", sent_at: null });
    expect(row.metadata.not_sent_reason).toBe("not_configured");
  });

  it("a provider refusal is reported as not sent with the provider's status", async () => {
    useTwilio();
    H.fetch = vi.fn(async () => ({ ok: false, status: 400, text: async () => "invalid To" }));
    const r = await post({ to: "+919800000000", body: "Hi" });
    expect(r.body).toMatchObject({ ok: false, sent: false, status: "failed", configured: true, code: "provider_error" });
    expect(r.body.error).toMatch(/twilio returned 400/);
  });

  it("a provider that accepts the message answers sent: true", async () => {
    useTwilio();
    const r = await post({ to: "+919800000000", body: "Hi" });
    expect(r.body).toMatchObject({ ok: true, sent: true, status: "sent", configured: true, code: null, error: null, provider: "twilio" });
    expect(H.fetch).toHaveBeenCalledTimes(1);
    const row = H.store.communications.find((c) => c.id === r.body.communication_id);
    expect(row.status).toBe("sent");
    expect(row.sent_at).toBeTruthy();
  });
});
