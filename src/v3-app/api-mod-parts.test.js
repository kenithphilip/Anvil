// Provisional ("-MOD") part numbers and BOM finality.
//
// A gun-modification quote is priced before engineering has issued real part
// numbers, so its lines carry provisional codes with a -MOD suffix. The rule:
// a FINAL BOM is one where no part carries that suffix. Until design supplies
// it, the order is committed to parts that do not yet exist.
//
// This is the first part-number shape rule in the codebase — item_master.part_no
// and bom_lines.part_no have no CHECK constraint and no application-level
// validation, and the only pre-existing part-shape code answers different
// questions entirely.

import { describe, it, expect } from "vitest";
import {
  isProvisionalPart, baseOfProvisional, provisionalParts,
  isModificationQuote, isFinalBom, modBomFinding, MOD_BOM_FINDING_CODE,
} from "../api/_lib/mod-parts.js";

describe("isProvisionalPart", () => {
  it("recognises the plain suffix", () => {
    expect(isProvisionalPart("TNA-16-04-MOD")).toBe(true);
    expect(isProvisionalPart("X-HD0420-MOD")).toBe(true);
  });

  it("recognises a numbered revision of it", () => {
    for (const p of ["TNA-16-04-MOD2", "TNA-16-04-MOD-3", "TNA-16-04-MOD_4"]) {
      expect(isProvisionalPart(p)).toBe(true);
    }
  });

  it("is case-insensitive and tolerates surrounding space", () => {
    expect(isProvisionalPart("  tna-16-04-mod  ")).toBe(true);
  });

  // The one that would block orders that are perfectly fine.
  it("does NOT match a part that merely contains MOD", () => {
    for (const p of ["BRACKET-MODULE", "MOD-PLATE-7", "MODIFIER-22", "X-MODEL-3"]) {
      expect(isProvisionalPart(p)).toBe(false);
    }
  });

  it("does not match a bare suffix-free part", () => {
    expect(isProvisionalPart("TNA-16-04")).toBe(false);
  });

  it.each([null, undefined, "", "   ", 42])("is false for %p", (v) => {
    expect(isProvisionalPart(v)).toBe(false);
  });
});

describe("baseOfProvisional", () => {
  it("strips only the suffix", () => {
    expect(baseOfProvisional("TNA-16-04-MOD")).toBe("TNA-16-04");
    expect(baseOfProvisional("TNA-16-04-MOD2")).toBe("TNA-16-04");
  });

  it("returns null for a part that is not provisional", () => {
    expect(baseOfProvisional("TNA-16-04")).toBeNull();
    expect(baseOfProvisional("BRACKET-MODULE")).toBeNull();
  });
});

describe("provisionalParts", () => {
  const L = (p) => ({ part_no: p });

  it("collects the distinct provisional parts, first-seen order", () => {
    const out = provisionalParts([L("A-MOD"), L("B"), L("A-MOD"), L("C-MOD")]);
    expect(out).toEqual(["A-MOD", "C-MOD"]);
  });

  it("dedupes case-insensitively", () => {
    expect(provisionalParts([L("A-MOD"), L("a-mod")])).toEqual(["A-MOD"]);
  });

  it("reads the alternative field names lines actually arrive with", () => {
    expect(provisionalParts([{ partNumber: "A-MOD" }, { partNo: "B-MOD" }, { item_code: "C-MOD" }]))
      .toEqual(["A-MOD", "B-MOD", "C-MOD"]);
  });

  it.each([null, undefined, []])("is empty for %p", (v) => {
    expect(provisionalParts(v)).toEqual([]);
  });
});

describe("isModificationQuote", () => {
  it("is derived from the parts, not declared", () => {
    expect(isModificationQuote([{ part_no: "A" }, { part_no: "B-MOD" }])).toBe(true);
    expect(isModificationQuote([{ part_no: "A" }, { part_no: "B" }])).toBe(false);
  });
});

describe("isFinalBom", () => {
  it("is final when it has parts and none is provisional", () => {
    const r = isFinalBom([{ part_no: "A" }, { part_no: "B" }]);
    expect(r.final).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.pending_parts).toEqual([]);
  });

  it("is not final while any part is provisional", () => {
    const r = isFinalBom([{ part_no: "A" }, { part_no: "B-MOD" }]);
    expect(r.final).toBe(false);
    expect(r.pending_parts).toEqual(["B-MOD"]);
  });

  // The distinction that keeps this honest.
  it("does not call an EMPTY bom final", () => {
    // An empty BOM has no -MOD parts either. Calling it final would clear the
    // block on an order nobody has engineered.
    const r = isFinalBom([]);
    expect(r.final).toBe(false);
    expect(r.complete).toBe(false);
  });
});

describe("modBomFinding", () => {
  it("returns null when nothing is provisional", () => {
    expect(modBomFinding([{ part_no: "A" }])).toBeNull();
  });

  it("blocks, so approval and ERP push refuse", () => {
    const f = modBomFinding([{ part_no: "A-MOD" }]);
    expect(f.code).toBe(MOD_BOM_FINDING_CODE);
    expect(f.blocks).toBe(true);
    expect(f.severity).toBe("ERROR");
  });

  it("names the parts in the detail an operator reads", () => {
    const f = modBomFinding([{ part_no: "A-MOD" }, { part_no: "B-MOD" }]);
    expect(f.detail).toContain("A-MOD");
    expect(f.detail).toContain("B-MOD");
    expect(f.detail).toMatch(/final BOM/i);
    expect(f.pending_parts).toEqual(["A-MOD", "B-MOD"]);
  });

  it("truncates a long list in the text but keeps them all on the finding", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ part_no: `P${i}-MOD` }));
    const f = modBomFinding(many);
    expect(f.detail).toMatch(/\+4 more/);
    expect(f.pending_parts).toHaveLength(12);
  });

  it("carries the quote it came from", () => {
    const f = modBomFinding([{ part_no: "A-MOD" }], { sourceQuoteNumber: "Q-77" });
    expect(f.source_quote_number).toBe("Q-77");
  });
});

describe("the finding goes through the same gate as an extraction blocker", () => {
  it("is recognised as an unresolved blocker", async () => {
    const { isUnresolvedBlocker, hasUnresolvedBlocker } = await import("../api/_lib/blocking-findings.js");
    const f = modBomFinding([{ part_no: "A-MOD" }]);
    expect(isUnresolvedBlocker(f)).toBe(true);
    expect(hasUnresolvedBlocker([f])).toBe(true);
  });

  it("stops blocking once resolved", async () => {
    const { isUnresolvedBlocker } = await import("../api/_lib/blocking-findings.js");
    const f = { ...modBomFinding([{ part_no: "A-MOD" }]), resolved: true };
    expect(isUnresolvedBlocker(f)).toBe(false);
  });
});
