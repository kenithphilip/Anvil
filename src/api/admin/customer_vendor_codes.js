// /api/admin/customer_vendor_codes
//   GET    ?customer_id= or ?vendor_code= (reverse lookup)
//   POST   upsert
//   DELETE ?customer_id=&vendor_code=
//
// Maps each customer to the code they use when referring to this
// tenant as a supplier. A customer may call the seller by its own vendor code on every PO header.
// Stored per (tenant, customer) so the intake flow can resolve
// inbound POs by their vendor code field. Migration 106.

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

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("customer_vendor_codes").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.vendor_code) q = q.eq("vendor_code", String(req.query.vendor_code).trim());
      const { data, error } = await q.order("vendor_code", { ascending: true }).limit(500);
      if (error) throw new Error(error.message);
      return json(res, 200, { mappings: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.customer_id || !body.vendor_code) {
        return json(res, 400, { error: { message: "customer_id and vendor_code required" } });
      }
      // Promote a primary by demoting any other primary for the
      // same customer first.
      if (body.is_primary !== false) {
        await svc.from("customer_vendor_codes")
          .update({ is_primary: false })
          .eq("tenant_id", ctx.tenantId)
          .eq("customer_id", body.customer_id);
      }
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        vendor_code: String(body.vendor_code).trim(),
        is_primary: body.is_primary !== false,
        notes: body.notes || null,
      };
      const { data, error } = await svc.from("customer_vendor_codes")
        .upsert(row, { onConflict: "tenant_id,customer_id,vendor_code" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "customer_vendor_code_upsert", objectType: "customer", objectId: body.customer_id, after: data });
      return json(res, 200, { mapping: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const { customer_id, vendor_code } = req.query || {};
      if (!customer_id || !vendor_code) {
        return json(res, 400, { error: { message: "customer_id and vendor_code required" } });
      }
      const { error } = await svc.from("customer_vendor_codes")
        .delete()
        .eq("tenant_id", ctx.tenantId)
        .eq("customer_id", customer_id)
        .eq("vendor_code", vendor_code);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "customer_vendor_code_delete", objectType: "customer", objectId: customer_id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
