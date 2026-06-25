// POST /api/supplier_rfq/quote
// Body: { invitation_id, lines: [{ line_no, unit_price, lead_time_days, currency?, validity_days?, notes? }], notes? }
//
// Records vendor responses against an invitation. Operators paste a
// vendor reply (or upload a PDF that the existing Document AI v2
// extracts), this endpoint persists the resulting structured quote.
// Flips the invitation to response_status=quoted.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.invitation_id || !Array.isArray(body?.lines)) {
      return json(res, 400, { error: { message: "invitation_id and lines required" } });
    }
    const svc = serviceClient();
    const inv = await svc.from("supplier_rfq_invitations").select("*")
      .eq("tenant_id", ctx.tenantId).eq("id", body.invitation_id).maybeSingle();
    if (inv.error) throw new Error(inv.error.message);
    if (!inv.data) return json(res, 404, { error: { message: "invitation not found" } });

    for (const li of body.lines) {
      if (!Number.isFinite(li.line_no)) continue;
      await svc.from("supplier_quotes").upsert({
        tenant_id: ctx.tenantId,
        invitation_id: inv.data.id,
        rfq_id: inv.data.rfq_id,
        vendor_id: inv.data.vendor_id,
        line_no: li.line_no,
        unit_price: li.unit_price ?? null,
        lead_time_days: li.lead_time_days ?? null,
        currency: li.currency || "USD",
        validity_days: li.validity_days || 30,
        supplier_quote_ref: li.supplier_quote_ref || body.supplier_quote_ref || null,
        notes: li.notes || null,
        raw: li.raw || {},
      }, { onConflict: "tenant_id,invitation_id,line_no" });
    }
    await svc.from("supplier_rfq_invitations").update({
      response_received_at: new Date().toISOString(),
      response_status: "quoted",
      notes: body.notes || inv.data.notes,
    }).eq("id", inv.data.id);
    // Move the parent RFQ to quoting if it was still 'sent'.
    const rfqQ = await svc.from("supplier_rfqs").select("status").eq("id", inv.data.rfq_id).maybeSingle();
    if (rfqQ.data?.status === "sent") {
      await svc.from("supplier_rfqs").update({ status: "quoting" }).eq("id", inv.data.rfq_id);
    }
    await recordAudit(ctx, {
      action: "supplier_quote_received",
      objectType: "supplier_rfq_invitation",
      objectId: inv.data.id,
      detail: body.lines.length + " lines",
    });
    return json(res, 200, { ok: true });
  } catch (err) { sendError(res, err); }
}
