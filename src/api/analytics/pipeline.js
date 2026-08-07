// GET /api/analytics/pipeline?granularity=day|week|month&window_days=90&owner_id=&customer_id=
//
// P2 pipeline-conversion report: quotes sent (opportunity_quotes) -> orders
// processed (orders APPROVED) -> sales completed (invoices paid), bucketed by
// period, with an opportunity-stage cohort + stalled-quote worklist + per-rep
// rollup. Live-computed (no snapshot table), cloning the ops_kpis pattern.
//
// Depends on migration 203 (opportunity_quotes). RBAC: managers (approve-tier:
// sales_manager / finance / admin) see all reps; other roles are scoped to
// their own opportunities/quotes (and their customers' orders/invoices).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission, hasPermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { computePipelineConversion } from "../_lib/pipeline-conversion.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  applyCors(req, res);
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return json(res, 405, { error: { message: "Method not allowed" } });
  }
  try {
    const ctx = await resolveContext(req);
    requirePermission(ctx, "read");
    const svc = serviceClient();
    const url = new URL(req.url || "/", "http://x");
    const granularity = url.searchParams.get("granularity") || "week";
    const windowDays = Math.min(730, Math.max(7, Number(url.searchParams.get("window_days") || 90)));
    const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString();

    const isManager = hasPermission(ctx, "approve");
    const selfId = ctx.user?.id || null;
    const explicitOwner = url.searchParams.get("owner_id") || null;
    const explicitCustomer = url.searchParams.get("customer_id") || null;
    const ownerScope = isManager ? explicitOwner : selfId; // uuid or null

    const respond = (payload) => json(res, 200, {
      window_days: windowDays, scoped_to_self: !isManager, as_of: new Date().toISOString(), ...payload,
    });

    // A non-manager with no resolved identity has nothing to show.
    if (!isManager && !selfId) {
      return respond(computePipelineConversion({ quotesSent: [], orders: [], invoices: [], opportunities: [], granularity }));
    }

    // Opportunities first — their stage drives the cohort, and (for a scoped
    // non-manager) their customer set bounds the money side of the funnel.
    let oppSel = svc.from("opportunities")
      .select("id, stage, amount_inr, owner_id, customer_id")
      .eq("tenant_id", ctx.tenantId);
    if (ownerScope) oppSel = oppSel.eq("owner_id", ownerScope);
    if (explicitCustomer) oppSel = oppSel.eq("customer_id", explicitCustomer);
    const opp = await oppSel;
    if (opp.error) throw new Error(opp.error.message);
    const opportunities = opp.data || [];

    const custScope = !isManager
      ? [...new Set(opportunities.map((o) => o.customer_id).filter(Boolean))]
      : (explicitCustomer ? [explicitCustomer] : null);

    // Quotes sent (the top of the funnel).
    let qsSel = svc.from("opportunity_quotes")
      .select("opportunity_id, customer_id, amount, amount_currency, status, sent_at, sent_by, version")
      .eq("tenant_id", ctx.tenantId).eq("status", "sent").gte("sent_at", sinceIso);
    if (ownerScope) qsSel = qsSel.eq("sent_by", ownerScope);
    if (explicitCustomer) qsSel = qsSel.eq("customer_id", explicitCustomer);

    // Money side — orders processed + invoices paid, scoped to the rep's
    // customers for a non-manager so the funnel is internally consistent.
    let ordP, invP;
    if (custScope && custScope.length === 0) {
      ordP = Promise.resolve({ data: [], error: null });
      invP = Promise.resolve({ data: [], error: null });
    } else {
      let ordSel = svc.from("orders")
        .select("status, created_at, approved_at, customer_id")
        .eq("tenant_id", ctx.tenantId).gte("created_at", sinceIso);
      let invSel = svc.from("invoices")
        .select("status, grand_total, paid_amount, paid_at, issue_date, customer_id")
        .eq("tenant_id", ctx.tenantId).eq("status", "paid").gte("paid_at", sinceIso);
      if (custScope) { ordSel = ordSel.in("customer_id", custScope); invSel = invSel.in("customer_id", custScope); }
      ordP = ordSel; invP = invSel;
    }

    const [qs, ord, inv] = await Promise.all([qsSel, ordP, invP]);
    for (const r of [qs, ord, inv]) if (r.error) throw new Error(r.error.message);

    const report = computePipelineConversion({
      quotesSent: qs.data || [],
      orders: ord.data || [],
      invoices: inv.data || [],
      opportunities,
      granularity,
      nowMs: Date.now(),
    });
    return respond(report);
  } catch (err) { sendError(res, err); }
}
