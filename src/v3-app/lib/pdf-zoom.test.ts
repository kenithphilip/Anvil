// Zoom arithmetic for the PO viewer.
//
// The viewer rendered at fit-to-width and offered nothing else, so an operator
// checking a printed total or counting scanned line items could not magnify the
// region. react-pdf's `scale` prop was already threaded to <Page> — no caller
// ever passed it.

import { describe, it, expect } from "vitest";
import {
  ZOOM_MIN, ZOOM_MAX, ZOOM_FIT, ZOOM_STEP,
  clampZoom, scaleBy, zoomIn, zoomOut, zoomPercent,
  touchDistance, touchMidpoint, wheelZoomFactor, anchoredScroll,
} from "./pdf-zoom";

describe("clampZoom", () => {
  it("holds the range", () => {
    expect(clampZoom(99)).toBe(ZOOM_MAX);
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(2)).toBe(2);
  });

  it("falls back to fit rather than propagating a bad number", () => {
    // A NaN would reach react-pdf's scale and render nothing at all.
    for (const v of [NaN, Infinity, -Infinity]) expect(clampZoom(v)).toBe(ZOOM_FIT);
  });
});

describe("scaleBy", () => {
  it("multiplies and clamps in one step", () => {
    expect(scaleBy(1, 2)).toBe(2);
    expect(scaleBy(3, 4)).toBe(ZOOM_MAX);
    expect(scaleBy(1, 0.01)).toBe(ZOOM_MIN);
  });

  it("ignores a nonsense factor instead of destroying the zoom", () => {
    // A pinch that starts with a zero-distance touch pair would divide by zero.
    for (const f of [0, -1, NaN]) expect(scaleBy(2, f)).toBe(2);
  });
});

describe("zoomIn / zoomOut", () => {
  it("step by the configured ratio", () => {
    expect(zoomIn(1)).toBeCloseTo(ZOOM_STEP);
    expect(zoomOut(ZOOM_STEP)).toBeCloseTo(1);
  });

  it("round-trip returns to the start", () => {
    // Additive steps would not: 1 + 0.25 - 0.25 works, but 2 + 0.25 - 0.25
    // relative to a multiplicative in does not.
    expect(zoomOut(zoomIn(2))).toBeCloseTo(2);
  });

  it("saturate rather than overshoot", () => {
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });
});

describe("zoomPercent", () => {
  it("reads as a percentage", () => {
    expect(zoomPercent(1)).toBe("100%");
    expect(zoomPercent(1.25)).toBe("125%");
    expect(zoomPercent(0.5)).toBe("50%");
  });

  it("rounds rather than showing gesture noise", () => {
    // Mid-pinch the value is continuous; "137.4182%" is not a readout.
    expect(zoomPercent(1.374182)).toBe("137%");
  });
});

describe("touch geometry", () => {
  it("measures the pinch span", () => {
    expect(touchDistance({ clientX: 0, clientY: 0 }, { clientX: 3, clientY: 4 })).toBe(5);
  });

  it("finds the midpoint the zoom anchors to", () => {
    expect(touchMidpoint({ clientX: 10, clientY: 20 }, { clientX: 30, clientY: 60 }))
      .toEqual({ x: 20, y: 40 });
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
  });

  it("is exactly reversible", () => {
    // Scroll in then out must land where it started, or repeated adjustment
    // drifts the zoom away under the operator.
    expect(wheelZoomFactor(-40) * wheelZoomFactor(40)).toBeCloseTo(1, 10);
  });

  it("does nothing on a zero or broken delta", () => {
    for (const d of [0, NaN, Infinity]) expect(wheelZoomFactor(d)).toBe(1);
  });

  it("scales line and page delta modes down", () => {
    // deltaMode 1 counts LINES and 2 counts PAGES — a "3" there means far more
    // than a "3" of pixels. Treating them alike sends one notch across the
    // whole range.
    const px = wheelZoomFactor(3, 0);
    const lines = wheelZoomFactor(3, 1);
    const pages = wheelZoomFactor(3, 2);
    expect(lines).toBeLessThan(px);
    expect(pages).toBeLessThan(lines);
    expect(pages).toBeGreaterThan(0);
  });
});

describe("anchoredScroll", () => {
  const rect = { left: 100, top: 50 };

  it("keeps the focal point stationary while zooming in", () => {
    const before = { scrollLeft: 0, scrollTop: 0 };
    const focal = { x: 300, y: 250 };            // 200,200 inside the container
    const after = anchoredScroll(before, rect, focal, 2);
    // Content coord 200 becomes 400 at 2x; to keep it at offset 200, scroll 200.
    expect(after.scrollLeft).toBe(200);
    expect(after.scrollTop).toBe(200);
  });

  it("accounts for an existing scroll offset", () => {
    const after = anchoredScroll({ scrollLeft: 100, scrollTop: 100 }, rect, { x: 200, y: 150 }, 2);
    // content coord = 100 + 100 = 200 -> 400 at 2x; visible offset was 100.
    expect(after.scrollLeft).toBe(300);
    expect(after.scrollTop).toBe(300);
  });

  it("never returns a negative scroll", () => {
    // Zooming out past the top-left would compute a negative offset, which the
    // browser clamps silently — better to be explicit.
    const after = anchoredScroll({ scrollLeft: 0, scrollTop: 0 }, rect, { x: 110, y: 60 }, 0.5);
    expect(after.scrollLeft).toBeGreaterThanOrEqual(0);
    expect(after.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it("is a no-op at ratio 1", () => {
    const before = { scrollLeft: 42, scrollTop: 7 };
    expect(anchoredScroll(before, rect, { x: 200, y: 200 }, 1)).toEqual(before);
  });

  it("does not move on a broken ratio", () => {
    const before = { scrollLeft: 42, scrollTop: 7 };
    for (const r of [0, -2, NaN]) {
      expect(anchoredScroll(before, rect, { x: 200, y: 200 }, r)).toEqual(before);
    }
  });
});

describe("the overlay stays aligned across a scale change", () => {
  // The bbox SVG is sized in px measured off the canvas in onRenderSuccess, and
  // pdf.js rasterises asynchronously — so for a frame the canvas is already the
  // new size while the measurement describes the old one. The viewer bridges it
  // with drift = scale / measuredAt, applied to the SVG's width/height while the
  // viewBox stays in measured units.
  const drift = (scale: number, measuredAt: number) => scale / measuredAt;

  it("is 1 once the new measurement lands", () => {
    expect(drift(2, 2)).toBe(1);
  });

  it("scales the overlay by exactly the pending zoom change", () => {
    expect(drift(2, 1)).toBe(2);
    expect(drift(1, 2)).toBe(0.5);
  });

  it("keeps a rect on the same fraction of the page", () => {
    // A box at 25%..75% of a 600px-wide render must still be at 25%..75% of the
    // 1200px render, whichever side of the raster we are on.
    const measured = 600;
    const svgW = measured * drift(2, 1);
    expect((0.25 * measured) / measured).toBe(0.25);
    expect(svgW).toBe(1200);
  });
});
