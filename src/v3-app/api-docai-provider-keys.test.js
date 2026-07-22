// Issue #210: the per-tenant DocAI provider-key write-path. Keys are encrypted
// with the shared docai_creds_iv envelope; the pure buildKeyUpdates turns a
// { provider: plaintext|null } map into the tenant_settings column patch.

import { describe, it, expect, beforeAll } from "vitest";

// A valid 64-hex master key so encryptField works under test.
beforeAll(() => { process.env.ANVIL_SECRETS_KEY = "0".repeat(64); });

import { DOCAI_PROVIDERS, buildKeyUpdates } from "../api/admin/docai_provider_keys.js";
import { newIv, decryptField, isSecretsConfigured } from "../api/_lib/secrets.js";

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
    const iv = newIv();
    const { patch, changed } = buildKeyUpdates({ mistral: "sk-mistral-123", gemini: "", nope: "x" }, iv);

    // mistral -> encrypted buffer that decrypts back to the plaintext
    expect(patch.docai_mistral_api_key_enc).toBeInstanceOf(Buffer);
    expect(decryptField(patch.docai_mistral_api_key_enc, iv)).toBe("sk-mistral-123");
    // gemini "" -> cleared
    expect(patch.docai_gemini_api_key_enc).toBeNull();
    // unknown provider ignored (no stray column)
    expect(Object.keys(patch)).toEqual(expect.arrayContaining(["docai_mistral_api_key_enc", "docai_gemini_api_key_enc"]));
    expect(Object.keys(patch)).toHaveLength(2);
    expect(changed).toEqual(["mistral", "gemini"]);
  });

  it("trims whitespace and treats a whitespace-only value as a clear", () => {
    const iv = newIv();
    const { patch } = buildKeyUpdates({ reducto: "   ", llamacloud: "  key-x  " }, iv);
    expect(patch.docai_reducto_api_key_enc).toBeNull();
    expect(decryptField(patch.docai_llamacloud_api_key_enc, iv)).toBe("key-x");
  });
});
