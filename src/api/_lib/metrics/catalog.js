// GenAI copilot P0a — the governed Metric Catalog.
//
// The trust boundary for "Ask Anvil": a question resolves to a CATALOG ENTRY,
// never free-form SQL. Each metric declares what it means, its unit, and a
// hand-written, tenant-scoped, reviewed query — so every answer is consistent
// and auditable (the number + how it was computed + "as of"). The LLM only
// picks WHICH metric + params (via the query_metric tool); the server runs the
// known query. This is the erp-chat-tools pattern applied to analytics.
//
// P0a seeds ~10 metrics over the CONFIRMED invoices / quotes / orders columns
// that analytics/ops_kpis.js already computes from (proven math, reused via
// _lib/ops-kpis.js). Inventory / spares / forecast metrics land in P1 once
// their columns are verified. A per-tenant custom-metric editor is a later
// phase; P0 is the seeded default set (governed by code review).
//
// Each metric: { id, label, description, unit, domain, params[], fetch(), reduce() }.
//   fetch(svc, tenantId, params) -> raw rows (the ONLY I/O)
//   reduce(data, { nowMs, windowDays }) -> { value, breakdown?, provenance }  (PURE, tested)

import { computeArAging, computeCycleTime, median } from "../ops-kpis.js";

const DAY = 86400000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clampWindow = (d) => Math.min(365, Math.max(1, Number(d) || 90));
const sinceIso = (nowMs, windowDays) => new Date(nowMs - clampWindow(windowDays) * DAY).toISOString();

// ── shared tenant-scoped fetchers (the confirmed column sets) ─────────
const fetchInvoices = async (svc, tenantId) => {
  const r = await svc.from("invoices")
    .select("status, grand_total, paid_amount, due_date, currency")
    .eq("tenant_id", tenantId);
  if (r.error) throw new Error("invoices: " + r.error.message);
  return r.data || [];
};
const fetchQuotes = async (svc, tenantId, since) => {
  let q = svc.from("quotes")
    .select("status, grand_total, created_at, sent_at, accepted_at, created_by")
    .eq("tenant_id", tenantId);
  if (since) q = q.gte("created_at", since);
  const r = await q;
  if (r.error) throw new Error("quotes: " + r.error.message);
  return r.data || [];
};
const fetchOrders = async (svc, tenantId, since) => {
  let q = svc.from("orders")
    .select("status, created_at, approved_at")
    .eq("tenant_id", tenantId);
  if (since) q = q.gte("created_at", since);
  const r = await q;
  if (r.error) throw new Error("orders: " + r.error.message);
  return r.data || [];
};

const isCancelled = (s) => String(s || "").toUpperCase() === "CANCELLED";

// P1a domain fetchers (columns verified against the migrations + endpoints).
// An opportunity is OPEN when its stage is not one of the terminal three
// (matches opportunities.js TERMINAL_STAGES + forecast/index.js aggregate()).
const TERMINAL_STAGES = ["CLOSE_WON", "CLOSE_LOST", "REGRETTED"];
const isOpenOpp = (stage) => !TERMINAL_STAGES.includes(String(stage || "").toUpperCase());
const fetchOpportunities = async (svc, tenantId) => {
  const r = await svc.from("opportunities").select("stage, amount_inr, probability, ai_probability").eq("tenant_id", tenantId);
  if (r.error) throw new Error("opportunities: " + r.error.message);
  return r.data || [];
};
const fetchInventoryExceptions = async (svc, tenantId) => {
  const r = await svc.from("inventory_exceptions").select("status, severity, exception_kind").eq("tenant_id", tenantId);
  if (r.error) throw new Error("inventory_exceptions: " + r.error.message);
  return r.data || [];
};
const fetchScorecards = async (svc, tenantId) => {
  const r = await svc.from("supplier_scorecards").select("supplier, on_time_pct").eq("tenant_id", tenantId);
  if (r.error) throw new Error("supplier_scorecards: " + r.error.message);
  return r.data || [];
};

// ── the catalog ──────────────────────────────────────────────────────
export const METRICS = [
  // ---- Finance / AR (aging considers ALL outstanding invoices) ----
  {
    id: "ar_outstanding", label: "Total AR outstanding", domain: "finance", unit: "currency",
    description: "Sum of unpaid invoice balances (grand_total − paid_amount) across all open invoices.",
    params: [],
    fetch: (svc, t) => fetchInvoices(svc, t),
    reduce: (inv, { nowMs }) => {
      const ar = computeArAging(inv, nowMs);
      return { value: ar.total_outstanding, provenance: "sum(grand_total − paid_amount) over invoices not in {void,paid,draft} with a positive balance" };
    },
  },
  {
    id: "ar_overdue", label: "Overdue AR", domain: "finance", unit: "currency",
    description: "Outstanding balance on invoices past their due date, with an aging breakdown.",
    params: [],
    fetch: (svc, t) => fetchInvoices(svc, t),
    reduce: (inv, { nowMs }) => {
      const ar = computeArAging(inv, nowMs);
      return { value: ar.overdue_outstanding, breakdown: ar.buckets, count: ar.overdue_count,
        provenance: "outstanding on invoices where now > due_date, bucketed by days past due" };
    },
  },
  {
    id: "ar_overdue_rate", label: "AR overdue rate", domain: "finance", unit: "percent",
    description: "Share of outstanding AR that is past due (overdue ÷ total outstanding).",
    params: [],
    fetch: (svc, t) => fetchInvoices(svc, t),
    reduce: (inv, { nowMs }) => {
      const ar = computeArAging(inv, nowMs);
      return { value: ar.overdue_rate, provenance: "overdue_outstanding ÷ total_outstanding × 100" };
    },
  },
  // ---- Sales / GTM (windowed by quote.created_at) ----
  {
    id: "revenue_accepted", label: "Accepted-quote revenue", domain: "sales", unit: "currency",
    description: "Total value of quotes accepted in the window (won revenue).",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchQuotes(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (quotes) => {
      const value = round2((quotes || []).filter((q) => q.accepted_at && !isCancelled(q.status))
        .reduce((s, q) => s + (Number(q.grand_total) || 0), 0));
      return { value, provenance: "sum(grand_total) over quotes with accepted_at set and status ≠ CANCELLED, created in window" };
    },
  },
  {
    id: "quote_acceptance_rate", label: "Quote acceptance rate", domain: "sales", unit: "percent",
    description: "Share of quotes created in the window that have been accepted.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchQuotes(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (quotes) => {
      const all = (quotes || []).filter((q) => !isCancelled(q.status));
      const accepted = all.filter((q) => q.accepted_at).length;
      const value = all.length ? Math.round((accepted / all.length) * 1000) / 10 : 0;
      return { value, count: accepted, denominator: all.length,
        provenance: "count(accepted_at set) ÷ count(non-cancelled quotes created in window) × 100" };
    },
  },
  {
    id: "avg_quote_value", label: "Average quote value", domain: "sales", unit: "currency",
    description: "Mean grand_total of quotes created in the window.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchQuotes(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (quotes) => {
      const vals = (quotes || []).map((q) => Number(q.grand_total)).filter((n) => Number.isFinite(n));
      const value = vals.length ? round2(vals.reduce((s, n) => s + n, 0) / vals.length) : 0;
      return { value, count: vals.length, provenance: "mean(grand_total) over quotes created in window" };
    },
  },
  {
    id: "quotes_created", label: "Quotes created", domain: "sales", unit: "count",
    description: "Number of quotes created in the window.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchQuotes(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (quotes) => ({ value: (quotes || []).length, provenance: "count(quotes with created_at in window)" }),
  },
  // ---- Operations / bottlenecks (cycle-time medians) ----
  {
    id: "quote_cycle_time_median", label: "Median quote sent→accepted (days)", domain: "operations", unit: "days",
    description: "Median days from a quote being sent to being accepted, over the window.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchQuotes(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (quotes) => {
      const ct = computeCycleTime(quotes, []);
      return { value: ct.sent_to_accepted.median, count: ct.sent_to_accepted.n,
        provenance: "median(accepted_at − sent_at in days) over non-cancelled quotes in window" };
    },
  },
  {
    id: "order_approval_time_median", label: "Median order created→approved (days)", domain: "operations", unit: "days",
    description: "Median days from an order being created to being approved, over the window.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchOrders(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (orders) => {
      const ct = computeCycleTime([], orders);
      return { value: ct.order_to_approved.median, count: ct.order_to_approved.n,
        provenance: "median(approved_at − created_at in days) over non-cancelled orders in window" };
    },
  },
  {
    id: "orders_created", label: "Orders created", domain: "operations", unit: "count",
    description: "Number of orders created in the window.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchOrders(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (orders) => ({ value: (orders || []).length, provenance: "count(orders with created_at in window)" }),
  },
  // ---- Sales pipeline (opportunities; open = stage not terminal) ----
  {
    id: "open_opportunity_value", label: "Open pipeline value", domain: "sales", unit: "currency",
    description: "Total value of open opportunities (stage not won/lost/regretted).",
    params: [],
    fetch: fetchOpportunities,
    reduce: (opps) => {
      const open = (opps || []).filter((o) => isOpenOpp(o.stage));
      const value = round2(open.reduce((s, o) => s + (Number(o.amount_inr) || 0), 0));
      return { value, count: open.length, provenance: "sum(amount_inr) over opportunities whose stage is not CLOSE_WON/CLOSE_LOST/REGRETTED" };
    },
  },
  {
    id: "weighted_pipeline_value", label: "Probability-weighted pipeline", domain: "sales", unit: "currency",
    description: "Open pipeline weighted by each opportunity's win probability (AI probability when scored, else the operator's).",
    params: [],
    fetch: fetchOpportunities,
    reduce: (opps) => {
      const open = (opps || []).filter((o) => isOpenOpp(o.stage));
      const value = round2(open.reduce((s, o) => {
        const raw = Number(o.ai_probability != null ? o.ai_probability : o.probability);
        const pct = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
        return s + (Number(o.amount_inr) || 0) * (pct / 100);
      }, 0));
      return { value, count: open.length, provenance: "sum(amount_inr × coalesce(ai_probability, probability)/100) over open opportunities" };
    },
  },
  {
    id: "open_opportunities", label: "Open opportunities", domain: "sales", unit: "count",
    description: "Number of open opportunities (stage not terminal).",
    params: [],
    fetch: fetchOpportunities,
    reduce: (opps) => ({ value: (opps || []).filter((o) => isOpenOpp(o.stage)).length, provenance: "count(opportunities whose stage is not terminal)" }),
  },
  // ---- Inventory / procurement ----
  {
    id: "inventory_exceptions_open", label: "Open inventory exceptions", domain: "inventory", unit: "count",
    description: "Open inventory exceptions (stockout imminent, below reorder point, supplier delay…), by severity.",
    params: [],
    fetch: fetchInventoryExceptions,
    reduce: (rows) => {
      const open = (rows || []).filter((r) => String(r.status) === "open");
      const breakdown = ["critical", "bad", "warn", "info"]
        .map((label) => ({ label, count: open.filter((r) => String(r.severity) === label).length }))
        .filter((b) => b.count > 0);
      return { value: open.length, breakdown, provenance: "count(inventory_exceptions where status = 'open'), tenant-scoped" };
    },
  },
  {
    id: "supplier_on_time_rate", label: "Supplier on-time rate", domain: "procurement", unit: "percent",
    description: "Average on-time delivery % across your suppliers' current scorecards.",
    params: [],
    fetch: fetchScorecards,
    reduce: (rows) => {
      const vals = (rows || []).map((r) => Number(r.on_time_pct)).filter((n) => Number.isFinite(n));
      const value = vals.length ? Math.round((vals.reduce((s, n) => s + n, 0) / vals.length) * 10) / 10 : 0;
      return { value, count: vals.length, provenance: "avg(on_time_pct) over supplier_scorecards (current snapshot), tenant-scoped" };
    },
  },
];

const BY_ID = new Map(METRICS.map((m) => [m.id, m]));

// Public catalog surface (no compute) — for a metric picker / the list tool.
export const listMetrics = () =>
  METRICS.map((m) => ({ id: m.id, label: m.label, description: m.description, unit: m.unit, domain: m.domain, params: m.params }));

export const getMetric = (id) => BY_ID.get(String(id || "")) || null;

// Compute one governed metric. Returns the answer contract:
//   { metric_id, label, unit, domain, value, as_of, window_days?, breakdown?, provenance, source }
export const computeMetric = async (svc, tenantId, id, params = {}, nowMs = Date.now()) => {
  const m = getMetric(id);
  if (!m) {
    const err = new Error("unknown metric: " + id);
    err.status = 404; err.available = METRICS.map((x) => x.id);
    throw err;
  }
  const windowDays = clampWindow(params.window_days);
  const usesWindow = m.params.includes("window_days");
  const data = await m.fetch(svc, tenantId, { nowMs, windowDays });
  const out = m.reduce(data, { nowMs, windowDays });
  return {
    metric_id: m.id,
    label: m.label,
    unit: m.unit,
    domain: m.domain,
    value: out.value,
    ...(out.breakdown !== undefined ? { breakdown: out.breakdown } : {}),
    ...(out.count !== undefined ? { count: out.count } : {}),
    ...(out.denominator !== undefined ? { denominator: out.denominator } : {}),
    ...(usesWindow ? { window_days: windowDays } : {}),
    as_of: new Date(nowMs).toISOString(),
    provenance: out.provenance,
    source: "Anvil Metric Catalog (governed) — computed live, tenant-scoped",
  };
};
