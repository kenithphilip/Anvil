// Pure compute helpers for the sales-ops KPI/SLA substrate.
//
// Live-computed (no snapshot table) from invoices / quotes / orders:
//   - AR aging buckets + total/overdue outstanding   (revenue / cash)
//   - cycle-time medians (quote & order transitions)  (bottlenecks)
//   - overdue / on-time AR rate                         (delays)
//   - revenue by rep (accepted quotes)                  (revenue)
//
// Kept pure (no I/O) so it is unit-testable; analytics/ops_kpis.js does
// the fetch and calls computeOpsKpis().

const DAY = 86400000;

export const median = (nums) => {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 100) / 100;
};

export const percentile = (nums, p) => {
  const a = (nums || []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[idx];
};

const daysBetween = (aIso, bIso) => {
  const a = Date.parse(aIso); const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / DAY) * 10) / 10;
};

const stat = (nums) => {
  const clean = (nums || []).filter((n) => Number.isFinite(n) && n >= 0);
  return { median: median(clean), p90: percentile(clean, 90), n: clean.length };
};

// AR aging from invoices with an outstanding balance. `nowMs` is passed
// in (the caller stamps it) so this stays pure/deterministic under test.
export const computeArAging = (invoices, nowMs) => {
  const buckets = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const counts = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  let totalOutstanding = 0, overdueOutstanding = 0, overdueCount = 0;
  for (const inv of invoices || []) {
    if (["void", "paid", "draft"].includes(String(inv.status || ""))) continue;
    const outstanding = Math.round(((Number(inv.grand_total) || 0) - (Number(inv.paid_amount) || 0)) * 100) / 100;
    if (outstanding <= 0) continue;
    totalOutstanding += outstanding;
    const due = Date.parse(inv.due_date);
    const daysPast = Number.isFinite(due) ? Math.floor((nowMs - due) / DAY) : 0;
    let b;
    if (daysPast <= 0) b = "current";
    else if (daysPast <= 30) b = "1-30";
    else if (daysPast <= 60) b = "31-60";
    else if (daysPast <= 90) b = "61-90";
    else b = "90+";
    buckets[b] += outstanding; counts[b] += 1;
    if (daysPast > 0) { overdueOutstanding += outstanding; overdueCount += 1; }
  }
  const round = (n) => Math.round(n * 100) / 100;
  return {
    buckets: Object.keys(buckets).map((label) => ({ label, outstanding: round(buckets[label]), count: counts[label] })),
    total_outstanding: round(totalOutstanding),
    overdue_outstanding: round(overdueOutstanding),
    overdue_count: overdueCount,
    overdue_rate: totalOutstanding > 0 ? Math.round((overdueOutstanding / totalOutstanding) * 1000) / 10 : 0,
  };
};

export const computeCycleTime = (quotes, orders) => {
  const qToSent = [], sentToAcc = [], ordToApproved = [];
  for (const q of quotes || []) {
    if (String(q.status) === "CANCELLED") continue;
    if (q.created_at && q.sent_at) { const d = daysBetween(q.created_at, q.sent_at); if (d != null) qToSent.push(d); }
    if (q.sent_at && q.accepted_at) { const d = daysBetween(q.sent_at, q.accepted_at); if (d != null) sentToAcc.push(d); }
  }
  for (const o of orders || []) {
    if (String(o.status) === "CANCELLED") continue;
    if (o.created_at && o.approved_at) { const d = daysBetween(o.created_at, o.approved_at); if (d != null) ordToApproved.push(d); }
  }
  return {
    quote_to_sent: stat(qToSent),
    sent_to_accepted: stat(sentToAcc),
    order_to_approved: stat(ordToApproved),
  };
};

// Revenue by rep: value of ACCEPTED quotes grouped by created_by.
export const computeRevenueByRep = (quotes) => {
  const byRep = new Map();
  for (const q of quotes || []) {
    if (!q.accepted_at || String(q.status) === "CANCELLED") continue;
    const rep = q.created_by || "unassigned";
    const cur = byRep.get(rep) || { rep_id: rep, accepted_value: 0, count: 0 };
    cur.accepted_value += Number(q.grand_total) || 0;
    cur.count += 1;
    byRep.set(rep, cur);
  }
  return Array.from(byRep.values())
    .map((r) => ({ ...r, accepted_value: Math.round(r.accepted_value * 100) / 100 }))
    .sort((a, b) => b.accepted_value - a.accepted_value);
};

export const computeOpsKpis = ({ invoices, quotes, orders }, nowMs) => ({
  ar_aging: computeArAging(invoices, nowMs),
  cycle_time: computeCycleTime(quotes, orders),
  revenue_by_rep: computeRevenueByRep(quotes),
});
