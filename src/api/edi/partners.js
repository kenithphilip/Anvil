// CRUD for edi_partners.

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
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("edi_partners").select("*").eq("tenant_id", ctx.tenantId).order("name");
      return json(res, 200, { partners: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body?.name) return json(res, 400, { error: { message: "name required" } });
      const ins = await svc.from("edi_partners").insert({
        tenant_id: ctx.tenantId,
        name: body.name,
        isa_qualifier: body.isa_qualifier || null,
        isa_id: body.isa_id || null,
        partner_isa_qualifier: body.partner_isa_qualifier || null,
        partner_isa_id: body.partner_isa_id || null,
        default_format: body.default_format || "x12",
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, { action: "edi_partner_created", objectType: "edi_partner", objectId: ins.data.id, detail: body.name });
      return json(res, 200, { partner: ins.data });
    }
    if (!id) return json(res, 400, { error: { message: "id required" } });
    if (req.method === "PATCH") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      const r = await svc.from("edi_partners").update(body).eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (r.error) throw new Error(r.error.message);
      await recordAudit(ctx, { action: "edi_partner_updated", objectType: "edi_partner", objectId: id, detail: Object.keys(body).join(",") });
      return json(res, 200, { partner: r.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      await svc.from("edi_partners").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "edi_partner_deleted", objectType: "edi_partner", objectId: id, detail: "deleted" });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
