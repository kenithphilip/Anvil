// The shell telemetry poller must not run for a signed-out visitor.
//
// app.tsx calls useShellTelemetry ABOVE its auth gate, because React hooks
// cannot be conditional. The hook polled four endpoints every 30 seconds
// forever, and three of them (/api/orders, /api/audit, /api/fx/rates) require
// a tenant context — so every anonymous visitor to the public landing page
// generated a steady stream of 401s. Measured on the live site before the fix:
// 7 rounds over 238 seconds, ~30s apart.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShellTelemetry } from "./telemetry";

const calls: string[] = [];

const backend = (session: any) => ({
  isReady: () => true,
  getSession: () => session,
  orders: { list: async () => { calls.push("orders"); return []; } },
  audit: { list: async () => { calls.push("audit"); return []; } },
  fx: { lookup: async () => { calls.push("fx"); return []; } },
  health: async () => { calls.push("health"); return { db_ok: true }; },
});

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

beforeEach(() => {
  calls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (window as any).AnvilBackend;
});

const mount = (session: any, signedIn?: boolean) => {
  (window as any).AnvilBackend = backend(session);
  return renderHook(() => useShellTelemetry(signedIn));
};

describe("useShellTelemetry does not poll while signed out", () => {
  it("makes no request at all with no session", async () => {
    mount(null, false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual([]);
  });

  it("makes no request when the caller passes signedIn=false, session or not", async () => {
    mount({ access_token: "tok", expires_at: FUTURE }, false);
    await vi.advanceTimersByTimeAsync(120_000);
    // The caller is authoritative: app.tsx's own gate decides.
    expect(calls).toEqual([]);
  });

  it("does not register a focus listener while signed out", async () => {
    const add = vi.spyOn(window, "addEventListener");
    mount(null, false);
    expect(add.mock.calls.filter((c) => c[0] === "focus")).toHaveLength(0);
    add.mockRestore();
  });
});

describe("useShellTelemetry still polls when signed in", () => {
  it("fetches immediately and then on the interval", async () => {
    mount({ access_token: "tok", expires_at: FUTURE }, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("orders");
    const first = calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.length).toBeGreaterThan(first);
  });
});

describe("the fallback when no argument is passed", () => {
  // The default must never be "poll anyway" — a caller that forgets should
  // get the safe behaviour, not the bug back.
  it("polls when the session read says a valid session exists", async () => {
    mount({ access_token: "tok", expires_at: FUTURE });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toContain("orders");
  });

  it("stays silent when there is no session", async () => {
    mount(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
  });

  it("stays silent when the token has expired", async () => {
    mount({ access_token: "tok", expires_at: PAST });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
  });
});
