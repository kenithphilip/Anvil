// /api/admin/pricing_profile_bindings
//   GET    ?scope_type=&scope_id=   (filter) or all for the tenant
//   POST   upsert one binding       { scope_type, scope_id, profile_code?, margin_floor_pct?, is_active?, notes? }
//   DELETE ?id=...
//
// P3 account/supplier-aware pricing: bind a pricing profile + optional
// margin-floor override to a customer or supplier. The composition
// engine resolves these (see _lib/pricing-bindings.js).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const SCOPES = new Set(["customer", "supplier"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("pricing_profile_bindings").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.scope_type) q = q.eq("scope_type", req.query.scope_type);
      if (req.query.scope_id) q = q.eq("scope_id", req.query.scope_id);
      const { data, error } = await q.order("scope_type", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { bindings: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!SCOPES.has(body.scope_type)) return json(res, 400, { error: { message: "scope_type must be customer or supplier" } });
      if (!body.scope_id) return json(res, 400, { error: { message: "scope_id required" } });
      if (body.profile_code == null && body.margin_floor_pct == null) {
        return json(res, 400, { error: { message: "provide profile_code and/or margin_floor_pct" } });
      }
      const row = {
        tenant_id: ctx.tenantId,
        scope_type: body.scope_type,
        scope_id: body.scope_id,
        profile_code: body.profile_code || null,
        margin_floor_pct: body.margin_floor_pct == null || body.margin_floor_pct === "" ? null : Number(body.margin_floor_pct),
        is_active: body.is_active === false ? false : true,
        notes: body.notes || null,
        updated_at: new Date().toISOString(),
      };
      const up = await svc.from("pricing_profile_bindings")
        .upsert(row, { onConflict: "tenant_id,scope_type,scope_id" })
        .select("*").single();
      if (up.error) throw new Error(up.error.message);
      await recordAudit(ctx, {
        action: "pricing_profile_binding_upsert",
        objectType: body.scope_type, objectId: body.scope_id,
        after: { profile_code: row.profile_code, margin_floor_pct: row.margin_floor_pct },
      });
      return json(res, 200, { binding: up.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("pricing_profile_bindings")
        .delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
