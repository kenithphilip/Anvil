// LoadingState — the loader used for work measured in tens of seconds
// (extraction runs are budgeted at 45s; a copilot answer is similar).
//
// The elapsed readout is the reason this component exists: a static
// "extracting…" gives an operator no way to tell a slow run from a wedged
// one. These tests pin the timer's correctness and the accessibility
// contract, not the visual.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { LoadingState, formatElapsed } from "./LoadingState";

afterEach(() => { vi.useRealTimers(); });

describe("formatElapsed", () => {
  it("shows tenths under a minute", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(97)).toBe("9.7s");
    expect(formatElapsed(455)).toBe("45.5s");   // the run-budget ceiling
  });
  it("switches to m + s at a minute", () => {
    expect(formatElapsed(600)).toBe("1m 0.0s");
    expect(formatElapsed(725)).toBe("1m 12.5s");
  });
});

describe("LoadingState", () => {
  it("renders the label and a zeroed timer", () => {
    const { container } = render(<LoadingState label="Extracting" />);
    expect(container.textContent).toContain("Extracting");
    expect(container.textContent).toContain("0.0s");
  });

  it("ticks from wall-clock, so a throttled/background tab cannot under-report", () => {
    // The naive implementation increments a counter every 100ms, which
    // silently loses time whenever the browser throttles the interval —
    // under-reporting exactly the long runs this component exists to make
    // legible. Deriving from Date.now() is what this asserts.
    vi.useFakeTimers();
    const t0 = 1_000_000;
    vi.setSystemTime(t0);
    const { container } = render(<LoadingState label="Extracting" />);

    // One interval fires, but 12s of wall-clock actually elapsed. A
    // counter-based implementation would read 0.1s here. Match the whole
    // second rather than the tenth — advanceTimersByTime also moves the
    // mocked clock, so the exact tenth is an artefact of the harness.
    act(() => { vi.setSystemTime(t0 + 12_000); vi.advanceTimersByTime(100); });
    expect(container.textContent).toMatch(/12\.\ds/);
    expect(container.textContent).not.toContain("0.1s");
  });

  it("is a polite live region, and the decorative grid is hidden from AT", () => {
    const { container } = render(<LoadingState label="Thinking" />);
    const status = container.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status!.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector(".px-grid")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders 9 cells; orbit leaves the centre unanimated", () => {
    const { container } = render(<LoadingState variant="orbit" />);
    const cells = container.querySelectorAll(".px-cell");
    expect(cells).toHaveLength(9);
    // Centre cell (index 4) is not on the perimeter walk.
    expect((cells[4] as HTMLElement).style.animation).toBe("");
  });

  it("dots variant rounds the cells", () => {
    const { container } = render(<LoadingState variant="dots" />);
    expect(container.querySelector(".px-grid.round")).toBeTruthy();
  });

  it("can suppress the elapsed readout for short work", () => {
    const { container } = render(<LoadingState label="Saving" showElapsed={false} />);
    expect(container.textContent).toBe("Saving");
  });

  it("clears its interval on unmount", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = render(<LoadingState />);
    unmount();
    expect(spy).toHaveBeenCalled();
  });
});
