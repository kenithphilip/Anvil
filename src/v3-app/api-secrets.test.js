// Unit tests for the AES-256-GCM credential encryption helper
// (src/api/_lib/secrets.js). Confirms:
//   - encryptField + decryptField round-trip, across the JSON wire.
//   - Each encrypted value carries its own IV: two fields of one bundle,
//     and the same plaintext twice, never share an IV.
//   - Values written in the old format (one IV per bundle, in a separate
//     *_iv column) still decrypt with that IV.
//   - Tampering triggers an auth failure.
//   - NetSuite credentials are refused, not stored in plaintext, when
//     ANVIL_SECRETS_KEY is unset.

import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  encryptField, decryptField, openField, requireSecretsConfigured,
  encryptNetsuiteCreds, decryptNetsuiteCreds, isSecretsConfigured,
} from "../api/_lib/secrets.js";

const HEX_KEY = "a".repeat(64);

// The v2 layout the module documents: "v2:" (3 bytes) || iv (12) || ciphertext || tag (16).
const bytesOf = (enc) => Buffer.from(enc.slice(2), "hex");
const ivOf = (enc) => bytesOf(enc).subarray(3, 15).toString("hex");
const ctOf = (enc) => { const b = bytesOf(enc); return b.subarray(15, b.length - 16); };

// A value in the old format, built the way the old encryptField built it:
// ciphertext || tag under a caller-supplied IV, stored as '\x'-hex.
const legacyEncrypt = (plaintext, ivHex, keyHex = HEX_KEY) => {
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(ivHex, "hex"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return "\\x" + Buffer.concat([ct, cipher.getAuthTag()]).toString("hex");
};
const xor = (a, b) => Buffer.from(a.subarray(0, Math.min(a.length, b.length)).map((x, i) => x ^ b[i]));

let savedKey;
beforeAll(() => {
  savedKey = process.env.ANVIL_SECRETS_KEY;
  process.env.ANVIL_SECRETS_KEY = HEX_KEY;
});

afterAll(() => {
  if (savedKey === undefined) delete process.env.ANVIL_SECRETS_KEY;
  else process.env.ANVIL_SECRETS_KEY = savedKey;
});

describe("secrets / encryption helpers", () => {
  it("reports configured when the env var is the right length", () => {
    expect(isSecretsConfigured()).toBe(true);
  });

  it("round-trips an arbitrary string without a separate IV", () => {
    const enc = encryptField("hello-world-12345");
    // Emits a bytea '\x'-hex STRING, not a Buffer (a Buffer never lands in a
    // bytea column through supabase-js JSON serialisation).
    expect(typeof enc).toBe("string");
    expect(enc.startsWith("\\x")).toBe(true);
    expect(decryptField(enc)).toBe("hello-world-12345");
    expect(openField(enc)).toEqual({ plaintext: "hello-world-12345", version: 2 });
  });

  it("survives the storage boundary: a '\\x'-hex string passes the JSON wire unchanged", () => {
    // Regression guard for the bytea outage: postgrest-js JSON.stringify turns a
    // Buffer into {"type":"Buffer","data":[...]} which cannot be stored as bytea.
    const enc = encryptField("k-live-123");
    const overWire = JSON.parse(JSON.stringify({ enc }));
    expect(overWire.enc).toBe(enc);
    expect(decryptField(overWire.enc)).toBe("k-live-123");
  });

  it("decryptField also accepts a Buffer (defensive back-compat)", () => {
    const enc = encryptField("via-buffer");
    expect(decryptField(bytesOf(enc))).toBe("via-buffer");
  });

  it("returns null when encrypting empty input", () => {
    expect(encryptField(null)).toBeNull();
    expect(encryptField("")).toBeNull();
    expect(decryptField(null)).toBeNull();
  });

  it("gives two fields of one bundle distinct IVs", () => {
    const user = encryptField("svc-user");
    const pass = encryptField("svc-password");
    expect(ivOf(user)).not.toBe(ivOf(pass));
    expect(decryptField(user)).toBe("svc-user");
    expect(decryptField(pass)).toBe("svc-password");
  });

  it("gives the same plaintext a fresh IV and ciphertext on every call", () => {
    const encs = Array.from({ length: 20 }, () => encryptField("same-secret"));
    expect(new Set(encs.map(ivOf)).size).toBe(20);
    expect(new Set(encs).size).toBe(20);
  });

  it("does not leak one field through another: XOR of ciphertexts is not XOR of plaintexts", () => {
    // Two equal-length fields. Under the old format (one IV for the bundle)
    // ct1 XOR ct2 equals pt1 XOR pt2, so a known client_id gives away the
    // secret stored next to it. With per-value IVs it must not.
    const knownId = "client-0123456789";
    const secret = "S3cr3t-ABCDEFGHIJ";
    const ptXor = xor(Buffer.from(knownId), Buffer.from(secret));

    const sharedIv = "00112233445566778899aabb";
    const oldId = bytesOf(legacyEncrypt(knownId, sharedIv));
    const oldSecret = bytesOf(legacyEncrypt(secret, sharedIv));
    expect(xor(oldId.subarray(0, -16), oldSecret.subarray(0, -16)).equals(ptXor)).toBe(true);

    const newId = encryptField(knownId);
    const newSecret = encryptField(secret);
    expect(xor(ctOf(newId), ctOf(newSecret)).equals(ptXor)).toBe(false);
    expect(xor(xor(ctOf(newId), ctOf(newSecret)), Buffer.from(knownId)).toString()).not.toBe(secret);
  });

  it("still decrypts old-format values with their bundle IV", () => {
    const iv = "\\x" + "0f".repeat(12);
    const a = legacyEncrypt("old-user", "0f".repeat(12));
    const b = legacyEncrypt("old-pass", "0f".repeat(12));
    expect(decryptField(a, iv)).toBe("old-user");
    expect(decryptField(b, iv)).toBe("old-pass");
    expect(openField(a, iv)).toEqual({ plaintext: "old-user", version: 1 });
    // The IV may also arrive as a Buffer.
    expect(decryptField(b, Buffer.from("0f".repeat(12), "hex"))).toBe("old-pass");
  });

  it("refuses an old-format value without its IV, or with the wrong IV", () => {
    const a = legacyEncrypt("old-user", "0f".repeat(12));
    expect(() => decryptField(a)).toThrow();
    expect(() => decryptField(a, "\\x" + "1e".repeat(12))).toThrow();
  });

  it("reads an old-format value whose bytes happen to start with the v2 marker", () => {
    // About 1 in 16.7M old values start with "v2:" by chance; the auth tag
    // must route them to the old format instead of failing. Build one on
    // purpose: GCM ciphertext = plaintext XOR keystream, so choose the first
    // 3 plaintext bytes as "v2:" XOR keystream (printable, for a clean string).
    const key = Buffer.from(HEX_KEY, "hex");
    let found = null;
    for (let n = 0; n < 5000 && !found; n += 1) {
      const ivHex = n.toString(16).padStart(24, "0");
      const c = crypto.createCipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
      const keystream = c.update(Buffer.alloc(3));
      const head = Buffer.from([0x76 ^ keystream[0], 0x32 ^ keystream[1], 0x3a ^ keystream[2]]);
      if (head.every((x) => x >= 0x20 && x < 0x7f)) found = { ivHex, pt: head.toString("latin1") + "-collision-probe-plaintext" };
    }
    expect(found).not.toBeNull();
    const enc = legacyEncrypt(found.pt, found.ivHex);
    expect(enc.slice(2, 8)).toBe("76323a");   // starts with "v2:"
    expect(openField(enc, "\\x" + found.ivHex)).toEqual({ plaintext: found.pt, version: 1 });
  });

  it("rejects tampered ciphertext", () => {
    const enc = encryptField("secret");
    // Flip the last hex nibble (part of the GCM auth tag) -> auth failure.
    const tampered = enc.slice(0, -1) + (enc.slice(-1) === "0" ? "1" : "0");
    expect(() => decryptField(tampered)).toThrow();
  });

  it("rejects a value whose IV was altered", () => {
    const enc = encryptField("secret");
    const b = bytesOf(enc);
    b[3] ^= 0x01;   // first IV byte
    expect(() => decryptField("\\x" + b.toString("hex"))).toThrow();
  });

  it("encryption fails fast when the master key is wrong length", () => {
    const prev = process.env.ANVIL_SECRETS_KEY;
    process.env.ANVIL_SECRETS_KEY = "deadbeef";
    try { expect(() => encryptField("x")).toThrow(); }
    finally { process.env.ANVIL_SECRETS_KEY = prev; }
  });
});

describe("secrets / NetSuite bundle", () => {
  it("encryptNetsuiteCreds + decryptNetsuiteCreds round-trip with no bundle IV", () => {
    const enc = encryptNetsuiteCreds({
      consumer_key: "CK", consumer_secret: "CS",
      token_id: "TI", token_secret: "TS",
    });
    expect(enc).not.toHaveProperty("netsuite_creds_iv");
    // Plaintext columns are written as null.
    expect(enc.netsuite_consumer_key).toBeNull();
    expect(enc.netsuite_token_secret).toBeNull();
    const ivs = [enc.netsuite_consumer_key_enc, enc.netsuite_consumer_secret_enc,
      enc.netsuite_token_id_enc, enc.netsuite_token_secret_enc].map(ivOf);
    expect(new Set(ivs).size).toBe(4);
    const back = decryptNetsuiteCreds({ netsuite_account_id: "1234567", ...enc });
    expect(back.netsuite_consumer_key).toBe("CK");
    expect(back.netsuite_consumer_secret).toBe("CS");
    expect(back.netsuite_token_id).toBe("TI");
    expect(back.netsuite_token_secret).toBe("TS");
  });

  it("decryptNetsuiteCreds still reads a row written in the old format", () => {
    const ivHex = "abcdefabcdefabcdefabcdef";
    const back = decryptNetsuiteCreds({
      netsuite_consumer_key_enc: legacyEncrypt("OCK", ivHex),
      netsuite_consumer_secret_enc: legacyEncrypt("OCS", ivHex),
      netsuite_token_id_enc: legacyEncrypt("OTI", ivHex),
      netsuite_token_secret_enc: legacyEncrypt("OTS", ivHex),
      netsuite_creds_iv: "\\x" + ivHex,
    });
    expect(back.netsuite_consumer_key).toBe("OCK");
    expect(back.netsuite_token_secret).toBe("OTS");
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

  it("refuses to build a NetSuite patch without ANVIL_SECRETS_KEY (no plaintext fallback)", () => {
    const prev = process.env.ANVIL_SECRETS_KEY;
    delete process.env.ANVIL_SECRETS_KEY;
    try {
      let err = null;
      try { encryptNetsuiteCreds({ consumer_key: "CK", consumer_secret: "CS", token_id: "TI", token_secret: "TS" }); }
      catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(err.status).toBe(400);
      expect(err.code).toBe("ANVIL_SECRETS_KEY_MISSING");
      expect(() => requireSecretsConfigured()).toThrow();
    } finally {
      process.env.ANVIL_SECRETS_KEY = prev;
    }
    expect(() => requireSecretsConfigured()).not.toThrow();
  });
});
