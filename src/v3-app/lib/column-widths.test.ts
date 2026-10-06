// Operator-resizable columns on the reconciliation grid.
//
// The grid is width:100% with AUTO table layout, and every editable cell is an
// <input> at width:100%; min-width:0. Auto layout gives width to whichever
// column has the longest content, so short columns lose — HSN/SAC ends up a
// couple of characters wide, and an <input> in a starved cell does not wrap or
// ellipsize, it scrolls its own value out of sight. The digits are there; the
// column cannot show them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MIN_COL_PX, MAX_COL_PX, clampWidth, resizeColumn, clearColumn, sanitiseWidths,
  loadWidths, saveWidths, tableLayoutFor, widthStyle,
} from "./column-widths";

const COLS = ["item", "uom", "qty", "hsn", "issues"] as const;

describe("clampWidth", () => {
  it("keeps a column readable at both ends", () => {
    expect(clampWidth(5)).toBe(MIN_COL_PX);
    expect(clampWidth(99999)).toBe(MAX_COL_PX);
    expect(clampWidth(180)).toBe(180);
  });

  it("rounds to whole pixels", () => {
    // A fractional width reaches style.width and causes sub-pixel seams
    // between the column rules.
    expect(clampWidth(180.6)).toBe(181);
  });

  it("returns the floor for a broken number rather than NaN", () => {
    // NaN would reach style.width and collapse the column entirely.
    for (const v of [NaN, Infinity, -Infinity]) expect(clampWidth(v)).toBe(MIN_COL_PX);
  });
});

describe("resizeColumn", () => {
  it("widens by the drag delta", () => {
    expect(resizeColumn({}, "hsn", 60, 40).hsn).toBe(100);
  });

  it("narrows on a negative delta", () => {
    expect(resizeColumn({}, "hsn", 200, -50).hsn).toBe(150);
  });

  it("cannot be dragged below the floor", () => {
    expect(resizeColumn({}, "hsn", 60, -500).hsn).toBe(MIN_COL_PX);
  });

  it("leaves the other columns alone", () => {
    const before = { item: 300, uom: 60 };
    const after = resizeColumn(before, "hsn", 60, 40);
    expect(after.item).toBe(300);
    expect(after.uom).toBe(60);
  });

  it("does not mutate the input", () => {
    // The value is React state; mutating it in place skips the re-render.
    const before = { item: 300 };
    resizeColumn(before, "hsn", 60, 40);
    expect(before).toEqual({ item: 300 });
  });

  it("ignores a missing id", () => {
    expect(resizeColumn({ item: 300 }, "", 60, 40)).toEqual({ item: 300 });
  });
});

describe("clearColumn", () => {
  it("returns one column to automatic sizing", () => {
    expect(clearColumn({ item: 300, hsn: 90 }, "hsn")).toEqual({ item: 300 });
  });

  it("is a no-op for a column that was never sized", () => {
    const w = { item: 300 };
    expect(clearColumn(w, "hsn")).toBe(w);
  });
});

describe("sanitiseWidths", () => {
  it("drops columns this table no longer renders", () => {
    // Stored widths outlive the code that wrote them.
    expect(sanitiseWidths({ hsn: 90, removed_col: 120 }, COLS)).toEqual({ hsn: 90 });
  });

  it("drops values that are not numbers", () => {
    expect(sanitiseWidths({ hsn: "wide", uom: null, qty: 80 }, COLS)).toEqual({ qty: 80 });
  });

  it("clamps a hand-edited extreme", () => {
    expect(sanitiseWidths({ hsn: 999999 }, COLS)).toEqual({ hsn: MAX_COL_PX });
  });

  it.each([null, undefined, "nope", 42, []])("returns empty for %p", (v) => {
    expect(sanitiseWidths(v, COLS)).toEqual({});
  });
});

describe("tableLayoutFor", () => {
  it("stays automatic until the operator sizes something", () => {
    // Switching to fixed unconditionally would freeze every UNSET column to an
    // equal share, changing a table nobody touched.
    expect(tableLayoutFor({})).toBe("auto");
  });

  it("goes fixed once a width is set, so the width is authoritative", () => {
    expect(tableLayoutFor({ hsn: 90 })).toBe("fixed");
  });
});

describe("widthStyle", () => {
  it("pins both width and minWidth", () => {
    // width alone lets a flex ancestor shrink the column back below the drag.
    expect(widthStyle({ hsn: 90 }, "hsn")).toEqual({ width: 90, minWidth: 90 });
  });

  it("leaves an unsized column automatic", () => {
    expect(widthStyle({ hsn: 90 }, "item")).toBeUndefined();
    expect(widthStyle({}, "hsn")).toBeUndefined();
  });
});

describe("persistence", () => {
  // This suite installs its OWN storage rather than using the environment's.
  // vitest here provides a `localStorage` object whose methods are missing
  // (the `--localstorage-file` warning at startup), so touching it throws —
  // which is exactly the condition the last test in this block asserts the
  // production code survives, and a terrible basis for the others.
  const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const install = (impl: unknown) =>
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: impl, writable: true });
  const restore = () => {
    if (orig) Object.defineProperty(globalThis, "localStorage", orig);
    else delete (globalThis as any).localStorage;
  };

  beforeEach(() => {
    const store = new Map<string, string>();
    install({
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
  });
  afterEach(restore);

  it("round-trips a width", () => {
    saveWidths("t1", { hsn: 120 });
    expect(loadWidths("t1", COLS)).toEqual({ hsn: 120 });
  });

  it("sanitises on the way back in", () => {
    // Whatever is in storage is untrusted — another tab, an older release, a
    // user with devtools open.
    globalThis.localStorage.setItem("anvil.colw.t2", JSON.stringify({ hsn: 1e9, gone: 50 }));
    expect(loadWidths("t2", COLS)).toEqual({ hsn: MAX_COL_PX });
  });

  it("returns empty rather than throwing on unparseable storage", () => {
    globalThis.localStorage.setItem("anvil.colw.t3", "{not json");
    expect(loadWidths("t3", COLS)).toEqual({});
  });

  it("clears the key when the reset empties the widths", () => {
    saveWidths("t4", { hsn: 120 });
    saveWidths("t4", {});
    expect(globalThis.localStorage.getItem("anvil.colw.t4")).toBeNull();
    expect(loadWidths("t4", COLS)).toEqual({});
  });

  it("survives storage being unavailable", () => {
    // Private windows and embedded webviews throw on property ACCESS, not just
    // on the call. A layout preference must never take the grid down.
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError"); },
    });
    expect(() => saveWidths("t5", { hsn: 90 })).not.toThrow();
    expect(loadWidths("t5", COLS)).toEqual({});
  });

  it("survives a storage object whose methods are missing", () => {
    // Precisely this environment's stub, and some embedded webviews.
    install({});
    expect(() => saveWidths("t6", { hsn: 90 })).not.toThrow();
    expect(loadWidths("t6", COLS)).toEqual({});
  });
});

describe("the HSN case this exists for", () => {
  it("a drag makes the column wide enough to read a full HSN code", () => {
    // HSN/SAC is 4-8 digits; auto layout was leaving room for about two.
    const widths = resizeColumn({}, "hsn", 40, 80);
    expect(widths.hsn).toBe(120);
    expect(tableLayoutFor(widths)).toBe("fixed");     // so the width actually binds
    expect(widthStyle(widths, "hsn")).toEqual({ width: 120, minWidth: 120 });
  });

  it("and the reset puts every column back", () => {
    expect(tableLayoutFor({})).toBe("auto");
  });
});
