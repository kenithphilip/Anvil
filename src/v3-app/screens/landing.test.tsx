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
    // Stage A landing v2 sections must all render in grounded form.
    expect(html).toContain("Re-keying");                  // problem block
    expect(html).toContain("Receipts");                   // principles header
    expect(html).toContain("Bring one PO");               // CTA
    expect(html).toContain("Already speaks your stack");  // connector tabs
    expect(html).toContain("on every order");             // pillars headline
    expect(html).toContain("voucher at 10:42");           // flow timeline
    expect(html).toContain("audit packets");              // proof block
    expect(html).toContain("46 surfaces");                // coverage block
    expect(html).toContain("Anti-pattern");               // principle anti-pattern callout
    // Hero kinetic-pair part-number translation must render.
    expect(html).toContain("Your customer wrote");
    expect(html).toContain("Your ERP wants");
  });
});
