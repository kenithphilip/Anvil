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

const pickFile = (container: HTMLElement, name = "GUN-77.pdf", content = "drawing bytes", type = "application/pdf") => {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], name, { type });
  // jsdom's File.text() is unreliable across versions; the screen uses the
  // standard f.text() (correct in real browsers), so make it deterministic here.
  Object.defineProperty(file, "text", { value: async () => content, configurable: true });
  fireEvent.change(input, { target: { files: [file] } });
};

// A minimal DXF with a title block + two BOM-row attribute blocks.
const dxfPair = (pairs: Array<[number | string, string]>) => pairs.map(([c, v]) => c + "\n" + v).join("\n");
const dxfInsert = (block: string, attribs: Array<[string, string]>) => {
  const out: Array<[number | string, string]> = [[0, "INSERT"], [2, block], [10, "100"], [20, "50"], [66, "1"]];
  for (const [tag, value] of attribs) out.push([0, "ATTRIB"], [2, tag], [1, value], [10, "100"], [20, "50"]);
  out.push([0, "SEQEND"], [5, "0"]);
  return out;
};
const DXF_TEXT = dxfPair([
  [0, "SECTION"], [2, "ENTITIES"],
  ...dxfInsert("TITLEBLOCK", [["DWG_NO", "GA-9000"], ["REV", "A"], ["TITLE", "CLAMP ASSY"]]),
  ...dxfInsert("BOMROW", [["ITEM", "1"], ["PART_NO", "CLAMP-BODY"], ["DESC", "Body"], ["QTY", "1"]]),
  ...dxfInsert("BOMROW", [["ITEM", "2"], ["PART_NO", "CLAMP-PIN"], ["DESC", "Pin"], ["QTY", "2"]]),
  [0, "ENDSEC"], [0, "EOF"],
]);

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

describe("BomFromDrawing — DXF (deterministic, P2)", () => {
  it("parses a DXF client-side (no LLM) and commits via importBom", async () => {
    const extract = vi.fn();
    const importBom = vi.fn(async (_p: any) => ({ ok: true, asset_id: "asset-9", lines: 2, diff: { added: 2, removed: 0, changed: 0 } }));
    installBackend({ documents: { extract }, bom: { importBom } });

    const mod = await import("./bom-from-drawing");
    const { container, getByText, getByDisplayValue } = renderScreen(mod.default);
    pickFile(container, "CLAMP.dxf", DXF_TEXT, "application/dxf");

    await waitFor(() => expect(getByText("CLAMP-BODY")).toBeTruthy());
    // deterministic path never calls the LLM extractor
    expect(extract).not.toHaveBeenCalled();
    expect(getByText(/DXF · deterministic/i)).toBeTruthy();
    expect(getByDisplayValue("GA-9000")).toBeTruthy();

    fireEvent.click(getByText(/Save to BOM/i));
    await waitFor(() => expect(getByText(/Saved GA-9000 to the BOM/i)).toBeTruthy());
    expect(importBom).toHaveBeenCalledWith(expect.objectContaining({
      asset: expect.objectContaining({ asset_code: "GA-9000", source_format: "assembly_dxf" }),
      source_format: "assembly_dxf",
    }));
    // the committed lines carry the parsed parts
    const arg = importBom.mock.calls[0][0] as any;
    expect(arg.lines.map((l: any) => l.part_no)).toEqual(["CLAMP-BODY", "CLAMP-PIN"]);
  });

  it("steers DWG uploads to export-as-DXF instead of parsing", async () => {
    const extract = vi.fn();
    const importBom = vi.fn();
    installBackend({ documents: { extract }, bom: { importBom } });

    const mod = await import("./bom-from-drawing");
    const { container, getByText } = renderScreen(mod.default);
    pickFile(container, "GUN.dwg", "binary dwg", "application/acad");

    await waitFor(() => expect(getByText(/Export the drawing as DXF/i)).toBeTruthy());
    expect(extract).not.toHaveBeenCalled();
    expect(importBom).not.toHaveBeenCalled();
  });
});
