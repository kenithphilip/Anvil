-- 197_gun_drawings.sql — EG sheets + 2D/3D drawings per gun.
--
-- One row per uploaded artifact, linked to a spare_matrix gun row.
-- Supports a BULK-UPLOAD staging flow: files upload to storage (the
-- `documents` table), each is filename-matched to a gun, the reviewer
-- CORRECTS any mismatch, then commits.
--
--   kind    : eg_sheet | drawing_2d | drawing_3d
--   format  : pdf | dwg | step | link   (EG=pdf; 2D=pdf|dwg; 3D=step file OR external link)
--   payload : document_id (uploaded file) OR link_url (external, e.g. a large 3D STEP in a PDM)
--
-- Every row records the uploader + their role at upload time (the upload
-- TRACK). approval_status is PROVISIONED (defaults 'pending') for a future
-- approval workflow — no approval gate is enforced yet.
--
-- Idempotent. Standard tenant-scoped RLS (pattern from 159_spare_matrix).

create table if not exists gun_drawings (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  matrix_id uuid not null references spare_matrix(id) on delete cascade,
  -- Resolved gun row (null until matched/corrected). gun_no is the
  -- matched/corrected gun number, kept denormalised so the drawing
  -- survives a spare_matrix_rows delete (on delete set null).
  row_id uuid references spare_matrix_rows(id) on delete set null,
  gun_no text,
  kind text not null check (kind in ('eg_sheet', 'drawing_2d', 'drawing_3d')),
  format text check (format in ('pdf', 'dwg', 'step', 'link')),
  -- Payload: either an uploaded document, or an external link (typically
  -- a large 3D STEP model kept in a PDM / shared drive).
  document_id uuid references documents(id) on delete set null,
  link_url text,
  original_filename text,
  file_size bigint,
  -- Filename -> gun match outcome the reviewer corrects before commit.
  match_status text not null default 'unmatched' check (match_status in
    ('matched', 'matched_suffix', 'ambiguous', 'unmatched', 'wrong_type', 'duplicate', 'resolved')),
  match_detail jsonb not null default '{}'::jsonb,   -- { parsed_gun, suffix, candidates: [...] }
  -- Upload TRACK: who uploaded, and their role/team at upload time.
  uploaded_by uuid,
  uploader_role text,
  -- Staging lifecycle.
  status text not null default 'staged' check (status in ('staged', 'committed', 'discarded')),
  -- Approval PROVISION (workflow not enforced yet).
  approval_status text not null default 'pending' check (approval_status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gun_drawings_matrix_idx on gun_drawings (tenant_id, matrix_id, status);
create index if not exists gun_drawings_gun_idx on gun_drawings (tenant_id, gun_no);
create index if not exists gun_drawings_row_idx on gun_drawings (row_id);

-- One COMMITTED artifact per (matrix, gun, kind). Staged rows are left
-- unconstrained so a batch can hold duplicates for the reviewer to
-- resolve; only commit enforces uniqueness.
create unique index if not exists gun_drawings_committed_uidx
  on gun_drawings (matrix_id, gun_no, kind)
  where status = 'committed';

alter table gun_drawings enable row level security;
drop policy if exists gun_drawings_select on gun_drawings;
create policy gun_drawings_select on gun_drawings
  for select using (tenant_id in (select current_tenant_ids()));
drop policy if exists gun_drawings_write on gun_drawings;
create policy gun_drawings_write on gun_drawings
  for all using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id in (select current_tenant_ids()));

create or replace function gun_drawings_touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists gun_drawings_updated_at on gun_drawings;
create trigger gun_drawings_updated_at before update on gun_drawings
  for each row execute function gun_drawings_touch_updated_at();

comment on table gun_drawings is
  'EG sheet (PDF) + 2D (PDF/DWG) + 3D (STEP file or external link) per spare_matrix gun. Bulk-uploaded, filename-matched to a gun, corrected, then committed. Records uploader + role (upload track); approval_status provisioned for a future approval workflow.';
