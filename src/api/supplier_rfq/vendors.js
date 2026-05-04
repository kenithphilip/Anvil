// CRUD for vendors used by the supplier RFQ flow.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("vendors").select("*")
        .eq("tenant_id", ctx.tenantId).eq("active", true)
        .order("vendor_name");
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { vendors: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.vendor_name) return json(res, 400, { error: { message: "vendor_name required" } });
      const ins = await svc.from("vendors").insert({
        tenant_id: ctx.tenantId,
        vendor_name: body.vendor_name,
        vendor_key: body.vendor_key || null,
        contact_email: body.contact_email || null,
        contact_phone: body.contact_phone || null,
        payment_terms: body.payment_terms || null,
        default_lead_time_days: body.default_lead_time_days || null,
        notes: body.notes || null,
        external_ref: body.external_ref || {},
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, { action: "vendor_created", objectType: "vendor", objectId: ins.data.id, detail: body.vendor_name });
      return json(res, 200, { vendor: ins.data });
    }
    if (!id) return json(res, 400, { error: { message: "id required" } });
    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      const r = await svc.from("vendors").update(body)
        .eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (r.error) throw new Error(r.error.message);
      await recordAudit(ctx, { action: "vendor_updated", objectType: "vendor", objectId: id, detail: Object.keys(body).join(",") });
      return json(res, 200, { vendor: r.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      // Soft-delete via active=false to preserve history.
      await svc.from("vendors").update({ active: false }).eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "vendor_deactivated", objectType: "vendor", objectId: id, detail: "deactivated" });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
