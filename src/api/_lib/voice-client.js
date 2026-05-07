// Phase 5.1: voice-agent client. Wraps Vapi and Retell with a
// uniform interface so the rest of Anvil only sees a single
// "voice" surface. Both providers expose:
//   - a webhook contract (call started / ended / transcript)
//   - a way to programmatically place outbound calls
//   - a way to forward an in-progress call to a human number
//
// We deliberately do NOT pull in either vendor SDK; both APIs are
// thin REST and the SDK overhead isn't worth it for the small
// number of calls made per minute.

import crypto from "node:crypto";
import { decryptField, encryptField, isSecretsConfigured, newIv } from "./secrets.js";
import { safeFetch } from "./safe-fetch.js";

export const voiceDecryptCreds = (s) => {
  if (!s) return s;
  const out = { ...s };
  if (s.api_key_enc && s.creds_iv) {
    try { out.api_key = decryptField(s.api_key_enc, s.creds_iv); }
    catch (_e) { out.api_key = s.api_key || null; }
  }
  return out;
};

export const voiceEncryptCreds = ({ apiKey }) => {
  if (!isSecretsConfigured()) {
    return { api_key: apiKey || null, api_key_enc: null, creds_iv: null };
  }
  const iv = newIv();
  return {
    api_key: null,
    api_key_enc: apiKey ? encryptField(apiKey, iv) : null,
    creds_iv: iv,
  };
};

export const voiceIsConfigured = (s) => !!(s?.provider && s?.api_key);

// Verify Vapi's HMAC signature. Vapi signs the raw body with the
// webhook_secret using HMAC-SHA256 and includes the result in
// `X-Vapi-Signature`. The header value is base64url, no prefix.
export const verifyVapiSignature = (secret, rawBody, signature) => {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Retell signs with X-Retell-Signature. The format is
// `t=<timestamp>,v1=<hex hmac>` where the HMAC is over
// `<timestamp>.<rawBody>` using the webhook secret.
export const verifyRetellSignature = (secret, rawBody, signatureHeader) => {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map((p) => p.split("=")));
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) return false;
  // Reject anything older than 5 minutes.
  const skew = Math.abs(Date.now() / 1000 - Number(ts));
  if (Number.isNaN(skew) || skew > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Place an outbound call. Returns the provider's call id so we can
// pre-create the voice_calls row before the webhook arrives.
export const voicePlaceOutboundCall = async (config, { to, fromAssistantId, metadata }) => {
  if (!voiceIsConfigured(config)) throw new Error("Voice provider not configured");

  if (config.provider === "vapi") {
    const resp = await safeFetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        assistantId: fromAssistantId || config.assistant_id,
        customer: { number: to },
        phoneNumberId: config.phone_number_id,
        metadata: metadata || {},
      }),
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`Vapi outbound: ${resp.status} ${JSON.stringify(body).slice(0, 240)}`);
    return { external_id: body.id, raw: body };
  }

  if (config.provider === "retell") {
    const resp = await safeFetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_number: config.phone_number,
        to_number: to,
        agent_id: fromAssistantId || config.assistant_id,
        metadata: metadata || {},
      }),
    });
    const body = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error(`Retell outbound: ${resp.status} ${JSON.stringify(body).slice(0, 240)}`);
    return { external_id: body.call_id, raw: body };
  }

  throw new Error("Unknown voice provider: " + config.provider);
};

// Forward an in-progress call to a human. Provider-specific.
export const voiceForwardCall = async (config, { callId, toNumber }) => {
  if (config.provider === "vapi") {
    const resp = await safeFetch(`https://api.vapi.ai/call/${callId}/forward`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ destinationNumber: toNumber }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Vapi forward: ${resp.status} ${text.slice(0, 240)}`);
    }
    return { ok: true };
  }
  if (config.provider === "retell") {
    const resp = await safeFetch(`https://api.retellai.com/v2/transfer-call/${callId}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transfer_to: toNumber }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Retell transfer: ${resp.status} ${text.slice(0, 240)}`);
    }
    return { ok: true };
  }
  throw new Error("Unknown voice provider: " + config.provider);
};

// Normalise a webhook payload into the canonical Anvil shape:
//   { event_type, external_id, direction, transcript, summary,
//     duration_seconds, ended_reason, structured_actions }
export const normalisePayload = (provider, payload) => {
  if (provider === "vapi") {
    const msg = payload.message || payload;
    return {
      event_type: msg.type || "unknown",            // "status-update" | "end-of-call-report" | "tool-calls" | ...
      external_id: msg.call?.id || payload.call?.id || null,
      direction: msg.call?.type === "outboundPhoneCall" ? "outbound" : "inbound",
      caller_phone_number: msg.call?.customer?.number || null,
      callee_phone_number: msg.call?.phoneNumber?.number || null,
      transcript: (msg.artifact?.messages || msg.transcript || []).map((m) => ({
        role: m.role,
        text: m.message || m.text || m.content,
        ts: m.time || m.timestamp,
      })),
      summary: msg.summary || msg.analysis?.summary || null,
      duration_seconds: msg.durationSeconds || msg.call?.endedReason ? msg.call?.duration : null,
      ended_reason: msg.endedReason || null,
      structured_actions: msg.toolCalls || msg.analysis?.structuredData || null,
      raw: payload,
    };
  }
  if (provider === "retell") {
    return {
      event_type: payload.event || "unknown",       // "call_started" | "call_ended" | "call_analyzed"
      external_id: payload.call?.call_id || payload.call_id || null,
      direction: payload.call?.direction || (payload.call?.from_number ? "inbound" : "outbound"),
      caller_phone_number: payload.call?.from_number || null,
      callee_phone_number: payload.call?.to_number || null,
      transcript: (payload.call?.transcript_object || []).map((m) => ({
        role: m.role,
        text: m.content,
        ts: m.words?.[0]?.start,
      })),
      summary: payload.call?.call_analysis?.call_summary || null,
      duration_seconds: payload.call?.duration_ms ? Math.round(payload.call.duration_ms / 1000) : null,
      ended_reason: payload.call?.disconnection_reason || null,
      structured_actions: payload.call?.call_analysis?.custom_analysis_data || null,
      raw: payload,
    };
  }
  return { event_type: "unknown", raw: payload };
};
