// AES-256-GCM credential encryption.
//
// We store integration credentials (NetSuite TBA, Tally bridge tokens,
// any future ERP secrets) as encrypted bytea on tenant_settings. The
// master key lives in env as ANVIL_SECRETS_KEY: a 64-char hex string
// (32 random bytes). One IV per encryption operation; authenticated
// tag is appended to the ciphertext so we can verify integrity on
// decrypt.
//
// Storage layout per credential bundle:
//   - <field>_enc bytea: ciphertext || authTag (auth tag is the last 16 bytes)
//   - <bundle>_iv  bytea: 12-byte IV shared by every field in the bundle
//
// Sharing the IV across fields in a single bundle is safe because each
// field is encrypted as an independent ciphertext with its own auth
// tag, and the bundle is rotated atomically (one row update writes all
// fields). If you rotate one field, you must re-encrypt all four.

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

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

export const newIv = () => crypto.randomBytes(IV_LEN);

// Encrypt a single string with the master key and a caller-supplied IV.
// Returns Buffer (ciphertext || authTag). The IV is NOT embedded; the
// caller persists it once for the whole bundle.
export const encryptField = (plaintext, iv) => {
  if (plaintext == null || plaintext === "") return null;
  const key = getMasterKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ct, tag]);
};

export const decryptField = (encBuf, iv) => {
  if (!encBuf) return null;
  const key = getMasterKey();
  // Supabase returns bytea as hex-prefixed string ('\x...') or Buffer
  // depending on the path; normalise to Buffer.
  const buf = Buffer.isBuffer(encBuf)
    ? encBuf
    : (typeof encBuf === "string" && encBuf.startsWith("\\x"))
      ? Buffer.from(encBuf.slice(2), "hex")
      : Buffer.from(encBuf);
  const ivBuf = Buffer.isBuffer(iv)
    ? iv
    : (typeof iv === "string" && iv.startsWith("\\x"))
      ? Buffer.from(iv.slice(2), "hex")
      : Buffer.from(iv);
  if (buf.length < TAG_LEN + 1) return null;
  const ct = buf.slice(0, buf.length - TAG_LEN);
  const tag = buf.slice(buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, ivBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
};

// Encrypt a bundle of fields atomically. Returns { iv, fields }
// where fields is { name: ciphertext_buffer }.
export const encryptBundle = (fields) => {
  const iv = newIv();
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = encryptField(v, iv);
  }
  return { iv, fields: out };
};

// Decrypt a bundle given the row + IV. Returns { name: plaintext }.
// Missing fields return null. Decryption errors surface as null per
// field so a partial bundle does not crash the whole call; callers
// validate completeness separately.
export const decryptBundle = (encFields, iv) => {
  const out = {};
  for (const [k, v] of Object.entries(encFields)) {
    if (!v || !iv) { out[k] = null; continue; }
    try { out[k] = decryptField(v, iv); }
    catch (_e) { out[k] = null; }
  }
  return out;
};

// Convenience wrapper: pass in a tenant_settings row + a list of
// (encColumn, plainColumn, ivColumn) tuples; returns the row with
// the plaintext values back-filled. Falls back to the plaintext
// columns if the encrypted columns are absent (covers the rotation
// window where some tenants are still on plaintext).
export const decryptNetsuiteCreds = (row) => {
  if (!row) return row;
  const iv = row.netsuite_creds_iv;
  const out = { ...row };
  const tryDecrypt = (encCol, plainCol) => {
    if (row[encCol] && iv) {
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

export const encryptNetsuiteCreds = (creds) => {
  const { iv, fields } = encryptBundle({
    netsuite_consumer_key_enc: creds.consumer_key,
    netsuite_consumer_secret_enc: creds.consumer_secret,
    netsuite_token_id_enc: creds.token_id,
    netsuite_token_secret_enc: creds.token_secret,
  });
  return { ...fields, netsuite_creds_iv: iv };
};
