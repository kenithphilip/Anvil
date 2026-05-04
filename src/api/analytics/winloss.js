// GET /api/analytics/winloss
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD&rep_id=&tier=
// Returns:
//   - trend:    [{ day, won, lost, expired, won_value, lost_value }]
//   - lost_reasons: { reason_id: count }
//   - rep_efficiency: [{ rep_id, name, quotes_won, win_rate, median_response_minutes }]
//   - top_customers: [{ customer_id, name, won_value, win_rate }]

import { applyCors, handlePreflight, json, sendError } from "../_lib/cors.js";
import { resolveContext, requirePermission } from "../_lib/auth.js";
import { serviceClient } from "../_lib/supabase.js";

const todayMinusDays = (n) => {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
};

const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

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
    const url = new URL(req.url, "http://x");
    const from = url.searchParams.get("from") || todayMinusDays(30);
    const to = url.searchParams.get("to") || todayMinusDays(0);
    const repId = url.searchParams.get("rep_id");
    const tier = url.searchParams.get("tier");

    let q = svc.from("analytics_winloss_daily")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .gte("day", from).lte("day", to);
    if (repId) q = q.eq("rep_id", repId);
    if (tier) q = q.eq("customer_tier", tier);
    const r = await q;
    if (r.error) throw new Error(r.error.message);
    const rows = r.data || [];

    // Trend: collapse rep + tier into one row per day.
    const trendMap = new Map();
    const lostReasons = {};
    const repAccum = new Map();
    for (const row of rows) {
      const t = trendMap.get(row.day) || {
        day: row.day, won: 0, lost: 0, expired: 0,
        won_value: 0, lost_value: 0, created: 0,
      };
      t.won += row.quotes_won; t.lost += row.quotes_lost;
      t.expired += row.quotes_expired; t.created += row.quotes_created;
      t.won_value += Number(row.total_won_value || 0);
      t.lost_value += Number(row.total_lost_value || 0);
      trendMap.set(row.day, t);
      for (const [rid, count] of Object.entries(row.lost_reasons || {})) {
        lostReasons[rid] = (lostReasons[rid] || 0) + count;
      }
      if (row.rep_id) {
        let acc = repAccum.get(row.rep_id);
        if (!acc) {
          acc = { rep_id: row.rep_id, won: 0, total: 0, response_medians: [] };
          repAccum.set(row.rep_id, acc);
        }
        acc.won += row.quotes_won;
        acc.total += row.quotes_created;
        if (row.median_response_minutes != null) acc.response_medians.push(row.median_response_minutes);
      }
    }
    const trend = Array.from(trendMap.values()).sort((a, b) => a.day.localeCompare(b.day));

    // Hydrate lost-reason names.
    const reasonIds = Object.keys(lostReasons);
    let reasonNames = {};
    if (reasonIds.length) {
      const lr = await svc.from("lost_reasons").select("id, label").in("id", reasonIds);
      reasonNames = Object.fromEntries((lr.data || []).map((r) => [r.id, r.label]));
    }
    const lostReasonsHydrated = Object.entries(lostReasons).map(([id, count]) => ({
      id, label: reasonNames[id] || id, count,
    })).sort((a, b) => b.count - a.count);

    // Hydrate rep names.
    const repIds = Array.from(repAccum.keys());
    let repNames = {};
    if (repIds.length) {
      const u = await svc.from("auth.users").select("id, email").in("id", repIds);
      repNames = Object.fromEntries((u.data || []).map((r) => [r.id, r.email]));
    }
    const repEfficiency = Array.from(repAccum.values()).map((acc) => ({
      rep_id: acc.rep_id,
      name: repNames[acc.rep_id] || acc.rep_id.slice(0, 8),
      quotes_won: acc.won,
      quotes_total: acc.total,
      win_rate: acc.total > 0 ? Math.round((acc.won / acc.total) * 10000) / 100 : null,
      median_response_minutes: median(acc.response_medians),
    })).sort((a, b) => b.quotes_won - a.quotes_won);

    // Top customers: read directly from monthly table for the
    // window's months.
    const fromMonth = (from || "").slice(0, 7) + "-01";
    const monthly = await svc.from("analytics_customer_monthly")
      .select("customer_id, won_value, won_count, orders_count, win_rate, avg_response_minutes")
      .eq("tenant_id", ctx.tenantId)
      .gte("month", fromMonth);
    if (monthly.error) throw new Error(monthly.error.message);
    const custMap = new Map();
    for (const row of monthly.data || []) {
      let acc = custMap.get(row.customer_id);
      if (!acc) {
        acc = {
          customer_id: row.customer_id,
          won_value: 0, won_count: 0, orders_count: 0,
          response_avgs: [],
        };
        custMap.set(row.customer_id, acc);
      }
      acc.won_value += Number(row.won_value || 0);
      acc.won_count += row.won_count;
      acc.orders_count += row.orders_count;
      if (row.avg_response_minutes != null) acc.response_avgs.push(row.avg_response_minutes);
    }
    const topCustomerIds = Array.from(custMap.keys());
    let custNames = {};
    if (topCustomerIds.length) {
      const c = await svc.from("customers").select("id, customer_name, tier").in("id", topCustomerIds);
      custNames = Object.fromEntries((c.data || []).map((r) => [r.id, r]));
    }
    const topCustomers = Array.from(custMap.values()).map((acc) => {
      const meta = custNames[acc.customer_id] || {};
      return {
        customer_id: acc.customer_id,
        name: meta.customer_name || acc.customer_id.slice(0, 8),
        tier: meta.tier || "standard",
        won_value: acc.won_value,
        won_count: acc.won_count,
        orders_count: acc.orders_count,
        win_rate: acc.orders_count > 0 ? Math.round((acc.won_count / acc.orders_count) * 10000) / 100 : null,
        avg_response_minutes: acc.response_avgs.length
          ? Math.round(acc.response_avgs.reduce((a, b) => a + b, 0) / acc.response_avgs.length)
          : null,
      };
    }).sort((a, b) => b.won_value - a.won_value).slice(0, 10);

    // Headline KPIs.
    const totals = trend.reduce((acc, d) => {
      acc.created += d.created; acc.won += d.won; acc.lost += d.lost;
      acc.expired += d.expired;
      acc.won_value += d.won_value; acc.lost_value += d.lost_value;
      return acc;
    }, { created: 0, won: 0, lost: 0, expired: 0, won_value: 0, lost_value: 0 });
    const winRate = totals.created > 0 ? Math.round((totals.won / totals.created) * 10000) / 100 : null;

    return json(res, 200, {
      from, to, filters: { rep_id: repId, tier },
      kpis: { ...totals, win_rate: winRate },
      trend,
      lost_reasons: lostReasonsHydrated,
      rep_efficiency: repEfficiency,
      top_customers: topCustomers,
    });
  } catch (err) { sendError(res, err); }
}
