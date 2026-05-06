// Auto-generated smoke test for screens/approvals.jsx.
// Hand-edit if a screen needs a more specific assertion; the generator
// only overwrites files that match the auto-generated header below.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Approvals", () => {
  it("renders without throwing", async () => {
    const mod = await import("./approvals");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders the WSTitle and gracefully degrades when backend is unset", async () => {
    const mod = await import("./approvals");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML.toLowerCase();
    expect(html).toContain("approvals");
    // Either the loaded state shows "Pending" KPIs, or the error
    // banner offers a retry. Both are valid; assert at least one.
    const hasPendingKpi = html.includes("pending");
    const hasRetry = html.includes("retry");
    expect(hasPendingKpi || hasRetry).toBe(true);
  });
});
