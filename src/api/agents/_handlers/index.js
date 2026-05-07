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
// Phase 6 (audit): three new handlers covering the most common
// gaps the original 3-handler set missed.
import { expiringQuoteNudge } from "./expiring_quote_nudge.js";
import { failedPushRecovery } from "./failed_push_recovery.js";
import { paidPartialFollowup } from "./paid_partial_followup.js";
// Audit P8.3: nine more handlers covering the long tail of
// quote-to-cash + post-sale touchpoints that previously required
// an operator nudge.
import { supplierAckFollowup } from "./supplier_ack_followup.js";
import { deliveryEtaCheck } from "./delivery_eta_check.js";
import { serviceVisitSchedule } from "./service_visit_schedule.js";
import { amcRenewalChase } from "./amc_renewal_chase.js";
import { creditReviewRequest } from "./credit_review_request.js";
import { onboardingFollowup } from "./onboarding_followup.js";
import { priceIncreaseAnnouncement } from "./price_increase_announcement.js";
import { replenishmentSuggestion } from "./replenishment_suggestion.js";
import { obsoleteProductWarning } from "./obsolete_product_warning.js";

export const HANDLERS = {
  quote_accept_within_14d:    quoteAccept,
  ar_collect_by_due_plus_7:   arCollect,
  missing_doc_followup:       missingDoc,
  expiring_quote_nudge:       expiringQuoteNudge,
  failed_push_recovery:       failedPushRecovery,
  paid_partial_followup:      paidPartialFollowup,
  supplier_ack_followup:      supplierAckFollowup,
  delivery_eta_check:         deliveryEtaCheck,
  service_visit_schedule:     serviceVisitSchedule,
  amc_renewal_chase:          amcRenewalChase,
  credit_review_request:      creditReviewRequest,
  onboarding_followup:        onboardingFollowup,
  price_increase_announcement: priceIncreaseAnnouncement,
  replenishment_suggestion:   replenishmentSuggestion,
  obsolete_product_warning:   obsoleteProductWarning,
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
