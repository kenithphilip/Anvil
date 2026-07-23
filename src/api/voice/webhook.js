// /api/voice/webhook?provider=vapi|retell
//
// Single endpoint shared between Vapi and Retell. The provider
// query string lets us route signature verification without
// looking up a config first; we then resolve the tenant by the
// call's phone number (vapi.phoneNumber.number / retell.to_number).
//
// Lifecycle:
//   - call_started / status-update with started:  insert voice_calls row.
//   - transcript snippets:                        append to transcript jsonb.
//   - call_ended / end-of-call-report:            mark completed,
//     persist summary and any structured action_extracted, then
//     enqueue voice_call_actions for each tool call so the agent
//     runner can finish the work.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import {
  normalisePayload,
  verifyVapiSignature,
  verifyRetellSignature,
} from "../_lib/voice-client.js";

const readRaw = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { raw += c; });
  req.on("end", () => resolve(raw));
  req.on("error", reject);
});

const matchTenantConfig = async (svc, provider, payload) => {
  const calleeNumber = payload.callee_phone_number;
  if (!calleeNumber) return null;
  const { data: configs, error } = await svc.from("voice_configs")
    .select("*")
    .eq("provider", provider)
    .eq("active", true);
  // Bug fix May 2026: previously the error was destructured but
  // unused. A DB outage made matchTenantConfig return null which
  // the webhook turned into a 404, prompting the provider to drop
  // the event. Surface the error so the caller can return 5xx and
  // the provider retries.
  if (error) {
    const wrapped = new Error("voice_configs lookup failed: " + error.message);
    wrapped.status = 503;
    throw wrapped;
  }
  return (configs || []).find((c) => c.phone_number === calleeNumber) || null;
};

const upsertCall = async (svc, tenantId, configId, provider, payload) => {
  if (!payload.external_id) return null;
  const { data, error } = await svc.from("voice_calls").upsert({
    tenant_id: tenantId,
    config_id: configId,
    provider,
    external_id: payload.external_id,
    direction: payload.direction || "inbound",
    caller_phone_number: payload.caller_phone_number,
    callee_phone_number: payload.callee_phone_number,
    started_at: new Date().toISOString(),
    status: "in_progress",
    transcript: payload.transcript || [],
    raw: payload.raw,
  }, { onConflict: "tenant_id,provider,external_id" }).select("*").single();
  if (error) throw new Error("voice_calls upsert: " + error.message);
  return data;
};

const finaliseCall = async (svc, callRow, payload) => {
  const status = payload.event_type === "escalated" ? "escalated"
    : payload.ended_reason === "error" ? "failed"
    : "completed";
  const { error } = await svc.from("voice_calls").update({
    ended_at: new Date().toISOString(),
    duration_seconds: payload.duration_seconds,
    status,
    transcript: payload.transcript?.length ? payload.transcript : callRow.transcript,
    summary: payload.summary,
    action_extracted: payload.structured_actions || {},
    raw: payload.raw,
  }).eq("id", callRow.id);
  if (error) throw new Error("voice_calls finalise: " + error.message);

  // Enqueue any tool-call actions the agent emitted. These run
  // out of band: a worker (or the next /api/cron/tick) picks them
  // up and calls the corresponding Anvil endpoint (orders.create
  // for place_order, etc.).
  const actions = Array.isArray(payload.structured_actions)
    ? payload.structured_actions
    : (payload.structured_actions ? [payload.structured_actions] : []);
  for (const a of actions) {
    const action = (a.name || a.action || "note").toLowerCase();
    const allowed = new Set(["place_order", "quote_request", "check_delivery", "verify_customer", "escalate", "note"]);
    if (!allowed.has(action)) continue;
    const ins = await svc.from("voice_call_actions").insert({
      tenant_id: callRow.tenant_id,
      call_id: callRow.id,
      action,
      payload: a.arguments || a.payload || a.parameters || {},
    });
    if (ins.error) {
      // Bug fix May 2026: previously we silently dropped the
      // action insert error. The call would land marked completed
      // with no work queued, and the customer-visible "voice agent
      // took my order" promise was lost. Surface as a
      // processing_event so operators can recover the action from
      // the call's action_extracted payload.
      await svc.from("processing_events").insert({
        tenant_id: callRow.tenant_id,
        case_id: callRow.id,
        event_type: "voice_action_enqueue_failed",
        object_type: "voice_call",
        object_id: callRow.id,
        detail: { action, error: ins.error.message, raw_action: a, severity: "warn" },
      });
    }
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const url = new URL(req.url, "http://x");
    const provider = url.searchParams.get("provider");
    if (!provider || !["vapi", "retell"].includes(provider)) {
      return json(res, 400, { error: { message: "?provider=vapi|retell required" } });
    }
    const raw = await readRaw(req);
    // Voice providers (Vapi, Retell) sometimes send malformed JSON
    // during retries / replay. A SyntaxError here used to crash the
    // request with a generic 500; instead, return a clear 400 so the
    // provider can drop the bad message.
    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch (err) {
      return json(res, 400, {
        error: {
          code: "INVALID_JSON",
          message: "Webhook body is not valid JSON: " + (err.message || "parse error"),
        },
      });
    }

    // Normalise first so we can resolve the tenant by phone number.
    const norm = normalisePayload(provider, payload);
    if (!norm.external_id) {
      return json(res, 200, { ok: true, ignored: "no_call_id" });
    }

    const svc = serviceClient();
    const config = await matchTenantConfig(svc, provider, norm);
    if (!config) {
      return json(res, 404, { error: { message: "No tenant configured for this number" } });
    }

    // Signature check (audit H3, May 2026). Fail closed when the
    // tenant has not configured a webhook_secret: an unsigned
    // webhook must be treated as forged. Previously this branch
    // was conditional on `config.webhook_secret` being truthy,
    // which let an unconfigured tenant accept any payload that
    // matched a phone number. That is enough for an attacker who
    // can guess a tenant's number to inject fake call lifecycle
    // events, transcripts, and downstream voice_call_actions.
    if (!config.webhook_secret) {
      return json(res, 503, {
        error: {
          code: "VOICE_WEBHOOK_NOT_CONFIGURED",
          message: "Voice webhook secret not configured for this tenant.",
        },
      });
    }
    const sig = req.headers[provider === "vapi" ? "x-vapi-signature" : "x-retell-signature"] || "";
    const valid = provider === "vapi"
      ? verifyVapiSignature(config.webhook_secret, raw, sig)
      : verifyRetellSignature(config.webhook_secret, raw, sig);
    if (!valid) return json(res, 403, { error: { message: "Invalid voice webhook signature" } });

    // Lifecycle dispatch. Vapi events: status-update,
    // end-of-call-report, transcript, function-call. Retell events:
    // call_started, call_ended, call_analyzed.
    const isStart = ["status-update", "call_started"].includes(norm.event_type);
    const isEnd = ["end-of-call-report", "call_ended", "call_analyzed"].includes(norm.event_type);

    let call = await svc.from("voice_calls")
      .select("*")
      .eq("tenant_id", config.tenant_id)
      .eq("provider", provider)
      .eq("external_id", norm.external_id)
      .maybeSingle();

    if (!call.data && (isStart || isEnd)) {
      call = { data: await upsertCall(svc, config.tenant_id, config.id, provider, norm) };
    }
    if (call.data && isEnd) {
      await finaliseCall(svc, call.data, norm);
    }

    return json(res, 200, { ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}
