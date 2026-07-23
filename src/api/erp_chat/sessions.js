// /api/erp_chat/sessions
// GET                          list recent sessions
// GET    ?id=...&messages=true full session with messages
// DELETE ?id=...               remove session

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const id = url.searchParams.get("id");

    if (req.method === "GET" && !id) {
      const r = await svc.from("erp_chat_sessions").select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("updated_at", { ascending: false }).limit(50);
      if (r.error) throw new Error(r.error.message);
      return json(res, 200, { sessions: r.data || [] });
    }
    if (req.method === "GET" && id) {
      const wantMessages = url.searchParams.get("messages") === "true";
      const s = await svc.from("erp_chat_sessions").select("*").eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
      if (s.error) throw new Error(s.error.message);
      if (!s.data) return json(res, 404, { error: { message: "session not found" } });
      let messages = [];
      if (wantMessages) {
        // tokens_in/out are persisted per assistant turn and are what the
        // Ask Anvil diagnostics panel shows for a RESTORED conversation.
        const m = await svc.from("erp_chat_messages").select("id, role, content, tool_call, tool_result, citations, model, latency_ms, tokens_in, tokens_out, created_at")
          .eq("session_id", id).order("created_at", { ascending: true });
        messages = m.data || [];
      }
      return json(res, 200, { session: s.data, messages });
    }
    if (req.method === "DELETE" && id) {
      await svc.from("erp_chat_sessions").delete().eq("tenant_id", ctx.tenantId).eq("id", id);
      return json(res, 200, { ok: true });
    }
    res.setHeader("Allow", "GET, DELETE");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) { sendError(res, err); }
}
