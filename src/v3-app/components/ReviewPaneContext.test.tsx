// Tests for ReviewPaneSelectionProvider + useReviewPaneSelection.
//
// The Provider is internal plumbing the ReviewPane.test.tsx exercises
// end-to-end. This file pins the API contract directly so a future
// Phase C / D edit can refactor the rendering pieces around it without
// re-tracing the integration test to understand the shape.

import React from "react";
import { describe, it, expect } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import {
  ReviewPaneSelectionProvider,
  useReviewPaneSelection,
} from "./ReviewPaneContext";

const Probe: React.FC<{ tag: string; observe: string }> = ({ tag, observe }) => {
  const { hoveredField, selectedField, setHoveredField, setSelectedField, isActive } =
    useReviewPaneSelection();
  return (
    <div data-testid={tag}>
      <span data-role="hovered">{hoveredField ?? "—"}</span>
      <span data-role="selected">{selectedField ?? "—"}</span>
      <span data-role="active">{isActive(observe) ? "yes" : "no"}</span>
      <button onClick={() => setHoveredField(observe)}>hover</button>
      <button onClick={() => setHoveredField(null)}>clear hover</button>
      <button onClick={() => setSelectedField(observe)}>select</button>
      <button onClick={() => setSelectedField(null)}>clear select</button>
    </div>
  );
};

const getRole = (container: HTMLElement, tag: string, role: string) =>
  container.querySelector(`[data-testid="${tag}"] [data-role="${role}"]`)?.textContent ?? "";

describe("ReviewPaneSelectionProvider", () => {
  it("starts with no hover and no selection", () => {
    const { container } = render(
      <ReviewPaneSelectionProvider>
        <Probe tag="p1" observe="customer.gstin" />
      </ReviewPaneSelectionProvider>
    );
    expect(getRole(container, "p1", "hovered")).toBe("—");
    expect(getRole(container, "p1", "selected")).toBe("—");
    expect(getRole(container, "p1", "active")).toBe("no");
  });

  it("isActive() returns true for the hovered field", () => {
    const { container } = render(
      <ReviewPaneSelectionProvider>
        <Probe tag="p1" observe="customer.gstin" />
      </ReviewPaneSelectionProvider>
    );
    fireEvent.click(container.querySelectorAll('[data-testid="p1"] button')[0]); // hover
    expect(getRole(container, "p1", "hovered")).toBe("customer.gstin");
    expect(getRole(container, "p1", "active")).toBe("yes");
  });

  it("isActive() returns true for the selected field even after hover clears", () => {
    const { container } = render(
      <ReviewPaneSelectionProvider>
        <Probe tag="p1" observe="order.po_number" />
      </ReviewPaneSelectionProvider>
    );
    const buttons = container.querySelectorAll('[data-testid="p1"] button');
    fireEvent.click(buttons[2]); // select
    fireEvent.click(buttons[1]); // clear hover (no-op for selection)
    expect(getRole(container, "p1", "hovered")).toBe("—");
    expect(getRole(container, "p1", "selected")).toBe("order.po_number");
    expect(getRole(container, "p1", "active")).toBe("yes");
  });

  it("two consumers in the same provider see the same state", () => {
    const { container } = render(
      <ReviewPaneSelectionProvider>
        <Probe tag="left" observe="totals.grand_inr" />
        <Probe tag="right" observe="totals.grand_inr" />
      </ReviewPaneSelectionProvider>
    );
    const leftButtons = container.querySelectorAll('[data-testid="left"] button');
    fireEvent.click(leftButtons[2]); // left selects
    expect(getRole(container, "left", "active")).toBe("yes");
    expect(getRole(container, "right", "active")).toBe("yes");
  });

  it("two providers are isolated from each other", () => {
    const { container } = render(
      <>
        <ReviewPaneSelectionProvider>
          <Probe tag="a" observe="customer.gstin" />
        </ReviewPaneSelectionProvider>
        <ReviewPaneSelectionProvider>
          <Probe tag="b" observe="customer.gstin" />
        </ReviewPaneSelectionProvider>
      </>
    );
    fireEvent.click(container.querySelectorAll('[data-testid="a"] button')[2]); // a selects
    expect(getRole(container, "a", "active")).toBe("yes");
    expect(getRole(container, "b", "active")).toBe("no");
  });

  it("default context (no provider) is a safe no-op", () => {
    // Without a provider the hook reads the default context value.
    // Setters must not throw, and isActive must always be false.
    const { container } = render(<Probe tag="lonely" observe="x.y" />);
    expect(() => {
      fireEvent.click(container.querySelectorAll('[data-testid="lonely"] button')[0]); // hover
      fireEvent.click(container.querySelectorAll('[data-testid="lonely"] button')[2]); // select
    }).not.toThrow();
    // Default setters are no-ops, so the displayed state stays "—" / "no".
    expect(getRole(container, "lonely", "hovered")).toBe("—");
    expect(getRole(container, "lonely", "selected")).toBe("—");
    expect(getRole(container, "lonely", "active")).toBe("no");
  });
});
