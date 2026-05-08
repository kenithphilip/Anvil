-- 078_agent_goals_expand_goal_types.sql
--
-- The agent_goals table's `goal_type` CHECK constraint was set in
-- migration 011 with the original three handlers
-- (quote_accept_within_14d, ar_collect_by_due_plus_7,
-- missing_doc_followup). Phases 6, 7, and 8 of the audit roadmap
-- shipped twelve more handlers (expiring_quote_nudge,
-- failed_push_recovery, paid_partial_followup, supplier_ack_followup,
-- delivery_eta_check, service_visit_schedule, amc_renewal_chase,
-- credit_review_request, onboarding_followup,
-- price_increase_announcement, replenishment_suggestion,
-- obsolete_product_warning), but the DB-level constraint was never
-- expanded. Any insert of one of those types would have raised a
-- check_violation; the API layer was implicitly enforcing the
-- runtime KNOWN_GOAL_TYPES list while the DB silently rejected the
-- write.
--
-- This migration drops the stale constraint and re-creates it with
-- the full handler set so the goals.js endpoint and the quote-send
-- arming path can actually persist rows for the newer types.
--
-- Idempotent: drops by name first, then adds.

alter table agent_goals
  drop constraint if exists agent_goals_goal_type_check;

alter table agent_goals
  add constraint agent_goals_goal_type_check
  check (goal_type in (
    'quote_accept_within_14d',
    'ar_collect_by_due_plus_7',
    'missing_doc_followup',
    'expiring_quote_nudge',
    'failed_push_recovery',
    'paid_partial_followup',
    'supplier_ack_followup',
    'delivery_eta_check',
    'service_visit_schedule',
    'amc_renewal_chase',
    'credit_review_request',
    'onboarding_followup',
    'price_increase_announcement',
    'replenishment_suggestion',
    'obsolete_product_warning'
  ));
