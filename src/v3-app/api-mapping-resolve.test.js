// Integration test for src/api/mapping/resolve.js (Wave CM 5.2).
//
// We mock _lib/auth, _lib/supabase, _lib/anthropic, item-mapper,
// hybrid-item-search, cross-encoder-rerank so the handler runs
// entirely in memory. Tests focus on the WIRING (the right
// helpers called with the right shape) rather than re-testing
// the helpers themselves.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveContext = vi.fn();
vi.mock("../api/_lib/auth.js", () => ({
  resolveContext: mockResolveContext,
  requirePermission: vi.fn(),
}));

vi.mock("../api/_lib/supabase.js", () => ({
  serviceClient: () => ({}),
}));

const mockMapLines = vi.fn();
vi.mock("../api/_lib/item-mapper.js", () => ({
  mapLinesToItemMaster: mockMapLines,
}));

const mockSearch = vi.fn();
vi.mock("../api/_lib/hybrid-item-search.js", () => ({
  searchItemsHybrid: mockSearch,
  buildSearchText: (line) => [line?.partNumber, line?.description].filter(Boolean).join(" "),
}));

const mockRerank = vi.fn();
vi.mock("../api/_lib/cross-encoder-rerank.js", () => ({
  rerankCandidates: mockRerank,
}));

vi.mock("../api/_lib/anthropic.js", () => ({
  callAnthropic: vi.fn(),
}));

const fakeRes = () => {
  const captured = { status: null, json: null, headers: {} };
  return {
    res: {
      setHeader: (k, v) => { captured.headers[k] = v; },
      writeHead: () => {},
      end: () => {},
      status: (n) => ({
        json: (j) => { captured.status = n; captured.json = j; },
        send: (s) => {
          captured.status = n;
          captured.json = typeof s === "string" ? JSON.parse(s) : s;
        },
      }),
      getHeader: (k) => captured.headers[k],
    },
    captured,
  };
};

const fakeReq = (body, method = "POST") => ({
  method,
  headers: {},
  body,
  on: () => {},
});

describe("POST /api/mapping/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveContext.mockResolvedValue({ tenantId: "t1", userId: "u1" });
  });

  it("returns 405 on non-POST", async () => {
    const { default: handler } = await import("../api/mapping/resolve.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq(null, "GET"), res);
    expect(captured.status).toBe(405);
  });

  it("rejects empty lines", async () => {
    const { default: handler } = await import("../api/mapping/resolve.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({ customer_id: "c1", lines: [] }), res);
    expect(captured.status).toBe(400);
  });

  it("returns resolved_lines + meta on the happy path", async () => {
    mockMapLines.mockResolvedValue([
      { partNumber: "THB-001", _mapped_item: { id: "i1", part_no: "THB-001", match_via: "item_master.part_no" } },
      { partNumber: "UNKNOWN", _mapped_item: null },
    ]);
    mockSearch.mockResolvedValue([
      { item_id: "i2", part_no: "THB-CLOSE", description: "Adapter close match" },
    ]);
    mockRerank.mockResolvedValue([
      { item_id: "i2", part_no: "THB-CLOSE", rerank_score: 0.87 },
    ]);
    const { default: handler } = await import("../api/mapping/resolve.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({
      customer_id: "c1",
      lines: [{ partNumber: "THB-001" }, { partNumber: "UNKNOWN" }],
    }), res);
    expect(captured.status).toBe(200);
    expect(captured.json.ok).toBe(true);
    expect(captured.json.resolved_lines.length).toBe(2);
    expect(captured.json.meta.mapped_lines).toBe(1);
    expect(captured.json.meta.unmapped_lines).toBe(1);
    // The unmapped line surfaced a suggestion via the rerank.
    expect(captured.json.suggestions.length).toBe(1);
    expect(captured.json.suggestions[0].candidates[0].item_id).toBe("i2");
  });

  it("threads context + customerId into the resolver", async () => {
    mockMapLines.mockResolvedValue([]);
    const { default: handler } = await import("../api/mapping/resolve.js");
    const { res } = fakeRes();
    await handler(fakeReq({
      customer_id: "c1",
      lines: [{ partNumber: "X" }],
      context: "quote",
    }), res);
    expect(mockMapLines).toHaveBeenCalledWith({}, "t1", "c1", expect.any(Array), { context: "quote" });
  });

  it("skips rerank when body.rerank=false", async () => {
    mockMapLines.mockResolvedValue([{ partNumber: "X", _mapped_item: null }]);
    const { default: handler } = await import("../api/mapping/resolve.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({
      customer_id: "c1",
      lines: [{ partNumber: "X" }],
      rerank: false,
    }), res);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockRerank).not.toHaveBeenCalled();
    expect(captured.json.suggestions).toEqual([]);
  });

  it("falls back to pre-rerank candidates when rerank fails", async () => {
    mockMapLines.mockResolvedValue([{ partNumber: "X", _mapped_item: null }]);
    mockSearch.mockResolvedValue([{ item_id: "i1", part_no: "X", description: "match" }]);
    mockRerank.mockResolvedValue(null);
    const { default: handler } = await import("../api/mapping/resolve.js");
    const { res, captured } = fakeRes();
    await handler(fakeReq({ customer_id: "c1", lines: [{ partNumber: "X" }] }), res);
    expect(captured.json.suggestions.length).toBe(1);
    expect(captured.json.suggestions[0].candidates[0].item_id).toBe("i1");
  });
});
