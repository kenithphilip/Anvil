// GET  /api/spare_matrix           list matrix headers (?customer_id=&project=)
// POST /api/spare_matrix           create a matrix header -> { matrix }
//
// Per-customer/project spare matrix (migration 159). The full matrix
// (columns/rows/recommended) is read/written via /api/spare_matrix/<id>.
// created_by/updated_by = ctx.user.id (plain uuid; no auth.users FK).

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
      let q = svc.from("spare_matrix").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      if (req.query.project) q = q.eq("project_name", req.query.project);
      q = q.order("updated_at", { ascending: false });
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { matrices: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const row = {
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id || null,
        project_name: body.project_name || body.project || null,
        name: body.name || null,
        notes: body.notes || null,
        created_by: (ctx.user && ctx.user.id) || null,
        updated_by: (ctx.user && ctx.user.id) || null,
      };
      const { data, error } = await svc.from("spare_matrix").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, {
        action: "spare_matrix_create",
        objectType: "spare_matrix",
        objectId: data.id,
        detail: { customer_id: row.customer_id, project_name: row.project_name },
      });
      return json(res, 201, { matrix: data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
