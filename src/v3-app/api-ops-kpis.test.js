// Sales-ops KPI substrate (analytics/ops_kpis) — pure compute lib.
import { describe, it, expect } from "vitest";
import { computeArAging, computeCycleTime, computeRevenueByRep, median, percentile } from "../api/_lib/ops-kpis.js";

const DAY = 86400000;
const now = Date.parse("2026-07-06T00:00:00Z");
const ago = (d) => new Date(now - d * DAY).toISOString();
const dueIn = (d) => new Date(now + d * DAY).toISOString().slice(0, 10);

describe("median / percentile", () => {
  it("median of odd/even", () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); });
  it("null on empty", () => { expect(median([])).toBeNull(); expect(percentile([], 90)).toBeNull(); });
  it("p90", () => { expect(percentile([1,2,3,4,5,6,7,8,9,10], 90)).toBe(9); });
});

describe("computeArAging", () => {
  const invoices = [
    { status: "sent",    grand_total: 100, paid_amount: 0,  due_date: dueIn(10) },   // current
    { status: "overdue", grand_total: 200, paid_amount: 50, due_date: dueIn(-15) },  // 1-30, outstanding 150
    { status: "partial", grand_total: 300, paid_amount: 0,  due_date: dueIn(-75) },  // 61-90
    { status: "paid",    grand_total: 400, paid_amount: 400, due_date: dueIn(-100) },// excluded (paid)
    { status: "void",    grand_total: 999, paid_amount: 0,  due_date: dueIn(-100) }, // excluded (void)
    { status: "draft",   grand_total: 500, paid_amount: 0,  due_date: dueIn(-5) },   // excluded (draft)
  ];
  const r = computeArAging(invoices, now);
  it("total outstanding excludes paid/void/draft", () => { expect(r.total_outstanding).toBe(100 + 150 + 300); });
  it("overdue excludes current", () => { expect(r.overdue_outstanding).toBe(150 + 300); expect(r.overdue_count).toBe(2); });
  it("buckets by days past due", () => {
    const by = Object.fromEntries(r.buckets.map((b) => [b.label, b]));
    expect(by.current.outstanding).toBe(100);
    expect(by["1-30"].outstanding).toBe(150);
    expect(by["61-90"].outstanding).toBe(300);
    expect(by["90+"].outstanding).toBe(0);
  });
  it("overdue_rate = overdue/total", () => { expect(r.overdue_rate).toBe(Math.round((450 / 550) * 1000) / 10); });
});

describe("computeCycleTime", () => {
  const quotes = [
    { status: "SENT", created_at: ago(20), sent_at: ago(18), accepted_at: null },   // q→sent 2d
    { status: "ACCEPTED", created_at: ago(30), sent_at: ago(26), accepted_at: ago(20) }, // q→sent 4d, sent→acc 6d
    { status: "CANCELLED", created_at: ago(5), sent_at: ago(1), accepted_at: null }, // excluded
  ];
  const orders = [
    { status: "APPROVED", created_at: ago(10), approved_at: ago(7) },  // 3d
    { status: "CANCELLED", created_at: ago(9), approved_at: ago(1) },  // excluded
  ];
  const r = computeCycleTime(quotes, orders);
  it("quote_to_sent median", () => { expect(r.quote_to_sent.median).toBe(3); expect(r.quote_to_sent.n).toBe(2); });
  it("sent_to_accepted", () => { expect(r.sent_to_accepted.median).toBe(6); expect(r.sent_to_accepted.n).toBe(1); });
  it("order_to_approved excludes cancelled", () => { expect(r.order_to_approved.median).toBe(3); expect(r.order_to_approved.n).toBe(1); });
});

describe("computeRevenueByRep", () => {
  const quotes = [
    { status: "ACCEPTED", accepted_at: ago(1), grand_total: 100, created_by: "u1" },
    { status: "CONVERTED", accepted_at: ago(2), grand_total: 200, created_by: "u1" },
    { status: "ACCEPTED", accepted_at: ago(3), grand_total: 50, created_by: null },
    { status: "SENT", accepted_at: null, grand_total: 999, created_by: "u2" }, // not accepted
  ];
  const r = computeRevenueByRep(quotes);
  it("sums accepted value per rep, sorted desc", () => {
    expect(r[0]).toEqual({ rep_id: "u1", accepted_value: 300, count: 2 });
    expect(r.find((x) => x.rep_id === "unassigned")).toEqual({ rep_id: "unassigned", accepted_value: 50, count: 1 });
    expect(r.find((x) => x.rep_id === "u2")).toBeUndefined();
  });
});
