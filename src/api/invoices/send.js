// POST /api/invoices/send
// Body: { id, to?, subject?, body?, share_link? }
//
// Drafts a `communications` row for the invoice with a share link to
// the rendered PDF, then fires it via the existing comm send path.
// If `share_link` is true (default), regenerates the signed URL via
// /api/invoices/pdf?format=share so the customer always sees the
// latest invoice bytes.

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { renderInvoice } from "../_lib/pdf-renderer.js";
import { documentsBucket, ensureDocumentsBucket, friendlyStorageError } from "../_lib/storage.js";
import { commsRow } from "../_lib/comms-row.js";

const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Audit P2.7. portal/accept_quote.js + portal/pay.js + portal/tokens.js
// shipped as full-fledged customer-side endpoints, but no flow
// auto-issued a token when an invoice was sent. Customers received
// the PDF link but had no clickable Pay-now URL. Issue a portal
// token on every invoice send with the `pay` + `invoices` scopes
// and append a portal URL into the email body.
const PORTAL_TOKEN_TTL_DAYS = 30;
const generatePortalToken = () => crypto.randomBytes(24).toString("hex");

const portalBaseUrl = () => {
  const base = process.env.PORTAL_BASE_URL || process.env.PUBLIC_APP_URL || "";
  return base ? base.replace(/\/+$/, "") : "";
};

const issuePortalTokenForInvoice = async (svc, ctx, invoice, customer) => {
  const token = generatePortalToken();
  const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const ins = await svc.from("portal_tokens").insert({
    tenant_id: ctx.tenantId,
    customer_id: invoice.customer_id || customer?.id || null,
    email: customer?.contact_email || null,
    token,
    scopes: ["invoices", "pay"],
    expires_at: expiresAt,
    created_by: ctx.user?.id || null,
  }).select("id, token, expires_at").single();
  if (ins.error) {
    // eslint-disable-next-line no-console
    console.warn("[invoices/send] portal token insert failed: " + ins.error.message);
    return null;
  }
  const base = portalBaseUrl();
  const url = base ? base + "/portal/" + ins.data.token : null;
  return { id: ins.data.id, token: ins.data.token, expires_at: ins.data.expires_at, url };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body?.id) return json(res, 400, { error: { message: "id required" } });

    const svc = serviceClient();
    const invQ = await svc.from("invoices").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
    if (invQ.error) throw new Error("invoices read: " + invQ.error.message);
    if (!invQ.data) return json(res, 404, { error: { message: "Invoice not found" } });

    let customer = null;
    if (invQ.data.customer_id) {
      const cQ = await svc.from("customers")
        .select("customer_name, contact_email, gstin, billing_address")
        .eq("tenant_id", ctx.tenantId).eq("id", invQ.data.customer_id).maybeSingle();
      if (!cQ.error) customer = cQ.data;
    }

    const recipient = body.to || customer?.contact_email;
    if (!recipient) return json(res, 400, { error: { message: "No recipient email; pass `to` or set customer.contact_email" } });

    // Re-render + upload + sign so the link is fresh each send.
    let shareUrl = null;
    if (body.share_link !== false) {
      const tQ = await svc.from("tenants").select("display_name").eq("id", ctx.tenantId).maybeSingle();
      const pdf = await renderInvoice({
        kind: "Invoice",
        number: invQ.data.invoice_number,
        date: invQ.data.issue_date,
        brand: { name: tQ.data?.display_name || "Anvil" },
        from: { name: tQ.data?.display_name || "Anvil" },
        to: { name: customer?.customer_name || "Customer", email: recipient, gstin: customer?.gstin },
        items: invQ.data.line_items || [],
        subtotal: invQ.data.subtotal,
        tax: invQ.data.tax_total,
        total: invQ.data.grand_total,
        currency: invQ.data.currency,
        notes: invQ.data.notes,
      });
      let bucket;
      try { bucket = await ensureDocumentsBucket(svc); }
      catch (e) {
        bucket = documentsBucket();
        // eslint-disable-next-line no-console
        console.warn("[invoices/send] ensureDocumentsBucket: " + e.message);
      }
      const path = ctx.tenantId + "/invoices/" + invQ.data.id + ".pdf";
      const up = await svc.storage.from(bucket).upload(path, pdf, { contentType: "application/pdf", upsert: true });
      if (up.error) throw new Error("storage upload: " + friendlyStorageError(up.error.message, bucket));
      const signed = await svc.storage.from(bucket).createSignedUrl(path, SHARE_TTL_SECONDS);
      if (signed.error) throw new Error("signed url: " + friendlyStorageError(signed.error.message, bucket));
      shareUrl = signed.data.signedUrl;
      await svc.from("invoices").update({ pdf_storage_path: path }).eq("tenant_id", ctx.tenantId).eq("id", invQ.data.id);
    }

    // Audit P2.7: issue a portal token so the customer can pay
    // through the embedded portal/pay surface. Best-effort: when
    // PORTAL_BASE_URL/PUBLIC_APP_URL is not set we still create
    // the token but skip the URL line in the email body.
    const portal = await issuePortalTokenForInvoice(svc, ctx, invQ.data, customer);

    const subject = body.subject || ("Invoice " + invQ.data.invoice_number + " from your supplier");
    const lines = [
      "Hello" + (customer?.customer_name ? " " + customer.customer_name : "") + ",",
      "",
      "Please find invoice " + invQ.data.invoice_number + " for " + invQ.data.currency + " " + (Number(invQ.data.grand_total) || 0).toFixed(2) + ".",
      "Due date: " + invQ.data.due_date + ".",
    ];
    if (shareUrl) {
      lines.push("");
      lines.push("View invoice: " + shareUrl);
    }
    if (portal?.url) {
      lines.push("");
      lines.push("Pay now: " + portal.url);
    }
    if (invQ.data.payment_terms) {
      lines.push("");
      lines.push("Payment terms: " + invQ.data.payment_terms);
    }
    const text = body.body || lines.join("\n");

    // Draft a communications row with status=queued. The client can
    // immediately call /api/communications/send to fire it. The agent
    // runner's reaper (Phase 3) will also fire any leftover queued
    // rows on its next tick.
    const draft = await svc.from("communications").insert(commsRow({
      tenant_id: ctx.tenantId,
      object_type: "invoice",
      object_id: invQ.data.id,
      kind: "invoice_email",
      to_addr: recipient,
      subject,
      body: text,
      status: "queued",
      sent_by: ctx.user?.id || null,
      metadata: {
        invoice_id: invQ.data.id,
        share_url: shareUrl,
        portal_token_id: portal?.id || null,
        portal_url: portal?.url || null,
      },
    })).select("*").single();
    if (draft.error) throw new Error("comm draft: " + draft.error.message);

    // Flip the invoice to sent if it was draft.
    if (invQ.data.status === "draft") {
      await svc.from("invoices")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", invQ.data.id);
    }

    await recordAudit(ctx, {
      action: "invoice_sent",
      objectType: "invoice",
      objectId: invQ.data.id,
      detail: recipient,
    });

    return json(res, 200, {
      ok: true,
      communication_id: draft.data.id,
      share_url: shareUrl,
      portal_url: portal?.url || null,
      portal_token_id: portal?.id || null,
      status: "queued",
    });
  } catch (err) {
    sendError(res, err);
  }
}
