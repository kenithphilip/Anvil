// CRUD for MCP tokens (admin-only).
//
// GET    /api/mcp/tokens                       list (token plaintext NEVER returned)
// POST   /api/mcp/tokens                       { name, scopes?, expires_at? } -> creates and returns plaintext ONCE
// PATCH  /api/mcp/tokens?id=...                { revoke: true }
// DELETE /api/mcp/tokens?id=...

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { erpChatScopes, erpChatReadScopes } from "../_lib/erp-chat-tools.js";
import { mcpHashToken, mcpNewToken } from "../_lib/mcp.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();
    const id = req.query?.id || new URL(req.url, "http://x").searchParams.get("id");

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const r = await svc.from("mcp_tokens")
        .select("id, name, token_prefix, scopes, expires_at, revoked_at, last_used_at, use_count, created_at, user_id")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false });
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { tokens: r.data || [], available_scopes: erpChatScopes() });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body?.name) return json(res, 400, { error: { message: "name required" } });
      const allScopes = erpChatScopes();
      // Default-deny write.*: a new token gets read-only scopes unless
      // write scopes are explicitly requested. A copilot token therefore
      // cannot take actions unless issued with the matching write scope.
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes.filter((s) => allScopes.includes(s))
        : erpChatReadScopes();
      const plaintext = mcpNewToken();
      const ins = await svc.from("mcp_tokens").insert({
        tenant_id: ctx.tenantId,
        user_id: ctx.user?.id || null,
        name: body.name,
        token_hash: mcpHashToken(plaintext),
        token_prefix: plaintext.slice(0, 8),
        scopes,
        expires_at: body.expires_at || null,
      }).select("id, name, token_prefix, scopes, expires_at, created_at").single();
      if (ins.error) throw new Error(ins.error.message);
      await recordAudit(ctx, {
        action: "mcp_token_created",
        objectType: "mcp_token",
        objectId: ins.data.id,
        detail: body.name + "::scopes=" + scopes.join(","),
      });
      return json(res, 200, {
        token: ins.data,
        plaintext,
        warning: "Save this token now. It will not be shown again.",
      });
    }

    if (!id) return json(res, 400, { error: { message: "id required" } });

    if (req.method === "PATCH") {
      requirePermission(ctx, "admin");
      const body = await readBody(req);
      if (!body?.revoke) return json(res, 400, { error: { message: "only revoke supported" } });
      const upd = await svc.from("mcp_tokens").update({ revoked_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId).eq("id", id)
        .select("id, name, revoked_at").single();
      if (upd.error) throw new Error(upd.error.message);
      await recordAudit(ctx, {
        action: "mcp_token_revoked",
        objectType: "mcp_token",
        objectId: id,
        detail: "revoked",
      });
      return json(res, 200, { token: upd.data });
    }

    if (req.method === "DELETE") {
      requirePermission(ctx, "admin");
      await svc.from("mcp_tokens").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      await recordAudit(ctx, {
        action: "mcp_token_deleted",
        objectType: "mcp_token",
        objectId: id,
        detail: "deleted",
      });
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
