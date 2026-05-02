-- Obara Ops backend schema
-- Designed for Supabase (Postgres 15+) with Row Level Security
-- Tenant scoping uses tenant_id on every business table.

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ───────────────────────────────────────────────────────────────────────────
-- Tenants and users
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists tenants (
  id uuid primary key default uuid_generate_v4(),
  slug text unique not null,
  display_name text not null,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

insert into tenants (id, slug, display_name)
values ('00000000-0000-0000-0000-000000000001', 'default', 'Default')
on conflict (slug) do nothing;

create type obara_role as enum (
  'sales_engineer', 'sales_manager', 'procurement', 'finance', 'admin', 'viewer'
);

create table if not exists tenant_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role obara_role not null default 'sales_engineer',
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create or replace function current_tenant_ids() returns setof uuid
language sql stable as $$
  select tenant_id from tenant_members where user_id = auth.uid()
$$;

create or replace function current_tenant_role(tenant uuid) returns obara_role
language sql stable as $$
  select role from tenant_members where tenant_id = tenant and user_id = auth.uid()
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Customers and customer format profiles (item 5: Customer Format Profile Studio)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists customers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_key text not null,
  customer_name text not null default '',
  gstin text,
  state_code text,
  default_payment_terms text,
  default_incoterms text,
  default_quote_validity_days int default 90,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_key)
);

create table if not exists customer_format_profiles (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  version int not null default 1,
  fingerprint jsonb not null default '{}'::jsonb,
  orders_processed int not null default 0,
  last_format_changed boolean not null default false,
  format_change_summary text,
  trusted boolean not null default false,
  learned_rules jsonb not null default '{}'::jsonb,
  recipe jsonb not null default '{}'::jsonb,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists customer_format_profiles_current
  on customer_format_profiles (tenant_id, customer_id) where is_current;

-- ───────────────────────────────────────────────────────────────────────────
-- Documents and signed-upload tracking
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists documents (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  storage_bucket text not null default 'obara-documents',
  storage_path text not null,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  uploaded_by uuid references auth.users(id),
  classification text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists documents_tenant_idx on documents (tenant_id, created_at desc);
create index if not exists documents_sha256_idx on documents (tenant_id, sha256);

-- ───────────────────────────────────────────────────────────────────────────
-- Orders, source POs, evidence, validation findings
-- ───────────────────────────────────────────────────────────────────────────

create type order_status as enum (
  'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'BLOCKED', 'DUPLICATE',
  'REUSED', 'EXPORTED_TO_TALLY', 'FAILED_TALLY_IMPORT', 'RECONCILED', 'CANCELLED'
);

create type source_po_status as enum (
  'DRAFT', 'PENDING_INTERNAL_APPROVAL', 'SENT_TO_SUPPLIER', 'SUPPLIER_ACK',
  'PRICE_CHANGED', 'ETA_CONFIRMED', 'DELAYED', 'RECEIVED', 'CLOSED', 'CANCELLED'
);

create table if not exists orders (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  status order_status not null default 'DRAFT',
  po_number text,
  po_date date,
  quote_number text,
  quote_date date,
  doc_fingerprint text,
  result jsonb not null default '{}'::jsonb,
  preflight_payload jsonb not null default '{}'::jsonb,
  api_usage jsonb not null default '{}'::jsonb,
  cost_policy_snapshot jsonb not null default '{}'::jsonb,
  token_estimate jsonb not null default '{}'::jsonb,
  rule_findings jsonb not null default '[]'::jsonb,
  anomaly_flags jsonb not null default '[]'::jsonb,
  evidence_by_field jsonb not null default '{}'::jsonb,
  line_edits jsonb not null default '[]'::jsonb,
  approval jsonb,
  payload_hash text,
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  blocker_summary text,
  format_change_summary text,
  cost_avoided_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists orders_tenant_status_idx on orders (tenant_id, status, created_at desc);
create index if not exists orders_po_number_idx on orders (tenant_id, lower(po_number));
create index if not exists orders_fingerprint_idx on orders (tenant_id, doc_fingerprint);
create index if not exists orders_customer_idx on orders (tenant_id, customer_id, created_at desc);

create table if not exists order_documents (
  order_id uuid not null references orders(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  role text not null check (role in ('purchase_order', 'quote', 'price_composition', 'attachment', 'supplier_ack')),
  primary key (order_id, document_id)
);

create table if not exists source_pos (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  reference text not null,
  supplier text not null,
  country text,
  currency text,
  exchange_rate numeric(12, 4),
  total_foreign numeric(18, 2),
  total_inr numeric(18, 2),
  total_landed_inr numeric(18, 2),
  status source_po_status not null default 'DRAFT',
  acknowledged_price numeric(18, 4),
  acknowledged_eta date,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists source_pos_order_idx on source_pos (order_id);
create index if not exists source_pos_status_idx on source_pos (tenant_id, status);

create table if not exists source_po_events (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_po_id uuid not null references source_pos(id) on delete cascade,
  from_status source_po_status,
  to_status source_po_status not null,
  detail text,
  actor uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists evidence (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  field_path text not null,
  value text,
  document_id uuid references documents(id) on delete set null,
  page_number int,
  bbox jsonb,
  snippet text,
  extraction_method text,
  confidence numeric(4, 3),
  validator_status text,
  created_at timestamptz not null default now()
);

create index if not exists evidence_order_idx on evidence (order_id, field_path);

create table if not exists validation_findings (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  rule_id text not null,
  code text not null,
  severity text not null,
  owner text,
  blocks boolean not null default false,
  line_index int,
  detail text,
  suggested_fix text,
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists validation_findings_order_idx on validation_findings (order_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Customer part aliases (item 17)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists part_aliases (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_part_no text not null,
  customer_description text,
  obara_part_no text not null,
  tally_stock_item text,
  confidence numeric(4, 3) default 0.9,
  first_seen_po text,
  last_seen_po text,
  approved_by uuid references auth.users(id),
  status text not null default 'active' check (status in ('active', 'pending', 'deprecated')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_id, customer_part_no)
);

create index if not exists part_aliases_obara_idx on part_aliases (tenant_id, obara_part_no);

-- ───────────────────────────────────────────────────────────────────────────
-- Tally master sync (item 2)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists tally_masters (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  master_type text not null check (master_type in ('stock_item', 'ledger', 'gst_ledger', 'uom', 'voucher_type')),
  name text not null,
  payload jsonb not null default '{}'::jsonb,
  source_imported_at timestamptz not null default now(),
  unique (tenant_id, master_type, name)
);

create index if not exists tally_masters_lookup on tally_masters (tenant_id, master_type, lower(name));

create table if not exists tally_voucher_records (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null references orders(id) on delete cascade,
  voucher_no text not null,
  payload_hash text not null,
  status text not null default 'pending' check (status in ('pending','validated','dry_run_ok','exported','imported','failed')),
  validation jsonb not null default '{}'::jsonb,
  tally_voucher_id text,
  imported_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create unique index if not exists tally_voucher_idem on tally_voucher_records (tenant_id, voucher_no, payload_hash);

-- ───────────────────────────────────────────────────────────────────────────
-- UOM normalization (item 29)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists uom_aliases (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  raw_uom text not null,
  canonical_uom text not null,
  tally_uom text,
  conversion_factor numeric(18, 6) default 1,
  notes text,
  unique (tenant_id, raw_uom)
);

-- ───────────────────────────────────────────────────────────────────────────
-- Audit log (item 40) and processing events (item 23)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists audit_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor uuid references auth.users(id),
  actor_role obara_role,
  action text not null,
  object_type text not null,
  object_id text,
  before_payload jsonb,
  after_payload jsonb,
  payload_hash text,
  source_evidence_ids uuid[],
  reason text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists audit_tenant_idx on audit_events (tenant_id, created_at desc);
create index if not exists audit_object_idx on audit_events (tenant_id, object_type, object_id);

create table if not exists processing_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id text not null,
  event_type text not null,
  object_type text not null,
  object_id text,
  detail jsonb not null default '{}'::jsonb,
  duration_ms int,
  created_at timestamptz not null default now()
);

create index if not exists processing_events_case_idx on processing_events (tenant_id, case_id, created_at);

-- ───────────────────────────────────────────────────────────────────────────
-- Result extraction cache (cost reduction)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists extraction_cache (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  cache_key text not null,
  fingerprint text not null,
  prompt_version text not null,
  schema_version int not null,
  rules_version text not null,
  customer_profile_version text,
  result jsonb not null,
  api_usage jsonb,
  hit_count int not null default 0,
  saved_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (tenant_id, cache_key)
);

create index if not exists extraction_cache_fingerprint_idx on extraction_cache (tenant_id, fingerprint);

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

alter table tenants enable row level security;
alter table tenant_members enable row level security;
alter table customers enable row level security;
alter table customer_format_profiles enable row level security;
alter table documents enable row level security;
alter table orders enable row level security;
alter table order_documents enable row level security;
alter table source_pos enable row level security;
alter table source_po_events enable row level security;
alter table evidence enable row level security;
alter table validation_findings enable row level security;
alter table part_aliases enable row level security;
alter table tally_masters enable row level security;
alter table tally_voucher_records enable row level security;
alter table uom_aliases enable row level security;
alter table audit_events enable row level security;
alter table processing_events enable row level security;
alter table extraction_cache enable row level security;

-- Helper macro: every business table grants SELECT/INSERT/UPDATE/DELETE to tenant members.
do $$
declare
  t text;
  business_tables text[] := array[
    'customers','customer_format_profiles','documents','orders','order_documents',
    'source_pos','source_po_events','evidence','validation_findings','part_aliases',
    'tally_masters','tally_voucher_records','uom_aliases','audit_events','processing_events',
    'extraction_cache'
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

-- Tenant rows themselves: a member can read their tenants
drop policy if exists tenants_select on tenants;
create policy tenants_select on tenants for select using (id in (select current_tenant_ids()));

drop policy if exists members_select on tenant_members;
create policy members_select on tenant_members for select using (tenant_id in (select current_tenant_ids()));

-- Audit events are append-only for non-admins
drop policy if exists audit_no_update on audit_events;
create policy audit_no_update on audit_events for update using (current_tenant_role(tenant_id) = 'admin');

drop policy if exists audit_no_delete on audit_events;
create policy audit_no_delete on audit_events for delete using (current_tenant_role(tenant_id) = 'admin');

-- Helpful update trigger
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare
  trg record;
begin
  for trg in
    select unnest(array['customers','customer_format_profiles','orders','source_pos','part_aliases']) as table_name
  loop
    execute format($f$
      drop trigger if exists trg_set_updated_at on %I;
      create trigger trg_set_updated_at before update on %I
        for each row execute function set_updated_at();
    $f$, trg.table_name, trg.table_name);
  end loop;
end $$;

-- Storage bucket for documents (idempotent)
insert into storage.buckets (id, name, public)
values ('obara-documents', 'obara-documents', false)
on conflict (id) do nothing;

-- Restrict uploads to authenticated users (fine-grained tenant filtering happens via the API layer)
do $$
begin
  begin
    drop policy if exists "obara documents read" on storage.objects;
    drop policy if exists "obara documents write" on storage.objects;
  exception when undefined_object then null;
  end;
  create policy "obara documents read" on storage.objects
    for select using (bucket_id = 'obara-documents' and auth.role() = 'authenticated');
  create policy "obara documents write" on storage.objects
    for insert with check (bucket_id = 'obara-documents' and auth.role() = 'authenticated');
end $$;
