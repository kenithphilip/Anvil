// Smoke test for the pre-auth landing screen. It must render
// without throwing even when the backend client is not yet
// configured, since this is the page a brand-new visitor sees
// before any sign-in.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Landing", () => {
  it("renders the marketing copy + auth tabs", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("Sign in");
    expect(html).toContain("Sign up");
    // Confirms the value-prop block rendered.
    expect(html.toLowerCase()).toContain("anvil");
    // New marketing sections (problem / principles / CTA) must render.
    expect(html).toContain("Re-keying");
    expect(html).toContain("Receipts over reasons");
    expect(html).toContain("Bring one PO");
  });
});
