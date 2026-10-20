// Which status decisions an order can take from each status, and which moves
// an expired approval still allows. PURE. No I/O.
//
// The SO workspace reads the status lists, so it never offers a button that
// the server refuses (a "dead button": approve on a DRAFT, return for fix on a
// failed Tally import, cancel after an export). orders/[id].js reads the
// expiry rule. The server's ALLOWED_TRANSITIONS table in orders/[id].js stays
// the gate: api-order-status-actions.test.js runs that PATCH handler from
// every status, so these lists cannot drift from it.

// Every order status (the order_status enum).
export const ORDER_STATUSES = Object.freeze([
  "DRAFT", "PENDING_REVIEW", "APPROVED", "EXPORTED_TO_TALLY", "FAILED_TALLY_IMPORT",
  "RECONCILED", "CANCELLED", "BLOCKED", "DUPLICATE", "REUSED",
]);

// Cancel: every status the server lets move to CANCELLED. Not from
// EXPORTED_TO_TALLY (the voucher is in Tally) and not from CANCELLED.
export const CANCELLABLE_STATUSES = Object.freeze([
  "DRAFT", "PENDING_REVIEW", "APPROVED", "FAILED_TALLY_IMPORT", "RECONCILED",
  "BLOCKED", "DUPLICATE", "REUSED",
]);

// Return for fix: back to DRAFT, from every status the server allows except
// DRAFT itself. Not from FAILED_TALLY_IMPORT or later.
export const RETURNABLE_STATUSES = Object.freeze([
  "PENDING_REVIEW", "APPROVED", "BLOCKED", "DUPLICATE", "REUSED",
]);

// Approve: only while the order is pending review.
export const APPROVABLE_STATUSES = Object.freeze(["PENDING_REVIEW"]);

export const canCancelFrom = (status) => CANCELLABLE_STATUSES.includes(status);
export const canReturnFrom = (status) => RETURNABLE_STATUSES.includes(status);
export const canApproveFrom = (status) => APPROVABLE_STATUSES.includes(status);

// A move that WITHDRAWS the order from its approval: cancel, or return to
// DRAFT for a fix. It does not act on the approval.
export const WITHDRAW_STATUSES = Object.freeze(["CANCELLED", "DRAFT"]);

export const isWithdrawal = (prevStatus, nextStatus) =>
  !!nextStatus && nextStatus !== prevStatus && WITHDRAW_STATUSES.includes(nextStatus);

// How long an approval lasts in Mode A. The server sets it, never the client.
export const APPROVAL_TTL_MS = 24 * 3600 * 1000;

// True when an expired approval must refuse this PATCH with a 409.
//
// In Mode A the approval expires 24 h after it is given. That used to refuse
// EVERY status change, cancel and return included. A withdrawal does not rely
// on the approval, so it passes. Every move that does rely on the approval (an
// export to Tally, a failed import) is refused after the expiry.
//
// In Mode B an approval does not expire (C-11, decision C-D8): the order rests
// at APPROVED while a clerk keys the ERP, so an expiry only refused its later
// status moves. This includes an approval stored with a 24 h expiry before
// C-11. A line edit still clears the approval (orders/[id].js).
//
// An approval given in Mode B has no stored expiry. If the tenant is now in
// Mode A, it expires 24 h after approved_at, so it does not escape the rule.
export const approvalExpiryBlocks = ({ prev, body, intendedAction = null, modeB = false, now = Date.now() } = {}) => {
  if (!prev || !prev.approval || modeB) return false;
  const expiresAt = prev.approval_expires_at ? new Date(prev.approval_expires_at).getTime()
    : prev.approved_at ? new Date(prev.approved_at).getTime() + APPROVAL_TTL_MS : NaN;
  if (!(expiresAt < now)) return false;
  if (!body || !body.status || body.status === prev.status) return false;
  if (intendedAction === "approve") return false;
  if (isWithdrawal(prev.status, body.status)) return false;
  return true;
};

// The approval columns a return to DRAFT clears, or null. A returned order
// is no longer approved: it must be approved again, and a stale approval
// (expired or not) must not stay on a DRAFT, where it would refuse the
// resubmit once it expires.
export const approvalClearedByReturn = (prev, body) => {
  if (!prev || !prev.approval || !body) return null;
  if (body.status !== "DRAFT" || prev.status === "DRAFT") return null;
  return { approval: null, approval_expires_at: null, approval_actions: [] };
};
