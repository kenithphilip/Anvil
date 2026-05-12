// /api/admin/item_field_definitions
//   GET    list the tenant's custom item-field schema
//   POST   upsert one definition  (field_key is unique per tenant)
//   DELETE ?id=
//
// Per-tenant configurable schema for the Item Master. Each tenant
// defines its own extended fields (e.g., "Gun Number", "Customer
// Project", "Source Country") without a code migration. UI surfaces
// these in the item-detail drawer under the "Custom fields" tab,
// plus the per-document visibility flags drive which fields are
// shown on customer invoices vs supplier POs vs the internal master.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const FIELD_TYPES = new Set(["text", "number", "boolean", "select", "date", "file", "url"]);
const FIELD_GROUPS = new Set(["identification", "classification", "tax", "inventory", "engineering", "logistics", "custom"]);

const slug = (s) => String(s || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .slice(0, 60);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("item_field_definitions")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("field_group", { ascending: true })
        .order("field_sort_order", { ascending: true })
        .order("field_label", { ascending: true })
        .limit(500);
      if (error) throw new Error(error.message);
      return json(res, 200, { definitions: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.field_label) return json(res, 400, { error: { message: "field_label required" } });
      const fieldType = FIELD_TYPES.has(body.field_type) ? body.field_type : "text";
      const fieldGroup = FIELD_GROUPS.has(body.field_group) ? body.field_group : "custom";
      const fieldKey = body.field_key ? slug(body.field_key) : slug(body.field_label);
      if (!fieldKey) return json(res, 400, { error: { message: "field_key could not be derived" } });
      const row = {
        tenant_id: ctx.tenantId,
        field_key: fieldKey,
        field_label: String(body.field_label).trim(),
        field_type: fieldType,
        field_group: fieldGroup,
        field_options: Array.isArray(body.field_options) ? body.field_options : [],
        field_default: body.field_default ?? null,
        field_required: !!body.field_required,
        field_sort_order: Number.isFinite(Number(body.field_sort_order)) ? Number(body.field_sort_order) : 100,
        is_visible_invoice: !!body.is_visible_invoice,
        is_visible_po: !!body.is_visible_po,
        // Default visibility on master view is true unless explicitly disabled.
        is_visible_master: body.is_visible_master == null ? true : !!body.is_visible_master,
        is_active: body.is_active == null ? true : !!body.is_active,
      };
      // Upsert on (tenant_id, field_key). The id column is generated
      // server-side; we do not require the caller to send it.
      const { data, error } = await svc.from("item_field_definitions")
        .upsert(row, { onConflict: "tenant_id,field_key" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "item_field_definition_upsert", objectType: "tenant", objectId: ctx.tenantId, after: data });
      return json(res, 200, { definition: data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      // Soft path: mark inactive instead of dropping so historical
      // values stay queryable. Hard delete only on caller intent via
      // ?hard=1 (admin only).
      if (String(req.query.hard) === "1") {
        const { error } = await svc.from("item_field_definitions")
          .delete()
          .eq("tenant_id", ctx.tenantId)
          .eq("id", id);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "item_field_definition_hard_delete", objectType: "tenant", objectId: ctx.tenantId, detail: id });
      } else {
        const { error } = await svc.from("item_field_definitions")
          .update({ is_active: false })
          .eq("tenant_id", ctx.tenantId)
          .eq("id", id);
        if (error) throw new Error(error.message);
        await recordAudit(ctx, { action: "item_field_definition_disable", objectType: "tenant", objectId: ctx.tenantId, detail: id });
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
