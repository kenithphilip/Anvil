// POST /api/kb/ask
// Body: { content, customer_id?, customer_name? }
//
// Inside-sales knowledge-base assistant. Tool-use loop with the
// catalog-intelligence tools (catalog_lookup, last_purchase_price,
// customer_history, get_quote_status). Audit P3.3: now routes
// through the shared callAnthropic helper so the firewall + PII
// redaction + telemetry come for free, instead of a direct
// api.anthropic.com call.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { recordAudit } from "../_lib/audit.js";
import { erpChatTools, dispatchErpChatTool } from "../_lib/erp-chat-tools.js";
import { callAnthropic } from "../_lib/anthropic.js";

const MAX_LOOPS = 4;

const SYSTEM = `You are Anvil's inside-sales assistant. Reps ask
practical, often urgent questions about customers, quotes, and
catalog items. Answer concisely (under 150 words unless they ask
for detail), cite the data source, and prefer numbers over prose.

Rules:
- Use tools to look up data. Don't guess.
- For "what was Acme's last price" use last_purchase_price.
- For "what's Acme buying recently" use customer_history.
- For "do we have a part like X" use catalog_lookup; surface any
  alternative or private-label upsell prominently.
- For "where's order PO-12345" use get_quote_status.
- End with: Source: <table_name(s)>. If a tool returned no rows,
  say so honestly.`;

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
    const tools = erpChatTools();
    const messages = [{ role: "user", content: body.content }];
    let assistantText = "";
    const citations = [];
    let loop = 0;
    let totalLatency = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    while (loop < MAX_LOOPS) {
      loop += 1;
      const t0 = Date.now();
      // Audit P3.3: callAnthropic applies the firewall + redaction
      // and writes a model_routing_log row per call. Reps' raw
      // questions (which can include part numbers, customer GSTINs)
      // now go through the redaction pipeline.
      const result = await callAnthropic({
        tenantId: ctx.tenantId,
        userId: ctx.user?.id || null,
        messages,
        system: SYSTEM,
        purpose: "extraction",
        max_tokens: 1500,
        tools,
        // Auto so the model can choose to call a tool or answer
        // directly when the question doesn't need a lookup.
        tool_choice: { type: "auto" },
      });
      totalLatency += Date.now() - t0;
      if (!result.ok) {
        return json(res, result.status || 502, {
          ok: false,
          status: result.status,
          error: result.error || result.data?.error?.message || result.data?.error,
        });
      }
      totalTokensIn += result.data?.usage?.input_tokens || 0;
      totalTokensOut += result.data?.usage?.output_tokens || 0;
      const content = result.data?.content || [];
      const toolCalls = content.filter((b) => b.type === "tool_use");
      const textBlocks = content.filter((b) => b.type === "text");
      assistantText = textBlocks.map((b) => b.text).join("\n").trim();
      if (!toolCalls.length) break;
      const toolResults = [];
      for (const tc of toolCalls) {
        const dispatched = await dispatchErpChatTool(ctx.tenantId, tc.name, tc.input || {}, { userId: ctx.user?.id });
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(dispatched) });
        if (dispatched?.source) citations.push({ source: dispatched.source, tool: tc.name });
      }
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
    }
    await recordAudit(ctx, {
      action: "kb_ask",
      objectType: "kb",
      objectId: ctx.user?.id || "system",
      detail: "loops=" + loop,
    });
    return json(res, 200, {
      ok: true,
      content: assistantText || "(no answer)",
      citations,
      stats: { loops: loop, latency_ms: totalLatency, tokens_in: totalTokensIn, tokens_out: totalTokensOut },
    });
  } catch (err) { sendError(res, err); }
}
