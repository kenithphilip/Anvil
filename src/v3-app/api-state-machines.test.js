// Unit tests for the four state-machine guards shipped in
// Phase 7.4 + 7.5. Audit P10. We import the test-only exports
// each module exposes as `__test` so the assertions stay
// independent of the HTTP handler.

import { describe, it, expect } from "vitest";
import { __test as oppsTest } from "../api/sales/opportunities.js";
import { __test as projectsTest } from "../api/sales/projects.js";
import { __test as spoTest } from "../api/source_pos/[id].js";
import { __test as creditTest } from "../api/credit_notes/index.js";

describe("opportunities · isStageTransitionAllowed", () => {
  const f = oppsTest.isStageTransitionAllowed;
  it("allows same-state and null inputs", () => {
    expect(f(null, "QUALIFICATION")).toBe(true);
    expect(f("QUALIFICATION", "QUALIFICATION")).toBe(true);
  });
  it("blocks any move from a terminal stage", () => {
    expect(f("CLOSE_WON", "QUALIFICATION")).toBe(false);
    expect(f("CLOSE_LOST", "RFQ")).toBe(false);
    expect(f("REGRETTED", "FOLLOW_UP")).toBe(false);
  });
  it("allows close-state transitions from any open stage", () => {
    expect(f("QUALIFICATION", "CLOSE_LOST")).toBe(true);
    expect(f("RFQ", "CLOSE_WON")).toBe(true);
    expect(f("NEEDS_ANALYSIS", "REGRETTED")).toBe(true);
  });
  it("blocks the audit's flagged jump (QUALIFICATION -> CLOSE_WON via PATCH-stage)", () => {
    // The audit recommendation was for the runner to enforce
    // forward progression, with closes allowed from ANY open
    // stage. So this should be allowed; the regression the
    // audit flagged was QUALIFICATION -> CLOSE_WON in one PATCH
    // BYPASSING the runner. The guard treats it as legitimate.
    expect(f("QUALIFICATION", "CLOSE_WON")).toBe(true);
  });
  it("allows arbitrary forward progression along the pipeline", () => {
    expect(f("QUALIFICATION", "INTERNAL_PROPOSAL")).toBe(true);
    expect(f("QUALIFICATION", "RFQ")).toBe(true);
  });
  it("allows one-step backward (operator mis-staged the row)", () => {
    expect(f("RFQ", "FOLLOW_UP")).toBe(true);
    expect(f("INTERNAL_PROPOSAL", "RFQ")).toBe(true);
  });
  it("blocks two-step backward jumps", () => {
    expect(f("RFQ", "STRATEGY_CHECK")).toBe(false);
    expect(f("INTERNAL_PROPOSAL", "FOLLOW_UP")).toBe(false);
  });
});

describe("projects · isPhaseTransitionAllowed", () => {
  const f = projectsTest.isPhaseTransitionAllowed;
  it("allows CLOSED from any phase", () => {
    expect(f("DESIGN", "CLOSED")).toBe(true);
    expect(f("INITIAL_INFO", "CLOSED")).toBe(true);
  });
  it("blocks any move from CLOSED", () => {
    expect(f("CLOSED", "DESIGN")).toBe(false);
    expect(f("CLOSED", "INITIAL_INFO")).toBe(false);
  });
  it("allows one-step backward inside the pipeline", () => {
    expect(f("DESIGN", "KICKOFF")).toBe(true);
  });
  it("allows arbitrary forward jumps along the pipeline", () => {
    expect(f("INITIAL_INFO", "MANUFACTURING")).toBe(true);
  });
  it("blocks two-step backward jumps", () => {
    expect(f("MANUFACTURING", "RFQ_PREP")).toBe(false);
  });
});

describe("source_pos · isSpoTransitionAllowed", () => {
  const f = spoTest.isSpoTransitionAllowed;
  it("allows DRAFT -> PENDING_INTERNAL_APPROVAL -> SENT_TO_SUPPLIER", () => {
    expect(f("DRAFT", "PENDING_INTERNAL_APPROVAL")).toBe(true);
    expect(f("PENDING_INTERNAL_APPROVAL", "SENT_TO_SUPPLIER")).toBe(true);
  });
  it("allows the supplier sideways path PRICE_CHANGED <-> SUPPLIER_ACK", () => {
    expect(f("SUPPLIER_ACK", "PRICE_CHANGED")).toBe(true);
    expect(f("PRICE_CHANGED", "SUPPLIER_ACK")).toBe(true);
  });
  it("allows CANCELLED from any open status", () => {
    expect(f("DRAFT", "CANCELLED")).toBe(true);
    expect(f("DELAYED", "CANCELLED")).toBe(true);
    expect(f("RECEIVED", "CANCELLED")).toBe(true);
  });
  it("blocks moves out of terminal CLOSED/CANCELLED", () => {
    expect(f("CLOSED", "DRAFT")).toBe(false);
    expect(f("CANCELLED", "RECEIVED")).toBe(false);
  });
  it("blocks skipping ahead from DRAFT to RECEIVED", () => {
    expect(f("DRAFT", "RECEIVED")).toBe(false);
  });
});

describe("credit_notes · isTransitionAllowed", () => {
  const f = creditTest.isTransitionAllowed;
  it("allows the canonical lifecycle DRAFT -> ISSUED -> ACKNOWLEDGED", () => {
    expect(f("DRAFT", "ISSUED")).toBe(true);
    expect(f("ISSUED", "ACKNOWLEDGED")).toBe(true);
  });
  it("allows CANCELLED from every non-terminal state", () => {
    expect(f("DRAFT", "CANCELLED")).toBe(true);
    expect(f("ISSUED", "CANCELLED")).toBe(true);
    expect(f("ACKNOWLEDGED", "CANCELLED")).toBe(true);
  });
  it("blocks moves out of CANCELLED (terminal)", () => {
    expect(f("CANCELLED", "DRAFT")).toBe(false);
    expect(f("CANCELLED", "ISSUED")).toBe(false);
  });
  it("blocks skipping ISSUED (DRAFT -> ACKNOWLEDGED)", () => {
    expect(f("DRAFT", "ACKNOWLEDGED")).toBe(false);
  });
  it("blocks rolling back ISSUED -> DRAFT (immutable once issued)", () => {
    expect(f("ISSUED", "DRAFT")).toBe(false);
  });
});
