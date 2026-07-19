// /api/locations - internal stocking-location master (MEIO step 4d, Phase A).
//   GET            list locations (tenant-scoped)
//   POST           upsert (location_code required); setting is_default unsets others
//   DELETE ?id=    delete
//
// Additive: the planning engine ignores location_id until MEIO is enabled (Phase
// B). See docs/MEIO_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const cleanStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("locations").select("*").eq("tenant_id", ctx.tenantId).order("location_code");
      if (error) throw new Error(error.message);
      return json(res, 200, { locations: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const code = cleanStr(body.location_code);
      if (!code) return json(res, 400, { error: { message: "location_code required" } });
      const row = {
        tenant_id: ctx.tenantId,
        location_code: code,
        name: cleanStr(body.name),
        location_type: cleanStr(body.location_type),
        gstin: cleanStr(body.gstin),
        state_code: cleanStr(body.state_code),
        address_line1: cleanStr(body.address_line1),
        address_line2: cleanStr(body.address_line2),
        city: cleanStr(body.city),
        pincode: cleanStr(body.pincode),
        is_default: !!body.is_default,
        active: body.active !== false,
        notes: cleanStr(body.notes),
        updated_at: new Date().toISOString(),
      };
      let result;
      if (body.id) {
        result = await svc.from("locations").update(row).eq("tenant_id", ctx.tenantId).eq("id", body.id).select("*").single();
      } else {
        // Create is INSERT-only (not upsert): a duplicate location_code must error,
        // never silently overwrite the existing warehouse's GSTIN/address/default.
        result = await svc.from("locations").insert(row).select("*").single();
      }
      if (result.error) {
        if (!body.id && /duplicate key|already exists|unique|23505/i.test(result.error.message || "")) {
          return json(res, 409, { error: { message: `Location code "${code}" already exists — edit it instead.` } });
        }
        throw new Error(result.error.message);
      }
      // At most one default per tenant.
      if (row.is_default && result.data?.id) {
        const un = await svc.from("locations").update({ is_default: false })
          .eq("tenant_id", ctx.tenantId).eq("is_default", true).neq("id", result.data.id);
        if (un.error) throw new Error(un.error.message);
      }
      await recordAudit(ctx, { action: "location_upsert", objectType: "location", objectId: result.data.id, detail: code });
      return json(res, 200, { location: result.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("locations").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "location_delete", objectType: "location", objectId: id });
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
