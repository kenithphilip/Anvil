// PDM C: the manufacturing raw-material review screen. Drop a part drawing →
// extract → determine → review/correct make-buy + stock → save the recipe. A
// bought-out part is recorded with NO recipe.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const PART_SPEC = { title_block: { part_no: "SHANK-A", title: "Weld shank" }, material: "CrCu", dimensions: { diameter: 25, length: 110 }, bought_out: false };
const MAKE_VERDICT = {
  procurement_type: "make", confidence: 0.7,
  recipe: { material: "CuCrZr", material_matched: true, density: 8900, geometry_class: "rotational", form: "rod", stock_dims: { diameter: 31, length: 113 }, gross_mass_kg: 0.76, yield_pct: 0.85, consumption_per_unit_kg: 0.89, uom: "kg" },
  warnings: [],
};

const pickFile = (container: HTMLElement, name = "SHANK-A.pdf") => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["x"], name, { type: "application/pdf" })] } });
};

beforeEach(() => { installRbac("admin"); });

describe("PdmMaterial", () => {
  it("extracts → determines → shows the make verdict (material + form + stock)", async () => {
    const extract = vi.fn(async () => ({ status: "ok", normalized: { part_spec: PART_SPEC } }));
    const determineRawMaterial = vi.fn(async () => ({ dry_run: true, finished_part_no: "SHANK-A", verdict: MAKE_VERDICT }));
    installBackend({ documents: { extract }, pdm: { determineRawMaterial, saveRawMaterial: vi.fn() } });

    const mod = await import("./pdm-material");
    const { container, getByText, getByDisplayValue } = renderScreen(mod.default);
    pickFile(container);

    await waitFor(() => expect(getByText("CuCrZr")).toBeTruthy());
    expect(extract).toHaveBeenCalledWith(expect.any(File), { kind: "part_drawing" });
    expect(determineRawMaterial).toHaveBeenCalled();
    expect(getByText("rod")).toBeTruthy();                 // form
    expect(getByText(/Ø31/)).toBeTruthy();                 // stock size
    expect(getByDisplayValue("SHANK-A")).toBeTruthy();     // finished part prefilled
  });

  it("saves the reviewed make verdict via pdm.saveRawMaterial", async () => {
    const saveRawMaterial = vi.fn(async () => ({ committed: true, procurement_type: "make", raw_material_part_no: "RM-CUCRZR-ROD", recipe_saved: true }));
    installBackend({
      documents: { extract: vi.fn(async () => ({ status: "ok", normalized: { part_spec: PART_SPEC } })) },
      pdm: { determineRawMaterial: vi.fn(async () => ({ verdict: MAKE_VERDICT })), saveRawMaterial },
    });
    const mod = await import("./pdm-material");
    const { container, getByText } = renderScreen(mod.default);
    pickFile(container);
    await waitFor(() => expect(getByText("CuCrZr")).toBeTruthy());

    fireEvent.click(getByText(/Save recipe/i));
    await waitFor(() => expect(saveRawMaterial).toHaveBeenCalledWith("SHANK-A", expect.objectContaining({ procurement_type: "make" })));
    await waitFor(() => expect(getByText(/Saved SHANK-A as make/i)).toBeTruthy());
    expect(getByText("RM-CUCRZR-ROD")).toBeTruthy();
  });

  it("marking Buy drops the recipe and saves as bought-out (no raw material)", async () => {
    const saveRawMaterial = vi.fn(async () => ({ committed: true, procurement_type: "buy", raw_material_part_no: null, recipe_saved: false }));
    installBackend({
      documents: { extract: vi.fn(async () => ({ status: "ok", normalized: { part_spec: PART_SPEC } })) },
      pdm: { determineRawMaterial: vi.fn(async () => ({ verdict: MAKE_VERDICT })), saveRawMaterial },
    });
    const mod = await import("./pdm-material");
    const { container, getByText } = renderScreen(mod.default);
    pickFile(container);
    await waitFor(() => expect(getByText("CuCrZr")).toBeTruthy());

    fireEvent.click(getByText(/^Buy$/));
    await waitFor(() => expect(getByText(/Bought-out — no raw-material recipe/i)).toBeTruthy());
    fireEvent.click(getByText(/Save recipe/i));
    await waitFor(() => expect(saveRawMaterial).toHaveBeenCalledWith("SHANK-A", expect.objectContaining({ procurement_type: "buy", recipe: null })));
  });

  it("surfaces a non-drawing extraction instead of a verdict", async () => {
    installBackend({
      documents: { extract: vi.fn(async () => ({ status: "failed", status_reason: "non_drawing" })) },
      pdm: { determineRawMaterial: vi.fn(), saveRawMaterial: vi.fn() },
    });
    const mod = await import("./pdm-material");
    const { container, getByText } = renderScreen(mod.default);
    pickFile(container);
    await waitFor(() => expect(getByText(/wasn't recognised as a single part drawing/i)).toBeTruthy());
  });
});
