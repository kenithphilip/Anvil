// The fine-grained sales-order action a PATCH /api/orders/[id] needs, on top
// of the coarse "write" verb the handler checks first.
//
// The coarse verb admits procurement, finance and operator, whom the MATRIX
// keeps read-only on sales orders. So a finance user could edit lines or send
// an order for approval through the API while the screen showed no button.
//
//   cancel (status CANCELLED)                 so.cancel
//   an approver's decision, by a role that    nothing more here: the handler
//   holds so.approve:                         checks the approve verb where
//     approve (status APPROVED + approval)    the decision needs it
//     return for fix (DRAFT + a reason)
//     clear a blocking finding (resolve_finding)
//   everything else: line and header edits,  so.write
//   extraction and validation results, send
//   for approval, any other status move
//
// A decision is recognised by what it WRITES: the handler's allowlisted
// patch must hold only decision columns, and the body must not carry the
// customer, PO number or PO date (written by _lib/order-identity.js). Any
// other key outside the allowlist is never written, so it does not matter
// here. A decision that also edits the order needs so.write as well.

import { hasAction, requireAction } from "./auth.js";
import { IDENTITY_KEYS } from "./order-identity.js";

const DECISION_COLUMNS = new Set([
  "status", "approval",
  "correction_reason", "correction_requested_by", "correction_requested_at",
]);

// Approve, return for fix, or clear a blocking finding, and nothing else.
// `written` is the patch the handler will write (its allowlist applied).
export const isApproverDecision = (body, written = body) => {
  if (!body || typeof body !== "object") return false;
  if (body.resolve_finding && body.resolve_finding.code) return true;
  // The customer, PO number and PO date are written outside the allowlist
  // (_lib/order-identity.js), so a body that carries one edits the order.
  if (IDENTITY_KEYS.some((k) => k in body)) return false;
  const cols = Object.keys(written && typeof written === "object" ? written : {});
  if (!cols.every((k) => DECISION_COLUMNS.has(k))) return false;
  if (body.status === "APPROVED") return true;
  return body.status === "DRAFT"
    && typeof body.correction_reason === "string" && body.correction_reason.trim().length > 0;
};

// The action this PATCH needs, or null when the coarse verb (and the
// handler's own approve check) is the whole gate.
export const orderPatchAction = (ctx, body, written = body) => {
  if (body && body.status === "CANCELLED") return "so.cancel";
  if (isApproverDecision(body, written) && hasAction(ctx, "so.approve")) return null;
  return "so.write";
};

// Throws 403 ACTION_FORBIDDEN when the caller lacks the action. Call after
// requirePermission(ctx, "write"), with the allowlisted patch.
export const requireOrderPatchAction = (ctx, body, written = body) => {
  const action = orderPatchAction(ctx, body, written);
  if (action) requireAction(ctx, action);
};
