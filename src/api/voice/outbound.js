// POST /api/voice/outbound
// Body: {
//   to,                       (required) E.164 destination
//   config_id,                (optional) which voice_configs row to dial from
//   customer_id,              (optional) attribution
//   customer_contact_id,      (optional) attribution
//   reason,                   (optional) free-form note ("AR collection", etc.)
//   metadata,                 (optional) opaque obj passed to provider + stored on the call
// }
//
// Places a compliance-checked outbound voice call. Gates:
//
//   1. Voice config must exist + have outbound_enabled = true.
//   2. Destination must NOT be on the DND list (TRAI NDNC, FCC DNC,
//      tenant-manual, customer-request).
//   3. Active voice_consent row must exist for the destination.
//   4. The recording disclosure for the destination's region is
//      attached to the call so the agent's first utterance carries
//      it.
//
// Audit: DEFERRED_ROADMAP §1 (voice AI). The launch gate that
// blocked this build was "outbound dialler compliance"; this
// endpoint is the integration point for those gates.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { checkOutboundCompliance } from "../_lib/voice-compliance.js";
import { voiceDecryptCreds, voicePlaceOutboundCall } from "../_lib/voice-client.js";

const pickConfig = async (svc, { tenantId, configId }) => {
  let q = svc.from("voice_configs")
    .select("id, tenant_id, provider, api_key, api_key_enc, creds_iv, phone_number, phone_number_id, assistant_id, region, recording_disclosure, recording_disclosure_locale, outbound_enabled, active")
    .eq("tenant_id", tenantId)
    .eq("active", true);
  if (configId) q = q.eq("id", configId);
  const r = await q.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (r.error) throw new Error("voice_configs read: " + r.error.message);
  return r.data || null;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.to) return json(res, 400, { error: { message: "to (E.164 phone number) is required" } });

    const svc = serviceClient();
    const rawConfig = await pickConfig(svc, { tenantId: ctx.tenantId, configId: body.config_id });
    if (!rawConfig) {
      return json(res, 400, { error: { code: "NO_VOICE_CONFIG", message: "No active voice_configs row for this tenant" } });
    }
    // Decrypt the credentials so voicePlaceOutboundCall sees a populated
    // api_key. The DB stores api_key_enc + creds_iv (AES-256-GCM) and
    // voiceIsConfigured asserts on the plaintext field. Without this
    // step every dial would fail with "Voice provider not configured."
    // (P0 from the May 2026 critic audit; the prior fix on PR #58's
    // branch did not survive the squash-merge.)
    const config = voiceDecryptCreds(rawConfig);

    const verdict = await checkOutboundCompliance(svc, {
      tenantId: ctx.tenantId,
      config,
      toNumber: body.to,
    });
    if (!verdict.allowed) {
      // Audit the refused dial. Keeps a trail for "why didn't this
      // call happen?" investigations and SOC2 evidence that we
      // honor DND + consent.
      await recordAudit(ctx, {
        action: "voice_outbound_refused",
        objectType: "voice_call",
        objectId: null,
        detail: verdict.reason + "::" + (verdict.detail || "").slice(0, 200),
      });
      return json(res, 409, {
        error: {
          code: verdict.reason.toUpperCase(),
          message: verdict.detail,
          consent_reason: verdict.consent_reason || null,
          dnd_source: verdict.dnd_source || null,
          region: verdict.region,
        },
      });
    }

    // Place the call via the provider SDK. The disclosure rides as
    // metadata; the per-tenant assistant prompt at provider level
    // is responsible for opening with it (we ship a default
    // template; legal sign-off may revise the wording).
    let placement;
    try {
      placement = await voicePlaceOutboundCall(config, {
        // The provider handles dial format per region; we pass the
        // E.164 from the gate verdict (already region-checked).
        to: body.to,
        fromAssistantId: config.assistant_id,
        metadata: {
          tenant_id: ctx.tenantId,
          customer_id: body.customer_id || null,
          customer_contact_id: body.customer_contact_id || null,
          reason: body.reason || null,
          recording_disclosure: verdict.disclosure,
          consent_id: verdict.consent_id,
          region: verdict.region,
          ...(body.metadata || {}),
        },
      });
    } catch (err) {
      await recordAudit(ctx, {
        action: "voice_outbound_failed",
        objectType: "voice_call",
        objectId: null,
        detail: (err.message || String(err)).slice(0, 240),
      });
      return json(res, 502, { error: { code: "PROVIDER_ERROR", message: "Voice provider rejected the call: " + (err.message || err) } });
    }

    // Pre-create the voice_calls row so the inbound webhook for
    // the same external_id can deduplicate and so the operator
    // can see the call in flight.
    const ins = await svc.from("voice_calls").insert({
      tenant_id: ctx.tenantId,
      config_id: config.id,
      provider: config.provider,
      external_id: placement.external_id,
      direction: "outbound",
      customer_id: body.customer_id || null,
      caller_phone_number: config.phone_number || null,
      callee_phone_number: body.to,
      status: "in_progress",
      raw: { initiated: true, placement: placement.raw, disclosure: verdict.disclosure, region: verdict.region },
    }).select("id, external_id").single();
    if (ins.error) {
      // Bug fix May 2026: previously we returned 200 + a warning
      // string and the call was invisible to the operator UI. Now
      // we write a processing_event so ops sees an actionable item
      // ("voice call placed but not tracked") with the provider's
      // external_id available for recovery. Audit also captures it.
      // The call is already placed; we can't undial it. The
      // webhook may still reconcile when the provider sends the
      // call-started event.
      await svc.from("processing_events").insert({
        tenant_id: ctx.tenantId,
        case_id: null,
        event_type: "voice_call_persist_failed",
        object_type: "voice_call",
        object_id: null,
        detail: {
          external_id: placement.external_id,
          provider: config.provider,
          callee: body.to,
          db_error: ins.error.message,
        },
        severity: "warn",
      });
      await recordAudit(ctx, {
        action: "voice_outbound_persist_failed",
        objectType: "voice_call",
        objectId: null,
        detail: config.provider + "::" + placement.external_id + "::" + ins.error.message.slice(0, 200),
      });
      return json(res, 200, {
        ok: true,
        warning: "voice_calls insert failed: " + ins.error.message + " (provider call id: " + placement.external_id + ")",
        external_id: placement.external_id,
        processing_event_recorded: true,
      });
    }

    await recordAudit(ctx, {
      action: "voice_outbound_placed",
      objectType: "voice_call",
      objectId: ins.data.id,
      detail: config.provider + "::" + placement.external_id + "::" + verdict.region,
    });

    return json(res, 200, {
      ok: true,
      call_id: ins.data.id,
      external_id: placement.external_id,
      region: verdict.region,
      disclosure: verdict.disclosure,
    });
  } catch (err) { sendError(res, err); }
}
