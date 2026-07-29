// The MARKETING path (item 8) — docs/CUSTOMER_COMMS_DESIGN.md §6.
//
// The load-bearing property, asserted as a TEST (not a convention): a marketing
// suppression or a missing marketing consent must NEVER block a transactional
// send. Plus: marketing enforces consent + suppression + unsubscribe, the
// unsubscribe token is tamper-proof, and the transactional reaper skips marketing.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

beforeAll(() => {
  process.env.ANVIL_SECRETS_KEY = "b".repeat(64);
  process.env.PUBLIC_APP_URL = "https://app.example.com";
});

const HERE = dirname(fileURLToPath(import.meta.url));
const readApi = (p) => readFileSync(join(HERE, "..", "api", p), "utf8");

const mkt = await import("../api/_lib/marketing-send.js");
const { resolveRecipients } = await import("../api/_lib/comms-routing.js");

// Mock svc: prospecting_suppressions returns a row when `suppressed`.
const mockSvc = (suppressed) => ({
  from: () => {
    const b = {
      select: () => b, or: () => b, eq: () => b, limit: () => b,
      upsert: () => Promise.resolve({ error: null }),
      then: (res) => res({ data: suppressed ? [{ id: "s1" }] : [], error: null }),
    };
    return b;
  },
});

describe("THE INVARIANT — marketing gates never touch transactional", () => {
  const contacts = [{ id: "c1", email: "buyer@acme.com", is_active: true, is_primary: true, marketing_consent: false }];

  it("a non-consented contact STILL receives a transactional send", () => {
    const tx = resolveRecipients("payment_reminder", contacts, [], {}); // no requireConsent
    expect(tx.to).toContain("buyer@acme.com");
    expect(tx.unresolved).toBe(false);
  });

  it("the SAME contact gets NO marketing (consent required)", () => {
    const mk = resolveRecipients("marketing", contacts, [], { requireConsent: true });
    expect(mk.to).not.toContain("buyer@acme.com");
    expect(mk.unresolved).toBe(true);
  });

  it("the transactional send path never reads suppression or consent", () => {
    const src = readApi("_lib/comms-send.js");
    expect(src).not.toMatch(/prospecting_suppressions/);
    expect(src).not.toMatch(/marketing_consent/);
    expect(src).not.toMatch(/import[^\n]*marketing-send/);   // does not IMPORT the marketing path
  });

  it("the transactional reaper skips document_type='marketing'", () => {
    const src = readApi("agents/run.js");
    expect(src).toMatch(/document_type === "marketing"/);
  });

  it("the transactional sendCommunication REFUSES a marketing row (every entry point, not just the reaper)", () => {
    // POST /api/communications/send + the copilot path both reach
    // sendCommunication; a failed marketing row must not be re-sent transactionally.
    const src = readApi("_lib/comms-send.js");
    expect(src).toMatch(/document_type === "marketing"/);
    expect(src).toMatch(/skipped: "marketing_row"/);
  });
});

describe("unsubscribe token is tamper-proof + tenant/email-bound", () => {
  it("round-trips tenant + email", () => {
    const tok = mkt.signUnsubscribe("t1", "Buyer@Acme.com");
    expect(mkt.verifyUnsubscribe(tok)).toEqual({ tenantId: "t1", email: "buyer@acme.com" }); // normalized
  });
  it("rejects a tampered signature and garbage", () => {
    const tok = mkt.signUnsubscribe("t1", "a@x.com");
    expect(mkt.verifyUnsubscribe(tok.split(".")[0] + ".deadbeef")).toBeNull();
    expect(mkt.verifyUnsubscribe("nope")).toBeNull();
    expect(mkt.verifyUnsubscribe("")).toBeNull();
  });
  it("builds a same-origin unsubscribe URL", () => {
    const url = mkt.unsubscribeUrl("t1", "a@x.com");
    expect(url).toMatch(/^https:\/\/app\.example\.com\/api\/marketing\/unsubscribe\?token=/);
  });
});

describe("sendMarketing enforces consent + suppression", () => {
  it("refuses without asserted consent", async () => {
    const r = await mkt.sendMarketing(mockSvc(false), "t1", { to: "a@x.com", subject: "s", body: "b", consented: false });
    expect(r).toMatchObject({ ok: false, skipped: "no_consent" });
  });
  it("refuses a suppressed recipient even when consented", async () => {
    const r = await mkt.sendMarketing(mockSvc(true), "t1", { to: "a@x.com", subject: "s", body: "b", consented: true });
    expect(r).toMatchObject({ ok: false, skipped: "suppressed" });
  });
  it("with consent + no suppression, reaches the provider step and carries an unsubscribe url", async () => {
    // No SENDGRID/MARKETING_FROM env in test -> stops at no_provider, but the
    // gates passed and the unsubscribe url is present.
    const r = await mkt.sendMarketing(mockSvc(false), "t1", { to: "a@x.com", subject: "s", body: "b", consented: true });
    expect(r.skipped).toBe("no_provider");
    expect(r.unsubscribe_url).toMatch(/\/api\/marketing\/unsubscribe\?token=/);
  });
  it("isSuppressed / addSuppression round-trip against the table", async () => {
    expect(await mkt.isSuppressed(mockSvc(true), "t1", "a@x.com")).toBe(true);
    expect(await mkt.isSuppressed(mockSvc(false), "t1", "a@x.com")).toBe(false);
    expect(await mkt.addSuppression(mockSvc(false), "t1", "a@x.com")).toBe(true);
  });
});

describe("marketing endpoints are wired correctly", () => {
  it("send.js requires consent, marks document_type='marketing', logs via commsRow", () => {
    const src = readApi("marketing/send.js");
    expect(src).toMatch(/marketing_consent/);
    expect(src).toMatch(/document_type: "marketing"/);
    expect(src).toMatch(/insert\(commsRow\(/);           // passes the #334 guard
    expect(src).toMatch(/requirePermission\(ctx, "admin"\)/);
  });
  it("unsubscribe.js is public and does not unsubscribe on GET (prefetch-safe)", () => {
    const src = readApi("marketing/unsubscribe.js");
    expect(src).not.toMatch(/resolveContext/);           // public, no session
    expect(src).toMatch(/verifyUnsubscribe/);
    // The addSuppression CALL (not the import) lives inside the POST branch, so
    // a GET (link prefetch / scanner) never mutates state.
    const postIdx = src.indexOf('req.method === "POST"');
    const callIdx = src.indexOf("addSuppression(serviceClient");
    expect(postIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(postIdx);
  });
  it("prospecting run sends via the marketing path, marked marketing", () => {
    const src = readApi("prospecting/run.js");
    expect(src).toMatch(/sendMarketing\(/);
    expect(src).toMatch(/document_type: "marketing"/);
  });
});
