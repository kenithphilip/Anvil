-- Logistics P1: what the supplier promised, and when the promise changed.
--
-- `shipments` records only ACTUAL ladder dates (ready_date, vessel_sailing_date,
-- port_arrival_date, warehouse_receipt_date). It has no forward-looking ETA
-- column at all, so the daily workbook's "ETA @ Indian Port", "ETA @ store",
-- "Delayed Shipment Update-ETA …" and "Revised ETA at store" were parsed and
-- then flattened into the free-text `remarks` blob. An operator could read
-- "ETA store (promised): 2026-08-09" on one shipment; nobody could ask which
-- shipments were slipping, by how much, or whether a slip threatened a customer
-- commitment.
--
-- Deliberately NOT a `delay_count` column on `shipments`.
--
-- A stored counter is a number that only goes up and can drift from what
-- actually happened; the workbook's own "No. of Delays" is hand-maintained, so
-- mirroring it would import a figure Anvil could never verify. This table is the
-- fact log instead: revision count, slip days and trend are all DERIVED from it
-- (see src/api/_lib/logistics/eta-history.js), so they cannot disagree with the
-- evidence.
--
-- A row is written only when a promise CHANGES. Re-importing the same workbook
-- is a no-op, and every row is therefore a real revision. The first row for a
-- shipment is its baseline — the original promise everything later is measured
-- against.

create table if not exists shipment_eta_observations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  -- The promise as of this observation. Either may be null: a sheet can carry a
  -- port ETA weeks before anyone commits to a store date.
  eta_port date,
  eta_store date,
  -- What the previous observation said, denormalised so a single row is
  -- readable on its own ("moved 2026-08-02 -> 2026-08-09") without a window
  -- function. Null on the baseline row.
  prev_eta_port date,
  prev_eta_store date,
  -- Net movement in days, positive = later than before. Stored because it is
  -- computed from the pair at write time and is what every read filters on;
  -- the CUMULATIVE slip against baseline stays derived.
  slip_port_days int,
  slip_store_days int,
  -- 'baseline' for the first observation, 'revision' thereafter. Lets a query
  -- count revisions without an offset-by-one everywhere.
  kind text not null default 'revision'
    check (kind in ('baseline', 'revision')),
  source text not null default 'workbook_import',
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- The read path is always "this shipment's history, oldest first".
create index if not exists shipment_eta_obs_shipment_idx
  on shipment_eta_observations (tenant_id, shipment_id, observed_at);
-- "What slipped recently, across the tenant" — the P2/P3 float queries.
create index if not exists shipment_eta_obs_recent_idx
  on shipment_eta_observations (tenant_id, observed_at desc);

alter table shipment_eta_observations enable row level security;
drop policy if exists "shipment_eta_observations_all" on shipment_eta_observations;
create policy "shipment_eta_observations_all" on shipment_eta_observations
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
