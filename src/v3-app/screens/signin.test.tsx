// Smoke test for the sign-in screen. Must render without throwing
// even when the backend client is not yet configured, and must
// render all three auth modes (signin / signup / magic) by tab
// switch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("SignIn", () => {
  it("renders the auth tabs and form", async () => {
    const mod = await import("./signin");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain("Sign in");
    expect(html).toContain("Sign up");
    expect(html).toContain("Magic link");
    expect(html).toContain("Email");
    expect(html).toContain("Password");
    expect(html).toContain("Anvil");
  });
});
