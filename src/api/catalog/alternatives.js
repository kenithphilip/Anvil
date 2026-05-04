// CRUD for catalog_alternatives.
//
// GET    ?item_id=...
// POST   { item_id, alternative_item_id, relation, margin_delta_bps?, spec_match_score?, notes? }
// DELETE ?id=...

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const RELATIONS = ["equivalent", "upgrade", "downsell", "crosssell"];

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
      const itemId = url.searchParams.get("item_id");
      let q = svc.from("catalog_alternatives").select("*").eq("tenant_id", ctx.tenantId);
      if (itemId) q = q.eq("item_id", itemId);
      const r = await q.limit(500);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { alternatives: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.item_id || !body?.alternative_item_id || !body?.relation) {
        return json(res, 400, { error: { message: "item_id, alternative_item_id, relation required" } });
      }
      if (!RELATIONS.includes(body.relation)) {
        return json(res, 400, { error: { message: "invalid relation" } });
      }
      const ins = await svc.from("catalog_alternatives").upsert({
        tenant_id: ctx.tenantId,
        item_id: body.item_id,
        alternative_item_id: body.alternative_item_id,
        relation: body.relation,
        margin_delta_bps: body.margin_delta_bps ?? null,
        spec_match_score: body.spec_match_score ?? null,
        notes: body.notes || null,
      }, { onConflict: "tenant_id,item_id,alternative_item_id,relation" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "catalog_alternative_added",
        objectType: "item_master",
        objectId: body.item_id,
        detail: body.relation + "::" + body.alternative_item_id,
      });
      return json(res, 200, { alternative: ins.data });
    }
    if (req.method === "DELETE" && id) {
      requirePermission(ctx, "approve");
      await svc.from("catalog_alternatives").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "catalog_alternative_removed", objectType: "catalog_alternative", objectId: id, detail: "deleted" });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
