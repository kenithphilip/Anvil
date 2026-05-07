// Smoke test for DocCropper. The component depends on browser
// APIs (Image, URL.createObjectURL, canvas) that jsdom only
// partially implements; we stub the missing pieces and assert
// the dialog mounts + close button calls onCancel without
// exercising the full homography-solve path.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { DocCropper } from "./DocCropper";

const makeImageFile = () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG header
  return new File([bytes], "capture.png", { type: "image/png" });
};

beforeEach(() => {
  // jsdom does not implement URL.createObjectURL / revokeObjectURL.
  // The component invokes both inside the image-load effect; without
  // stubs the render throws before we can assert anything.
  if (!(URL as any).createObjectURL) {
    (URL as any).createObjectURL = vi.fn(() => "blob:mock");
  }
  if (!(URL as any).revokeObjectURL) {
    (URL as any).revokeObjectURL = vi.fn();
  }
});

describe("DocCropper", () => {
  it("mounts the modal dialog and cancels on close", () => {
    const onCancel = vi.fn();
    const onCropped = vi.fn();
    const { getByLabelText, getByText } = render(
      <DocCropper file={makeImageFile()} onCancel={onCancel} onCropped={onCropped} />,
    );
    expect(getByText(/Crop the document/i)).toBeTruthy();
    fireEvent.click(getByLabelText(/Cancel crop/i));
    expect(onCancel).toHaveBeenCalled();
    expect(onCropped).not.toHaveBeenCalled();
  });

  it("renders four corner handles", () => {
    const { getAllByRole } = render(
      <DocCropper file={makeImageFile()} onCancel={() => undefined} onCropped={() => undefined} />,
    );
    // Each corner handle is a <button>; the dialog also has the
    // close + Cancel + "Crop and use" buttons. We assert at least
    // the 4 corner aria-labels exist.
    const labels = ["top-left corner", "top-right corner", "bottom-right corner", "bottom-left corner"];
    for (const lbl of labels) {
      const buttons = getAllByRole("button").filter((b) => b.getAttribute("aria-label") === lbl);
      expect(buttons.length).toBe(1);
    }
  });
});
