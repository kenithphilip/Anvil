// /api/orders/schedule_lines
// Customer schedule lines that arrive separately from the PO header.
// Real-world example: every MG Motor PO has a footnote "*As per Schedule Lines,
// to be sent separately" pointing at a separate spreadsheet attachment.

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
      const orderId = req.query.order_id;
      if (!orderId) return json(res, 400, { error: { message: "order_id required" } });
      const { data, error } = await svc.from("order_schedule_lines")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("order_id", orderId)
        .order("scheduled_date", { ascending: true })
        .limit(2000);
      if (error) throw new Error(error.message);
      return json(res, 200, { schedule_lines: data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.order_id) return json(res, 400, { error: { message: "order_id required" } });
      // Bulk insert when body.rows is provided. Otherwise single insert.
      const rows = Array.isArray(body.rows) && body.rows.length ? body.rows : [body];
      const sourceDocId = body.source_document_id || null;
      const inserts = rows
        .map((r) => ({
          tenant_id: ctx.tenantId,
          order_id: body.order_id,
          line_index: r.line_index != null ? Number(r.line_index) : null,
          part_no: r.part_no || null,
          scheduled_qty: Number(r.scheduled_qty) || 0,
          scheduled_date: r.scheduled_date,
          delivery_location: r.delivery_location || null,
          remark: r.remark || null,
          source_document_id: r.source_document_id || sourceDocId,
        }))
        .filter((r) => r.scheduled_qty > 0 && r.scheduled_date);
      if (!inserts.length) return json(res, 400, { error: { message: "no valid rows. need scheduled_qty + scheduled_date." } });
      const { data, error } = await svc.from("order_schedule_lines").insert(inserts).select("*");
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "schedule_lines_insert", objectType: "order", objectId: body.order_id, detail: "rows=" + inserts.length });
      return json(res, 201, { schedule_lines: data || [], inserted: inserts.length });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      const orderId = req.query.order_id;
      if (id) {
        const { error } = await svc.from("order_schedule_lines").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "schedule_line_delete", objectType: "order_schedule_line", objectId: id });
        return json(res, 200, { ok: true });
      }
      if (orderId) {
        const { error, count } = await svc.from("order_schedule_lines").delete({ count: "exact" }).eq("tenant_id", ctx.tenantId).eq("order_id", orderId);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "schedule_lines_clear", objectType: "order", objectId: orderId, detail: "deleted=" + (count || 0) });
        return json(res, 200, { ok: true, deleted: count || 0 });
      }
      return json(res, 400, { error: { message: "id or order_id required" } });
    }
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
