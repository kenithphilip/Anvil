// CM PDM P0b: obsolete-part supersession — reroute a discontinued spare to its
// active replacement so a quote never orders an obsolete part.

import { describe, it, expect } from "vitest";
import { resolveReplacement, applySupersession } from "../api/_lib/part-supersession.js";

const mapOf = (obj) => new Map(Object.entries(obj));

describe("resolveReplacement", () => {
  it("reroutes a single-hop supersession", () => {
    const r = resolveReplacement(mapOf({ "SHANK-A": "SHANK-B" }), "SHANK-A");
    expect(r).toMatchObject({ part_no: "SHANK-B", superseded: true, from: "SHANK-A" });
  });

  it("follows a transitive chain to the terminal active part", () => {
    const r = resolveReplacement(mapOf({ A: "B", B: "C", C: "D" }), "A");
    expect(r.part_no).toBe("D");
    expect(r.superseded).toBe(true);
    expect(r.chain).toEqual(["A", "B", "C", "D"]);
  });

  it("does not mark an active (unsuperseded) part", () => {
    const r = resolveReplacement(mapOf({ A: "B" }), "LIVE-1");
    expect(r).toMatchObject({ part_no: "LIVE-1", superseded: false });
    expect(r.from).toBeUndefined();
  });

  it("stops on a cycle without looping", () => {
    const r = resolveReplacement(mapOf({ A: "B", B: "A" }), "A");
    expect(r.part_no).toBe("B");            // takes the last non-cycling hop
    expect(r.chain).toEqual(["A", "B"]);
  });

  it("trims + handles null/empty input", () => {
    expect(resolveReplacement(mapOf({ A: "B" }), "  A ").part_no).toBe("B");
    expect(resolveReplacement(mapOf({ A: "B" }), null)).toMatchObject({ part_no: null, superseded: false });
    expect(resolveReplacement(new Map(), "A")).toMatchObject({ part_no: "A", superseded: false });
  });
});

describe("applySupersession", () => {
  it("maps rows to active replacements aligned by index", () => {
    const out = applySupersession([{ part_no: "A" }, { part_no: "LIVE" }], mapOf({ A: "B" }));
    expect(out.map((e) => e.part_no)).toEqual(["B", "LIVE"]);
    expect(out.map((e) => e.superseded)).toEqual([true, false]);
  });
});
