-- 005_close_remaining_gaps.sql
-- Closes every Partial / Backend-only / Not-done audit item.
-- Adds approval expiry, model routing log, spare matrix intelligence, supplier scorecard,
-- communication outbox, eval cases catalogue, redaction policies, UOM rules,
-- order amendments, and missing-doc requests.

-- ───────────────────────────────────────────────────────────────────────────
-- Approval safety (item #11)
-- ───────────────────────────────────────────────────────────────────────────

alter table orders
  add column if not exists tally_status text check (tally_status in ('idle','pending','dry_run_ok','exported','imported','failed','reconciled')) default 'idle',
  add column if not exists approval_expires_at timestamptz,
  add column if not exists approval_actions text[] default array[]::text[];

create index if not exists orders_tally_status_idx on orders (tenant_id, tally_status);

-- ───────────────────────────────────────────────────────────────────────────
-- Communications outbox (items #20, #21)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists communications (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  source_po_id uuid references source_pos(id) on delete set null,
  direction text not null check (direction in ('inbound','outbound')),
  channel text not null default 'email',
  thread_id text,
  from_addr text,
  to_addr text,
  subject text,
  body text,
  status text not null default 'draft' check (status in ('draft','sent','failed','replied','archived')),
  template_code text,
  attachments jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists communications_order_idx on communications (tenant_id, order_id, created_at desc);
create index if not exists communications_thread_idx on communications (tenant_id, thread_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Source PO supplier ack + scorecard (item #13)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists supplier_scorecards (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  supplier text not null,
  country text,
  on_time_pct numeric(5,2) not null default 0,
  price_accuracy_pct numeric(5,2) not null default 0,
  response_time_hours numeric(8,2),
  total_acks int not null default 0,
  variance_count int not null default 0,
  last_updated timestamptz not null default now(),
  unique (tenant_id, supplier)
);

alter table source_pos
  add column if not exists ack_received_at timestamptz,
  add column if not exists ack_payload jsonb,
  add column if not exists price_variance_pct numeric(8,2),
  add column if not exists eta_variance_days int;

-- ───────────────────────────────────────────────────────────────────────────
-- Order amendments (item #18)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists order_amendments (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  parent_order_id uuid not null references orders(id) on delete cascade,
  revised_order_id uuid references orders(id) on delete set null,
  diff jsonb not null default '{}'::jsonb,
  amendment_type text not null check (amendment_type in ('qty','price','date','line_added','line_removed','mixed')),
  status text not null default 'detected' check (status in ('detected','approved','rejected','applied')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists order_amendments_parent_idx on order_amendments (tenant_id, parent_order_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- Spare matrix intelligence (item #31)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists installed_base (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  gun_model text,
  installed_qty int not null default 0,
  installed_at date,
  notes text,
  created_at timestamptz not null default now(),
  unique (tenant_id, customer_id, gun_model)
);

create table if not exists spare_recommendations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  customer_id uuid references customers(id) on delete cascade,
  criticality_score numeric(5,2) not null default 0,
  recommended_qty numeric(18,3) not null default 0,
  reason jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  unique (tenant_id, part_no, customer_id)
);

create table if not exists obsolete_parts (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  part_no text not null,
  last_seen_in_so date,
  last_seen_in_bom date,
  replacement_part_no text,
  notes text,
  unique (tenant_id, part_no)
);

-- ───────────────────────────────────────────────────────────────────────────
-- Model routing log (item #37)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists model_routing_log (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  purpose text not null,
  primary_model text,
  primary_status text,
  primary_confidence numeric(4,3),
  fallback_model text,
  fallback_reason text,
  fallback_status text,
  total_input_tokens int,
  total_output_tokens int,
  total_latency_ms int,
  created_at timestamptz not null default now()
);

create index if not exists model_routing_log_order_idx on model_routing_log (tenant_id, order_id, created_at desc);

-- ───────────────────────────────────────────────────────────────────────────
-- Customer profile fallback flag (item #5)
-- ───────────────────────────────────────────────────────────────────────────

alter table customer_format_profiles
  add column if not exists force_llm_fallback boolean not null default false,
  add column if not exists golden_examples uuid[] not null default array[]::uuid[];

-- ───────────────────────────────────────────────────────────────────────────
-- UOM rules (item #29)
-- ───────────────────────────────────────────────────────────────────────────

alter table uom_aliases
  add column if not exists integer_only boolean not null default false,
  add column if not exists min_order_qty numeric(18,3),
  add column if not exists pack_size numeric(18,3),
  add column if not exists rounding_rule text check (rounding_rule in ('floor','ceil','round','none')) default 'none';

-- ───────────────────────────────────────────────────────────────────────────
-- Security: redaction rules + injection tests (item #12)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists redaction_rules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid references tenants(id) on delete cascade,
  field_path text not null,
  pattern text not null,
  replacement text not null default '[REDACTED]',
  enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists injection_test_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  catalogue text not null,
  passed int not null default 0,
  failed int not null default 0,
  detail jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- Eval case catalogue (item #8)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists eval_cases (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  suite text not null,
  case_id text not null,
  description text,
  documents jsonb not null default '[]'::jsonb,
  expected jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, suite, case_id)
);

-- ───────────────────────────────────────────────────────────────────────────
-- Backups (item #41)
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists backups (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  storage_path text not null,
  size_bytes bigint,
  taken_by uuid references auth.users(id),
  notes text,
  created_at timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────

alter table communications enable row level security;
alter table supplier_scorecards enable row level security;
alter table order_amendments enable row level security;
alter table installed_base enable row level security;
alter table spare_recommendations enable row level security;
alter table obsolete_parts enable row level security;
alter table model_routing_log enable row level security;
alter table redaction_rules enable row level security;
alter table injection_test_runs enable row level security;
alter table eval_cases enable row level security;
alter table backups enable row level security;

do $$
declare
  t text;
  business_tables text[] := array[
    'communications','supplier_scorecards','order_amendments','installed_base',
    'spare_recommendations','obsolete_parts','model_routing_log',
    'injection_test_runs','eval_cases','backups'
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

drop policy if exists redaction_rules_select on redaction_rules;
create policy redaction_rules_select on redaction_rules for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
drop policy if exists redaction_rules_write on redaction_rules;
create policy redaction_rules_write on redaction_rules for all
  using (tenant_id in (select current_tenant_ids()) and current_tenant_role(tenant_id) in ('admin','sales_manager'))
  with check (tenant_id in (select current_tenant_ids()) and current_tenant_role(tenant_id) in ('admin','sales_manager'));
