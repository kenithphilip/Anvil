/* Inbound email webhook.
 * Compatible with provider-side parse webhooks (SendGrid Inbound Parse, Mailgun routes,
 * Postmark inbound, CloudMailin, etc.). The endpoint expects multipart form data or JSON
 * with a normalized envelope. Configure your inbound mail provider to POST here.
 *
 * Behavior:
 *  - Authenticate the call using EMAIL_INBOUND_TOKEN (header or query).
 *  - Parse from / subject / body.
 *  - Classify intent (po | quote_request | revision | status_request | other) using lightweight rules.
 *  - Persist attachments via the documents table; bundle them under a new draft order.
 *  - Record processing_events so the SLA timer starts.
 */

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { serviceClient } from "../_lib/supabase.js";
import { timingSafeEqual } from "../_lib/sanitize.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { documentsBucket } from "../_lib/storage.js";

const TENANT_DEFAULT = process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
const TOKEN = process.env.EMAIL_INBOUND_TOKEN || "";

const sanitize = (s) => String(s || "").replace(/[^A-Za-z0-9._@-]+/g, "_").slice(0, 200);

const classifyIntent = (subject, body) => {
  const text = ((subject || "") + " " + (body || "")).toLowerCase();
  if (/(revis|amend|update.*po\b|po.*update)/.test(text)) return "po_revision";
  if (/(quote|quotation|rfq|pricing)/.test(text)) return "quote_request";
  if (/(status|delivery|eta|tracking)/.test(text)) return "status_request";
  if (/(po|purchase\s*order|p\.o\.)/.test(text)) return "purchase_order";
  return "other";
};

const parseMultipart = async (req) => {
  // Vercel parses x-www-form-urlencoded into req.body but multipart needs explicit handling.
  // For provider compatibility we accept either: JSON body OR a flat envelope.
  if (req.body && typeof req.body === "object") return req.body;
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) {
        const params = new URLSearchParams(raw);
        const out = {};
        for (const [key, value] of params.entries()) out[key] = value;
        resolve(out);
      }
    });
    req.on("error", reject);
  });
};

// Email attachment intake. Audit M8 (May 2026): the same controls
// that gate POST /api/documents/upload now gate the inbound-email
// path — server-side size cap, MIME allowlist, extension allowlist,
// and the documents row lands with scan_status='pending' so the
// scan endpoint must clear it before downstream OCR / extract can
// run. Previously this path bypassed every check.
const ATTACHMENT_MAX_BYTES = Number(process.env.DOCUMENTS_MAX_UPLOAD_BYTES || 50 * 1024 * 1024);
const ATTACHMENT_ALLOWED_MIME = new Set([
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/tiff",
  "text/plain", "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/json",
  "application/octet-stream",
]);
const ATTACHMENT_ALLOWED_EXT = new Set([
  "pdf", "zip", "png", "jpg", "jpeg", "webp", "heic", "heif", "tiff",
  "txt", "csv", "tsv", "xls", "xlsx", "doc", "docx", "json", "jsonl",
]);
const persistAttachment = async (svc, tenantId, attachment) => {
  if (!attachment || !attachment.content) return null;
  const filename = sanitize(attachment.filename || "attachment");
  const ext = String(filename).toLowerCase().split(".").pop() || "";
  const mime = String(attachment.contentType || "").toLowerCase();
  // Reject before allocating the buffer so a flood of large invalid
  // attachments can't exhaust function memory.
  if (mime && !ATTACHMENT_ALLOWED_MIME.has(mime)) {
    return { skipped: true, reason: "unsupported_mime", filename, mime };
  }
  if (ext && !ATTACHMENT_ALLOWED_EXT.has(ext)) {
    return { skipped: true, reason: "unsupported_extension", filename, ext };
  }
  const buffer = Buffer.from(attachment.content, attachment.encoding || "base64");
  if (buffer.length > ATTACHMENT_MAX_BYTES) {
    return { skipped: true, reason: "too_large", filename, size: buffer.length };
  }
  const path = tenantId + "/email/" + Date.now() + "_" + filename;
  const bucket = documentsBucket();
  const upload = await svc.storage.from(bucket).upload(path, buffer, {
    contentType: mime || "application/octet-stream",
    upsert: false,
  });
  if (upload.error) throw new Error("Storage upload failed: " + upload.error.message);
  const insert = await svc.from("documents").insert({
    tenant_id: tenantId,
    storage_bucket: bucket,
    storage_path: path,
    filename,
    mime_type: mime || null,
    size_bytes: buffer.length,
    classification: "email_attachment",
    scan_status: "pending",
    metadata: { source: "email_inbound" },
  }).select("id").single();
  if (insert.error) throw new Error("Document insert failed: " + insert.error.message);
  return insert.data.id;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const queryToken = (req.query && req.query.token) || "";
    const headerToken = (req.headers["x-obara-inbound-token"] || "").toString();
    // Refuse the call entirely if EMAIL_INBOUND_TOKEN is not configured. This avoids the
    // implicit "anyone can post" mode that could leak across tenants on a shared deploy.
    if (!TOKEN) {
      return json(res, 503, { error: { message: "Inbound disabled: set EMAIL_INBOUND_TOKEN to enable." } });
    }
    // Audit H10 (May 2026): use crypto.timingSafeEqual to avoid the
    // string-comparison short-circuit timing oracle. Both the query
    // and header tokens are checked against TOKEN constant-time.
    if (!timingSafeEqual(TOKEN, queryToken) && !timingSafeEqual(TOKEN, headerToken)) {
      return json(res, 403, { error: { message: "Inbound token mismatch" } });
    }
    const body = await parseMultipart(req);
    // Tenant must come from the trusted header or fall back to the configured default.
    // We do NOT trust `body.tenant_id` because the request body originates from the email
    // provider and could be spoofed by anyone who tricks the provider into forwarding.
    const tenantId = (req.headers["x-obara-tenant"] || TENANT_DEFAULT).toString();
    const from = body.from || body.sender || (body.envelope && body.envelope.from) || "";
    const to = body.to || body.recipient || (body.envelope && body.envelope.to) || "";
    const subject = body.subject || body.Subject || "";
    const text = body.text || body["body-plain"] || body.plain || body.html || "";
    const messageId = body.messageId || body["Message-Id"] || (body.message && body.message.id) || ("inbound-" + Date.now());
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    const svc = serviceClient();

    const documentIds = [];
    const skippedAttachments = [];
    for (const attachment of attachments) {
      try {
        const result = await persistAttachment(svc, tenantId, attachment);
        if (typeof result === "string") {
          documentIds.push(result);
        } else if (result && result.skipped) {
          skippedAttachments.push(result);
          await recordAudit({ tenantId, role: "admin" }, {
            action: "email_attachment_skipped",
            objectType: "email",
            objectId: messageId,
            detail: result.filename + " :: " + result.reason,
          });
        }
      } catch (err) {
        await recordAudit({ tenantId, role: "admin" }, {
          action: "email_attachment_failed",
          objectType: "email",
          objectId: messageId,
          detail: (attachment.filename || "?") + ": " + err.message,
        });
      }
    }

    const intent = classifyIntent(subject, text);
    const threadId = body.threadId || body["Message-Id"] || (body.headers && body.headers["In-Reply-To"]) || subject.replace(/^(re:|fwd:)\s*/i, "").trim().toLowerCase();

    // Try to bundle with an existing recent draft order from the same thread or sender.
    let order;
    if (threadId) {
      const existing = await svc.from("orders")
        .select("id, status, preflight_payload")
        .eq("tenant_id", tenantId)
        .eq("status", "DRAFT")
        .gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString())
        .order("created_at", { ascending: false })
        .limit(20);
      const reuse = (existing.data || []).find((row) => {
        const t = row.preflight_payload && (row.preflight_payload.threadId || row.preflight_payload.subject);
        return t && (t === threadId || (typeof t === "string" && t.toLowerCase().includes(threadId.toLowerCase().slice(0, 40))));
      });
      if (reuse) order = { data: { id: reuse.id, reused: true } };
    }
    if (!order) {
      const ins = await svc.from("orders").insert({
        tenant_id: tenantId,
        status: "DRAFT",
        preflight_payload: {
          source: "email_inbound",
          intent,
          threadId,
          from,
          to,
          subject,
          text: String(text || "").slice(0, 8000),
          messageId,
        },
        blocker_summary: intent === "other" ? "Inbound email without clear PO/quote intent; needs triage" : null,
      }).select("id").single();
      if (ins.error) throw new Error("Order create failed: " + ins.error.message);
      order = { data: ins.data };
    }

    if (documentIds.length) {
      const classifyRole = (filename) => {
        const lower = String(filename || "").toLowerCase();
        if (/quote|quotation|qto/.test(lower)) return "quote";
        if (/price.?comp|costing|composition/.test(lower)) return "price_composition";
        return "purchase_order";
      };
      // Pull document filenames so we can route by name.
      const docs = await svc.from("documents").select("id, filename").in("id", documentIds);
      const links = (docs.data || []).map((d) => ({ order_id: order.data.id, document_id: d.id, role: classifyRole(d.filename) }));
      await svc.from("order_documents").insert(links);
    }

    await recordEvent({ tenantId, role: "system" }, {
      caseId: order.data.id,
      eventType: "document_uploaded",
      objectType: "email",
      objectId: messageId,
      detail: { from, to, subject, intent, attachmentCount: documentIds.length },
    });
    await recordAudit({ tenantId, role: "system" }, {
      action: "email_intake",
      objectType: "order",
      objectId: order.data.id,
      detail: "Intent=" + intent + " from=" + from + " attachments=" + documentIds.length,
    });

    return json(res, 200, { ok: true, orderId: order.data.id, intent, attachments: documentIds.length });
  } catch (err) {
    sendError(res, err);
  }
}
