// The nightly analytics refresh threw on its first step, every run.
//
// refreshWinloss selected four columns that are not on `orders`:
//
//   total_value      orders holds no money at all
//   created_by       no such column
//   lost_reason_id   the column is `lost_reason`, free text
//   customer_tier    not on orders; it already joins customers.tier
//
// PostgREST rejects a select naming an unknown column, so the query errored and
// the very next line threw. analytics_winloss_daily and the funnel snapshots
// have therefore always been empty, and every pipeline report reading them
// showed zero — with nothing anywhere saying the refresh had failed.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { orderGrandTotal } from "../api/_lib/order-value.js";

const winloss = readFileSync("src/api/_lib/winloss.js", "utf8");
const endpoint = readFileSync("src/api/analytics/winloss.js", "utf8");

// The authoritative column set, parsed from the migrations rather than assumed.
// Must include later ALTERs: lost_reason, opportunity_id and result are all
// added after 001, so reading only the create-table block understates the table.
const ordersColumns = () => {
  const cols = new Set();
  const init = readFileSync("supabase/migrations/001_init.sql", "utf8");
  const m = /create table if not exists orders \(([\s\S]*?)\n\);/.exec(init);
  for (const line of (m ? m[1] : "").split("\n")) {
    const mm = /^\s*([a-z_]+)\s+[a-z]/.exec(line);
    if (mm && !/^\s*(unique|primary|foreign|check|constraint)/.test(line)) cols.add(mm[1]);
  }
  for (const f of readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql"))) {
    const sql = readFileSync("supabase/migrations/" + f, "utf8");
    for (const blk of sql.match(/alter table orders\b[\s\S]*?;/gi) || []) {
      for (const c of blk.match(/add column if not exists ([a-z_]+)/gi) || []) {
        cols.add(c.replace(/add column if not exists /i, ""));
      }
    }
  }
  return cols;
};

// Source with comments removed — otherwise an assertion that a call is GONE
// matches the comment explaining why it was removed.
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("refreshWinloss selects only columns that exist", () => {
  const selected = () => {
    const m = /from\("orders"\)\s*\n?\s*\.select\("([^"]+)"\)/.exec(winloss);
    return (m ? m[1] : "").split(",").map((s) => s.trim()).filter(Boolean);
  };

  it("names at least one column", () => {
    expect(selected().length).toBeGreaterThan(0);
  });

  // The regression.
  it("no longer selects the four phantom columns", () => {
    const sel = selected();
    for (const bad of ["total_value", "created_by", "lost_reason_id", "customer_tier"]) {
      expect(sel).not.toContain(bad);
    }
  });

  it("every selected column exists on orders", () => {
    const cols = ordersColumns();
    // Sanity: the parser found a real table, not an empty set.
    expect(cols.has("status")).toBe(true);
    expect(cols.has("customer_id")).toBe(true);
    for (const c of selected()) expect(cols.has(c)).toBe(true);
  });

  it("uses lost_reason, the column that does exist", () => {
    expect(ordersColumns().has("lost_reason")).toBe(true);
    expect(winloss).toContain("o.lost_reason");
  });

  it("takes the rep from the opportunity's owner, since orders has no creator", () => {
    expect(winloss).toContain("owner_id");
    expect(winloss).not.toMatch(/o\.created_by/);
  });

  it("counts a rollup row only once it persisted", () => {
    // It ignored the upsert result and returned the attempt count as
    // days_written, so a refresh that wrote nothing reported a full run.
    expect(winloss).toMatch(/const \{ error \} = await svc\.from\("analytics_winloss_daily"\)/);
    expect(winloss).toContain("write_errors");
  });
});

describe("the endpoint's name hydration targets things that exist", () => {
  it("no longer queries a lost_reasons table", () => {
    // No migration creates one; the rollup key is already the human label.
    expect(code(endpoint)).not.toMatch(/from\("lost_reasons"\)/);
  });

  it("no longer queries auth.users through PostgREST", () => {
    // The auth schema is not exposed as a table; the error was swallowed and
    // every rep rendered as an 8-char uuid fragment.
    expect(code(endpoint)).not.toMatch(/from\("auth\.users"\)/);
    expect(endpoint).toContain("auth.admin.getUserById");
  });
});

describe("orderGrandTotal", () => {
  it("prefers a stated grand total", () => {
    expect(orderGrandTotal({ result: { salesOrder: { grandTotal: 5000 } } })).toBe(5000);
  });

  it("sums line items when no total is stated", () => {
    expect(orderGrandTotal({ result: { salesOrder: {
      lineItems: [{ rate: 100, quantity: 3 }, { total: 250 }],
    } } })).toBe(550);
  });

  it("adds tax to a stated subtotal", () => {
    expect(orderGrandTotal({ result: { salesOrder: { subtotal: 1000, taxTotal: 180 } } })).toBe(1180);
  });

  it("falls back to the linked opportunity's amount", () => {
    // An order created before extraction ran carries no money of its own.
    expect(orderGrandTotal({ result: {} }, { amount_inr: 7500 })).toBe(7500);
  });

  it("returns 0, never null, so a running sum is not poisoned", () => {
    for (const o of [null, undefined, {}, { result: null }, { result: { salesOrder: {} } }]) {
      expect(orderGrandTotal(o)).toBe(0);
    }
  });

  it("ignores a non-numeric total rather than propagating NaN", () => {
    expect(orderGrandTotal({ result: { salesOrder: { grandTotal: "abc" } } })).toBe(0);
  });
});
