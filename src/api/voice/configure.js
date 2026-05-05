// /api/voice/configure
//   GET                         list this tenant's voice configs
//   POST { provider, ... }      upsert one
//   DELETE ?id=                 deactivate
//
// Phase 5.1.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { voiceEncryptCreds } from "../_lib/voice-client.js";

const VALID_PROVIDERS = new Set(["vapi", "retell"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("voice_configs")
        .select("id, provider, display_name, phone_number, assistant_id, voice_persona, system_prompt, handoff_phone_number, active, updated_at")
        .eq("tenant_id", ctx.tenantId);
      if (error) throw new Error(error.message);
      return json(res, 200, { configs: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const provider = body?.provider;
      if (!provider || !VALID_PROVIDERS.has(provider)) {
        return json(res, 400, { error: { message: "provider in (vapi, retell) required" } });
      }
      if (!body?.phone_number) {
        return json(res, 400, { error: { message: "phone_number required (E.164)" } });
      }
      const enc = voiceEncryptCreds({ apiKey: body.api_key });
      const row = {
        tenant_id: ctx.tenantId,
        provider,
        display_name: body.display_name || null,
        phone_number: body.phone_number,
        assistant_id: body.assistant_id || null,
        webhook_secret: body.webhook_secret || null,
        voice_persona: body.voice_persona || null,
        system_prompt: body.system_prompt || null,
        handoff_phone_number: body.handoff_phone_number || null,
        active: body.active !== false,
        ...enc,
      };
      const { data, error } = await svc.from("voice_configs")
        .upsert(row, { onConflict: "tenant_id,provider,phone_number" })
        .select("id, provider, display_name, phone_number, active")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, {
        action: "voice_configure",
        objectType: "voice_config",
        objectId: data.id,
        after: { provider, phone_number: body.phone_number },
      });
      return json(res, 200, { config: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const url = new URL(req.url, "http://x");
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("voice_configs")
        .update({ active: false })
        .eq("id", id)
        .eq("tenant_id", ctx.tenantId);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "voice_deactivate", objectType: "voice_config", objectId: id });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
