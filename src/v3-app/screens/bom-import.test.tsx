// Auto-generated smoke test for screens/bom-import.jsx.
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

describe("BomImport", () => {
  it("renders without throwing", async () => {
    const mod = await import("./bom-import");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  // Spare matrix iteration: the client fallback (used when /api/bom/parse is
  // unreachable) used to hard-code material: null and drop the column.
  it("client fallback keeps the Material column", async () => {
    const { extractItems } = await import("./bom-import");
    const { items } = extractItems([["Part No", "Part Name", " MATERIAL ", "Qty"], ["P1", "TIP", "CuCrZr", 2], ["P2", "ARM", "", 1]]);
    expect(items.map((it: any) => it.material)).toEqual(["CuCrZr", null]);
  });
});
