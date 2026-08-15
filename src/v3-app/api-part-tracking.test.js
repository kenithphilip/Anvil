// "Where is my TNA-16-04-40-2?"
//
// shipment_import has persisted per-part rows into shipment_lines (mig 209)
// since #393, and exactly one thing read them — the Pending Sales Order
// tracker, server-side. So the data to answer a customer's question was already
// in the database and nothing could ask it; an operator answered from the
// spreadsheet the import exists to replace.

import { describe, it, expect } from "vitest";
import { sanitiseTerm, buildOrFilter, ladderStage } from "../api/sales/part_tracking.js";

describe("sanitiseTerm", () => {
  it("keeps a part number's meaningful characters", () => {
    expect(sanitiseTerm(" TNA-16-04-40-2 ")).toBe("TNA-16-04-40-2");
  });

  // PostgREST's `or=` is comma-separated and treats , ( ) . as syntax. A raw
  // term carrying them would break the filter or, worse, silently alter it.
  it.each([
    ["X-HD0420-3,extra", "X-HD0420-3 extra"],
    ["PSD-100 (SEAL)", "PSD-100 SEAL"],
    ["A.B.C", "A B C"],
    ["a**b", "a b"],
  ])("strips PostgREST syntax from %p", (input, expected) => {
    expect(sanitiseTerm(input)).toBe(expected);
  });

  it("collapses whitespace so a stray double space still matches", () => {
    expect(sanitiseTerm("PSD-100   SEAL")).toBe("PSD-100 SEAL");
  });

  it.each([null, undefined, "", "   ", "..."])("returns empty for %p", (v) => {
    expect(sanitiseTerm(v)).toBe("");
  });
});

describe("buildOrFilter", () => {
  it("searches part_no AND description", () => {
    // Searching only part_no would miss the Thailand sheet's 672 rows, which
    // leave Part Number blank and put the code inside the description.
    const f = buildOrFilter("SB36466");
    expect(f).toContain("part_no.ilike.%SB36466%");
    expect(f).toContain("description.ilike.%SB36466%");
  });

  it("returns null for a term with nothing left after sanitising", () => {
    // The caller turns this into a 400. Returning a match-everything filter
    // would be a 34,000-row response that looks like a working search.
    expect(buildOrFilter("")).toBeNull();
    expect(buildOrFilter(",,,")).toBeNull();
    expect(buildOrFilter(null)).toBeNull();
  });

  it("does not let a term inject an extra or-clause", () => {
    const f = buildOrFilter("X,tenant_id.neq.0");
    expect(f.match(/ilike/g)).toHaveLength(2);   // exactly the two we built
  });
});

describe("ladderStage", () => {
  // Derived from the shipment's DATES, not its free-text status, so the stage
  // can never disagree with the dates shown beside it.
  it("reports received when the line has a receipt date", () => {
    expect(ladderStage({}, { receipt_date: "2026-08-15" })).toBe("received");
  });

  it("reports received from the shipment's warehouse receipt too", () => {
    expect(ladderStage({ warehouse_receipt_date: "2026-08-15" }, {})).toBe("received");
  });

  it("reports at_port once it has arrived but not been received", () => {
    expect(ladderStage({ port_arrival_date: "2026-08-12", vessel_sailing_date: "2026-08-01" }, {}))
      .toBe("at_port");
  });

  it("reports in_transit once it has sailed", () => {
    expect(ladderStage({ vessel_sailing_date: "2026-08-01" }, {})).toBe("in_transit");
  });

  it("reports booked when no hop has happened", () => {
    expect(ladderStage({}, {})).toBe("booked");
    expect(ladderStage({ status: "PLANNED" }, {})).toBe("booked");
  });

  it("prefers the furthest hop reached, not the first date present", () => {
    const s = { vessel_sailing_date: "2026-08-01", port_arrival_date: "2026-08-12", warehouse_receipt_date: "2026-08-15" };
    expect(ladderStage(s, {})).toBe("received");
  });

  it("ignores a status that contradicts the dates", () => {
    // A stale free-text status must not outrank a real arrival date.
    expect(ladderStage({ status: "PLANNED", port_arrival_date: "2026-08-12" }, {})).toBe("at_port");
  });

  it.each([null, undefined])("does not throw on %p", (v) => {
    expect(() => ladderStage(v, v)).not.toThrow();
    expect(ladderStage(v, v)).toBe("booked");
  });
});
