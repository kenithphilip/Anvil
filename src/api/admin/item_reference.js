// /api/admin/item_reference
//   GET  unified reference-data bundle for item-master UI dropdowns.
//
// Returns:
//   - uom_options:       per-tenant + global UoMs
//   - hsn_codes:         global India HSN/SAC reference (paginated by ?q=)
//   - taxability_types:  global enum
//   - stock_groups:      per-tenant hierarchy
//
// One round-trip so the item-detail drawer renders all dropdowns
// without N+1 fetches. Migration 105 created the source tables.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();

    // UoMs: union of tenant rows + global seed (tenant_id null). The
    // RLS policy already permits both via `tenant_id is null OR ...`.
    // We dedupe on code, preferring the tenant override over the
    // global seed.
    const uomRes = await svc.from("uom_options")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true })
      .limit(500);
    const uomByCode = {};
    for (const row of uomRes.data || []) {
      // Tenant rows arrive after globals; the assignment naturally
      // overrides because of the order-by sort_order then code.
      if (row.tenant_id === null || row.tenant_id === ctx.tenantId) {
        uomByCode[row.code] = row;
      }
    }
    const uomList = Object.values(uomByCode).filter((r) => r.is_active);

    // HSN codes: optional ?q= for type-ahead. Cap to 50 rows.
    const hsnQ = String(req.query.q || "").trim();
    let hsnQuery = svc.from("hsn_codes").select("*").limit(50);
    if (hsnQ) {
      const safe = hsnQ.replace(/[%_,()*]/g, "\\$&");
      hsnQuery = hsnQuery.or("code.ilike." + safe + "%,description.ilike.%" + safe + "%");
    } else {
      hsnQuery = hsnQuery.order("code", { ascending: true });
    }
    const hsnRes = await hsnQuery;

    // Taxability types: small static list.
    const taxRes = await svc.from("taxability_types").select("*").order("sort_order", { ascending: true });

    // Stock groups: tenant-scoped tree.
    const groupRes = await svc.from("stock_groups")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("label", { ascending: true });

    return json(res, 200, {
      uom_options: uomList,
      hsn_codes: hsnRes.data || [],
      taxability_types: taxRes.data || [],
      stock_groups: groupRes.data || [],
    });
  } catch (err) {
    sendError(res, err);
  }
}
