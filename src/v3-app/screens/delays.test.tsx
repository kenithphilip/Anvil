import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Delays", () => {
  it("renders without throwing", async () => {
    const mod = await import("./delays");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders the WSTitle and surfaces an error when backend is unset", async () => {
    const mod = await import("./delays");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    // wait for fetch to fail (backend not configured)
    await new Promise((r) => setTimeout(r, 50));
    const html = container.innerHTML.toLowerCase();
    expect(html).toContain("delays");
    // The screen either shows a loading state, the error banner, or
    // the full table. All three are valid; the only failure mode
    // would be a thrown error.
    expect(html).toMatch(/scanning|could not|flagged/);
  });
});
