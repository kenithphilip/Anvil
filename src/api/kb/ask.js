// POST /api/kb/ask
// Body: { content, customer_id?, customer_name? }
//
// Inside-sales knowledge-base assistant. Same Claude tool-use loop
// as /api/erp_chat/send, but with a system prompt scoped to
// quoting + customer-history questions, and the catalog-intelligence
// tools enabled (catalog_lookup + last_purchase_price + customer_history).
//
// Stateless: this endpoint does not persist a session. Reps want a
// quick "what was Acme's last price on SKU-1234" answer; if they
// want a back-and-forth, the existing /api/erp_chat/send is the
// session-backed surface.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { recordAudit } from "../_lib/audit.js";
import { erpChatTools, dispatchErpChatTool } from "../_lib/erp-chat-tools.js";
import { safeFetch } from "../_lib/safe-fetch.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = process.env.ANTHROPIC_MODEL_DEFAULT || "claude-sonnet-4-20250514";
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
    // The KB assistant uses every tool in the registry — reps need
    // breadth. Scopes are not enforced here (the rep is logged in
    // and route-permissioned).
    const tools = erpChatTools();
    const messages = [{ role: "user", content: body.content }];
    let assistantText = "";
    const citations = [];
    let loop = 0;
    let totalLatency = 0;
    let totalTokensIn = 0; let totalTokensOut = 0;
    while (loop < MAX_LOOPS) {
      loop += 1;
      const t0 = Date.now();
      const resp = await callClaude(apiKey, {
        model: MODEL,
        max_tokens: 1500,
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
      const toolResults = [];
      for (const tc of toolCalls) {
        const result = await dispatchErpChatTool(ctx.tenantId, tc.name, tc.input || {});
        toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: JSON.stringify(result) });
        if (result?.source) citations.push({ source: result.source, tool: tc.name });
      }
      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
    }
    await recordAudit(ctx, {
      action: "kb_ask",
      objectType: "kb",
      objectId: ctx.userId || "system",
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
