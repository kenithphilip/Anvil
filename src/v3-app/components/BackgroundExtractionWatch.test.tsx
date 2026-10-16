// The background extraction strip: it reads extraction_status while the
// order's job is in flight, shows real progress, calls onLanded once when the
// job completes, stops polling when the job ends, and backs off while nothing
// moves. Fake timers, so the backoff is measured, not guessed. Invented data.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { installBackend } from "../test-utils";
import { BackgroundExtractionWatch, nextDelay, POLL } from "./BackgroundExtractionWatch";

const NOW = Date.parse("2026-10-16T10:00:00Z");
const ORDER_ID = "ord-bg-1";

const inFlight = (over: any = {}, job: any = {}) => ({
  order_id: ORDER_ID, status: "idle", current_stage: "extracting chunk 3 of 5 (pages 13-18)",
  chunks_total: 5, chunks_done: 2, chunks_failed: 0, page_count: 30, line_count: null,
  last_event_at: "2026-10-16T09:59:00Z", events: [],
  job: { id: "job-1", status: "extracting", total_pages: 30, next_chunk_index: 2, created_at: "2026-10-16T09:50:00Z", ...job },
  job_in_flight: true,
  ...over,
});
const ended = (status: string, over: any = {}) => ({
  ...inFlight({ chunks_done: 5, current_stage: "done · 42 lines extracted", line_count: 42, last_event_at: "2026-10-16T10:01:00Z" }),
  job: { id: "job-1", status, total_pages: 30, next_chunk_index: 5, created_at: "2026-10-16T09:50:00Z", last_error: status === "failed" ? "all chunks failed to extract" : null },
  job_in_flight: false,
  ...over,
});

let reads: any;
let onLanded: any;

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const mount = async (sequence: any[]) => {
  let i = 0;
  reads = vi.fn(async () => sequence[Math.min(i++, sequence.length - 1)]);
  installBackend({ orders: { extractionStatus: reads } });
  onLanded = vi.fn();
  const view = render(<BackgroundExtractionWatch orderId={ORDER_ID} onLanded={onLanded} />);
  await flush(0);
  return view;
};

const strip = (c: HTMLElement) => c.querySelector("[data-testid='bg-extraction']");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe("BackgroundExtractionWatch", () => {
  it("shows nothing and stops when no job is in flight", async () => {
    const { container } = await mount([{ order_id: ORDER_ID, status: "idle", job: null, job_in_flight: false }]);
    expect(strip(container)).toBe(null);
    await flush(120000);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a job that had already finished when the order opened", async () => {
    const { container } = await mount([ended("completed")]);
    expect(strip(container)).toBe(null);
    await flush(60000);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it("shows the real stage and chunk progress of an in-flight job", async () => {
    const { container } = await mount([inFlight()]);
    expect(container.querySelector("[data-testid='bg-extraction-stage']")!.textContent)
      .toBe("Reading the full PO in the background: extracting chunk 3 of 5 (pages 13-18).");
    expect(container.querySelector("[data-testid='bg-extraction-chunks']")!.textContent).toBe("2 of 5 chunks");
    expect((container.querySelector("[data-testid='bg-extraction-bar']") as HTMLElement).style.width).toBe("40%");
    expect(strip(container)!.textContent).toContain("30 pages");
  });

  it("says how long a queued job has waited, with no made-up percentage", async () => {
    const { container } = await mount([inFlight({ chunks_total: 0, chunks_done: 0, current_stage: "idle" }, { status: "queued", created_at: "2026-10-16T09:57:00Z" })]);
    expect(container.querySelector("[data-testid='bg-extraction-stage']")!.textContent)
      .toBe("Large PO queued 3m ago. Waiting for the background worker to start.");
    expect(container.querySelector("[data-testid='bg-extraction-bar']")).toBe(null);
  });

  it("calls onLanded once when the job completes, then stops polling", async () => {
    const { container } = await mount([inFlight(), inFlight({ chunks_done: 4, last_event_at: "2026-10-16T10:00:30Z" }), ended("completed")]);
    await flush(POLL.firstMs);
    expect(container.querySelector("[data-testid='bg-extraction-chunks']")!.textContent).toBe("4 of 5 chunks");
    await flush(POLL.firstMs);
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(onLanded.mock.calls[0][0].line_count).toBe(42);
    expect(reads).toHaveBeenCalledTimes(3);
    await flush(10 * 60000);
    expect(reads).toHaveBeenCalledTimes(3);
    expect(onLanded).toHaveBeenCalledTimes(1);
  });

  it("says a failed job did not finish, keeps page 1, and stops polling", async () => {
    const { container } = await mount([inFlight(), ended("failed")]);
    await flush(POLL.firstMs);
    expect(strip(container)!.textContent).toContain("Background extraction did not finish");
    expect(strip(container)!.textContent).toContain("all chunks failed to extract. The lines from page 1 are kept. Run extraction to try again.");
    expect(onLanded).not.toHaveBeenCalled();
    await flush(10 * 60000);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("backs off while nothing moves, and speeds up again when it moves", async () => {
    // Reads 1-4 identical; read 5 moves.
    const same = inFlight();
    const moved = inFlight({ chunks_done: 3, last_event_at: "2026-10-16T10:05:00Z" });
    await mount([same, same, same, same, moved, moved]);
    expect(reads).toHaveBeenCalledTimes(1);   // t = 0
    await flush(2000);
    expect(reads).toHaveBeenCalledTimes(2);   // t = 2000 (first interval)
    await flush(2999);
    expect(reads).toHaveBeenCalledTimes(2);   // not yet: the wait grew to 3000
    await flush(1);
    expect(reads).toHaveBeenCalledTimes(3);   // t = 5000
    await flush(4500);
    expect(reads).toHaveBeenCalledTimes(4);   // t = 9500 (wait 4500)
    await flush(6750);
    expect(reads).toHaveBeenCalledTimes(5);   // t = 16250 (wait 6750); this read moved
    await flush(2000);
    expect(reads).toHaveBeenCalledTimes(6);   // back to the first interval
  });

  it("keeps the last progress and retries, slower, when a read fails mid-job", async () => {
    let i = 0;
    reads = vi.fn(async () => { i += 1; if (i === 2) throw new Error("network down"); return inFlight(); });
    installBackend({ orders: { extractionStatus: reads } });
    onLanded = vi.fn();
    const { container } = render(<BackgroundExtractionWatch orderId={ORDER_ID} onLanded={onLanded} />);
    await flush(0);
    await flush(2000);
    expect(strip(container)!.textContent).toContain("Status not read (network down). Trying again.");
    expect(container.querySelector("[data-testid='bg-extraction-chunks']")!.textContent).toBe("2 of 5 chunks");
    await flush(3000);
    expect(reads).toHaveBeenCalledTimes(3);
  });
});

describe("nextDelay", () => {
  it("grows by 1.5 up to the cap while nothing moves, and resets on movement", () => {
    expect(nextDelay(2000, false)).toBe(3000);
    expect(nextDelay(3000, false)).toBe(4500);
    expect(nextDelay(12000, false)).toBe(POLL.maxMs);
    expect(nextDelay(POLL.maxMs, false)).toBe(POLL.maxMs);
    expect(nextDelay(9000, true)).toBe(POLL.firstMs);
  });
});
