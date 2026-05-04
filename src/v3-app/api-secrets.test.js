// Unit tests for the AES-256-GCM credential encryption helper used by
// the NetSuite v2 connector. Confirms:
//   - encryptField + decryptField round-trip.
//   - Tampering with ciphertext or tag triggers an auth failure.
//   - encryptBundle yields one IV per call and decrypts back cleanly.
//   - decryptNetsuiteCreds falls back to plaintext when encrypted
//     columns are absent (the rotation window).
//   - encryptNetsuiteCreds emits the four field bytea blobs + iv.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  encryptField, decryptField, encryptBundle, decryptBundle,
  encryptNetsuiteCreds, decryptNetsuiteCreds, isSecretsConfigured, newIv,
} from "../api/_lib/secrets.js";

const HEX_KEY = "a".repeat(64);

beforeAll(() => {
  process.env.ANVIL_SECRETS_KEY = HEX_KEY;
});

afterAll(() => {
  delete process.env.ANVIL_SECRETS_KEY;
});

describe("secrets / encryption helpers", () => {
  it("reports configured when the env var is the right length", () => {
    expect(isSecretsConfigured()).toBe(true);
  });

  it("round-trips an arbitrary string", () => {
    const iv = newIv();
    const enc = encryptField("hello-world-12345", iv);
    expect(Buffer.isBuffer(enc)).toBe(true);
    expect(enc.length).toBeGreaterThan(16);
    expect(decryptField(enc, iv)).toBe("hello-world-12345");
  });

  it("returns null when encrypting empty input", () => {
    const iv = newIv();
    expect(encryptField(null, iv)).toBeNull();
    expect(encryptField("", iv)).toBeNull();
  });

  it("rejects tampered ciphertext", () => {
    const iv = newIv();
    const enc = encryptField("secret", iv);
    enc[0] = enc[0] ^ 0xff;
    expect(() => decryptField(enc, iv)).toThrow();
  });

  it("rejects swapped IV", () => {
    const ivA = newIv();
    const ivB = newIv();
    const enc = encryptField("secret", ivA);
    expect(() => decryptField(enc, ivB)).toThrow();
  });

  it("encryptBundle produces one IV shared by all fields and round-trips", () => {
    const { iv, fields } = encryptBundle({ a: "alpha", b: "beta", c: "gamma" });
    expect(iv.length).toBe(12);
    const back = decryptBundle(fields, iv);
    expect(back).toEqual({ a: "alpha", b: "beta", c: "gamma" });
  });

  it("encryptNetsuiteCreds + decryptNetsuiteCreds round-trip on a full row", () => {
    const enc = encryptNetsuiteCreds({
      consumer_key: "CK", consumer_secret: "CS",
      token_id: "TI", token_secret: "TS",
    });
    expect(enc.netsuite_creds_iv).toBeDefined();
    expect(Buffer.isBuffer(enc.netsuite_consumer_key_enc)).toBe(true);
    const row = {
      netsuite_account_id: "1234567",
      ...enc,
    };
    const back = decryptNetsuiteCreds(row);
    expect(back.netsuite_consumer_key).toBe("CK");
    expect(back.netsuite_consumer_secret).toBe("CS");
    expect(back.netsuite_token_id).toBe("TI");
    expect(back.netsuite_token_secret).toBe("TS");
  });

  it("decryptNetsuiteCreds falls back to plaintext columns when no enc bytes", () => {
    const back = decryptNetsuiteCreds({
      netsuite_account_id: "1234567",
      netsuite_consumer_key: "PCK",
      netsuite_consumer_secret: "PCS",
      netsuite_token_id: "PTI",
      netsuite_token_secret: "PTS",
    });
    expect(back.netsuite_consumer_key).toBe("PCK");
    expect(back.netsuite_token_secret).toBe("PTS");
  });

  it("encryption fails fast when the master key is wrong length", () => {
    const prev = process.env.ANVIL_SECRETS_KEY;
    process.env.ANVIL_SECRETS_KEY = "deadbeef";
    expect(() => encryptField("x", newIv())).toThrow();
    process.env.ANVIL_SECRETS_KEY = prev;
  });
});
