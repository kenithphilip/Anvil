// /api/admin/item_field_values
//   GET   ?item_id=...                  list custom-field values for an item
//   POST  upsert one value
//   POST  /bulk  body { item_id, values: { field_key: { text|number|boolean|date|json } } }
//   DELETE ?item_id=&field_key=
//
// Stores actual custom-field values keyed against a tenant's
// item_field_definitions schema. Migration 105 enforces the
// (tenant_id, item_id, field_key) primary key.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const coerceValue = (defRow, raw) => {
  // Coerce the raw payload into the typed column matching the field
  // definition. Other typed columns are nulled.
  const row = {
    value_text: null,
    value_number: null,
    value_boolean: null,
    value_date: null,
    value_json: null,
  };
  if (raw == null) return row;
  const t = (defRow && defRow.field_type) || "text";
  switch (t) {
    case "number":
      if (raw === "") return row;
      row.value_number = Number(raw);
      if (Number.isNaN(row.value_number)) row.value_number = null;
      return row;
    case "boolean":
      row.value_boolean = !!raw;
      return row;
    case "date":
      row.value_date = raw || null;
      return row;
    case "select":
    case "text":
    case "file":
    case "url":
      row.value_text = String(raw);
      return row;
    default:
      // Unknown type: stash JSON.
      row.value_json = typeof raw === "object" ? raw : { value: raw };
      return row;
  }
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (!req.query.item_id) return json(res, 400, { error: { message: "item_id required" } });
      const { data, error } = await svc.from("item_field_values")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("item_id", req.query.item_id);
      if (error) throw new Error(error.message);
      return json(res, 200, { values: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body.item_id) return json(res, 400, { error: { message: "item_id required" } });

      // Two shapes: single key (body.field_key + body.value) or bulk
      // (body.values map). Bulk lets the UI persist a whole tab in
      // one round-trip when the operator clicks Save.
      const defsResult = await svc.from("item_field_definitions")
        .select("field_key, field_type")
        .eq("tenant_id", ctx.tenantId);
      if (defsResult.error) throw new Error(defsResult.error.message);
      const byKey = {};
      for (const d of defsResult.data || []) byKey[d.field_key] = d;

      const out = [];
      const pairs = body.values
        ? Object.entries(body.values).map(([k, v]) => [k, v])
        : [[body.field_key, body.value]];
      for (const [key, raw] of pairs) {
        if (!key) continue;
        const def = byKey[key];
        if (!def) continue;                  // Refuse to write unknown keys.
        const typed = coerceValue(def, raw);
        const row = {
          tenant_id: ctx.tenantId,
          item_id: body.item_id,
          field_key: key,
          ...typed,
        };
        const upsert = await svc.from("item_field_values")
          .upsert(row, { onConflict: "tenant_id,item_id,field_key" })
          .select("*")
          .single();
        if (upsert.error) throw new Error(upsert.error.message);
        out.push(upsert.data);
      }
      await recordAudit(ctx, { action: "item_field_values_upsert", objectType: "item_master", objectId: body.item_id, after: { count: out.length } });
      return json(res, 200, { values: out });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      const { item_id, field_key } = req.query || {};
      if (!item_id || !field_key) return json(res, 400, { error: { message: "item_id and field_key required" } });
      const { error } = await svc.from("item_field_values")
        .delete()
        .eq("tenant_id", ctx.tenantId)
        .eq("item_id", item_id)
        .eq("field_key", field_key);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
