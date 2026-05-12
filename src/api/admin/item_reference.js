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

    // Incoterms (migration 106): union of tenant rows + global seed.
    // Same pattern as uom_options. Pre-106 deployments fall through
    // with an empty array; UI shows "no incoterms loaded yet".
    let incoterms = [];
    try {
      const incoRes = await svc.from("incoterms_v2").select("*").order("sort_order").order("code");
      if (!incoRes.error) {
        const byCode = {};
        for (const r of incoRes.data || []) {
          if (r.tenant_id === null || r.tenant_id === ctx.tenantId) byCode[r.code] = r;
        }
        incoterms = Object.values(byCode).filter((r) => r.is_active);
      }
    } catch (_) {}

    // Order line tax component codes (migration 106) for tax-decomp UI.
    let taxComponents = [];
    try {
      const tcRes = await svc.from("order_line_tax_component_codes").select("*").order("sort_order");
      if (!tcRes.error) taxComponents = (tcRes.data || []).filter((r) => r.is_active);
    } catch (_) {}

    return json(res, 200, {
      uom_options: uomList,
      hsn_codes: hsnRes.data || [],
      taxability_types: taxRes.data || [],
      stock_groups: groupRes.data || [],
      incoterms,
      tax_component_codes: taxComponents,
    });
  } catch (err) {
    sendError(res, err);
  }
}
