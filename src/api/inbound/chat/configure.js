// /api/inbound/chat/configure
//   GET                                    list this tenant's chat configs
//   POST { channel, creds, display_name }  create or update
//   DELETE ?channel=                       deactivate (soft)
//
// Phase 5.2. Single endpoint for WhatsApp/Slack/Teams/WeChat
// configuration so the Admin Center has one panel.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { encryptChatCreds, decryptChatCreds } from "../../_lib/inbound-chat.js";

const VALID = new Set(["whatsapp", "slack", "teams", "wechat"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("inbound_chat_configs")
        .select("id, channel, display_name, active, last_seen_at, last_error, updated_at")
        .eq("tenant_id", ctx.tenantId);
      if (error) throw new Error(error.message);
      return json(res, 200, { configs: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const channel = body?.channel;
      if (!channel || !VALID.has(channel)) {
        return json(res, 400, { error: { message: "channel in (whatsapp, slack, teams, wechat) required" } });
      }
      const enc = encryptChatCreds(channel, body.creds || {});
      const row = {
        tenant_id: ctx.tenantId,
        channel,
        display_name: body.display_name || null,
        active: body.active !== false,
        ...enc,
      };
      const { data, error } = await svc.from("inbound_chat_configs")
        .upsert(row, { onConflict: "tenant_id,channel" })
        .select("id, channel, display_name, active, updated_at")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, {
        action: "inbound_chat_config_upsert",
        objectType: "inbound_chat_config",
        objectId: data.id,
        after: { channel },
      });
      return json(res, 200, { config: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const url = new URL(req.url, "http://x");
      const channel = url.searchParams.get("channel");
      if (!channel || !VALID.has(channel)) {
        return json(res, 400, { error: { message: "channel query param required" } });
      }
      const { error } = await svc.from("inbound_chat_configs")
        .update({ active: false })
        .eq("tenant_id", ctx.tenantId)
        .eq("channel", channel);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, {
        action: "inbound_chat_config_disable",
        objectType: "inbound_chat_config",
        after: { channel },
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    return sendError(res, err);
  }
}
