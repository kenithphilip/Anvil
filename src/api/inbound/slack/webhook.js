// /api/inbound/slack/webhook
//
// Slack Events API endpoint. Handles two event shapes:
//   1. url_verification: Slack's initial handshake; we echo the
//      challenge to confirm we own the URL.
//   2. event_callback: real events. We listen for `message` events
//      in DMs and channels the bot is in, plus `app_mention`.
//
// Tenant resolution: by Slack `team_id` (workspace ID). One tenant
// can install Anvil into multiple workspaces; one workspace maps
// to exactly one tenant config.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { decryptChatCreds, ingestInboundMessage, verifySlackSignature } from "../../_lib/inbound-chat.js";

const readRaw = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { raw += c; });
  req.on("end", () => resolve(raw));
  req.on("error", reject);
});

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const raw = await readRaw(req);
    let payload;
    try { payload = JSON.parse(raw); }
    catch (_e) { return json(res, 400, { error: { message: "Invalid JSON" } }); }

    // 1. URL verification. Slack sends this once when the app is
    // configured. We MUST echo the challenge back to prove we own
    // the URL. No signature on this initial request beyond shape.
    if (payload.type === "url_verification") {
      return json(res, 200, { challenge: payload.challenge });
    }

    if (payload.type !== "event_callback" || !payload.event) {
      return json(res, 200, { ok: true, ignored: true });
    }

    const teamId = payload.team_id;
    if (!teamId) return json(res, 400, { error: { message: "team_id missing" } });

    const svc = serviceClient();
    // Look up the tenant config by team_id. We persist Slack's
    // team_id inside the creds bag (keyed `team_id`).
    const { data: configs } = await svc.from("inbound_chat_configs")
      .select("*")
      .eq("channel", "slack")
      .eq("active", true);
    const matched = (configs || []).find((c) => {
      const creds = decryptChatCreds(c);
      return creds.team_id === teamId;
    });
    if (!matched) {
      return json(res, 404, { error: { message: "No tenant configured for this Slack workspace" } });
    }

    const creds = decryptChatCreds(matched);
    const signature = req.headers["x-slack-signature"] || "";
    const timestamp = req.headers["x-slack-request-timestamp"] || "";
    if (creds.signing_secret && !verifySlackSignature(creds.signing_secret, timestamp, raw, signature)) {
      return json(res, 403, { error: { message: "Invalid Slack signature" } });
    }

    const ev = payload.event;
    // Ignore bot's own messages (avoid loops).
    if (ev.bot_id || ev.subtype === "bot_message") {
      return json(res, 200, { ok: true, ignored: "bot_self" });
    }

    // We only care about messages and app mentions for now.
    if (!["message", "app_mention"].includes(ev.type)) {
      return json(res, 200, { ok: true, ignored: ev.type });
    }

    // Slack files (uploads). Each file has a URL we can fetch with
    // the bot token. Capture URLs only; the parse pass will pull.
    const attachments = (ev.files || []).map((f) => ({
      url: f.url_private_download || f.url_private,
      content_type: f.mimetype,
      name: f.name,
      size: f.size,
    }));

    await ingestInboundMessage(svc, {
      tenantId: matched.tenant_id,
      channel: "slack",
      externalId: ev.client_msg_id || ev.ts || `${ev.channel}-${ev.ts}`,
      threadExternalId: ev.thread_ts || ev.ts,
      senderHandle: ev.user,            // Slack user ID; the bot can resolve to name later
      senderName: ev.username || null,
      textBody: ev.text || "",
      rawPayload: ev,
      attachments,
    });

    return json(res, 200, { ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}
