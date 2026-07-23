// POST /api/erp_chat/send
// Body: { session_id?, content }
//
// Real-time ERP-query chat endpoint. We call Claude with a tool list
// from erp-chat-tools.js; Claude can issue tool_use calls to query
// the mirror tables, and we run the loop until it returns a final
// text answer. Each turn (user, tool calls, assistant) is persisted
// to erp_chat_messages.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { erpChatTools, dispatchErpChatTool } from "../_lib/erp-chat-tools.js";
import { callAnthropic } from "../_lib/anthropic.js";

// Audit P3.4: route the per-loop Anthropic call through
// callAnthropic() so the firewall + redaction + telemetry +
// retry come from the shared helper. The model + agentic-loop
// shape is preserved.
const MODEL = process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-20250514";
const MAX_LOOPS = 5;

const SYSTEM = `You are the Anvil ERP query assistant. Operators ask
questions in natural language about orders, invoices, customers,
and inventory. You answer by calling the provided tools to look up
mirror tables (NetSuite, SAP, Dynamics 365, Acumatica, Tally) and
native Anvil tables (orders, invoices, customers, einvoices).

Rules:
- Use tools whenever a question needs real data. Don't guess.
- Cite the source(s) you used at the end of your answer
  ("Source: netsuite_open_orders, sap_sales_orders").
- If a tool returns no rows, say so honestly.
- COUNTING: tools return total_count (the true number of matches) alongside
  rows (a capped sample). Answer "how many" from total_count. NEVER count the
  rows array -- it is truncated, so counting it under-reports.
- A zero result is a claim about the DATA, not proof. Before concluding
  "there are none", consider that a filter may not have matched (e.g. a status
  spelled differently) and say what you filtered on, so the operator can see
  whether the query -- rather than reality -- produced the zero.
- Keep answers under 200 words unless the user asks for detail.
- For aging / outstanding-money questions use open_invoices_aging.
- For inventory questions use search_inventory; combine across ERPs.
- Never invent IDs.`;

// callClaude removed: the per-loop Anthropic call now goes
// through callAnthropic() from _lib/anthropic.js. See P3.4.

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    if (!body?.content || typeof body.content !== "string") {
      return json(res, 400, { error: { message: "content required" } });
    }
    const svc = serviceClient();

    // Resolve or create session.
    let sessionId = body.session_id;
    if (!sessionId) {
      const ins = await svc.from("erp_chat_sessions").insert({
        tenant_id: ctx.tenantId,
        user_id: ctx.userId || null,
        title: body.content.slice(0, 60),
      }).select("id").single();
      if (ins.error) throw new Error(ins.error.message);
      sessionId = ins.data.id;
    }

    // Persist the user turn.
    await svc.from("erp_chat_messages").insert({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      role: "user",
      content: body.content,
    });

    // Build conversation history from prior messages.
    const prior = await svc.from("erp_chat_messages")
      .select("role, content, tool_call, tool_result")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    const history = [];
    for (const m of prior.data || []) {
      if (m.role === "user") history.push({ role: "user", content: m.content });
      else if (m.role === "assistant") history.push({ role: "assistant", content: m.content });
      // tool turns are ephemeral; rebuild via tool_use/tool_result blocks below
    }

    // Tool-use loop.
    const tools = erpChatTools();
    let messages = [...history];
    let assistantText = "";
    let citations = [];
    let loop = 0;
    let totalLatency = 0;
    let totalTokensIn = 0; let totalTokensOut = 0;
    // Per-turn diagnostics trace (see the tool loop below). Built entirely
    // from metadata the turn already emits — no extra model calls.
    const toolTrace = [];
    while (loop < MAX_LOOPS) {
      loop += 1;
      const t0 = Date.now();
      const result = await callAnthropic({
        tenantId: ctx.tenantId,
        userId: ctx.user?.id || null,
        messages,
        system: SYSTEM,
        purpose: "extraction",
        model: MODEL,
        max_tokens: 2048,
        tools,
        tool_choice: { type: "auto" },
      });
      totalLatency += Date.now() - t0;
      if (!result.ok) {
        return json(res, result.status || 502, {
          ok: false,
          status: result.status,
          error: result.error || result.data?.error || result.data?.raw,
        });
      }
      totalTokensIn += result.data?.usage?.input_tokens || 0;
      totalTokensOut += result.data?.usage?.output_tokens || 0;
      const content = result.data?.content || [];
      const toolCalls = content.filter((b) => b.type === "tool_use");
      const textBlocks = content.filter((b) => b.type === "text");
      assistantText = textBlocks.map((b) => b.text).join("\n").trim();

      if (!toolCalls.length) break;

      // Run each tool, attach a tool_result block, push assistant + user messages.
      const toolResults = [];
      for (const tc of toolCalls) {
        const tToolStart = Date.now();
        const result = await dispatchErpChatTool(ctx.tenantId, tc.name, tc.input || {}, { userId: ctx.user?.id });
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(result) });
        if (result?.source) {
          citations.push({ source: result.source, tool: tc.name });
        }
        // Diagnostics trace. Everything here is metadata the turn ALREADY
        // produced — the tool name the model chose, the arguments it bound,
        // the table the tool read, how many rows came back. Recording it costs
        // no additional model call, which is the constraint: the panel must
        // never itself consume tokens to explain a turn.
        toolTrace.push({
          loop,
          name: tc.name,
          args: tc.input || {},
          source: result?.source || null,
          rows: Array.isArray(result?.rows) ? result.rows.length : null,
          ok: !result?.error,
          error: result?.error ? String(result.error).slice(0, 200) : null,
          proposed: !!result?.proposed,
          ms: Date.now() - tToolStart,
        });
        await svc.from("erp_chat_messages").insert({
          tenant_id: ctx.tenantId,
          session_id: sessionId,
          role: "tool",
          content: tc.name,
          tool_call: { name: tc.name, args: tc.input },
          tool_result: result,
          model: MODEL,
        });
      }
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
      if (loop >= MAX_LOOPS) break;
    }

    // Persist the final assistant turn.
    await svc.from("erp_chat_messages").insert({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      role: "assistant",
      content: assistantText || "(no answer)",
      citations,
      model: MODEL,
      latency_ms: totalLatency,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
    });
    await svc.from("erp_chat_sessions").update({ updated_at: new Date().toISOString() }).eq("id", sessionId);
    await recordAudit(ctx, {
      action: "erp_chat_query",
      objectType: "erp_chat_session",
      objectId: sessionId,
      detail: "loops=" + loop,
    });
    return json(res, 200, {
      ok: true,
      session_id: sessionId,
      content: assistantText,
      citations,
      stats: { loops: loop, latency_ms: totalLatency, tokens_in: totalTokensIn, tokens_out: totalTokensOut },
      // Pipeline diagnostics for THIS prompt. Deliberately assembled from
      // metadata the turn already produced (the provider's own usage counters,
      // the tool calls the model issued, the tables those tools read), so the
      // panel is free: it never triggers an additional model call to describe
      // itself. `schema_refs` is the distinct set of internal tables this
      // answer actually stands on.
      diagnostics: {
        model: MODEL,
        loops: loop,
        latency_ms: totalLatency,
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        tools: toolTrace,
        schema_refs: Array.from(new Set(toolTrace.map((t) => t.source).filter(Boolean))).sort(),
      },
    });
  } catch (err) { sendError(res, err); }
}
