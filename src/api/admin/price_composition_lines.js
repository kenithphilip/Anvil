// /api/admin/price_composition_lines
//   GET   ?quote_id=...           lines for a quote
//   POST  upsert one or bulk     (body: { quote_id, lines: [...] })
//   DELETE ?id=...
//
// Per-quote-line internal pricing carrying the multi-tier margin,
// supplier price, reference price columns from the Price Composition
// Excel master sheet. Migration 106.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { composePrice, mapProfile } from "../_lib/pricing.js";

const numericKeys = [
  "qty", "supplier_unit_price", "total_cost",
  "mod1", "mod2", "mod3", "landed_cost", "profit_pct", "profit_setting",
  "reference_price", "selling_unit_price", "selling_total", "conversion_factor",
];

const buildRow = (tenantId, quoteId, raw) => {
  const row = {
    tenant_id: tenantId,
    quote_id: quoteId,
    quote_version: raw.quote_version != null ? Number(raw.quote_version) : null,
    line_index: Number(raw.line_index),
    part_no: raw.part_no || null,
    unit: raw.unit || null,
    supplier_currency: raw.supplier_currency || null,
    supplier_quote_no: raw.supplier_quote_no || null,
    supplier_name: raw.supplier_name || null,
    source_country: raw.source_country || null,
    reference_currency: raw.reference_currency || null,
    notes: raw.notes || null,
  };
  for (const k of numericKeys) {
    if (k in raw) row[k] = raw[k] == null || raw[k] === "" ? null : Number(raw[k]);
  }
  return row;
};

// Resolve a pricing profile by code for the tenant (own row shadows a
// global of the same code), with its ordered components. Returns the
// engine-shaped profile, or null when not found.
const resolveProfile = async (svc, tenantId, code) => {
  let prof = null;
  if (code) {
    const own = await svc.from("pricing_profiles").select("*")
      .eq("tenant_id", tenantId).eq("code", code).maybeSingle();
    if (own.error) throw new Error(own.error.message);
    prof = own.data;
    if (!prof) {
      const glob = await svc.from("pricing_profiles").select("*")
        .is("tenant_id", null).eq("code", code).maybeSingle();
      if (glob.error) throw new Error(glob.error.message);
      prof = glob.data;
    }
  }
  if (!prof) return null;
  const comps = await svc.from("pricing_components").select("*")
    .eq("profile_id", prof.id).order("seq", { ascending: true });
  if (comps.error) throw new Error(comps.error.message);
  return mapProfile({ ...prof, components: comps.data || [] });
};

// Recompute + persist a quote's price composition server-side so the
// stored price is authoritative (never trusts a client-sent total).
const handleRecompute = async (svc, ctx, body, res) => {
  if (!body.quote_id) return json(res, 400, { error: { message: "quote_id required" } });
  if (!body.profile_code) return json(res, 400, { error: { message: "profile_code required" } });
  const inputs = Array.isArray(body.lines) ? body.lines : [];
  if (!inputs.length) return json(res, 400, { error: { message: "no lines supplied" } });
  const profile = await resolveProfile(svc, ctx.tenantId, body.profile_code);
  if (!profile) return json(res, 404, { error: { message: "Pricing profile not found: " + body.profile_code } });
  const fx = body.fx && typeof body.fx === "object" ? body.fx : { base: "INR", rates: { INR: 1 } };

  const out = [];
  for (const ln of inputs) {
    if (ln.line_index == null) continue;
    const r = composePrice(profile, {
      qty: Number(ln.qty) || 0,
      supplierUnitPrice: Number(ln.supplier_unit_price) || 0,
      supplierCurrency: ln.supplier_currency || profile.baseCurrency,
      sourceCountry: ln.source_country,
      weightKg: ln.weight_kg != null ? Number(ln.weight_kg) : undefined,
      volumeCbm: ln.volume_cbm != null ? Number(ln.volume_cbm) : undefined,
      discountPct: ln.discount_pct != null ? Number(ln.discount_pct) : undefined,
      supplierQuoteValidTo: ln.supplier_quote_valid_to,
    }, fx);
    const row = {
      tenant_id: ctx.tenantId,
      quote_id: body.quote_id,
      quote_version: ln.quote_version != null ? Number(ln.quote_version) : null,
      line_index: Number(ln.line_index),
      part_no: ln.part_no || null,
      unit: ln.unit || null,
      supplier_unit_price: Number(ln.supplier_unit_price) || 0,
      supplier_currency: ln.supplier_currency || profile.baseCurrency,
      supplier_quote_no: ln.supplier_quote_no || null,
      supplier_name: ln.supplier_name || null,
      source_country: ln.source_country || null,
      qty: Number(ln.qty) || 0,
      weight_kg: ln.weight_kg != null ? Number(ln.weight_kg) : null,
      volume_cbm: ln.volume_cbm != null ? Number(ln.volume_cbm) : null,
      discount_pct: ln.discount_pct != null ? Number(ln.discount_pct) : null,
      profile_code: profile.code,
      fx_snapshot: fx,
      waterfall: r.waterfall,
      warnings: r.warnings,
      landed_cost: r.perUnit.loadedCost,
      selling_unit_price: r.perUnit.finalPrice,
      selling_total: r.lineTotal,
      profit_pct: r.marginRealized,
      profit_setting: r.marginTarget,
      margin_realized: r.marginRealized,
      margin_floor: profile.marginFloorPct,
      conversion_factor: r.effectiveMultiplier,
      updated_at: new Date().toISOString(),
    };
    let upsert = await svc.from("price_composition_lines")
      .upsert(row, { onConflict: "tenant_id,quote_id,line_index" })
      .select("*").single();
    // Pre-139 deployments lack supplier_name; strip and retry once.
    if (upsert.error && (upsert.error.code === "42703" || /supplier_name/i.test(upsert.error.message))) {
      delete row.supplier_name;
      upsert = await svc.from("price_composition_lines")
        .upsert(row, { onConflict: "tenant_id,quote_id,line_index" })
        .select("*").single();
    }
    if (upsert.error) throw new Error(upsert.error.message);
    out.push(upsert.data);
  }
  await recordAudit(ctx, { action: "price_composition_recompute", objectType: "quote", objectId: body.quote_id, after: { count: out.length, profile: profile.code } });
  return json(res, 200, { lines: out, profile: { code: profile.code, margin_floor_pct: profile.marginFloorPct } });
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (!req.query.quote_id) return json(res, 400, { error: { message: "quote_id required" } });
      const { data, error } = await svc.from("price_composition_lines")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("quote_id", req.query.quote_id)
        .order("line_index", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { lines: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      // Server-authoritative recompute: ?action=recompute or { recompute:true }.
      if (req.query?.action === "recompute" || body.recompute === true) {
        return await handleRecompute(svc, ctx, body, res);
      }
      if (!body.quote_id) return json(res, 400, { error: { message: "quote_id required" } });
      const inputs = Array.isArray(body.lines) ? body.lines : (body.line_index != null ? [body] : []);
      if (!inputs.length) return json(res, 400, { error: { message: "no lines supplied" } });
      const out = [];
      for (const ln of inputs) {
        if (ln.line_index == null) continue;
        const row = buildRow(ctx.tenantId, body.quote_id, ln);
        const upsert = await svc.from("price_composition_lines")
          .upsert(row, { onConflict: "tenant_id,quote_id,line_index" })
          .select("*")
          .single();
        if (upsert.error) throw new Error(upsert.error.message);
        out.push(upsert.data);
      }
      await recordAudit(ctx, { action: "price_composition_lines_upsert", objectType: "quote", objectId: body.quote_id, after: { count: out.length } });
      return json(res, 200, { lines: out });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("price_composition_lines")
        .delete()
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id);
      if (error) throw new Error(error.message);
      return json(res, 200, { ok: true });
    }

    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
