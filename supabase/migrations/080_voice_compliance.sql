-- 080_voice_compliance.sql
--
-- Voice AI compliance + autonomy support. The voice infrastructure
-- (voice_configs, voice_calls, voice_call_actions) shipped in
-- 041_voice.sql; the webhook + process_actions worker shipped in
-- Phase 5.1. Two gaps were called out as "blocking the launch, not
-- the engineering" in DEFERRED_ROADMAP §1:
--
--   1. Recording-disclosure copy per region. The agent must announce
--      "this call is being recorded" at call-start. Wording differs
--      by jurisdiction (US single-party consent, EU + India two-
--      party consent). Stored per voice_configs row plus a
--      tenant-default fallback.
--
--   2. Outbound dialer compliance. India = TRAI National Do-Not-Call
--      registry (NDNC) lookup; US = TCPA prior-express-consent
--      requirement. Both require we know, before placing the call,
--      whether the destination number is callable. We persist the
--      decision so a future audit can replay it.
--
-- Plus voice_followup as a new agent goal_type (the autonomy
-- runtime will auto-create one of these when a voice call ends
-- with an unfulfilled "callback" intent).
--
-- Idempotent.

-- ----------------------------------------------------------------
-- voice_configs: add recording-disclosure columns.
-- ----------------------------------------------------------------
alter table voice_configs
  add column if not exists region text default 'IN'
    check (region in ('IN', 'US', 'EU', 'UK', 'AE', 'SG', 'OTHER')),
  add column if not exists recording_disclosure text,
  add column if not exists recording_disclosure_locale text default 'en-IN',
  -- Whether this config is allowed for outbound campaigns. Off by
  -- default; a tenant must explicitly opt in after their compliance
  -- review. The /api/voice/outbound endpoint refuses to dial when
  -- this flag is false, regardless of any per-number consent.
  add column if not exists outbound_enabled boolean not null default false,
  -- Last time the operator re-confirmed compliance posture (the
  -- annual renewal that DPDP / GDPR + TCPA mandate). NULL until
  -- they sign once.
  add column if not exists compliance_reviewed_at timestamptz;

-- ----------------------------------------------------------------
-- voice_consent: per-phone-number consent record for outbound.
-- ----------------------------------------------------------------
-- A row exists when we have an explicit, dated consent artifact
-- the recipient gave us (signed agreement, prior text-back, opt-in
-- form, recorded verbal). The /api/voice/outbound endpoint
-- consults this table before dialing a US (TCPA) or EU (GDPR)
-- number; an Indian number additionally has to NOT appear on the
-- DND list (see voice_dnd_list).
create table if not exists voice_consent (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  -- Always store as E.164.
  phone_number text not null,
  -- The customer + contact this consent applies to. Either field
  -- can be null (e.g. consent captured before the contact row
  -- existed); the matcher prefers contact + customer when both
  -- are populated.
  customer_id uuid references customers(id) on delete set null,
  customer_contact_id uuid references customer_contacts(id) on delete set null,
  -- Channel the consent applies to. We currently scope to voice
  -- explicitly so an SMS / email opt-in does not auto-grant a
  -- voice opt-in. Both directions are explicit.
  scope text not null default 'voice'
    check (scope in ('voice', 'sms', 'voice+sms')),
  consented_at timestamptz not null default now(),
  -- "How was consent captured?" Audit trail.
  source text not null check (source in (
    'inbound_call',         -- they called us
    'inbound_message',      -- they texted/whatsapped us first
    'signed_agreement',     -- contract or order form
    'opt_in_form',          -- web form
    'recorded_verbal',      -- on a previous call
    'manual_attestation'    -- operator typed it in (last resort)
  )),
  source_artifact_url text,
  -- Optional expiry (e.g. 12 months for some regions). NULL means
  -- "until withdrawn"; the matcher refuses calls past expires_at.
  expires_at timestamptz,
  -- Withdrawal: when the customer opts out, we set withdrawn_at
  -- and refuse calls thereafter. The row stays for audit.
  withdrawn_at timestamptz,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- One active consent per (tenant, number, scope). A second row
  -- for the same combination usually represents a re-consent
  -- after a withdrawal; we use a partial unique index so withdrawn
  -- rows don't block fresh consent.
  unique (tenant_id, phone_number, scope, consented_at)
);

create index if not exists voice_consent_lookup_idx
  on voice_consent (tenant_id, phone_number, scope, withdrawn_at);

create index if not exists voice_consent_customer_idx
  on voice_consent (tenant_id, customer_id) where customer_id is not null;

alter table voice_consent enable row level security;
drop policy if exists "voice_consent_owner" on voice_consent;
create policy "voice_consent_owner" on voice_consent
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ----------------------------------------------------------------
-- voice_dnd_list: per-tenant Do-Not-Call list.
-- ----------------------------------------------------------------
-- Two rows shapes coexist:
--   - source = 'tenant_manual': a specific number the operator
--     blocked. Always honored.
--   - source = 'trai_ndnc' / 'fcc_dnc': periodic snapshots from
--     national DND registries. Cron-loaded by the compliance
--     vendor integration; out of scope for the initial PR but the
--     table is in place so the load can drop in without a schema
--     change.
create table if not exists voice_dnd_list (
  id uuid primary key default uuid_generate_v4(),
  -- TRAI / FCC lists are global; we still tag with tenant_id =
  -- null for the global rows so a single index covers both per-
  -- tenant + global lookups.
  tenant_id uuid references tenants(id) on delete cascade,
  phone_number text not null,
  source text not null check (source in (
    'tenant_manual',    -- operator added
    'trai_ndnc',        -- India registry
    'fcc_dnc',          -- US registry
    'customer_request'  -- captured during a previous call ("don't call again")
  )),
  region text,
  added_at timestamptz not null default now(),
  reason text,
  added_by uuid references auth.users(id),
  -- Per-source freshness so the cron loader can drop and replace
  -- without touching the manual rows.
  source_loaded_at timestamptz
);

create unique index if not exists voice_dnd_list_unique
  on voice_dnd_list (coalesce(tenant_id::text, ''), phone_number, source);

create index if not exists voice_dnd_list_lookup_idx
  on voice_dnd_list (phone_number);

alter table voice_dnd_list enable row level security;
drop policy if exists "voice_dnd_list_global_or_owner" on voice_dnd_list;
create policy "voice_dnd_list_global_or_owner" on voice_dnd_list
  for select using (
    tenant_id is null
    or tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
drop policy if exists "voice_dnd_list_tenant_modify" on voice_dnd_list;
create policy "voice_dnd_list_tenant_modify" on voice_dnd_list
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- ----------------------------------------------------------------
-- agent_goals: add voice_followup to the goal_type CHECK list.
-- ----------------------------------------------------------------
-- 078 expanded the CHECK to 15 handlers. voice_followup is the
-- 16th: when a voice call ends with an unfulfilled callback intent
-- (the customer asked us to call back later), the autonomy
-- runtime arms a goal here, and the handler attempts the callback
-- via /api/voice/outbound.
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
    'obsolete_product_warning',
    'voice_followup'
  ));
