// Goal-type handlers for the autonomous agent.
//
// Each handler takes a goal row and returns a step descriptor:
//   { thought, action, action_payload, complete? }
//
// `action` is one of:
//   noop          The goal is on track; do nothing this tick.
//   send_email    Draft + send a customer-facing email (uses
//                 communications.draft + communications.send).
//   escalate      Notify the owner_user_id that the agent is stuck.
//   mark_complete The goal succeeded; flip to 'completed'.
//   give_up       The goal failed; flip to 'failed'.
//
// The runner persists every step in agent_steps and updates the
// goal's bookkeeping fields. The handlers are deliberately thin: they
// inspect state, decide next action, and let the runner execute.
// This separation makes them unit-testable without standing up the
// full /api/communications stack.

import { quoteAccept } from "./quote_accept.js";
import { arCollect } from "./ar_collect.js";
import { missingDoc } from "./missing_doc.js";

export const HANDLERS = {
  quote_accept_within_14d: quoteAccept,
  ar_collect_by_due_plus_7: arCollect,
  missing_doc_followup:    missingDoc,
};

export const KNOWN_GOAL_TYPES = Object.keys(HANDLERS);

export const dispatch = async (goal, ctx) => {
  const fn = HANDLERS[goal.goal_type];
  if (!fn) {
    return {
      thought: "Unknown goal_type " + goal.goal_type,
      action: "give_up",
      action_payload: {},
    };
  }
  return fn(goal, ctx);
};
