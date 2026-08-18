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
          lines: [{ line_index: 0, supplier_unit_price: 8000, supplier_currency: "USD", supplier_name: "Northwind Korea", profile_code: "granular" }],
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
    await waitFor(() => expect((getByLabelText("supplier name line 1") as HTMLInputElement).value).toBe("Northwind Korea"));
    // Operator can change the name.
    fireEvent.change(getByLabelText("supplier name line 1"), { target: { value: "Anil Steel" } });
    fireEvent.click(getByText("Save composition"));
    await waitFor(() => expect(recompute).toHaveBeenCalledTimes(1));
    const payload = recompute.mock.calls[0][0];
    expect(payload.lines[0].supplier_name).toBe("Anil Steel");
  });
});

describe("QuoteComposition — raw materials (BOM) editor", () => {
  let saveMaterials: any;
  beforeEach(() => {
    saveMaterials = vi.fn(async () => ({ bom_synced: 1, finished_parts: ["X-MEDIUM"] }));
    installBackend({
      admin: {
        listPricingProfiles: vi.fn(async () => ({ profiles: [] })),
        listPriceComposition: vi.fn(async () => ({ lines: [] })),
        listCompositionMaterials: vi.fn(async () => ({ lines: [] })),
        saveCompositionMaterials: saveMaterials,
      },
    });
  });

  it("authors a material on the selected line and syncs it to the BOM", async () => {
    const { getByText, getByLabelText } = render(<QuoteComposition lines={LINES} quoteId="q-1" />);
    fireEvent.click(getByText("X-MEDIUM"));                       // select the line
    expect(getByText(/Raw materials \(BOM\)/)).toBeTruthy();
    fireEvent.click(getByText("+ Add material"));
    fireEvent.change(getByLabelText("raw material part 1"), { target: { value: "STEEL-EN8" } });
    fireEvent.change(getByLabelText("grade 1"), { target: { value: "EN8" } });
    fireEvent.change(getByLabelText("consumption per unit 1"), { target: { value: "1.4" } });
    fireEvent.click(getByText(/Save materials/));
    await waitFor(() => expect(saveMaterials).toHaveBeenCalledTimes(1));
    const payload = saveMaterials.mock.calls[0][0];
    expect(payload.quote_id).toBe("q-1");
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({
      composition_line_index: 0, seq: 0, finished_part_no: "X-MEDIUM",
      raw_material_part_no: "STEEL-EN8", material: "EN8", consumption_per_unit: 1.4,
    });
  });

  it("seeds the editor from a saved recipe", async () => {
    installBackend({
      admin: {
        listPricingProfiles: vi.fn(async () => ({ profiles: [] })),
        listPriceComposition: vi.fn(async () => ({ lines: [] })),
        listCompositionMaterials: vi.fn(async () => ({ lines: [
          { composition_line_index: 0, seq: 0, raw_material_part_no: "STEEL-EN8", material: "EN8", consumption_per_unit: 1.4, uom: "kg" },
        ] })),
        saveCompositionMaterials: saveMaterials,
      },
    });
    const { getByText, getByLabelText } = render(<QuoteComposition lines={LINES} quoteId="q-1" />);
    await waitFor(() => {
      fireEvent.click(getByText("X-MEDIUM"));
      expect((getByLabelText("raw material part 1") as HTMLInputElement).value).toBe("STEEL-EN8");
    });
  });
});

// Navigating the per-line breakdown on a long quote.
//
// The Waterfall and Raw-materials cards render AFTER the line table, so on a
// quote with fifty lines clicking a row put the breakdown a full screen below
// the fold. The operator scrolled to the bottom, read it, scrolled back up to
// find the next row, and repeated — once per line. The table already pins its
// header and totals; the detail panel was the part still stranded.
describe("QuoteComposition — stepping through line breakdowns", () => {
  const MANY = Array.from({ length: 12 }, (_, i) => ({
    line_index: i, part_no: `PART-${i + 1}`, qty: 1,
    source_country: "O-KOREA", listed_unit_price: 100000, discount_pct: 0,
  }));

  const openFirstLine = () => {
    const view = render(<QuoteComposition lines={MANY} />);
    const cell = view.getByText("PART-1");
    fireEvent.click(cell.closest("tr")!);
    return view;
  };

  it("shows which line is open and how many there are", () => {
    const { getByText } = openFirstLine();
    expect(getByText(/line 1 of 12/i)).toBeTruthy();
  });

  it("steps to the next line without touching the table", () => {
    const { getByText, getByLabelText } = openFirstLine();
    fireEvent.click(getByLabelText("Next line"));
    expect(getByText(/line 2 of 12/i)).toBeTruthy();
    // The heading follows the selection, so the panel is never showing one
    // line's numbers under another line's title.
    expect(getByText(/Waterfall - line 2/i)).toBeTruthy();
  });

  it("steps backwards too", () => {
    const { getByText, getByLabelText } = openFirstLine();
    fireEvent.click(getByLabelText("Next line"));
    fireEvent.click(getByLabelText("Previous line"));
    expect(getByText(/line 1 of 12/i)).toBeTruthy();
  });

  it("cannot step past either end", () => {
    const { getByLabelText } = openFirstLine();
    // Already on the first line.
    expect((getByLabelText("Previous line") as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 11; i += 1) fireEvent.click(getByLabelText("Next line"));
    expect((getByLabelText("Next line") as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes the breakdown without clearing the quote", () => {
    const { getByLabelText, queryByText, getByText } = openFirstLine();
    fireEvent.click(getByLabelText("Close breakdown"));
    expect(queryByText(/Waterfall - line/i)).toBeNull();
    // The line list is still there to pick from.
    expect(getByText("PART-1")).toBeTruthy();
  });

  it("brings the breakdown into view when a line is opened", () => {
    // jsdom has no layout, so assert the call rather than the pixels.
    const spy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    try {
      openFirstLine();
      expect(spy).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});
