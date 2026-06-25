// Operator actions - pure state machine + reconcile-contract validation
// (PR4). No I/O; the endpoints call these then persist. See
// docs/OPERATOR_ACTIONS_DESIGN.md.

// Allowed transitions. advance_step / attach_evidence keep the action in
// place (or move in_progress -> evidence_captured for attach_evidence).
const TRANSITIONS = {
  proposed: { start: "in_progress", abandon: "abandoned" },
  in_progress: { attach_evidence: "evidence_captured", advance_step: "in_progress", reconcile: "reconciled", abandon: "abandoned" },
  evidence_captured: { attach_evidence: "evidence_captured", advance_step: "evidence_captured", reconcile: "reconciled", abandon: "abandoned" },
  reconciled: {},
  abandoned: {},
};

export const TERMINAL = new Set(["reconciled", "abandoned"]);

// nextState(current, event, { requiresEvidence, hasEvidence })
//   -> { ok: true, status } | { error }
export const nextState = (current, event, opts = {}) => {
  const t = TRANSITIONS[current];
  if (!t) return { error: "unknown state: " + current };
  const to = t[event];
  if (!to) return { error: "illegal transition: " + event + " from " + current };
  if (event === "reconcile" && opts.requiresEvidence && !opts.hasEvidence) {
    return { error: "evidence required before reconcile" };
  }
  return { ok: true, status: to };
};

export const SUPPORTED_RECONCILE = ["note", "status"];

// Order statuses a reconcile may set (mirrors orders/index.js STATUS_VALUES).
const ORDER_STATUSES = new Set([
  "DRAFT", "PENDING_REVIEW", "APPROVED", "BLOCKED", "DUPLICATE", "REUSED",
  "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT", "RECONCILED", "CANCELLED",
]);

// validateReconcileContract(contract) -> { ok, type, mutatesSor } | { error }
// `note`   : append an audited note/event to the related object (no SOR
//            mutation) -> write.
// `status` : set orders.status to an allowed value (SOR mutation) ->
//            approve, behind the order's approval guard.
export const validateReconcileContract = (contract) => {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return { error: "reconcile_contract required" };
  }
  const type = contract.type;
  if (!SUPPORTED_RECONCILE.includes(type)) return { error: "unsupported reconcile type: " + String(type) };

  if (type === "note") {
    if (!contract.text || typeof contract.text !== "string") return { error: "note reconcile requires text" };
    return { ok: true, type, mutatesSor: false };
  }

  // status
  const target = contract.target || {};
  if (target.object_type !== "order" || !target.object_id) {
    return { error: "status reconcile requires target { object_type: 'order', object_id }" };
  }
  const set = contract.set || {};
  if (set.field !== "status") return { error: "status reconcile may only set field 'status'" };
  if (!ORDER_STATUSES.has(set.value)) return { error: "invalid order status: " + String(set.value) };
  return { ok: true, type, mutatesSor: true };
};
