// /api/inventory/suppliers
//   GET    list suppliers (with rolling lead-time + on-time stats)
//   POST   create / upsert
//   PATCH <id>  update mutable fields
//
// Lead-time stats are persisted on the suppliers row by the
// weekly-planning cron (when it estimates lead-time per supplier);
// this endpoint just reads what's there. The S6 dashboard renders
// the table.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const url = new URL(req.url, "http://_");
    const segments = url.pathname.split("/").filter(Boolean);
    const id = segments[3];     // /api/inventory/suppliers/<id>
    const svc = serviceClient();

    if (req.method === "GET" && !id) {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("suppliers")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("supplier_name", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { suppliers: data || [] });
    }

    if (req.method === "POST" && !id) {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body?.supplier_name || !body?.supplier_code) {
        return json(res, 400, { error: { message: "supplier_code + supplier_name required" } });
      }
      const ins = await svc.from("suppliers").upsert({
        tenant_id: ctx.tenantId,
        supplier_code: body.supplier_code,
        supplier_name: body.supplier_name,
        country: body.country || null,
        default_currency: body.default_currency || "INR",
        contact_email: body.contact_email || null,
        contact_phone: body.contact_phone || null,
        ordering_cost_override: body.ordering_cost_override || null,
        notes: body.notes || null,
      }, { onConflict: "tenant_id,supplier_code" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "inventory.supplier.upserted",
        objectType: "supplier",
        objectId: ins.data.id,
        detail: { supplier_code: ins.data.supplier_code },
      });
      return json(res, 200, { supplier: ins.data });
    }

    if (req.method === "PATCH" && id) {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const allowed = [
        "supplier_name", "country", "default_currency",
        "contact_email", "contact_phone", "ordering_cost_override", "notes",
      ];
      const patch = {};
      for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
      const upd = await svc.from("suppliers")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "inventory.supplier.updated",
        objectType: "supplier",
        objectId: id,
        detail: patch,
      });
      return json(res, 200, { supplier: upd.data });
    }

    return json(res, 405, { error: { message: "Unsupported method or path" } });
  } catch (err) { sendError(res, err); }
}
