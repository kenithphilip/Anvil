// Tests for the cost-composition preview: entering a supplier price
// drives the engine, and an under-cost quoted price trips the
// below-floor guardrail.

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { installBackend } from "../test-utils";
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

describe("QuoteComposition — persistence", () => {
  let recompute: any;
  beforeEach(() => {
    recompute = vi.fn(async (p: any) => ({ lines: (p.lines || []).map((l: any) => ({ ...l })) }));
    installBackend({
      admin: {
        listPricingProfiles: vi.fn(async () => ({ profiles: [] })), // -> fallback to in-code defaults
        listPriceComposition: vi.fn(async () => ({
          lines: [{ line_index: 0, supplier_unit_price: 8000, supplier_currency: "USD", supplier_name: "Obara Korea", profile_code: "granular" }],
        })),
        recomputePriceComposition: recompute,
      },
    });
  });

  it("seeds supplier inputs from a saved composition", async () => {
    const { getByLabelText } = render(<QuoteComposition lines={LINES} quoteId="q-1" />);
    await waitFor(() => expect((getByLabelText("supplier price line 1") as HTMLInputElement).value).toBe("8000"));
  });

  it("Save composition recomputes server-side with the supplier inputs", async () => {
    const { getByText, getByLabelText } = render(<QuoteComposition lines={LINES} quoteId="q-1" />);
    await waitFor(() => expect((getByLabelText("supplier price line 1") as HTMLInputElement).value).toBe("8000"));
    fireEvent.click(getByText("Save composition"));
    await waitFor(() => expect(recompute).toHaveBeenCalledTimes(1));
    const payload = recompute.mock.calls[0][0];
    expect(payload.quote_id).toBe("q-1");
    expect(payload.profile_code).toBe("granular");
    expect(payload.lines[0].supplier_unit_price).toBe(8000);
    expect(payload.lines[0].supplier_currency).toBe("USD");
  });

  it("disables Save when there is no quote id", () => {
    const { getByText } = render(<QuoteComposition lines={LINES} />);
    expect((getByText("Save composition").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("seeds and persists supplier_name per line", async () => {
    const { getByLabelText, getByText } = render(<QuoteComposition lines={LINES} quoteId="q-1" />);
    await waitFor(() => expect((getByLabelText("supplier name line 1") as HTMLInputElement).value).toBe("Obara Korea"));
    // Operator can change the name.
    fireEvent.change(getByLabelText("supplier name line 1"), { target: { value: "Anil Steel" } });
    fireEvent.click(getByText("Save composition"));
    await waitFor(() => expect(recompute).toHaveBeenCalledTimes(1));
    const payload = recompute.mock.calls[0][0];
    expect(payload.lines[0].supplier_name).toBe("Anil Steel");
  });
});
