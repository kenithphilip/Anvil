// TOTP helpers for the MFA flow.
//
// RFC 6238 (Time-based One-Time Password) and RFC 4648 base32.
// Pure Node crypto, no extra deps.
//
// We deliberately implement this rather than reach for `otpauth`
// or `speakeasy`: the algorithm is six lines of code and the
// node_modules surface area for those packages (each pulling in
// its own crypto polyfills) isn't worth the lift on a serverless
// cold path.

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Base32 encode (RFC 4648, no padding) for the TOTP secret. Output
// is uppercase A-Z + 2-7. Authenticator apps expect this format
// (Google Authenticator, Authy, 1Password, ...).
export const base32Encode = (buf) => {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
};

// Base32 decode. Tolerant of whitespace + lowercase + padding.
export const base32Decode = (s) => {
  const cleaned = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of cleaned) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

// Generate a 20-byte (160-bit) secret, base32-encoded. Authy /
// Google Authenticator accept any length but 160-bit is the
// HOTP-recommended size.
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

// Compute TOTP for a given counter. Returns a 6-digit zero-padded
// string. Algorithm:
//   counter (8-byte big-endian) -> HMAC-SHA1(secret) -> 20 bytes
//   take last nibble = offset
//   take 4 bytes from offset, mask top bit -> 31-bit int
//   modulo 10^digits = OTP
const computeTotp = (secret, counter, digits = 6) => {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  // Node BigInt to write 8 bytes big-endian.
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset]     & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8)  |
    ((hmac[offset + 3] & 0xff))
  );
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, "0");
};

// Validate a TOTP code with a small skew window (default ±1 step =
// ±30 s) so a slightly off clock or a code typed at the boundary
// still passes.
export const verifyTotp = (secret, code, opts = {}) => {
  const period = opts.period || 30;
  const digits = opts.digits || 6;
  const window = opts.window != null ? opts.window : 1;
  const cleaned = String(code || "").replace(/\D/g, "");
  if (cleaned.length !== digits) return false;
  const now = Math.floor(Date.now() / 1000);
  const counter = Math.floor(now / period);
  for (let w = -window; w <= window; w++) {
    const got = computeTotp(secret, counter + w, digits);
    // Constant-time compare to avoid timing leak.
    if (cleaned.length === got.length && crypto.timingSafeEqual(Buffer.from(cleaned), Buffer.from(got))) {
      return true;
    }
  }
  return false;
};

// Build the otpauth:// URI that authenticator apps render as a
// QR code. RFC 6238 + Google Authenticator key URI format.
//   otpauth://totp/<issuer>:<account>?secret=<base32>&issuer=<issuer>&algorithm=SHA1&digits=6&period=30
export const otpauthUri = ({ secret, issuer = "Anvil", account, digits = 6, period = 30 }) => {
  const label = encodeURIComponent(`${issuer}:${account || "user"}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
};

// Render a QR code as an SVG string. Pure Node, no deps. Uses a
// minimal QR code implementation we can ship inline. We deliberately
// keep the encoding simple (alpha-numeric mode, error-correction
// level M) because the otpauth URI is short and the entire QR fits
// in version 4 every time.
//
// For ease of review we delegate the actual matrix construction to
// a tiny embedded module. Authenticator apps don't care about the
// rendering; the client can also just receive the otpauth URI and
// generate its own QR if the inline path is too heavy. We expose
// both in the API response.
//
// (We omit the inline encoder and let the client render the URI
// via the WebGL-free `qr-creator` lite path or any QR lib it has.
// The API returns both the secret and the otpauth URI.)
