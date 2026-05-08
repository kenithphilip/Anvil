// Smoke test for screens/voice.tsx. Mounts the screen, exercises
// the empty-state copy on the calls tab, and confirms the
// outbound + consent tabs render their forms.

import { describe, it, expect, beforeEach } from "vitest";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend({
    voice: {
      listConfigs: async () => ({ configs: [] }),
      listConsent: async () => ({ rows: [] }),
    },
  });
  installRbac("admin");
});

describe("Voice", () => {
  it("renders without throwing", async () => {
    const mod = await import("./voice");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("renders the three tabs", async () => {
    const mod = await import("./voice");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    expect(await findByText("Calls")).toBeTruthy();
    expect(await findByText("Outbound")).toBeTruthy();
    expect(await findByText("Consent")).toBeTruthy();
  });

  it("shows the calls empty state when no calls are loaded", async () => {
    const mod = await import("./voice");
    const Screen = mod.default;
    const { findByText } = renderScreen(Screen);
    expect(await findByText(/No voice calls in scope yet/i)).toBeTruthy();
  });
});
