// POST or GET /api/rlhf/aggregate
//
// Recomputes rlhf_reward_daily for the caller's tenant (manual trigger,
// admin) or every tenant (cron). Aggregates the previous N days
// from rlhf_feedback and upserts the rollup table.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const CRON_SECRET = process.env.CRON_SECRET;

const recomputeForTenant = async (svc, tenantId, days = 30) => {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  // Pull raw feedback for the window.
  const r = await svc.from("rlhf_feedback")
    .select("surface, rating, model, comment, corrected_output, created_at")
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  if (r.error) throw new Error(r.error.message);

  const buckets = new Map();
  for (const row of r.data || []) {
    const day = row.created_at.slice(0, 10);
    const key = row.surface + "|" + day;
    let b = buckets.get(key);
    if (!b) {
      b = {
        tenant_id: tenantId, surface: row.surface, day,
        positive: 0, negative: 0, neutral: 0, net_score: 0,
        comments_count: 0, corrections_count: 0, models: new Set(),
      };
      buckets.set(key, b);
    }
    if (row.rating > 0) b.positive += 1;
    else if (row.rating < 0) b.negative += 1;
    else b.neutral += 1;
    b.net_score = b.positive - b.negative;
    if (row.comment) b.comments_count += 1;
    if (row.corrected_output) b.corrections_count += 1;
    if (row.model) b.models.add(row.model);
  }

  let upserted = 0;
  for (const b of buckets.values()) {
    const upsert = await svc.from("rlhf_reward_daily").upsert({
      tenant_id: b.tenant_id, surface: b.surface, day: b.day,
      positive: b.positive, negative: b.negative, neutral: b.neutral,
      net_score: b.net_score,
      comments_count: b.comments_count,
      corrections_count: b.corrections_count,
      models: Array.from(b.models),
    }, { onConflict: "tenant_id,surface,day" });
    if (!upsert.error) upserted += 1;
  }
  return { tenant_id: tenantId, days, buckets: buckets.size, upserted };
};

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const isCron = !!CRON_SECRET && auth === CRON_SECRET;
    const svc = serviceClient();
    if (isCron) {
      const tenants = await svc.from("rlhf_feedback").select("tenant_id");
      const uniq = Array.from(new Set((tenants.data || []).map((t) => t.tenant_id)));
      const out = [];
      for (const tid of uniq) out.push(await recomputeForTenant(svc, tid, 30));
      return json(res, 200, { ran_at: new Date().toISOString(), tenants: out });
    }
    const ctx = await resolveContext(req);
    requirePermission(ctx, "approve");
    const body = req.method === "POST" ? await readBody(req) : {};
    const days = Math.min(180, Number(body?.days || 30));
    const result = await recomputeForTenant(svc, ctx.tenantId, days);
    return json(res, 200, { ran_at: new Date().toISOString(), ...result });
  } catch (err) { sendError(res, err); }
}
