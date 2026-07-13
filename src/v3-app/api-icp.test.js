// Unit tests for src/api/_lib/icp.js — the pure ICP fit scorer.

import { describe, it, expect } from "vitest";
import { scoreCustomer, evalRule, DEFAULT_ICP_PROFILE } from "../api/_lib/icp.js";

describe("evalRule operators", () => {
  const a = { customer_type: "OEM", country: "IN", employees: "1200", gstin: "27AAACO8335K1Z5", trade_name: "" };
  it("equals / in are case-insensitive and require a value", () => {
    expect(evalRule(a, { attribute_key: "country", op: "equals", value: "in" })).toBe(true);
    expect(evalRule(a, { attribute_key: "customer_type", op: "in", value: ["OEM", "Tier-1"] })).toBe(true);
    expect(evalRule(a, { attribute_key: "customer_type", op: "in", value: ["Distributor"] })).toBe(false);
  });
  it("exists / absent treat blank as empty", () => {
    expect(evalRule(a, { attribute_key: "gstin", op: "exists" })).toBe(true);
    expect(evalRule(a, { attribute_key: "trade_name", op: "exists" })).toBe(false); // blank string
    expect(evalRule(a, { attribute_key: "missing", op: "absent" })).toBe(true);
  });
  it("gte / lte / range coerce numbers", () => {
    expect(evalRule(a, { attribute_key: "employees", op: "gte", value: 1000 })).toBe(true);
    expect(evalRule(a, { attribute_key: "employees", op: "lte", value: 500 })).toBe(false);
    expect(evalRule(a, { attribute_key: "employees", op: "range", value: [500, 2000] })).toBe(true);
  });
  it("matches is a case-insensitive regex", () => {
    expect(evalRule(a, { attribute_key: "customer_type", op: "matches", value: "oem" })).toBe(true);
  });
});

describe("scoreCustomer", () => {
  it("perfect fit against the default profile scores high (tier A)", () => {
    const attrs = {
      customer_type: "OEM", gst_status: "Active", country: "IN",
      industry_segment: "Automotive", parent_customer_id: "abc", gstin: "27AAACO8335K1Z5",
    };
    const r = scoreCustomer(attrs);
    expect(r.score).toBe(100);
    expect(r.tier).toBe("A");
    expect(r.signals.matched.length).toBe(DEFAULT_ICP_PROFILE.rules.length);
    expect(r.signals.missed).toEqual([]);
  });
  it("partial fit lands mid-tier and lists what's missing", () => {
    const attrs = { customer_type: "OEM", gstin: "27AAACO8335K1Z5" }; // 30 + 10 = 40 / 100
    const r = scoreCustomer(attrs);
    expect(r.score).toBe(40);
    expect(r.tier).toBe("B");
    expect(r.signals.missed).toContain("GST registration Active");
  });
  it("poor fit is tier C", () => {
    const r = scoreCustomer({ customer_type: "Distributor" });
    expect(r.score).toBe(0);
    expect(r.tier).toBe("C");
  });
  it("a failed hard gate disqualifies (tier Out)", () => {
    const profile = {
      ...DEFAULT_ICP_PROFILE,
      gate: [{ attribute_key: "gst_status", op: "equals", value: "Active", label: "GST must be Active" }],
    };
    const r = scoreCustomer({ customer_type: "OEM", gst_status: "Cancelled" }, profile);
    expect(r.tier).toBe("Out");
    expect(r.score).toBe(0);
    expect(r.signals.gate_failed).toContain("GST must be Active");
  });
  it("respects a custom tenant rubric (weights + tiers)", () => {
    const profile = {
      name: "SaaS ICP",
      gate: [],
      rules: [{ attribute_key: "country", op: "in", value: ["US", "UK"], weight: 100, label: "Target geo" }],
      tiers: [{ min: 80, tier: "Ideal" }, { min: 0, tier: "Out-of-profile" }],
    };
    expect(scoreCustomer({ country: "US" }, profile)).toMatchObject({ score: 100, tier: "Ideal" });
    expect(scoreCustomer({ country: "IN" }, profile)).toMatchObject({ score: 0, tier: "Out-of-profile" });
  });
  // P3: the compute layer derives gstin_valid ("valid"/"invalid") with a local
  // checksum -- no external call -- so a rubric can gate/score on it today.
  it("can gate on the derived gstin_valid attribute (checksum proxy)", () => {
    const profile = {
      gate: [{ attribute_key: "gstin_valid", op: "equals", value: "valid", label: "Registered business (valid GSTIN)" }],
      rules: [{ attribute_key: "customer_type", op: "equals", value: "OEM", weight: 100 }],
      tiers: [{ min: 50, tier: "A" }, { min: 0, tier: "C" }],
    };
    expect(scoreCustomer({ customer_type: "OEM", gstin_valid: "valid" }, profile)).toMatchObject({ tier: "A" });
    const bad = scoreCustomer({ customer_type: "OEM", gstin_valid: "invalid" }, profile);
    expect(bad.tier).toBe("Out");
    expect(bad.signals.gate_failed).toContain("Registered business (valid GSTIN)");
  });
  it("can weight the derived gstin_valid attribute as a scoring rule", () => {
    const profile = {
      gate: [],
      rules: [{ attribute_key: "gstin_valid", op: "equals", value: "valid", weight: 100, label: "Valid GSTIN" }],
      tiers: [{ min: 80, tier: "A" }, { min: 0, tier: "C" }],
    };
    expect(scoreCustomer({ gstin_valid: "valid" }, profile).tier).toBe("A");
    expect(scoreCustomer({ gstin_valid: "invalid" }, profile).tier).toBe("C");
    expect(scoreCustomer({ gstin_present: "no" }, profile).tier).toBe("C");
  });
});
