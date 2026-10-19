// The order's execution stage: one answer, derived from records that already
// exist, that every order endpoint returns and every screen reads (plan R-M1,
// docs/SO_EXECUTION_COHESION.md section 4). PURE. No I/O. It writes nothing:
// orders.status keeps its meaning and no status value is added (C-D3).
//
// orderStage(order, evidence) returns
//   { stage, since, evidence_ref, holder_role, next_action }
//   stage         a key of STAGES. Stable: screens label it from STAGE_LABELS.
//   since         ISO time the order entered the stage, or null.
//   evidence_ref  the record that puts the order in the stage:
//                 "orders.<column>", "order_documents:<document id>" (an
//                 attached ERP SO) or "extraction_jobs:<job id>".
//   holder_role   the role that owes the next move ("system" while a job
//                 runs); null when nothing is owed.
//   next_action   what the holder does next: an ACTIONS key of
//                 order-next-step.js, which turns it into the button.
//
// order     an orders row with at least STAGE_COLUMNS.
// evidence  mode            "A" (Anvil pushes to Tally) or "B" (the team keys
//                           the SO into Tally by hand)
//           erp_so          the ERP sales orders linked to the order
//                           (order_documents role 'sales_order'):
//                           [{ document_id }], or null
//           extraction_job  the in-flight background extraction job
//                           ({ id, created_at }), or null
//           approver_role   the open threshold's approver_role, when known
//
// The ladder. Mode A has no handoff and reads its push states.
//   cancelled         CANCELLED
//   received          a background extraction job is still reading the PO
//   returned          DRAFT with a correction reason (sent back by a return)
//   verifying         DRAFT, BLOCKED, DUPLICATE, REUSED; or an approved order
//                     whose approval a later edit cleared (the revision rule)
//   in_approval       PENDING_REVIEW. A handoff or a keyed entry made before
//                     the approval does not move it on: "Keyed" needs both
//                     the approval and the entry (C-D11).
//   approved          approved; in Mode B not handed off yet, or the order
//                     changed since the handoff (re-send is the next step)
//   handed_off        Mode B, handoff_status 'sent' for the order as it is
//   keyed_unverified  Mode B, tally_status 'imported' and no Tally SO PDF
//                     attached (C-D4: a manual exit stays unverified)
//   keyed             Mode B, a Tally SO PDF attached; Mode A,
//                     EXPORTED_TO_TALLY
//   verified          Mode B, tally_status 'reconciled'; Mode A, RECONCILED
//
// Keyed evidence also closes the handoff: an entry the clerk made proves the
// order reached the clerk, whatever rail carried it (R-F3 item 4).
//
// shortcut: since falls back to updated_at where no column records the
// stage's start (in approval, revised, keyed, verified, cancelled), so a
// later write moves it; upgrade when C-27 reads the submit and keyed audit
// rows.

export const STAGES = Object.freeze([
  "received", "verifying", "returned", "in_approval", "approved", "handed_off",
  "keyed_unverified", "keyed", "verified", "cancelled",
]);

export const STAGE_LABELS = Object.freeze({
  received: "Received",
  verifying: "Verifying",
  returned: "Returned for correction",
  in_approval: "In approval",
  approved: "Approved",
  handed_off: "Handed off",
  keyed_unverified: "Keyed, unverified",
  keyed: "Keyed in ERP",
  verified: "Verified in ERP",
  cancelled: "Cancelled",
});

// The orders columns the stage reads. Every select that returns a stage
// includes them.
export const STAGE_COLUMNS = Object.freeze([
  "id", "status", "created_at", "updated_at", "approval", "approved_at", "payload_hash",
  "correction_reason", "correction_requested_at", "tally_status",
  "handoff_status", "handoff_sent_at", "handoff_payload",
]);

// A select list with the stage columns added once.
export const withStageColumns = (cols) => [...new Set([...cols, ...STAGE_COLUMNS])].join(", ");

// Approved by status; Anvil has not pushed it (or the push failed).
const APPROVED_STATUSES = new Set(["APPROVED", "FAILED_TALLY_IMPORT"]);

const S = (stage, since, evidence_ref, holder_role, next_action) =>
  ({ stage, since: since || null, evidence_ref, holder_role, next_action });

const approvedStage = (o, mode, erpSo) => {
  if (mode !== "B") return S("approved", o.approved_at, "orders.approved_at", "sales_engineer", "push_to_tally");
  const sent = o.handoff_status === "sent";
  // The handoff stores the payload hash it sent (handoff_payload.payload_hash,
  // written by C-18). A handoff with no stored hash cannot show that it
  // matches the order, so it asks for a re-send too.
  if (sent && (o.handoff_payload?.payload_hash || null) !== (o.payload_hash || null)) {
    return S("approved", o.approved_at, "orders.handoff_payload", "sales_engineer", "resend_handoff");
  }
  if (o.tally_status === "reconciled") return S("verified", o.updated_at, "orders.tally_status", null, "none");
  const doc = Array.isArray(erpSo) && erpSo.length ? erpSo[0] : null;
  if (doc) return S("keyed", o.updated_at, "order_documents:" + doc.document_id, "sales_engineer", "verify_in_erp");
  if (o.tally_status === "imported") return S("keyed_unverified", o.updated_at, "orders.tally_status", "sales_engineer", "attach_erp_so");
  if (sent) return S("handed_off", o.handoff_sent_at, "orders.handoff_status", "operator", "enter_in_tally");
  return S("approved", o.approved_at, "orders.approved_at", "sales_engineer", "send_handoff");
};

export const orderStage = (order, { mode = "A", erp_so = null, extraction_job = null, approver_role = null } = {}) => {
  const o = order || {};
  const status = o.status;
  if (status === "CANCELLED") return S("cancelled", o.updated_at, "orders.status", null, "none");
  if (status === "RECONCILED") return S("verified", o.updated_at, "orders.status", null, "none");
  if (status === "EXPORTED_TO_TALLY") return S("keyed", o.updated_at, "orders.status", "sales_engineer", "verify_in_erp");
  if (status === "PENDING_REVIEW") return S("in_approval", o.updated_at, "orders.status", approver_role || "sales_manager", "approve");
  if (APPROVED_STATUSES.has(status) && o.approval) return approvedStage(o, mode, erp_so);
  if (extraction_job) return S("received", extraction_job.created_at, "extraction_jobs:" + extraction_job.id, "system", "wait_for_extraction");
  // The revision rule (C-D2): a line edit clears the approval and leaves the
  // status APPROVED. The order is verified and sent for approval again.
  if (APPROVED_STATUSES.has(status)) return S("verifying", o.updated_at, "orders.approval", "sales_engineer", "resubmit_for_approval");
  if (status === "DRAFT" && o.correction_reason) {
    return S("returned", o.correction_requested_at, "orders.correction_reason", "sales_engineer", "submit_for_approval");
  }
  // BLOCKED, DUPLICATE and REUSED have no forward step: the engineer returns
  // the order to DRAFT or cancels it.
  return S("verifying", o.created_at, "orders.status", "sales_engineer", status === "DRAFT" ? "submit_for_approval" : "none");
};
