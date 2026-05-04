// CRUD for portal_tokens (admin-only).
//
// GET    /api/portal/tokens                  list active tokens
// POST   /api/portal/tokens                  { customer_id, email?, expires_at? } -> creates
// PATCH  /api/portal/tokens?id=...           { revoke: true } -> revokes
// DELETE /api/portal/tokens?id=...

import crypto from "node:crypto";
import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";

const newToken = () => crypto.randomBytes(24).toString("hex");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("portal_tokens").select("id, customer_id, email, scopes, revoked_at, expires_at, last_used_at, use_count, created_at")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false });
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { tokens: r.data || [] });
    }
    if (req.method === "POST") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.customer_id) return json(res, 400, { error: { message: "customer_id required" } });
      const ins = await svc.from("portal_tokens").insert({
        tenant_id: ctx.tenantId,
        customer_id: body.customer_id,
        email: body.email || null,
        scopes: body.scopes || ["quotes", "orders", "invoices", "pay"],
        expires_at: body.expires_at || null,
        token: newToken(),
        created_by: ctx.userId || null,
      }).select("*").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "portal_token_created",
        objectType: "portal_token",
        objectId: ins.data.id,
        detail: "customer=" + body.customer_id,
      });
      return json(res, 200, { token: ins.data });
    }
    if (!id) return json(res, 400, { error: { message: "id required" } });
    if (req.method === "PATCH") {
      requirePermission(ctx, "approve");
      const body = await readBody(req);
      if (!body?.revoke) return json(res, 400, { error: { message: "only revoke supported" } });
      const upd = await svc.from("portal_tokens").update({ revoked_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", id).select("*").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, { action: "portal_token_revoked", objectType: "portal_token", objectId: id, detail: "revoked" });
      return json(res, 200, { token: upd.data });
    }
    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      await svc.from("portal_tokens").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, { action: "portal_token_deleted", objectType: "portal_token", objectId: id, detail: "deleted" });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
