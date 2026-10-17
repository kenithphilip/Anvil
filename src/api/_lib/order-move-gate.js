// The server's half of the exceptions gate (plan R-F1 (c)).
//
// The SO workspace greys out "Send for approval" and "Approve" while an open
// exception blocks them (order-next-step.js). The Kanban, the Approvals queue
// and a direct API call never read that list, so the one blocker held only in
// the browser, an undecided critical terms flag, could be dragged past once a
// tenant sets terms_check_mode to on. PATCH /api/orders/:id now builds the
// same list with the same builder (order-exceptions.js) before it moves an
// order to PENDING_REVIEW or APPROVED, and refuses the move with 409
// ORDER_HAS_BLOCKING_EXCEPTION, naming the rows. A person and an agent meet
// one gate.
//
// Which rows stop which move, by each row's blocks:
//   send      the move to PENDING_REVIEW, and the move to APPROVED: an order
//             that should not go for approval is not approved either
//   approval  the move to APPROVED, through its stored finding: orders/[id].js
//             refuses it as ORDER_HAS_UNRESOLVED_BLOCKER (blocking-findings.js)
//             and an approver clears it with resolve_finding. The list's
//             fallback copies (a -MOD verdict whose finding is gone, a
//             shortfall on the extraction run with no finding) are not refused
//             here: resolve_finding cannot clear them, and the server must
//             never refuse an order that nobody can clear.
//
// Stored data only: the order as the PATCH leaves it, and the terms check's
// stored flags and decisions. No LLM call and no reconcile. The customer
// master and the extraction run feed no send row, so they are not read; a new
// source of send rows must be read here too. With the check off (the default
// for every tenant) the gate costs one tenant_settings read.

import { buildOrderExceptions, blockingRows } from "./order-exceptions.js";
import { blockerSentence } from "./order-next-step.js";
import { readTermsSettings, readTermsView } from "./terms/check.js";

export const BLOCKING_EXCEPTION_CODE = "ORDER_HAS_BLOCKING_EXCEPTION";

// The moves the gate guards, and how the refusal names each.
const MOVES = Object.freeze({
  PENDING_REVIEW: "send this order for approval",
  APPROVED: "approve this order",
});

export const isGatedMove = (to) => Object.prototype.hasOwnProperty.call(MOVES, to);

// The open rows that stop a move to `to`: the send rows, for either move.
// blockingRows already leaves out shadow and decided rows.
export const rowsBlockingMove = (exceptions, to) => (isGatedMove(to) ? blockingRows(exceptions).send : []);

// The 409 body. Each row is named: its key and type for an agent, its title
// and where it is decided for a person.
export const blockingExceptionError = (rows, to) => ({
  error: {
    code: BLOCKING_EXCEPTION_CODE,
    message: "Cannot " + (MOVES[to] || "move this order") + ". " + blockerSentence({ blockers: rows })
      + ". Decide " + (rows.length === 1 ? "it" : "them") + " on the order first.",
    to,
    blocking: rows.map((r) => ({
      key: r.key, type: r.type, title: r.title, severity: r.severity, blocks: r.blocks, action: r.action || null,
    })),
  },
});

// The terms view the gate reads. Never the shadow rows (they never block),
// and none before migration 250 (no check can exist then). Any other read
// error is thrown: the move is refused rather than let through unchecked.
const readTerms = async (svc, ctx, orderId) => {
  try {
    const settings = await readTermsSettings(svc, ctx.tenantId);
    const out = await readTermsView(svc, ctx, orderId, { includeShadow: false, settings });
    return { view: out.status === "ok" ? out.view : null, policy: settings.policy || null };
  } catch (err) {
    if (err && err.code === "MIGRATION_NOT_APPLIED") return { view: null, policy: null };
    throw err;
  }
};

// null when the move may go ahead, else { status: 409, body }. `order` is the
// order as the PATCH leaves it.
export const checkMoveBlockers = async (svc, ctx, { order, to }) => {
  if (!isGatedMove(to) || !order || !order.id) return null;
  const terms = await readTerms(svc, ctx, order.id);
  const exceptions = buildOrderExceptions({ order, terms: terms.view, termsPolicy: terms.policy });
  const rows = rowsBlockingMove(exceptions, to);
  return rows.length ? { status: 409, body: blockingExceptionError(rows, to) } : null;
};
