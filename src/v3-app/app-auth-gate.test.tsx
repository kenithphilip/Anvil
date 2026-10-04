// The auth gate has to notice when the session changes underneath it.
//
// It did not. `setRoute((r) => r)` hands React a value Object.is-equal to the
// current state, so React bails out without rendering — reliably, not
// flakily. That single line made both of its listeners inert: "anvil:session",
// which nothing in this repository's history has ever dispatched, and
// "storage", which fires for real and was the only reason the effect looked
// alive.
//
// The case it was written for and never covered: sign out in one tab and the
// other tab keeps rendering the authenticated Shell. The cross-tab listener
// further down app.tsx re-routes only when `next?.access_token` is truthy, so
// a sign-out reaches setSession(null) and stops there. Sign-IN worked, which
// is why nobody noticed.
//
// The last test is the one that makes the fix real rather than cosmetic: it
// drives the REAL client and asserts the event actually leaves it. Without a
// dispatcher, the same-tab listener is decoration.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, waitFor, cleanup } from "@testing-library/react";
import React from "react";
import App from "./app";

// Captured at module scope: test-setup.ts loads the real anvil-client before
// any beforeEach replaces window.AnvilBackend with a stub.
const realBackend = (window as { AnvilBackend?: unknown }).AnvilBackend;

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 60;
const w = window as unknown as Record<string, unknown>;

// NOT `.skip-link`, which was the obvious probe and is wrong: Landing, signin,
// the Shell and app.tsx itself each render one, so it is present signed out
// too. <main id="app-main"> is rendered only by Shell, i.e. only behind the
// gate. Worth stating because the wrong probe reported the gate open in every
// state and still let three of five tests pass.
const gateIsOpen = (c: HTMLElement) => c.querySelector("main#app-main") !== null;

// Render, then wait for the lazy Landing chunk to resolve BEFORE asserting.
// Otherwise the Suspense fallback is still up and the re-render that replaces
// it flips the gate on its own — a pass that has nothing to do with the event
// under test. The cross-tab case passed against the unfixed code exactly that
// way until this was added.
const renderSettled = async () => {
  const { container } = render(<App />);
  await waitFor(() => expect(container.textContent || "").not.toContain("Loading anvil"));
  return container;
};

describe("auth gate: a session change re-renders it", () => {
  let session: { access_token: string; expires_at: number } | null = null;

  beforeEach(() => {
    // Pin desktop: below 768 App renders MobileShell, which has no #app-main.
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    window.location.hash = "#/home";
    session = null;
    w.AnvilBackend = {
      isReady: () => true,
      getConfig: () => ({}),
      setSession: () => undefined,
      getSession: () => session,
      health: async () => ({}),
    };
  });

  afterEach(() => { cleanup(); w.AnvilBackend = realBackend; });

  // Fires for real, in other tabs, on every session write — the client's
  // writeSession mirrors to localStorage, which is what emits it.
  it("opens on a cross-tab storage event", async () => {
    const container = await renderSettled();
    expect(gateIsOpen(container)).toBe(false);

    session = { access_token: "tok", expires_at: FUTURE };
    await act(async () => { window.dispatchEvent(new Event("storage")); });

    await waitFor(() => expect(gateIsOpen(container)).toBe(true));
  });

  // "storage" never fires in the tab that performed the write — that is the
  // DOM spec — so a same-tab change needs its own event.
  it("opens on a same-tab anvil:session event", async () => {
    const container = await renderSettled();
    expect(gateIsOpen(container)).toBe(false);

    session = { access_token: "tok", expires_at: FUTURE };
    await act(async () => { window.dispatchEvent(new CustomEvent("anvil:session")); });

    await waitFor(() => expect(gateIsOpen(container)).toBe(true));
  });

  // The direction that has never worked, and the one that matters most: a
  // signed-out tab must stop rendering authenticated UI.
  it("closes when the session goes away", async () => {
    session = { access_token: "tok", expires_at: FUTURE };
    const container = await renderSettled();
    expect(gateIsOpen(container)).toBe(true);

    session = null;
    await act(async () => { window.dispatchEvent(new CustomEvent("anvil:session")); });

    await waitFor(() => expect(gateIsOpen(container)).toBe(false));
  });

  // An expired token is not a session, however recently it was written.
  it("stays closed for an expired session", async () => {
    const container = await renderSettled();
    expect(gateIsOpen(container)).toBe(false);

    session = { access_token: "tok", expires_at: PAST };
    await act(async () => { window.dispatchEvent(new CustomEvent("anvil:session")); });

    expect(gateIsOpen(container)).toBe(false);
  });
});

describe("the client dispatches anvil:session", () => {
  // Against the REAL client, not the stub. Asserts on the event rather than a
  // getSession() round-trip: this environment's localStorage has no working
  // methods, so a read-back would be testing that trap, not the dispatch.
  const backend = realBackend as { setSession?: (s: unknown) => void } | undefined;

  it("fires on a session write and on a session clear", () => {
    expect(backend?.setSession, "the real client must be loaded").toBeTypeOf("function");

    const heard = vi.fn();
    window.addEventListener("anvil:session", heard);
    try {
      backend!.setSession!({ access_token: "t", expires_at: FUTURE });
      expect(heard, "writeSession must notify").toHaveBeenCalledTimes(1);

      backend!.setSession!(null);
      expect(heard, "clearSession must notify").toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("anvil:session", heard);
    }
  });
});

// Making the gate reactive exposed two places that were quietly relying on it
// being LATE. Both were found by adversarial review of the fix, not by the
// suite, and both are regressions the fix itself introduced.
describe("a reactive gate must not yank a pre-auth screen out from under the user", () => {
  let session: { access_token: string; expires_at: number } | null = null;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    session = null;
    w.AnvilBackend = {
      isReady: () => true,
      getConfig: () => ({}),
      setSession: () => undefined,
      getSession: () => session,
      health: async () => ({}),
    };
  });

  afterEach(() => { cleanup(); w.AnvilBackend = realBackend; });

  // Sign-in writes the session and navigates 400ms later. In that window the
  // gate must NOT render the Shell around a remounted, blank sign-in form.
  it("stays on the sign-in screen when the session lands before the redirect", async () => {
    window.location.hash = "#/signin";
    const container = await renderSettled();

    session = { access_token: "tok", expires_at: FUTURE };
    await act(async () => { window.dispatchEvent(new CustomEvent("anvil:session")); });

    expect(gateIsOpen(container), "the Shell must not appear while route is still signin").toBe(false);
  });

  // A 401 on connect clears the session. The client deliberately does not
  // navigate away from connect; the gate must not do it on the client's behalf.
  it("keeps rendering connect when the session is cleared underneath it", async () => {
    window.location.hash = "#/connect";
    session = { access_token: "tok", expires_at: FUTURE };
    const container = await renderSettled();

    session = null;
    await act(async () => { window.dispatchEvent(new CustomEvent("anvil:session")); });

    // Landing is what it used to fall back to. Connect must survive instead.
    await waitFor(() => expect(gateIsOpen(container)).toBe(false));
    expect(container.textContent || "", "must not have fallen back to marketing Landing")
      .not.toContain("Skip to content");
  });
});
