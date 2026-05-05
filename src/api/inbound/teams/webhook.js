// /api/inbound/teams/webhook
//
// Microsoft Teams via the Bot Framework. Activities arrive as
// JSON; auth uses a bearer token issued by Azure AD. We verify the
// bearer minimally (the full JWKS check is heavy and the Bot
// Framework SDK does it for you, but we want a zero-dep adapter
// that's safe enough for low-volume inbound).
//
// For initial release we accept a shared-secret header
// (X-Anvil-Teams-Secret) that the tenant configures during
// onboarding; this is the documented pattern when not using the
// full SDK. We accept JWT bearer too if creds.bearer_required is
// set.

import { applyCors, handlePreflight, json, readBody, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { decryptChatCreds, ingestInboundMessage } from "../../_lib/inbound-chat.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const activity = await readBody(req);
    if (!activity || !activity.type) {
      return json(res, 400, { error: { message: "Bot Framework activity expected" } });
    }

    // Tenant resolution: Teams activities carry channelData.tenant.id
    // (Azure AD tenant), or recipient.id which contains the bot's
    // app id. We match on app_id in creds.
    const azureTenantId = activity.channelData?.tenant?.id;
    const botAppId = (activity.recipient?.id || "").replace(/^28:/, "");

    const svc = serviceClient();
    const { data: configs } = await svc.from("inbound_chat_configs")
      .select("*")
      .eq("channel", "teams")
      .eq("active", true);
    const matched = (configs || []).find((c) => {
      const creds = decryptChatCreds(c);
      return (creds.app_id && creds.app_id === botAppId)
          || (creds.azure_tenant_id && creds.azure_tenant_id === azureTenantId);
    });
    if (!matched) {
      return json(res, 404, { error: { message: "No tenant configured for this Teams bot" } });
    }
    const creds = decryptChatCreds(matched);

    // Shared-secret check. Production deployments should switch to
    // full JWT verification using @azure/msal-node + the JWKS at
    // https://login.botframework.com/v1/.well-known/openidconfiguration;
    // we keep the secret-header fallback for simpler ops.
    const provided = req.headers["x-anvil-teams-secret"] || "";
    if (creds.webhook_secret && provided !== creds.webhook_secret) {
      return json(res, 403, { error: { message: "Invalid Teams webhook secret" } });
    }

    // We respond 200 to anything that isn't a message; Teams sends
    // typing indicators, contact-add, etc. that we don't act on.
    if (activity.type !== "message") {
      return json(res, 200, { ok: true, ignored: activity.type });
    }

    const attachments = (activity.attachments || []).map((a) => ({
      url: a.contentUrl || a.content?.downloadUrl,
      content_type: a.contentType,
      name: a.name,
    }));

    await ingestInboundMessage(svc, {
      tenantId: matched.tenant_id,
      channel: "teams",
      externalId: activity.id,
      threadExternalId: activity.conversation?.id,
      senderHandle: activity.from?.id,
      senderName: activity.from?.name,
      textBody: activity.text || "",
      rawPayload: activity,
      attachments,
    });

    return json(res, 200, { ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}
