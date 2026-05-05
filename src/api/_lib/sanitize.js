// Output sanitisation helpers. Used by handlers that surface
// vendor / library / DB error messages back to the client. Keeps
// secret-bearing strings out of API responses, audit log details,
// and notification bodies.

import crypto from "node:crypto";

// Constant-time string comparison. Returns false when the two
// strings are different lengths (no timing leak about length
// relative to the secret because we always run timingSafeEqual on
// padded buffers of the secret's length).
export const timingSafeEqual = (a, b) => {
  const aBuf = Buffer.from(String(a ?? ""));
  const bBuf = Buffer.from(String(b ?? ""));
  if (aBuf.length !== bBuf.length) {
    // Constant-work pad to bBuf.length to avoid a length-based
    // short-circuit timing leak. The result is always false.
    const pad = Buffer.alloc(bBuf.length);
    crypto.timingSafeEqual(pad, bBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
};

// Common substrings that must never end up in API responses or audit
// rows. The list is conservative; if a real error legitimately
// contains "secret" (rare), the operator can add a negation.
const SECRET_TOKENS = [
  /\bsecret\b/i,
  /\bpassword\b/i,
  /\bclient_secret\b/i,
  /\bapi[_-]?key\b/i,
  /\baccess_token\b/i,
  /\brefresh_token\b/i,
  /\bbearer\s+[A-Za-z0-9._-]{8,}/i,
  /\b[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\b/, // JWT-like
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/, // Stripe key
  /\brk_(live|test)_[A-Za-z0-9]{16,}\b/, // Razorpay key
  /\bxox[bsapr]-[A-Za-z0-9-]{10,}\b/,    // Slack token
];

// Strip likely-secret substrings from a string before logging or
// returning it. Replaces matches with [redacted]. Idempotent on
// already-redacted strings.
export const scrubSecrets = (s) => {
  if (s == null) return s;
  let out = String(s);
  for (const pat of SECRET_TOKENS) out = out.replace(pat, "[redacted]");
  return out;
};

// Generic vendor probe error sanitiser. Used by every ERP connect.js
// to map a probe response into a safe public-facing summary. Never
// returns the raw response body; never returns a status >= 500
// description that leaks vendor topology.
export const safeProbeError = (probe, fallback = "connection_failed") => {
  if (!probe || probe.ok) return null;
  const status = Number(probe.status || 0);
  if (status >= 500) return `Vendor returned HTTP ${status}`;
  // Allowlist a small set of well-known short error codes from the
  // parsed body (never the raw body). Most providers populate a
  // `code` or `error_code` field at the top level when they want
  // the integration to surface a known token.
  const knownCode = probe.body?.code || probe.body?.error_code || probe.body?.error?.code;
  if (knownCode && /^[A-Z0-9_]{3,40}$/.test(String(knownCode))) {
    return String(knownCode);
  }
  // Otherwise fall back to a generic status-based message. The full
  // body is logged server-side by the caller (after scrubSecrets)
  // for debugging.
  return status > 0 ? `HTTP ${status}` : fallback;
};

// Pattern for "is this string safe to echo back into a JSON body
// that will be rendered in operator UI". Used by Slack
// url_verification echo.
export const isAlphaNumDashUnderscore = (s, maxLen = 200) => {
  const str = String(s ?? "");
  return str.length <= maxLen && /^[A-Za-z0-9_-]*$/.test(str);
};
