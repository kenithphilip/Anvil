// POST /api/inventory/explain
// Body: { plan_id: uuid }
//
// Generates a one-paragraph plain-English rationale for a planned
// PO. Reuses the Haiku-tier Anthropic plumbing from
// /api/anomaly/explain so we don't add new infra. Cached via the
// planned-PO id + version to keep cost bounded.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { callAnthropic } from "../_lib/anthropic.js";

const SYSTEM_PROMPT = [
  "You are an inventory-planning copilot for a manufacturing operations team.",
  "Operators approve or release planned purchase orders for long-lead bundled items (ATD, Timer).",
  "Given a plan's rationale (decomposed forecast, position, lead time, EOQ candidates, top opportunities) explain in 2-3 short sentences:",
  " (1) why the system recommends this PO at this time,",
  " (2) which one or two opportunities are the largest demand contributors,",
  " (3) the one risk the operator should weigh before approval.",
  "Be specific with numbers. No hedging. No marketing language. No emoji.",
].join("\n");

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const planId = body?.plan_id;
    if (!planId) return json(res, 400, { error: { message: "plan_id required" } });
    const svc = serviceClient();
    const plan = await svc.from("procurement_plans")
      .select("*").eq("tenant_id", ctx.tenantId).eq("id", planId).single();
    if (plan.error) throw new Error(plan.error.message);
    const r = plan.data?.rationale || {};
    const userPrompt = [
      "Plan summary:",
      "  Part: " + plan.data.part_no,
      "  Recommended qty: " + plan.data.recommended_qty,
      "  Order by: " + plan.data.recommended_order_date,
      "  Expected arrival: " + plan.data.expected_arrival_date,
      "  Net requirement: " + plan.data.net_requirement,
      "  Policy source: " + plan.data.policy_source,
      "Rationale jsonb:",
      JSON.stringify(r, null, 2),
    ].join("\n");
    const out = await callAnthropic({
      tenantId: ctx.tenantId,
      purpose: "anomaly_explain",
      tier: "preflight",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });
    if (!out.ok) {
      return json(res, 200, {
        explanation: "(LLM explanation unavailable; review the rationale fields directly.)",
        model: out.model || null, error: out.error || null,
      });
    }
    const text = out.data?.content?.[0]?.text || "(no content)";
    return json(res, 200, { explanation: text, model: out.model });
  } catch (err) { sendError(res, err); }
}
