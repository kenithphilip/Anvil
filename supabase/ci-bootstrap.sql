-- Supabase shim for the CI migration-apply check.
--
-- `supabase/migrations/` is written against a Supabase database, which supplies
-- a few things a stock Postgres does not: the `auth` and `storage` schemas
-- (GoTrue / Storage own them, so no migration creates them), the built-in roles
-- the grants target, and four extensions. Without these the migration set can't
-- even be parsed, so CI could never execute it.
--
-- This file recreates the MINIMUM surface the migrations actually touch —
-- verified by grepping the whole migration set:
--   • auth.users(id)          92 foreign-key references
--   • auth.uid / jwt / role   referenced inside RLS policy expressions, which
--                             Postgres parses at CREATE POLICY time, so the
--                             functions must exist even though nothing calls them
--   • storage.buckets/objects one insert + policies on them
--   • anon / authenticated /  grant targets (a grant to a missing role errors)
--     service_role
--   • uuid-ossp, pgcrypto, pg_trgm, vector
-- auth.mfa_factors / auth.mfa_challenges appear ONLY in comments, so they are
-- deliberately not stubbed.
--
-- This is a throwaway CI database. These stubs are NOT security-equivalent to
-- Supabase's real implementations (auth.uid() returns null rather than reading
-- a JWT) — they exist so the DDL parses and executes. The job asserts that the
-- migrations APPLY, not that RLS behaves correctly at runtime.

-- ── Extensions ─────────────────────────────────────────────────────────────
-- `vector` requires the pgvector image (see .github/workflows/ci.yml).
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;

-- ── Roles the grants target ────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

-- ── auth schema (GoTrue) ───────────────────────────────────────────────────
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- Referenced inside policy expressions; must exist at CREATE POLICY time.
create or replace function auth.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

create or replace function auth.role() returns text
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

-- ── storage schema ─────────────────────────────────────────────────────────
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id) on delete cascade,
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

grant usage on schema auth, storage to anon, authenticated, service_role;
