// Auto-generated smoke test for screens/anomaly.jsx.
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

describe("Anomaly", () => {
  it("renders without throwing", async () => {
    const mod = await import("./anomaly");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("includes Findings title; tab list available when not errored", async () => {
    const mod = await import("./anomaly");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html.toLowerCase()).toContain("findings");
    // When data path errors out, the screen renders an error banner.
    // When it loads, the 4-tab WSTabs (incl. the new Rules tab) renders.
    const isError = html.toLowerCase().includes("could not load");
    if (!isError) {
      expect(html).toContain("Open");
      expect(html).toContain("Resolved");
      expect(html).toContain("Suppressed");
      expect(html).toContain("Rules");
    }
  });
});
