// Unit tests for tally-client v2 helpers. Confirms:
//   - tallyEncryptedTokenColumns picks plaintext when no key, encrypts
//     bytea + iv when ANVIL_SECRETS_KEY is set, returns nulls when
//     the input token is null.
//   - tallyDecryptToken round-trips encrypted columns and falls back
//     to plaintext.
//   - tallyIsRecoverable matches the documented HTTP class set.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  tallyEncryptedTokenColumns, tallyDecryptToken, tallyIsRecoverable,
} from "../api/_lib/tally-client.js";

const HEX_KEY = "b".repeat(64);

beforeAll(() => { process.env.ANVIL_SECRETS_KEY = HEX_KEY; });
afterAll(() => { delete process.env.ANVIL_SECRETS_KEY; });

describe("tally-client / token helpers", () => {
  it("encrypts the token when the master key is configured", () => {
    const cols = tallyEncryptedTokenColumns("super-secret");
    expect(cols.bridge_token).toBeNull();
    expect(Buffer.isBuffer(cols.bridge_token_enc)).toBe(true);
    expect(Buffer.isBuffer(cols.bridge_iv)).toBe(true);
  });

  it("returns nulls for a null token", () => {
    const cols = tallyEncryptedTokenColumns(null);
    expect(cols).toEqual({ bridge_token: null, bridge_token_enc: null, bridge_iv: null });
  });

  it("falls back to plaintext when ANVIL_SECRETS_KEY is unset", () => {
    delete process.env.ANVIL_SECRETS_KEY;
    const cols = tallyEncryptedTokenColumns("plain");
    expect(cols.bridge_token).toBe("plain");
    expect(cols.bridge_token_enc).toBeNull();
    process.env.ANVIL_SECRETS_KEY = HEX_KEY;
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
