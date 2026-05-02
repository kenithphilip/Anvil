-- Eval (golden test) tables and email-intake support

create table if not exists eval_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  suite text not null,
  passed int not null default 0,
  failed int not null default 0,
  total_score numeric(5, 4),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists eval_runs_tenant_idx on eval_runs (tenant_id, created_at desc);

create table if not exists eval_case_results (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  run_id uuid not null references eval_runs(id) on delete cascade,
  case_id text not null,
  passed int not null default 0,
  failed int not null default 0,
  score numeric(5, 4),
  checks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists eval_case_results_run_idx on eval_case_results (run_id);

alter table eval_runs enable row level security;
alter table eval_case_results enable row level security;

do $$
begin
  drop policy if exists eval_runs_select on eval_runs;
  create policy eval_runs_select on eval_runs for select using (tenant_id in (select current_tenant_ids()));
  drop policy if exists eval_runs_insert on eval_runs;
  create policy eval_runs_insert on eval_runs for insert with check (tenant_id in (select current_tenant_ids()));
  drop policy if exists eval_case_results_select on eval_case_results;
  create policy eval_case_results_select on eval_case_results for select using (tenant_id in (select current_tenant_ids()));
  drop policy if exists eval_case_results_insert on eval_case_results;
  create policy eval_case_results_insert on eval_case_results for insert with check (tenant_id in (select current_tenant_ids()));
end $$;

-- Email intake routing rules (optional)
create table if not exists email_intake_rules (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  match_subject text,
  match_from text,
  match_to text,
  default_classification text,
  notes text,
  created_at timestamptz not null default now()
);

alter table email_intake_rules enable row level security;
do $$
begin
  drop policy if exists email_rules_select on email_intake_rules;
  create policy email_rules_select on email_intake_rules for select using (tenant_id in (select current_tenant_ids()));
  drop policy if exists email_rules_write on email_intake_rules;
  create policy email_rules_write on email_intake_rules for all using (current_tenant_role(tenant_id) in ('admin','sales_manager'));
end $$;

-- Helpers for evaluating accuracy across customers and time
create or replace view eval_accuracy_by_suite as
select tenant_id, suite, count(*) as runs, avg(total_score) as avg_score, max(created_at) as last_run
from eval_runs group by tenant_id, suite;
