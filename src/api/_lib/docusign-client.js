// DocuSign eSignature REST client.
//
// Auth: JWT Grant. Anvil holds the integration key + RSA private
// key + impersonating user id; we mint a JWT signed RS256 with the
// private key, exchange it for an OAuth access token, then call
// /v2.1/accounts/<account_id>/envelopes etc.
//
// We cache the access token in-memory until ~30s before expiry.

import crypto from "node:crypto";
import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

const tokenCache = new Map();
const REFRESH_SLACK_MS = 30_000;

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export const docusignDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol) => {
    if (s[encCol] && s.docusign_creds_iv) {
      try { return decryptField(s[encCol], s.docusign_creds_iv); } catch (_e) { return null; }
    }
    return null;
  };
  out.docusign_rsa_private_key = tryDec("docusign_rsa_private_key_enc");
  return out;
};

export const docusignEncryptCreds = ({ rsa_private_key }) => {
  if (!isSecretsConfigured()) {
    return { docusign_rsa_private_key_enc: null, docusign_creds_iv: null, _plaintext_key: rsa_private_key };
  }
  const iv = newIv();
  return {
    docusign_rsa_private_key_enc: encryptField(rsa_private_key, iv),
    docusign_creds_iv: iv,
  };
};

export const docusignIsConfigured = (s) => !!(
  s?.docusign_account_id && s?.docusign_integration_key &&
  s?.docusign_user_id && s?.docusign_rsa_private_key
);

const oauthHost = (basePath) => {
  if (!basePath) return "account-d.docusign.com";
  // Demo / sandbox basePaths point at *.docusign.net but oauth lives
  // at account.docusign.com (prod) or account-d.docusign.com (demo).
  return basePath.includes("demo") ? "account-d.docusign.com" : "account.docusign.com";
};

const acquireToken = async (s) => {
  const key = (s.tenant_id || "shared") + "|" + s.docusign_integration_key;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + REFRESH_SLACK_MS) return cached.token;

  const aud = oauthHost(s.docusign_base_path);
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: s.docusign_integration_key,
    sub: s.docusign_user_id,
    aud,
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };
  const headerB = b64url(JSON.stringify(header));
  const payloadB = b64url(JSON.stringify(payload));
  const data = headerB + "." + payloadB;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), s.docusign_rsa_private_key);
  const jwt = data + "." + b64url(sig);

  const tokenUrl = "https://" + aud + "/oauth/token";
  const resp = await safeFetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  if (!resp.ok || !parsed?.access_token) {
    const err = new Error("DocuSign token: " + resp.status + " " + (parsed?.error_description || parsed?.error || ""));
    err.status = resp.status;
    throw err;
  }
  const ttlMs = (Number(parsed.expires_in) || 3600) * 1000;
  const token = parsed.access_token;
  tokenCache.set(key, { token, expiresAt: Date.now() + ttlMs });
  return token;
};

export const docusignFetch = async (s, { method, path, body }) => {
  if (!docusignIsConfigured(s)) throw new Error("DocuSign not configured for this tenant");
  const token = await acquireToken(s);
  const url = s.docusign_base_path.replace(/\/+$/, "") + path;
  const headers = { Authorization: "Bearer " + token, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const resp = await safeFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

// Convenience: build an envelope from a single PDF (base64) + signers.
export const docusignCreateEnvelope = async (s, { pdfBase64, pdfName, subject, message, signers }) => {
  const documents = [{
    documentBase64: pdfBase64,
    name: pdfName || "document.pdf",
    fileExtension: "pdf",
    documentId: "1",
  }];
  const envelopeSigners = signers.map((sgn, i) => ({
    email: sgn.email,
    name: sgn.name,
    recipientId: String(i + 1),
    routingOrder: String(i + 1),
    tabs: {
      signHereTabs: [{
        anchorString: sgn.anchor || "/sn" + (i + 1) + "/",
        anchorXOffset: "0",
        anchorYOffset: "0",
        anchorIgnoreIfNotPresent: "true",
        anchorUnits: "pixels",
      }],
    },
  }));
  const path = `/v2.1/accounts/${s.docusign_account_id}/envelopes`;
  return docusignFetch(s, {
    method: "POST",
    path,
    body: {
      emailSubject: subject || "Please sign",
      emailBlurb: message || "",
      documents,
      recipients: { signers: envelopeSigners },
      status: "sent",
    },
  });
};

export const docusignGetEnvelope = async (s, envelopeId) =>
  docusignFetch(s, { method: "GET", path: `/v2.1/accounts/${s.docusign_account_id}/envelopes/${envelopeId}` });

export const docusignGetSignedPdf = async (s, envelopeId) =>
  docusignFetch(s, { method: "GET", path: `/v2.1/accounts/${s.docusign_account_id}/envelopes/${envelopeId}/documents/combined` });

// Webhook (Connect) signature verification: HMAC-SHA256 over the
// raw body using docusign_webhook_secret, base64-encoded in the
// X-DocuSign-Signature-1 header.
export const docusignVerifyWebhook = (rawBody, signatureHeader, secret) => {
  if (!signatureHeader || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (_e) { return false; }
};
