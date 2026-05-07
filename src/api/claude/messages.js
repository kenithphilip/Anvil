// HTTP wrapper around _lib/anthropic.js callAnthropic().
//
// The wrapper used to inline every behaviour (firewall, redaction,
// model routing, retry, fallback, telemetry). After P3.1 / P3.2 /
// P3.3 / P3.4 those behaviours moved into the shared helper at
// src/api/_lib/anthropic.js so internal callers (docai/claude.js,
// kb/ask.js, erp_chat/send.js) can reuse them without an HTTP
// hop. This file is now a thin auth layer:
//
//   1. Resolve the user's session, require write or admin role.
//   2. Gate bypassFirewall behind admin (audit H7).
//   3. Forward the body fields to callAnthropic().
//   4. Audit the call.
//
// Plus a separate GET ?routing=1 path that lists recent
// model_routing_log entries for the tenant (the routing
// dashboard).

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { recordAudit } from "../_lib/audit.js";
import { serviceClient } from "../_lib/supabase.js";
import { callAnthropic } from "../_lib/anthropic.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method === "GET" && req.query && req.query.routing) {
    try {
      const ctx = await resolveContext(req);
      requirePermission(ctx, "read");
      const svc = serviceClient();
      const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
      const out = await svc.from("model_routing_log")
        .select("*")
        .eq("tenant_id", ctx.tenantId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (out.error) throw new Error(out.error.message);
      return json(res, 200, { log: out.data || [] });
    } catch (err) { return sendError(res, err); }
  }
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });

  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "write");
    const body = await readBody(req);
    if (!body || !body.messages) return json(res, 400, { error: { message: "messages payload required" } });

    // Audit H7: bypassFirewall is admin-only. The HTTP wrapper
    // remains the only place this is enforced; internal helper
    // callers (docai, kb, erp_chat) never pass bypassFirewall=true.
    if (body.bypassFirewall) {
      try { requirePermission(ctx, "admin"); }
      catch (_) {
        return json(res, 403, { error: { code: "BYPASS_FIREWALL_FORBIDDEN", message: "Only admins can bypass the prompt-injection firewall." } });
      }
    }

    const result = await callAnthropic({
      tenantId: ctx.tenantId,
      orderId: body.orderId || null,
      userId: ctx.user?.id || null,
      messages: body.messages,
      system: body.system,
      purpose: body.purpose,
      tier: body.tier,
      model: body.model,
      max_tokens: body.max_tokens,
      tools: body.tools,
      tool_choice: body.tool_choice,
      temperature: body.temperature,
      top_p: body.top_p,
      top_k: body.top_k,
      stop_sequences: body.stop_sequences,
      stream: body.stream,
      metadata: body.metadata,
      cache_ttl: body.cache_ttl,
      bypassFirewall: !!body.bypassFirewall,
      minConfidence: body.minConfidence,
      allowFallback: body.allowFallback,
      confidenceHint: body.confidenceHint,
    });

    await recordAudit(ctx, {
      action: "anthropic_call",
      objectType: "claude_call",
      objectId: result.model,
      detail: "purpose=" + (body.purpose || "extraction") + " tier=" + result.tier + " status=" + result.status,
      after: {
        usage: result.data?.usage || null,
        stop_reason: result.data?.stop_reason || null,
        status: result.status,
        tier: result.tier,
        confidence: result.confidence,
        firewall_bypassed: result.firewall_bypassed,
        tools_used: result.tools_used,
        has_cache_breakpoint: result.has_cache_breakpoint,
      },
    });

    if (!result.ok && !result.data) {
      return json(res, result.status || 502, { error: { message: result.error || "Anthropic call failed" } });
    }
    return json(res, result.status || 200, result.data);
  } catch (err) {
    sendError(res, err);
  }
}
