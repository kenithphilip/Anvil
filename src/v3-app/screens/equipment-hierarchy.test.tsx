// Hand-edited test for screens/equipment-hierarchy (generalized asset model,
// migration 173). NOT auto-generated -- covers the class-aware detail form on
// top of the render smoke test.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

beforeEach(() => {
  installBackend();
  installRbac("admin");
  // jsdom's confirm/alert/prompt are no-ops by default; stub them so
  // accidental click handlers can't pop dialogs during a smoke render.
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => undefined);
  vi.stubGlobal("prompt", () => null);
});

describe("EquipmentHierarchy", () => {
  it("renders without throwing", async () => {
    const mod = await import("./equipment-hierarchy");
    const Screen = mod.default;
    expect(typeof Screen).toBe("function");
    const { container } = renderScreen(Screen);
    expect(container).toBeTruthy();
    // Wait one tick so any useEffect-triggered fetches resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("New-asset form is class-aware: welding shows gun fields, others show attributes", async () => {
    const mod = await import("./equipment-hierarchy");
    const { getByRole, getByLabelText, queryByLabelText } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));

    // Open the add-asset form (defaults to welding_gun for backward compat).
    fireEvent.click(getByRole("button", { name: /New asset/i }));
    const classInput = getByLabelText("Asset class") as HTMLInputElement;
    expect(classInput.value).toBe("welding_gun");
    // Welding shows the typed gun fields, no generic name/attributes.
    expect(queryByLabelText("Gun no")).toBeTruthy();
    expect(queryByLabelText("Asset name")).toBeFalsy();

    // Switch to a non-welding class: welding fields disappear, generic ones show.
    fireEvent.change(classInput, { target: { value: "pump" } });
    expect(queryByLabelText("Asset name")).toBeTruthy();
    expect(queryByLabelText("Gun no")).toBeFalsy();

    // Trailing whitespace around the welding class must still render as welding
    // so render and save cannot disagree (regression: silent attribute drop).
    fireEvent.change(classInput, { target: { value: "welding_gun " } });
    expect(queryByLabelText("Gun no")).toBeTruthy();
    expect(queryByLabelText("Asset name")).toBeFalsy();
  });

  it("renders an existing non-welding asset by its attribute name", async () => {
    installBackend({
      admin: {
        listEquipment: async () => ({
          equipment: [
            { id: "c1", customer_id: "cust1", asset_class: "customer", label: "Acme" },
          ],
        }),
      },
    });
    const mod = await import("./equipment-hierarchy");
    const { container } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    // The screen mounts and the tree renders without throwing on a row whose
    // asset_class is not welding_gun (gun_no absent, attributes drive labeling).
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });
});
