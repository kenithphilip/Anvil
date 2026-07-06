// GET /api/analytics/ops_kpis?window_days=90
//
// Live-computed sales-ops KPI / SLA substrate for the cockpit:
//   - AR aging (outstanding by days-past-due) + overdue rate   [revenue/cash]
//   - cycle-time medians: quote created→sent→accepted, order   [bottlenecks]
//     created→approved
//   - revenue by rep (accepted quotes)                          [revenue]
//
// Computes from live invoices / quotes / orders (no snapshot table). The
// window bounds quotes/orders by created_at; AR aging considers all
// still-outstanding invoices regardless of age (that's the point of aging).

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";
import { computeOpsKpis } from "../_lib/ops-kpis.js";

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
    const windowDays = Math.min(365, Math.max(7, Number(url.searchParams.get("window_days") || 90)));
    const sinceIso = new Date(Date.now() - windowDays * 86400_000).toISOString();

    const [inv, qt, ord] = await Promise.all([
      svc.from("invoices")
        .select("status, grand_total, paid_amount, due_date, currency")
        .eq("tenant_id", ctx.tenantId),
      svc.from("quotes")
        .select("status, grand_total, created_at, sent_at, accepted_at, created_by")
        .eq("tenant_id", ctx.tenantId).gte("created_at", sinceIso),
      svc.from("orders")
        .select("status, created_at, approved_at")
        .eq("tenant_id", ctx.tenantId).gte("created_at", sinceIso),
    ]);
    if (inv.error) throw new Error(inv.error.message);
    if (qt.error) throw new Error(qt.error.message);
    if (ord.error) throw new Error(ord.error.message);

    const kpis = computeOpsKpis(
      { invoices: inv.data || [], quotes: qt.data || [], orders: ord.data || [] },
      Date.now(),
    );
    return json(res, 200, { window_days: windowDays, as_of: new Date().toISOString(), ...kpis });
  } catch (err) { sendError(res, err); }
}
