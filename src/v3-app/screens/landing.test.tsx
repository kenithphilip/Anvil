// Smoke test for the pre-auth landing screen. It must render
// without throwing even when the backend client is not yet
// configured, since this is the page a brand-new visitor sees
// before any sign-in. After the v3 redesign the inline auth widget
// moved to /signin (covered by signin.test.tsx); this test now
// covers the full Landing.html section set.

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
  it("renders the full v3 marketing landing", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html.length).toBeGreaterThan(0);
    expect(html.toLowerCase()).toContain("anvil");
    // Sign in CTAs must point to the dedicated /signin route.
    expect(html).toContain("#/signin");
    // Hero (kinetic part-number translation)
    expect(html).toContain("Your customer wrote");
    expect(html).toContain("Your ERP wants");
    // Hero spec strip cells
    expect(html).toContain("PO → voucher");
    expect(html).toContain("Anomalies caught");
    // Logos marquee
    expect(html).toContain("Currently piloting with");
    // Security strip
    expect(html).toContain("Built for finance teams");
    // Connector tab grid
    expect(html).toContain("Already speaks");
    // Full-bleed console preview
    expect(html).toContain("42 surfaces");
    // Problem section
    expect(html).toContain("Re-keying the PO");
    // Pillars
    expect(html).toContain("Three things, on every order");
    // Flow
    expect(html).toContain("voucher at");
    // Founder note
    expect(html).toContain("Kenith Philip");
    // Proof block
    expect(html).toContain("audit packets");
    // Coverage
    expect(html).toContain("Sales Orders");
    // Principles
    expect(html).toContain("Anti-pattern");
    // Pricing tiers
    expect(html).toContain("For pilots");
    expect(html).toContain("For real teams");
    expect(html).toContain("most pop");
    // Compare table
    expect(html).toContain("Workato");
    // Changelog
    expect(html).toContain("Anvil Network");
    // FAQ accordion
    expect(html).toContain("Where does my data live");
    // CTA
    expect(html).toContain("Bring one PO");
    // Footer
    expect(html).toContain("all systems operational");
  });
});
