// Auto-generated smoke test for screens/source-pos.jsx.
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

describe("SourcePos", () => {
  it("renders without throwing", async () => {
    const mod = await import("./source-pos");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("New SPO button opens an inline create form when ?new=1 is in the hash", async () => {
    // Regression: previously the button set the hash but the
    // resolver did not handle `?new=1` and nothing rendered. The
    // screen now reads the flag and shows a creation form.
    const original = window.location.hash;
    try {
      window.location.hash = "#/spo?new=1";
      const mod = await import("./source-pos");
      const Screen = mod.default;
      const { container } = renderScreen(Screen);
      await new Promise((r) => setTimeout(r, 0));
      const html = container.innerHTML;
      expect(html).toContain("New Source PO");
      // Form fields the user listed in the bug report.
      expect(html).toContain("Parent sales order");
      expect(html).toContain("PO reference");
      expect(html).toContain("Supplier");
      expect(html).toContain("Currency");
      expect(html).toContain("Acknowledged ETA");
    } finally {
      window.location.hash = original;
    }
  });
});
