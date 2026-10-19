// AES-256-GCM credential encryption.
//
// We store integration credentials (NetSuite TBA, Tally bridge tokens,
// DocAI provider keys, any future ERP secrets) encrypted in *_enc columns
// on tenant_settings and a few per-integration tables. The master key
// lives in env as ANVIL_SECRETS_KEY: a 64-char hex string (32 random
// bytes).
//
// Value format (v2, the only format encryptField writes):
//   "v2:" (3 ASCII bytes) || iv (12 random bytes) || ciphertext || authTag (16 bytes)
// Every value carries its own fresh IV. Callers persist the one value in
// its *_enc column and nothing else.
//
// Legacy format (v1, read only): ciphertext || authTag, with the IV in a
// separate <bundle>_iv column. decryptField still reads v1 when the caller
// passes that IV, so stored values keep working until
// /api/admin/secrets_reencrypt rewrites them as v2. The *_iv columns are
// read for v1 values only; nothing writes them any more.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const V2_PREFIX = Buffer.from("v2:", "ascii");
const V2_MIN_LEN = V2_PREFIX.length + IV_LEN + 1 + TAG_LEN;

const getMasterKey = () => {
  const raw = process.env.ANVIL_SECRETS_KEY;
  if (!raw) throw new Error("ANVIL_SECRETS_KEY env var is not set");
  if (raw.length !== 64) {
    throw new Error("ANVIL_SECRETS_KEY must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(raw, "hex");
};

export const isSecretsConfigured = () => {
  const raw = process.env.ANVIL_SECRETS_KEY;
  return !!(raw && raw.length === 64);
};

// Credential writers call this before they build a patch. A credential is
// stored encrypted or not at all: there is no plaintext fallback.
export const requireSecretsConfigured = () => {
  if (isSecretsConfigured()) return;
  const err = new Error("ANVIL_SECRETS_KEY is not configured, so credentials cannot be stored. Set it and try again.");
  err.status = 400;
  err.code = "ANVIL_SECRETS_KEY_MISSING";
  throw err;
};

// A stored bytea value MUST reach Postgres as a '\x'-hex STRING. supabase-js
// JSON-serialises the request body, and a Node Buffer becomes
// {"type":"Buffer","data":[...]} — which never lands in a bytea column (the
// ciphertext is silently dropped / stored as garbage, so every provider key,
// TOTP secret and ERP credential read back undecryptable). So the encryption
// boundary EMITS '\x'-hex strings; decryptField already reads that exact form
// back (PostgREST returns bytea reads as '\x'-hex too). Callers persist the
// returned strings directly into the *_enc columns.
const toBuf = (v) => {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string" && v.startsWith("\\x")) return Buffer.from(v.slice(2), "hex");
  return Buffer.from(v);
};
const toByteaHex = (buf) => "\\x" + buf.toString("hex");

// Encrypt a single string with the master key and a fresh random IV.
// Returns a v2 bytea '\x'-hex string, or null for empty input.
export const encryptField = (plaintext) => {
  if (plaintext == null || plaintext === "") return null;
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return toByteaHex(Buffer.concat([V2_PREFIX, iv, ct, cipher.getAuthTag()]));
};

// body = ciphertext || authTag
const gcmOpen = (key, iv, body) => {
  const decipher = crypto.createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(body.subarray(body.length - TAG_LEN));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_LEN)), decipher.final()]).toString("utf8");
};

// Decrypt one stored value and report its format: { plaintext, version }.
// legacyIv is the bundle's *_iv column; only a v1 value needs it. Returns
// null for an empty or too-short value; throws when the value does not
// authenticate.
export const openField = (enc, legacyIv) => {
  if (!enc) return null;
  const key = getMasterKey();
  const buf = toBuf(enc);
  if (buf.length < TAG_LEN + 1) return null;
  let v2Err = null;
  if (buf.length >= V2_MIN_LEN && buf.subarray(0, V2_PREFIX.length).equals(V2_PREFIX)) {
    const iv = buf.subarray(V2_PREFIX.length, V2_PREFIX.length + IV_LEN);
    try { return { plaintext: gcmOpen(key, iv, buf.subarray(V2_PREFIX.length + IV_LEN)), version: 2 }; }
    // A v1 ciphertext can start with the same 3 bytes by chance. The auth
    // tag tells the two apart, so fall through and try v1.
    catch (e) { v2Err = e; }
  }
  if (!legacyIv) throw v2Err || new Error("v1 ciphertext needs its bundle IV");
  try { return { plaintext: gcmOpen(key, toBuf(legacyIv), buf), version: 1 }; }
  catch (e) { throw v2Err || e; }
};

// Decrypt one stored value (v2, or v1 given its bundle IV). Returns the
// plaintext, or null for an empty value. Throws when it does not
// authenticate; callers catch and fall back.
export const decryptField = (enc, legacyIv) => {
  const opened = openField(enc, legacyIv);
  return opened ? opened.plaintext : null;
};

// Convenience wrapper for the NetSuite TBA bundle on tenant_settings:
// returns the row with the plaintext values back-filled. Falls back to
// the plaintext columns if the encrypted columns are absent (rows
// written before the encrypted columns existed).
export const decryptNetsuiteCreds = (row) => {
  if (!row) return row;
  const iv = row.netsuite_creds_iv;
  const out = { ...row };
  const tryDecrypt = (encCol, plainCol) => {
    if (row[encCol]) {
      try { return decryptField(row[encCol], iv); }
      catch (_e) { return row[plainCol] || null; }
    }
    return row[plainCol] || null;
  };
  out.netsuite_consumer_key = tryDecrypt("netsuite_consumer_key_enc", "netsuite_consumer_key");
  out.netsuite_consumer_secret = tryDecrypt("netsuite_consumer_secret_enc", "netsuite_consumer_secret");
  out.netsuite_token_id = tryDecrypt("netsuite_token_id_enc", "netsuite_token_id");
  out.netsuite_token_secret = tryDecrypt("netsuite_token_secret_enc", "netsuite_token_secret");
  return out;
};

// The tenant_settings patch for a NetSuite TBA bundle: the four encrypted
// columns, and the four plaintext columns nulled so dumps never carry them.
export const encryptNetsuiteCreds = (creds) => {
  requireSecretsConfigured();
  return {
    netsuite_consumer_key_enc: encryptField(creds.consumer_key),
    netsuite_consumer_secret_enc: encryptField(creds.consumer_secret),
    netsuite_token_id_enc: encryptField(creds.token_id),
    netsuite_token_secret_enc: encryptField(creds.token_secret),
    netsuite_consumer_key: null,
    netsuite_consumer_secret: null,
    netsuite_token_id: null,
    netsuite_token_secret: null,
  };
};
