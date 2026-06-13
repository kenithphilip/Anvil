// Tests for screens/extraction-review.tsx (Wave 4.1 operator surface).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const SAMPLE = {
  queue: [
    {
      id: "q1",
      customer_id: "cust-aaaa",
      case_id: "ord-1",
      extraction_run_id: "run-1",
      reason: "low_confidence",
      severity: "high",
      preview: { customer: { name: "Tata Steel", po_number: "PO-7788" }, line_count: 12 },
      metrics: { confidence_overall: 0.42, adapter_used: "claude", voter_used: true },
      status: "open",
      created_at: new Date().toISOString(),
    },
  ],
  summary: { low: 0, medium: 0, high: 1, critical: 0, total: 1 },
};

let decideCalls = [];

beforeEach(() => {
  decideCalls = [];
  installBackend({
    docai: {
      listReviewQueue: vi.fn(async () => SAMPLE),
      reviewDecide: vi.fn(async (payload) => { decideCalls.push(payload); return { ok: true }; }),
    },
  });
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
});

describe("ExtractionReview", () => {
  it("renders without throwing", async () => {
    const mod = await import("./extraction-review");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("shows the queued row with customer, reason label, and severity", async () => {
    const mod = await import("./extraction-review");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html.toLowerCase()).toContain("extraction review");
    expect(html).toContain("Tata Steel");
    expect(html).toContain("PO-7788");
    expect(html).toContain("Low confidence"); // reason label, not raw enum
    expect(html).toContain("42%");            // confidence rendered as percent
    expect(html.toLowerCase()).toContain("voted"); // voter chip
  });

  it("renders the severity summary KPIs on the open tab", async () => {
    const mod = await import("./extraction-review");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Critical");
    expect(html).toContain("High");
  });
});
