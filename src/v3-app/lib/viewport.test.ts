// Tests for the viewport hook. We resize jsdom and assert the hook
// flips isMobile across the breakpoint.

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useViewport, MOBILE_BREAKPOINT } from "./viewport";

const setWidth = (w: number) => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w, writable: true });
  window.dispatchEvent(new Event("resize"));
};

describe("useViewport", () => {
  beforeEach(() => {
    setWidth(1024);
  });

  it("reports desktop above the breakpoint", async () => {
    const { result } = renderHook(() => useViewport());
    await waitFor(() => expect(result.current.width).toBe(1024));
    expect(result.current.isMobile).toBe(false);
  });

  it("flips to mobile when innerWidth drops below the breakpoint", async () => {
    const { result } = renderHook(() => useViewport());
    act(() => { setWidth(MOBILE_BREAKPOINT - 1); });
    await waitFor(() => expect(result.current.isMobile).toBe(true));
    expect(result.current.width).toBe(MOBILE_BREAKPOINT - 1);
  });

  it("flips back to desktop when innerWidth comes back above", async () => {
    const { result } = renderHook(() => useViewport());
    act(() => { setWidth(400); });
    await waitFor(() => expect(result.current.isMobile).toBe(true));
    act(() => { setWidth(900); });
    await waitFor(() => expect(result.current.isMobile).toBe(false));
  });
});
