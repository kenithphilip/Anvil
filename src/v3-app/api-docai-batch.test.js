// Unit tests for src/api/_lib/docai/batch.js (Wave 5.1).

import { describe, it, expect, vi } from "vitest";
import {
  classifyDoc, planBatch, runBatch, schedulePartialResume,
} from "../api/_lib/docai/batch.js";

describe("classifyDoc", () => {
  it("classifies small short text PDFs", () => {
    expect(classifyDoc({ mime_type: "application/pdf", page_count: 2, size_bytes: 100_000 })).toBe("small");
  });
  it("classifies medium 5-20 page PDFs", () => {
    expect(classifyDoc({ mime_type: "application/pdf", page_count: 10 })).toBe("medium");
  });
  it("classifies large >20 page PDFs", () => {
    expect(classifyDoc({ mime_type: "application/pdf", page_count: 25 })).toBe("large");
  });
  it("treats images as medium (OCR needed)", () => {
    expect(classifyDoc({ mime_type: "image/jpeg" })).toBe("medium");
  });
  it("treats xlsx / docx / rtf as small (cheap text path)", () => {
    expect(classifyDoc({ mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })).toBe("small");
    expect(classifyDoc({ mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("small");
    expect(classifyDoc({ mime_type: "application/rtf" })).toBe("small");
  });
  it("treats 4MB+ PDF as medium even at low page count", () => {
    expect(classifyDoc({ mime_type: "application/pdf", page_count: 3, size_bytes: 5_000_000 })).toBe("medium");
  });
});

describe("planBatch", () => {
  it("clusters small docs up to the batch size", () => {
    const queue = Array.from({ length: 7 }, (_, i) => ({ id: i, mime_type: "application/pdf", page_count: 1 }));
    const batches = planBatch(queue, { smallBatchSize: 5 });
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBe(5);
    expect(batches[1].length).toBe(2);
  });

  it("runs medium and large docs alone", () => {
    const queue = [
      { id: 1, mime_type: "application/pdf", page_count: 30 },
      { id: 2, mime_type: "application/pdf", page_count: 1 },
      { id: 3, mime_type: "image/jpeg" },
    ];
    const batches = planBatch(queue);
    expect(batches.length).toBe(3);
    expect(batches[0]).toEqual([queue[0]]);
    expect(batches[1]).toEqual([queue[1]]);
    expect(batches[2]).toEqual([queue[2]]);
  });

  it("flushes the small buffer when a non-small doc is encountered", () => {
    const queue = [
      { id: 1, mime_type: "application/pdf", page_count: 1 },
      { id: 2, mime_type: "application/pdf", page_count: 1 },
      { id: 3, mime_type: "application/pdf", page_count: 25 },
      { id: 4, mime_type: "application/pdf", page_count: 1 },
    ];
    const batches = planBatch(queue);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(2);
    expect(batches[1].length).toBe(1);
    expect(batches[2].length).toBe(1);
  });
});

describe("runBatch", () => {
  it("processes the whole batch when budget is loose", async () => {
    const docs = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const runOne = vi.fn().mockResolvedValue({ ok: true });
    const out = await runBatch(docs, runOne, { budgetMs: 60_000, perDocBudgetMs: 100 });
    expect(out.processed.length).toBe(3);
    expect(out.remaining.length).toBe(0);
  });

  it("stops early when the deadline approaches", async () => {
    const docs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    let calls = 0;
    const runOne = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true };
    };
    const out = await runBatch(docs, runOne, { budgetMs: 60, perDocBudgetMs: 50 });
    expect(calls).toBeLessThan(4);
    expect(out.remaining.length).toBeGreaterThan(0);
  });

  it("records errors without stopping the batch", async () => {
    const docs = [{ id: 1 }, { id: 2 }];
    const runOne = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ ok: true });
    const out = await runBatch(docs, runOne, { budgetMs: 60_000, perDocBudgetMs: 100 });
    expect(out.processed.length).toBe(1);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0].error).toBe("boom");
  });

  it("returns empty on no docs or no runOne", async () => {
    expect((await runBatch([], () => {})).processed).toEqual([]);
    expect((await runBatch([{ id: 1 }], null)).processed).toEqual([]);
  });
});

describe("schedulePartialResume", () => {
  it("returns deferred=0 on empty remaining", async () => {
    const out = await schedulePartialResume({}, []);
    expect(out.ok).toBe(true);
    expect(out.deferred).toBe(0);
  });

  it("updates the priority on each remaining doc id", async () => {
    let payload = null;
    let inIds = null;
    const svc = {
      from: () => ({
        update: (vals) => {
          payload = vals;
          return {
            in: (col, ids) => {
              inIds = ids;
              return Promise.resolve({ error: null });
            },
          };
        },
      }),
    };
    const out = await schedulePartialResume(svc, [{ id: "a" }, { id: "b" }]);
    expect(out.ok).toBe(true);
    expect(out.deferred).toBe(2);
    expect(payload.auto_ocr_priority).toBe("high");
    expect(inIds).toEqual(["a", "b"]);
  });
});
