// Auto-generated smoke test for screens/home.jsx.
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

describe("Home", () => {
  it("renders without throwing", async () => {
    const mod = await import("./home");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders a non-trivial layout (WSTitle / KPIs / sections)", async () => {
    const mod = await import("./home");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // The page should always at least render the page wrapper. We
    // don't assert on copy because it depends on the role injected.
    const wsTitle = container.querySelector(".ws-title");
    const wsContent = container.querySelector(".ws-content");
    expect(wsTitle || wsContent).toBeTruthy();
  });
});
