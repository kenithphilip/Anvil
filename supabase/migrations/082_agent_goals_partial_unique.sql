-- 082_agent_goals_partial_unique.sql
--
-- P1 from the May 2026 critic audit: concurrent quote-send (or
-- any concurrent goal-arming flow) could double-arm goals on the
-- same target. The armQuoteAgentGoals helper does a cancel-then-
-- insert pair; two interleaved calls can cancel both prior rows
-- then insert four new ones, two of which fire duplicate nudges.
--
-- Defence: a partial unique index on (tenant_id, object_type,
-- object_id, goal_type) WHERE status in ('active', 'paused').
-- Withdrawn / cancelled / completed / failed rows are ignored, so
-- re-arming after a customer cycle works as before; only the
-- "two active goals on the same thing" case is forbidden.
--
-- Idempotent. The index name is unique per Postgres; we DROP IF
-- EXISTS first to make this safe to re-apply.

drop index if exists agent_goals_active_target_uniq;

create unique index agent_goals_active_target_uniq
  on agent_goals (tenant_id, object_type, object_id, goal_type)
  where status in ('active', 'paused');
