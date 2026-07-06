// Smoke tests for the shared helpers. These exist to prove the Vitest +
// Vite + jsdom chain works end-to-end. Real coverage will land alongside
// each screen conversion in Sub-PR 3.

import { describe, it, expect } from "vitest";
import { ageLabel, fmtINRShort, stageOf, sevOf, draftLabel } from "./helpers";

describe("ageLabel", () => {
  it("returns em-dash for nullish input", () => {
    expect(ageLabel(null)).toBe("—");
    expect(ageLabel(undefined)).toBe("—");
  });

  it("formats minutes under an hour", () => {
    const iso = new Date(Date.now() - 14 * 60_000).toISOString();
    expect(ageLabel(iso)).toBe("14m");
  });

  it("formats hours under a day", () => {
    const iso = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(ageLabel(iso)).toBe("3h");
  });

  it("formats days with optional residual hours", () => {
    const iso = new Date(Date.now() - (2 * 24 + 5) * 60 * 60_000).toISOString();
    expect(ageLabel(iso)).toBe("2d 5h");
  });
});

describe("fmtINRShort", () => {
  it("returns em-dash for null", () => {
    expect(fmtINRShort(null)).toBe("—");
  });

  it("formats lakhs above 10L", () => {
    expect(fmtINRShort(15_50_000)).toBe("₹ 15.5 L");
  });

  it("formats thousands above 1k", () => {
    expect(fmtINRShort(45_000)).toBe("₹ 45k");
  });

  it("formats small values with locale grouping", () => {
    expect(fmtINRShort(999)).toBe("₹ 999");
  });
});

describe("stageOf", () => {
  it("maps known status enums", () => {
    expect(stageOf("BLOCKED")).toEqual({ label: "blocked", k: "bad" });
    expect(stageOf("RECONCILED")).toEqual({ label: "shipped", k: "good" });
  });

  it("falls back to a ghost chip for unknown status", () => {
    const out = stageOf("WEIRD_STATE");
    expect(out.k).toBe("ghost");
    expect(out.label).toBe("weird_state");
  });
});

describe("sevOf", () => {
  it("returns high for blocked / failed-tally", () => {
    expect(sevOf({ status: "BLOCKED" })).toBe("high");
    expect(sevOf({ status: "FAILED_TALLY_IMPORT" })).toBe("high");
  });

  it("returns med for pending review / duplicate", () => {
    expect(sevOf({ status: "PENDING_REVIEW" })).toBe("med");
    expect(sevOf({ status: "DUPLICATE" })).toBe("med");
  });

  it("returns low otherwise", () => {
    expect(sevOf({ status: "APPROVED" })).toBe("low");
    expect(sevOf(null)).toBe("low");
  });
});

describe("draftLabel", () => {
  it("prefers po_number when present", () => {
    expect(draftLabel({ po_number: "P250432265", quote_number: "Q-1", id: "x" })).toBe("P250432265");
  });

  it("falls back to quote_number when no po_number", () => {
    expect(draftLabel({ po_number: null, quote_number: "OIQTLC-240123", id: "x" })).toBe("OIQTLC-240123");
  });

  it("builds <CUSTOMER>-<DDMMM>-<id4> when only customer + id are set", () => {
    const out = draftLabel({
      id: "8a3f1b2c-1234-5678-abcd-1111aaaa2222",
      created_at: "2026-05-19T10:00:00Z",
      customer: { customer_name: "Meridian Motor India Ltd" },
    });
    expect(out).toBe("MERID-19MAY-8a3f");
  });

  it("prefers customer_key over customer_name when both are present", () => {
    const out = draftLabel({
      id: "8a3f1b2c-1234",
      created_at: "2026-05-19T10:00:00Z",
      customer: { customer_key: "mmil_pune", customer_name: "Meridian Motor India Ltd" },
    });
    // customer_key wins, non-alnum stripped, uppercased, capped at 5
    expect(out).toBe("MMILP-19MAY-8a3f");
  });

  it("strips legal suffixes from customer_name before truncating", () => {
    // Without suffix stripping, "Summit Automation Pvt Ltd" would
    // start with "SUMMI" anyway, but a name like "MG Ltd" must yield
    // "MG", not include "Ltd" in the prefix.
    expect(draftLabel({
      id: "abcd",
      created_at: "2026-05-19T10:00:00Z",
      customer: { customer_name: "MG Ltd" },
    })).toBe("MG-19MAY-abcd");
  });

  it("falls back to DRAFT when there is no customer at all", () => {
    expect(draftLabel({
      id: "8a3f1b2c-1234",
      created_at: "2026-05-19T10:00:00Z",
    })).toBe("DRAFT-19MAY-8a3f");
  });

  it("uses NEW when created_at is missing or unparseable", () => {
    expect(draftLabel({
      id: "8a3f1b2c",
      customer: { customer_name: "Northwind Korea Co Ltd" },
    })).toBe("NORTH-NEW-8a3f");
  });

  it("returns literal 'draft' for nullish input so legacy renderers stay safe", () => {
    expect(draftLabel(null)).toBe("draft");
    expect(draftLabel(undefined)).toBe("draft");
  });

  it("does not lose the hex prefix when the id has no dashes", () => {
    expect(draftLabel({
      id: "deadbeef1234",
      created_at: "2026-05-19T10:00:00Z",
      customer: { customer_name: "Comet Motors" },
    })).toBe("COMET-19MAY-dead");
  });
});
