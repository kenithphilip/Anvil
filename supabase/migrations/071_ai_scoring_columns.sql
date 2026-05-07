-- 071_ai_scoring_columns.sql
--
-- Audit P7.1 + P7.2 + P7.3. Add the AI-derived signal columns
-- the new scoring endpoints write to. All nullable so the
-- migration is non-blocking and existing reads keep working.

-- Lead scoring (Haiku-derived)
alter table leads
  add column if not exists ai_score numeric(4, 1),                   -- 0.0 to 100.0
  add column if not exists ai_score_reasoning text,
  add column if not exists ai_score_signals jsonb,                   -- { quality_signals, risk_signals, ... }
  add column if not exists ai_scored_at timestamptz,
  add column if not exists ai_score_model text;

create index if not exists leads_ai_score_idx
  on leads (tenant_id, ai_score desc nulls last)
  where ai_score is not null;

-- Opportunity AI close probability (separate from operator-set
-- `probability` so the operator can compare).
alter table opportunities
  add column if not exists ai_probability numeric(4, 1),
  add column if not exists ai_probability_reasoning text,
  add column if not exists ai_probability_signals jsonb,
  add column if not exists ai_probability_at timestamptz,
  add column if not exists ai_probability_model text;

create index if not exists opportunities_ai_prob_idx
  on opportunities (tenant_id, ai_probability desc nulls last)
  where ai_probability is not null;

-- Customer health score (monthly Haiku batch).
alter table customers
  add column if not exists ai_health_score numeric(4, 1),
  add column if not exists ai_health_band text,                       -- 'green' | 'yellow' | 'red'
  add column if not exists ai_health_signals jsonb,
  add column if not exists ai_health_reasoning text,
  add column if not exists ai_health_computed_at timestamptz,
  add column if not exists ai_health_model text;

create index if not exists customers_ai_health_band_idx
  on customers (tenant_id, ai_health_band)
  where ai_health_band is not null;
