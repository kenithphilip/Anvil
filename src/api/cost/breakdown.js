// GET /api/cost/breakdown?customer_id=&since=
// Returns: per-customer, per-month, per-successful-SO, per-field-extracted with trend.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const PRICING = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "claude-opus-4-7": { input: 15, output: 75 },
};

const usdForUsage = (model, usage) => {
  const price = PRICING[model] || PRICING["claude-sonnet-4-20250514"];
  if (!usage) return 0;
  const input = (Number(usage.input_tokens || 0) / 1e6) * price.input;
  const output = (Number(usage.output_tokens || 0) / 1e6) * price.output;
  const cacheCreate = (Number(usage.cache_creation_input_tokens || 0) / 1e6) * price.input * 1.25;
  const cacheRead = (Number(usage.cache_read_input_tokens || 0) / 1e6) * price.input * 0.10;
  return input + output + cacheCreate + cacheRead;
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    let q = svc.from("orders").select("id, status, customer_id, created_at, api_usage, cost_policy_snapshot, evidence_by_field").eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(500);
    if (req.query.customer_id) q = q.eq("customer_id", req.query.customer_id);
    if (req.query.since) q = q.gte("created_at", req.query.since);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const orders = data || [];
    const byMonth = {};
    const byCustomer = {};
    let totalUsd = 0;
    let totalSuccess = 0;
    let totalFields = 0;
    orders.forEach((o) => {
      const usage = o.api_usage || {};
      const parts = [usage.preflight, usage.generation].filter(Boolean);
      let usd = 0;
      parts.forEach((p) => { usd += usdForUsage(o.cost_policy_snapshot && o.cost_policy_snapshot.model || "claude-sonnet-4-20250514", p); });
      totalUsd += usd;
      const month = (o.created_at || "").slice(0, 7);
      byMonth[month] = (byMonth[month] || { month, usd: 0, count: 0, successCount: 0 });
      byMonth[month].usd += usd;
      byMonth[month].count += 1;
      const cid = o.customer_id || "unknown";
      byCustomer[cid] = (byCustomer[cid] || { customer_id: cid, usd: 0, count: 0, success: 0 });
      byCustomer[cid].usd += usd;
      byCustomer[cid].count += 1;
      if (o.status === "APPROVED" || o.status === "EXPORTED_TO_TALLY" || o.status === "RECONCILED") {
        totalSuccess += 1;
        byMonth[month].successCount += 1;
        byCustomer[cid].success += 1;
      }
      totalFields += Object.keys(o.evidence_by_field || {}).length;
    });
    const costPerSuccess = totalSuccess > 0 ? totalUsd / totalSuccess : 0;
    const costPerField = totalFields > 0 ? totalUsd / totalFields : 0;
    return json(res, 200, {
      totalUsd, totalSuccess, totalFields,
      costPerSuccess, costPerField,
      byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
      byCustomer: Object.values(byCustomer).sort((a, b) => b.usd - a.usd).slice(0, 25),
    });
  } catch (err) {
    sendError(res, err);
  }
}
