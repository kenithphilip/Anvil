// GET /api/mcp/usage  ?since=ISO&limit=N
//
// Recent MCP call log + per-tool counts. Used by the Admin Center to
// show what external assistants have been doing.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url, "http://x");
    const since = url.searchParams.get("since")
      || new Date(Date.now() - 7 * 86400_000).toISOString();
    const limit = Math.min(500, Number(url.searchParams.get("limit") || 200));

    const [recent, totals] = await Promise.all([
      svc.from("mcp_call_log")
        .select("id, token_id, tool, scope, status, error, latency_ms, rows_returned, created_at")
        .eq("tenant_id", ctx.tenantId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(limit),
      svc.from("mcp_call_log")
        .select("tool, status")
        .eq("tenant_id", ctx.tenantId)
        .gte("created_at", since)
        .limit(5000),
    ]);
    if (recent.error) throw new Error(recent.error.message);

    const byTool = new Map();
    let totalCalls = 0;
    let denied = 0;
    let errors = 0;
    for (const r of totals.data || []) {
      totalCalls += 1;
      if (r.status === "denied") denied += 1;
      if (r.status === "error") errors += 1;
      byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1);
    }
    return json(res, 200, {
      recent: recent.data || [],
      summary: {
        total_calls: totalCalls,
        denied,
        errors,
        by_tool: Object.fromEntries(byTool),
        since,
      },
    });
  } catch (err) { sendError(res, err); }
}
