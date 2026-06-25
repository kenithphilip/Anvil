// POST /api/supplier_rfq/send
// Body: { rfq_id, vendor_ids: [uuid] }
//
// Drafts emails for each invited vendor, persists supplier_rfq_invitations,
// hands off to /api/communications/send for the actual send (reuses
// the existing SendGrid path). Marks the RFQ status=sent.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const buildRfqEmail = ({ rfq, lines, vendor, customerRef, customerName }) => {
  const linesText = lines.map((l) => `${l.line_no}. ${l.part_number || ""} ${l.description || ""} qty=${l.quantity || 0}${l.uom ? " " + l.uom : ""}${l.target_price ? " target=" + l.target_price : ""}${l.spec ? " spec=" + l.spec : ""}`).join("\n");
  // Tell the vendor which end customer this RFQ is for, using the reference
  // they know that customer by, so customer-specific (special) rates apply.
  const custLine = (customerRef || customerName)
    ? `Quotation for end customer: ${customerName || ""}${customerRef ? ` (ref: ${customerRef})` : ""}\nPlease apply the agreed customer-specific rates.\n\n`
    : "";
  return {
    subject: "RFQ " + (rfq.rfq_number || rfq.id) + " from Anvil",
    body_text: `Hello ${vendor.vendor_name},

${custLine}Please quote the following items by ${rfq.due_at || "your earliest convenience"}:

${linesText}

Reply to this email with your unit prices, lead times, and any notes per line.

Thanks.
Anvil RFQ #${rfq.rfq_number || ""}`,
    body_html: null,
  };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.rfq_id || !Array.isArray(body?.vendor_ids) || !body.vendor_ids.length) {
      return json(res, 400, { error: { message: "rfq_id and vendor_ids required" } });
    }
    const svc = serviceClient();
    const [rfqQ, linesQ, vendorsQ] = await Promise.all([
      svc.from("supplier_rfqs").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.rfq_id).maybeSingle(),
      svc.from("supplier_rfq_lines").select("*").eq("tenant_id", ctx.tenantId).eq("rfq_id", body.rfq_id).order("line_no"),
      svc.from("vendors").select("*").eq("tenant_id", ctx.tenantId).in("id", body.vendor_ids),
    ]);
    if (rfqQ.error) throw new Error(rfqQ.error.message);
    if (!rfqQ.data) return json(res, 404, { error: { message: "rfq not found" } });
    if (linesQ.error) throw new Error(linesQ.error.message);
    if (vendorsQ.error) throw new Error(vendorsQ.error.message);
    const rfq = rfqQ.data;
    const lines = linesQ.data || [];
    const vendors = vendorsQ.data || [];

    // Resolve the end customer + each vendor's reference for them, so the RFQ
    // email carries the customer-specific code (special-rate basis).
    let customerName = null;
    const refByVendor = new Map();
    if (rfq.customer_id) {
      const [custQ, refsQ] = await Promise.all([
        svc.from("customers").select("customer_name").eq("tenant_id", ctx.tenantId).eq("id", rfq.customer_id).maybeSingle(),
        svc.from("vendor_customer_refs").select("vendor_id, customer_ref").eq("tenant_id", ctx.tenantId).eq("customer_id", rfq.customer_id),
      ]);
      customerName = custQ.data?.customer_name || null;
      (refsQ.data || []).forEach((r) => refByVendor.set(r.vendor_id, r.customer_ref));
    }

    const out = [];
    for (const v of vendors) {
      if (!v.contact_email) {
        out.push({ vendor_id: v.id, skipped: true, reason: "no email" });
        continue;
      }
      const customerRef = refByVendor.get(v.id) || rfq.customer_ref || null;
      const draft = buildRfqEmail({ rfq, lines, vendor: v, customerRef, customerName });
      const inv = await svc.from("supplier_rfq_invitations").upsert({
        tenant_id: ctx.tenantId,
        rfq_id: rfq.id,
        vendor_id: v.id,
        email_to: v.contact_email,
        sent_at: new Date().toISOString(),
        response_status: "pending",
      }, { onConflict: "tenant_id,rfq_id,vendor_id" }).select("id").single();
      if (inv.error) throw new Error(inv.error.message);
      // Hand off to comms to actually send. We write a draft
      // communications row; the existing send wiring picks it up.
      await svc.from("communications").insert({
        tenant_id: ctx.tenantId,
        channel: "email",
        recipient: v.contact_email,
        subject: draft.subject,
        body_text: draft.body_text,
        status: "queued",
        ref_type: "supplier_rfq",
        ref_id: rfq.id,
      }).then(() => {}).then(() => undefined, () => undefined);
      out.push({ vendor_id: v.id, invitation_id: inv.data.id, ok: true });
    }
    await svc.from("supplier_rfqs").update({ status: "sent" })
      .eq("tenant_id", ctx.tenantId).eq("id", rfq.id);
    await recordAudit(ctx, {
      action: "supplier_rfq_sent",
      objectType: "supplier_rfq",
      objectId: rfq.id,
      detail: out.filter((r) => r.ok).length + " vendors",
    });
    return json(res, 200, { ok: true, results: out });
  } catch (err) { sendError(res, err); }
}
