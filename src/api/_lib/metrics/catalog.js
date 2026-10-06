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
import {
  defectRate, runOutcomes, parseHealth, promptVersionSlices,
  groupBy, isShipped, isFinished, kindKey, evidenceOf,
} from "../extraction-kpis.js";

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

// Communications (item 7). OUTBOUND only: every writer inserts outbound, and
// filtering here keeps the counts honest if inbound rows ever land in the table.
const fetchCommunications = async (svc, tenantId, since) => {
  let q = svc.from("communications")
    .select("document_type, direction, status, created_at, sent_at, customer_id, metadata")
    .eq("tenant_id", tenantId).eq("direction", "outbound");
  if (since) q = q.gte("created_at", since);
  const r = await q;
  if (r.error) throw new Error("communications: " + r.error.message);
  return r.data || [];
};
// Routing coverage needs two tables; fetch returns both for a pure reduce.
const fetchRoutingCoverage = async (svc, tenantId) => {
  const [rules, customers] = await Promise.all([
    svc.from("comms_routing_rules").select("customer_id, is_active").eq("tenant_id", tenantId),
    svc.from("customers").select("id").eq("tenant_id", tenantId),
  ]);
  if (rules.error) throw new Error("comms_routing_rules: " + rules.error.message);
  if (customers.error) throw new Error("customers: " + customers.error.message);
  return { rules: rules.data || [], customers: customers.data || [] };
};
// The customer-FACING document types. `communications` also carries supplier
// RFQs, prospecting outreach, inventory/system notifications, and agent
// messages — none of which are customer communications, so the customer-comms
// metrics filter to this set (a customer_id filter would be wrong: quote/invoice
// emails set object_id, not customer_id). ar_reminder = the autonomous AR
// agent's dunning; payment_reminder = the manual statement — both are follow-ups.
const CUSTOMER_COMMS_TYPES = new Set([
  "dispatch_register", "payment_reminder", "ar_reminder", "service_report",
  "quote_email", "invoice_email",
]);
const PAYMENT_COMMS_TYPES = new Set(["payment_reminder", "ar_reminder"]);
// "Issued" = handed to the send path (queued or sent), i.e. not a saved draft.
const isIssued = (c) => c.status !== "draft";

// ── extraction quality (docai) ───────────────────────────────────────
//
// extraction_runs takes a row for every document Anvil reads, so it is the
// highest-volume table these metrics touch: the fetch is windowed, ordered
// newest-first and capped. A governed metric must never be the query that
// times the dispatcher out.
//
// field_confidences is pulled because it is how a run's LINE COUNT is known
// without opening the whole normalized_extract blob (the adapters write
// "lines[0]", "lines[1]" … keys into it) — and lines are the unit the defect
// rate is denominated in.
const EXTRACTION_RUN_CAP = 5000;
const fetchExtractionRuns = async (svc, tenantId, since) => {
  let q = svc.from("extraction_runs")
    .select("id, status, status_reason, extraction_kind, prompt_version, parse_method, parse_retries, confidence_overall, field_confidences, finished_at")
    .eq("tenant_id", tenantId);
  if (since) q = q.gte("finished_at", since);
  const r = await q.order("finished_at", { ascending: false }).limit(EXTRACTION_RUN_CAP);
  if (r.error) throw new Error("extraction_runs: " + r.error.message);
  return r.data || [];
};
// Defect rate needs both tables; fetch returns both for a pure reduce
// (same shape as fetchRoutingCoverage).
const fetchExtractionQuality = async (svc, tenantId, since) => {
  const [runs, corr] = await Promise.all([
    fetchExtractionRuns(svc, tenantId, since),
    (async () => {
      let q = svc.from("extraction_corrections")
        .select("extraction_run_id, field_path")
        .eq("tenant_id", tenantId);
      if (since) q = q.gte("applied_at", since);
      const r = await q.limit(50000);
      if (r.error) throw new Error("extraction_corrections: " + r.error.message);
      return r.data || [];
    })(),
  ]);
  return { runs, corrections: corr };
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
  // ---- Communications (item 7) — per docs/CUSTOMER_COMMS_DESIGN.md §7 ----
  // Reply rate + time-to-first-response are DELIBERATELY not here: they need
  // inbound thread linkage, and no inbound row lands in `communications` today
  // (every writer is outbound). They unblock with the Graph reply-loop join —
  // shipping them now would measure fiction (always 0 replies).
  {
    id: "comms_sent", label: "Customer messages issued", domain: "communications", unit: "count",
    description: "Customer-facing outbound messages in the window (queued or sent; excludes drafts and non-customer traffic like supplier RFQs / notifications), broken down by document type.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchCommunications(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (rows) => {
      const list = (rows || []).filter((c) => CUSTOMER_COMMS_TYPES.has(c.document_type) && isIssued(c));
      const breakdown = {};
      for (const c of list) breakdown[c.document_type] = (breakdown[c.document_type] || 0) + 1;
      return { value: list.length, breakdown, provenance: "count(outbound customer-facing communications not in draft, created in window), grouped by document_type" };
    },
  },
  {
    id: "comms_delivery_rate", label: "Customer message delivery rate", domain: "communications", unit: "percent",
    description: "Share of attempted customer messages (in window) that actually sent, vs. stuck queued or failed. A low rate usually means no send provider is configured.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchCommunications(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (rows) => {
      const cust = (rows || []).filter((c) => CUSTOMER_COMMS_TYPES.has(c.document_type));
      const attempted = cust.filter((c) => ["sent", "replied", "queued", "failed"].includes(c.status));
      const delivered = attempted.filter((c) => c.status === "sent" || c.status === "replied").length;
      const value = attempted.length ? Math.round((delivered / attempted.length) * 1000) / 10 : 0;
      return { value, count: delivered, denominator: attempted.length,
        provenance: "count(status in {sent,replied}) ÷ count(status in {sent,replied,queued,failed}) × 100, over customer-facing outbound in window" };
    },
  },
  {
    id: "dispatch_register_cadence", label: "Dispatch registers sent", domain: "communications", unit: "count",
    description: "Dispatch registers proactively sent to customers in the window — whether we inform them of despatches or they chase us.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchCommunications(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (rows) => ({
      value: (rows || []).filter((c) => c.document_type === "dispatch_register" && isIssued(c)).length,
      provenance: "count(communications with document_type='dispatch_register', outbound, not draft, in window)",
    }),
  },
  {
    id: "payment_followups_sent", label: "Payment follow-ups sent", domain: "communications", unit: "count",
    description: "Payment reminders sent to customers in the window — both the manual statement (payment_reminder) and the autonomous AR agent's dunning (ar_reminder).",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchCommunications(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (rows) => ({
      value: (rows || []).filter((c) => PAYMENT_COMMS_TYPES.has(c.document_type) && isIssued(c)).length,
      provenance: "count(communications with document_type in {payment_reminder,ar_reminder}, outbound, not draft, in window)",
    }),
  },
  {
    id: "routing_coverage", label: "Customers with comms routing configured", domain: "communications", unit: "percent",
    description: "Share of customers with at least one active comms routing rule. Low coverage means most customers fall back to the primary contact instead of the right function (stores / accounts).",
    params: [],
    fetch: (svc, t) => fetchRoutingCoverage(svc, t),
    reduce: ({ rules, customers }) => {
      const configured = new Set((rules || []).filter((r) => r.is_active !== false && r.customer_id).map((r) => r.customer_id));
      const total = (customers || []).length;
      const value = total ? Math.round((configured.size / total) * 1000) / 10 : 0;
      return { value, count: configured.size, denominator: total,
        provenance: "count(distinct customer_id in comms_routing_rules where is_active) ÷ count(customers) × 100" };
    },
  },
  // Reply metrics — unblocked by the Graph reply-loop join (_lib/graph-reply.js):
  // an inbound reply now flips its originating outbound row to status='replied'
  // and stamps metadata.replied_at, so these read real data (0 until Graph is
  // connected + a reply arrives — honest, not fiction).
  {
    id: "comms_reply_rate", label: "Customer reply rate", domain: "communications", unit: "percent",
    description: "Share of customer messages sent in the window that received a reply (attributed via Graph conversationId / In-Reply-To).",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchCommunications(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (rows) => {
      const cust = (rows || []).filter((c) => CUSTOMER_COMMS_TYPES.has(c.document_type) && (c.status === "sent" || c.status === "replied"));
      const replied = cust.filter((c) => c.status === "replied").length;
      const value = cust.length ? Math.round((replied / cust.length) * 1000) / 10 : 0;
      return { value, count: replied, denominator: cust.length,
        provenance: "count(status='replied') ÷ count(status in {sent,replied}) × 100, customer-facing outbound in window" };
    },
  },
  {
    id: "time_to_first_response_median", label: "Median time to first reply (days)", domain: "communications", unit: "days",
    description: "Median days from sending a customer message to the customer's first reply, over replied messages in the window.",
    params: ["window_days"],
    fetch: (svc, t, p) => fetchCommunications(svc, t, sinceIso(p.nowMs, p.windowDays)),
    reduce: (rows) => {
      const durs = [];
      for (const c of rows || []) {
        if (c.status !== "replied" || !CUSTOMER_COMMS_TYPES.has(c.document_type)) continue;
        const repliedAt = c.metadata?.replied_at;
        if (!repliedAt || !c.sent_at) continue;
        const d = (Date.parse(repliedAt) - Date.parse(c.sent_at)) / 86400000;
        if (Number.isFinite(d) && d >= 0) durs.push(d);
      }
      return { value: Math.round(median(durs) * 10) / 10, count: durs.length,
        provenance: "median(metadata.replied_at − sent_at in days) over replied customer-facing outbound in window" };
    },
  },
  // ---- Extraction quality (windowed by extraction_runs.finished_at) ----
  //
  // Why these are in the governed catalog at all: extraction is the machine
  // the whole product rests on — every PO, quote, invoice and packing list
  // enters Anvil through it — and until now the only surface that could
  // quote a number about it was one dashboard block. The copilot could
  // answer "what is my overdue AR" but not "is the reader getting better".
  {
    id: "extraction_defect_rate", label: "Extraction defect rate", domain: "extraction", unit: "percent",
    description: "Share of critical extracted fields an operator later had to correct, on documents that shipped. DPMO and process sigma ride in the breakdown.",
    params: ["window_days"],
    fetch: (svc, t, { nowMs, windowDays }) => fetchExtractionQuality(svc, t, sinceIso(nowMs, windowDays)),
    reduce: ({ runs, corrections }) => {
      const d = defectRate(runs, corrections);
      const by_kind = {};
      for (const [kind, rows] of groupBy(runs.filter(isShipped), kindKey)) {
        const k = defectRate(rows, corrections);
        by_kind[kind] = { shipped_runs: k.shipped_runs, defects: k.defects, dpmo: Math.round(k.dpmo), sigma: k.sigma };
      }
      return {
        value: round2(d.escape_rate * 100),
        count: d.defects,
        denominator: d.opportunities,
        breakdown: {
          dpmo: Math.round(d.dpmo), sigma: d.sigma, shipped_runs: d.shipped_runs,
          corrected_runs: d.corrected_runs, units: d.units, by_kind,
        },
        evidence: evidenceOf(d.run_ids, "the shipped runs this rate is computed over"),
        provenance: "distinct (run, field) corrections ÷ Σ[5 header + 5×lines] critical fields, over status='ok' runs with ≥1 line — operator-corrected, so a LOWER BOUND on true escapes",
      };
    },
  },
  {
    id: "extraction_failure_rate", label: "Extraction failure rate", domain: "extraction", unit: "percent",
    description: "Share of finished extraction runs that failed outright (no usable output), with the failure reasons and the per-document-kind split.",
    params: ["window_days"],
    fetch: (svc, t, { nowMs, windowDays }) => fetchExtractionRuns(svc, t, sinceIso(nowMs, windowDays)),
    reduce: (runs) => {
      const o = runOutcomes(runs);
      const by_kind = {};
      for (const [kind, rows] of groupBy(runs.filter(isFinished), kindKey)) {
        const k = runOutcomes(rows);
        by_kind[kind] = { finished: k.finished, failed: k.failed, failure_rate: k.failure_rate };
      }
      return {
        value: o.failure_rate,
        count: o.failed,
        denominator: o.finished,
        breakdown: { ok: o.ok, failed: o.failed, low_confidence: o.low_confidence, reasons: o.reasons, by_kind },
        evidence: evidenceOf(runs.filter((r) => r.status === "failed").map((r) => r.id), "the failed runs"),
        provenance: "count(status='failed') ÷ count(status ≠ 'running') over extraction_runs in the window; in-flight runs are excluded from both sides",
      };
    },
  },
  {
    id: "extraction_review_rate", label: "Extraction review rate", domain: "extraction", unit: "percent",
    description: "Share of finished extraction runs held back for a human to check (low confidence) — how much of the reading Anvil still cannot do alone.",
    params: ["window_days"],
    fetch: (svc, t, { nowMs, windowDays }) => fetchExtractionRuns(svc, t, sinceIso(nowMs, windowDays)),
    reduce: (runs) => {
      const o = runOutcomes(runs);
      const by_kind = {};
      for (const [kind, rows] of groupBy(runs.filter(isFinished), kindKey)) {
        const k = runOutcomes(rows);
        by_kind[kind] = { finished: k.finished, low_confidence: k.low_confidence, review_rate: k.review_rate };
      }
      return {
        value: o.review_rate,
        count: o.low_confidence,
        denominator: o.finished,
        breakdown: { low_confidence: o.low_confidence, ok: o.ok, failed: o.failed, by_kind },
        evidence: evidenceOf(runs.filter((r) => r.status === "low_confidence").map((r) => r.id), "the runs waiting on a human"),
        provenance: "count(status='low_confidence') ÷ count(status ≠ 'running') over extraction_runs in the window",
      };
    },
  },
  {
    id: "extraction_parse_failure_rate", label: "Model output parse-failure rate", domain: "extraction", unit: "percent",
    description: "Share of runs where the model's answer could not be turned into JSON at all. The repair rate — output that only parsed after a fixup pass — rides in the breakdown as the leading indicator.",
    params: ["window_days"],
    fetch: (svc, t, { nowMs, windowDays }) => fetchExtractionRuns(svc, t, sinceIso(nowMs, windowDays)),
    reduce: (runs) => {
      const p = parseHealth(runs);
      return {
        value: p.parse_failure_rate,
        count: p.failed,
        denominator: p.parsed_runs,
        breakdown: { by_method: p.by_method, repaired: p.repaired, repair_rate: p.repair_rate, retries_per_run: p.retries_per_run },
        evidence: evidenceOf(runs.filter((r) => r.parse_method === "failed").map((r) => r.id), "the runs whose output never parsed"),
        provenance: "count(parse_method='failed') ÷ count(parse_method is not null) over extraction_runs in the window; repair_rate counts sap_repaired + sap_zod_retry",
      };
    },
  },
  {
    id: "extraction_runs_count", label: "Documents read", domain: "extraction", unit: "count",
    description: "How many documents Anvil read in the window, split by kind — the volume every other extraction rate is a share of.",
    params: ["window_days"],
    fetch: (svc, t, { nowMs, windowDays }) => fetchExtractionRuns(svc, t, sinceIso(nowMs, windowDays)),
    reduce: (runs) => {
      const finished = runs.filter(isFinished);
      const by_kind = {};
      for (const [kind, rows] of groupBy(finished, kindKey)) by_kind[kind] = rows.length;
      return {
        value: finished.length,
        breakdown: { by_kind, in_flight: runs.length - finished.length, capped_at: EXTRACTION_RUN_CAP },
        evidence: evidenceOf(finished.map((r) => r.id), finished.length >= EXTRACTION_RUN_CAP ? "window hit the row cap — the true count is higher" : null),
        provenance: "count of extraction_runs finished in the window, newest first, capped at " + EXTRACTION_RUN_CAP + " rows",
      };
    },
  },
  {
    id: "extraction_prompt_version_lift", label: "Prompt version lift", domain: "extraction", unit: "percent",
    description: "How much better the best-performing extraction prompt version is than the worst, by defect rate. The readout for whether a prompt change actually helped.",
    params: ["window_days"],
    fetch: (svc, t, { nowMs, windowDays }) => fetchExtractionQuality(svc, t, sinceIso(nowMs, windowDays)),
    reduce: ({ runs, corrections }) => {
      const v = promptVersionSlices(runs, corrections);
      return {
        value: v.lift_pct,
        count: v.comparable_versions,
        breakdown: { versions: v.versions, best: v.best, worst: v.worst, min_runs: v.min_runs, unrecorded_runs: v.unrecorded_runs },
        evidence: evidenceOf(
          runs.filter(isShipped).map((r) => r.id),
          v.comparable_versions < 2
            ? "fewer than two prompt versions have enough shipped runs to compare — no lift is claimed"
            : "the shipped runs behind the per-version rates",
        ),
        provenance: "(worst.dpmo − best.dpmo) ÷ worst.dpmo × 100, over prompt versions with ≥" + v.min_runs + " shipped runs each; runs predating prompt-version recording group as 'unrecorded' and are never crowned",
      };
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
    ...(out.evidence !== undefined ? { evidence: out.evidence } : {}),
    ...(usesWindow ? { window_days: windowDays } : {}),
    as_of: new Date(nowMs).toISOString(),
    provenance: out.provenance,
    source: "Anvil Metric Catalog (governed) — computed live, tenant-scoped",
  };
};
