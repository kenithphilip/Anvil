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
import { safeFetch } from "../_lib/safe-fetch.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
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
- Keep answers under 200 words unless the user asks for detail.
- For aging / outstanding-money questions use open_invoices_aging.
- For inventory questions use search_inventory; combine across ERPs.
- Never invent IDs.`;

const callClaude = async (apiKey, payload) => {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
  const resp = await safeFetch(ANTHROPIC_URL, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await resp.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_e) { parsed = { raw: text.slice(0, 800) }; }
  return { ok: resp.ok, status: resp.status, body: parsed };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return json(res, 500, { error: { message: "ANTHROPIC_API_KEY not configured" } });
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
    while (loop < MAX_LOOPS) {
      loop += 1;
      const t0 = Date.now();
      const resp = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM,
        tools,
        messages,
      });
      totalLatency += Date.now() - t0;
      if (!resp.ok) {
        return json(res, 502, { ok: false, status: resp.status, error: resp.body?.error || resp.body?.raw });
      }
      totalTokensIn += resp.body?.usage?.input_tokens || 0;
      totalTokensOut += resp.body?.usage?.output_tokens || 0;
      const content = resp.body?.content || [];
      const toolCalls = content.filter((b) => b.type === "tool_use");
      const textBlocks = content.filter((b) => b.type === "text");
      assistantText = textBlocks.map((b) => b.text).join("\n").trim();

      if (!toolCalls.length) break;

      // Run each tool, attach a tool_result block, push assistant + user messages.
      const toolResults = [];
      for (const tc of toolCalls) {
        const result = await dispatchErpChatTool(ctx.tenantId, tc.name, tc.input || {});
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(result) });
        if (result?.source) {
          citations.push({ source: result.source, tool: tc.name });
        }
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
    });
  } catch (err) { sendError(res, err); }
}
