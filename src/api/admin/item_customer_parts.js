// /api/admin/item_customer_parts
//   GET    ?item_id=  OR  ?customer_id=
//   POST   upsert one mapping
//   DELETE ?item_id=&customer_id=&customer_part_number=
//
// Many-to-many: one Anvil item can carry the part number a specific
// customer uses on their POs, and one customer can map many of their
// parts to many Anvil items. Migration 105 adds the table + RLS.
//
// Use case: customer ACME calls a Cutter Holder "CH-DZ-010505";
// Obara's internal part_no is "Cutter Holder DZ-010505". The intake
// flow looks up customer_part_number on inbound POs to auto-resolve
// the line to the canonical item_master row.

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
      let q = svc.from("item_customer_parts").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.item_id) q = q.eq("item_id", req.query.item_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      q = q.order("updated_at", { ascending: false }).limit(1000);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { mappings: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.item_id || !body.customer_id || !body.customer_part_number) {
        return json(res, 400, { error: { message: "item_id, customer_id, customer_part_number required" } });
      }
      // When is_primary is set true, demote every other mapping for
      // this (tenant, item, customer) so there is at most one
      // primary per pair.
      if (body.is_primary) {
        await svc.from("item_customer_parts")
          .update({ is_primary: false })
          .eq("tenant_id", ctx.tenantId)
          .eq("item_id", body.item_id)
          .eq("customer_id", body.customer_id);
      }
      const row = {
        tenant_id: ctx.tenantId,
        item_id: body.item_id,
        customer_id: body.customer_id,
        customer_part_number: String(body.customer_part_number).trim(),
        customer_part_description: body.customer_part_description || null,
        customer_project: body.customer_project || null,
        valid_from: body.valid_from || null,
        valid_to: body.valid_to || null,
        is_primary: !!body.is_primary,
      };
      const { data, error } = await svc.from("item_customer_parts")
        .upsert(row, { onConflict: "tenant_id,item_id,customer_id,customer_part_number" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "item_customer_part_upsert", objectType: "item_master", objectId: body.item_id, after: data });
      return json(res, 200, { mapping: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const { item_id, customer_id, customer_part_number } = req.query || {};
      if (!item_id || !customer_id || !customer_part_number) {
        return json(res, 400, { error: { message: "item_id, customer_id, customer_part_number required" } });
      }
      const { error } = await svc.from("item_customer_parts")
        .delete()
        .eq("tenant_id", ctx.tenantId)
        .eq("item_id", item_id)
        .eq("customer_id", customer_id)
        .eq("customer_part_number", customer_part_number);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "item_customer_part_delete", objectType: "item_master", objectId: item_id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
