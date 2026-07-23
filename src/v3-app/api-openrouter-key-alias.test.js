// OpenRouter key resolution.
//
// The Vercel project sets `open_router`, but every read site used
// OPENROUTER_API_KEY. The mismatch was silent: isConfigured() returned false,
// so the dispatcher recorded `skipped_not_configured` and moved on — a paid key
// configured but never used, with nothing in the diagnostics to say so.

import { describe, it, expect, afterEach } from "vitest";
import { openRouterApiKey, isOpenRouterConfigured } from "../api/_lib/openrouter.js";
import { isConfigured as adapterIsConfigured } from "../api/_lib/docai/openrouter.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

describe("openRouterApiKey", () => {
  it("prefers the canonical OPENROUTER_API_KEY", () => {
    process.env.OPENROUTER_API_KEY = "canonical";
    process.env.open_router = "alias";
    expect(openRouterApiKey()).toBe("canonical");
  });

  it("falls back to the `open_router` alias the deployment sets", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.open_router = "alias";
    expect(openRouterApiKey()).toBe("alias");
  });

  it("returns null when neither is set", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.open_router;
    expect(openRouterApiKey()).toBeNull();
  });
});

describe("configured checks agree with the resolver", () => {
  it("the adapter reports configured when only the alias is set", () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.open_router = "alias";
    // Both were false before the fix, so the adapter was skipped silently.
    expect(isOpenRouterConfigured()).toBe(true);
    expect(adapterIsConfigured({})).toBe(true);
  });

  it("both report unconfigured when no key exists", () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.open_router;
    expect(isOpenRouterConfigured()).toBe(false);
    expect(adapterIsConfigured({})).toBe(false);
  });
});
