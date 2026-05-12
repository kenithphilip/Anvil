// /api/admin/tenant_pricing_settings
//   GET   single row (per tenant)
//   POST  upsert
//
// Carries target margin, default conversion factor, per-currency
// multiplication factors, default freight mode, rounding rule, and
// the "show supplier price in quote" toggle. Quote workspace reads
// these as defaults; per-quote overrides via price_composition_lines.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ROUNDING = new Set(["NEAREST_1", "NEAREST_10", "NEAREST_100", "NONE"]);
const MODES = new Set(["air", "ocean", "road", "courier"]);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const { data, error } = await svc.from("tenant_pricing_settings")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return json(res, 200, { settings: data || null });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const row = {
        tenant_id: ctx.tenantId,
        target_margin_pct: body.target_margin_pct != null ? Number(body.target_margin_pct) : 0.35,
        default_conversion_factor: body.default_conversion_factor != null ? Number(body.default_conversion_factor) : 1.0,
        multiplication_factors: body.multiplication_factors && typeof body.multiplication_factors === "object" ? body.multiplication_factors : {},
        default_freight_mode: MODES.has(body.default_freight_mode) ? body.default_freight_mode : "ocean",
        enable_landed_cost: body.enable_landed_cost == null ? true : !!body.enable_landed_cost,
        rounding_rule: ROUNDING.has(body.rounding_rule) ? body.rounding_rule : "NEAREST_1",
        show_supplier_price_in_quote: !!body.show_supplier_price_in_quote,
        show_reference_price_in_quote: !!body.show_reference_price_in_quote,
      };
      const { data, error } = await svc.from("tenant_pricing_settings")
        .upsert(row, { onConflict: "tenant_id" })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      await recordAudit(ctx, { action: "tenant_pricing_settings_upsert", objectType: "tenant", objectId: ctx.tenantId, after: data });
      return json(res, 200, { settings: data });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
