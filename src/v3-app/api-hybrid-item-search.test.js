// Unit tests for src/api/_lib/hybrid-item-search.js (Wave CM 2.2).

import { describe, it, expect, vi } from "vitest";
import {
  buildSearchText, searchItemsHybrid, searchItemsHybridBatch,
} from "../api/_lib/hybrid-item-search.js";

describe("buildSearchText", () => {
  it("returns '' on null / no fields", () => {
    expect(buildSearchText(null)).toBe("");
    expect(buildSearchText({})).toBe("");
  });
  it("concatenates every text-bearing field", () => {
    const out = buildSearchText({
      partNumber: "THB-001",
      description: "Bend adapter",
      customer_part_number: "GD-544",
    });
    expect(out).toContain("THB-001");
    expect(out).toContain("Bend adapter");
    expect(out).toContain("GD-544");
  });
  it("caps at 256 chars", () => {
    const out = buildSearchText({ description: "x".repeat(500) });
    expect(out.length).toBeLessThanOrEqual(256);
  });
});

describe("searchItemsHybrid", () => {
  it("returns [] on missing args", async () => {
    expect(await searchItemsHybrid(null, { tenantId: "t" })).toEqual([]);
    expect(await searchItemsHybrid({}, { tenantId: null })).toEqual([]);
  });

  it("returns [] when both queryText and queryEmbedding are empty", async () => {
    expect(await searchItemsHybrid({}, { tenantId: "t" })).toEqual([]);
  });

  it("calls the RPC and returns its rows", async () => {
    let capturedArgs = null;
    const svc = {
      rpc: vi.fn().mockImplementation((name, args) => {
        capturedArgs = args;
        return Promise.resolve({ data: [
          { item_id: "i1", part_no: "THB-001", score: 0.032, bm25_rank: 1, vector_rank: 2 },
        ], error: null });
      }),
    };
    const out = await searchItemsHybrid(svc, {
      tenantId: "t1",
      queryText: "Bend adapter",
      queryEmbedding: [0.1, 0.2, 0.3],
      matchCount: 5,
    });
    expect(out.length).toBe(1);
    expect(svc.rpc).toHaveBeenCalledWith("match_items_hybrid", expect.objectContaining({
      _tenant_id: "t1",
      _match_count: 5,
    }));
    expect(capturedArgs._query_vector).toEqual([0.1, 0.2, 0.3]);
  });

  it("falls back to lexical when no embedding supplied", async () => {
    let captured = null;
    const svc = {
      rpc: vi.fn().mockImplementation((_, args) => {
        captured = args;
        return Promise.resolve({ data: [], error: null });
      }),
    };
    await searchItemsHybrid(svc, { tenantId: "t1", queryText: "Bolt M8" });
    expect(captured._query_vector).toBeNull();
    expect(captured._query_text).toBe("Bolt M8");
  });

  it("returns [] when the RPC throws", async () => {
    const svc = { rpc: () => Promise.reject(new Error("rpc_down")) };
    expect(await searchItemsHybrid(svc, { tenantId: "t", queryText: "x" })).toEqual([]);
  });
});

describe("searchItemsHybridBatch", () => {
  it("returns [] on empty input", async () => {
    expect(await searchItemsHybridBatch({}, { tenantId: "t", lines: [] })).toEqual([]);
  });

  it("embeds each non-empty line and runs hybrid search per line", async () => {
    const embedFn = vi.fn().mockResolvedValue({
      ok: true,
      embeddings: [[0.1], [0.2]],
    });
    const svc = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ item_id: "i1", part_no: "X", score: 0.5 }],
        error: null,
      }),
    };
    const out = await searchItemsHybridBatch(svc, {
      tenantId: "t",
      lines: [{ description: "Bend adapter" }, { partNumber: "THB-001" }],
      embedFn,
    });
    expect(out.length).toBe(2);
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(svc.rpc).toHaveBeenCalledTimes(2);
  });

  it("falls back to lexical-only when embedFn fails", async () => {
    const embedFn = vi.fn().mockResolvedValue({ ok: false });
    let lastArgs = null;
    const svc = {
      rpc: vi.fn().mockImplementation((_, args) => {
        lastArgs = args;
        return Promise.resolve({ data: [], error: null });
      }),
    };
    await searchItemsHybridBatch(svc, {
      tenantId: "t",
      lines: [{ description: "Bend adapter" }],
      embedFn,
    });
    expect(lastArgs._query_vector).toBeNull();
  });
});
