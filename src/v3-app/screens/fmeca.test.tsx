import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("Fmeca", () => {
  it("renders the FMECA screen (form + empty worklist)", async () => {
    const mod = await import("./fmeca");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container, getByText } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(getByText(/FMECA criticality/i)).toBeTruthy();
    expect(getByText(/Save record/i)).toBeTruthy();
  });
});
