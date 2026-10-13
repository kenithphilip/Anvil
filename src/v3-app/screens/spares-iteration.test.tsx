// Spare matrix iteration, screen level (docs/SPARE_MATRIX_ITERATION.md):
//  - the worksheet preview equals the exported xlsx (same fixture, both built
//    by the real screen, the file parsed back),
//  - "Columns from BOM" offers Material when present and explains when absent,
//  - a matrix saved before this change still loads unchanged.
// Invented fixtures only.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import * as XLSXmod from "xlsx";
import { installBackend, installRbac, renderScreen } from "../test-utils";

const XLSX: any = (XLSXmod as any).read ? XLSXmod : (XLSXmod as any).default;

const waitFor = async (pred: () => boolean, tries = 200) => {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met");
};
const texts = (els: Iterable<Element>) => Array.from(els).map((e) => e.textContent || "");

const BOM: Record<string, any[]> = {
  "GUN-A1": [
    { part_no: "PN-1001", part_name: "ADAPTER", material: "CuCrZr" },
    { part_no: "ARM-501", part_name: "ARM", material: "SS400" },
  ],
  "GUN-B2": [
    { part_no: "PN-1002", part_name: "ADAPTER 16MM", material: "CuCr" },
  ],
};

const matrixFixture = (columns: any[], rows: any[]) => ({
  list: async () => ({ matrices: [{ id: "m1", customer_id: "c1", project_name: "Plant X", name: "Test Matrix", updated_at: "2026-10-01T00:00:00Z" }] }),
  get: async () => ({ matrix: { id: "m1", customer_id: "c1", project_name: "Plant X", name: "Test Matrix" }, columns, rows, recommended: [] }),
  update: vi.fn(async () => ({})),
});

beforeEach(() => {
  installRbac("admin");
  vi.stubGlobal("confirm", () => true);
  try { window.localStorage.clear(); } catch (_) { /* noop */ }
});
afterEach(() => { delete (window as any).XLSX; });

describe("worksheet preview equals the export", () => {
  it("renders and exports the same headers, order, PART NO. row and MATERIAL row", async () => {
    // Saved out of order on purpose: a Spare, then Consumable split columns, then a kit.
    const columns = [
      { id: "k1", col_name: "ARM", category: "spare", locked: false },
      { id: "k2", col_name: "ADAPTER-1", category: "consumable", locked: false },
      { id: "k3", col_name: "ADAPTER-2", category: "consumable", locked: false },
      { id: "k4", col_name: "KIT A", category: "kit", locked: false },
    ];
    const rows = [
      { id: "r1", gun_no: "GUN-A1", line: "L1", station_no: "ST-10", robot_no: "R1", gun_type: "X", atd: "ATD-5", qty: 1, timer: "T-1", spare_values: { ARM: "ARM-501", "ADAPTER-1": "PN-1001" } },
      { id: "r2", gun_no: "GUN-B2", line: "L1", station_no: "ST-20", robot_no: "R2", gun_type: "Y", atd: "ATD-6", qty: 2, spare_values: { "ADAPTER-2": "PN-1002", "KIT A": "KT-9" } },
    ];
    window.localStorage.setItem("anvil:v3_spare_bom_fields:m1", JSON.stringify(["material"]));
    installBackend({
      customers: { list: async () => [{ id: "c1", customer_name: "Test Customer" }] },
      spareMatrix: matrixFixture(columns, rows),
      bom: { assetByCode: async (code: string) => ({ lines: BOM[code] || [] }), list: async () => [] },
    });
    let captured: any = null;
    (window as any).XLSX = { ...XLSX, writeFile: (wb: any) => { captured = wb; } };

    const mod = await import("./spares");
    const { container } = renderScreen(mod.default);
    // Wait for the grid and for the MATERIAL row's values (BOM lines loaded).
    await waitFor(() => texts(container.querySelectorAll("tr[data-sm-meta='material'] [data-sm-meta-cell]")).includes("CuCrZr"));

    const head = texts(container.querySelectorAll("thead tr:first-child [data-sm-label]"));
    const metaRow = (key: string) => {
      const tr = container.querySelector(`tr[data-sm-meta='${key}']`)!;
      return [tr.querySelector("[data-sm-label]")!.textContent, ...texts(tr.querySelectorAll("[data-sm-meta-cell]"))];
    };
    expect(head.slice(0, 7)).toEqual(["GUN NO.", "LINE", "STATION", "ROBOT", "GUN TYPE", "ATDC/ATD", "QTY"]);
    expect(head.slice(10)).toEqual(["ADAPTER-1", "ADAPTER-2", "ARM", "KIT A"]);   // Consumables, Spares, fallback

    // Export through the real button.
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => /Export/.test(b.textContent || ""))!);
    fireEvent.click(Array.from(container.querySelectorAll(".cmdk-row")).find((d) => d.textContent === "xlsx")!);
    await waitFor(() => captured != null);
    const file = XLSX.read(XLSX.write(captured, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
    const aoa: any[][] = XLSX.utils.sheet_to_json(file.Sheets["Spare Matrix"], { header: 1, defval: "" });

    expect(aoa[0]).toEqual(head);                                    // same headers, same order
    const fileMeta = (label: string) => {
      const r = aoa.find((x) => x[0] === label)!;
      return [r[0], ...r.slice(10)];
    };
    expect(fileMeta("PART NO.")).toEqual(metaRow("part_no"));
    expect(fileMeta("MATERIAL")).toEqual(metaRow("material"));
    expect(metaRow("part_no")).toEqual(["PART NO.", "PN-1001", "PN-1002", "ARM-501", "KT-9"]);
    expect(metaRow("material")).toEqual(["MATERIAL", "CuCrZr", "CuCr", "SS400", ""]);
    // Data rows are aligned under the same headers.
    const gunA = aoa.find((x) => x[0] === "GUN-A1")!;
    expect(gunA[head.indexOf("ADAPTER-1")]).toBe("PN-1001");
    expect(gunA[head.indexOf("ARM")]).toBe("ARM-501");
    expect(gunA[head.indexOf("ATDC/ATD")]).toBe("ATD-5");
  });

  it("loads a matrix saved before this change as it was, without rewriting it", async () => {
    const spare = matrixFixture(
      [{ id: "k1", col_name: "ADAPTER", category: "consumable", locked: false }],
      [{ id: "r1", gun_no: "GUN-A1", spare_values: { ADAPTER: "PN-1001\nPN-1002" } }],
    );
    installBackend({ customers: { list: async () => [] }, spareMatrix: spare, bom: { assetByCode: async () => ({ lines: [] }) } });
    const mod = await import("./spares");
    const { container } = renderScreen(mod.default);
    await waitFor(() => !!container.querySelector("tr[data-sm-meta='part_no']"));
    expect(texts(container.querySelectorAll("thead tr:first-child [data-sm-label]")).slice(10)).toEqual(["ADAPTER"]);
    // Both part numbers stay visible; nothing was split or saved on load.
    expect(texts(container.querySelectorAll("tr[data-sm-meta='part_no'] [data-sm-meta-cell]"))).toEqual(["PN-1001\nPN-1002"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(spare.update).not.toHaveBeenCalled();
  });
});

describe("importing a sheet in the new layout", () => {
  it("skips the PART NO. row, maps ATDC/ATD, and merges duplicate part headers", async () => {
    installBackend({ customers: { list: async () => [] }, spareMatrix: matrixFixture([], []), bom: { assetByCode: async () => ({ lines: [] }) } });
    const mod = await import("./spares");
    const { container } = renderScreen(mod.default);
    await waitFor(() => /No rows yet/.test(container.textContent || ""));
    const csv = [
      "GUN NO.,LINE,STATION,ROBOT,GUN TYPE,ATDC/ATD,QTY,ADAPTER,ADAPTER",
      "PART NO.,,,,,,,PN-1001,PN-1002",
      "GUN-A1,L1,ST-10,R1,X,ATD-5,2,PN-1001,PN-1002",
    ].join("\n");
    const input = container.querySelector("input[type='file']") as HTMLInputElement;
    // jsdom's File has no text(); the import only needs name + text().
    fireEvent.change(input, { target: { files: [{ name: "matrix.csv", text: async () => csv }] } });
    await waitFor(() => /Import preview/.test(container.textContent || "") && !!Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Commit" && !b.disabled));
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Commit")!);
    await waitFor(() => /GUN-A1/.test(container.querySelector("tbody")?.textContent || ""));
    const guns = texts(container.querySelectorAll("tbody td:first-child span.mono"));
    expect(guns).toEqual(["GUN-A1"]);                                   // no "PART NO." gun row
    const head = texts(container.querySelectorAll("thead tr:first-child [data-sm-label]"));
    expect(head.slice(10)).toEqual(["ADAPTER"]);                        // ATDC/ATD is not a part column
    const atdInput = container.querySelectorAll("tbody tr td")[head.indexOf("ATDC/ATD")].querySelector("input") as HTMLInputElement;
    expect(atdInput.value).toBe("ATD-5");
    // Both ADAPTER columns' part numbers survive in the one ADAPTER column.
    expect(texts(container.querySelectorAll("tr[data-sm-meta='part_no'] [data-sm-meta-cell]"))).toEqual(["PN-1001\nPN-1002"]);
  });
});

describe("Columns from BOM: Material", () => {
  const renderPanel = async (lines: any[], props: any = {}) => {
    installBackend({ bom: { assetByCode: async () => ({ lines }), list: async () => [] } });
    const { SuggestColsPanel } = await import("./spares");
    const onFieldsChange = vi.fn();
    const onAdd = vi.fn();
    const view = render(<SuggestColsPanel guns={["GUN-A1"]} existing={[]} onAdd={onAdd} onClose={() => {}} fields={[]} onFieldsChange={onFieldsChange} {...props} />);
    await waitFor(() => !/Scanning every gun/.test(view.container.textContent || ""));
    return { ...view, onFieldsChange, onAdd };
  };

  it("lists Material when present and saves the selection", async () => {
    const { container, onFieldsChange } = await renderPanel([
      { part_no: "PN-1001", part_name: "ADAPTER", material: "CuCrZr", qty: 2 },
    ]);
    const box = container.querySelector("input[aria-label='Show Material']") as HTMLInputElement;
    expect(box).toBeTruthy();
    expect(container.querySelector("[data-sm-material-missing]")).toBeNull();
    fireEvent.click(box);
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((b) => /Add selected/.test(b.textContent || ""))!);
    expect(onFieldsChange).toHaveBeenCalledWith(["material"]);
    // Excluded fields are explained, not silently hidden.
    expect(container.textContent).toContain("Qty (BOM quantity is per gun.");
  });

  it("explains why Material is missing when no BOM line has it", async () => {
    const { container } = await renderPanel([{ part_no: "PN-1001", part_name: "ADAPTER", material: "" }]);
    expect(container.querySelector("input[aria-label='Show Material']")).toBeNull();
    expect(container.querySelector("[data-sm-material-missing]")?.textContent).toContain("Material is not available");
  });

  it("does not offer a category again once it is split", async () => {
    const { container } = await renderPanel(
      [{ part_no: "PN-1001", part_name: "ADAPTER" }, { part_no: "ARM-1", part_name: "ARM" }],
      { existing: [{ col_name: "ADAPTER-1" }, { col_name: "ADAPTER-2" }] },
    );
    const offered = texts(container.querySelectorAll("td.mono"));
    expect(offered).toContain("ARM");
    expect(offered).not.toContain("ADAPTER");
  });
});
