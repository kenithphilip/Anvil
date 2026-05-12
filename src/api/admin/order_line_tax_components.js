// /api/admin/order_line_tax_components
//   GET   ?order_id=...   list all per-line tax + charge rows
//   POST  upsert one or many (body: { order_id, components: [{line_index, component_code, amount, ...}] })
//   DELETE ?id=...
//
// Per-line tax + charge decomposition: SGST, CGST, IGST, UTGST, GST
// Cess, legacy Excise / Ed. Cess / S-VAT / C-VAT, and per-line
// charges (Tooling, P&F, Freight, Insurance, Handling, Others).
// Migration 106 + 106-seed of order_line_tax_component_codes.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      if (!req.query.order_id) return json(res, 400, { error: { message: "order_id required" } });
      const { data, error } = await svc.from("order_line_tax_components")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("order_id", req.query.order_id)
        .order("line_index", { ascending: true })
        .order("component_code", { ascending: true });
      if (error) throw new Error(error.message);
      return json(res, 200, { components: data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      if (!body.order_id) return json(res, 400, { error: { message: "order_id required" } });
      const inputs = Array.isArray(body.components) ? body.components : (body.component_code ? [body] : []);
      if (!inputs.length) return json(res, 400, { error: { message: "no components supplied" } });
      const out = [];
      for (const c of inputs) {
        if (!c.component_code || c.line_index == null) continue;
        const row = {
          tenant_id: ctx.tenantId,
          order_id: body.order_id,
          line_index: Number(c.line_index),
          component_code: String(c.component_code).toLowerCase(),
          component_label: c.component_label || null,
          amount: Number(c.amount || 0),
          rate_pct: c.rate_pct != null ? Number(c.rate_pct) : null,
          is_inclusive: !!c.is_inclusive,
          notes: c.notes || null,
        };
        const upsert = await svc.from("order_line_tax_components")
          .upsert(row, { onConflict: "tenant_id,order_id,line_index,component_code" })
          .select("*")
          .single();
        if (upsert.error) throw new Error(upsert.error.message);
        out.push(upsert.data);
      }
      await recordAudit(ctx, { action: "order_line_tax_components_upsert", objectType: "order", objectId: body.order_id, after: { count: out.length } });
      return json(res, 200, { components: out });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = req.query.id;
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const { error } = await svc.from("order_line_tax_components")
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
