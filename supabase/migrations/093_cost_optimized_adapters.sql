-- 093_cost_optimized_adapters.sql
--
-- Cost-optimisation pass for the docai pipeline (May 2026).
--
-- Goal: zero infra spend at PoC scale by routing traffic through
-- free tiers in this order:
--
--   1. Gemini 2.5 Flash (free, 1500 req/day, 1M TPM, no card)
--   2. Self-hosted Docling/Marker/Unstructured (free if deployed)
--   3. Azure DI F0 (free, 500 pages/mo, hosted)
--   4. Reducto / paid Unstructured (per-page paid)
--   5. Anthropic Claude (paid, Haiku or Sonnet selectable)
--
-- The adapter chain default in src/api/_lib/docai/index.js gets
-- updated alongside this migration.
--
-- Three concerns:
--
--   A. New adapter: Gemini. Same encrypted-key + env-var fallback
--      pattern as the other paid adapters.
--
--   B. Cost guard. Per-tenant per-day per-adapter call counters in
--      docai_daily_usage so the dispatcher can short-circuit paid
--      adapters when the operator's budget is exhausted. Defaults
--      are unlimited; tenants opt in via docai_daily_limits jsonb.
--
--   C. Model selector for Anthropic. Lets a tenant pin
--      claude-haiku-4 (4x cheaper than Sonnet) per-tenant without
--      a code change. Falls back to ANTHROPIC_MODEL_DEFAULT env
--      var, then to Sonnet 4.
--
-- Idempotent.

-- ---- A. Gemini key on tenant_settings ---------------------------

alter table tenant_settings
  add column if not exists docai_gemini_api_key_enc bytea,
  add column if not exists docai_gemini_model text,
  add column if not exists docai_anthropic_model text;

comment on column tenant_settings.docai_gemini_api_key_enc is
  'AES-GCM encrypted Gemini API key. Falls back to env GEMINI_API_KEY when null.';
comment on column tenant_settings.docai_gemini_model is
  'Override the Gemini model. Default = gemini-2.5-flash (free tier).';
comment on column tenant_settings.docai_anthropic_model is
  'Override the Claude model per-tenant. Examples: claude-haiku-4-..., claude-sonnet-4-... .';

-- ---- B. Cost-guard infra ----------------------------------------

-- docai_daily_limits: per-adapter caps as a jsonb map. Adapters
-- not present in the map are unlimited; null map = no limits at
-- all. Example:
--   {"claude": 50, "reducto": 100, "azure_di": 200}
alter table tenant_settings
  add column if not exists docai_daily_limits jsonb default null;

comment on column tenant_settings.docai_daily_limits is
  'Phase Cost-Opt: per-adapter daily call cap. Map of {adapter -> int}. Adapters absent from the map are uncapped. NULL = no caps at all.';

-- docai_daily_usage: one row per (tenant, day, adapter) with a
-- monotonic counter. Bumped after each successful adapter call by
-- the cost-guard recordCall path. Old rows can be archived
-- whenever; the dispatcher only ever reads `today` and writes via
-- INSERT ... ON CONFLICT DO UPDATE.
create table if not exists docai_daily_usage (
  tenant_id uuid not null references tenants(id) on delete cascade,
  usage_date date not null default current_date,
  adapter text not null,
  call_count int not null default 0,
  estimated_cost_usd numeric(8,4) not null default 0,
  last_called_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (tenant_id, usage_date, adapter)
);

create index if not exists docai_daily_usage_tenant_idx
  on docai_daily_usage (tenant_id, usage_date desc);

alter table docai_daily_usage enable row level security;
drop policy if exists "docai_daily_usage_all" on docai_daily_usage;
create policy "docai_daily_usage_all" on docai_daily_usage
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check  (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
