// POST /api/whatsapp/inbound
//
// Provider-agnostic inbound webhook for WhatsApp Business messages.
// Accepts the two common envelopes:
//
// 1. Twilio WhatsApp HTTP webhook (urlencoded form):
//      From=whatsapp:+919876543210
//      To=whatsapp:+15551234567
//      Body=Need quote for WGC-K12464 qty 50
//      MediaUrl0=https://...   MediaContentType0=application/pdf
//
// 2. Meta WhatsApp Cloud API webhook (JSON):
//      { entry: [{ changes: [{ value: { messages: [{ from, text, ... }],
//                                       contacts: [{ profile: { name } }] } }] }] }
//
// Behavior mirrors api/email/inbound.js: token-gated, classifies the
// intent on subject+body, persists every attachment to the documents
// table, attempts to bundle the message into an existing DRAFT order
// from the same sender within a 7-day window, audits every step.
//
// Configure exactly one provider and point its webhook here:
//   - Twilio: https://www.twilio.com/console/sms/whatsapp/sandbox
//   - Meta:   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks

import { applyCors, handlePreflight, json } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { documentsBucket } from "../_lib/storage.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const TENANT_DEFAULT = process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
const TOKEN = process.env.WHATSAPP_INBOUND_TOKEN || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || ""; // optional; for media fetch with auth

const sanitize = (s) => String(s || "").replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 200);

const classifyIntent = (text) => {
  const t = String(text || "").toLowerCase();
  if (/(revis|amend|update.*po\b|po.*update)/.test(t)) return "po_revision";
  if (/(quote|quotation|rfq|pricing|price|cost)/.test(t)) return "quote_request";
  if (/(status|delivery|eta|tracking|where\s+is)/.test(t)) return "status_request";
  if (/(po|purchase\s*order|p\.o\.|buy)/.test(t)) return "purchase_order";
  return "other";
};

const parseBody = async (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      // Twilio sends application/x-www-form-urlencoded by default.
      try { resolve(JSON.parse(raw)); }
      catch (_) {
        const params = new URLSearchParams(raw);
        const out = {};
        for (const [k, v] of params.entries()) out[k] = v;
        resolve(out);
      }
    });
    req.on("error", reject);
  });
};

// Normalize either the Twilio or Meta envelope into a single shape:
//   { from, name, text, media: [{ url, contentType, filename }] }
const normalize = (raw) => {
  // Meta Cloud API
  if (Array.isArray(raw?.entry)) {
    const change = raw.entry[0]?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    if (!msg) return null;
    const profile = change?.contacts?.[0]?.profile || {};
    const text = msg.text?.body
      || msg.image?.caption
      || msg.document?.caption
      || msg.video?.caption
      || "";
    const media = [];
    for (const kind of ["image", "document", "video", "audio"]) {
      if (msg[kind]?.id) {
        media.push({
          provider: "meta",
          media_id: msg[kind].id,
          contentType: msg[kind].mime_type || null,
          filename: msg[kind].filename || (kind + "_" + msg[kind].id),
        });
      }
    }
    return { from: msg.from, name: profile.name || null, text, media, raw };
  }
  // Twilio
  if (raw?.From) {
    const from = String(raw.From).replace(/^whatsapp:/, "");
    const num = parseInt(raw.NumMedia || "0", 10) || 0;
    const media = [];
    for (let i = 0; i < num; i++) {
      const url = raw["MediaUrl" + i];
      const ct = raw["MediaContentType" + i] || null;
      if (url) media.push({ provider: "twilio", url, contentType: ct, filename: "media_" + i });
    }
    return { from, name: raw.ProfileName || null, text: raw.Body || "", media, raw };
  }
  return null;
};

// Download a media attachment and upload to Supabase Storage; insert
// the documents row. Provider differences: Twilio returns the bytes
// directly behind basic auth; Meta requires a two-step (resolve
// media_id -> signed url -> bytes) call. We only handle the Twilio
// case fully here because Meta's flow needs an access token; Meta
// media_ids are persisted on the document so an operator can resolve
// them later.
const persistMedia = async (svc, tenantId, m) => {
  const filename = sanitize(m.filename || "whatsapp");
  const path = tenantId + "/whatsapp/" + Date.now() + "_" + filename;
  let buffer = null;
  let stored = false;
  if (m.provider === "twilio" && m.url) {
    const headers = {};
    if (process.env.TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
      const creds = Buffer.from(process.env.TWILIO_ACCOUNT_SID + ":" + TWILIO_AUTH_TOKEN).toString("base64");
      headers["Authorization"] = "Basic " + creds;
    }
    try {
      const resp = await safeFetch(m.url, { headers });
      if (resp.ok) {
        buffer = Buffer.from(await resp.arrayBuffer());
        const bucket = documentsBucket();
        const up = await svc.storage.from(bucket).upload(path, buffer, {
          contentType: m.contentType || "application/octet-stream",
          upsert: false,
        });
        if (!up.error) {
          stored = true;
          m._bucket_used = bucket;
        }
      }
    } catch (_) { /* fall through, store as unfetched */ }
  }
  const insert = await svc.from("documents").insert({
    tenant_id: tenantId,
    storage_bucket: stored ? (m._bucket_used || documentsBucket()) : null,
    storage_path: stored ? path : null,
    filename,
    mime_type: m.contentType || null,
    size_bytes: buffer ? buffer.length : null,
    classification: "whatsapp_attachment",
    metadata: {
      source: "whatsapp_inbound",
      provider: m.provider,
      provider_url: m.url || null,
      provider_media_id: m.media_id || null,
      stored,
    },
  }).select("id").single();
  if (insert.error) return null;
  return insert.data.id;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });

  // Token gate. We refuse to accept inbound when WHATSAPP_INBOUND_TOKEN
  // isn't set: anonymous-write would be a multi-tenant data hole.
  if (!TOKEN) {
    return json(res, 503, { error: { message: "Inbound disabled: set WHATSAPP_INBOUND_TOKEN to enable." } });
  }
  const queryToken = (req.query && req.query.token) || "";
  const headerToken = (req.headers["x-obara-inbound-token"] || "").toString();
  if (TOKEN !== queryToken && TOKEN !== headerToken) {
    return json(res, 403, { error: { message: "Inbound token mismatch" } });
  }

  // Tenant id can be supplied by the trusted webhook; defaults to the
  // demo tenant. Never read from message body.
  const tenantId = (req.headers["x-anvil-tenant"] || req.headers["x-obara-tenant"] || "").toString() || TENANT_DEFAULT;

  try {
    const raw = await parseBody(req);
    const msg = normalize(raw);
    if (!msg) {
      return json(res, 400, { error: { message: "Could not parse provider envelope" } });
    }
    const svc = serviceClient();

    // Persist attachments first.
    const documentIds = [];
    for (const m of (msg.media || [])) {
      const id = await persistMedia(svc, tenantId, m);
      if (id) documentIds.push(id);
    }

    const intent = classifyIntent(msg.text);

    // Try to bundle into an existing DRAFT order from the same sender
    // within a 7-day window. We use phone-number similarity stored on
    // preflight_payload.from since we don't have a contacts table yet.
    let bundledOrderId = null;
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const existing = await svc
      .from("orders")
      .select("id, preflight_payload, status, created_at")
      .eq("tenant_id", tenantId)
      .eq("status", "DRAFT")
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!existing.error && existing.data) {
      const candidate = existing.data.find((o) => {
        const from = o.preflight_payload?.from || "";
        return from && msg.from && String(from).includes(msg.from.replace(/^\+/, "").slice(-10));
      });
      if (candidate) bundledOrderId = candidate.id;
    }

    let orderId = bundledOrderId;
    if (!orderId) {
      const ord = await svc.from("orders").insert({
        tenant_id: tenantId,
        status: "DRAFT",
        preflight_payload: {
          source: "whatsapp_inbound",
          from: msg.from,
          name: msg.name,
          text: msg.text,
          intent,
          received_at: new Date().toISOString(),
        },
      }).select("id").single();
      if (ord.error) throw new Error("Order insert: " + ord.error.message);
      orderId = ord.data.id;
    }

    // Link documents to the order.
    if (orderId && documentIds.length) {
      await svc.from("documents")
        .update({ order_id: orderId, role: intent === "purchase_order" ? "purchase_order" : "quote" })
        .in("id", documentIds);
    }

    // Audit + event so the meter + activity timeline pick this up.
    const ctx = { tenantId, user: { id: null }, role: "service" };
    await recordAudit(ctx, {
      action: "whatsapp_intake",
      objectType: "order",
      objectId: orderId,
      detail: msg.from + " :: " + intent + " :: docs=" + documentIds.length,
    });
    await recordEvent(ctx, {
      caseId: orderId,
      eventType: "whatsapp_message",
      objectType: "order",
      objectId: orderId,
      detail: { from: msg.from, intent, document_ids: documentIds, bundled: !!bundledOrderId },
    });

    return json(res, 200, {
      ok: true,
      order_id: orderId,
      bundled: !!bundledOrderId,
      intent,
      document_ids: documentIds,
    });
  } catch (err) {
    res.statusCode = err.status || 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: { message: err.message || String(err) } }));
  }
}
