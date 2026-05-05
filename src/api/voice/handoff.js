// /api/voice/handoff
//   POST { call_id, to_number? }
//
// Forwards an in-progress call to a human number. Used by the
// agent when it can't authenticate the customer, when the topic
// exits scope, or on operator-initiated takeover. Phase 5.1.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { voiceDecryptCreds, voiceForwardCall } from "../_lib/voice-client.js";

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
    if (!body?.call_id) return json(res, 400, { error: { message: "call_id required" } });

    const svc = serviceClient();
    const { data: call } = await svc.from("voice_calls")
      .select("*")
      .eq("id", body.call_id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();
    if (!call) return json(res, 404, { error: { message: "call not found" } });
    if (call.status !== "in_progress") {
      return json(res, 409, { error: { message: "call is not in progress" } });
    }

    const { data: config } = await svc.from("voice_configs")
      .select("*")
      .eq("id", call.config_id)
      .maybeSingle();
    if (!config) return json(res, 404, { error: { message: "voice config not found for call" } });
    const decrypted = voiceDecryptCreds(config);
    const target = body.to_number || config.handoff_phone_number;
    if (!target) {
      return json(res, 400, { error: { message: "to_number required (or set handoff_phone_number on the config)" } });
    }

    await voiceForwardCall(decrypted, { callId: call.external_id, toNumber: target });
    await svc.from("voice_calls")
      .update({ status: "escalated" })
      .eq("id", call.id);
    await recordAudit(ctx, {
      action: "voice_handoff",
      objectType: "voice_call",
      objectId: call.id,
      detail: "to=" + target,
    });

    return json(res, 200, { ok: true, forwarded_to: target });
  } catch (err) {
    return sendError(res, err);
  }
}
