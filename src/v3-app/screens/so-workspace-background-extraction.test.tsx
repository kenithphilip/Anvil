// A large PO's lines come from a background job. The workspace used to show
// no progress for it and never refreshed when the lines landed. It now reads
// extraction_status while the job is in flight, shows the progress, reloads
// the order when the job completes, and then stops reading. Fake timers.
// Invented fixtures.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const ORDER_ID = "ord-bgws-1";
const line = (n: number) => ({ partNumber: "BG-" + n, description: "Part " + n, qty: 1, rate: 10, uom: "NOS" });
const order = (lines: number) => ({
  id: ORDER_ID, status: "DRAFT", po_number: "PO-BG-1", customer_id: "cust-1",
  customer: { customer_name: "Background Buyer" },
  preflight_payload: { source_document_id: "doc-1" },
  documents: [{ id: "doc-1" }],
  created_at: "2026-10-16T09:00:00Z", updated_at: "2026-10-16T09:00:00Z",
  result: { salesOrder: { customer: { name: "Background Buyer" }, lineItems: Array.from({ length: lines }, (_, i) => line(i + 1)) } },
});

const status = (jobStatus: string, done: number, extra: any = {}) => ({
  order_id: ORDER_ID, status: "idle", current_stage: done < 3 ? "extracting chunk " + (done + 1) + " of 3" : "done · 3 lines extracted",
  chunks_total: 3, chunks_done: done, chunks_failed: 0, page_count: 64, line_count: done === 3 ? 3 : null,
  last_event_at: "2026-10-16T09:5" + done + ":00Z", events: [],
  job: { id: "job-1", status: jobStatus, total_pages: 64, next_chunk_index: done, created_at: "2026-10-16T09:40:00Z" },
  job_in_flight: jobStatus !== "completed",
  ...extra,
});

let mod: any;
let get: any;
let reads: any;

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeAll(async () => { mod = await import("./so-workspace"); });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-10-16T10:00:00Z"));
  installRbac("sales_engineer");
  window.location.hash = "#/so?id=" + ORDER_ID;
  // The page-1 preview first; the full PO once the job has written it back.
  let landed = false;
  get = vi.fn(async () => ({ order: order(landed ? 3 : 1) }));
  // The job's state by the (fake) clock, not by call count: React's
  // StrictMode runs the effect twice on mount.
  const T0 = Date.now();
  reads = vi.fn(async () => {
    const t = Date.now() - T0;
    const s = t < 2000 ? status("extracting", 1) : t < 4000 ? status("merging", 2) : status("completed", 3);
    if (s.job.status === "completed") landed = true;
    return s;
  });
  installBackend({
    orders: { get, extractionStatus: reads, terms: vi.fn(async () => ({ visible: false })), attachedQuotes: vi.fn(async () => ({ attached: [], other_quotes: [] })) },
    audit: { list: vi.fn(async () => []) },
    events: { list: vi.fn(async () => []) },
    cost: { breakdown: vi.fn(async () => null) },
    docai: { soProcessingMode: vi.fn(async () => ({ mode: "A" })), getRun: vi.fn(async () => null) },
  });
  (window as any).notifySuccess = vi.fn();
});

afterEach(() => { vi.useRealTimers(); });

describe("the workspace with a background job in flight", () => {
  it("shows progress, reloads the order when the lines land, then stops reading", async () => {
    const { container } = renderScreen(mod.default);
    await flush(0);
    await flush(0);
    (window as any).notifySuccess = vi.fn();   // lib/toasts installs its own on import

    // In flight: real progress, and the preview's one line.
    expect(container.querySelector("[data-testid='bg-extraction-stage']")!.textContent)
      .toBe("Reading the full PO in the background: extracting chunk 2 of 3.");
    expect(container.querySelector("[data-testid='bg-extraction-chunks']")!.textContent).toBe("1 of 3 chunks");
    expect(container.querySelector("[data-testid='lines-details'] summary")!.textContent).toContain("Lines (1)");
    expect(get).toHaveBeenCalledTimes(1);

    // The job moves.
    await flush(2000);
    expect(container.querySelector("[data-testid='bg-extraction-chunks']")!.textContent).toBe("2 of 3 chunks");

    // The job completes: the order reloads with the full line set.
    await flush(2000);
    await flush(0);
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='lines-details'] summary")!.textContent).toContain("Lines (3)");
    expect((window as any).notifySuccess).toHaveBeenCalledWith("Line items landed", "3 lines from the full PO. The order has reloaded.");

    // Polling stopped: the reloaded screen read the status once more (the
    // job is now history), and nothing reads it after that.
    const after = reads.mock.calls.length;
    await flush(10 * 60000);
    expect(reads.mock.calls.length).toBe(after);
    expect(get).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-testid='bg-extraction']")).toBe(null);
  });
});
