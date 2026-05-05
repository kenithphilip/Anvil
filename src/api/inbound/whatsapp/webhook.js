// /api/inbound/whatsapp/webhook
//
// Twilio's WhatsApp Business webhook posts to this endpoint with
// urlencoded form data. We verify the X-Twilio-Signature header
// against our per-tenant auth_token and persist a normalised
// inbound_messages row.
//
// Tenant resolution: we look up inbound_chat_configs by the To
// number (Twilio's "To" param is the WhatsApp business number
// the customer messaged). The config holds the auth_token used
// for signature verification.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { decryptChatCreds, ingestInboundMessage, verifyTwilioSignature } from "../../_lib/inbound-chat.js";

// Read the raw urlencoded body as form params.
const readForm = (req) => new Promise((resolve, reject) => {
  let raw = "";
  req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const params = {};
    for (const pair of raw.split("&")) {
      if (!pair) continue;
      const [k, v] = pair.split("=").map(decodeURIComponent);
      params[k.replace(/\+/g, " ")] = (v || "").replace(/\+/g, " ");
    }
    resolve({ raw, params });
  });
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
    const { params } = await readForm(req);
    const messageSid = params.MessageSid || params.SmsMessageSid;
    const from = params.From || "";
    const to = params.To || "";
    const body = params.Body || "";
    const profileName = params.ProfileName || "";
    if (!messageSid) return json(res, 400, { error: { message: "MessageSid required" } });

    // Twilio prefixes WhatsApp numbers with "whatsapp:". Strip for
    // matching against our config.
    const fromNumber = from.replace(/^whatsapp:/, "");
    const toNumber = to.replace(/^whatsapp:/, "");

    const svc = serviceClient();
    const { data: config } = await svc.from("inbound_chat_configs")
      .select("*")
      .eq("channel", "whatsapp")
      .eq("active", true);
    // Multiple configs possible (different tenants on different
    // numbers). Match on the configured from_number.
    const matched = (config || []).find((c) => {
      const creds = decryptChatCreds(c);
      return creds.from_number && creds.from_number.replace(/^whatsapp:/, "") === toNumber;
    });
    if (!matched) {
      return json(res, 404, { error: { message: "No tenant configured for this WhatsApp number" } });
    }

    const creds = decryptChatCreds(matched);
    // Signature verification. Twilio's URL must include the full
    // public hostname; we trust X-Forwarded-Host on Vercel.
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const fullUrl = `${proto}://${host}${req.url}`;
    const signature = req.headers["x-twilio-signature"] || "";
    if (creds.auth_token && !verifyTwilioSignature(creds.auth_token, fullUrl, params, signature)) {
      return json(res, 403, { error: { message: "Invalid Twilio signature" } });
    }

    // Attachments: Twilio attaches images via NumMedia + MediaUrlN +
    // MediaContentTypeN. We capture URLs; downstream pipeline can
    // fetch and pin them.
    const numMedia = Number(params.NumMedia || 0);
    const attachments = [];
    for (let i = 0; i < numMedia; i++) {
      attachments.push({
        url: params[`MediaUrl${i}`],
        content_type: params[`MediaContentType${i}`],
      });
    }

    await ingestInboundMessage(svc, {
      tenantId: matched.tenant_id,
      channel: "whatsapp",
      externalId: messageSid,
      // Twilio doesn't expose a thread id; group by sender phone
      // (one ongoing convo per number is the common case).
      threadExternalId: fromNumber,
      senderHandle: fromNumber,
      senderName: profileName,
      textBody: body,
      rawPayload: params,
      attachments,
    });

    // Twilio expects a 200 with optional TwiML. Empty <Response/>
    // means "no auto-reply".
    res.setHeader("Content-Type", "text/xml");
    res.statusCode = 200;
    return res.end("<Response/>");
  } catch (err) {
    return sendError(res, err);
  }
}
