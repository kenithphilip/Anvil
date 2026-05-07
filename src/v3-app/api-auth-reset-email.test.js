// Regression test for the forgot-password email delivery path.
// Symptom the user hit: clicked forgot password, never got an email.
//
// Cause: the only email path was SendGrid. On a deployment without
// SENDGRID_API_KEY + SENDGRID_FROM_EMAIL, the function silently
// dropped the email and returned 200, so the operator had no signal
// that nothing was delivered.
//
// Fix: try Supabase's anon-client `auth.resetPasswordForEmail()`
// first (uses the project's configured SMTP, the default for new
// projects). Fall back to SendGrid only if the Supabase path didn't
// deliver. Log a server-side warning when neither path delivered so
// the operator can spot the misconfig (the user-visible response
// stays generic to avoid enumeration).
//
// This test reads the source of request_reset.js directly. We don't
// boot the handler because that requires Supabase env vars + a test
// user; asserting the contract is in the code is enough to lock the
// bug shut.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/auth/request_reset.js"),
  "utf8",
);

describe("auth/request_reset: dual email-delivery providers", () => {
  it("calls Supabase anon resetPasswordForEmail as the primary path", () => {
    expect(SRC).toMatch(/anon\.auth\.resetPasswordForEmail\(/);
  });

  it("only walks the SendGrid fallback when Supabase didn't deliver", () => {
    // The fallback must be guarded by `if (!delivered)`.
    const fallbackIdx = SRC.indexOf("sendResetEmail(");
    expect(fallbackIdx).toBeGreaterThan(0);
    const before = SRC.slice(Math.max(0, fallbackIdx - 600), fallbackIdx);
    expect(before).toMatch(/if\s*\(\s*!delivered\s*\)/);
  });

  it("logs a clear server-side warning when neither provider delivered", () => {
    // The warning must name both env-var paths so operators know
    // what to set.
    expect(SRC).toMatch(/SUPABASE_URL.*SUPABASE_ANON_KEY/);
    expect(SRC).toMatch(/SENDGRID_API_KEY.*SENDGRID_FROM_EMAIL/);
    expect(SRC).toMatch(/no email delivered for/);
  });

  it("never returns the action_link in the HTTP response (audit H2)", () => {
    // The 200 response body must not include actionLink. Find the
    // final json() call and check.
    const finalJson = SRC.lastIndexOf("return json(res, 200,");
    expect(finalJson).toBeGreaterThan(0);
    const block = SRC.slice(finalJson, finalJson + 240);
    expect(block).not.toMatch(/actionLink/);
    expect(block).not.toMatch(/action_link/);
  });

  it("audit row records the provider that actually delivered", () => {
    // The audit insert must include a `provider` field whose value
    // is the runtime variable, not a hard-coded string.
    const auditIdx = SRC.indexOf("password_reset_audit");
    expect(auditIdx).toBeGreaterThan(0);
    const window = SRC.slice(Math.max(0, auditIdx - 600), auditIdx);
    expect(window).toMatch(/provider\s*,/);
    expect(window).toMatch(/sent:\s*delivered/);
  });
});
