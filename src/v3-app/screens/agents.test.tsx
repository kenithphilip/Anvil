// Auto-generated smoke test for screens/agents.tsx. Mirrors the pattern
// used by the other screens (anomaly, duplicates, evals).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Agents", () => {
  it("renders without throwing", async () => {
    const mod = await import("./agents");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});
