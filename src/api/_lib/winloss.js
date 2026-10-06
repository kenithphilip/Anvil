// Win/loss aggregation. Used by both the cron-driven refresh and
// the manual recompute endpoints. Reads orders + audit_events in
// the requested window, builds the daily + monthly rollups, and
// upserts into the analytics tables.
//
// Order-status -> outcome mapping:
//   APPROVED, EXPORTED_TO_TALLY, SCHEDULED, DISPATCHED,
//   RECONCILED, DONE                              -> won
//   LOST, REJECTED                                -> lost
//   EXPIRED                                       -> expired
//   anything else                                 -> in flight (counted in quotes_created only)
//
// Median response time = (first_decision_at - created_at) where
// first_decision_at is the audit event for an approval / loss.

import { orderGrandTotal } from "./order-value.js";

const isWon = (s) => ["APPROVED","EXPORTED_TO_TALLY","SCHEDULED","DISPATCHED","RECONCILED","DONE"].includes(s);
const isLost = (s) => ["LOST","REJECTED"].includes(s);
const isExpired = (s) => s === "EXPIRED";

const dayOf = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : null;
const monthOf = (iso) => iso ? new Date(iso).toISOString().slice(0, 7) + "-01" : null;

const median = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export const refreshWinloss = async (svc, tenantId, { sinceDays = 90 } = {}) => {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  // COLUMNS THAT ACTUALLY EXIST.
  //
  // This selected total_value, created_by, lost_reason_id and customer_tier —
  // none of which are columns on `orders`. PostgREST rejects a select naming an
  // unknown column, so the query errored, line 36 threw, and the nightly
  // analytics refresh died on its first step every single run. Both
  // analytics_winloss_daily and the funnel snapshots have therefore always been
  // empty, and every report reading them shows zero.
  //
  //   total_value    -> orders holds no money at all; it lives in
  //                     result.salesOrder (see _lib/order-value.js)
  //   created_by     -> no such column; the sales rep is the linked
  //                     OPPORTUNITY's owner_id
  //   lost_reason_id -> the column is `lost_reason`, free text
  //   customer_tier  -> not on orders; it already joins customers.tier below
  //
  // opportunity_id (migration 204) is requested but NOT depended on. Migrations
  // here are applied by hand, so a repo that has the column is not a database
  // that has it — and PostgREST rejects the WHOLE select over one unknown name,
  // which is the exact failure that kept these rollups empty since they
  // shipped. analytics/pipeline.js sidesteps it by refusing to read the column
  // at all; this needs it for rep attribution, so it retries without it and
  // degrades to the quotes join instead of dying.
  const BASE_COLS = "id, status, created_at, customer_id, approval, lost_reason, result";
  const readOrders = (cols) => svc.from("orders")
    .select(cols)
    .eq("tenant_id", tenantId)
    .gte("created_at", since);

  let orders = await readOrders(BASE_COLS + ", opportunity_id");
  let hasOpportunityColumn = true;
  if (orders.error && (orders.error.code === "42703" || /opportunity_id/i.test(orders.error.message || ""))) {
    hasOpportunityColumn = false;
    orders = await readOrders(BASE_COLS);
  }
  if (orders.error) throw new Error(orders.error.message);
  const customers = await svc.from("customers").select("id, tier").eq("tenant_id", tenantId);
  if (customers.error) throw new Error(customers.error.message);
  const tierByCustomer = new Map((customers.data || []).map((c) => [c.id, c.tier || "standard"]));

  // Rep + fallback value come from the opportunity the order was won from.
  // Bounded by the opportunities these orders actually reference.
  const oppIds = [...new Set((orders.data || []).map((o) => o.opportunity_id).filter(Boolean))];
  const oppById = new Map();
  for (let i = 0; i < oppIds.length; i += 200) {
    const { data, error } = await svc.from("opportunities")
      .select("id, owner_id, amount_inr")
      .eq("tenant_id", tenantId).in("id", oppIds.slice(i, i + 200));
    if (error) throw new Error("opportunities: " + error.message);
    for (const r of (data || [])) oppById.set(r.id, r);
  }

  // Day buckets keyed by (day | rep | tier).
  const dayBuckets = new Map();
  // Month buckets keyed by (customer | month).
  const monthBuckets = new Map();
  // Response-time accumulators keyed by (day | rep | tier).
  const responseTimes = new Map();

  for (const o of orders.data || []) {
    const day = dayOf(o.created_at);
    const month = monthOf(o.created_at);
    if (!day || !month) continue;
    const opp = o.opportunity_id ? oppById.get(o.opportunity_id) : null;
    const tier = tierByCustomer.get(o.customer_id) || "standard";
    const repId = opp?.owner_id || null;
    const key = day + "|" + (repId || "") + "|" + tier;
    let b = dayBuckets.get(key);
    if (!b) {
      b = {
        tenant_id: tenantId, day, rep_id: repId, customer_tier: tier,
        quotes_created: 0, quotes_won: 0, quotes_lost: 0, quotes_expired: 0,
        total_won_value: 0, total_lost_value: 0,
        lost_reasons: {},
      };
      dayBuckets.set(key, b);
    }
    b.quotes_created += 1;
    const value = orderGrandTotal(o, opp);
    if (isWon(o.status)) { b.quotes_won += 1; b.total_won_value += value; }
    else if (isLost(o.status)) {
      b.quotes_lost += 1; b.total_lost_value += value;
      if (o.lost_reason) {
        b.lost_reasons[o.lost_reason] = (b.lost_reasons[o.lost_reason] || 0) + 1;
      }
    } else if (isExpired(o.status)) { b.quotes_expired += 1; }
    if (o.approval?.decided_at && o.created_at) {
      const minutes = Math.max(0, Math.round((new Date(o.approval.decided_at).getTime() - new Date(o.created_at).getTime()) / 60_000));
      let arr = responseTimes.get(key);
      if (!arr) { arr = []; responseTimes.set(key, arr); }
      arr.push(minutes);
    }
    // Customer-monthly bucket.
    if (o.customer_id) {
      const ck = o.customer_id + "|" + month;
      let cb = monthBuckets.get(ck);
      if (!cb) {
        cb = {
          tenant_id: tenantId, customer_id: o.customer_id, month,
          orders_count: 0, won_count: 0, won_value: 0,
          response_minutes_sum: 0, response_count: 0,
        };
        monthBuckets.set(ck, cb);
      }
      cb.orders_count += 1;
      if (isWon(o.status)) { cb.won_count += 1; cb.won_value += value; }
      if (o.approval?.decided_at && o.created_at) {
        cb.response_minutes_sum += Math.max(0, Math.round((new Date(o.approval.decided_at).getTime() - new Date(o.created_at).getTime()) / 60_000));
        cb.response_count += 1;
      }
    }
  }

  // Upsert daily.
  const writeErrors = [];
  let daysWritten = 0;
  for (const b of dayBuckets.values()) {
    const arr = responseTimes.get(b.day + "|" + (b.rep_id || "") + "|" + b.customer_tier);
    const med = median(arr || []);
    // Counted only when it PERSISTED. This ignored the result entirely and
    // returned the attempt count as days_written, so a refresh that wrote
    // nothing reported a full run.
    const { error } = await svc.from("analytics_winloss_daily").upsert({
      ...b,
      median_response_minutes: med,
    }, { onConflict: "tenant_id,day,rep_id,customer_tier" });
    if (error) { writeErrors.push(error.message); continue; }
    daysWritten += 1;
  }

  // Upsert monthly customer. Counted only when it PERSISTED, for the same
  // reason as the daily loop above: this ignored its result entirely and
  // returned the ATTEMPT count, so a refresh that wrote nothing to
  // analytics_customer_monthly still reported a clean run — and that table is
  // what the cockpit's top-customers panel reads.
  let monthsWritten = 0;
  for (const cb of monthBuckets.values()) {
    const winRate = cb.orders_count > 0
      ? Math.round((cb.won_count / cb.orders_count) * 10000) / 100
      : null;
    const avg = cb.response_count > 0
      ? Math.round(cb.response_minutes_sum / cb.response_count)
      : null;
    const { error } = await svc.from("analytics_customer_monthly").upsert({
      tenant_id: cb.tenant_id, customer_id: cb.customer_id, month: cb.month,
      orders_count: cb.orders_count, won_count: cb.won_count, won_value: cb.won_value,
      win_rate: winRate, avg_response_minutes: avg,
    }, { onConflict: "tenant_id,customer_id,month" });
    if (error) { writeErrors.push(error.message); continue; }
    monthsWritten += 1;
  }

  if (writeErrors.length) {
    console.warn(`[winloss] ${writeErrors.length} rollup upsert(s) failed:`, writeErrors[0]);
  }
  return {
    tenant_id: tenantId, since_days: sinceDays,
    // Surfaced rather than swallowed: a tenant whose DB is behind on 204 gets
    // degraded rep attribution, and the cron response is the only place that
    // can say so.
    opportunity_column: hasOpportunityColumn,
    days_written: daysWritten, months_written: monthsWritten,
    // Reported, not swallowed: a refresh that wrote nothing must not look
    // identical to one that had nothing to write.
    write_errors: writeErrors.length,
  };
};
