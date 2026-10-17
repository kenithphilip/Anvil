// Issue #210: the per-tenant DocAI provider-key write-path. Each key is
// encrypted with its own IV (secrets.js v2); the pure buildKeyUpdates turns a
// { provider: plaintext|null } map into the tenant_settings column patch.

import { describe, it, expect, beforeAll } from "vitest";

// A valid 64-hex master key so encryptField works under test.
beforeAll(() => { process.env.ANVIL_SECRETS_KEY = "0".repeat(64); });

import { DOCAI_PROVIDERS, buildKeyUpdates } from "../api/admin/docai_provider_keys.js";
import { decryptField, isSecretsConfigured } from "../api/_lib/secrets.js";

// v2 layout: "v2:" (3 bytes) || iv (12 bytes) || ciphertext || tag.
const ivOf = (enc) => Buffer.from(enc.slice(2), "hex").subarray(3, 15).toString("hex");

describe("DOCAI_PROVIDERS", () => {
  it("covers every provider incl. the previously env-only mistral + gst", () => {
    const ids = DOCAI_PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["gemini", "mistral", "reducto", "unstructured", "docling", "marker", "llamacloud", "gst"]));
    // each maps to an _enc column and declares residency
    expect(DOCAI_PROVIDERS.every((p) => /_enc$/.test(p.col) && typeof p.external === "boolean" && p.region)).toBe(true);
    expect(DOCAI_PROVIDERS.find((p) => p.id === "mistral").col).toBe("docai_mistral_api_key_enc");
    expect(DOCAI_PROVIDERS.find((p) => p.id === "gst").col).toBe("gst_provider_api_key_enc");
  });
});

describe("buildKeyUpdates", () => {
  it("encrypts a non-empty key (round-trips), clears on empty, skips unknown providers", () => {
    expect(isSecretsConfigured()).toBe(true);   // the test key is set
    const { patch, changed } = buildKeyUpdates({ mistral: "sk-mistral-123", gemini: "", nope: "x" });

    // mistral -> a bytea '\x'-hex STRING (NOT a Buffer — a Buffer never lands in
    // the bytea column through supabase-js) that decrypts back to the plaintext.
    expect(typeof patch.docai_mistral_api_key_enc).toBe("string");
    expect(patch.docai_mistral_api_key_enc.startsWith("\\x")).toBe(true);
    expect(decryptField(patch.docai_mistral_api_key_enc)).toBe("sk-mistral-123");
    // No shared IV is written: docai_creds_iv stays as it is.
    expect(patch).not.toHaveProperty("docai_creds_iv");
    // gemini "" -> cleared
    expect(patch.docai_gemini_api_key_enc).toBeNull();
    // unknown provider ignored (no stray column)
    expect(Object.keys(patch)).toEqual(expect.arrayContaining(["docai_mistral_api_key_enc", "docai_gemini_api_key_enc"]));
    expect(Object.keys(patch)).toHaveLength(2);
    expect(changed).toEqual(["mistral", "gemini"]);
  });

  it("trims whitespace and treats a whitespace-only value as a clear", () => {
    const { patch } = buildKeyUpdates({ reducto: "   ", llamacloud: "  key-x  " });
    expect(patch.docai_reducto_api_key_enc).toBeNull();
    expect(decryptField(patch.docai_llamacloud_api_key_enc)).toBe("key-x");
  });
});

describe("buildKeyUpdates — one IV per key", () => {
  it("gives every key in one save its own IV", () => {
    const { patch } = buildKeyUpdates({ gemini: "k-gemini", mistral: "k-mistral", reducto: "k-reducto" });
    const ivs = [patch.docai_gemini_api_key_enc, patch.docai_mistral_api_key_enc, patch.docai_reducto_api_key_enc].map(ivOf);
    expect(new Set(ivs).size).toBe(3);
  });

  it("gives a key saved later a different IV from a key saved earlier", () => {
    const first = buildKeyUpdates({ gemini: "k-1" }).patch.docai_gemini_api_key_enc;
    const second = buildKeyUpdates({ gemini: "k-2" }).patch.docai_gemini_api_key_enc;
    expect(ivOf(first)).not.toBe(ivOf(second));
    expect(decryptField(first)).toBe("k-1");
    expect(decryptField(second)).toBe("k-2");
  });
});
