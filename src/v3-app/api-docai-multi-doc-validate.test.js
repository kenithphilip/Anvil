// Unit tests for src/api/_lib/docai/multi-doc-validate.js (Wave 3.6).

import { describe, it, expect } from "vitest";
import { crossValidateDocuments, __test } from "../api/_lib/docai/multi-doc-validate.js";

describe("__test.flatten", () => {
  it("flattens customer + lines + totals", () => {
    const out = __test.flatten({
      customer: { name: "Acme" },
      lines: [{ partNumber: "X", quantity: 10 }],
      totals: { grand_total: 1180 },
    });
    expect(out["customer.name"]).toBe("Acme");
    expect(out["lines[0].partNumber"]).toBe("X");
    expect(out["totals.grand_total"]).toBe(1180);
  });
});

describe("__test.classifySeverity", () => {
  it("flags grand_total as critical", () => {
    expect(__test.classifySeverity("totals.grand_total")).toBe("critical");
  });
  it("flags customer.gstin as critical", () => {
    expect(__test.classifySeverity("customer.gstin")).toBe("critical");
  });
  it("flags customer-* and totals-* as high", () => {
    expect(__test.classifySeverity("customer.name")).toBe("high");
    expect(__test.classifySeverity("totals.subtotal")).toBe("critical");      // critical wins
  });
  it("flags line numeric fields as high", () => {
    expect(__test.classifySeverity("lines[0].unitPrice")).toBe("high");
    expect(__test.classifySeverity("lines[0].quantity")).toBe("high");
  });
  it("defaults to medium", () => {
    expect(__test.classifySeverity("lines[0].description")).toBe("medium");
  });
});

describe("crossValidateDocuments", () => {
  it("returns empty when fewer than 2 docs", () => {
    expect(crossValidateDocuments([]).summary.match_count).toBe(0);
    expect(crossValidateDocuments([{ docId: "a", normalized: {} }]).summary.conflict_count).toBe(0);
  });

  it("flags matching fields", () => {
    const out = crossValidateDocuments([
      { docId: "po", kind: "po", normalized: { customer: { name: "Acme" } } },
      { docId: "quote", kind: "quote", normalized: { customer: { name: "Acme" } } },
    ]);
    expect(out.summary.match_count).toBeGreaterThan(0);
    expect(out.matches.some((m) => m.field === "customer.name" && m.value === "Acme")).toBe(true);
  });

  it("flags conflicting fields", () => {
    const out = crossValidateDocuments([
      { docId: "po", kind: "po", normalized: { totals: { grand_total: 1180 } } },
      { docId: "quote", kind: "quote", normalized: { totals: { grand_total: 1200 } } },
    ]);
    expect(out.summary.conflict_count).toBe(1);
    expect(out.conflicts[0].field).toBe("totals.grand_total");
    expect(out.conflicts[0].severity).toBe("critical");
    expect(out.conflicts[0].values.length).toBe(2);
  });

  it("flags unique fields per document", () => {
    const out = crossValidateDocuments([
      { docId: "po", kind: "po", normalized: { customer: { name: "Acme", po_number: "PO-1" } } },
      { docId: "quote", kind: "quote", normalized: { customer: { name: "Acme" } } },
    ]);
    const poUnique = out.unique.find((u) => u.docId === "po");
    expect(poUnique.fields).toContain("customer.po_number");
  });

  it("treats numerics within 0.5 paise as matching", () => {
    const out = crossValidateDocuments([
      { docId: "po", normalized: { totals: { grand_total: 1180.00 } } },
      { docId: "quote", normalized: { totals: { grand_total: 1180.002 } } },
    ]);
    expect(out.summary.conflict_count).toBe(0);
  });

  it("handles 3 documents with mixed agreement", () => {
    const out = crossValidateDocuments([
      { docId: "po", normalized: { customer: { name: "Acme" }, totals: { grand_total: 1000 } } },
      { docId: "quote", normalized: { customer: { name: "Acme" }, totals: { grand_total: 1100 } } },
      { docId: "spec", normalized: { customer: { name: "Acme" }, totals: { grand_total: 1000 } } },
    ]);
    expect(out.matches.some((m) => m.field === "customer.name")).toBe(true);
    expect(out.conflicts.some((c) => c.field === "totals.grand_total")).toBe(true);
    const conflict = out.conflicts.find((c) => c.field === "totals.grand_total");
    expect(conflict.values.length).toBe(2);
  });

  it("includes the summary counts", () => {
    const out = crossValidateDocuments([
      { docId: "po", normalized: { customer: { name: "Acme", po_number: "X" } } },
      { docId: "quote", normalized: { customer: { name: "Acme" } } },
    ]);
    expect(out.summary.match_count).toBeGreaterThan(0);
    expect(out.summary.unique_count).toBeGreaterThan(0);
  });
});
