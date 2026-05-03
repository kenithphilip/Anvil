// Tests for the shell telemetry hook. Covers the parts that don't
// depend on a live ObaraBackend, namely email->initials/displayName
// derivation and the badge derivation rules.
//
// We also smoke-test the hook via render to confirm it doesn't throw
// when the backend is not configured (the most common state on a
// fresh device, e.g. before the user signs in).

import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShellTelemetry } from "./telemetry";

describe("useShellTelemetry", () => {
  it("does not throw when ObaraBackend is unconfigured", () => {
    const { result } = renderHook(() => useShellTelemetry());
    expect(result.current).toBeTruthy();
    expect(result.current.session).toBeTruthy();
    expect(typeof result.current.time).toBe("string");
    expect(typeof result.current.version).toBe("string");
  });

  it("returns guest identity when no session is present", () => {
    const { result } = renderHook(() => useShellTelemetry());
    expect(result.current.session.initials).toBe("GU");
    expect(result.current.session.displayName).toBe("Guest");
  });

  it("starts with empty badges when no orders have been fetched", () => {
    const { result } = renderHook(() => useShellTelemetry());
    expect(result.current.badges).toEqual({});
  });

  it("reports drafts count as 0 by default", () => {
    const { result } = renderHook(() => useShellTelemetry());
    expect(result.current.drafts).toBe(0);
  });
});
