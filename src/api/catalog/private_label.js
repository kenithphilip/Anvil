// CRUD for private_label_items.
//
// GET
// POST   { item_id, label_brand, margin_bps?, notes? }
// PATCH  ?id=...   { active?, margin_bps?, notes? }
// DELETE ?id=...

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
    const url = new URL(req.url, "http://x");
    const id = url.searchParams.get("id");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("private_label_items").select("*")
        .eq("tenant_id", ctx.tenantId).eq("active", true).limit(500);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { items: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.item_id || !body?.label_brand) {
        return json(res, 400, { error: { message: "item_id and label_brand required" } });
      }
      const ins = await svc.from("private_label_items").upsert({
        tenant_id: ctx.tenantId,
        item_id: body.item_id,
        label_brand: body.label_brand,
        margin_bps: body.margin_bps || 0,
        notes: body.notes || null,
        active: true,
      }, { onConflict: "tenant_id,item_id" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, { action: "private_label_added", objectType: "item_master", objectId: body.item_id, detail: body.label_brand });
      return json(res, 200, { item: ins.data });
    }
    if (!id) return json(res, 400, { error: { message: "id required" } });
    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      const r = await svc.from("private_label_items").update(body)
        .eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (r.error) throw new Error(r.error.message);
      await recordAudit(ctx, { action: "private_label_updated", objectType: "private_label_item", objectId: id, detail: Object.keys(body).join(",") });
      return json(res, 200, { item: r.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      await svc.from("private_label_items").update({ active: false }).eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "private_label_deactivated", objectType: "private_label_item", objectId: id, detail: "deactivated" });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
