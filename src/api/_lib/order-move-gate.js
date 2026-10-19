// The server's half of the exceptions gate (plan R-F1 (c)).
//
// The SO workspace greys out "Send for approval" and "Approve" while an open
// exception blocks them (order-next-step.js). The Kanban, the Approvals queue
// and a direct API call never read that list, so the one blocker held only in
// the browser, an undecided critical terms flag, could be dragged past once a
// tenant sets terms_check_mode to on. PATCH /api/orders/:id now builds the
// same list with the same builder (order-exceptions.js), from the same inputs
// read by the same reader (order-exceptions-inputs.js), before it moves an
// order to PENDING_REVIEW or APPROVED, and refuses the move with 409
// ORDER_HAS_BLOCKING_EXCEPTION, naming the rows. A person and an agent meet
// one gate.
//
// The moves it guards:
//   PENDING_REVIEW  a send for approval (from DRAFT or BLOCKED)
//   APPROVED        every approve, whatever the order's status: the first
//                   approve from PENDING_REVIEW, and a re-approval from
//                   FAILED_TALLY_IMPORT or of an order already APPROVED. An
//                   order is never approved with a send row open. Nothing is
//                   trapped by this: a terms flag is decided at any status
//                   (terms_decide.js).
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
// Stored data only: the order as the PATCH leaves it, its customer and
// extraction run, and the terms check's stored flags and decisions. No LLM
// call and no reconcile. Never the shadow rows: they never block.
//
// Fails closed. When the inputs cannot be read the move is refused with 503
// ORDER_EXCEPTIONS_UNAVAILABLE, which says to try again. Before migration 250
// there is no terms check, so the reader returns no terms rows and the move
// goes ahead.

import { buildOrderExceptions, blockingRows } from "./order-exceptions.js";
import { readExceptionInputs } from "./order-exceptions-inputs.js";
import { blockerSentence } from "./order-next-step.js";

export const BLOCKING_EXCEPTION_CODE = "ORDER_HAS_BLOCKING_EXCEPTION";
export const EXCEPTIONS_UNAVAILABLE_CODE = "ORDER_EXCEPTIONS_UNAVAILABLE";

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

// The 503 body when the inputs cannot be read. The database's own words are
// logged, not shown: the person is told the check is unavailable for now.
export const exceptionsUnavailableError = (to) => ({
  error: {
    code: EXCEPTIONS_UNAVAILABLE_CODE,
    message: "Could not check this order's exceptions. Try again.",
    to,
  },
});

// null when the move may go ahead, else { status, body }: 409 when an open
// row blocks the move, 503 when the inputs cannot be read. `order` is the
// order as the PATCH leaves it.
export const checkMoveBlockers = async (svc, ctx, { order, to }) => {
  if (!isGatedMove(to) || !order || !order.id) return null;
  let inputs;
  try {
    inputs = await readExceptionInputs(svc, ctx, order, { includeShadow: false });
  } catch (err) {
    console.error("[order-move-gate] exceptions inputs unreadable; move refused", {
      tenant_id: ctx.tenantId, order_id: order.id, to, message: err && err.message,
    });
    return { status: 503, body: exceptionsUnavailableError(to) };
  }
  const rows = rowsBlockingMove(buildOrderExceptions(inputs), to);
  return rows.length ? { status: 409, body: blockingExceptionError(rows, to) } : null;
};
