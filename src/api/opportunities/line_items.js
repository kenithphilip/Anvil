// /api/opportunities/line_items
//
// CRUD for opportunity_line_items (migration 086). Without this
// endpoint the inventory-planning pipeline-demand calculation
// has no input, since pipeline forecasts read from
// opportunity_line_items.
//
// GET    ?opportunity_id=<uuid>   list lines for an opportunity
// POST                             create one line
//        body: { opportunity_id, product_family, product_category?,
//                part_no?, description?, qty, uom?,
//                expected_unit_price?, expected_currency?,
//                expected_close_date?, win_probability_pct? }
// PATCH  ?id=<uuid>                update fields
// DELETE ?id=<uuid>                delete

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const ALLOWED_PATCH_FIELDS = new Set([
  "product_family", "product_category", "part_no", "description",
  "qty", "uom", "expected_unit_price", "expected_currency",
  "expected_close_date", "win_probability_pct",
]);

const validateLineBody = (b) => {
  const errs = [];
  if (!b?.opportunity_id) errs.push("opportunity_id required");
  if (!b?.product_family) errs.push("product_family required");
  if (!Number.isFinite(Number(b?.qty)) || Number(b.qty) <= 0) errs.push("qty must be > 0");
  if (b?.expected_unit_price != null && !Number.isFinite(Number(b.expected_unit_price))) {
    errs.push("expected_unit_price must be a number");
  }
  if (b?.win_probability_pct != null) {
    const w = Number(b.win_probability_pct);
    if (!Number.isFinite(w) || w < 0 || w > 100) {
      errs.push("win_probability_pct must be between 0 and 100");
    }
  }
  return errs;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const url = new URL(req.url || "", "http://x");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const oppId = url.searchParams.get("opportunity_id");
      if (!oppId) return json(res, 400, { error: { message: "opportunity_id required" } });
      const r = await svc.from("opportunity_line_items")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .eq("opportunity_id", oppId)
        .order("line_index", { ascending: true });
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { line_items: r.data || [] });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      const errs = validateLineBody(body);
      if (errs.length) return json(res, 400, { error: { message: errs.join("; ") } });

      // Auto-assign line_index = max + 1 unless caller supplied it.
      let lineIndex = Number(body?.line_index);
      if (!Number.isFinite(lineIndex)) {
        const maxResp = await svc.from("opportunity_line_items")
          .select("line_index")
          .eq("tenant_id", ctx.tenantId)
          .eq("opportunity_id", body.opportunity_id)
          .order("line_index", { ascending: false })
          .limit(1)
          .maybeSingle();
        lineIndex = (maxResp.data?.line_index ?? 0) + 1;
      }

      const ins = await svc.from("opportunity_line_items").insert({
        tenant_id: ctx.tenantId,
        opportunity_id: body.opportunity_id,
        line_index: lineIndex,
        product_family: body.product_family,
        product_category: body.product_category || null,
        part_no: body.part_no || null,
        description: body.description || null,
        qty: Number(body.qty),
        uom: body.uom || "pcs",
        expected_unit_price: body.expected_unit_price == null ? null : Number(body.expected_unit_price),
        expected_currency: body.expected_currency || "INR",
        expected_close_date: body.expected_close_date || null,
        win_probability_pct: body.win_probability_pct == null ? null : Number(body.win_probability_pct),
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "opportunity_line_item_created",
        objectType: "opportunity_line_item",
        objectId: ins.data.id,
        detail: body.opportunity_id + "::" + body.product_family,
      });
      return json(res, 200, { line_item: ins.data });
    }

    if (req.method === "PATCH") {
      requirePermission(ctx, "write");
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const body = await readBody(req);
      const patch = {};
      for (const k of Object.keys(body || {})) {
        if (ALLOWED_PATCH_FIELDS.has(k)) patch[k] = body[k];
      }
      if (Object.keys(patch).length === 0) {
        return json(res, 400, { error: { message: "no recognised fields in body" } });
      }
      if (patch.qty != null && (!Number.isFinite(Number(patch.qty)) || Number(patch.qty) <= 0)) {
        return json(res, 400, { error: { message: "qty must be > 0" } });
      }
      const upd = await svc.from("opportunity_line_items")
        .update(patch)
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*")
        .single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "opportunity_line_item_updated",
        objectType: "opportunity_line_item",
        objectId: id,
        detail: Object.keys(patch).join(","),
      });
      return json(res, 200, { line_item: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "write");
      const id = url.searchParams.get("id");
      if (!id) return json(res, 400, { error: { message: "id required" } });
      const del = await svc.from("opportunity_line_items")
        .delete()
        .eq("tenant_id", ctx.tenantId)
        .eq("id", id)
        .select("*")
        .single();
      if (del.error) throw new Error(del.error.message);
      await recordAudit(ctx, {
        action: "opportunity_line_item_deleted",
        objectType: "opportunity_line_item",
        objectId: id,
        detail: del.data?.product_family || "unknown",
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
