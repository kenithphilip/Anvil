// GET /api/brsr/buyer/dashboard?fy=FY2025-26
//
// Roll up the listed-company buyer-tenant's tier-2 supplier
// coverage:
//   - which Anvil-tenant suppliers have accepted our invite
//   - their FY share % + materiality flag (>= 2%)
//   - period status (open / submitted / locked / assured)
//   - rolled-up Scope 3 (spend-weighted attribution per
//     supplier scope1 + scope2)
//   - 75% cumulative coverage gauge (the SEBI threshold for
//     value-chain disclosure scope)
//
// RBAC: admin / finance / sales_manager.

import { applyCors, handlePreflight, json, sendError } from "../../_lib/cors.js";
import { resolveContext, requirePermission } from "../../_lib/auth.js";
import { serviceClient } from "../../_lib/supabase.js";
import { rollupBuyerScope3 } from "../../_lib/brsr/emission_factors.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const url = new URL(req.url, "http://_");
    const fy = url.searchParams.get("fy");
    const svc = serviceClient();

    // 1. Active relationships for this buyer (accepted only).
    const rels = await svc.from("value_chain_relationships").select("*")
      .eq("buyer_tenant_id", ctx.tenantId)
      .eq("consent_status", "accepted");
    if (rels.error) throw new Error(rels.error.message);
    const suppliers = rels.data || [];
    if (!suppliers.length) {
      return json(res, 200, {
        suppliers: [],
        rollup: rollupBuyerScope3([]),
        coverage: { reached_75_pct: false, total_share_pct: 0, material_count: 0 },
        materiality_threshold: 2,
      });
    }
    const supplierIds = suppliers.map((s) => s.supplier_tenant_id);

    // 2. Matching periods + disclosures for each supplier. We
    // bias to the requested FY; if missing, take the most-recent
    // submitted/locked/assured per supplier.
    let periodQ = svc.from("supplier_disclosure_periods")
      .select("id, tenant_id, fiscal_year, cadence, status, submitted_at, locked_at, assured_at, period_end")
      .in("tenant_id", supplierIds);
    if (fy) periodQ = periodQ.eq("fiscal_year", fy);
    periodQ = periodQ.order("period_end", { ascending: false });
    const periodResp = await periodQ;
    if (periodResp.error) throw new Error(periodResp.error.message);
    const periodBySupplier = new Map();
    for (const p of (periodResp.data || [])) {
      if (!periodBySupplier.has(p.tenant_id)) periodBySupplier.set(p.tenant_id, p);
    }
    const periodIds = Array.from(periodBySupplier.values()).map((p) => p.id);
    const discResp = periodIds.length
      ? await svc.from("supplier_disclosures")
          .select("tenant_id, period_id, scope1_tco2e, scope2_tco2e, revenue_inr, updated_at")
          .in("period_id", periodIds)
      : { data: [] };
    if (discResp.error) throw new Error(discResp.error.message);
    const discBySupplier = new Map();
    for (const d of (discResp.data || [])) discBySupplier.set(d.tenant_id, d);

    // 3. Build the per-supplier rollup payload.
    const supplierRows = suppliers.map((rel) => {
      const period = periodBySupplier.get(rel.supplier_tenant_id) || null;
      const disc = discBySupplier.get(rel.supplier_tenant_id) || null;
      return {
        supplier_tenant_id: rel.supplier_tenant_id,
        share_pct: Number(rel.buyer_purchase_share_pct) || 0,
        is_material: rel.is_material,
        period: period
          ? {
              id: period.id,
              fiscal_year: period.fiscal_year,
              status: period.status,
              submitted_at: period.submitted_at,
              locked_at: period.locked_at,
              assured_at: period.assured_at,
            }
          : null,
        disclosure: disc
          ? {
              scope1_tco2e: Number(disc.scope1_tco2e) || 0,
              scope2_tco2e: Number(disc.scope2_tco2e) || 0,
              revenue_inr: Number(disc.revenue_inr) || 0,
              updated_at: disc.updated_at,
            }
          : null,
      };
    });

    // 4. Roll up Scope 3 contributions + cumulative coverage.
    const rollupInput = supplierRows.map((r) => ({
      supplier_tenant_id: r.supplier_tenant_id,
      scope1_tco2e: r.disclosure?.scope1_tco2e || 0,
      scope2_tco2e: r.disclosure?.scope2_tco2e || 0,
      buyer_purchase_share_pct: r.share_pct,
    }));
    const rollup = rollupBuyerScope3(rollupInput);

    const coverage = {
      reached_75_pct: rollup.coverage_75_pct_reached,
      total_share_pct: rollup.total_spend_share_pct,
      material_count: supplierRows.filter((r) => r.is_material).length,
      reporting_count: supplierRows.filter((r) => r.period?.status &&
        ["submitted", "locked", "assured"].includes(r.period.status)).length,
    };

    return json(res, 200, {
      suppliers: supplierRows,
      rollup,
      coverage,
      materiality_threshold: 2,
      fiscal_year: fy || null,
    });
  } catch (err) { sendError(res, err); }
}
