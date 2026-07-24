// Ask Anvil answered "0 cancelled orders" while the database held 15.
//
// Two independent defects produced that, and both are the dangerous kind —
// a WRONG ANSWER delivered confidently, not an error:
//
//   1. Status filters used .eq(), which is case-sensitive. orders.status is
//      stored uppercase ('CANCELLED') but the UI chips (and therefore the way
//      an operator phrases the question) are lowercase, so the model passed
//      'cancelled' and matched nothing. The assistant then rationalised the
//      empty result as "there are genuinely no cancelled orders".
//   2. Counting meant rows.length, but every search caps at 50 — so any
//      "how many" question silently answered with the page size.

import { describe, it, expect, vi } from "vitest";

// dispatchErpChatTool builds its own client, so the recorder is injected via
// the supabase module rather than a parameter.
const H = { svc: null };
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => H.svc }));

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { erpChatTools, dispatchErpChatTool } from "../api/_lib/erp-chat-tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_SRC = readFileSync(join(HERE, "..", "api", "_lib", "erp-chat-tools.js"), "utf8");
const SEND_SRC = readFileSync(join(HERE, "..", "api", "erp_chat", "send.js"), "utf8");

// Records the query so we can assert HOW it filtered, and returns a page plus
// a true total — mirroring PostgREST's { data, count } with count:"exact".
const makeSvc = ({ rows = [], total = null }) => {
  const calls = [];
  const build = (table) => {
    const q = {
      select: (_c, opts) => { calls.push({ table, count: opts?.count }); return q; },
      eq: (c, v) => { calls.push({ op: "eq", c, v }); return q; },
      ilike: (c, v) => { calls.push({ op: "ilike", c, v }); return q; },
      or: () => q, gte: () => q, lte: () => q, in: () => q, is: () => q,
      order: () => q,
      limit: () => Promise.resolve({ data: rows, count: total, error: null }),
      then: (fn) => Promise.resolve(fn({ data: rows, count: total, error: null })),
    };
    return q;
  };
  return { calls, from: (t) => build(t) };
};

describe("status filtering is case-insensitive", () => {
  it("matches 'cancelled' against a stored 'CANCELLED' (the reported bug)", async () => {
    const svc = H.svc = makeSvc({ rows: [{ id: "o1", status: "CANCELLED" }], total: 15 });
    await dispatchErpChatTool("t1", "search_orders", { status: "cancelled" }, {});
    const statusFilter = svc.calls.find((c) => c.c === "status");
    expect(statusFilter).toBeTruthy();
    // ilike with no wildcards = exact match, case-insensitive. .eq() is the bug.
    expect(statusFilter.op).toBe("ilike");
    expect(statusFilter.v).toBe("cancelled");
  });

  it("no status filter still uses .eq for tenant scoping (safety unchanged)", async () => {
    const svc = H.svc = makeSvc({ rows: [], total: 0 });
    await dispatchErpChatTool("t1", "search_orders", {}, {});
    const tenant = svc.calls.find((c) => c.c === "tenant_id");
    expect(tenant.op).toBe("eq");
    expect(tenant.v).toBe("t1");
  });

  it("every status filter in the tool file goes through the helper", () => {
    // A raw .eq("status", ...) reintroduces the bug.
    expect(TOOLS_SRC).not.toMatch(/\.eq\("status",\s*args/);
    expect((TOOLS_SRC.match(/eqStatus\(q, "status"/g) || []).length).toBeGreaterThanOrEqual(6);
  });
});

describe("counts are TRUE totals, not the page size", () => {
  it("returns total_count from the exact count, not rows.length", async () => {
    // 2 rows on the page, 15 matches in the table.
    H.svc = makeSvc({ rows: [{ id: "a" }, { id: "b" }], total: 15 });
    const out = await dispatchErpChatTool("t1", "search_orders", { status: "cancelled" }, {});
    expect(out.total_count).toBe(15);
    expect(out.returned).toBe(2);
    expect(out.rows).toHaveLength(2);
  });

  it("requests an exact count from PostgREST", async () => {
    const svc = H.svc = makeSvc({ rows: [], total: 0 });
    await dispatchErpChatTool("t1", "search_orders", {}, {});
    expect(svc.calls.find((c) => c.table === "orders")?.count).toBe("exact");
  });

  it("falls back to the row count when the driver reports none", async () => {
    H.svc = makeSvc({ rows: [{ id: "a" }], total: null });
    const out = await dispatchErpChatTool("t1", "search_orders", {}, {});
    expect(out.total_count).toBe(1);
  });

  it("tells the model to count from total_count, never from rows", () => {
    expect(erpChatTools().find((t) => t.name === "search_orders").description).toMatch(/total_count/);
    expect(SEND_SRC).toMatch(/NEVER count the/i);
  });

  it("tells the model not to present a zero as proof of absence", () => {
    // The assistant claimed "there are genuinely no cancelled orders" when the
    // filter, not reality, produced the zero.
    expect(SEND_SRC).toMatch(/zero result is a claim about the DATA/i);
  });
});
