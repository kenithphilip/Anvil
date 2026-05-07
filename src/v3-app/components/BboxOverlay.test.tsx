// Smoke test for the OCR bbox overlay. Asserts the SVG renders
// one <rect> per evidence row and the page indicator appears
// when multiple pages are present. We stub the image's
// getBoundingClientRect so the overlay's measurement effect
// produces a deterministic display box.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { BboxOverlay, OcrEvidenceRow } from "./BboxOverlay";

beforeEach(() => {
  // jsdom returns a zero-size client rect for images. Stub it so
  // the overlay sets a non-zero box and renders the SVG layer.
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width: 800, height: 1000, top: 0, left: 0, right: 800, bottom: 1000, x: 0, y: 0, toJSON: () => ({}) }),
  });
});

const row = (id: string, page: number, x0: number, y0: number, x1: number, y1: number, value: string): OcrEvidenceRow => ({
  id, page_number: page, value, confidence: 0.95,
  bbox: { x0, y0, x1, y1, page_width: 1000, page_height: 1400 },
});

describe("BboxOverlay", () => {
  it("renders one <rect> per evidence row", () => {
    const rows: OcrEvidenceRow[] = [
      row("r1", 1, 100, 200, 400, 240, "PO Number"),
      row("r2", 1, 100, 260, 600, 300, "PO12345"),
    ];
    const { container } = render(
      <BboxOverlay src="/blob/captured.png" rows={rows} />,
    );
    // The image should render even when no bboxes are present.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/blob/captured.png");
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(2);
  });

  it("hides the SVG layer entirely when no rows are provided", () => {
    const { container } = render(<BboxOverlay src="/blob/blank.png" rows={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows a page indicator when multiple pages have bboxes", () => {
    const rows: OcrEvidenceRow[] = [
      row("a", 1, 10, 10, 20, 20, "page 1 text"),
      row("b", 2, 30, 30, 40, 40, "page 2 text"),
    ];
    const { getByLabelText } = render(<BboxOverlay src="/blob/multi.png" rows={rows} />);
    expect(getByLabelText(/Page \d+ of 2/i)).toBeTruthy();
  });

  it("skips rows without a bbox without throwing", () => {
    const rows: OcrEvidenceRow[] = [
      { id: "no-bbox", page_number: 1, bbox: null, value: "ignored", confidence: 0.5 },
      row("with-bbox", 1, 10, 10, 50, 50, "kept"),
    ];
    const { container } = render(<BboxOverlay src="/blob/x.png" rows={rows} />);
    const rects = container.querySelectorAll("rect");
    expect(rects.length).toBe(1);
  });
});
