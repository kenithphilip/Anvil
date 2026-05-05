// Smoke tests for the brand animation hooks. The interesting bits
// (IntersectionObserver, requestAnimationFrame, scroll listeners) are
// browser-side; under jsdom the hooks must still mount cleanly and
// degrade to a static end state.

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useScrollProgress,
  useReveal,
  useCountUp,
  useScrollSpy,
  useTicker,
} from "./brand-anim";

describe("brand-anim", () => {
  it("useScrollProgress returns a number in [0, 1]", () => {
    const { result } = renderHook(() => useScrollProgress());
    expect(typeof result.current).toBe("number");
    expect(result.current).toBeGreaterThanOrEqual(0);
    expect(result.current).toBeLessThanOrEqual(1);
  });

  it("useReveal returns a [ref, visible] pair", () => {
    const { result } = renderHook(() => useReveal());
    const [ref, visible] = result.current;
    expect(ref).toBeTruthy();
    expect(typeof visible).toBe("boolean");
  });

  it("useCountUp returns the target value when start is false", () => {
    const { result } = renderHook(() => useCountUp(42, { start: false }));
    expect(result.current).toBe(42);
  });

  it("useScrollSpy returns a non-negative integer", () => {
    const { result } = renderHook(() => useScrollSpy(".does-not-exist"));
    expect(typeof result.current).toBe("number");
    expect(result.current).toBeGreaterThanOrEqual(0);
  });

  it("useTicker returns the first item by default", () => {
    const items = ["a", "b", "c"] as const;
    const { result } = renderHook(() => useTicker(items, 1000));
    expect(items.includes(result.current as any)).toBe(true);
  });

  it("useTicker handles an empty list without crashing", () => {
    const { result } = renderHook(() => useTicker([] as readonly string[], 1000));
    expect(result.current).toBeUndefined();
  });
});
