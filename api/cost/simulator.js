// POST /api/cost/simulator
// Body: { tokenEstimate: { totalInput, call2Output }, customerId? }
// Returns simulated cost across the routing ladder so the operator can pick a path.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";

const PRICING = {
  haiku: { input: 0.8, output: 4 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 15, output: 75 },
};

const usd = (model, inT, outT, opts) => {
  const price = PRICING[model];
  let cost = (inT / 1e6) * price.input + (outT / 1e6) * price.output;
  if (opts && opts.cacheRead) cost = cost - (inT / 1e6) * price.input * 0.9; // 10% of input cost when fully cached
  if (opts && opts.cacheWriteTtl === "5m") cost = cost + (inT / 1e6) * price.input * 0.25;
  if (opts && opts.cacheWriteTtl === "1h") cost = cost + (inT / 1e6) * price.input * 1.0;
  return cost;
};

const inr = (u, rate) => u * (Number(rate) || 83);

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const body = await readBody(req);
    const inT = Number(body.tokenEstimate && body.tokenEstimate.totalInput || 0);
    const outT = Number(body.tokenEstimate && body.tokenEstimate.call2Output || 0);
    const usdToInr = Number(body.usdToInr || 83);
    const scenarios = [
      { id: "full_sonnet", label: "Full Sonnet", usd: usd("sonnet", inT, outT) },
      { id: "haiku_pf_sonnet_gen", label: "Haiku preflight + Sonnet generation", usd: usd("haiku", Math.round(inT * 0.4), 600) + usd("sonnet", inT, outT) },
      { id: "template_dry_run", label: "Template dry run + Sonnet only on uncertainty", usd: usd("sonnet", Math.round(inT * 0.2), Math.round(outT * 0.2)) },
      { id: "cached_duplicate", label: "Cached duplicate", usd: 0 },
      { id: "opus_complex", label: "Opus reasoning fallback (worst case)", usd: usd("opus", inT, outT) },
    ];
    return json(res, 200, {
      scenarios: scenarios.map((s) => ({ ...s, inr: inr(s.usd, usdToInr) })),
      tokens: { input: inT, output: outT },
      usdToInr,
    });
  } catch (err) {
    sendError(res, err);
  }
}
