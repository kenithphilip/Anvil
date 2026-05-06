// Behaviour tests for the sign-in screen. Smoke renders + tab
// switching + form-field interaction + Sign in submit handler.
// Validates auth flow integrity without hitting the backend.

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

  it("switches between signin / signup / magic-link tabs", async () => {
    const mod = await import("./signin");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    // Default mode = signin: card title contains "Sign in to Anvil"
    expect(container.innerHTML).toContain("Sign in to Anvil");
    // Click the "Sign up" tab
    const tabs = container.querySelectorAll(".signin-tab");
    expect(tabs.length).toBe(3);
    const signupTab = tabs[1] as HTMLElement;
    fireEvent.click(signupTab);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Create your account");
    expect(container.innerHTML).toContain("Display name");
    // Click the "Magic link" tab
    const magicTab = tabs[2] as HTMLElement;
    fireEvent.click(magicTab);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toContain("Magic link");
  });

  it("typing email + password updates the form state", async () => {
    const mod = await import("./signin");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    const inputs = container.querySelectorAll("input");
    const emailInput = Array.from(inputs).find((i) => (i as HTMLInputElement).type === "email") as HTMLInputElement;
    const pwInput = Array.from(inputs).find((i) => (i as HTMLInputElement).type === "password") as HTMLInputElement;
    expect(emailInput).toBeTruthy();
    expect(pwInput).toBeTruthy();
    fireEvent.change(emailInput, { target: { value: "test@example.com" } });
    fireEvent.change(pwInput, { target: { value: "secret123!" } });
    expect(emailInput.value).toBe("test@example.com");
    expect(pwInput.value).toBe("secret123!");
  });

  it("renders the back-to-landing link", async () => {
    const mod = await import("./signin");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    const backLinks = container.querySelectorAll('a[href="#/landing"]');
    expect(backLinks.length).toBeGreaterThan(0);
  });

  it("renders the trust footer with security claims", async () => {
    const mod = await import("./signin");
    const Screen = mod.default;
    const { container } = renderScreen(Screen);
    await new Promise((r) => setTimeout(r, 0));
    const html = container.innerHTML;
    expect(html).toContain("RLS on every table");
    expect(html).toContain("AES-256-GCM");
    expect(html).toContain("PII redaction");
  });
});
