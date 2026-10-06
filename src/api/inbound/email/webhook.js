// POST /api/inbound/email/webhook
//
// Single dispatcher for both adapters. We pick by the
// `X-Anvil-Provider` header (set per-tenant in webhook config) or
// by shape detection on the body.
//
//   Postmark Inbound webhook payload:
//     { MessageID, From, FromName, To, Cc, Subject, TextBody,
//       HtmlBody, Headers: [{Name,Value}], Attachments: [...] }
//
//   Microsoft Graph notification:
//     { value: [{ changeType, resource, resourceData: {id}, ... }] }
//   then we fetch the message via Graph using the subscription's
//   client credentials.
//
// Tenant resolution:
//   - Postmark: by inbound address. We look up tenant_settings
//     where postmark_inbound_address matches `To`.
//   - Graph: by the `clientState` in the subscription, which we
//     persisted on tenant_settings.graph_subscription_id.
//
// Auth:
//   - Postmark: HMAC over body using postmark_inbound_secret in the
//     `X-Postmark-Signature` header (Postmark's standard).
//   - Graph: validation token round-trip on subscribe; per-message
//     `clientState` check.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { serviceClient } from "../../_lib/supabase.js";
import { recordAudit } from "../../_lib/audit.js";
import { buildInboundEmailRow, ingestInboundEmail } from "../../_lib/inbound-email.js";
import { safeFire } from "../../_lib/safe-thenable.js";
import { graphAccessToken, fetchGraphMessage, graphIsConnected } from "../../_lib/graph-client.js";
import { attributeReply } from "../../_lib/graph-reply.js";

const readRaw = (req) => new Promise((resolve, reject) => {
  let data = "";
  req.setEncoding && req.setEncoding("utf8");
  req.on("data", (c) => { data += c; });
  req.on("end", () => resolve(data));
  req.on("error", reject);
});

const verifyPostmarkSignature = (raw, signature, secret) => {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch (_e) { return false; }
};

const headersAsMap = (headers) => {
  const map = {};
  for (const h of headers || []) map[String(h.Name || "").toLowerCase()] = h.Value;
  return map;
};

// Timing-safe check of a Graph notification's clientState against the stored
// subscription secret. Fails closed: no secret / no value / mismatch -> false.
const clientStateOk = (expected, provided) => {
  if (!expected || !provided) return false;
  try {
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(provided));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_e) { return false; }
};

const handlePostmark = async (svc, raw, body, req) => {
  const toAddrs = String(body.To || body.OriginalRecipient || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  // Find the tenant whose inbound address matches.
  let tenantId = null;
  let postmarkSecret = null;
  for (const to of toAddrs) {
    const r = await svc.from("tenant_settings")
      .select("tenant_id, postmark_inbound_address, postmark_inbound_secret")
      .ilike("postmark_inbound_address", to)
      .maybeSingle();
    if (r.data?.tenant_id) {
      tenantId = r.data.tenant_id;
      postmarkSecret = r.data.postmark_inbound_secret;
      break;
    }
  }
  if (!tenantId) {
    return { status: 404, body: { error: { code: "NO_TENANT_MATCH", message: "no tenant for these recipients" } } };
  }
  const sig = req.headers["x-postmark-signature"] || req.headers["X-Postmark-Signature"];
  // Bug fix May 2026: previously we only verified the signature
  // when postmarkSecret was set. A tenant that hadn't configured
  // a secret accepted unsigned inbound webhooks (i.e. the public
  // URL became a poisonable inbox). Now we fail-closed: every
  // Postmark inbound MUST carry a verified signature. Tenants
  // without a configured secret have to set one before inbound
  // works; the configure endpoint surfaces this requirement.
  if (!postmarkSecret) {
    return { status: 401, body: { error: { code: "POSTMARK_SECRET_NOT_CONFIGURED", message: "Tenant has no postmark_inbound_secret on tenant_settings; refusing to accept unsigned inbound." } } };
  }
  if (!verifyPostmarkSignature(raw, sig, postmarkSecret)) {
    return { status: 401, body: { error: { code: "BAD_SIGNATURE", message: "invalid postmark signature" } } };
  }
  const headers = headersAsMap(body.Headers);
  const refs = headers["references"] ? String(headers["references"]).split(/\s+/).filter(Boolean) : null;
  const row = buildInboundEmailRow({
    tenantId,
    provider: "postmark",
    message_id: body.MessageID || headers["message-id"] || null,
    in_reply_to: headers["in-reply-to"] || null,
    references_chain: refs,
    from_address: String(body.From || "").toLowerCase(),
    from_name: body.FromName || null,
    to_addresses: toAddrs,
    cc_addresses: String(body.Cc || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
    subject: body.Subject || null,
    body_text: body.TextBody || null,
    body_html: body.HtmlBody || null,
    raw_mime: null,
    attachments: (body.Attachments || []).map((a) => ({
      filename: a.Name,
      content_type: a.ContentType,
      size_bytes: a.ContentLength,
      // Postmark sends Content as inline base64. Stash it on the
      // row so the persist_attachments worker can drain it into
      // the documents bucket asynchronously. The worker clears
      // content_b64 once the bytes are safely uploaded + scanned,
      // so this field is only present in transit. Audit P5.4.
      content_b64: typeof a.Content === "string" && a.Content.length > 0 ? a.Content : undefined,
    })),
  });
  return { status: 200, body: await ingestInboundEmail(svc, row), tenantId };
};

const handleGraph = async (svc, body, req) => {
  // Graph subscription validation handshake: when a subscription
  // is first registered, MS sends a validationToken query param
  // and expects us to echo it back as text/plain.
  // The Vercel rewrite preserves req.url; check there.
  const url = new URL(req.url, "http://x");
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return { status: 200, body: validationToken, contentType: "text/plain" };
  }
  // For real notifications, the body has `value: [...]` with resource ids. We
  // fetch each message via Graph (the tenant's own OAuth token), ingest the full
  // inbound row, and ATTRIBUTE the reply back to the outbound communication that
  // prompted it (thread_id=conversationId / provider_message_id=In-Reply-To).
  // If the fetch fails we still write a stub so a retry can complete it.
  const notifs = Array.isArray(body?.value) ? body.value : [];
  let processed = 0;
  let attributed = 0;
  for (const n of notifs) {
    const subscriptionId = n.subscriptionId;
    const tset = await svc.from("tenant_settings").select("*")
      .eq("graph_subscription_id", subscriptionId).maybeSingle();
    const settings = tset.data;
    if (!settings?.tenant_id) continue;
    const tenantId = settings.tenant_id;
    const graphMessageId = n.resourceData?.id || null;

    // AUTHENTICITY GATE (fail closed): only fetch the message — a privileged call
    // with the tenant's mailbox token — when the notification's clientState
    // matches the stored subscription secret. No secret configured, or a
    // mismatch, means we do NOT fetch (write the benign stub only), so a forged
    // notification can never make us read an arbitrary message.
    const trusted = clientStateOk(settings.graph_client_state, n.clientState);

    // Fetch the actual message (conversationId + internetMessageId + In-Reply-To).
    let fetched = null;
    if (trusted && graphMessageId && graphIsConnected(settings)) {
      try {
        const { accessToken, sender } = await graphAccessToken(svc, { ...settings });
        fetched = await fetchGraphMessage(accessToken, sender || settings.graph_mailbox, graphMessageId);
      } catch (_e) { fetched = null; }
    }

    const row = buildInboundEmailRow({
      tenantId,
      provider: "graph",
      // Dedup on the stable Graph id — present on BOTH the fetched and stub paths,
      // so at-least-once redelivery (or a stub-then-fetch retry) never doubles.
      message_id: graphMessageId,
      in_reply_to: fetched?.inReplyTo || null,
      references_chain: fetched?.references ? fetched.references.split(/\s+/).filter(Boolean) : null,
      from_address: fetched?.from || null,
      from_name: fetched?.fromName || null,
      subject: fetched?.subject || "(graph notification, fetch pending)",
      body_text: fetched?.bodyText || null,
      body_html: fetched?.bodyHtml || null,
    });
    row.status = "received";
    const ing = await ingestInboundEmail(svc, row);
    processed += 1;

    if (fetched && (fetched.conversationId || fetched.inReplyTo)) {
      const r = await attributeReply(svc, tenantId, {
        conversationId: fetched.conversationId,
        inReplyTo: fetched.inReplyTo,
        receivedAt: fetched.receivedAt,
        inboundEmailId: ing?.id || null,
      });
      if (r.matched) attributed += 1;
    }
  }
  return { status: 202, body: { processed, attributed } };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "POST, GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const raw = req.method === "POST" ? await readRaw(req) : "";
    const explicit = req.headers["x-anvil-provider"];
    let body = null;
    if (raw) {
      try { body = JSON.parse(raw); } catch (_e) {
        return json(res, 400, { error: { message: "invalid json" } });
      }
    }
    const svc = serviceClient();
    const provider = explicit
      || (body?.MessageID ? "postmark"
          : (body?.value || new URL(req.url, "http://x").searchParams.get("validationToken") ? "graph"
          : "postmark"));

    let out;
    if (provider === "postmark") out = await handlePostmark(svc, raw, body, req);
    else if (provider === "graph") out = await handleGraph(svc, body, req);
    else return json(res, 400, { error: { message: "unknown provider: " + provider } });

    if (out.contentType === "text/plain") {
      res.statusCode = out.status;
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end(out.body);
      return;
    }
    if (out.tenantId) {
      // Best-effort audit. safeFire so a failure is logged without
      // breaking the webhook response, and labelled so the operator
      // can spot it in stderr.
      safeFire(svc.from("audit_events").insert({
        tenant_id: out.tenantId,
        actor_id: null,
        action: "inbound_email_received",
        object_type: "inbound_email",
        object_id: out.body?.id || null,
        detail: provider + (out.body?.duplicate ? "::duplicate" : ""),
      }), "inbound_email_audit");
    }
    return json(res, out.status, out.body);
  } catch (err) { sendError(res, err); }
}
