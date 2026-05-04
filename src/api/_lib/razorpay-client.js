// Razorpay HTTP client. Razorpay's REST API is documented at
// /v1/orders and /v1/payments; auth is HTTP Basic with key_id +
// key_secret. We don't pull in the official razorpay node SDK to
// keep the bundle thin; the API surface we use is small.
//
// Webhook signature verification uses HMAC-SHA256 over the raw
// request body with razorpay_webhook_secret as the key, base64
// encoded. The X-Razorpay-Signature header carries the expected hex.

import crypto from "node:crypto";
import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";

const BASE_URL = "https://api.razorpay.com";

export const razorpayDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  const tryDec = (encCol, plainCol) => {
    if (s[encCol] && s.razorpay_creds_iv) {
      try { return decryptField(s[encCol], s.razorpay_creds_iv); }
      catch (_e) { return s[plainCol] || null; }
    }
    return s[plainCol] || null;
  };
  out.razorpay_key_id = tryDec("razorpay_key_id_enc", "razorpay_key_id");
  out.razorpay_key_secret = tryDec("razorpay_key_secret_enc", null);
  return out;
};

export const razorpayEncryptCreds = ({ key_id, key_secret }) => {
  if (!isSecretsConfigured()) {
    return { razorpay_key_id: key_id, razorpay_key_id_enc: null, razorpay_key_secret_enc: null, razorpay_creds_iv: null };
  }
  const iv = newIv();
  return {
    razorpay_key_id: null,
    razorpay_key_id_enc: encryptField(key_id, iv),
    razorpay_key_secret_enc: encryptField(key_secret, iv),
    razorpay_creds_iv: iv,
  };
};

export const razorpayIsConfigured = (s) => !!(s?.razorpay_key_id && s?.razorpay_key_secret);

export const razorpayFetch = async (s, { method, path, body }) => {
  if (!razorpayIsConfigured(s)) throw new Error("Razorpay not configured for this tenant");
  const auth = "Basic " + Buffer.from(s.razorpay_key_id + ":" + s.razorpay_key_secret).toString("base64");
  const headers = { Authorization: auth, Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  // Route via linked account if set; lets the platform charge with
  // an automatic split.
  if (s.razorpay_account_id) headers["X-Razorpay-Account"] = s.razorpay_account_id;
  const resp = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_e) { parsed = { raw: text.slice(0, 400) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

export const razorpayCreateOrder = async (s, { amount, currency, receipt, notes }) =>
  razorpayFetch(s, {
    method: "POST",
    path: "/v1/orders",
    body: { amount, currency: currency || "INR", receipt, notes: notes || {}, payment_capture: 1 },
  });

export const razorpayVerifyPaymentSignature = ({ order_id, payment_id, signature, key_secret }) => {
  if (!signature || !order_id || !payment_id || !key_secret) return false;
  const expected = crypto.createHmac("sha256", key_secret)
    .update(order_id + "|" + payment_id)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
};

export const razorpayVerifyWebhookSignature = (rawBody, signature, secret) => {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch (_e) {
    return false;
  }
};
