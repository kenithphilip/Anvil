// Tests for the useTallyBridgeStatus hook. The hook reads /api/health
// and looks up the integration entry by id. We stub AnvilBackend.health
// on window so the hook can resolve without a backend.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTallyBridgeStatus } from "./tally-status";

// `Window.AnvilBackend` is already declared in `lib/api.ts` with the
// canonical shape. We don't re-declare here; we cast on assign.

describe("useTallyBridgeStatus", () => {
  let prev: any;
  beforeEach(() => { prev = (window as any).AnvilBackend; });
  afterEach(() => { (window as any).AnvilBackend = prev; });

  it("returns configured: true when /api/health reports tally configured", async () => {
    (window as any).AnvilBackend = (window as any).AnvilBackend = {
      isReady: () => true,
      health: vi.fn().mockResolvedValue({
        integrations: [
          { id: "tally", configured: true },
          { id: "clamav", configured: false },
        ],
      }),
    };
    const { result } = renderHook(() => useTallyBridgeStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("returns configured: false when tally is not configured", async () => {
    (window as any).AnvilBackend = (window as any).AnvilBackend = {
      isReady: () => true,
      health: vi.fn().mockResolvedValue({
        integrations: [{ id: "tally", configured: false }],
      }),
    };
    const { result } = renderHook(() => useTallyBridgeStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(false);
  });

  it("returns configured: false and stores the error when /api/health rejects", async () => {
    (window as any).AnvilBackend = (window as any).AnvilBackend = {
      isReady: () => true,
      health: vi.fn().mockRejectedValue(new Error("Backend down")),
    };
    const { result } = renderHook(() => useTallyBridgeStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configured).toBe(false);
    expect(result.current.error?.message).toBe("Backend down");
  });
});
