// Phase C: cross-adapter voter tests.

import { describe, it, expect } from "vitest";
import { voteAcrossAdapters, __test__ } from "../api/_lib/docai/voter.js";

const adapter = (name, normalized, conf, rank = 0) => ({
  ok: true,
  adapter_used: name,
  confidence_overall: conf,
  normalized,
  _rank: rank,
});

describe("voter / scalar field voting", () => {
  it("picks the most common non-null value", () => {
    const entries = [
      { adapter: "claude", normalized: { customer: { gstin: "27AAACA1234B1Z5" } }, confidence: 0.95, ok: true, rank: 0 },
      { adapter: "reducto", normalized: { customer: { gstin: "27AAACA1234B1Z5" } }, confidence: 0.85, ok: true, rank: 1 },
      { adapter: "marker", normalized: { customer: { gstin: "27AAACA9999B1Z5" } }, confidence: 0.50, ok: true, rank: 2 },
    ];
    const out = __test__.voteScalar(entries, "customer.gstin");
    expect(out.value).toBe("27AAACA1234B1Z5");
    expect(out.source).toBe("claude");                      // highest confidence in the winning bucket
    expect(out.voters).toHaveLength(3);
  });

  it("breaks ties on count by max confidence", () => {
    const entries = [
      { adapter: "claude",  normalized: { customer: { gstin: "A" } }, confidence: 0.60, ok: true, rank: 0 },
      { adapter: "reducto", normalized: { customer: { gstin: "B" } }, confidence: 0.95, ok: true, rank: 1 },
    ];
    const out = __test__.voteScalar(entries, "customer.gstin");
    expect(out.value).toBe("B");
    expect(out.source).toBe("reducto");
  });

  it("returns null when every adapter returned null", () => {
    const entries = [
      { adapter: "claude",  normalized: { customer: { gstin: null } }, confidence: 0.60, ok: true, rank: 0 },
      { adapter: "reducto", normalized: { customer: { gstin: null } }, confidence: 0.95, ok: true, rank: 1 },
    ];
    const out = __test__.voteScalar(entries, "customer.gstin");
    expect(out.value).toBeNull();
    expect(out.source).toBeNull();
  });
});

describe("voter / line voting", () => {
  it("aligns lines by partNumber across adapters and votes per field", () => {
    const entries = [
      {
        adapter: "claude",
        normalized: {
          lines: [
            { partNumber: "BRG-6204", description: "Bearing", quantity: 100, unitPrice: 125 },
            { partNumber: "BRG-6205", description: "Bearing 5", quantity: 50, unitPrice: 145 },
          ],
        },
        confidence: 0.95, ok: true, rank: 0,
      },
      {
        adapter: "reducto",
        normalized: {
          lines: [
            { partNumber: "BRG-6204", description: "Deep groove", quantity: 100, unitPrice: 125 },
            { partNumber: "BRG-6205", description: "Bearing 5", quantity: 50, unitPrice: 145 },
          ],
        },
        confidence: 0.85, ok: true, rank: 1,
      },
    ];
    const { lines, lineProvenance } = __test__.voteLines(entries);
    expect(lines).toHaveLength(2);
    // Same qty + price across both adapters -> same value.
    expect(lines[0].partNumber).toBe("BRG-6204");
    expect(lines[0].quantity).toBe(100);
    expect(lines[0].unitPrice).toBe(125);
    // Description disagrees across adapters. Both buckets have one
    // vote each, so the tie breaks on confidence: claude (0.95) >
    // reducto (0.85). Provenance must agree.
    expect(lines[0].description).toBe("Bearing");
    expect(lineProvenance[0].fields.description.source).toBe("claude");
  });

  it("aligns by row index when partNumbers are missing", () => {
    const entries = [
      {
        adapter: "claude",
        normalized: { lines: [{ description: "A", quantity: 10 }, { description: "B", quantity: 20 }] },
        confidence: 0.7, ok: true, rank: 0,
      },
      {
        adapter: "reducto",
        normalized: { lines: [{ description: "A", quantity: 10 }, { description: "B", quantity: 22 }] },
        confidence: 0.8, ok: true, rank: 1,
      },
    ];
    const { lines } = __test__.voteLines(entries);
    expect(lines).toHaveLength(2);
    // Row 1 quantity disagrees: reducto (0.8) > claude (0.7).
    expect(lines[1].quantity).toBe(22);
  });
});

describe("voter / voteAcrossAdapters end-to-end", () => {
  it("returns null when fewer than 2 adapters succeeded", () => {
    expect(voteAcrossAdapters([])).toBeNull();
    expect(voteAcrossAdapters([adapter("claude", { customer: {} }, 0.9, 0)])).toBeNull();
  });

  it("produces a voted normalized + field provenance + voter_lines", () => {
    const a = adapter("claude", {
      classification: "po",
      customer: { name: "Acme", gstin: "27AAACA1234B1Z5", currency: "INR" },
      lines: [{ partNumber: "X", quantity: 5, unitPrice: 100 }],
    }, 0.95, 0);
    const b = adapter("reducto", {
      classification: "po",
      customer: { name: "Acme", gstin: "27AAACA1234B1Z5", currency: "INR" },
      lines: [{ partNumber: "X", quantity: 5, unitPrice: 100 }],
    }, 0.85, 1);
    const out = voteAcrossAdapters([a, b]);
    expect(out).not.toBeNull();
    expect(out.voter_used).toBe(true);
    expect(out.adapter_used).toBe("voter");
    expect(out.normalized.customer).toMatchObject({
      name: "Acme",
      gstin: "27AAACA1234B1Z5",
      currency: "INR",
    });
    expect(out.normalized.classification).toBe("po");
    expect(out.normalized.lines).toHaveLength(1);
    expect(out.field_provenance.find((p) => p.field === "customer.gstin").value).toBe("27AAACA1234B1Z5");
    expect(out.voter_lines).toHaveLength(1);
    expect(out.voter_lines[0].fields.partNumber.source).toMatch(/^(claude|reducto)$/);
    // Confidence aggregation: average of winning fields, > 0.
    expect(out.confidence_overall).toBeGreaterThan(0);
  });
});
