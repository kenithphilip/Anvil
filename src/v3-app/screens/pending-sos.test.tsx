// Auto-generated-style smoke test for screens/pending-sos.tsx.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("sales_engineer");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
  window.location.hash = "#/so?view=pending";
});

describe("PendingSalesOrders", () => {
  it("renders the customer prompt without throwing (no customer selected)", async () => {
    const mod = await import("./pending-sos");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    // Empty state renders (no customer chosen yet), never crashes.
    expect(container.textContent || "").toMatch(/customer/i);
  });
});
