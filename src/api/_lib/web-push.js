// W3C Web Push helper.
//
// Sending a push: we generate a JWT signed with the VAPID private
// key (P-256 ECDSA), encrypt the payload to the subscriber's p256dh
// + auth keys (RFC 8291 aes128gcm), and POST to the subscription's
// endpoint URL with TTL + Authorization headers.
//
// We deliberately keep this minimal-dependency: no `web-push` npm
// package. Only Node's crypto + a small ECE encoder is needed.
//
// For dev / staging without VAPID keys, pushNotify() short-circuits
// to a logged "would-have-sent" event so devs can ship features
// without standing up a key pair.

import crypto from "node:crypto";
import { safeFetch } from "./safe-fetch.js";

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:ops@anvil.example";

export const webPushIsConfigured = () => !!(VAPID_PUBLIC && VAPID_PRIVATE);

const b64urlEncode = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s) => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
};

// Build a VAPID JWT for the given audience.
const vapidJwt = (audience) => {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: VAPID_SUBJECT,
  };
  const headerB = b64urlEncode(JSON.stringify(header));
  const payloadB = b64urlEncode(JSON.stringify(payload));
  const data = headerB + "." + payloadB;
  // Build a P-256 private key from the VAPID raw private bytes.
  const privBuf = b64urlDecode(VAPID_PRIVATE);
  // Convert raw 32-byte private key to a PKCS#8 envelope (ASN.1)
  // so node's crypto can sign with it.
  const pkcs8 = Buffer.concat([
    Buffer.from("3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"),
    privBuf,
  ]);
  const keyObj = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const sig = crypto.sign("sha256", Buffer.from(data), {
    key: keyObj,
    dsaEncoding: "ieee-p1363",
  });
  return data + "." + b64urlEncode(sig);
};

// HKDF helper (used in aes128gcm encoding).
const hkdf = (salt, ikm, info, length) => {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  let okm = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  let counter = 1;
  while (okm.length < length) {
    prev = crypto.createHmac("sha256", prk)
      .update(prev).update(info).update(Buffer.from([counter]))
      .digest();
    okm = Buffer.concat([okm, prev]);
    counter += 1;
  }
  return okm.slice(0, length);
};

// Encrypt a payload to the subscription's p256dh + auth keys using
// the aes128gcm content-coding (RFC 8188).
const encryptPayload = (subscription, plaintext) => {
  const userAgentPub = b64urlDecode(subscription.p256dh);
  const userAgentAuth = b64urlDecode(subscription.auth);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const localPub = ecdh.getPublicKey(null, "uncompressed");
  const sharedSecret = ecdh.computeSecret(userAgentPub);
  const salt = crypto.randomBytes(16);

  // ikm = HKDF(auth, sharedSecret, "WebPush: info\0" || ua_pub || local_pub, 32)
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    userAgentPub,
    localPub,
  ]);
  const ikm = hkdf(userAgentAuth, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // Pad: 0x02 (last record) + body.
  const padded = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedBody = Buffer.concat([ct, tag]);

  // aes128gcm header: salt(16) || rs(4 BE = 4096) || idlen(1) || keyid
  const header = Buffer.concat([
    salt,
    Buffer.from([0, 0, 0x10, 0]),     // record size 4096
    Buffer.from([localPub.length]),
    localPub,
  ]);
  return Buffer.concat([header, encryptedBody]);
};

export const sendWebPush = async (subscription, payload, opts = {}) => {
  if (!webPushIsConfigured()) {
    return { ok: false, status: 0, error: "VAPID keys missing", skipped: true };
  }
  if (!subscription?.endpoint) {
    return { ok: false, status: 0, error: "subscription has no endpoint" };
  }
  const url = new URL(subscription.endpoint);
  const audience = url.origin;
  const jwt = vapidJwt(audience);
  const body = encryptPayload(subscription, JSON.stringify(payload));
  const ttl = String(opts.ttl ?? 60);
  const resp = await safeFetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: "vapid t=" + jwt + ", k=" + VAPID_PUBLIC,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: ttl,
      "Content-Length": String(body.length),
    },
    body,
  });
  return {
    ok: resp.ok,
    status: resp.status,
    expired: resp.status === 404 || resp.status === 410,
  };
};
