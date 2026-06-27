-- 160_gun_drawings.sql
--
-- Gun assembly drawings (PDF / DWG / STEP) attached to a gun so the spare
-- matrix can show the drawing while spares are identified on the gun. The file
-- itself is stored via the documents pipeline (signed upload + ClamAV scan +
-- storage bucket); this table links a scanned document to a gun by gun_no
-- (matches spare-matrix rows and bom_assets.asset_code), so a drawing is
-- intrinsic to the gun and reused across every matrix.

create table if not exists gun_drawings (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  gun_no text not null,                       -- matches spare matrix row gun_no / bom_assets.asset_code
  document_id uuid not null references documents(id) on delete cascade,
  format text,                                -- pdf | dwg | step | other
  label text,                                 -- e.g. Assembly, Exploded view
  is_primary boolean not null default false,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, document_id)
);

create index if not exists gun_drawings_idx on gun_drawings (tenant_id, gun_no);

alter table gun_drawings enable row level security;
drop policy if exists "gun_drawings_all" on gun_drawings;
create policy "gun_drawings_all" on gun_drawings
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
