// CM PDM P1c: the BOM-from-drawing screen. Upload an assembly drawing ->
// extract (kind=assembly_bom) -> review the mapped parts list + warnings ->
// commit to the BOM. Extraction is reviewed BEFORE it mutates the BOM, so the
// commit is an explicit operator action, never automatic.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const PREVIEW = {
  ok: true,
  dry_run: true,
  run_id: "run-1",
  asset: { asset_code: "GUN-77", name: "Weld Gun", revision: "B", drawing_no: "GA-1234" },
  lines: [
    { balloon_no: "1", part_no: "SHANK-A", part_name: "Shank", qty: 2, material: "EN8", is_spare: true },
    { balloon_no: "2", part_no: "TIP-9", part_name: "Electrode tip", qty: 4, material: null, is_spare: false },
  ],
  warnings: [{ code: "line_count_shortfall", message: "drawing declares 5 items; 2 importable", declared: 5, importable: 2 }],
  meta: { classification: "assembly_bom", stated_line_count: 5, extracted_line_count: 2, importable_line_count: 2, dropped_no_part_no: 0 },
};

const pickFile = (container: HTMLElement) => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["drawing bytes"], "GUN-77.pdf", { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => {
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
});

describe("BomFromDrawing", () => {
  it("renders the drop zone", async () => {
    installBackend();
    const mod = await import("./bom-from-drawing");
    const { container, getByText } = renderScreen(mod.default);
    await new Promise((r) => setTimeout(r, 0));
    expect(getByText(/assembly \(GA\) drawing/i)).toBeTruthy();
  });

  it("extracts -> previews the mapped parts list + shortfall warning", async () => {
    const extract = vi.fn(async () => ({ status: "ok", run_id: "run-1", confidence_overall: 0.9 }));
    const fromDrawing = vi.fn(async (p: any) => PREVIEW);
    installBackend({ documents: { extract }, bom: { fromDrawing } });

    const mod = await import("./bom-from-drawing");
    const { container, getByText, getByDisplayValue } = renderScreen(mod.default);
    pickFile(container);

    await waitFor(() => expect(getByText("SHANK-A")).toBeTruthy());
    // the extractor was asked for the drawing kind
    expect(extract).toHaveBeenCalledWith(expect.any(File), { kind: "assembly_bom" });
    // preview came from a dry-run (no commit) call
    expect(fromDrawing).toHaveBeenCalledWith({ run_id: "run-1" });
    // parts list + completeness warning rendered
    expect(getByText("TIP-9")).toBeTruthy();
    expect(getByText(/drawing declares 5 items/i)).toBeTruthy();
    // asset header pre-filled + editable
    expect(getByDisplayValue("GUN-77")).toBeTruthy();
  });

  it("commits the reviewed BOM only on the explicit Save action", async () => {
    const extract = vi.fn(async () => ({ status: "ok", run_id: "run-1", confidence_overall: 0.9 }));
    const fromDrawing = vi.fn(async (p: any) => (p.commit
      ? { ok: true, committed: true, run_id: "run-1", asset_id: "asset-1", lines: 2, diff: { added: 2, removed: 0, changed: 0 } }
      : PREVIEW));
    installBackend({ documents: { extract }, bom: { fromDrawing } });

    const mod = await import("./bom-from-drawing");
    const { container, getByText } = renderScreen(mod.default);
    pickFile(container);
    await waitFor(() => expect(getByText("SHANK-A")).toBeTruthy());

    // no commit happened just from previewing
    expect(fromDrawing).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText(/Save to BOM/i));
    await waitFor(() => expect(getByText(/Saved GUN-77 to the BOM/i)).toBeTruthy());

    // the commit call carried commit:true + the (editable) asset_code override
    expect(fromDrawing).toHaveBeenCalledWith(expect.objectContaining({ run_id: "run-1", commit: true, asset_code: "GUN-77" }));
    expect(getByText(/2 parts imported/i)).toBeTruthy();
  });

  it("surfaces a non-drawing extraction instead of previewing", async () => {
    const extract = vi.fn(async () => ({ status: "failed", status_reason: "non_drawing" }));
    const fromDrawing = vi.fn();
    installBackend({ documents: { extract }, bom: { fromDrawing } });

    const mod = await import("./bom-from-drawing");
    const { container, getByText } = renderScreen(mod.default);
    pickFile(container);

    await waitFor(() => expect(getByText(/not recognised as an assembly drawing/i)).toBeTruthy());
    // never attempted to map/commit a non-drawing
    expect(fromDrawing).not.toHaveBeenCalled();
  });
});
