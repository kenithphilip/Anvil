// Behaviour tests for the pre-auth landing screen. Asserts the full
// Landing.html section set renders, plus interactive surfaces work:
// connector tab switching, FAQ accordion expand/collapse, mobile
// hamburger menu toggle.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
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
    // Hero spec strip , grounded counts now (17 ERPs, 20 rules, 5 channels, 100% audit)
    expect(html).toContain("ERPs");
    expect(html).toContain("Anomaly rules");
    // Shipping integrations marquee
    expect(html).toContain("Currently shipping integrations");
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
    // Pricing tiers (May 2026 base + included + overage model;
    // see docs/PRICING_STRATEGY.md).
    expect(html).toContain("For single-shop");
    expect(html).toContain("For 2-5 locations");
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
    expect(html.toLowerCase()).toContain("all systems operational");
  });

  it("connector tab switching renders different categories", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    // Default tab = ERPs (index 0); shows "SAP S/4HANA" tile
    expect(container.innerHTML).toContain("SAP S/4HANA");
    // Click the "Channels" tab
    const tabs = container.querySelectorAll(".lp-con-tab");
    expect(tabs.length).toBe(6);
    fireEvent.click(tabs[1] as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("WhatsApp");
    expect(container.innerHTML).toContain("Twilio");
    // Click "Doc AI"
    fireEvent.click(tabs[2] as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Anthropic Claude");
    expect(container.innerHTML).toContain("Mistral OCR");
  });

  it("renders 6 connector tabs and 18 ERP tiles by default", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    const tabs = container.querySelectorAll(".lp-con-tab");
    expect(tabs.length).toBe(6);
    const tiles = container.querySelectorAll(".lp-con-cell");
    expect(tiles.length).toBe(18);
  });

  it("renders all 19 design sections (h1 + 18 section h2/h3)", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    // Spec sections in source order: hero (h1) + logos + sec + connectors
    // + bleed + problem + product + flow + founder + proof + coverage
    // + principles + pricing + compare + changelog + faq + cta
    const html = container.innerHTML;
    const headlines = [
      "Your customer wrote",
      "Currently shipping integrations",
      "Built for finance teams",
      "Already speaks",
      "42 surfaces",
      "22 minutes",
      "Three things, on every order",
      "voucher at",
      "Kenith Philip",
      "audit packets",
      "One job",
      "keep Anvil",
      "Pay per",
      "A focused tool beats",
      "ship",
      "finance teams",
      "Bring one PO",
    ];
    headlines.forEach((h) => expect(html).toContain(h));
  });

  it("hero CTAs and connectors link to #/signin and section anchors", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    const signinLinks = container.querySelectorAll('a[href="#/signin"]');
    expect(signinLinks.length).toBeGreaterThanOrEqual(3);
    const ctaLinks = container.querySelectorAll('a[href="#cta"]');
    expect(ctaLinks.length).toBeGreaterThanOrEqual(2);
  });

  it("FAQ accordion has 8 items and the first is open by default", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    const details = container.querySelectorAll(".lp-q");
    expect(details.length).toBe(8);
    expect((details[0] as HTMLDetailsElement).open).toBe(true);
    expect((details[1] as HTMLDetailsElement).open).toBe(false);
  });

  // Regression: the landing has 7 `.reveal` blocks (problem intro,
  // problem list, product header, flow, proof, coverage,
  // principles). CSS sets these to opacity:0 only when the .lp root
  // has class `js-reveal-ready`. Without the reveal observer in
  // landing.tsx, every section header rendered as a giant invisible
  // rectangle. This test pins the contract: either `.in` is on every
  // block (observer or reduced-motion path) or the `.lp` root never
  // gains `js-reveal-ready` (so CSS leaves them visible).
  it("every .reveal block is visible (no permanent invisible blocks)", async () => {
    const mod = await import("./landing");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    // Wait a microtask for the reveal effect to run.
    await new Promise((r) => setTimeout(r, 0));
    const all = container.querySelectorAll(".lp .reveal");
    expect(all.length).toBeGreaterThanOrEqual(7);
    const root = container.querySelector(".lp");
    const gated = !!root?.classList.contains("js-reveal-ready");
    if (gated) {
      all.forEach((el) => {
        expect(el.classList.contains("in")).toBe(true);
      });
    }
  });
});
