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
    // Emits a bytea '\x'-hex STRING, not a Buffer (a Buffer never lands in a
    // bytea column through supabase-js JSON serialisation).
    expect(typeof enc).toBe("string");
    expect(enc.startsWith("\\x")).toBe(true);
    expect(typeof iv).toBe("string");
    expect(iv).toMatch(/^\\x[0-9a-f]{24}$/); // 12-byte IV
    expect(decryptField(enc, iv)).toBe("hello-world-12345");
  });

  it("survives the storage boundary: a Buffer would be JSON-mangled, a '\\x'-hex string is not", () => {
    // Regression guard for the actual outage: postgrest-js JSON.stringify turns a
    // Buffer into {"type":"Buffer","data":[...]} which cannot be stored as bytea.
    // A '\x'-hex string passes through unchanged and PostgREST returns bytea reads
    // in the same form, so encrypt -> (JSON wire) -> decrypt must round-trip.
    const iv = newIv();
    const enc = encryptField("k-live-123", iv);
    const overWire = JSON.parse(JSON.stringify({ enc, iv }));
    expect(overWire.enc).toBe(enc);           // still a string, not a {type:"Buffer"} object
    expect(typeof overWire.enc).toBe("string");
    expect(decryptField(overWire.enc, overWire.iv)).toBe("k-live-123");
  });

  it("decryptField also accepts a Buffer (defensive back-compat)", () => {
    const iv = Buffer.from("0".repeat(24), "hex");
    const enc = encryptField("via-buffer-iv", iv); // iv passed as a raw Buffer
    expect(decryptField(enc, iv)).toBe("via-buffer-iv");
  });

  it("returns null when encrypting empty input", () => {
    const iv = newIv();
    expect(encryptField(null, iv)).toBeNull();
    expect(encryptField("", iv)).toBeNull();
  });

  it("rejects tampered ciphertext", () => {
    const iv = newIv();
    const enc = encryptField("secret", iv);
    // Flip the last hex nibble (part of the GCM auth tag) -> auth failure.
    const tampered = enc.slice(0, -1) + (enc.slice(-1) === "0" ? "1" : "0");
    expect(() => decryptField(tampered, iv)).toThrow();
  });

  it("rejects swapped IV", () => {
    const ivA = newIv();
    const ivB = newIv();
    const enc = encryptField("secret", ivA);
    expect(() => decryptField(enc, ivB)).toThrow();
  });

  it("encryptBundle produces one IV shared by all fields and round-trips", () => {
    const { iv, fields } = encryptBundle({ a: "alpha", b: "beta", c: "gamma" });
    expect(iv).toMatch(/^\\x[0-9a-f]{24}$/); // 12-byte IV as a bytea hex string
    expect(typeof fields.a).toBe("string");
    expect(fields.a.startsWith("\\x")).toBe(true);
    const back = decryptBundle(fields, iv);
    expect(back).toEqual({ a: "alpha", b: "beta", c: "gamma" });
  });

  it("encryptNetsuiteCreds + decryptNetsuiteCreds round-trip on a full row", () => {
    const enc = encryptNetsuiteCreds({
      consumer_key: "CK", consumer_secret: "CS",
      token_id: "TI", token_secret: "TS",
    });
    expect(enc.netsuite_creds_iv).toMatch(/^\\x[0-9a-f]{24}$/);
    expect(typeof enc.netsuite_consumer_key_enc).toBe("string");
    expect(enc.netsuite_consumer_key_enc.startsWith("\\x")).toBe(true);
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
