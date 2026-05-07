// POST /api/quotes/send
// Body: { id, to?, subject?, body?, share_link? }
//
// Audit P6.3. Sends a quote to a customer:
//
//   1. Validates the quote is in DRAFT or PENDING_INTERNAL_APPROVAL.
//   2. Resolves the recipient (body.to | quote.customer_contact_id |
//      customer.contact_email).
//   3. Renders the quote PDF and uploads it; signs a 7-day URL.
//   4. Issues a portal_tokens row with scopes=[quotes, accept_quote]
//      so the customer can click through to portal/accept_quote.
//   5. Drafts a `communications` row at status=queued. The reaper
//      fires it via SendGrid on the next agent tick.
//   6. Flips the quote to SENT, sets expires_at from validity_days,
//      sent_at, sent_via='email'.
//
// Reuses the same portal-token + signed-URL machinery that
// invoices/send (Phase 2 P2.7) shipped, plus the same pattern
// for queueing the comm row.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderQuote } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PORTAL_TOKEN_TTL_DAYS = 30;

const portalBaseUrl = () => {
  const base = process.env.PORTAL_BASE_URL || process.env.PUBLIC_APP_URL || "";
  return base ? base.replace(/\/+$/, "") : "";
};

const issuePortalTokenForQuote = async (svc, ctx, quote, customer) => {
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const ins = await svc.from("portal_tokens").insert({
    tenant_id: ctx.tenantId,
    customer_id: quote.customer_id || customer?.id || null,
    email: customer?.contact_email || null,
    token,
    scopes: ["quotes", "accept_quote"],
    expires_at: expiresAt,
    created_by: ctx.user?.id || null,
  }).select("id, token, expires_at").single();
  if (ins.error) {
    // eslint-disable-next-line no-console
    console.warn("[quotes/send] portal token insert failed: " + ins.error.message);
    return null;
  }
  const base = portalBaseUrl();
  const url = base ? base + "/portal/" + ins.data.token + "?quote=" + quote.id : null;
  return { id: ins.data.id, token: ins.data.token, expires_at: ins.data.expires_at, url };
};

const resolveRecipient = async (svc, tenantId, quote, override) => {
  if (override) {
    return { email: override, name: null, customer_name: null };
  }
  let customerName = null;
  if (quote.customer_id) {
    const c = await svc.from("customers").select("customer_name, contact_email")
      .eq("tenant_id", tenantId).eq("id", quote.customer_id).maybeSingle();
    if (c.data) customerName = c.data.customer_name;
    if (quote.customer_contact_id) {
      const ct = await svc.from("customer_contacts").select("name, email")
        .eq("tenant_id", tenantId).eq("id", quote.customer_contact_id).maybeSingle();
      if (ct.data?.email) {
        return { email: ct.data.email, name: ct.data.name, customer_name: customerName };
      }
    }
    if (c.data?.contact_email) {
      return { email: c.data.contact_email, name: null, customer_name: customerName };
    }
  }
  return { email: null, name: null, customer_name: customerName };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: { message: "id required" } });

    const svc = serviceClient();
    const qQ = await svc.from("quotes").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (qQ.error) throw new Error("quotes read: " + qQ.error.message);
    if (!qQ.data) return json(res, 404, { error: { message: "Quote not found" } });
    const quote = qQ.data;
    if (!["DRAFT", "PENDING_INTERNAL_APPROVAL"].includes(quote.status)) {
      return json(res, 409, { error: { message: "Cannot send a quote in status " + quote.status } });
    }

    const recipient = await resolveRecipient(svc, ctx.tenantId, quote, body.to);
    if (!recipient.email) {
      return json(res, 400, { error: { message: "No recipient email; pass `to` or set customer.contact_email / customer_contact_id." } });
    }

    let customer = null;
    if (quote.customer_id) {
      const c = await svc.from("customers").select("*").eq("tenant_id", ctx.tenantId).eq("id", quote.customer_id).maybeSingle();
      customer = c.data || null;
    }

    // Render + upload PDF.
    let shareUrl = null;
    if (body.share_link !== false) {
      const tQ = await svc.from("tenants").select("display_name").eq("id", ctx.tenantId).maybeSingle();
      const pdf = await renderQuote({
        kind: "Quotation",
        number: quote.quote_number + " v" + quote.version,
        date: new Date(quote.created_at).toLocaleDateString("en-US"),
        brand: { name: tQ.data?.display_name || "Anvil" },
        from: { name: tQ.data?.display_name || "Anvil" },
        to: {
          name: customer?.customer_name || recipient.name || "Customer",
          email: recipient.email,
          gstin: customer?.gstin,
        },
        items: quote.line_items || [],
        subtotal: quote.subtotal,
        tax: quote.tax_total,
        total: quote.grand_total,
        currency: quote.currency || "INR",
        notes: quote.notes,
      }).catch(() => null);
      if (pdf) {
        let bucket;
        try { bucket = await ensureDocumentsBucket(svc); }
        catch (e) {
          bucket = documentsBucket();
          // eslint-disable-next-line no-console
          console.warn("[quotes/send] ensureDocumentsBucket: " + e.message);
        }
        const path = ctx.tenantId + "/quotes/" + quote.id + "_v" + quote.version + ".pdf";
        const up = await svc.storage.from(bucket).upload(path, pdf, { contentType: "application/pdf", upsert: true });
        if (up.error) {
          // eslint-disable-next-line no-console
          console.warn("[quotes/send] storage upload: " + friendlyStorageError(up.error.message, bucket));
        } else {
          const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
          if (!signed.error) shareUrl = signed.data.signedUrl;
        }
      }
    }

    const portal = await issuePortalTokenForQuote(svc, ctx, quote, customer);

    const greeting = "Hello" + (recipient.name ? " " + recipient.name : (recipient.customer_name ? " " + recipient.customer_name : "")) + ",";
    const subject = body.subject || ("Quotation " + quote.quote_number + " v" + quote.version);
    const lines = [
      greeting,
      "",
      "Please find quotation " + quote.quote_number + " (version " + quote.version + ") for "
        + (quote.currency || "INR") + " " + (Number(quote.grand_total) || 0).toFixed(2) + ".",
    ];
    if (quote.validity_days) {
      lines.push("Validity: " + quote.validity_days + " days from today.");
    }
    if (shareUrl) {
      lines.push("");
      lines.push("View quotation: " + shareUrl);
    }
    if (portal?.url) {
      lines.push("");
      lines.push("Accept this quotation: " + portal.url);
    }
    lines.push("");
    lines.push("Reply to this email if you'd like changes; happy to revise.");
    const text = body.body || lines.join("\n");

    // Compute payload_hash for the audit trail. The customer's
    // accept-click can verify they accepted exactly this version.
    const payloadHash = crypto.createHash("sha256")
      .update(JSON.stringify({
        id: quote.id,
        version: quote.version,
        line_items: quote.line_items,
        currency: quote.currency,
        grand_total: quote.grand_total,
      }))
      .digest("hex");

    // Flip the quote to SENT, populate sent_at + expires_at +
    // sent_via, persist the payload_hash so portal/accept_quote
    // can verify on click.
    const validityDays = quote.validity_days || 30;
    const expiresAt = new Date(Date.now() + validityDays * 86400 * 1000).toISOString();
    const upd = await svc.from("quotes").update({
      status: "SENT",
      sent_at: new Date().toISOString(),
      sent_via: "email",
      expires_at: expiresAt,
      payload_hash: payloadHash,
      updated_at: new Date().toISOString(),
    }).eq("tenant_id", ctx.tenantId).eq("id", quote.id).select("*").single();
    if (upd.error) throw new Error("quote SENT update: " + upd.error.message);

    // Queue the email.
    const draft = await svc.from("communications").insert({
      tenant_id: ctx.tenantId,
      object_type: "quote",
      object_id: quote.id,
      kind: "quote_email",
      to_addr: recipient.email,
      subject,
      body: text,
      status: "queued",
      sent_by: ctx.user?.id || null,
      metadata: {
        quote_id: quote.id,
        version: quote.version,
        share_url: shareUrl,
        portal_token_id: portal?.id || null,
        portal_url: portal?.url || null,
        payload_hash: payloadHash,
      },
    }).select("*").single();
    if (draft.error) throw new Error("comm draft: " + draft.error.message);

    await recordAudit(ctx, {
      action: "quote_send",
      objectType: "quote",
      objectId: quote.id,
      detail: recipient.email + " :: v" + quote.version,
      payloadHash,
    });

    return json(res, 200, {
      ok: true,
      communication_id: draft.data.id,
      share_url: shareUrl,
      portal_url: portal?.url || null,
      portal_token_id: portal?.id || null,
      quote: upd.data,
      status: "queued",
    });
  } catch (err) { sendError(res, err); }
}
