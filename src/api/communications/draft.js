// POST /api/communications/draft
// Body: { orderId?, sourcePoId?, templateCode, variables?, to_addr?, subject?, body? }
// Creates a draft communication (email, SMS, etc.) ready for review.
// Templates resolve from EXCEPTION_PLAYBOOKS-style codes server-side.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import { commsRow } from "../_lib/comms-row.js";

const TEMPLATES = {
  order_received: {
    subject: "Order received: PO {{poNumber}}",
    body: "Hi {{contact}},\\n\\nWe have received PO {{poNumber}} and started preflight validation. We will revert with the SO confirmation shortly.\\n\\nThanks,\\n{{senderName}}",
  },
  order_accepted: {
    subject: "PO {{poNumber}} accepted",
    body: "Hi {{contact}},\\n\\nWe have processed PO {{poNumber}} and generated SO {{voucherNo}}. Total {{grandTotal}} INR.\\n\\nThanks,\\n{{senderName}}",
  },
  missing_quote: {
    subject: "Quote reference needed for PO {{poNumber}}",
    body: "Hi {{contact}},\\n\\nWe received PO {{poNumber}} but could not locate the matching quote. Could you share the quote reference number?\\n\\nThanks,\\n{{senderName}}",
  },
  delivery_date_conflict: {
    subject: "Delivery date conflict on PO {{poNumber}}",
    body: "Hi {{contact}},\\n\\nPO {{poNumber}} requests delivery by {{requestedDate}}. Our calculated earliest ship is {{predictedShipDate}} due to {{reason}}. Could you confirm an updated delivery date?\\n\\nThanks,\\n{{senderName}}",
  },
  supplier_followup: {
    subject: "Confirmation needed for SPO {{reference}}",
    body: "Hi {{supplierContact}},\\n\\nCould you please confirm price and ETA for source PO {{reference}}? We need it for customer commitments.\\n\\nThanks,\\n{{senderName}}",
  },
};

const fill = (template, vars) => {
  let out = String(template || "");
  Object.entries(vars || {}).forEach(([key, value]) => {
    out = out.replace(new RegExp("\\{\\{" + key + "\\}\\}", "g"), String(value == null ? "" : value));
  });
  return out;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.templateCode) return json(res, 400, { error: { message: "templateCode required" } });
    const tpl = TEMPLATES[body.templateCode];
    const vars = body.variables || {};
    const subject = body.subject || (tpl ? fill(tpl.subject, vars) : "(draft)");
    const draftBody = body.body || (tpl ? fill(tpl.body, vars) : "");
    const svc = serviceClient();
    const insert = await svc.from("communications").insert(commsRow({
      tenant_id: ctx.tenantId,
      order_id: body.orderId || null,
      source_po_id: body.sourcePoId || null,
      direction: "outbound",
      channel: body.channel || "email",
      from_addr: body.from_addr || null,
      to_addr: body.to_addr || null,
      subject,
      body: draftBody,
      status: "draft",
      template_code: body.templateCode,
    })).select("*").single();
    if (insert.error) throw new Error(insert.error.message);
    await recordAudit(ctx, { action: "comm_draft", objectType: "communication", objectId: insert.data.id, detail: body.templateCode });
    if (body.orderId) await recordEvent(ctx, { caseId: body.orderId, eventType: "draft_email_created", objectType: "communication", objectId: insert.data.id, detail: { template: body.templateCode } });
    return json(res, 200, { draft: insert.data });
  } catch (err) {
    sendError(res, err);
  }
}
