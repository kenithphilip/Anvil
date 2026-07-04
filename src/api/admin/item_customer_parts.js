// /api/admin/item_customer_parts
//   GET    ?item_id=  OR  ?customer_id=
//   POST   { item_id, customer_id, customer_part_number, ... }       single-row upsert
//          OR { rows: [ ... ] }                                       batch import (Layer D)
//   DELETE ?item_id=&customer_id=&customer_part_number=
//
// Many-to-many: one Anvil item can carry the part number a specific
// customer uses on their POs, and one customer can map many of their
// parts to many Anvil items. Migration 105 adds the table + RLS.
// Migration 115 adds audit columns (created_via, created_by,
// confidence_pct, confirmed_at, confirmed_by) for the learning-loop
// telemetry.
//
// Use case: customer ACME calls a Cutter Holder "CH-DZ-010505";
// The seller's internal part_no is "Cutter Holder DZ-010505". The intake
// flow looks up customer_part_number on inbound POs to auto-resolve
// the line to the canonical item_master row.
//
// Single-row writes from this endpoint are tagged created_via:
// "manual" (the operator typed the mapping in the drawer or
// confirmed an admin add-row). Batch writes are tagged
// "bulk_import". The recon-table manual map and quote-SENT
// learning paths call the same shared helper from their own
// endpoints.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit, recordEvent } from "../_lib/audit.js";
import {
  upsertCustomerPart,
  upsertCustomerPartsBatch,
} from "../_lib/item-customer-parts.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const actor = ctx.user && ctx.user.id ? ctx.user.id : null;

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      let q = svc.from("item_customer_parts").select("*").eq("tenant_id", ctx.tenantId);
      if (req.query.item_id) q = q.eq("item_id", req.query.item_id);
      if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
      // Confirmed mappings sit at the top of the drawer table so
      // the operator sees the freshest signal first. Falls back to
      // updated_at for legacy rows that have no confirmed_at.
      q = q.order("confirmed_at", { ascending: false, nullsFirst: false }).order("updated_at", { ascending: false }).limit(1000);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return json(res, 200, { mappings: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);

      // Batch mode (Layer D): { rows: [{ customer_id|customer_name,
      // customer_part_number, item_master_id|item_master_part_no,
      // customer_part_description?, customer_project?, valid_from?,
      // valid_to?, is_primary? }, ... ] }
      if (Array.isArray(body.rows)) {
        const result = await upsertCustomerPartsBatch(svc, ctx, body.rows);
        await recordAudit(ctx, {
          action: "item_customer_parts_bulk_import",
          objectType: "item_customer_parts",
          objectId: null,
          detail: { ok: result.ok, errors: result.errors.length, total: body.rows.length },
        });
        await recordEvent(ctx, {
          caseId: null,
          eventType: "item_customer_parts_bulk_import",
          objectType: "item_customer_parts",
          objectId: null,
          detail: { ok: result.ok, errors: result.errors.length, total: body.rows.length },
        });
        return json(res, 200, result);
      }

      // Single-row mode (existing admin drawer flow).
      if (!body.item_id || !body.customer_id || !body.customer_part_number) {
        return json(res, 400, { error: { message: "item_id, customer_id, customer_part_number required" } });
      }
      try {
        const { row, action } = await upsertCustomerPart(svc, {
          tenantId: ctx.tenantId,
          itemId: body.item_id,
          customerId: body.customer_id,
          customerPartNumber: body.customer_part_number,
          customerPartDescription: body.customer_part_description || null,
          customerProject: body.customer_project || null,
          validFrom: body.valid_from || null,
          validTo: body.valid_to || null,
          isPrimary: !!body.is_primary,
          createdVia: "manual",
          createdBy: actor,
          confidencePct: 100,
          confirmedAt: new Date().toISOString(),
          confirmedBy: actor,
        });
        await recordAudit(ctx, {
          action: "item_customer_part_upsert",
          objectType: "item_master",
          objectId: body.item_id,
          after: row,
          detail: { upsert_action: action, customer_id: body.customer_id, customer_part_number: body.customer_part_number },
        });
        return json(res, 200, { mapping: row, action });
      } catch (e) {
        return json(res, 400, { error: { message: (e && e.message) || String(e) } });
      }
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
