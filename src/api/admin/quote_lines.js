// /api/admin/quote_lines
//   GET    ?quote_id=...           list lines for a quote (with effective unit price)
//   POST   single + bulk upsert    body: { quote_id, lines: [...] }
//   DELETE ?id=...                 single line
//
// First-class per-quote-line schema introduced by migration 108.
// Sits alongside the legacy quotes.line_items JSONB; existing handlers
// continue to read from JSONB until the next migration drops it.
//
// Auto-computes discounted_unit_price + line_amount from
// (listed_unit_price, discount_pct, qty) when those are supplied
// without explicit overrides, so the renderer never has to recompute.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const NUMERIC_KEYS = [
  "qty", "listed_unit_price", "discount_pct", "discounted_unit_price",
  "line_amount", "cgst_pct", "sgst_pct", "igst_pct", "utgst_pct", "cess_pct",
];

const buildRow = (tenantId, quoteId, raw) => {
  const row = {
    tenant_id: tenantId,
    quote_id: quoteId,
    line_index: Number(raw.line_index),
    part_no: raw.part_no || null,
    description: raw.description || null,
    uom: raw.uom || null,
    hsn_sac: raw.hsn_sac || null,
    customer_part_number: raw.customer_part_number || null,
    source_country: raw.source_country || null,
    remark: raw.remark || null,
  };
  for (const k of NUMERIC_KEYS) {
    if (k in raw) row[k] = raw[k] == null || raw[k] === "" ? null : Number(raw[k]);
  }
  // Auto-compute: discounted_unit_price + line_amount when omitted.
  if (row.listed_unit_price != null && row.discount_pct != null && row.discounted_unit_price == null) {
    row.discounted_unit_price = Number((row.listed_unit_price * (1 - Number(row.discount_pct))).toFixed(4));
  }
  if (row.qty != null && row.line_amount == null) {
    const ppu = row.discounted_unit_price != null
      ? row.discounted_unit_price
      : row.listed_unit_price;
    if (ppu != null) row.line_amount = Number((row.qty * ppu).toFixed(4));
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
      const { data, error } = await svc.from("quote_lines")
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
      const inputs = Array.isArray(body.lines)
        ? body.lines
        : (body.line_index != null ? [body] : []);
      if (!inputs.length) return json(res, 400, { error: { message: "no lines supplied" } });
      const out = [];
      for (const raw of inputs) {
        if (raw.line_index == null) continue;
        const row = buildRow(ctx.tenantId, body.quote_id, raw);
        const upsert = await svc.from("quote_lines")
          .upsert(row, { onConflict: "tenant_id,quote_id,line_index" })
          .select("*")
          .single();
        if (upsert.error) throw new Error(upsert.error.message);
        out.push(upsert.data);
      }
      await recordAudit(ctx, { action: "quote_lines_upsert", objectType: "quote", objectId: body.quote_id, after: { count: out.length } });
      return json(res, 200, { lines: out });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("quote_lines")
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
