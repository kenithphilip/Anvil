// Pure compute for the P2 pipeline-conversion report.
//
// Lines up the three real funnel events over time (day / week / month):
//   quotes sent      — opportunity_quotes.status='sent'   (by sent_at,  value = amount)
//   orders processed — orders.status APPROVED/EXPORTED/RECONCILED (by approved_at; COUNT only — orders carry no monetary total)
//   sales completed  — invoices.status='paid'             (by paid_at,  value = paid_amount)
//
// P2a (no schema change): aggregate per-period trend + window totals + an
// opportunity-stage COHORT (of deals quoted in the window, how many are now
// won / lost / open — the honest conversion, via opportunity_quotes' hard
// opportunity_id FK) + a stalled-quote follow-up worklist + a per-rep rollup.
// Precise quote->order->paid attribution waits on the orders.opportunity_id
// bridge (P2b fast-follow) and is deliberately NOT relied on here.
//
// Pure / no I/O so it is unit-testable; analytics/pipeline.js does the fetch.

import { median, percentile } from "./ops-kpis.js";

const DAY = 86400000;
const PROCESSED = new Set(["APPROVED", "EXPORTED_TO_TALLY", "RECONCILED"]);
const WON = "CLOSE_WON";
const LOST = new Set(["CLOSE_LOST", "REGRETTED"]);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const pad = (n) => String(n).padStart(2, "0");

// Period bucket key from an ISO timestamp. Uses UTC so buckets are stable
// under test and independent of server locale. Week = the Monday that starts it.
export const bucketKey = (iso, granularity) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (granularity === "month") return `${y}-${pad(d.getUTCMonth() + 1)}`;
  if (granularity === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const mon = new Date(d.getTime() - dow * DAY);
    return `${mon.getUTCFullYear()}-${pad(mon.getUTCMonth() + 1)}-${pad(mon.getUTCDate())}`;
  }
  return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; // day
};

const stat = (nums) => {
  const clean = (nums || []).filter((n) => Number.isFinite(n) && n >= 0);
  return { median: median(clean), p90: percentile(clean, 90), n: clean.length };
};
const daysBetween = (aIso, bIso) => {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(((b - a) / DAY) * 10) / 10;
};

export const computePipelineConversion = ({ quotesSent, orders, invoices, opportunities, granularity, nowMs } = {}) => {
  const g = ["day", "week", "month"].includes(granularity) ? granularity : "week";
  const now = Number.isFinite(nowMs) ? nowMs : Date.parse("2026-08-07T00:00:00Z");

  // ---- per-period trend buckets ----
  const periods = new Map();
  const P = (key) => {
    if (!periods.has(key)) periods.set(key, { period: key, quotes_sent_count: 0, quotes_sent_value: 0, orders_processed_count: 0, paid_count: 0, paid_value: 0 });
    return periods.get(key);
  };

  // opportunity_id -> its sent-quote rollup (latest revision drives the cohort/stalled view)
  const quotedOpps = new Map();
  let qsCount = 0, qsValue = 0;
  const customersQuoted = new Set();
  for (const q of quotesSent || []) {
    if (String(q.status) !== "sent" || !q.sent_at) continue;
    const key = bucketKey(q.sent_at, g);
    if (key) { const p = P(key); p.quotes_sent_count += 1; p.quotes_sent_value += num(q.amount); }
    qsCount += 1; qsValue += num(q.amount);
    if (q.customer_id) customersQuoted.add(q.customer_id);
    if (q.opportunity_id) {
      const cur = quotedOpps.get(q.opportunity_id)
        || { opportunity_id: q.opportunity_id, revisions: 0, last_sent_at: null, amount: 0, sent_by: q.sent_by || null, customer_id: q.customer_id || null };
      cur.revisions += 1;
      if (!cur.last_sent_at || Date.parse(q.sent_at) >= Date.parse(cur.last_sent_at)) { cur.last_sent_at = q.sent_at; cur.amount = num(q.amount); }
      quotedOpps.set(q.opportunity_id, cur);
    }
  }

  let opCount = 0;
  const orderCycle = [];
  for (const o of orders || []) {
    if (!PROCESSED.has(String(o.status)) || !o.approved_at) continue;
    const key = bucketKey(o.approved_at, g);
    if (key) P(key).orders_processed_count += 1;
    opCount += 1;
    if (o.created_at) { const d = daysBetween(o.created_at, o.approved_at); if (d != null) orderCycle.push(d); }
  }

  let paidCount = 0, paidValue = 0;
  const arCycle = [];
  for (const inv of invoices || []) {
    if (String(inv.status) !== "paid" || !inv.paid_at) continue;
    const key = bucketKey(inv.paid_at, g);
    const v = num(inv.paid_amount) || num(inv.grand_total);
    if (key) { const p = P(key); p.paid_count += 1; p.paid_value += v; }
    paidCount += 1; paidValue += v;
    if (inv.issue_date) { const d = daysBetween(inv.issue_date, inv.paid_at); if (d != null) arCycle.push(d); }
  }

  const trend = Array.from(periods.values())
    .map((p) => ({ ...p, quotes_sent_value: round2(p.quotes_sent_value), paid_value: round2(p.paid_value) }))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));

  // ---- opportunity-stage cohort: of deals quoted in the window, where are they now ----
  const stageOf = new Map((opportunities || []).map((o) => [o.id, o]));
  let won = 0, lost = 0, open = 0, wonValue = 0;
  const stalled = [];
  const stalledBuckets = { "0-7": 0, "8-30": 0, "31-60": 0, "60+": 0 };
  for (const [oppId, q] of quotedOpps) {
    const opp = stageOf.get(oppId);
    const stage = opp ? String(opp.stage) : null;
    if (stage === WON) { won += 1; wonValue += num(opp && opp.amount_inr) || q.amount; }
    else if (stage && LOST.has(stage)) { lost += 1; }
    else {
      open += 1;
      const age = q.last_sent_at ? Math.floor((now - Date.parse(q.last_sent_at)) / DAY) : null;
      if (age != null && age >= 0) {
        const b = age <= 7 ? "0-7" : age <= 30 ? "8-30" : age <= 60 ? "31-60" : "60+";
        stalledBuckets[b] += 1;
        stalled.push({ opportunity_id: oppId, customer_id: q.customer_id, owner_id: (opp && opp.owner_id) || q.sent_by || null, last_sent_at: q.last_sent_at, age_days: age, amount: round2(q.amount), revisions: q.revisions, bucket: b });
      }
    }
  }
  stalled.sort((a, b) => b.age_days - a.age_days);
  const quotedOppCount = quotedOpps.size;

  // ---- per-rep rollup (by the quote sender) ----
  const byRep = new Map();
  for (const [oppId, q] of quotedOpps) {
    const rep = q.sent_by || "unassigned";
    const cur = byRep.get(rep) || { rep_id: rep, opportunities_quoted: 0, quotes_value: 0, won: 0 };
    cur.opportunities_quoted += 1; cur.quotes_value += q.amount;
    const opp = stageOf.get(oppId);
    if (opp && String(opp.stage) === WON) cur.won += 1;
    byRep.set(rep, cur);
  }
  const by_rep = Array.from(byRep.values())
    .map((r) => ({ ...r, quotes_value: round2(r.quotes_value), win_rate_pct: pct(r.won, r.opportunities_quoted) }))
    .sort((a, b) => b.opportunities_quoted - a.opportunities_quoted);

  return {
    granularity: g,
    trend,
    totals: {
      quotes_sent: { count: qsCount, value: round2(qsValue) },
      orders_processed: { count: opCount },       // orders carry no monetary total (count only)
      paid: { count: paidCount, value: round2(paidValue) },
      distinct_opportunities_quoted: quotedOppCount,
      distinct_customers_quoted: customersQuoted.size,
    },
    cohort: {
      quoted: quotedOppCount, won, lost, open,
      won_value: round2(wonValue),
      win_rate_pct: pct(won, won + lost),          // win rate among decided deals
      quote_to_won_pct: pct(won, quotedOppCount),  // of all quoted, share now won
    },
    conversion: {
      orders_per_quote_pct: pct(opCount, qsCount),  // aggregate volume ratio (NOT cohort-attributed — see P2b)
      paid_per_order_pct: pct(paidCount, opCount),
      value_realized_pct: pct(paidValue, qsValue),  // paid value vs quoted value
    },
    stalled_buckets: stalledBuckets,
    stalled: stalled.slice(0, 100),
    by_rep,
    cycle: { order_to_approved: stat(orderCycle), invoice_to_paid: stat(arCycle) },
  };
};
