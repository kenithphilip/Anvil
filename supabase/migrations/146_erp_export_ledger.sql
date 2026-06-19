-- 146_erp_export_ledger.sql
-- ERP-push idempotency / export ledger (PR3).
--
-- The README claims "ERP export with idempotency", but requireApprovedOrder
-- explicitly permits re-export and the HTTP push handlers (SAP, NetSuite,
-- D365, Acumatica, P21, Eclipse, SX.e, Sage X3, IFS, Oracle Fusion, Ramco,
-- JDE, Plex, JobBoss, Oracle EBS, proALPHA) send no idempotency key and do
-- not check whether an order was already exported. A double-click or two
-- overlapping pushes therefore create DUPLICATE sales orders in the live
-- ERP. The retry queue's atomic claim only prevents concurrent *retry*
-- duplicates, not first-call duplicates.
--
-- This ledger generalises the proven Tally pattern (tally_voucher_records
-- unique on (tenant_id, voucher_no, payload_hash)) to every HTTP connector:
-- a success row is keyed by (tenant_id, order_id, connector, payload_hash).
-- A push that matches an existing success row short-circuits to a no-op
-- returning the prior external id; a push whose payload hash changed is
-- blocked unless the caller opts into an explicit re-export. Tally keeps
-- its own ledger and is intentionally not duplicated here.

create table if not exists erp_export_ledger (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  order_id uuid not null,
  connector text not null,                     -- external_systems key: sap, netsuite, ifs, oracle_ebs, sage_x3, ...
  payload_hash text not null,                  -- the approval-bound hash this export was built from
  external_id text,                            -- the ERP-side sales order id returned on success
  status text not null default 'success'
    check (status in ('success')),
  last_pushed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, order_id, connector, payload_hash)
);

create index if not exists erp_export_ledger_order_idx
  on erp_export_ledger (tenant_id, order_id, connector);

alter table erp_export_ledger enable row level security;
drop policy if exists erp_export_ledger_select on erp_export_ledger;
create policy erp_export_ledger_select on erp_export_ledger
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists erp_export_ledger_write on erp_export_ledger;
create policy erp_export_ledger_write on erp_export_ledger
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

comment on table erp_export_ledger is
  'PR3: idempotency ledger for ERP sales-order exports. One success row per (tenant, order, connector, payload_hash); guards the HTTP push handlers against duplicate ERP orders.';
