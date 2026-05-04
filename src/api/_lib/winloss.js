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
  const orders = await svc.from("orders")
    .select("id, status, total_value, created_at, customer_id, created_by, approval, lost_reason_id, customer_tier")
    .eq("tenant_id", tenantId)
    .gte("created_at", since);
  if (orders.error) throw new Error(orders.error.message);
  const customers = await svc.from("customers").select("id, tier").eq("tenant_id", tenantId);
  if (customers.error) throw new Error(customers.error.message);
  const tierByCustomer = new Map((customers.data || []).map((c) => [c.id, c.tier || "standard"]));

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
    const tier = o.customer_tier || tierByCustomer.get(o.customer_id) || "standard";
    const repId = o.created_by || null;
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
    const value = Number(o.total_value || 0);
    if (isWon(o.status)) { b.quotes_won += 1; b.total_won_value += value; }
    else if (isLost(o.status)) {
      b.quotes_lost += 1; b.total_lost_value += value;
      if (o.lost_reason_id) {
        b.lost_reasons[o.lost_reason_id] = (b.lost_reasons[o.lost_reason_id] || 0) + 1;
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
  let daysWritten = 0;
  for (const b of dayBuckets.values()) {
    const arr = responseTimes.get(b.day + "|" + (b.rep_id || "") + "|" + b.customer_tier);
    const med = median(arr || []);
    await svc.from("analytics_winloss_daily").upsert({
      ...b,
      median_response_minutes: med,
    }, { onConflict: "tenant_id,day,rep_id,customer_tier" });
    daysWritten += 1;
  }

  // Upsert monthly customer.
  let monthsWritten = 0;
  for (const cb of monthBuckets.values()) {
    const winRate = cb.orders_count > 0
      ? Math.round((cb.won_count / cb.orders_count) * 10000) / 100
      : null;
    const avg = cb.response_count > 0
      ? Math.round(cb.response_minutes_sum / cb.response_count)
      : null;
    await svc.from("analytics_customer_monthly").upsert({
      tenant_id: cb.tenant_id, customer_id: cb.customer_id, month: cb.month,
      orders_count: cb.orders_count, won_count: cb.won_count, won_value: cb.won_value,
      win_rate: winRate, avg_response_minutes: avg,
    }, { onConflict: "tenant_id,customer_id,month" });
    monthsWritten += 1;
  }

  return { tenant_id: tenantId, since_days: sinceDays, days_written: daysWritten, months_written: monthsWritten };
};
