// Regression test for the passkey registration flow.
// Symptom the user hit:
//   "excludeCredential id 'pending::a2433e6f-...::1778068977088' is
//    not a valid base64url string"
//
// Cause: register_begin SELECTed every row in user_passkeys for the
// user, including the placeholder rows with credential_id like
// "pending::<uuid>::<ts>" that are written for challenge state.
// Those went straight into excludeCredentials, and
// @simplewebauthn/server tried to base64url-decode them and threw.
//
// Fix: filter out `credential_id like 'pending::%'` so only real
// passkeys (with base64url credential ids) are excluded.
//
// This test reads the source of register_begin.js directly. We don't
// boot the handler because that requires WebAuthn + Supabase env vars;
// asserting the SQL filter is present is enough to lock the bug shut.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/auth/passkey/register_begin.js"),
  "utf8",
);

describe("passkey register_begin: exclude pending placeholders", () => {
  it("filters credential_id like 'pending::%' from excludeCredentials select", () => {
    // The SQL select that builds the excludeCredentials list must
    // filter out the placeholder rows. Look for a query against
    // user_passkeys that combines a user_id eq with the not-pending
    // filter, which is the exact contract.
    const queryRe = /from\(\s*["']user_passkeys["']\s*\)[\s\S]{0,400}\.eq\(\s*["']user_id["'][\s\S]{0,400}\.not\(\s*["']credential_id["']\s*,\s*["']like["']\s*,\s*["']pending::%["']\s*\)/;
    expect(SRC).toMatch(queryRe);
  });

  it("auth_begin uses the same filter (already shipped, sanity-check)", () => {
    const ab = readFileSync(
      resolve(process.cwd(), "src/api/auth/passkey/auth_begin.js"),
      "utf8",
    );
    expect(ab).toMatch(/\.not\(\s*["']credential_id["']\s*,\s*["']like["']\s*,\s*["']pending::%["']\s*\)/);
  });
});
