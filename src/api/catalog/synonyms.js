// CRUD for catalog_synonyms.
//
// GET    ?item_id=...
// POST   { item_id, synonym, source?, confidence? }
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
      const itemId = url.searchParams.get("item_id");
      let q = svc.from("catalog_synonyms").select("*").eq("tenant_id", ctx.tenantId).order("synonym");
      if (itemId) q = q.eq("item_id", itemId);
      const r = await q.limit(500);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { synonyms: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.item_id || !body?.synonym) {
        return json(res, 400, { error: { message: "item_id and synonym required" } });
      }
      const ins = await svc.from("catalog_synonyms").upsert({
        tenant_id: ctx.tenantId,
        item_id: body.item_id,
        synonym: body.synonym,
        source: body.source || "manual",
        confidence: body.confidence ?? 1.0,
      }, { onConflict: "tenant_id,item_id,synonym" }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "catalog_synonym_added",
        objectType: "item_master",
        objectId: body.item_id,
        detail: body.synonym,
      });
      return json(res, 200, { synonym: ins.data });
    }
    if (req.method === "DELETE" && id) {
      requirePermission(ctx, "approve");
      await svc.from("catalog_synonyms").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "catalog_synonym_removed", objectType: "catalog_synonym", objectId: id, detail: "deleted" });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
