// Anvil's operators are mostly on Windows, and every keyboard hint said "⌘".
//
// The shortcuts themselves were never broken — app.tsx opens the palette on
// `(e.metaKey || e.ctrlKey)`, so Ctrl+K has always worked. What was broken was
// the LABEL, which told a Windows operator to press a key their keyboard does
// not have.

import { describe, it, expect, afterEach, vi } from "vitest";
import { isApplePlatform, modKeyLabel, shortcutLabel, shortcutAria } from "./platform";

// navigator is read-only in jsdom, so each case redefines the properties the
// detector reads, most-preferred first.
const withNavigator = (props: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(globalThis.navigator, k, { value: v, configurable: true, writable: true });
  }
};
const original = {
  userAgentData: (globalThis.navigator as any)?.userAgentData,
  platform: (globalThis.navigator as any)?.platform,
  userAgent: globalThis.navigator?.userAgent,
};
afterEach(() => { withNavigator(original as any); vi.restoreAllMocks(); });

describe("isApplePlatform", () => {
  it("prefers userAgentData.platform, the non-deprecated source", () => {
    withNavigator({ userAgentData: { platform: "macOS" }, platform: "Win32" });
    expect(isApplePlatform()).toBe(true);
  });

  it("falls back to navigator.platform when userAgentData is absent", () => {
    withNavigator({ userAgentData: undefined, platform: "MacIntel" });
    expect(isApplePlatform()).toBe(true);
  });

  it.each(["Windows", "Win32", "Linux x86_64", "Android"])("treats %s as non-Apple", (p) => {
    withNavigator({ userAgentData: { platform: p }, platform: p });
    expect(isApplePlatform()).toBe(false);
  });

  it("detects iPadOS, which reports MacIntel", () => {
    withNavigator({ userAgentData: undefined, platform: "MacIntel" });
    expect(isApplePlatform()).toBe(true);
  });

  it("falls back to the user-agent string when neither platform field is set", () => {
    withNavigator({ userAgentData: undefined, platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(isApplePlatform()).toBe(true);
  });

  // Defaulting to Ctrl is deliberate: it is the right bet for Anvil's user
  // base, and the more legible of the two when the guess is wrong.
  it("defaults to non-Apple when nothing is detectable", () => {
    withNavigator({ userAgentData: undefined, platform: "", userAgent: "" });
    expect(isApplePlatform()).toBe(false);
  });

  it("never throws when a getter blows up — the header must not go down for this", () => {
    Object.defineProperty(globalThis.navigator, "userAgentData", {
      get() { throw new Error("blocked by privacy setting"); }, configurable: true,
    });
    expect(() => isApplePlatform()).not.toThrow();
    expect(isApplePlatform()).toBe(false);
  });
});

describe("labels", () => {
  it("shows Ctrl K on Windows, not the command glyph", () => {
    withNavigator({ userAgentData: { platform: "Windows" } });
    expect(shortcutLabel("k")).toBe("Ctrl K");
    expect(modKeyLabel()).toBe("Ctrl");
    expect(shortcutLabel("k")).not.toContain("⌘");
  });

  it("keeps the Mac convention on Mac", () => {
    withNavigator({ userAgentData: { platform: "macOS" } });
    expect(shortcutLabel("k")).toBe("⌘K");
    expect(modKeyLabel()).toBe("⌘");
  });

  it("uppercases the key either way", () => {
    withNavigator({ userAgentData: { platform: "Windows" } });
    expect(shortcutLabel("k")).toBe("Ctrl K");
    withNavigator({ userAgentData: { platform: "macOS" } });
    expect(shortcutLabel("k")).toBe("⌘K");
  });

  // A screen reader reads ⌘ as "place of interest sign".
  it("spells the modifier out for assistive tech", () => {
    withNavigator({ userAgentData: { platform: "Windows" } });
    expect(shortcutAria("k")).toBe("Ctrl+K");
    withNavigator({ userAgentData: { platform: "macOS" } });
    expect(shortcutAria("k")).toBe("Command+K");
    expect(shortcutAria("k")).not.toContain("⌘");
  });
});
