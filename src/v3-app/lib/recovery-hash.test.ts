// Unit tests for the Supabase password-recovery hash detector.
// Bug fix May 2026: a recovery email link of the shape
// "https://<host>/#access_token=...&type=recovery&..." was
// hitting App.tsx's default-route fallback because parseRoute
// treated the entire hash as an unknown route id and landed
// the user on the marketing page.

import { describe, it, expect } from "vitest";
import { looksLikeRecoveryHash } from "./recovery-hash";

describe("looksLikeRecoveryHash", () => {
  it("returns true for the canonical Supabase recovery URL", () => {
    const hash = "#access_token=eyJhbGciOiJFUzI1NiIsImtpZCI&expires_at=1778222383&expires_in=3600&refresh_token=6k56ndnjcfx5&sb=&token_type=bearer&type=recovery";
    expect(looksLikeRecoveryHash(hash)).toBe(true);
  });

  it("returns true when only type=recovery is present at the start", () => {
    expect(looksLikeRecoveryHash("#type=recovery&access_token=abc")).toBe(true);
  });

  it("returns false for the legacy '#/reset?access_token=...' shape (handled by RESOLVERS)", () => {
    // The legacy shape carries the "reset" route id directly, so
    // the existing RESOLVERS lookup in parseRoute handles it
    // without this helper firing. We document the contract here:
    // looksLikeRecoveryHash is only for the canonical Supabase
    // shape where the fragment starts with the recovery params
    // themselves.
    expect(looksLikeRecoveryHash("#/reset?access_token=abc&type=recovery")).toBe(false);
  });

  it("returns false for a normal route hash", () => {
    expect(looksLikeRecoveryHash("#/landing")).toBe(false);
    expect(looksLikeRecoveryHash("#/so?id=abc-123")).toBe(false);
    expect(looksLikeRecoveryHash("#/orders")).toBe(false);
  });

  it("returns false for an empty / null hash", () => {
    expect(looksLikeRecoveryHash("")).toBe(false);
    expect(looksLikeRecoveryHash(null)).toBe(false);
    expect(looksLikeRecoveryHash(undefined)).toBe(false);
  });

  it("does not false-positive on a route that contains 'access_token' as a substring", () => {
    // A defensive check: a hand-crafted (or malicious) URL like
    // "#/some-route?access_token=injected" should NOT route to
    // reset, because the first key is "some-route?access_token"
    // not a known recovery param name.
    expect(looksLikeRecoveryHash("#/some-route?access_token=injected")).toBe(false);
  });

  it("returns true for the refresh_token-led variant", () => {
    expect(looksLikeRecoveryHash("#refresh_token=xxx&type=recovery&access_token=yyy")).toBe(true);
  });
});
