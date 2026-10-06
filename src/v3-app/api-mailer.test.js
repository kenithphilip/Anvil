// Switchable transactional mailer: provider selection + per-provider payload
// shaping + the no-op-when-unconfigured contract. safe-fetch is mocked so no
// network I/O happens.

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = [];
vi.mock("../api/_lib/safe-fetch.js", () => ({
  safeFetch: vi.fn(async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return { ok: true, status: 202, text: async () => "" }; }),
}));

// FROM_EMAIL is captured at module load, so set it before importing the mailer.
process.env.EMAIL_FROM = "noreply@anvil.test";
process.env.EMAIL_FROM_NAME = "Anvil";
const { sendEmail, emailProvider, emailConfigured } = await import("../api/_lib/mailer.js");

beforeEach(() => {
  calls.length = 0;
  vi.unstubAllEnvs();
});

describe("emailProvider — selection", () => {
  it("honours explicit EMAIL_PROVIDER when its key is set", () => {
    vi.stubEnv("EMAIL_PROVIDER", "brevo"); vi.stubEnv("BREVO_API_KEY", "k");
    expect(emailProvider()).toBe("brevo");
  });
  it("returns null for an explicit provider whose key is missing", () => {
    vi.stubEnv("EMAIL_PROVIDER", "brevo");
    expect(emailProvider()).toBeNull();
  });
  it("auto-detects brevo > resend > sendgrid by which key is present", () => {
    vi.stubEnv("RESEND_API_KEY", "r");
    expect(emailProvider()).toBe("resend");
    vi.stubEnv("BREVO_API_KEY", "b");
    expect(emailProvider()).toBe("brevo");   // brevo wins over resend
  });
  it("is null when nothing is configured", () => {
    expect(emailProvider()).toBeNull();
    expect(emailConfigured()).toBe(false);
  });
});

describe("sendEmail — no-op contract", () => {
  it("skips (no throw, no fetch) when no provider is configured", async () => {
    const r = await sendEmail({ to: "a@b.com", subject: "hi", text: "x" });
    expect(r).toMatchObject({ ok: false, skipped: true, reason: "not_configured" });
    expect(calls).toHaveLength(0);
  });
  it("skips when there's no recipient", async () => {
    vi.stubEnv("BREVO_API_KEY", "k");
    const r = await sendEmail({ subject: "hi", text: "x" });
    expect(r).toMatchObject({ ok: false, skipped: true, reason: "no_recipient" });
    expect(calls).toHaveLength(0);
  });
});

describe("sendEmail — provider payloads", () => {
  it("brevo: posts to the Brevo API with api-key header + sender/to/subject", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "brevo"); vi.stubEnv("BREVO_API_KEY", "bkey");
    const r = await sendEmail({ to: "cust@x.com", subject: "Welcome", text: "hello", cc: "boss@x.com" });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(calls[0].opts.headers["api-key"]).toBe("bkey");
    expect(calls[0].body.sender).toEqual({ email: "noreply@anvil.test", name: "Anvil" });
    expect(calls[0].body.to).toEqual([{ email: "cust@x.com" }]);
    expect(calls[0].body.cc).toEqual([{ email: "boss@x.com" }]);
    expect(calls[0].body.subject).toBe("Welcome");
    expect(calls[0].body.htmlContent).toContain("hello");
  });
  it("resend: posts to the Resend API with Bearer + 'Name <email>' from", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend"); vi.stubEnv("RESEND_API_KEY", "rkey");
    const r = await sendEmail({ to: "cust@x.com", subject: "Reset", text: "link" });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].opts.headers.Authorization).toBe("Bearer rkey");
    expect(calls[0].body.from).toBe("Anvil <noreply@anvil.test>");
    expect(calls[0].body.to).toEqual(["cust@x.com"]);
  });
  it("sendgrid: posts to the SendGrid API with personalizations", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "sendgrid"); vi.stubEnv("SENDGRID_API_KEY", "skey");
    const r = await sendEmail({ to: "cust@x.com", subject: "Quote", text: "body" });
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(calls[0].body.personalizations[0].to).toEqual([{ email: "cust@x.com" }]);
    expect(calls[0].body.from.email).toBe("noreply@anvil.test");
  });
});
