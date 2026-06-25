// POST /api/supplier_rfq/customer_ref
// Body: { vendor_id, customer_id, customer_ref }
//
// Upserts the reference/code a vendor knows an end customer by, so
// customer-specific (special) rates can be requested. Reused across RFQs via
// the (tenant, vendor, customer) unique key. An empty customer_ref removes it.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = await readBody(req);
    if (!body?.vendor_id || !body?.customer_id) {
      return json(res, 400, { error: { message: "vendor_id and customer_id required" } });
    }
    const svc = serviceClient();
    const ref = (body.customer_ref || "").trim();

    if (!ref) {
      const del = await svc.from("vendor_customer_refs").delete()
        .eq("tenant_id", ctx.tenantId).eq("vendor_id", body.vendor_id).eq("customer_id", body.customer_id);
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, { action: "vendor_customer_ref_cleared", objectType: "vendor", objectId: body.vendor_id, detail: body.customer_id });
      return json(res, 200, { ok: true, cleared: true });
    }

    const up = await svc.from("vendor_customer_refs").upsert({
      tenant_id: ctx.tenantId,
      vendor_id: body.vendor_id,
      customer_id: body.customer_id,
      customer_ref: ref,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,vendor_id,customer_id" }).select("*").single();
    if (up.error) throw new Error(up.error.message);
    await recordAudit(ctx, { action: "vendor_customer_ref_set", objectType: "vendor", objectId: body.vendor_id, detail: body.customer_id + "=" + ref });
    return json(res, 200, { ok: true, ref: up.data });
  } catch (err) { sendError(res, err); }
}
