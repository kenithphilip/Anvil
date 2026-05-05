-- 056_docai_fine_tune.sql
-- Phase 6 (C.4): Per-customer fine-tuned extraction routing.
--
-- Adds the routing inputs:
--   tenant_settings.docai_fine_tune_threshold  (default 200)
--   customers.docai_fine_tune_url              (NULL until worker registers)
--   customers.docai_correction_count           (rolling count, refreshed by RLHF aggregator)
-- Idempotent.

alter table tenant_settings
  add column if not exists docai_fine_tune_threshold int default 200;

do $$ begin
  if to_regclass('public.customers') is not null then
    execute 'alter table customers add column if not exists docai_fine_tune_url text';
    execute 'alter table customers add column if not exists docai_correction_count int default 0';
  end if;
end $$;
