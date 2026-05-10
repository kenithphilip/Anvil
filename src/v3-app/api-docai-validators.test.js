// Phase A: shared validators (L5).
//
// Locks the contract that:
//   - GSTIN / state-code / HSN / currency / line-math rules emit
//     the right structured issues.
//   - Confidence is downgraded to <0.7 on any error issue (so the
//     dispatcher's threshold flips the run to low_confidence).
//   - 3+ warns downgrade confidence to <0.8 (soft warning banner).
//   - A clean extraction returns no issues and leaves confidence
//     untouched.

import { describe, it, expect } from "vitest";
import {
  validateExtraction,
  summariseIssuesHeadline,
  GSTIN_REGEX,
  HSN_REGEX,
} from "../api/_lib/docai/validators.js";

const cleanCustomer = {
  name: "Acme Industries Pvt Ltd",
  gstin: "27AAACA1234B1Z5",  // Maharashtra, valid checksum-shape
  state_code: "27",
  currency: "INR",
  payment_terms: "Net 30",
};
const cleanLine = {
  partNumber: "BRG-6204-ZZ",
  description: "Deep groove ball bearing",
  quantity: 100,
  unitPrice: 125,
  hsn: "8482",
  gst_pct: 18,
};

describe("validators / regex constants", () => {
  it("GSTIN_REGEX matches the canonical Indian shape", () => {
    expect(GSTIN_REGEX.test("27AAACA1234B1Z5")).toBe(true);
    expect(GSTIN_REGEX.test("not-a-gstin")).toBe(false);
    // Wrong length
    expect(GSTIN_REGEX.test("27AAACA1234B1Z")).toBe(false);
    // Lowercase letters not allowed
    expect(GSTIN_REGEX.test("27aaaca1234b1z5")).toBe(false);
  });

  it("HSN_REGEX accepts 4 to 8 digits", () => {
    expect(HSN_REGEX.test("8482")).toBe(true);
    expect(HSN_REGEX.test("84821011")).toBe(true);
    expect(HSN_REGEX.test("84")).toBe(false);
    expect(HSN_REGEX.test("84A")).toBe(false);
  });
});

describe("validators / clean extraction", () => {
  it("emits no issues and leaves confidence unchanged", () => {
    const out = validateExtraction(
      { customer: cleanCustomer, lines: [cleanLine] },
      { currentConfidence: 0.93 },
    );
    expect(out.issues).toHaveLength(0);
    expect(out.summary).toMatchObject({ error: 0, warn: 0, info: 0, total: 0 });
    expect(out.adjustedConfidence).toBe(0.93);
  });
});

describe("validators / GSTIN", () => {
  it("flags malformed GSTIN as error", () => {
    const out = validateExtraction({
      customer: { ...cleanCustomer, gstin: "27INVALID00000ZZ" },
      lines: [cleanLine],
    });
    expect(out.issues.some((i) => i.field === "customer.gstin" && i.code === "gstin_malformed")).toBe(true);
    expect(out.summary.error).toBeGreaterThan(0);
  });

  it("flags state_code mismatch as error when GSTIN prefix differs", () => {
    const out = validateExtraction({
      customer: { ...cleanCustomer, gstin: "27AAACA1234B1Z5", state_code: "29" },
      lines: [cleanLine],
    });
    const mismatch = out.issues.find((i) => i.code === "state_code_gstin_mismatch");
    expect(mismatch).toBeTruthy();
    expect(mismatch.severity).toBe("error");
  });
});

describe("validators / currency", () => {
  it("warns on uncommon currency", () => {
    const out = validateExtraction({
      customer: { ...cleanCustomer, currency: "ZAR" },
      lines: [cleanLine],
    });
    const issue = out.issues.find((i) => i.code === "currency_uncommon");
    expect(issue).toBeTruthy();
    expect(issue.severity).toBe("warn");
  });

  it("errors on malformed currency string", () => {
    const out = validateExtraction({
      customer: { ...cleanCustomer, currency: "rupees" },
      lines: [cleanLine],
    });
    expect(out.issues.some((i) => i.code === "currency_malformed")).toBe(true);
  });
});

describe("validators / line-level rules", () => {
  it("flags malformed HSN as error", () => {
    const out = validateExtraction({
      customer: cleanCustomer,
      lines: [{ ...cleanLine, hsn: "84" }],
    });
    expect(out.issues.some((i) => i.field === "lines[0].hsn" && i.code === "hsn_malformed")).toBe(true);
  });

  it("warns on non-positive quantity", () => {
    const out = validateExtraction({
      customer: cleanCustomer,
      lines: [{ ...cleanLine, quantity: 0 }],
    });
    expect(out.issues.some((i) => i.code === "qty_non_positive" && i.severity === "warn")).toBe(true);
  });

  it("errors when lineTotal disagrees with quantity * unitPrice", () => {
    const out = validateExtraction({
      customer: cleanCustomer,
      lines: [{ ...cleanLine, quantity: 100, unitPrice: 125, lineTotal: 9999 }],
    });
    expect(out.issues.some((i) => i.code === "line_total_mismatch")).toBe(true);
  });

  it("warns on uncommon GST percentage", () => {
    const out = validateExtraction({
      customer: cleanCustomer,
      lines: [{ ...cleanLine, gst_pct: 7 }],
    });
    expect(out.issues.some((i) => i.code === "gst_pct_uncommon")).toBe(true);
  });
});

describe("validators / confidence adjustment", () => {
  it("downgrades to <0.7 on any error", () => {
    const out = validateExtraction(
      { customer: { ...cleanCustomer, gstin: "BAD" }, lines: [cleanLine] },
      { currentConfidence: 0.95 },
    );
    expect(out.adjustedConfidence).toBeLessThan(0.7);
  });

  it("downgrades to <0.8 on 3+ warnings", () => {
    const out = validateExtraction(
      {
        customer: { ...cleanCustomer, currency: "ZAR" },                // warn
        lines: [
          { ...cleanLine, gst_pct: 7 },                                  // warn
          { ...cleanLine, quantity: 0 },                                 // warn
          cleanLine,
        ],
      },
      { currentConfidence: 0.95 },
    );
    expect(out.summary.warn).toBeGreaterThanOrEqual(3);
    expect(out.adjustedConfidence).toBeLessThan(0.8);
    expect(out.adjustedConfidence).toBeGreaterThanOrEqual(0.7);
  });

  it("returns null when no input confidence is supplied", () => {
    const out = validateExtraction({ customer: cleanCustomer, lines: [cleanLine] }, {});
    expect(out.adjustedConfidence).toBeNull();
  });
});

describe("validators / summariseIssuesHeadline", () => {
  it("returns a no-issues string when total is zero", () => {
    expect(summariseIssuesHeadline({ error: 0, warn: 0, info: 0, total: 0 })).toMatch(/no validator/i);
  });

  it("composes counts in order error -> warn -> info", () => {
    expect(summariseIssuesHeadline({ error: 2, warn: 1, info: 0, total: 3 })).toMatch(/2 errors, 1 warning/);
  });
});
