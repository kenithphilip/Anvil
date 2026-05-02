// POST /api/communications/missing_doc
// Body: { orderId }
// Detects which intake docs are missing (PO, quote, price comp) and drafts the
// appropriate request email. Idempotent per orderId+docType.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const TEMPLATES = {
  quote: { code: "missing_quote", subject: "Quote reference needed", body: "Hi {{contact}},\\n\\nWe received PO {{poNumber}} but could not locate the matching Obara quote. Could you share the quote reference number?\\n\\nThanks,\\n{{senderName}}" },
  price_composition: { code: "missing_price_comp", subject: "Price composition for PO {{poNumber}}", body: "Hi {{contact}},\\n\\nFor PO {{poNumber}} we need the internal price composition document. Could you forward the latest version?\\n\\nThanks,\\n{{senderName}}" },
  purchase_order: { code: "missing_po", subject: "PO copy needed", body: "Hi {{contact}},\\n\\nThe quote {{quoteNumber}} is ready but we have not yet received the customer PO. Could you share it once available?\\n\\nThanks,\\n{{senderName}}" },
};

const fill = (s, vars) => Object.entries(vars || {}).reduce((acc, [k, v]) => acc.replace(new RegExp("\\{\\{" + k + "\\}\\}", "g"), String(v == null ? "" : v)), String(s || ""));

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.orderId) return json(res, 400, { error: { message: "orderId required" } });
    const svc = serviceClient();
    const order = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId).single();
    if (order.error || !order.data) return json(res, 404, { error: { message: "Order not found" } });
    const docLinks = await svc.from("order_documents").select("role").eq("order_id", body.orderId);
    const presentRoles = new Set((docLinks.data || []).map((r) => r.role));
    const missing = [];
    if (!presentRoles.has("purchase_order")) missing.push("purchase_order");
    if (!presentRoles.has("quote")) missing.push("quote");
    if (!presentRoles.has("price_composition")) missing.push("price_composition");
    const variables = {
      poNumber: order.data.po_number || "",
      contact: order.data.result && order.data.result.po && order.data.result.po.contact || "Customer",
      senderName: "Obara India Sales",
      quoteNumber: order.data.quote_number || "",
    };
    const drafts = [];
    const errors = [];
    for (const docType of missing) {
      const tpl = TEMPLATES[docType];
      if (!tpl) continue;
      const insert = await svc.from("communications").insert({
        tenant_id: ctx.tenantId,
        order_id: body.orderId,
        direction: "outbound",
        channel: "email",
        subject: fill(tpl.subject, variables),
        body: fill(tpl.body, variables),
        status: "draft",
        template_code: tpl.code,
      }).select("*").single();
      if (insert.error) {
        errors.push({ docType, message: insert.error.message });
        continue;
      }
      if (insert.data) drafts.push(insert.data);
    }
    await recordAudit(ctx, { action: "missing_doc_drafts", objectType: "order", objectId: body.orderId, detail: missing.join(",") + (errors.length ? " errors=" + errors.length : "") });
    if (errors.length && !drafts.length) {
      return json(res, 500, { error: { message: "All draft inserts failed", errors } });
    }
    return json(res, 200, { missing, drafts, errors });
  } catch (err) {
    sendError(res, err);
  }
}
