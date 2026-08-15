// Suggested actions are derived, not generated.
//
// Every chip comes from a check that already ran. That is what makes the panel
// free to open: no model call fires until the operator sends something. These
// tests pin the derivation, and — more importantly — pin that a chip always
// names the check that produced it, so an operator can tell the difference
// between a real finding and a guess.

import { describe, it, expect } from "vitest";
import { suggestionsForOrder } from "./agent-suggestions";

describe("anomaly-driven suggestions", () => {
  it("turns the printed-line-number gap into an answerable question", () => {
    const [s] = suggestionsForOrder({
      anomalies: [{ code: "printed_line_number_gap", severity: "error", actual: 44, expected: 45 }],
    });
    expect(s.severity).toBe("error");
    expect(s.text).toContain("45");
    expect(s.text).toContain("44");
    expect(s.source).toContain("printed_line_number_gap");
  });

  it("states both totals AND the difference for a shortfall", () => {
    // "Some value appears to be missing" gives an operator nothing to act on.
    const [s] = suggestionsForOrder({
      anomalies: [{ code: "document_total_shortfall", severity: "warn", actual: 1788516.32, expected: 1825261.52 }],
    });
    expect(s.text).toMatch(/18,25,261/);
    expect(s.text).toMatch(/17,88,516/);
    expect(s.text).toMatch(/36,745/);          // the gap, computed
  });

  it("falls back to the raw detail for an anomaly code it does not know", () => {
    // A new anomaly should degrade to something readable, never to silence.
    const [s] = suggestionsForOrder({
      anomalies: [{ code: "some_future_check", severity: "warn", detail: "three lines disagree with the tax summary" }],
    });
    expect(s.text).toContain("three lines disagree");
    expect(s.source).toContain("some_future_check");
  });

  it("skips an unknown anomaly that carries no detail either", () => {
    const out = suggestionsForOrder({ anomalies: [{ code: "mystery", severity: "warn" }] });
    expect(out.every((s) => s.id !== "anomaly:mystery")).toBe(true);
  });

  it("emits one chip per check however many rows tripped it", () => {
    const out = suggestionsForOrder({
      anomalies: [
        { code: "line_arithmetic_mismatch", severity: "warn" },
        { code: "line_arithmetic_mismatch", severity: "warn" },
        { code: "line_arithmetic_mismatch", severity: "warn" },
      ],
    });
    expect(out.filter((s) => s.id === "anomaly:line_arithmetic_mismatch")).toHaveLength(1);
  });
});

describe("findings and unmatched lines", () => {
  it("summarises validator findings into one chip", () => {
    const out = suggestionsForOrder({
      findings: [{ code: "a", severity: "error" }, { code: "b", severity: "warn" }],
    });
    const f = out.find((s) => s.id === "findings:all");
    expect(f?.severity).toBe("error");           // worst severity wins
    expect(f?.text).toContain("2 validation");
  });

  it("flags lines with no item-master match", () => {
    const out = suggestionsForOrder({
      lines: [{ item_id: "x" }, {}, {}],
    });
    const u = out.find((s) => s.id === "lines:unmatched");
    expect(u?.text).toContain("2 of 3");
  });

  it("accepts any of the three id spellings a matched line may carry", () => {
    const out = suggestionsForOrder({
      lines: [{ item_id: "a" }, { itemId: "b" }, { matched_item_id: "c" }],
    });
    expect(out.find((s) => s.id === "lines:unmatched")).toBeUndefined();
  });
});

describe("ordering and bounds", () => {
  it("puts errors before warnings before info", () => {
    const out = suggestionsForOrder({
      anomalies: [
        { code: "unit_price_zero", severity: "warn" },
        { code: "printed_line_number_gap", severity: "error", actual: 1, expected: 2 },
      ],
      lines: [{}],
    });
    expect(out[0].severity).toBe("error");
  });

  it("caps the list so the panel never becomes a wall", () => {
    const anomalies = Object.keys({
      printed_line_number_gap: 1, document_total_shortfall: 1, parser_conservation_gap: 1,
      parser_rows_misaligned: 1, line_count_shortfall: 1, line_arithmetic_mismatch: 1,
      unit_price_zero: 1, quantity_zero: 1,
    }).map((code) => ({ code, severity: "warn" }));
    expect(suggestionsForOrder({ anomalies }).length).toBeLessThanOrEqual(5);
  });
});

describe("the empty case", () => {
  // A panel that opens with nothing to click reads as broken.
  it("always offers at least one thing to ask", () => {
    const out = suggestionsForOrder({});
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("always available");
  });

  it("names the PO in the fallback when one is known", () => {
    const [s] = suggestionsForOrder({ poNumber: "0066026562" });
    expect(s.text).toContain("0066026562");
  });

  it("does not offer the fallback once a real signal exists", () => {
    const out = suggestionsForOrder({ findings: [{ code: "x", severity: "warn" }] });
    expect(out.some((s) => s.id === "default:summarise")).toBe(false);
  });
});

describe("every suggestion is attributable", () => {
  it("carries a non-empty source, so no chip looks invented", () => {
    const out = suggestionsForOrder({
      anomalies: [{ code: "document_total_shortfall", severity: "warn", actual: 1, expected: 2 }],
      findings: [{ code: "x", severity: "warn" }],
      lines: [{}],
    });
    expect(out.length).toBeGreaterThan(1);
    for (const s of out) expect(s.source.trim()).not.toBe("");
  });

  it("survives null and undefined inputs without throwing", () => {
    expect(() => suggestionsForOrder({ anomalies: null, findings: null, lines: null })).not.toThrow();
  });
});
