// Integration test for src/api/mapping/workspace.js (Wave CM 5.1).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveContext = vi.fn();
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: mockResolveContext,
  requirePermission: vi.fn(),
}));

const tableData = {};
const svc = {
  from: (table) => {
    const rows = tableData[table] || [];
    let filtered = [...rows];
    const builder = {
      select() { return builder; },
      eq(col, val) {
        filtered = filtered.filter((r) => String(r[col]) === String(val));
        return builder;
      },
      in(col, vals) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return builder;
      },
      order() { return builder; },
      limit() { return Promise.resolve({ data: filtered, error: null }); },
      then(fn) { return Promise.resolve(fn({ data: filtered, error: null })); },
    };
    return builder;
  },
};
vi.mock("../api/_lib/supabase.js", () => ({ serviceClient: () => svc }));

const fakeRes = () => {
  const captured = { status: null, json: null };
  return {
    res: {
      setHeader: () => {},
      status: (n) => ({
        send: (s) => { captured.status = n; captured.json = JSON.parse(s); },
        json: (j) => { captured.status = n; captured.json = j; },
      }),
    },
    captured,
  };
};

const fakeReq = (query = {}, method = "GET") => ({
  method,
  headers: {},
  query,
});

describe("GET /api/mapping/workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveContext.mockResolvedValue({ tenantId: "t1", userId: "u1" });
    tableData.customer_merge_candidates = [
      { tenant_id: "t1", id: "m1", customer_a_id: "ca", customer_b_id: "cb", probability: 0.92, status: "open" },
      { tenant_id: "t1", id: "m2", customer_a_id: "cx", customer_b_id: "cy", probability: 0.55, status: "open" },
    ];
    tableData.item_customer_parts = [
      { tenant_id: "t1", customer_id: "ca", item_id: "i1", customer_part_number: "P1", created_via: "auto_consensus", confidence_pct: 90 },
      { tenant_id: "t1", customer_id: "cb", item_id: "i2", customer_part_number: "P2", created_via: "llm_suggest", confidence_pct: 80 },
      { tenant_id: "t1", customer_id: "cc", item_id: "i3", customer_part_number: "P3", created_via: "manual", confidence_pct: 100 },
    ];
  });

  it("returns 405 on non-GET", async () => {
    const { default: handler } = await import("../api/mapping/workspace.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({}, "POST"), res);
    expect(captured.status).toBe(405);
  });

  it("aggregates dedupe + recent_auto_consensus + llm_suggest_pending + summary", async () => {
    const { default: handler } = await import("../api/mapping/workspace.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq(), res);
    expect(captured.status).toBe(200);
    expect(captured.json.ok).toBe(true);
    expect(captured.json.dedupe_candidates.length).toBe(2);
    expect(captured.json.auto_consensus_recent.length).toBe(1);
    expect(captured.json.llm_suggest_pending.length).toBe(1);
    expect(captured.json.mapping_summary).toEqual({
      auto_consensus: 1, llm_suggest: 1, manual: 1,
    });
  });

  it("scopes everything to one customer when customer_id supplied", async () => {
    const { default: handler } = await import("../api/mapping/workspace.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({ customer_id: "ca" }), res);
    expect(captured.json.dedupe_candidates.length).toBe(1);     // only m1 involves ca
    expect(captured.json.auto_consensus_recent.length).toBe(1); // ca's row
    expect(captured.json.llm_suggest_pending.length).toBe(0);   // ca had no llm
    expect(captured.json.mapping_summary).toEqual({ auto_consensus: 1 });
  });

  it("returns empty buckets when nothing matches", async () => {
    const { default: handler } = await import("../api/mapping/workspace.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({ customer_id: "no-such-customer" }), res);
    expect(captured.json.dedupe_candidates).toEqual([]);
    expect(captured.json.auto_consensus_recent).toEqual([]);
    expect(captured.json.llm_suggest_pending).toEqual([]);
  });
});
