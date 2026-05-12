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
    source_country: raw.source_country || null,
    reference_currency: raw.reference_currency || null,
    notes: raw.notes || null,
  };
  for (const k of numericKeys) {
    if (k in raw) row[k] = raw[k] == null || raw[k] === "" ? null : Number(raw[k]);
  }
  return row;
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
