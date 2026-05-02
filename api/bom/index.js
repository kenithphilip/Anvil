// CRUD for bill_of_materials
// GET    /api/bom?parent=&child=         -> list
// POST   /api/bom                         -> upsert single row
// DELETE /api/bom?id=                     -> delete

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
      let q = svc.from("bill_of_materials").select("*").eq("tenant_id", ctx.tenantId).order("parent_part_no").limit(2000);
      if (req.query.parent) q = q.eq("parent_part_no", String(req.query.parent).trim());
      if (req.query.child) q = q.eq("child_part_no", String(req.query.child).trim());
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { rows: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [body];
      const cleaned = rows.map((r) => ({
        tenant_id: ctx.tenantId,
        parent_part_no: String(r.parent_part_no || r.parent || "").trim(),
        child_part_no: String(r.child_part_no || r.child || "").trim(),
        qty: Number(r.qty || 1),
        uom: r.uom || null,
        notes: r.notes || null,
      })).filter((r) => r.parent_part_no && r.child_part_no);
      if (!cleaned.length) return json(res, 400, { error: { message: "parent_part_no and child_part_no required" } });
      const upsert = await svc.from("bill_of_materials").upsert(cleaned, { onConflict: "tenant_id,parent_part_no,child_part_no" });
      if (upsert.error) throw new Error(upsert.error.message);
      await recordAudit(ctx, { action: "bom_upsert", objectType: "bill_of_materials", objectId: null, detail: "rows=" + cleaned.length });
      return json(res, 200, { ok: true, count: cleaned.length });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("bill_of_materials").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "bom_delete", objectType: "bill_of_materials", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
