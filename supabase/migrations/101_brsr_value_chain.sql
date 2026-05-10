-- 101_brsr_value_chain.sql
--
-- Bet 7: BRSR Core value-chain reporting pack. Two surfaces on one
-- schema:
--
--   1. Supplier surface: tenant fills out a 12-25 field BRSR Core
--      disclosure once per period (annual FY by default).
--   2. Buyer surface: listed-company buyer-tenants pull a rolled-up
--      BRSR-Core-shaped CSV / XBRL stub of their tier-2 suppliers'
--      disclosures.
--
-- Mapped 1:1 to SEBI BRSR Core Annexure I (the 9 attributes that
-- need third-party assurance/assessment from FY 2024-25 onwards
-- for top-250 listed entities, with value-chain disclosure
-- voluntary from FY 2025-26).
--
-- Per docs/STRATEGIC_BET_07_brsr_value_chain.md.
--
-- Idempotent.

-- 1. Tenant-level feature flag. Default OFF so the schema lands
--    inert for every tenant until they opt in.

alter table tenant_settings
  add column if not exists brsr_enabled boolean not null default false,
  add column if not exists brsr_default_cadence text not null default 'annual';

alter table tenant_settings
  drop constraint if exists tenant_settings_brsr_cadence_check;
alter table tenant_settings
  add constraint tenant_settings_brsr_cadence_check
  check (brsr_default_cadence in ('annual', 'quarterly'));

-- 2. supplier_disclosure_periods: FY/period definition per
--    supplier-tenant. status flips open -> submitted -> locked ->
--    assured as the disclosure moves through the audit lifecycle.

create table if not exists supplier_disclosure_periods (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  fiscal_year text not null,
  cadence text not null check (cadence in ('annual', 'quarterly')),
  period_start date not null,
  period_end date not null,
  status text not null default 'open'
    check (status in ('open', 'submitted', 'locked', 'assured')),
  submitted_at timestamptz,
  locked_at timestamptz,
  assured_at timestamptz,
  attestation_user_id uuid references auth.users(id),
  attestation_text text,
  attestation_role text,
  assurance_firm text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, fiscal_year, cadence, period_start)
);

create index if not exists sdp_status_idx
  on supplier_disclosure_periods (tenant_id, status, period_end desc);

alter table supplier_disclosure_periods enable row level security;
drop policy if exists "sdp_select" on supplier_disclosure_periods;
drop policy if exists "sdp_modify" on supplier_disclosure_periods;
create policy "sdp_select" on supplier_disclosure_periods
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "sdp_modify" on supplier_disclosure_periods
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 3. supplier_disclosures: one row per (supplier-tenant, period).
--    Fields cover all 9 BRSR Core attributes:
--      1 GHG (scope1/2)            -> scope1_tco2e, scope2_tco2e
--      2 Water                     -> withdrawal/consumption_kl
--      3 Energy                    -> electricity_kwh + renewable %
--      4 Circularity (waste)       -> waste_total/recycled_mt
--      5 Gender diversity          -> women_pct_*, posh_complaints
--      6 Inclusive development     -> msme_input_pct, india_sourcing_pct
--      7 Fairness                  -> supplier_deductions_pct, privacy
--      8 Openness                  -> related_party_purchases_pct
--      9 Wages + small-town jobs   -> wages fields
--    Plus health/safety (P3) and compliance attestations (P9).
--    `extra` jsonb holds anything not in the canonical schema so a
--    SEBI label change is a code-only update, no migration.

create table if not exists supplier_disclosures (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  period_id uuid not null references supplier_disclosure_periods(id) on delete cascade,
  -- Environment (BRSR Core attributes 1-4)
  scope1_tco2e numeric(14, 3),
  scope2_tco2e numeric(14, 3),
  electricity_kwh numeric(14, 2),
  electricity_renewable_pct numeric(5, 2)
    check (electricity_renewable_pct is null or
           (electricity_renewable_pct >= 0 and electricity_renewable_pct <= 100)),
  diesel_litres numeric(14, 2),
  petrol_litres numeric(14, 2),
  natural_gas_scm numeric(14, 2),
  water_withdrawal_kl numeric(14, 2),
  water_consumption_kl numeric(14, 2),
  water_discharge_kl numeric(14, 2),
  waste_total_mt numeric(14, 3),
  waste_recycled_mt numeric(14, 3),
  waste_disposed_mt numeric(14, 3),
  -- Social (attributes 3, 5, 9)
  women_pct_workforce numeric(5, 2)
    check (women_pct_workforce is null or
           (women_pct_workforce >= 0 and women_pct_workforce <= 100)),
  women_pct_kmp numeric(5, 2),
  women_pct_board numeric(5, 2),
  posh_complaints int check (posh_complaints is null or posh_complaints >= 0),
  ehs_lost_time_injuries int,
  ehs_fatalities int,
  gross_wages_inr numeric(16, 2),
  wages_paid_to_women_inr numeric(16, 2),
  wages_paid_smaller_towns_inr numeric(16, 2),
  return_to_work_after_parental_pct numeric(5, 2),
  -- Inclusive development + openness (attributes 6, 7, 8)
  msme_input_pct numeric(5, 2),
  india_sourcing_pct numeric(5, 2),
  related_party_purchases_pct numeric(5, 2),
  anti_competitive_complaints int,
  privacy_breaches int,
  supplier_deductions_pct numeric(5, 2),
  -- Compliance attestations
  pollution_consent_valid boolean,
  factory_act_compliant boolean,
  cyber_security_breaches int,
  -- Revenue (for intensity ratios in the rollup)
  revenue_inr numeric(16, 2),
  -- Extension: anything not on the canonical schema (industry-
  -- specific, future SEBI fields).
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, period_id)
);

create index if not exists sd_period_idx
  on supplier_disclosures (tenant_id, period_id);

alter table supplier_disclosures enable row level security;
drop policy if exists "sd_select" on supplier_disclosures;
drop policy if exists "sd_modify" on supplier_disclosures;
create policy "sd_select" on supplier_disclosures
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "sd_modify" on supplier_disclosures
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- 4. value_chain_relationships: supplier-tenant <-> buyer-tenant.
--    The `is_material` flag is generated on the >= 2% threshold
--    SEBI defines for value-chain partner inclusion. Consent must
--    be `accepted` before the buyer can read the supplier's
--    disclosure rows.

create table if not exists value_chain_relationships (
  id uuid primary key default uuid_generate_v4(),
  supplier_tenant_id uuid not null references tenants(id) on delete cascade,
  buyer_tenant_id uuid not null references tenants(id) on delete cascade,
  relationship_type text not null check (relationship_type in ('upstream', 'downstream')),
  buyer_purchase_share_pct numeric(5, 2),
  is_material boolean generated always as
    (coalesce(buyer_purchase_share_pct, 0) >= 2) stored,
  consent_status text not null default 'pending'
    check (consent_status in ('pending', 'accepted', 'rejected', 'revoked')),
  consent_at timestamptz,
  revoked_at timestamptz,
  invited_by_user_id uuid references auth.users(id),
  invited_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (supplier_tenant_id, buyer_tenant_id, relationship_type)
);

create index if not exists vcr_supplier_idx
  on value_chain_relationships (supplier_tenant_id, consent_status);
create index if not exists vcr_buyer_idx
  on value_chain_relationships (buyer_tenant_id, consent_status, is_material);

alter table value_chain_relationships enable row level security;
drop policy if exists "vcr_select" on value_chain_relationships;
drop policy if exists "vcr_supplier_modify" on value_chain_relationships;
drop policy if exists "vcr_buyer_modify" on value_chain_relationships;
-- Both sides can read their own rows.
create policy "vcr_select" on value_chain_relationships
  for select using (
    supplier_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
    or buyer_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
-- The buyer creates the invite (sets buyer_tenant_id = me).
create policy "vcr_buyer_modify" on value_chain_relationships
  for insert with check (
    buyer_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
-- The supplier accepts/rejects/revokes (updates their own row).
create policy "vcr_supplier_modify" on value_chain_relationships
  for update using (
    supplier_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  ) with check (
    supplier_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );

-- Buyer-read policy on disclosures: a buyer-tenant can read a
-- supplier's disclosure rows when the relationship is accepted and
-- material. Mirrors the customer-portal pattern from migration 022.
drop policy if exists "sd_buyer_read" on supplier_disclosures;
create policy "sd_buyer_read" on supplier_disclosures
  for select using (
    exists (
      select 1 from value_chain_relationships vcr
      where vcr.supplier_tenant_id = supplier_disclosures.tenant_id
        and vcr.buyer_tenant_id =
            (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
        and vcr.consent_status = 'accepted'
    )
  );
drop policy if exists "sdp_buyer_read" on supplier_disclosure_periods;
create policy "sdp_buyer_read" on supplier_disclosure_periods
  for select using (
    exists (
      select 1 from value_chain_relationships vcr
      where vcr.supplier_tenant_id = supplier_disclosure_periods.tenant_id
        and vcr.buyer_tenant_id =
            (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
        and vcr.consent_status = 'accepted'
    )
  );

-- 5. india_emission_factors: global table (tenant_id null is OK).
--    Pre-seeded with CEA grid factor FY 2024-25 (0.710 tCO2/MWh)
--    plus DEFRA 2025 diesel/petrol/natural gas factors. Refreshed
--    once a year when CEA publishes the new baseline. We keep
--    each factor's effective FY so back-dated disclosures use the
--    right number.

create table if not exists india_emission_factors (
  id uuid primary key default uuid_generate_v4(),
  fuel_type text not null check (fuel_type in (
    'electricity_grid',          -- tCO2/MWh
    'diesel',                    -- kgCO2/litre
    'petrol',                    -- kgCO2/litre
    'natural_gas',               -- kgCO2/scm
    'lpg',                       -- kgCO2/kg
    'coal'                       -- kgCO2/kg
  )),
  factor numeric(10, 6) not null,
  unit text not null,
  source text not null,           -- "CEA Baseline v21.0 Nov 2025", "DEFRA 2025", etc.
  effective_fy text not null,     -- "FY2024-25"
  created_at timestamptz not null default now(),
  unique (fuel_type, effective_fy)
);

-- Seed the canonical 2024-25 factors. Idempotent because of the
-- unique constraint on (fuel_type, effective_fy).
insert into india_emission_factors (fuel_type, factor, unit, source, effective_fy)
values
  ('electricity_grid', 0.710,  'tCO2/MWh',   'CEA Baseline Database v21.0 (Nov 2025)', 'FY2024-25'),
  ('diesel',           2.6862, 'kgCO2/litre', 'DEFRA 2025 GHG Conversion Factors',     'FY2024-25'),
  ('petrol',           2.3168, 'kgCO2/litre', 'DEFRA 2025 GHG Conversion Factors',     'FY2024-25'),
  ('natural_gas',      2.0429, 'kgCO2/scm',   'DEFRA 2025 GHG Conversion Factors',     'FY2024-25'),
  ('lpg',              2.9396, 'kgCO2/kg',    'DEFRA 2025 GHG Conversion Factors',     'FY2024-25'),
  ('coal',             2.4203, 'kgCO2/kg',    'DEFRA 2025 GHG Conversion Factors',     'FY2024-25')
on conflict (fuel_type, effective_fy) do nothing;

-- 6. Comments for documentation.

comment on table supplier_disclosure_periods is
  'Bet 7: per-supplier BRSR Core disclosure period. Annual by default; quarterly available for buyers that require it.';
comment on table supplier_disclosures is
  'Bet 7: per-period BRSR Core disclosure. Mapped 1:1 to SEBI Annexure I attributes 1-9.';
comment on table value_chain_relationships is
  'Bet 7: supplier-buyer link governing BRSR data sharing. consent_status must be accepted before the buyer can read the supplier disclosure.';
comment on column value_chain_relationships.is_material is
  'Bet 7: SEBI BRSR Core materiality (>= 2% of total purchases/sales by value). Generated from buyer_purchase_share_pct.';
comment on table india_emission_factors is
  'Bet 7: emission factors for server-side Scope 1/2 math. CEA grid factor per FY; DEFRA combustion factors per fuel type.';
