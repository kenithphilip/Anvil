-- 052_vertical_packs.sql
-- Phase 6 (C.2): Vertical templates pack installer.
--
-- Each tenant can install one or more "vertical packs" — bundled
-- approval thresholds, lead-time defaults, lost-reason taxonomy,
-- contract types, item-master starter rows, quote templates, and
-- vertical-specific KPI definitions. The pack content lives in
-- `src/v3-app/verticals/<id>.json`; this migration adds the install
-- log and the tenant-side `vertical` discriminator.
-- Idempotent.

alter table tenant_settings
  add column if not exists vertical text,
  add column if not exists vertical_kpis jsonb not null default '[]'::jsonb,
  add column if not exists vertical_quote_template jsonb;

create table if not exists vertical_pack_installs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  vertical_id text not null,
  pack_version int not null default 1,
  content_hash text not null,
  installed_by uuid references auth.users(id),
  installed_at timestamptz not null default now(),
  -- Per-pack install metadata: how many approval thresholds /
  -- lead-times / lost-reasons / item-master rows were inserted.
  details jsonb not null default '{}'::jsonb,
  unique (tenant_id, vertical_id, content_hash)
);

create index if not exists vertical_pack_installs_tenant_idx
  on vertical_pack_installs (tenant_id, vertical_id);

alter table vertical_pack_installs enable row level security;
drop policy if exists "vertical_pack_installs_owner" on vertical_pack_installs;
create policy "vertical_pack_installs_owner" on vertical_pack_installs
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Add a `pack_origin` discriminator on the four seed tables so a
-- vertical pack's contributions can be re-installed idempotently
-- without colliding with operator-curated rows. Existing rows get
-- pack_origin=NULL (operator-authored).
do $$ begin
  if to_regclass('public.approval_thresholds') is not null then
    execute 'alter table approval_thresholds add column if not exists pack_origin text';
    execute 'create unique index if not exists approval_thresholds_pack_uniq
              on approval_thresholds (tenant_id, level, coalesce(pack_origin, ''operator''))';
  end if;
  if to_regclass('public.admin_lead_times') is not null then
    execute 'alter table admin_lead_times add column if not exists pack_origin text';
    execute 'create unique index if not exists admin_lead_times_pack_uniq
              on admin_lead_times (tenant_id, lead_code, coalesce(pack_origin, ''operator''))';
  end if;
  if to_regclass('public.admin_lost_reasons') is not null then
    execute 'alter table admin_lost_reasons add column if not exists pack_origin text';
    execute 'create unique index if not exists admin_lost_reasons_pack_uniq
              on admin_lost_reasons (tenant_id, reason, coalesce(pack_origin, ''operator''))';
  end if;
  if to_regclass('public.item_master') is not null then
    execute 'alter table item_master add column if not exists pack_origin text';
  end if;
end $$;
