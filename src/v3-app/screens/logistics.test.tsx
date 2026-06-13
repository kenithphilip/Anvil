// Tests for screens/logistics.tsx (P4 freight bidding UI).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const SAMPLE = [
  {
    id: "con-1", origin: "O-KOREA", destination: "IN", window_week: "2026-06-08",
    weight_kg: 5000, volume_cbm: 40,
    containers: { fcl_40: 1, fcl_20: 0, lcl_cbm: 8, recommended_mode: "mixed" },
    status: "open",
  },
];

beforeEach(() => {
  installBackend({
    logistics: {
      listConsolidations: vi.fn(async () => ({ consolidations: SAMPLE })),
      listBids: vi.fn(async () => ({ bids: [] })),
      buildConsolidations: vi.fn(async () => ({ built: 1 })),
      addBid: vi.fn(async () => ({ bid: { id: "b-1" } })),
      awardBid: vi.fn(async () => ({})),
    },
  });
  installRbac("procurement");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
});

describe("Logistics (freight bidding)", () => {
  it("renders without throwing", async () => {
    const mod = await import("./logistics");
    expect(typeof mod.default).toBe("function");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("lists a consolidation with its lane and container estimate", async () => {
    const mod = await import("./logistics");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Freight Bidding");
    expect(html).toContain("O-KOREA → IN");
    expect(html).toContain("1×40ft");      // container fill rendered
    expect(html).toContain("LCL 8cbm");
  });
});
