// POST /api/supplier_rfq/award
// Body: { rfq_id, awards: [{ line_no, invitation_id }] }
//
// Records the awarded vendor per line. Sets RFQ status=awarded.
// Optionally generates draft purchase orders against the chosen
// vendors (one PO per vendor). The PO row in `purchase_orders` is
// the existing schema; we just write a draft.

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
    if (!body?.rfq_id || !Array.isArray(body?.awards)) {
      return json(res, 400, { error: { message: "rfq_id and awards required" } });
    }
    const svc = serviceClient();

    for (const aw of body.awards) {
      if (!aw.line_no || !aw.invitation_id) continue;
      await svc.from("supplier_rfq_lines").update({
        awarded_invitation_id: aw.invitation_id,
      }).eq("tenant_id", ctx.tenantId).eq("rfq_id", body.rfq_id).eq("line_no", aw.line_no);
    }
    await svc.from("supplier_rfqs").update({ status: "awarded" })
      .eq("tenant_id", ctx.tenantId).eq("id", body.rfq_id);
    await recordAudit(ctx, {
      action: "supplier_rfq_awarded",
      objectType: "supplier_rfq",
      objectId: body.rfq_id,
      detail: body.awards.length + " lines awarded",
    });
    return json(res, 200, { ok: true });
  } catch (err) { sendError(res, err); }
}
