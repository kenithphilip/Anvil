// Unit tests for the operator-actions state machine + reconcile-contract
// validation (_lib/operator-actions.js). Pure, no I/O.

import { describe, it, expect } from "vitest";
import { nextState, validateReconcileContract, TERMINAL } from "../api/_lib/operator-actions.js";

describe("nextState", () => {
  it("walks the happy path proposed -> in_progress -> evidence_captured -> reconciled", () => {
    expect(nextState("proposed", "start")).toEqual({ ok: true, status: "in_progress" });
    expect(nextState("in_progress", "attach_evidence")).toEqual({ ok: true, status: "evidence_captured" });
    expect(nextState("evidence_captured", "reconcile", { requiresEvidence: true, hasEvidence: true })).toEqual({ ok: true, status: "reconciled" });
  });

  it("allows abandon from any non-terminal state", () => {
    expect(nextState("proposed", "abandon").status).toBe("abandoned");
    expect(nextState("in_progress", "abandon").status).toBe("abandoned");
    expect(nextState("evidence_captured", "abandon").status).toBe("abandoned");
  });

  it("rejects illegal transitions", () => {
    expect(nextState("proposed", "reconcile").error).toMatch(/illegal/);
    expect(nextState("reconciled", "start").error).toMatch(/illegal/);
    expect(nextState("abandoned", "reconcile").error).toMatch(/illegal/);
    expect(nextState("bogus", "start").error).toMatch(/unknown state/);
  });

  it("blocks reconcile when evidence is required but absent", () => {
    expect(nextState("in_progress", "reconcile", { requiresEvidence: true, hasEvidence: false }).error).toMatch(/evidence required/);
    // when evidence not required, reconcile from in_progress is allowed
    expect(nextState("in_progress", "reconcile", { requiresEvidence: false }).status).toBe("reconciled");
  });

  it("keeps the action in place for advance_step", () => {
    expect(nextState("in_progress", "advance_step").status).toBe("in_progress");
    expect(nextState("evidence_captured", "advance_step").status).toBe("evidence_captured");
  });

  it("marks terminal states", () => {
    expect(TERMINAL.has("reconciled")).toBe(true);
    expect(TERMINAL.has("abandoned")).toBe(true);
    expect(TERMINAL.has("in_progress")).toBe(false);
  });
});

describe("validateReconcileContract", () => {
  it("accepts a note contract (no SOR mutation -> write)", () => {
    expect(validateReconcileContract({ type: "note", text: "Keyed into legacy SAP" }))
      .toEqual({ ok: true, type: "note", mutatesSor: false });
  });
  it("accepts a guarded order-status contract (SOR mutation -> approve)", () => {
    const r = validateReconcileContract({ type: "status", target: { object_type: "order", object_id: "o1" }, set: { field: "status", value: "APPROVED" } });
    expect(r).toEqual({ ok: true, type: "status", mutatesSor: true });
  });
  it("rejects unsupported types and malformed contracts", () => {
    expect(validateReconcileContract({ type: "delete_everything" }).error).toMatch(/unsupported/);
    expect(validateReconcileContract({ type: "note" }).error).toMatch(/text/);
    expect(validateReconcileContract({ type: "status", target: { object_type: "invoice", object_id: "i1" }, set: { field: "status", value: "APPROVED" } }).error).toMatch(/order/);
    expect(validateReconcileContract({ type: "status", target: { object_type: "order", object_id: "o1" }, set: { field: "total", value: 5 } }).error).toMatch(/only set field 'status'/);
    expect(validateReconcileContract({ type: "status", target: { object_type: "order", object_id: "o1" }, set: { field: "status", value: "NONSENSE" } }).error).toMatch(/invalid order status/);
    expect(validateReconcileContract(null).error).toMatch(/required/);
  });
});
