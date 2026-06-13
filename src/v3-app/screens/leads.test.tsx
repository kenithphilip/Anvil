// Auto-generated smoke test for screens/leads.jsx.
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

describe("Leads", () => {
  it("renders without throwing", async () => {
    const mod = await import("./leads");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("offers Convert to opportunity for a non-converted lead with a linked account", async () => {
    window.location.hash = "#/leads?id=lead-1";
    installBackend({ sales: { listLeads: async () => ({ leads: [
      { id: "lead-1", name: "Acme", company_name: "Acme", status: "QUALIFIED", account_id: "cust-1" },
    ] }) } });
    const mod = await import("./leads");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Convert to opportunity");
  });

  it("shows View opportunity for an already-converted lead", async () => {
    window.location.hash = "#/leads?id=lead-2";
    installBackend({ sales: { listLeads: async () => ({ leads: [
      { id: "lead-2", name: "Beta", status: "CONVERTED", converted_opportunity_id: "opp-9" },
    ] }) } });
    const mod = await import("./leads");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("View opportunity");
  });
});
