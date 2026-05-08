-- Audit P7.6. Recurring invoice schedules.
--
-- AMC contracts (and other long-running engagements) have a billing
-- cadence independent of visit cadence: e.g., quarterly invoices
-- regardless of how many visits actually happen that quarter. This
-- table holds the schedule + cadence; the cron at
-- /api/billing/recurring_cron walks rows where next_invoice_date
-- has arrived and the status is ACTIVE, materialising one invoices
-- row per drain pass and advancing next_invoice_date.

do $$ begin
  if not exists (select 1 from pg_type where typname = 'recurring_invoice_status') then
    create type recurring_invoice_status as enum ('ACTIVE', 'PAUSED', 'CANCELLED');
  end if;
end $$;

create table if not exists recurring_invoice_schedules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  customer_id uuid not null references customers(id) on delete cascade,

  cadence text not null check (cadence in ('MONTHLY', 'QUARTERLY', 'BIANNUAL', 'ANNUAL')),
  amount numeric(14, 2) not null,
  currency text not null default 'INR',

  start_date date not null,
  next_invoice_date date not null,
  end_date date,

  invoice_count int not null default 0,
  max_invoices int,                      -- null = open-ended

  description text,
  line_items jsonb not null default '[]'::jsonb,
  payment_terms text default 'Net 30',
  net_days int default 30,

  status recurring_invoice_status not null default 'ACTIVE',

  last_invoice_id uuid references invoices(id) on delete set null,
  last_invoiced_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists ris_due_idx
  on recurring_invoice_schedules (tenant_id, status, next_invoice_date);
create index if not exists ris_contract_idx
  on recurring_invoice_schedules (tenant_id, contract_id);
create index if not exists ris_customer_idx
  on recurring_invoice_schedules (tenant_id, customer_id);

alter table recurring_invoice_schedules enable row level security;

drop policy if exists ris_select on recurring_invoice_schedules;
create policy ris_select on recurring_invoice_schedules
  for select using (tenant_id in (select current_tenant_ids()));

drop policy if exists ris_write on recurring_invoice_schedules;
create policy ris_write on recurring_invoice_schedules
  for all using (tenant_id in (select current_tenant_ids()))
         with check (tenant_id in (select current_tenant_ids()));
