// GET /api/orders/cost_summary?order_id=<uuid>
//
// Phase E2. Aggregates token usage + estimated USD cost for an
// order across every LLM call the pipeline made on it. Reads
// model_routing_log (the audit table the anthropic.js wrapper
// writes per call) and rolls it up per-model + total.
//
// The price table below is approximate (Anthropic + Google
// public list prices as of 2026-05); replace with a per-tenant
// lookup when the marketplace pricing screen lands. The
// per-call confidence + status are not part of cost; this
// endpoint focuses purely on the "what did we spend" question
// the landing page promises operators can answer.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

// Per-million-tokens USD prices. input + output kept separate
// because Anthropic + Google price them differently. Output is
// 5x input typical. Indian tenants see ₹ via tenant currency
// conversion on the UI side; this endpoint stays in USD.
const PRICE_PER_M = {
  // Anthropic
  "claude-haiku-4-5":      { in: 0.25, out: 1.25 },
  "claude-sonnet-4-6":     { in: 3.00, out: 15.00 },
  "claude-opus-4":         { in: 15.0, out: 75.00 },
  // Google
  "gemini-3-flash-preview":{ in: 0.10, out: 0.40 },
  "gemini-2.5-flash":      { in: 0.10, out: 0.40 },
  "gemini-2.5-pro":        { in: 1.25, out: 10.00 },
};

const PRICE_DEFAULT = { in: 1.00, out: 5.00 };

const costUsd = (model, inputTokens, outputTokens) => {
  const p = PRICE_PER_M[model] || PRICE_DEFAULT;
  const inUsd = (Number(inputTokens) || 0) / 1_000_000 * p.in;
  const outUsd = (Number(outputTokens) || 0) / 1_000_000 * p.out;
  return inUsd + outUsd;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
    const orderId = req.query.order_id;
    if (!orderId) return json(res, 400, { error: { message: "order_id required" } });

    const svc = serviceClient();
    const r = await svc.from("model_routing_log")
      .select("primary_model, total_input_tokens, total_output_tokens, purpose, created_at, primary_status")
      .eq("tenant_id", ctx.tenantId)
      .eq("order_id", orderId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (r.error) throw new Error(r.error.message);

    const calls = r.data || [];
    let inputTokens = 0;
    let outputTokens = 0;
    let totalUsd = 0;
    const perModel = new Map();
    for (const c of calls) {
      const m = c.primary_model || "unknown";
      const inT = Number(c.total_input_tokens) || 0;
      const outT = Number(c.total_output_tokens) || 0;
      const usd = costUsd(m, inT, outT);
      inputTokens += inT;
      outputTokens += outT;
      totalUsd += usd;
      const slot = perModel.get(m) || { model: m, calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 };
      slot.calls += 1;
      slot.input_tokens += inT;
      slot.output_tokens += outT;
      slot.usd += usd;
      perModel.set(m, slot);
    }

    return json(res, 200, {
      order_id: orderId,
      call_count: calls.length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      total_usd: Math.round(totalUsd * 10000) / 10000, // 4 dp
      per_model: [...perModel.values()].sort((a, b) => b.usd - a.usd),
      first_call_at: calls[0]?.created_at || null,
      last_call_at: calls[calls.length - 1]?.created_at || null,
    });
  } catch (err) {
    sendError(res, err);
  }
}

export const __test = { costUsd, PRICE_PER_M, PRICE_DEFAULT };
