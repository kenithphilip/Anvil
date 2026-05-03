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
      const customerId = req.query.customer_id;
      const partNo = req.query.customer_part_no;
      let query = svc.from("part_aliases").select("*").eq("tenant_id", ctx.tenantId).order("updated_at", { ascending: false }).limit(500);
      if (customerId) query = query.eq("customer_id", customerId);
      if (partNo) query = query.eq("customer_part_no", partNo);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return json(res, 200, { aliases: data });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.customer_id || !body.customer_part_no || !body.obara_part_no) {
        return json(res, 400, { error: { message: "customer_id, customer_part_no, obara_part_no required" } });
      }
      const upsert = await svc.from("part_aliases").upsert({
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        customer_part_no: body.customer_part_no,
        customer_description: body.customer_description || null,
        obara_part_no: body.obara_part_no,
        tally_stock_item: body.tally_stock_item || null,
        confidence: body.confidence != null ? body.confidence : 0.9,
        first_seen_po: body.first_seen_po || null,
        last_seen_po: body.last_seen_po || null,
        approved_by: ctx.user ? ctx.user.id : null,
        status: body.status || "active",
      }, { onConflict: "tenant_id,customer_id,customer_part_no" }).select("*").single();
      if (upsert.error) throw new Error(upsert.error.message);
      await recordAudit(ctx, { action: "upsert_alias", objectType: "alias", objectId: upsert.data.id, after: upsert.data });
      return json(res, 200, { alias: upsert.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("part_aliases").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "delete_alias", objectType: "alias", objectId: id });
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
