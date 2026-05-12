// Unit tests for src/api/_lib/docai/stream.js (Wave 4.2).

import { describe, it, expect, vi } from "vitest";
import { createSseStream, wrapEventSinkForSse, __test } from "../api/_lib/docai/stream.js";

const makeFakeRes = () => {
  const writes = [];
  let ended = false;
  return {
    headers: {},
    setHeader: vi.fn(function (k, v) { this.headers[k] = v; }),
    write: vi.fn((chunk) => writes.push(chunk)),
    end: vi.fn(() => { ended = true; }),
    writes,
    ended: () => ended,
  };
};

describe("__test.formatEvent", () => {
  it("formats with event line + JSON data", () => {
    const out = __test.formatEvent("chunk_done", { index: 3 });
    expect(out).toContain("event: chunk_done");
    expect(out).toContain('data: {"index":3}');
    expect(out.endsWith("\n\n")).toBe(true);
  });
  it("encodes null data", () => {
    expect(__test.formatEvent("done")).toContain("data: null");
  });
});

describe("createSseStream", () => {
  it("requires an Express-like response", () => {
    expect(() => createSseStream(null)).toThrow();
  });

  it("sets the SSE headers on first write", () => {
    const res = makeFakeRes();
    const stream = createSseStream(res);
    stream.write({ type: "start", data: { ok: true } });
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream; charset=utf-8");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache, no-transform");
    expect(res.writes.length).toBe(1);
    stream.close();
  });

  it("emits a final 'done' event on close + ends the response", () => {
    const res = makeFakeRes();
    const stream = createSseStream(res);
    stream.write({ type: "chunk_done", data: { i: 1 } });
    stream.close({ ok: true });
    expect(res.ended()).toBe(true);
    expect(res.writes.some((w) => w.includes("event: done"))).toBe(true);
  });

  it("emits an 'error' event with the supplied detail", () => {
    const res = makeFakeRes();
    const stream = createSseStream(res);
    stream.error({ message: "upstream timeout" });
    expect(res.writes.some((w) => w.includes("event: error"))).toBe(true);
    stream.close();
  });

  it("is closed after .close() and subsequent writes are no-ops", () => {
    const res = makeFakeRes();
    const stream = createSseStream(res);
    stream.close();
    expect(stream.isClosed()).toBe(true);
    const before = res.writes.length;
    stream.write({ type: "ignored", data: {} });
    expect(res.writes.length).toBe(before);
  });
});

describe("wrapEventSinkForSse", () => {
  it("forwards events to the SSE stream", () => {
    const res = makeFakeRes();
    const stream = createSseStream(res);
    const sink = wrapEventSinkForSse(stream, null);
    sink({ stage: "chunking_started", page_count: 10 });
    expect(res.writes.some((w) => w.includes("event: chunking_started"))).toBe(true);
    stream.close();
  });

  it("strips heavy fields before forwarding", () => {
    const res = makeFakeRes();
    const stream = createSseStream(res);
    const sink = wrapEventSinkForSse(stream, null);
    sink({ stage: "ocr_done", page_breakdown: Array.from({ length: 50 }, (_, i) => ({ page: i })) });
    const written = res.writes.find((w) => w.includes("event: ocr_done"));
    expect(written).toBeDefined();
    expect(written).not.toContain("page_breakdown");
    stream.close();
  });

  it("invokes the fallback even when stream is closed", () => {
    const fallback = vi.fn();
    const sink = wrapEventSinkForSse({ isClosed: () => true, write: vi.fn() }, fallback);
    sink({ stage: "x" });
    expect(fallback).toHaveBeenCalled();
  });
});
