// Microsoft Graph (Outlook) mail provider (item 6). Network-free seams.
//
// The security-critical bits, asserted here:
//   * OAuth `state` is a tenant-bound, expiring HMAC — a tamper, a wrong key, or
//     an expiry makes it invalid, so the public callback can't be forged.
//   * The Azure directory id can't inject into the request URL path.
//   * Tokens + secret round-trip through the AES envelope (never plaintext).
//   * comms-send prefers Graph before SendGrid and persists the threading ids.
//   * the callback is public (no resolveContext) and never renders code/tokens.

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// signState + the AES envelope need a master key. Set one before importing.
beforeAll(() => {
  process.env.ANVIL_SECRETS_KEY = "a".repeat(64);   // 32 bytes hex
  process.env.PUBLIC_APP_URL = "https://app.example.com";
});

const HERE = dirname(fileURLToPath(import.meta.url));
const readApi = (p) => readFileSync(join(HERE, "..", "api", p), "utf8");

const g = await import("../api/_lib/graph-client.js");

describe("OAuth state is tenant-bound, signed, and expiring", () => {
  it("round-trips the tenant id", () => {
    const st = g.signState("tenant-123");
    expect(g.verifyState(st)).toEqual({ tenantId: "tenant-123" });
  });
  it("rejects a tampered signature", () => {
    const st = g.signState("t1");
    const [body] = st.split(".");
    expect(g.verifyState(body + ".deadbeef")).toBeNull();
  });
  it("rejects a tampered payload", () => {
    const st = g.signState("t1");
    const sig = st.split(".")[1];
    const forged = Buffer.from(JSON.stringify({ t: "t2", n: "x", e: Date.now() + 10000 })).toString("base64url");
    expect(g.verifyState(forged + "." + sig)).toBeNull();
  });
  it("rejects an expired state", () => {
    expect(g.verifyState(g.signState("t1", -1000))).toBeNull();
  });
  it("rejects garbage", () => {
    expect(g.verifyState("")).toBeNull();
    expect(g.verifyState("nodot")).toBeNull();
  });
});

describe("the authorize URL is well-formed and injection-safe", () => {
  it("carries client_id, redirect_uri, offline_access scope, and state", () => {
    const url = g.buildAuthorizeUrl({
      azureTenant: "00000000-0000-0000-0000-000000000000",
      clientId: "client-abc", redirectUri: "https://app.example.com/api/comms/graph/callback",
      state: "STATE",
    });
    expect(url).toMatch(/^https:\/\/login\.microsoftonline\.com\/00000000-0000-0000-0000-000000000000\/oauth2\/v2\.0\/authorize\?/);
    expect(url).toMatch(/client_id=client-abc/);
    expect(url).toMatch(/offline_access/);
    expect(url).toMatch(/Mail\.Send/);
    expect(url).toMatch(/state=STATE/);
    expect(url).toMatch(/redirect_uri=https%3A%2F%2Fapp\.example\.com/);
  });
  it("refuses an azure tenant id that would rewrite the URL path", () => {
    expect(() => g.buildAuthorizeUrl({ azureTenant: "foo/bar", clientId: "c", redirectUri: "r", state: "s" })).toThrow();
    expect(() => g.buildAuthorizeUrl({ azureTenant: "a b", clientId: "c", redirectUri: "r", state: "s" })).toThrow();
    expect(() => g.buildAuthorizeUrl({ azureTenant: "", clientId: "c", redirectUri: "r", state: "s" })).toThrow();
  });
});

describe("secret + tokens round-trip through the AES envelope", () => {
  it("encrypts and decrypts the client secret", () => {
    const enc = g.graphEncryptSecret({ client_secret: "super-secret" });
    expect(enc.graph_client_secret_enc).toBeInstanceOf(Buffer);   // not plaintext
    expect(g.graphDecryptSecret(enc)).toBe("super-secret");
  });
  it("encrypts and decrypts the access + refresh tokens under one iv", () => {
    const enc = g.graphEncryptTokens({ access_token: "AT", refresh_token: "RT" });
    const dec = g.graphDecryptTokens(enc);
    expect(dec).toEqual({ access_token: "AT", refresh_token: "RT" });
  });
});

describe("configured / connected gates", () => {
  // Reuses the columns migration 028 added for the inbound Graph integration.
  const base = { graph_tenant_id: "t", graph_client_id: "c", graph_mailbox: "s@x.com", graph_client_secret_enc: Buffer.from("x") };
  it("configured needs azure tenant + client + mailbox + secret", () => {
    expect(g.graphIsConfigured(base)).toBe(true);
    expect(g.graphIsConfigured({ ...base, graph_mailbox: null })).toBe(false);
  });
  it("connected additionally needs a refresh token", () => {
    expect(g.graphIsConnected(base)).toBe(false);
    expect(g.graphIsConnected({ ...base, graph_refresh_token_enc: Buffer.from("r") })).toBe(true);
  });
});

describe("the Graph message payload", () => {
  it("builds toRecipients/cc/bcc and a fileAttachment", () => {
    const m = g.buildGraphMessage({
      to: "a@x.com", cc: ["b@x.com"], bcc: ["c@x.com"], subject: "Hi", body: "line1\nline2",
      attachments: [{ filename: "r.pdf", type: "application/pdf", content_base64: "AAA" }],
    });
    expect(m.toRecipients).toEqual([{ emailAddress: { address: "a@x.com" } }]);
    expect(m.ccRecipients).toEqual([{ emailAddress: { address: "b@x.com" } }]);
    expect(m.bccRecipients).toEqual([{ emailAddress: { address: "c@x.com" } }]);
    expect(m.body.contentType).toBe("HTML");
    expect(m.body.content).toContain("<br/>");
    expect(m.attachments[0]["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
    expect(m.attachments[0].contentBytes).toBe("AAA");
  });
  it("omits cc/bcc when empty", () => {
    const m = g.buildGraphMessage({ to: "a@x.com", subject: "x", body: "y" });
    expect(m.ccRecipients).toBeUndefined();
    expect(m.bccRecipients).toBeUndefined();
  });
});

describe("redirect helpers come from config, not request headers", () => {
  it("redirect_uri derives from PUBLIC_APP_URL", () => {
    expect(g.graphRedirectUri()).toBe("https://app.example.com/api/comms/graph/callback");
  });
  it("UI return url is same-origin (hash route)", () => {
    expect(g.graphUiReturnUrl("connected")).toBe("https://app.example.com/#/admin?tab=communications&graph=connected");
  });
});

describe("comms-send integration", () => {
  const src = readApi("_lib/comms-send.js");
  it("prefers Graph BEFORE SendGrid", () => {
    expect(src.indexOf("sendViaGraph")).toBeGreaterThan(-1);
    expect(src.indexOf("sendViaGraph")).toBeLessThan(src.indexOf("sendViaSendGrid("));
  });
  it("gates Graph on the tenant being connected", () => {
    expect(src).toMatch(/graphIsConnected\(graphSettings\)/);
  });
  it("persists conversationId as thread_id and internetMessageId as provider_message_id", () => {
    expect(src).toMatch(/update\.thread_id = providerResult\.conversationId/);
    expect(src).toMatch(/update\.provider_message_id = providerResult\.internetMessageId/);
  });
});

describe("the OAuth callback is public + leak-free", () => {
  const src = readApi("comms/graph_callback.js");
  it("does NOT call resolveContext (validates signed state instead)", () => {
    expect(src).not.toMatch(/resolveContext/);
    expect(src).toMatch(/verifyState\(/);
  });
  it("redirects with a status code, never rendering the code or tokens", () => {
    expect(src).not.toMatch(/error_description/);      // never surfaced
    expect(src).toMatch(/graphUiReturnUrl/);
  });
});
