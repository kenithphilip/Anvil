// GET /api/mapping/workspace
//
// Wave CM 5.1: unified mapping workspace data aggregator.
//
// Surfaces every queue the mapping engine produces in one
// response so the operator UI renders without N round-trips:
//
//   - dedupe_candidates    customer_merge_candidates.status='open'
//   - auto_consensus_recent recent item_customer_parts rows with
//                          created_via='auto_consensus' (gives
//                          the operator a feed of "what got
//                          auto-promoted this week").
//   - llm_suggest_pending   recent rows with
//                          created_via='llm_suggest' that the
//                          operator hasn't manually re-confirmed.
//   - mapping_summary       counts per created_via for the
//                          customer-mapping diagnostics dashboard.
//
// Optional ?customer_id=<uuid> scopes everything to one
// customer so the customer-detail drawer pulls a focused view.
//
// Read-only. Honours tenant RLS via the auth context.

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const httpError = (status, message) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const MAX_PER_BUCKET = 50;

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  try {
    if (req.method !== "GET") throw httpError(405, "method_not_allowed");
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const customerId = (req.query && req.query.customer_id) || null;

    // 1. Dedupe candidates (always tenant-wide; filtering by
    //    customer means showing only candidates that involve
    //    that customer in either slot).
    let dedupeQ = svc.from("customer_merge_candidates")
      .select("id, customer_a_id, customer_b_id, probability, suggested_winner_id, status, created_at")
      .eq("tenant_id", ctx.tenantId)
      .in("status", ["open", "in_review"])
      .order("probability", { ascending: false })
      .limit(MAX_PER_BUCKET);
    const dedupeR = await dedupeQ;
    let dedupeRows = dedupeR?.data || [];
    if (customerId) {
      dedupeRows = dedupeRows.filter((r) =>
        r.customer_a_id === customerId || r.customer_b_id === customerId,
      );
    }

    // 2. Recent auto_consensus mappings. We compose every .eq()
    //    filter BEFORE the terminal .order().limit() so the
    //    conditional customer_id filter doesn't trip the chain.
    let consQ = svc.from("item_customer_parts")
      .select("tenant_id, customer_id, item_id, customer_part_number, created_via, confidence_pct, confirmed_at, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("created_via", "auto_consensus");
    if (customerId) consQ = consQ.eq("customer_id", customerId);
    const consR = await consQ
      .order("confirmed_at", { ascending: false })
      .limit(MAX_PER_BUCKET);

    // 3. Recent llm_suggest pending.
    let llmQ = svc.from("item_customer_parts")
      .select("tenant_id, customer_id, item_id, customer_part_number, created_via, confidence_pct, confirmed_at, updated_at")
      .eq("tenant_id", ctx.tenantId)
      .eq("created_via", "llm_suggest");
    if (customerId) llmQ = llmQ.eq("customer_id", customerId);
    const llmR = await llmQ
      .order("created_at", { ascending: false })
      .limit(MAX_PER_BUCKET);

    // 4. Per-created_via tally for the diagnostics chart.
    //    Pull the lightweight view; we don't want to download
    //    every row. Without a server-side group_by, we pull a
    //    bounded sample and tally client-side; for tenants
    //    with > 5k mappings the UI shows the recent
    //    distribution which is the actionable signal anyway.
    let tallyQ = svc.from("item_customer_parts")
      .select("created_via, confirmed_at")
      .eq("tenant_id", ctx.tenantId);
    if (customerId) tallyQ = tallyQ.eq("customer_id", customerId);
    const tallyR = await tallyQ
      .order("confirmed_at", { ascending: false, nullsFirst: false })
      .limit(2000);
    const summary = {};
    for (const row of tallyR?.data || []) {
      const k = row.created_via || "unknown";
      summary[k] = (summary[k] || 0) + 1;
    }

    return json(res, 200, {
      ok: true,
      dedupe_candidates: dedupeRows,
      auto_consensus_recent: consR?.data || [],
      llm_suggest_pending: llmR?.data || [],
      mapping_summary: summary,
      scope: { tenant_id: ctx.tenantId, customer_id: customerId },
    });
  } catch (err) {
    return sendError(res, err);
  }
}
