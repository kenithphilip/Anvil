// Shared helpers for Phase 5.2 multi-channel inbound. The
// per-channel adapters (whatsapp / slack / teams) call into this
// to ingest a normalised message and route it through the same
// downstream extraction pipeline as inbound email.

import crypto from "node:crypto";
import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";

// Encrypt the channel-specific creds bag as a single JSON blob.
// On decrypt we parse back to an object. This keeps the schema
// generic so a new channel doesn't need a migration.
export const encryptChatCreds = (channel, creds) => {
  const bag = creds || {};
  if (!isSecretsConfigured()) {
    return { creds_plain: bag, creds_enc: null, creds_iv: null };
  }
  const iv = newIv();
  return {
    creds_plain: {},
    creds_enc: encryptField(JSON.stringify(bag), iv),
    creds_iv: iv,
  };
};

export const decryptChatCreds = (config) => {
  if (!config) return {};
  if (config.creds_enc && config.creds_iv) {
    try {
      const decoded = decryptField(config.creds_enc, config.creds_iv);
      return JSON.parse(decoded || "{}");
    } catch (_e) {
      return config.creds_plain || {};
    }
  }
  return config.creds_plain || {};
};

// Verify a Twilio request signature. Twilio signs every webhook
// using HMAC-SHA1 of the URL + sorted form params, base64-encoded.
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
export const verifyTwilioSignature = (authToken, url, params, signature) => {
  if (!authToken || !signature) return false;
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  // Constant-time compare. Both must be the same length first.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Slack: verify the X-Slack-Signature using v0 scheme.
// https://api.slack.com/authentication/verifying-requests-from-slack
export const verifySlackSignature = (signingSecret, timestamp, rawBody, signature) => {
  if (!signingSecret || !signature || !timestamp) return false;
  // Reject requests older than 5 minutes (replay protection).
  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isNaN(skew) || skew > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Persist an inbound message and (best-effort) match it to a known
// customer by their handle. Idempotent on (tenant_id, channel,
// external_id).
export const ingestInboundMessage = async (svc, {
  tenantId, channel, externalId, threadExternalId,
  senderHandle, senderName, textBody, rawPayload, attachments,
}) => {
  if (!tenantId || !channel || !externalId) {
    throw new Error("tenantId, channel, externalId required");
  }
  // Try to resolve the customer by handle. WhatsApp sender_handle
  // is a phone number ("+15551234"); Slack is a user id; Teams is
  // an upn. We match against customers.contact_phone /
  // contact_email / external_ref->slack_user_id when present.
  let customerId = null;
  if (senderHandle) {
    const { data: byPhone } = await svc.from("customers")
      .select("id").eq("tenant_id", tenantId).eq("contact_phone", senderHandle).limit(1).maybeSingle();
    if (byPhone) customerId = byPhone.id;
  }

  const row = {
    tenant_id: tenantId,
    channel,
    external_id: externalId,
    thread_external_id: threadExternalId || null,
    sender_handle: senderHandle || null,
    sender_name: senderName || null,
    text_body: textBody || null,
    raw_payload: rawPayload || {},
    attachments: attachments || [],
    customer_id: customerId,
    status: "arrived",
  };
  const { data, error } = await svc.from("inbound_messages")
    .upsert(row, { onConflict: "tenant_id,channel,external_id", ignoreDuplicates: false })
    .select("*")
    .single();
  if (error) throw new Error("inbound_messages upsert: " + error.message);

  // Update last_seen_at on the channel config if present.
  await svc.from("inbound_chat_configs")
    .update({ last_seen_at: new Date().toISOString(), last_error: null })
    .eq("tenant_id", tenantId)
    .eq("channel", channel);

  return data;
};
