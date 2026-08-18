// refreshWinloss must report what it PERSISTED, and must not die on a database
// that is behind on a migration.
//
// Both defects here were introduced by the fix that made these rollups run at
// all (#448). It taught the daily loop to count only persisted rows and left
// the monthly loop fifteen lines below still counting attempts; and it replaced
// four phantom column names with a real one from migration 204, which is real
// in the REPO and not necessarily in the DATABASE — migrations here are applied
// by hand, which is the same class of failure that kept these tables empty for
// two years.

import { describe, it, expect } from "vitest";
import { refreshWinloss } from "../api/_lib/winloss.js";

// A supabase double that records selects and can be told which write fails.
// The assertions below are all about which rows were COUNTED versus which were
// actually accepted, so the double has to distinguish those.
const makeSvc = ({ failMonthly = false, failDaily = false, noOpportunityColumn = false, orders = [] } = {}) => {
  const selects = [];
  const writes = { daily: 0, monthly: 0 };
  return {
    selects, writes,
    from(table) {
      const self = {
        _cols: null,
        select(cols) { self._cols = cols; selects.push({ table, cols }); return self; },
        eq() { return self; },
        gte() { return self; },
        in() { return self; },
        async upsert() {
          if (table === "analytics_customer_monthly") {
            writes.monthly += 1;
            return failMonthly ? { error: { message: "monthly write refused" } } : { error: null };
          }
          writes.daily += 1;
          return failDaily ? { error: { message: "daily write refused" } } : { error: null };
        },
        then(resolve) {
          // Awaiting the builder resolves the read.
          if (table === "orders") {
            if (noOpportunityColumn && /opportunity_id/.test(self._cols || "")) {
              return resolve({ data: null, error: { code: "42703", message: 'column orders.opportunity_id does not exist' } });
            }
            return resolve({ data: orders, error: null });
          }
          if (table === "customers") return resolve({ data: [{ id: "c1", tier: "gold" }], error: null });
          if (table === "opportunities") return resolve({ data: [], error: null });
          if (table === "audit_events") return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        },
      };
      return self;
    },
  };
};

const ORDERS = [
  { id: "o1", status: "APPROVED", created_at: "2026-08-01T00:00:00Z", customer_id: "c1", approval: null, lost_reason: null, opportunity_id: null, result: {} },
  { id: "o2", status: "APPROVED", created_at: "2026-08-02T00:00:00Z", customer_id: "c1", approval: null, lost_reason: null, opportunity_id: null, result: {} },
];

describe("refreshWinloss counts only what persisted", () => {
  it("reports months_written 0 when every monthly upsert is refused", async () => {
    const svc = makeSvc({ orders: ORDERS, failMonthly: true });
    const out = await refreshWinloss(svc, "t1", 90);
    // It ATTEMPTED at least one monthly row...
    expect(svc.writes.monthly).toBeGreaterThan(0);
    // ...and must not claim to have written it.
    expect(out.months_written).toBe(0);
    // write_errors is a COUNT, not an array — asserting .length here is the
    // same mistake that has shipped bugs green in this repo all session.
    expect(out.write_errors).toBeGreaterThan(0);
  });

  it("reports months_written when the upserts are accepted", async () => {
    const svc = makeSvc({ orders: ORDERS });
    const out = await refreshWinloss(svc, "t1", 90);
    expect(out.months_written).toBeGreaterThan(0);
  });

  it("keeps the daily loop honest too", async () => {
    const svc = makeSvc({ orders: ORDERS, failDaily: true });
    const out = await refreshWinloss(svc, "t1", 90);
    expect(svc.writes.daily).toBeGreaterThan(0);
    expect(out.days_written).toBe(0);
  });
});

describe("refreshWinloss survives a DB without migration 204", () => {
  it("retries without opportunity_id instead of throwing", async () => {
    const svc = makeSvc({ orders: ORDERS, noOpportunityColumn: true });
    const out = await refreshWinloss(svc, "t1", 90);
    // PostgREST rejects the whole select over one unknown column. Before this,
    // that rejection propagated and the nightly refresh died at step one —
    // silently, exactly as it had for two years.
    expect(out.days_written).toBeGreaterThan(0);
    expect(out.opportunity_column).toBe(false);
  });

  it("says so in the response rather than degrading invisibly", async () => {
    const ok = await refreshWinloss(makeSvc({ orders: ORDERS }), "t1", 90);
    expect(ok.opportunity_column).toBe(true);
  });

  it("asks for the column first, then falls back — not the other way round", async () => {
    const svc = makeSvc({ orders: ORDERS, noOpportunityColumn: true });
    await refreshWinloss(svc, "t1", 90);
    const orderSelects = svc.selects.filter((s) => s.table === "orders");
    expect(orderSelects.length).toBe(2);
    expect(orderSelects[0].cols).toMatch(/opportunity_id/);
    expect(orderSelects[1].cols).not.toMatch(/opportunity_id/);
  });

  it("does not retry on an unrelated error", async () => {
    // A permissions or connection failure must surface, not be masked by a
    // second attempt that fails the same way.
    const svc = {
      from(table) {
        const self = {
          select() { return self; }, eq() { return self; }, gte() { return self; }, in() { return self; },
          async upsert() { return { error: null }; },
          then(resolve) {
            if (table === "orders") return resolve({ data: null, error: { code: "42501", message: "permission denied" } });
            return resolve({ data: [], error: null });
          },
        };
        return self;
      },
    };
    await expect(refreshWinloss(svc, "t1", 90)).rejects.toThrow(/permission denied/);
  });
});
