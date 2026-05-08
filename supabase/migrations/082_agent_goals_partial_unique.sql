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
-- Bug fix May 2026 (re-roll): the first version of this migration
-- failed in environments that already had duplicate active rows
-- from prior racing arms. The unique index can't be created while
-- duplicates exist, so we dedupe first by cancelling all but the
-- most recent active/paused row per (tenant, object, goal_type),
-- then create the index. Cancelling older dupes is the same
-- semantic the arm helper applies on every re-arm; the audit row
-- is preserved.
--
-- Idempotent. Re-running is a no-op once duplicates are gone.

update agent_goals
   set status = 'cancelled',
       updated_at = now()
 where id in (
   select id
     from (
       select id,
              row_number() over (
                partition by tenant_id, object_type, object_id, goal_type
                order by created_at desc, id desc
              ) as rn
         from agent_goals
        where status in ('active', 'paused')
     ) ranked
    where rn > 1
 );

drop index if exists agent_goals_active_target_uniq;

create unique index agent_goals_active_target_uniq
  on agent_goals (tenant_id, object_type, object_id, goal_type)
  where status in ('active', 'paused');
