import { describe, it, expect, vi, beforeEach } from "vitest";
import { signOutAndRedirect } from "./session";
import * as api from "./api";
import * as storage from "./storage-keys";

// signOutAndRedirect is a one-shot sign-out helper. The behaviour
// the test locks: it always clears the in-memory session even when
// localStorage is sealed off, removes the cached auth profile + the
// intended-route key, and bounces to #/landing.

describe("signOutAndRedirect", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    if (typeof window !== "undefined") {
      window.location.hash = "#/somewhere";
    }
  });

  it("calls AnvilBackend.setSession(null) and clears the auth keys", () => {
    const setSession = vi.fn();
    const lsRemove = vi.spyOn(storage, "lsRemove").mockImplementation(() => undefined);
    Object.defineProperty(api, "AnvilBackend", {
      configurable: true,
      get: () => ({ setSession }),
    });
    signOutAndRedirect();
    expect(setSession).toHaveBeenCalledWith(null);
    expect(lsRemove).toHaveBeenCalledWith("auth_profile");
    expect(lsRemove).toHaveBeenCalledWith("v3_intended_route");
  });

  it("redirects to the marketing landing", () => {
    Object.defineProperty(api, "AnvilBackend", {
      configurable: true,
      get: () => ({ setSession: () => undefined }),
    });
    vi.spyOn(storage, "lsRemove").mockImplementation(() => undefined);
    signOutAndRedirect();
    expect(window.location.hash).toBe("#/landing");
  });

  it("survives a sealed-off localStorage without throwing", () => {
    Object.defineProperty(api, "AnvilBackend", {
      configurable: true,
      get: () => ({ setSession: () => undefined }),
    });
    vi.spyOn(storage, "lsRemove").mockImplementation(() => {
      throw new Error("storage locked");
    });
    expect(() => signOutAndRedirect()).not.toThrow();
  });
});
