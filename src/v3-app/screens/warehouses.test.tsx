import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
});

describe("Warehouses", () => {
  it("renders the warehouses screen (form + empty list)", async () => {
    const mod = await import("./warehouses");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container, getByText } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(getByText(/No warehouses yet/i)).toBeTruthy();
  });
});
