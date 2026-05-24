// Tests for the cost-composition preview: entering a supplier price
// drives the engine, and an under-cost quoted price trips the
// below-floor guardrail.

import React from "react";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { QuoteComposition } from "./QuoteComposition";

const LINES = [
  { line_index: 0, part_no: "X-MEDIUM", qty: 1, source_country: "O-KOREA", listed_unit_price: 200000, discount_pct: 0 },
];

describe("QuoteComposition", () => {
  it("renders the profile selector and an empty state with no lines", () => {
    const { getByLabelText, getByText } = render(<QuoteComposition lines={[]} />);
    expect(getByLabelText("Pricing profile")).toBeTruthy();
    expect(getByText(/No lines to price yet/i)).toBeTruthy();
  });

  it("computes a loaded cost and recommended price from a supplier price", () => {
    const { getByLabelText } = render(<QuoteComposition lines={LINES} />);
    const supInput = getByLabelText("supplier price line 1") as HTMLInputElement;
    fireEvent.change(supInput, { target: { value: "1000" } });
    // The line's row now shows the engine-computed loaded cost (~95,669).
    const row = supInput.closest("tr")!;
    expect(row.textContent || "").toMatch(/9[0-9],[0-9]{3}/);
  });

  it("flags a quoted price below the margin floor", () => {
    // listed below the computed loaded cost => negative margin => below floor.
    const cheap = [{ ...LINES[0], listed_unit_price: 80000 }];
    const { getByLabelText, getByText } = render(<QuoteComposition lines={cheap} />);
    fireEvent.change(getByLabelText("supplier price line 1"), { target: { value: "1000" } });
    expect(getByText(/below the .* margin floor/i)).toBeTruthy();
  });

  it("shows the waterfall when a line row is selected", () => {
    const { getByLabelText, getByText, container } = render(<QuoteComposition lines={LINES} />);
    fireEvent.change(getByLabelText("supplier price line 1"), { target: { value: "1000" } });
    // Click the part cell to select the row (not the inputs).
    fireEvent.click(getByText("X-MEDIUM"));
    // The granular waterfall lists named overhead steps.
    expect(getByText("Basic customs duty")).toBeTruthy();
    expect(getByText("Social welfare tax")).toBeTruthy();
  });
});
