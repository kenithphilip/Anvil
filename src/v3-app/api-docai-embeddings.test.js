// Unit tests for src/api/_lib/docai/embeddings.js (Wave 5.2).

import { describe, it, expect, vi } from "vitest";
import {
  buildItemEmbedSource, embedTextBatch, findStaleItems,
  upsertItemEmbeddings, searchSimilarItems,
} from "../api/_lib/docai/embeddings.js";

describe("buildItemEmbedSource", () => {
  it("joins all available fields with pipes", () => {
    const out = buildItemEmbedSource({ part_no: "THB-1", description: "Bend adapter", alias: "BA" });
    expect(out).toContain("THB-1");
    expect(out).toContain("Bend adapter");
    expect(out).toContain("BA");
  });
  it("filters out null + empty fields", () => {
    expect(buildItemEmbedSource({ part_no: "X", description: null })).toBe("X");
  });
  it("truncates to 1024 chars", () => {
    const big = "x".repeat(2000);
    expect(buildItemEmbedSource({ description: big }).length).toBeLessThanOrEqual(1024);
  });
  it("returns '' on null", () => {
    expect(buildItemEmbedSource(null)).toBe("");
  });
});

describe("embedTextBatch", () => {
  it("returns null on empty input", async () => {
    expect(await embedTextBatch([], { embedFn: () => ({ ok: true, embeddings: [] }) })).toBeNull();
  });
  it("returns null when no embedFn", async () => {
    expect(await embedTextBatch(["x"], {})).toBeNull();
  });
  it("returns embeddings when embedFn succeeds", async () => {
    const embedFn = vi.fn().mockResolvedValue({ ok: true, embeddings: [[0.1, 0.2], [0.3, 0.4]] });
    const out = await embedTextBatch(["a", "b"], { embedFn });
    expect(out).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });
  it("returns null on embedFn failure", async () => {
    const embedFn = vi.fn().mockResolvedValue({ ok: false });
    expect(await embedTextBatch(["a"], { embedFn })).toBeNull();
  });
});

describe("findStaleItems", () => {
  it("returns items missing or with mismatched source_text", async () => {
    const items = [
      { id: "i1", part_no: "A", description: "Alpha" },
      { id: "i2", part_no: "B", description: "Beta" },
    ];
    const existing = [
      { item_id: "i1", source_text: "A | Alpha" },     // up-to-date
      { item_id: "i2", source_text: "stale" },         // stale
    ];
    const svc = {
      from: (table) => {
        const data = table === "item_master" ? items : existing;
        return {
          select: () => ({
            eq: () => ({
              limit: () => Promise.resolve({ data, error: null }),
              then: (fn) => Promise.resolve(fn({ data, error: null })),
            }),
          }),
        };
      },
    };
    const out = await findStaleItems(svc, "t1");
    const ids = out.map((x) => x.id);
    expect(ids).toContain("i2");
    expect(ids).not.toContain("i1");
  });
});

describe("upsertItemEmbeddings", () => {
  it("returns ok=false when no embedFn", async () => {
    const out = await upsertItemEmbeddings({}, "t1", [{ id: "x", description: "Foo" }], null);
    expect(out.ok).toBe(false);
  });

  it("upserts after embedding in batches", async () => {
    let upserts = 0;
    const svc = {
      from: () => ({
        upsert: (rows) => {
          upserts += rows.length;
          return Promise.resolve({ error: null });
        },
      }),
    };
    const embedFn = vi.fn().mockImplementation((texts) =>
      Promise.resolve({ ok: true, embeddings: texts.map(() => [0.1, 0.2, 0.3]) }),
    );
    const items = Array.from({ length: 5 }, (_, i) => ({ id: "i" + i, description: "Item " + i }));
    const out = await upsertItemEmbeddings(svc, "t1", items, embedFn);
    expect(out.ok).toBe(true);
    expect(upserts).toBe(5);
  });

  it("handles embed failures by skipping the batch", async () => {
    const svc = { from: () => ({ upsert: () => Promise.resolve({ error: null }) }) };
    const embedFn = vi.fn().mockResolvedValue({ ok: false });
    const out = await upsertItemEmbeddings(svc, "t1", [{ id: "x", description: "Foo" }], embedFn);
    expect(out.written).toBe(0);
  });
});

describe("searchSimilarItems", () => {
  it("returns [] on bad input", async () => {
    expect(await searchSimilarItems(null, "t", [0.1])).toEqual([]);
    expect(await searchSimilarItems({}, "t", null)).toEqual([]);
    expect(await searchSimilarItems({}, "t", [])).toEqual([]);
  });
  it("returns the rpc result", async () => {
    const svc = {
      rpc: vi.fn().mockResolvedValue({ data: [{ item_id: "i1", score: 0.95 }], error: null }),
    };
    const out = await searchSimilarItems(svc, "t1", [0.1, 0.2, 0.3]);
    expect(out.length).toBe(1);
    expect(svc.rpc).toHaveBeenCalled();
  });
  it("returns [] when rpc throws", async () => {
    const svc = { rpc: () => Promise.reject(new Error("rpc_unavailable")) };
    expect(await searchSimilarItems(svc, "t1", [0.1])).toEqual([]);
  });
});
