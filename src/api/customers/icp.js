// /api/customers/icp
//
//   GET  ?customer_id=<id>   -> the customer's ICP fit (score/tier/signals).
//                              Computes + persists on first read if never scored.
//   POST { customer_id }     -> recompute + persist now.
//
// ICP fit is a firmographic axis distinct from ai_health_score (behavioral).
// See docs/ICP_FRAMEWORK_DESIGN.md.

import { applyCors, handlePreflight, json, readBody, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { recordAudit } from "../_lib/audit.js";
import { computeAndPersistIcp, scoreAllCustomers } from "../_lib/icp-compute.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    const ctx = await resolveContext(req);
    const svc = serviceClient();

    if (req.method === "GET") {
      requirePermission(ctx, "read");
      const customerId = req.query?.customer_id;
      if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
      const cur = await svc.from("customers")
        .select("icp_score, icp_tier, icp_signals, icp_scored_at, icp_profile_id")
        .eq("tenant_id", ctx.tenantId).eq("id", customerId).maybeSingle();
      if (cur.error) throw new Error(cur.error.message);
      if (!cur.data) return json(res, 404, { error: { message: "Customer not found" } });
      // Compute on first read so the badge is never blank.
      if (cur.data.icp_scored_at == null) {
        const r = await computeAndPersistIcp(svc, ctx.tenantId, customerId);
        if (r) return json(res, 200, { customer_id: customerId, score: r.score, tier: r.tier, signals: r.signals, scored_at: new Date().toISOString(), profile_name: r.profile_name });
      }
      return json(res, 200, {
        customer_id: customerId,
        score: cur.data.icp_score, tier: cur.data.icp_tier,
        signals: cur.data.icp_signals, scored_at: cur.data.icp_scored_at,
      });
    }

    if (req.method === "POST") {
      requirePermission(ctx, "write");
      const body = await readBody(req);
      // Batch re-score (P3): re-score the whole book against the active rubric.
      // Used after editing the ICP profile or a wave of GSTIN data landing.
      if (body?.all === true || req.query?.all === "1") {
        const r = await scoreAllCustomers(svc, ctx.tenantId, { limit: 1000 });
        await recordAudit(ctx, { action: "customer_icp_scored_all", objectType: "customer", objectId: null, after: { scored: r.scored, tiers: r.tiers } });
        return json(res, 200, { rescored: true, ...r });
      }
      const customerId = body?.customer_id || req.query?.customer_id;
      if (!customerId) return json(res, 400, { error: { message: "customer_id required" } });
      const r = await computeAndPersistIcp(svc, ctx.tenantId, customerId);
      if (!r) return json(res, 404, { error: { message: "Customer not found" } });
      await recordAudit(ctx, { action: "customer_icp_scored", objectType: "customer", objectId: customerId, after: { score: r.score, tier: r.tier } });
      return json(res, 200, { customer_id: customerId, ...r, scored_at: new Date().toISOString() });
    }

    res.setHeader("Allow", "GET, POST");
    return json(res, 405, { error: { message: "Method not allowed" } });
  } catch (err) {
    sendError(res, err);
  }
}
