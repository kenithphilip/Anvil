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
import { buildQuoteLineRow } from "../quotes/_lib/quote-build.js";

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
        const row = buildQuoteLineRow(ctx.tenantId, body.quote_id, raw);
        let upsert = await svc.from("quote_lines")
          .upsert(row, { onConflict: "tenant_id,quote_id,line_index" })
          .select("*")
          .single();
        // Pre-167 deployments lack supplier_id; strip and retry once.
        if (upsert.error && (upsert.error.code === "42703" || /supplier_id/i.test(upsert.error.message))) {
          delete row.supplier_id;
          upsert = await svc.from("quote_lines")
            .upsert(row, { onConflict: "tenant_id,quote_id,line_index" })
            .select("*").single();
        }
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
