// Smoke test for screens/quotes.tsx. Mirrors the pattern used by
// the other list screens (orders, recurring-invoices, etc.).
// Verifies the screen mounts, the tabs render, and the empty-state
// copy appears when the backend stub returns no rows.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend({
    quotes: {
      list: async () => ({ quotes: [] }),
    },
  });
  installRbac("admin");
});

describe("Quotes", () => {
  it("renders without throwing", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders the lifecycle tabs", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    // The lifecycle tabs come from the screen's TABS array.
    expect(await findByText("All")).toBeTruthy();
    expect(await findByText("Draft")).toBeTruthy();
    expect(await findByText("Sent")).toBeTruthy();
    expect(await findByText("Won")).toBeTruthy();
  });

  it("shows the empty state when the backend returns no quotes", async () => {
    const mod = await import("./quotes");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    expect(await findByText(/No quotes yet/i)).toBeTruthy();
  });
});
