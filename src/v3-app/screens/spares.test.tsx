// Auto-generated smoke test for screens/spares.jsx.
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

describe("Spares", () => {
  it("renders without throwing", async () => {
    const mod = await import("./spares");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("loads matrices from the server and renders the selected matrix (PR2a cutover)", async () => {
    installBackend({
      customers: { list: async () => [{ id: "c1", customer_name: "Hyundai Pune" }] },
      spareMatrix: {
        list: async () => ({ matrices: [{ id: "m1", customer_id: "c1", project_name: "Pune", name: "Hyundai Pune Servo", updated_at: "2026-01-23T00:00:00Z" }] }),
        get: async () => ({
          matrix: { id: "m1", customer_id: "c1", project_name: "Pune", name: "Hyundai Pune Servo" },
          columns: [{ id: "col1", col_name: "CAP TIP", category: "Consumable", locked: false }],
          rows: [{ id: "r1", gun_no: "SRTX-K16792", qty: 1, spare_values: { "CAP TIP": "4-TP2109-1" } }],
          recommended: [],
        }),
        update: async () => ({}),
      },
    });
    const mod = await import("./spares");
    const { container } = renderScreen(mod.default);
    // Tick for list load, then for the active-matrix get().
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("Hyundai Pune Servo"); // rail header from server list
    expect(html).toContain("CAP TIP");            // spare-category column from the loaded matrix
  });
});
