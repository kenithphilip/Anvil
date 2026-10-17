// Unit tests for tally-client v2 helpers. Confirms:
//   - tallyEncryptedTokenColumns encrypts the token when ANVIL_SECRETS_KEY
//     is set, refuses (400) when it is not, and returns nulls when the
//     input token is null.
//   - tallyDecryptToken round-trips encrypted columns, reads old-format
//     tokens with bridge_iv, and falls back to plaintext.
//   - tallyBridgeUrlProblem / tallyBridgeEndpoint accept https, and plain
//     http only for localhost.
//   - tallyResolveCompany serves the env bridge to its one tenant only.
//   - tallyIsRecoverable matches the documented HTTP class set.

import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  tallyEncryptedTokenColumns, tallyDecryptToken, tallyIsRecoverable,
  tallyBridgeUrlProblem, tallyBridgeEndpoint, tallyResolveCompany, tallyEnvBridgeServes,
} from "../api/_lib/tally-client.js";
import { defaultTenantId } from "../api/_lib/tenancy.js";

const HEX_KEY = "b".repeat(64);

beforeAll(() => { process.env.ANVIL_SECRETS_KEY = HEX_KEY; });
afterAll(() => { delete process.env.ANVIL_SECRETS_KEY; });

describe("tally-client / token helpers", () => {
  it("encrypts the token when the master key is configured", () => {
    const cols = tallyEncryptedTokenColumns("super-secret");
    expect(cols.bridge_token).toBeNull();
    // bytea '\x'-hex strings, not Buffers (a Buffer never lands in bytea).
    expect(typeof cols.bridge_token_enc).toBe("string");
    expect(cols.bridge_token_enc.startsWith("\\x")).toBe(true);
    // The value carries its own IV; no separate bridge_iv is written.
    expect(cols.bridge_iv).toBeNull();
  });

  it("returns nulls for a null token", () => {
    const cols = tallyEncryptedTokenColumns(null);
    expect(cols).toEqual({ bridge_token: null, bridge_token_enc: null, bridge_iv: null });
  });

  it("refuses to store the token when ANVIL_SECRETS_KEY is unset (no plaintext)", () => {
    delete process.env.ANVIL_SECRETS_KEY;
    try {
      let err = null;
      try { tallyEncryptedTokenColumns("plain"); } catch (e) { err = e; }
      expect(err && err.status).toBe(400);
      // Clearing the token needs no key.
      expect(tallyEncryptedTokenColumns(null).bridge_token).toBeNull();
    } finally {
      process.env.ANVIL_SECRETS_KEY = HEX_KEY;
    }
  });

  it("still decrypts a token stored in the old format with bridge_iv", () => {
    const ivHex = "0102030405060708090a0b0c";
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(HEX_KEY, "hex"), Buffer.from(ivHex, "hex"));
    const ct = Buffer.concat([cipher.update("old-token", "utf8"), cipher.final(), cipher.getAuthTag()]);
    expect(tallyDecryptToken({ bridge_token_enc: "\\x" + ct.toString("hex"), bridge_iv: "\\x" + ivHex })).toBe("old-token");
  });

  it("round-trips encrypted token via tallyDecryptToken", () => {
    const cols = tallyEncryptedTokenColumns("round-trip-token");
    const company = { ...cols };
    expect(tallyDecryptToken(company)).toBe("round-trip-token");
  });

  it("falls back to plaintext column when no encrypted bytes present", () => {
    expect(tallyDecryptToken({ bridge_token: "plain" })).toBe("plain");
  });

  it("returns null on no inputs at all", () => {
    expect(tallyDecryptToken({})).toBeNull();
    expect(tallyDecryptToken(null)).toBeNull();
  });

  it("classifies recoverable vs permanent HTTP statuses", () => {
    expect(tallyIsRecoverable(0)).toBe(true);     // network
    expect(tallyIsRecoverable(429)).toBe(true);   // throttle
    expect(tallyIsRecoverable(500)).toBe(true);
    expect(tallyIsRecoverable(503)).toBe(true);
    expect(tallyIsRecoverable(599)).toBe(true);
    expect(tallyIsRecoverable(400)).toBe(false);
    expect(tallyIsRecoverable(401)).toBe(false);
    expect(tallyIsRecoverable(404)).toBe(false);
  });
});

describe("tally-client / bridge URL", () => {
  it("accepts https, and plain http only for localhost", () => {
    expect(tallyBridgeUrlProblem("https://bridge.example.com")).toBeNull();
    expect(tallyBridgeUrlProblem("https://203.0.113.5:9443/tally")).toBeNull();
    expect(tallyBridgeUrlProblem("http://localhost:9000")).toBeNull();
    expect(tallyBridgeUrlProblem("http://127.0.0.1:9000")).toBeNull();
    expect(tallyBridgeUrlProblem("http://[::1]:9000")).toBeNull();
    expect(tallyBridgeUrlProblem("http://tally.localhost:9000")).toBeNull();
  });

  it("refuses plain http to any other host, other schemes, and junk", () => {
    expect(tallyBridgeUrlProblem("http://bridge.example.com")).toMatch(/https/);
    expect(tallyBridgeUrlProblem("http://203.0.113.5:9000")).toMatch(/https/);
    expect(tallyBridgeUrlProblem("http://localhost.example.com")).toMatch(/https/);
    expect(tallyBridgeUrlProblem("ftp://bridge.example.com")).toMatch(/https/);
    expect(tallyBridgeUrlProblem("bridge.example.com")).toMatch(/valid URL/);
  });

  it("tallyBridgeEndpoint returns the URL for https and throws 409 for plain http", () => {
    expect(tallyBridgeEndpoint({ bridge_url: "https://b.example.com/" }, "/health")).toBe("https://b.example.com/health");
    let err = null;
    try { tallyBridgeEndpoint({ bridge_url: "http://b.example.com" }); } catch (e) { err = e; }
    expect(err && err.status).toBe(409);
  });
});

// A supabase stand-in where the tenant has no tally_companies rows.
const noCompanies = () => {
  const q = {
    select: () => q, eq: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { from: () => q };
};

describe("tally-client / env bridge is bound to one tenant", () => {
  const OTHER = "11111111-2222-3333-4444-555555555555";
  afterEach(() => {
    delete process.env.TALLY_BRIDGE_URL;
    delete process.env.TALLY_BRIDGE_TOKEN;
    delete process.env.TALLY_BRIDGE_TENANT_ID;
  });

  it("serves the default tenant when TALLY_BRIDGE_TENANT_ID is unset", async () => {
    process.env.TALLY_BRIDGE_URL = "https://env-bridge.example.com";
    process.env.TALLY_BRIDGE_TOKEN = "env-token";
    const own = await tallyResolveCompany(noCompanies(), defaultTenantId(), null);
    expect(own && own.bridge_url).toBe("https://env-bridge.example.com");
    expect(own.bridge_token).toBe("env-token");
    expect(await tallyResolveCompany(noCompanies(), OTHER, null)).toBeNull();
  });

  it("serves only TALLY_BRIDGE_TENANT_ID when it is set", async () => {
    process.env.TALLY_BRIDGE_URL = "https://env-bridge.example.com";
    process.env.TALLY_BRIDGE_TENANT_ID = OTHER;
    expect((await tallyResolveCompany(noCompanies(), OTHER, null))?.bridge_url).toBe("https://env-bridge.example.com");
    expect(await tallyResolveCompany(noCompanies(), defaultTenantId(), null)).toBeNull();
    expect(tallyEnvBridgeServes(OTHER)).toBe(true);
    expect(tallyEnvBridgeServes(defaultTenantId())).toBe(false);
  });

  it("serves nobody when TALLY_BRIDGE_URL is unset", async () => {
    expect(tallyEnvBridgeServes(defaultTenantId())).toBe(false);
    expect(await tallyResolveCompany(noCompanies(), defaultTenantId(), null)).toBeNull();
  });
});
