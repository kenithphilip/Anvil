// GenAI copilot P0a: the governed Metric Catalog. A question resolves to a
// catalog entry, never free-form SQL; every answer carries value + unit +
// provenance + as_of. Tests: the pure reducers (the math), the compute wiring
// (fetch → reduce → answer contract), the catalog surface, and that the
// query_metric / list_metrics copilot tools are registered read.analytics.

import { describe, it, expect } from "vitest";
import { METRICS, listMetrics, getMetric, computeMetric } from "../api/_lib/metrics/catalog.js";
import { erpChatTools, erpChatToolScope } from "../api/_lib/erp-chat-tools.js";

const NOW = Date.parse("2026-07-21T00:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const reduceOf = (id, rows) => getMetric(id).reduce(rows, { nowMs: NOW, windowDays: 90 });

// ── in-memory svc shim (ignores filters; seed rows already "in window") ──
const makeSvc = (seed) => ({
  from: (table) => {
    const b = { select: () => b, eq: () => b, gte: () => b, then: (r) => r({ data: seed[table] || [], error: null }) };
    return b;
  },
});

describe("catalog surface", () => {
  it("lists ~10 governed metrics with id/unit/domain", () => {
    const list = listMetrics();
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(list.every((m) => m.id && m.unit && m.domain && m.label)).toBe(true);
    expect(list.map((m) => m.id)).toEqual(expect.arrayContaining(["ar_outstanding", "ar_overdue", "revenue_accepted", "quote_acceptance_rate"]));
    // no duplicate ids
    expect(new Set(list.map((m) => m.id)).size).toBe(list.length);
    // every metric declares a valid unit
    expect(METRICS.every((m) => ["currency", "count", "days", "percent"].includes(m.unit))).toBe(true);
  });
});

describe("finance / AR reducers", () => {
  const invoices = [
    { status: "sent", grand_total: 1000, paid_amount: 0, due_date: daysAgo(10) },   // overdue 10d
    { status: "partially_paid", grand_total: 500, paid_amount: 200, due_date: daysAgo(45) }, // overdue 45d, bal 300
    { status: "sent", grand_total: 400, paid_amount: 0, due_date: daysAgo(-5) },     // current (not due)
    { status: "paid", grand_total: 999, paid_amount: 999, due_date: daysAgo(80) },   // paid -> excluded
    { status: "draft", grand_total: 700, paid_amount: 0, due_date: daysAgo(3) },     // draft -> excluded
  ];
  it("ar_outstanding sums open balances", () => {
    expect(reduceOf("ar_outstanding", invoices).value).toBe(1700); // 1000 + 300 + 400
  });
  it("ar_overdue counts only past-due balances + a bucket breakdown", () => {
    const r = reduceOf("ar_overdue", invoices);
    expect(r.value).toBe(1300); // 1000 + 300 (the current 400 is not overdue)
    expect(r.count).toBe(2);
    expect(Array.isArray(r.breakdown)).toBe(true);
  });
  it("ar_overdue_rate = overdue / total × 100", () => {
    expect(reduceOf("ar_overdue_rate", invoices).value).toBeCloseTo(76.5, 1); // 1300/1700
  });
});

describe("sales reducers", () => {
  const quotes = [
    { status: "ACCEPTED", grand_total: 1000, created_at: daysAgo(20), sent_at: daysAgo(18), accepted_at: daysAgo(12) },
    { status: "SENT", grand_total: 500, created_at: daysAgo(15), sent_at: daysAgo(14), accepted_at: null },
    { status: "CANCELLED", grand_total: 800, created_at: daysAgo(10), sent_at: null, accepted_at: null },
  ];
  it("revenue_accepted sums accepted, non-cancelled quotes", () => {
    expect(reduceOf("revenue_accepted", quotes).value).toBe(1000);
  });
  it("quote_acceptance_rate = accepted / non-cancelled", () => {
    const r = reduceOf("quote_acceptance_rate", quotes);
    expect(r.value).toBe(50); // 1 accepted of 2 non-cancelled
    expect(r).toMatchObject({ count: 1, denominator: 2 });
  });
  it("avg_quote_value averages all quotes' grand_total", () => {
    expect(reduceOf("avg_quote_value", quotes).value).toBeCloseTo((1000 + 500 + 800) / 3, 2);
  });
  it("quotes_created counts rows", () => {
    expect(reduceOf("quotes_created", quotes).value).toBe(3);
  });
  it("quote_cycle_time_median = median(sent→accepted)", () => {
    expect(reduceOf("quote_cycle_time_median", quotes).value).toBe(6); // 18d-12d = 6d, single sample
  });
});

describe("operations reducers", () => {
  const orders = [
    { status: "APPROVED", created_at: daysAgo(20), approved_at: daysAgo(18) }, // 2d
    { status: "OPEN", created_at: daysAgo(10), approved_at: daysAgo(6) },      // 4d
    { status: "CANCELLED", created_at: daysAgo(5), approved_at: daysAgo(1) },  // excluded
  ];
  it("order_approval_time_median = median(created→approved), excludes cancelled", () => {
    expect(reduceOf("order_approval_time_median", orders).value).toBe(3); // median(2,4)
  });
  it("orders_created counts rows", () => {
    expect(reduceOf("orders_created", orders).value).toBe(3);
  });
});

describe("computeMetric — the answer contract", () => {
  it("wires fetch → reduce → { value, unit, provenance, as_of }", async () => {
    const svc = makeSvc({ invoices: [{ status: "sent", grand_total: 1000, paid_amount: 0, due_date: daysAgo(40) }] });
    const ans = await computeMetric(svc, "t1", "ar_overdue", {}, NOW);
    expect(ans).toMatchObject({ metric_id: "ar_overdue", unit: "currency", domain: "finance", value: 1000 });
    expect(ans.provenance).toBeTruthy();
    expect(ans.as_of).toBe(new Date(NOW).toISOString());
    expect(ans.breakdown).toBeDefined();
  });

  it("stamps window_days only on windowed metrics", async () => {
    const svc = makeSvc({ quotes: [{ status: "ACCEPTED", grand_total: 200, created_at: daysAgo(5), accepted_at: daysAgo(2) }] });
    const win = await computeMetric(svc, "t1", "revenue_accepted", { window_days: 30 }, NOW);
    expect(win.window_days).toBe(30);
    const ar = await computeMetric(makeSvc({ invoices: [] }), "t1", "ar_outstanding", {}, NOW);
    expect(ar.window_days).toBeUndefined(); // AR is not windowed
    expect(ar.value).toBe(0);
  });

  it("clamps the window and rejects an unknown metric", async () => {
    const svc = makeSvc({ quotes: [] });
    const clamped = await computeMetric(svc, "t1", "quotes_created", { window_days: 99999 }, NOW);
    expect(clamped.window_days).toBe(365);
    await expect(computeMetric(svc, "t1", "no_such_metric", {}, NOW)).rejects.toMatchObject({ status: 404 });
  });
});

describe("P1a domain reducers (opportunities / inventory / suppliers)", () => {
  const opps = [
    { stage: "RFQ", amount_inr: 1000, probability: 40, ai_probability: 60 },        // open; ai-weighted 600
    { stage: "QUALIFICATION", amount_inr: 500, probability: 20, ai_probability: null }, // open; operator-weighted 100
    { stage: "CLOSE_WON", amount_inr: 2000, probability: 100, ai_probability: 100 },  // terminal -> excluded
    { stage: "CLOSE_LOST", amount_inr: 800, probability: 0 },                          // terminal -> excluded
  ];
  it("open_opportunity_value sums open opps only", () => {
    expect(reduceOf("open_opportunity_value", opps).value).toBe(1500);
  });
  it("weighted_pipeline_value uses ai_probability when set, else operator probability", () => {
    expect(reduceOf("weighted_pipeline_value", opps).value).toBe(700); // 1000*.6 + 500*.2
  });
  it("open_opportunities counts non-terminal stages", () => {
    expect(reduceOf("open_opportunities", opps).value).toBe(2);
  });

  it("inventory_exceptions_open counts status=open with a severity breakdown", () => {
    const rows = [
      { status: "open", severity: "critical", exception_kind: "stockout_imminent" },
      { status: "open", severity: "warn", exception_kind: "below_reorder_point" },
      { status: "resolved", severity: "bad" },
      { status: "acknowledged", severity: "critical" },
    ];
    const r = reduceOf("inventory_exceptions_open", rows);
    expect(r.value).toBe(2);
    expect(r.breakdown).toEqual([{ label: "critical", count: 1 }, { label: "warn", count: 1 }]);
  });

  it("supplier_on_time_rate averages on_time_pct (already 0-100)", () => {
    const r = reduceOf("supplier_on_time_rate", [{ supplier: "Acme", on_time_pct: 90 }, { supplier: "Beta", on_time_pct: 80 }]);
    expect(r.value).toBe(85);
    expect(r.count).toBe(2);
  });
});

describe("copilot tools", () => {
  it("registers query_metric + list_metrics under read.analytics", () => {
    const names = erpChatTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["query_metric", "list_metrics"]));
    expect(erpChatToolScope("query_metric")).toBe("read.analytics");
    expect(erpChatToolScope("list_metrics")).toBe("read.analytics");
    // read.analytics is a read scope, so default MCP tokens (read.*) can call it
    expect("read.analytics".startsWith("read.")).toBe(true);
  });

  it("registers the P1a domain tools with read scopes", () => {
    const names = erpChatTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_opportunities", "read_inventory_exceptions", "supplier_scorecard", "list_demand_forecast"]));
    expect(erpChatToolScope("search_opportunities")).toBe("read.pipeline");
    expect(erpChatToolScope("read_inventory_exceptions")).toBe("read.inventory");
    expect(erpChatToolScope("supplier_scorecard")).toBe("read.suppliers");
    expect(erpChatToolScope("list_demand_forecast")).toBe("read.inventory");
    // every P1a tool scope is a read scope (default-granted to MCP tokens)
    for (const n of ["search_opportunities", "read_inventory_exceptions", "supplier_scorecard", "list_demand_forecast"]) {
      expect(erpChatToolScope(n).startsWith("read.")).toBe(true);
    }
  });
});
