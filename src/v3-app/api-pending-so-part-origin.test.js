// Tally part/description split + local(-I)/import(O/x) origin classification for
// the Pending Sales Order view. Fixtures are the real rows from
// "Pending Sales Order for Gestamp.xlsx".

import { describe, it, expect } from "vitest";
import {
  splitTallyPartDescription, classifySourcePoRef, classifyOrigin, resolveTallyLine,
} from "../api/_lib/pending-so/part-origin.js";

describe("splitTallyPartDescription", () => {
  it("splits a local -I part out of the munged Tally description", () => {
    expect(splitTallyPartDescription("Electrode OID1292-I")).toEqual({
      part_no: "OID1292-I", description: "Electrode", origin_marker: "-I",
    });
    expect(splitTallyPartDescription("Cooling Block OID2106-I")).toEqual({
      part_no: "OID2106-I", description: "Cooling Block", origin_marker: "-I",
    });
    expect(splitTallyPartDescription("Adapter TNA-16-04-25-1-I")).toEqual({
      part_no: "TNA-16-04-25-1-I", description: "Adapter", origin_marker: "-I",
    });
  });

  it("peels a spaced (O/x) import marker and still finds the code", () => {
    expect(splitTallyPartDescription("Transformer DB6-90-510 (O/C)")).toEqual({
      part_no: "DB6-90-510", description: "Transformer", origin_marker: "O/C",
    });
  });

  it("peels a GLUED (O/x) marker (the part-split.js gap)", () => {
    expect(splitTallyPartDescription("Gear Case Assy C5E0069(O/C)")).toEqual({
      part_no: "C5E0069", description: "Gear Case Assy", origin_marker: "O/C",
    });
    // From so_pdf's hardcoded-(O/K) fixture — glued, hyphenated code.
    expect(splitTallyPartDescription("403A7K188-100(O/K)")).toEqual({
      part_no: "403A7K188-100", description: null, origin_marker: "O/K",
    });
  });

  it("leaves a pure service/charge line as description only", () => {
    expect(splitTallyPartDescription("Installation Charges")).toEqual({
      part_no: null, description: "Installation Charges", origin_marker: null,
    });
    expect(splitTallyPartDescription("Service Charges")).toEqual({
      part_no: null, description: "Service Charges", origin_marker: null,
    });
  });

  it("keeps a non-origin parenthetical in the description (no code)", () => {
    const r = splitTallyPartDescription("Lower electrode (With Water Cooling)");
    expect(r.part_no).toBe(null);
    expect(r.origin_marker).toBe(null);
    expect(r.description).toBe("Lower electrode (With Water Cooling)");
  });

  it("does not mistake a 'W/O' abbreviation for a part code (no digit)", () => {
    const r = splitTallyPartDescription("Transformer W/O Terminal Block");
    expect(r.part_no).toBe(null);
    expect(r.description).toBe("Transformer W/O Terminal Block");
  });

  it("handles blank / null input", () => {
    expect(splitTallyPartDescription("")).toEqual({ part_no: null, description: null, origin_marker: null });
    expect(splitTallyPartDescription(null)).toEqual({ part_no: null, description: null, origin_marker: null });
  });
});

describe("classifySourcePoRef", () => {
  it("reads a WOPO work order as local", () => {
    expect(classifySourcePoRef("WOPOOI-260317-15-OI")).toMatchObject({
      source_kind: "work_order", origin: "local", country: "IN", source_country: "O-INDIA", ref_prefix: "WOPOOI",
    });
  });
  it("reads an OIPO import PO with its country", () => {
    expect(classifySourcePoRef("OIPOOC-260519-02-OC")).toMatchObject({ source_kind: "import_po", origin: "import", country: "CN", source_country: "O-CHINA" });
    expect(classifySourcePoRef("OIPOOJ-260101-01-OJ")).toMatchObject({ country: "JP", origin: "import" });
    expect(classifySourcePoRef("OIPOOK-260101-01-OK")).toMatchObject({ country: "KR", origin: "import" });
    expect(classifySourcePoRef("OIPOOC-260620-01-OC-MOQ")).toMatchObject({ country: "CN", origin: "import" });
  });
  it("treats OIPO to India as domestic procurement, not import", () => {
    expect(classifySourcePoRef("OIPOOI-260101-01-OI")).toMatchObject({ source_kind: "procurement_po", origin: "local", country: "IN" });
  });
  it("returns null for an unrecognised reference", () => {
    expect(classifySourcePoRef("5804027382")).toBe(null);
    expect(classifySourcePoRef("")).toBe(null);
  });
});

describe("classifyOrigin (reconciliation)", () => {
  it("agrees high-confidence when part suffix and PO ref match (local)", () => {
    const v = classifyOrigin({ part_no: "OID1292-I", description: "Electrode", origin_marker: "-I", source_po_ref: "WOPOOI-260317-15-OI" });
    expect(v).toMatchObject({ origin: "local", source_kind: "work_order", country: "IN", source_country: "O-INDIA", conflict: false, confidence: "high" });
  });
  it("agrees high-confidence for an import part", () => {
    const v = classifyOrigin({ part_no: "DB6-90-510", origin_marker: "O/C", source_po_ref: "OIPOOC-260519-02-OC" });
    expect(v).toMatchObject({ origin: "import", source_kind: "import_po", country: "CN", confidence: "high" });
  });
  it("classifies from the PO ref alone when the description has no code (medium)", () => {
    const v = classifyOrigin({ part_no: null, description: "Lower electrode (With Water Cooling)", source_po_ref: "WOPOOI-260508-04-OI" });
    expect(v).toMatchObject({ origin: "local", source_kind: "work_order", confidence: "medium" });
  });
  it("classifies from the -I suffix alone when there is no PO ref (medium, inferred kind)", () => {
    const v = classifyOrigin({ part_no: "C109181-I", description: "Holder" });
    expect(v).toMatchObject({ origin: "local", source_kind: "work_order", country: "IN", confidence: "medium" });
  });
  it("flags a conflict and prefers the PO ref (operational truth)", () => {
    // part says local (-I) but the PO ref is an import PO — surface it, don't hide it.
    const v = classifyOrigin({ part_no: "OID1292-I", origin_marker: "-I", source_po_ref: "OIPOOC-260519-02-OC" });
    expect(v).toMatchObject({ origin: "import", conflict: true, confidence: "low" });
  });
  it("is unknown/low with no signals (a service line)", () => {
    const v = classifyOrigin({ part_no: null, description: "Installation Charges" });
    expect(v).toMatchObject({ origin: "unknown", source_kind: null, confidence: "low" });
  });
});

describe("resolveTallyLine (split + classify in one)", () => {
  it("resolves a real import row end to end", () => {
    const r = resolveTallyLine("Gear Case Assy C5E0069(O/C)", "OIPOOC-260620-01-OC-MOQ");
    expect(r.part_no).toBe("C5E0069");
    expect(r.description).toBe("Gear Case Assy");
    expect(r.origin).toMatchObject({ origin: "import", country: "CN", source_kind: "import_po", confidence: "high" });
  });
  it("resolves a real local row end to end", () => {
    const r = resolveTallyLine("Electrode OID1300-I", "WOPOOI-260714-01-OI");
    expect(r.part_no).toBe("OID1300-I");
    expect(r.description).toBe("Electrode");
    expect(r.origin).toMatchObject({ origin: "local", source_kind: "work_order", confidence: "high" });
  });
});
