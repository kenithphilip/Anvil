-- 003_studio_ocr_fx_inventory_lead.sql
-- Adds tables for Customer Format Profile Studio versioning, server-side OCR runs,
-- ZIP scan results, FX rates, lead times, holiday calendar, inventory snapshot,
-- BOM relationships, and magic-link audit.
-- All tables tenant-scoped with the same RLS pattern as 001_init.sql.

-- ───────────────────────────────────────────────────────────────────────────
-- Customer Format Profile versions (item #5)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists customer_format_profile_versions (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  profile_id uuid not null references customer_format_profiles(id) on delete cascade,
  version int not null,
  fingerprint jsonb not null default '{}'::jsonb,
  recipe jsonb not null default '{}'::jsonb,
  learned_rules jsonb not null default '{}'::jsonb,
  golden_examples uuid[] not null default array[]::uuid[],
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index if not exists cfpv_customer_idx on customer_format_profile_versions (tenant_id, customer_id, version desc);

-- Trigger: snapshot the previous current row whenever a new format profile becomes current.
create or replace function snapshot_customer_format_profile() returns trigger language plpgsql as $$
begin
  if (TG_OP = 'INSERT' and NEW.is_current) or (TG_OP = 'UPDATE' and NEW.is_current and OLD.is_current is distinct from NEW.is_current) then
    insert into customer_format_profile_versions (
      tenant_id, customer_id, profile_id, version, fingerprint, recipe, learned_rules, notes
    )
    values (
      NEW.tenant_id, NEW.customer_id, NEW.id, NEW.version, NEW.fingerprint, NEW.recipe, NEW.learned_rules, NEW.format_change_summary
    )
    on conflict do nothing;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_snapshot_customer_format_profile on customer_format_profiles;
create trigger trg_snapshot_customer_format_profile
  after insert or update on customer_format_profiles
  for each row execute function snapshot_customer_format_profile();

-- ───────────────────────────────────────────────────────────────────────────
-- FX rates (item #14)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists fx_rates (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  from_ccy text not null,
  to_ccy text not null,
  rate numeric(14, 6) not null,
  as_of date not null,
  source text not null default 'frankfurter',
  fetched_at timestamptz not null default now(),
  unique (tenant_id, from_ccy, to_ccy, as_of)
);

create index if not exists fx_rates_lookup_idx on fx_rates (tenant_id, from_ccy, to_ccy, as_of desc);

-- ───────────────────────────────────────────────────────────────────────────
-- Lead times and holiday calendar (item #34)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists customer_lead_times (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  product_category text,
  lead_days int not null check (lead_days >= 0 and lead_days <= 365),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_lead_times_idx on customer_lead_times (tenant_id, customer_id);

create table if not exists supplier_lead_times (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  supplier text,
  country text not null,
  product_category text,
  lead_days int not null check (lead_days >= 0 and lead_days <= 365),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists supplier_lead_times_idx on supplier_lead_times (tenant_id, country, product_category);

create table if not exists holiday_calendar (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,
  country text not null,
  date date not null,
  name text,
  unique nulls not distinct (tenant_id, country, date)
);

create index if not exists holiday_calendar_idx on holiday_calendar (country, date);

-- ───────────────────────────────────────────────────────────────────────────
-- Inventory and BOM (items #35, #16)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists tally_inventory (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  stock_item_name text not null,
  available_qty numeric(18, 3) not null default 0,
  reserved_qty numeric(18, 3) not null default 0,
  reorder_level numeric(18, 3) not null default 0,
  uom text,
  last_sync_at timestamptz not null default now(),
  unique (tenant_id, stock_item_name)
);

create index if not exists tally_inventory_lookup on tally_inventory (tenant_id, lower(stock_item_name));

create table if not exists bill_of_materials (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  parent_part_no text not null,
  child_part_no text not null,
  qty numeric(18, 4) not null default 1,
  uom text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, parent_part_no, child_part_no)
);

create index if not exists bom_parent_idx on bill_of_materials (tenant_id, parent_part_no);
create index if not exists bom_child_idx on bill_of_materials (tenant_id, child_part_no);

-- ───────────────────────────────────────────────────────────────────────────
-- OCR runs and ZIP scans (items #1, #38, #39)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists ocr_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  provider text not null default 'mistral',
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  page_count int default 0,
  evidence_count int default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text,
  raw jsonb
);

create index if not exists ocr_runs_doc_idx on ocr_runs (tenant_id, document_id, started_at desc);

create table if not exists zip_scans (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  status text not null check (status in ('clean', 'rejected', 'warn')),
  file_count int not null default 0,
  total_size_bytes bigint not null default 0,
  threats jsonb not null default '[]'::jsonb,
  inner_files jsonb not null default '[]'::jsonb,
  completed_at timestamptz not null default now()
);

create index if not exists zip_scans_doc_idx on zip_scans (tenant_id, document_id, completed_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- Auth magic link audit (item #41)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists auth_magic_links (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete set null,
  email text not null,
  requested_at timestamptz not null default now(),
  ip text,
  user_agent text,
  outcome text not null default 'sent' check (outcome in ('sent', 'failed', 'verified'))
);

create index if not exists auth_magic_links_email_idx on auth_magic_links (lower(email), requested_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

alter table customer_format_profile_versions enable row level security;
alter table fx_rates enable row level security;
alter table customer_lead_times enable row level security;
alter table supplier_lead_times enable row level security;
alter table holiday_calendar enable row level security;
alter table tally_inventory enable row level security;
alter table bill_of_materials enable row level security;
alter table ocr_runs enable row level security;
alter table zip_scans enable row level security;
alter table auth_magic_links enable row level security;

do $$
declare
  t text;
  business_tables text[] := array[
    'customer_format_profile_versions','fx_rates','customer_lead_times','supplier_lead_times',
    'tally_inventory','bill_of_materials','ocr_runs','zip_scans'
  ];
begin
  foreach t in array business_tables loop
    execute format($f$
      drop policy if exists tenant_select on %I;
      create policy tenant_select on %I for select using (tenant_id in (select current_tenant_ids()));
      drop policy if exists tenant_insert on %I;
      create policy tenant_insert on %I for insert with check (tenant_id in (select current_tenant_ids()));
      drop policy if exists tenant_update on %I;
      create policy tenant_update on %I for update using (tenant_id in (select current_tenant_ids()));
      drop policy if exists tenant_delete on %I;
      create policy tenant_delete on %I for delete using (tenant_id in (select current_tenant_ids()));
    $f$, t, t, t, t, t, t, t, t);
  end loop;
end $$;

-- Holiday calendar can be global (tenant_id null) so members can see public rows;
-- private rows use tenant scoping.
drop policy if exists holiday_calendar_select on holiday_calendar;
create policy holiday_calendar_select on holiday_calendar for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists holiday_calendar_write on holiday_calendar;
create policy holiday_calendar_write on holiday_calendar for all
  using (tenant_id in (select current_tenant_ids()) and current_tenant_role(tenant_id) in ('admin','sales_manager'))
  with check (tenant_id in (select current_tenant_ids()) and current_tenant_role(tenant_id) in ('admin','sales_manager'));

-- Magic-link audit: insert from anonymous flows (service role) is fine;
-- members read their own tenant rows.
drop policy if exists magic_links_select on auth_magic_links;
create policy magic_links_select on auth_magic_links for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));

-- Triggers to keep updated_at fresh.
do $$
declare
  t record;
begin
  for t in select unnest(array['customer_lead_times','supplier_lead_times','bill_of_materials']) as table_name
  loop
    execute format($f$
      drop trigger if exists trg_set_updated_at on %I;
      create trigger trg_set_updated_at before update on %I
        for each row execute function set_updated_at();
    $f$, t.table_name, t.table_name);
  end loop;
end $$;
