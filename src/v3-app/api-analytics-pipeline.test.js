// P2 pipeline-conversion report — pure compute + handler RBAC scoping.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { computePipelineConversion, bucketKey } from "../api/_lib/pipeline-conversion.js";

const NOW = Date.parse("2026-08-07T00:00:00Z");

// Shared fixture: 3 opportunities (won / open / lost), 4 sent quote revisions,
// 1 approved order + 1 paid invoice (both on customer c1).
const OPPS = [
  { id: "opp1", stage: "CLOSE_WON", amount_inr: 500000, owner_id: "u1", customer_id: "c1" },
  { id: "opp2", stage: "NEGOTIATION_REVIEW", amount_inr: 300000, owner_id: "u1", customer_id: "c1" },
  { id: "opp3", stage: "CLOSE_LOST", amount_inr: 200000, owner_id: "u2", customer_id: "c2" },
];
const QUOTES = [
  { opportunity_id: "opp1", customer_id: "c1", amount: 400000, status: "sent", sent_at: "2026-07-01T09:00:00Z", sent_by: "u1", version: 1 },
  { opportunity_id: "opp1", customer_id: "c1", amount: 500000, status: "sent", sent_at: "2026-07-10T09:00:00Z", sent_by: "u1", version: 2 },
  { opportunity_id: "opp2", customer_id: "c1", amount: 300000, status: "sent", sent_at: "2026-06-01T09:00:00Z", sent_by: "u1", version: 1 },
  { opportunity_id: "opp3", customer_id: "c2", amount: 200000, status: "sent", sent_at: "2026-07-05T09:00:00Z", sent_by: "u2", version: 1 },
  { opportunity_id: "opp1", customer_id: "c1", amount: 999, status: "draft", sent_at: null, sent_by: "u1", version: 3 }, // not sent -> ignored
];
// ord1 is attributed to opp1 (P2b: pure test reads order.opportunity_id; the
// handler resolves it from quote_id 'gq1' -> quotes.opportunity_id 'opp1').
const ORDERS = [
  { id: "ord1", opportunity_id: "opp1", quote_id: "gq1", status: "APPROVED", created_at: "2026-07-08T09:00:00Z", approved_at: "2026-07-12T09:00:00Z", customer_id: "c1" },
  { id: "ord2", status: "DRAFT", created_at: "2026-07-09T09:00:00Z", approved_at: null, customer_id: "c1" }, // not processed
];
const INVOICES = [
  { status: "paid", order_id: "ord1", grand_total: 500000, paid_amount: 500000, paid_at: "2026-07-20T09:00:00Z", issue_date: "2026-07-13T09:00:00Z", customer_id: "c1" },
  { status: "sent", order_id: "ord1", grand_total: 100000, paid_amount: 0, paid_at: null, issue_date: "2026-07-15T09:00:00Z", customer_id: "c1" }, // unpaid -> ignored
];

describe("bucketKey", () => {
  it("buckets by month / week (Monday) / day, and rejects garbage", () => {
    expect(bucketKey("2026-07-10T00:00:00Z", "month")).toBe("2026-07");
    expect(bucketKey("2026-07-05T12:00:00Z", "week")).toBe("2026-06-29"); // Sun -> prior Mon
    expect(bucketKey("2026-07-06T00:00:00Z", "week")).toBe("2026-07-06"); // Mon -> itself
    expect(bucketKey("2026-07-10T00:00:00Z", "day")).toBe("2026-07-10");
    expect(bucketKey("not-a-date", "day")).toBeNull();
  });
});

describe("computePipelineConversion (pure)", () => {
  it("totals: counts sent quotes, distinct opps/customers; ignores non-sent", () => {
    const r = computePipelineConversion({ quotesSent: QUOTES, orders: ORDERS, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    expect(r.totals.quotes_sent).toEqual({ count: 4, value: 1400000 });
    expect(r.totals.orders_processed).toEqual({ count: 1 });
    expect(r.totals.paid).toEqual({ count: 1, value: 500000 });
    expect(r.totals.distinct_opportunities_quoted).toBe(3);
    expect(r.totals.distinct_customers_quoted).toBe(2);
  });

  it("cohort: opportunity-stage win/lost/open + rates from the hard opp FK", () => {
    const r = computePipelineConversion({ quotesSent: QUOTES, orders: ORDERS, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    expect(r.cohort.quoted).toBe(3);
    expect(r.cohort.won).toBe(1);
    expect(r.cohort.lost).toBe(1);
    expect(r.cohort.open).toBe(1);
    expect(r.cohort.win_rate_pct).toBe(50);      // won / (won+lost)
    expect(r.cohort.quote_to_won_pct).toBe(33.3); // won / quoted
    expect(r.cohort.won_value).toBe(500000);      // opp1.amount_inr
  });

  it("month trend is sorted ascending and buckets each event by its own date", () => {
    const r = computePipelineConversion({ quotesSent: QUOTES, orders: ORDERS, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    expect(r.trend.map((p) => p.period)).toEqual(["2026-06", "2026-07"]);
    const jul = r.trend.find((p) => p.period === "2026-07");
    expect(jul.quotes_sent_count).toBe(3);
    expect(jul.quotes_sent_value).toBe(1100000);
    expect(jul.orders_processed_count).toBe(1);
    expect(jul.paid_count).toBe(1);
    expect(jul.paid_value).toBe(500000);
  });

  it("stalled: only still-open opps, aged by latest sent_at", () => {
    const r = computePipelineConversion({ quotesSent: QUOTES, orders: ORDERS, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    expect(r.stalled).toHaveLength(1);            // only opp2 is open
    expect(r.stalled[0].opportunity_id).toBe("opp2");
    expect(r.stalled[0].bucket).toBe("60+");      // 2026-06-01 -> 2026-08-07 = 67d
    expect(r.stalled_buckets["60+"]).toBe(1);
  });

  it("by_rep rolls up by sender with per-rep win rate", () => {
    const r = computePipelineConversion({ quotesSent: QUOTES, orders: ORDERS, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    const u1 = r.by_rep.find((x) => x.rep_id === "u1");
    const u2 = r.by_rep.find((x) => x.rep_id === "u2");
    expect(u1.opportunities_quoted).toBe(2);
    expect(u1.won).toBe(1);
    expect(u1.win_rate_pct).toBe(50);
    expect(u2.opportunities_quoted).toBe(1);
    expect(u2.won).toBe(0);
  });

  it("attributed: quoted opp → processed order → paid (via order.opportunity_id)", () => {
    const r = computePipelineConversion({ quotesSent: QUOTES, orders: ORDERS, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    expect(r.attributed.quoted).toBe(3);
    expect(r.attributed.ordered).toBe(1);   // opp1 got a processed order
    expect(r.attributed.paid).toBe(1);      // opp1's order was paid
    expect(r.attributed.order_conv_pct).toBe(33.3);
    expect(r.attributed.paid_conv_pct).toBe(33.3);
    expect(r.attributed.unattributed_processed_orders).toBe(0);
  });

  it("a processed order with no opportunity counts as unattributed, not mis-attributed", () => {
    const orders = [...ORDERS, { id: "ordX", status: "APPROVED", created_at: "2026-07-02T00:00:00Z", approved_at: "2026-07-03T00:00:00Z", customer_id: "c9" }];
    const r = computePipelineConversion({ quotesSent: QUOTES, orders, invoices: INVOICES, opportunities: OPPS, granularity: "month", nowMs: NOW });
    expect(r.totals.orders_processed.count).toBe(2);
    expect(r.attributed.ordered).toBe(1);   // still only opp1
    expect(r.attributed.unattributed_processed_orders).toBe(1);
  });

  it("empty input yields zeroed, well-formed output", () => {
    const r = computePipelineConversion({ quotesSent: [], orders: [], invoices: [], opportunities: [], granularity: "week" });
    expect(r.totals.quotes_sent).toEqual({ count: 0, value: 0 });
    expect(r.trend).toEqual([]);
    expect(r.cohort.win_rate_pct).toBeNull();
    expect(r.conversion.orders_per_quote_pct).toBeNull();
  });
});

// ---- handler RBAC scoping ----
const H = vi.hoisted(() => ({ ctx: null, store: {} }));
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: vi.fn(async () => H.ctx),
  requirePermission: vi.fn(() => {}),
  hasPermission: vi.fn((ctx, level) => (level === "approve" ? ["sales_manager", "finance", "admin"].includes(ctx.role) : true)),
}));
vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({
    from(table) {
      const rows = () => H.store[table] || [];
      const q = { _f: [],
        select() { return this; },
        eq(c, v) { this._f.push((r) => r[c] === v); return this; },
        gte(c, v) { this._f.push((r) => r[c] != null && String(r[c]) >= String(v)); return this; },
        in(c, arr) { this._f.push((r) => arr.includes(r[c])); return this; },
        _run() { return { data: rows().filter((r) => this._f.every((fn) => fn(r))), error: null }; },
        then(res, rej) { return Promise.resolve(this._run()).then(res, rej); },
      };
      return q;
    },
  }),
}));

const { default: handler } = await import("../api/analytics/pipeline.js");

const run = async (query = {}) => {
  const qs = new URLSearchParams({ window_days: "730", granularity: "month", ...query }).toString();
  const res = { statusCode: 200, body: null, setHeader() { return this; }, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, send(p) { this.body = p; return this; }, end(p) { if (p != null) this.body = p; return this; } };
  await handler({ method: "GET", headers: {}, url: "/api/analytics/pipeline?" + qs }, res);
  return { status: res.statusCode, body: typeof res.body === "string" ? JSON.parse(res.body) : res.body };
};

beforeEach(() => {
  const t = (rows) => rows.map((r) => ({ ...r, tenant_id: "t-1" }));
  H.store = {
    opportunities: t(OPPS),
    opportunity_quotes: t(QUOTES),          // P1 uploaded quote revisions ("quotes sent")
    orders: t(ORDERS),
    invoices: t(INVOICES),
    quotes: t([{ id: "gq1", opportunity_id: "opp1" }]), // generated-quote link for P2b attribution
  };
});

describe("GET /analytics/pipeline", () => {
  it("manager (approve-tier) sees the whole tenant", async () => {
    H.ctx = { user: { id: "mgr" }, tenantId: "t-1", role: "admin" };
    const r = await run();
    expect(r.status).toBe(200);
    expect(r.body.scoped_to_self).toBe(false);
    expect(r.body.totals.quotes_sent.count).toBe(4);
    expect(r.body.cohort.quoted).toBe(3);
    expect(r.body.totals.paid.count).toBe(1);
    // P2b: attribution resolved via orders.quote_id -> quotes.opportunity_id
    expect(r.body.attributed.ordered).toBe(1);
    expect(r.body.attributed.paid).toBe(1);
    expect(r.body.attributed.unattributed_processed_orders).toBe(0);
  });

  it("a sales engineer is scoped to their own opportunities + their customers", async () => {
    H.ctx = { user: { id: "u1" }, tenantId: "t-1", role: "sales_engineer" };
    const r = await run();
    expect(r.body.scoped_to_self).toBe(true);
    expect(r.body.totals.quotes_sent.count).toBe(3);  // opp3's quote (u2) excluded
    expect(r.body.cohort.quoted).toBe(2);             // opp1 + opp2
    expect(r.body.cohort.lost).toBe(0);               // opp3 (lost) not theirs
    expect(r.body.totals.orders_processed.count).toBe(1); // c1 is their customer
  });
});
