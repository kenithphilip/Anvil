/*
 * 100_users_and_tenants.sql  --  Phase 1 of the Anvil seed pack.
 *
 * Purpose
 *   Establish the test-environment identity layer: 15 auth.users
 *   spanning every role in obara_role and every tenant_member_status,
 *   the per-tenant settings row, the SOC 2 access_review ledger seed,
 *   the security audit timeline, MCP tokens, redaction rules, FX
 *   rates, lead times, taxonomies, logistics ports/carriers, magic
 *   link audit, and the rate-limit ledgers.
 *
 * Prerequisites
 *   - Migrations 001..059 applied.
 *   - supabase/seed.sql applied (creates the default tenant +
 *     6 corpus customers). Re-running it after this file is safe.
 *   - Postgres role: service_role or postgres superuser. RLS is
 *     active on most tenant-scoped tables; an authenticated session
 *     will silently no-op the inserts.
 *   - Run as:
 *       set app.seed_env = 'staging';   -- or 'local' / 'ci'
 *       \i supabase/seed/100_users_and_tenants.sql
 *
 * Idempotency
 *   Every insert uses `on conflict ... do nothing`. Re-running the
 *   file is a no-op against an already-seeded database. UUIDs are
 *   deterministic (uuid_generate_v5 keyed on a seed namespace) so
 *   later phase files can reference them by formula without lookup.
 *
 * Deterministic UUID namespaces
 *   Users:      uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:' || email)
 *   Everything else (tenant_settings, mcp_tokens, etc.):
 *               uuid_generate_v5(seed_ns, '<entity>:<key>')
 *               seed_ns = 'd7a7e5e4-0001-0001-0001-000000000001'
 *
 * Seed marker
 *   Every row whose table has a jsonb metadata / settings / payload
 *   column gets `{"seed_marker": "anvil-test-seed-v1"}` merged in,
 *   so 900_teardown.sql can delete precisely.
 *
 * Test credentials (do NOT use outside staging / local / CI)
 *   Common password: Anvil!Seed#2026
 *   Shared TOTP secret (base32): JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
 *     - Enroll in any TOTP authenticator (Authy / 1Password / Google
 *       Authenticator) under "Anvil Staging".
 *     - Used by:  admin.primary, mgr.alpha, fin.alpha
 *
 * Deviations from the prompt
 *   1. The `operator` value is missing from the `obara_role` enum
 *      (no migration ever added it, despite docs/RBAC.md claiming
 *      migration 010 would). This file adds the enum value
 *      idempotently at the top so locked decision A's user fixture
 *      ("ops.alpha" with role=operator) actually inserts.
 *   2. The matrix's "4 passkeys for 2 users" is overridden by the
 *      prompt's locked decision A which says "one passkey fixture
 *      row in user_passkeys for user #4". Following the prompt.
 */

-- ───────────────────────────────────────────────────────────────────
-- 0. ENV GUARD  --  refuses to seed unless app.seed_env is set
-- ───────────────────────────────────────────────────────────────────
do $guard$
begin
  if current_setting('app.seed_env', true) is null
     or current_setting('app.seed_env', true) not in ('staging', 'local', 'ci') then
    raise exception 'Refusing to seed: app.seed_env must be set to staging, local, or ci. Got: %',
      coalesce(current_setting('app.seed_env', true), '<unset>');
  end if;
end $guard$;


-- ───────────────────────────────────────────────────────────────────
-- 1. SCHEMA REPAIRS  --  fill enum gaps the migrations missed
-- ───────────────────────────────────────────────────────────────────
-- Add 'operator' to obara_role if absent. ALTER TYPE ... ADD VALUE
-- IF NOT EXISTS is supported on Postgres 12+ and is itself idempotent.
--
-- Must run OUTSIDE any explicit transaction. Postgres rejects use of
-- a newly-added enum value in the same transaction that adds it
-- ('unsafe use of new value of enum type'); psql's implicit
-- per-statement transaction commits this immediately so the rest of
-- the file (in an explicit `begin; ... commit;` block below) can
-- cast strings to `obara_role` freely.
alter type obara_role add value if not exists 'operator';

begin;

-- Best-effort: prefer the postgres role inside the transaction. Harmless if not permitted.
do $role$
begin
  begin
    set local role 'postgres';
  exception when others then
    null;
  end;
end $role$;

-- ───────────────────────────────────────────────────────────────────
-- 2. AUTH USERS  --  15 deterministic identities
-- ───────────────────────────────────────────────────────────────────
do $auth$
declare
  seed_now           timestamptz := now();
  default_tenant     uuid := '00000000-0000-0000-0000-000000000001';
  password_hash      text;
  totp_b32           text := 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  rec                record;
  -- Local variable holding the per-row user UUID. Named `v_user_id`
  -- to avoid shadowing `tenant_members.user_id` /
  -- `user_security_settings.user_id` inside the ON CONFLICT clauses
  -- below (Postgres rejects the column reference as ambiguous when a
  -- PL/pgSQL variable shares its name).
  v_user_id          uuid;
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'auth') then
    raise notice 'auth schema not found; skipping auth.users seed (run on a Supabase project).';
    return;
  end if;

  -- Backfill empty-string tokens on previously-seeded rows. Earlier
  -- versions of this seed inserted NULL into confirmation_token /
  -- recovery_token / email_change which GoTrue rejects on signin
  -- ('Database error querying schema'). Fix in place; no impact on
  -- properly-seeded rows.
  update auth.users set
    confirmation_token         = coalesce(confirmation_token, ''),
    recovery_token             = coalesce(recovery_token, ''),
    email_change               = coalesce(email_change, ''),
    email_change_token_new     = coalesce(email_change_token_new, ''),
    email_change_token_current = coalesce(email_change_token_current, ''),
    phone_change               = coalesce(phone_change, ''),
    phone_change_token         = coalesce(phone_change_token, ''),
    reauthentication_token     = coalesce(reauthentication_token, ''),
    is_super_admin             = coalesce(is_super_admin, false)
  where email like '%@anvil.test'
    and (confirmation_token is null
         or recovery_token is null
         or email_change is null
         or email_change_token_new is null
         or email_change_token_current is null
         or phone_change is null
         or phone_change_token is null
         or reauthentication_token is null
         or is_super_admin is null);

    -- bcrypt the shared password once. pgcrypto is enabled in 001.
  password_hash := crypt('Anvil!Seed#2026', gen_salt('bf', 10));

  for rec in select * from (values
    -- email,                              role,             status,        wants_totp, wants_passkey,  display_name
    ('admin.primary@anvil.test',           'admin',          'approved',    true,       false,          'Priya Iyer'),
    ('admin.recovery@anvil.test',          'admin',          'approved',    false,      false,          'Rohan Mehta'),
    ('eng.alpha@anvil.test',               'sales_engineer', 'approved',    false,      false,          'Anand Kapoor'),
    ('eng.beta@anvil.test',                'sales_engineer', 'approved',    false,      true,           'Bhavna Rao'),
    ('eng.charlie@anvil.test',             'sales_engineer', 'pending',     false,      false,          'Chetan Sharma'),
    ('mgr.alpha@anvil.test',               'sales_manager',  'approved',    true,       false,          'Maya Krishnan'),
    ('mgr.beta@anvil.test',                'sales_manager',  'approved',    false,      false,          'Manish Bansal'),
    ('prc.alpha@anvil.test',               'procurement',    'approved',    false,      false,          'Pranav Joshi'),
    ('prc.beta@anvil.test',                'procurement',    'approved',    false,      false,          'Pooja Nair'),
    ('fin.alpha@anvil.test',               'finance',        'approved',    true,       false,          'Farah Sheikh'),
    ('fin.beta@anvil.test',                'finance',        'approved',    false,      false,          'Faisal Ahmed'),
    ('ops.alpha@anvil.test',               'operator',       'approved',    false,      false,          'Omar Patel'),
    ('vwr.alpha@anvil.test',               'viewer',         'approved',    false,      false,          'Vinod Rangaraj'),
    ('denied.user@anvil.test',             'sales_engineer', 'denied',      false,      false,          'Denis Carter'),
    ('deactivated.user@anvil.test',        'sales_engineer', 'deactivated', false,      false,          'Dipti Naidu')
  ) as t(email, role, status, wants_totp, wants_passkey, display_name)
  loop
    v_user_id := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:' || rec.email);

    -- auth.users row. instance_id and aud per Supabase 2024+ schema.
    begin
      insert into auth.users (
        id, instance_id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at, is_sso_user, is_anonymous,
        confirmation_token, recovery_token, email_change,
        email_change_token_new, email_change_token_current,
        phone_change, phone_change_token, reauthentication_token
      ) values (
        v_user_id,
        '00000000-0000-0000-0000-000000000000'::uuid,
        'authenticated',
        'authenticated',
        rec.email,
        password_hash,
        seed_now,
        jsonb_build_object(
          'provider', 'email',
          'providers', jsonb_build_array('email'),
          'seed_marker', 'anvil-test-seed-v1'
        ),
        jsonb_build_object(
          'name', rec.display_name,
          'full_name', rec.display_name,
          'seed_marker', 'anvil-test-seed-v1'
        ),
        seed_now - interval '120 days',
        seed_now - interval '120 days',
        false,
        false
      ) on conflict (id) do nothing;
    exception
      when insufficient_privilege then
        raise notice 'Insufficient privilege to insert into auth.users; skipping.  Use service_role.';
        return;
    end;

    -- auth.identities row.  Required for signInWithPassword: Supabase
    -- looks up the user by email via this table (provider='email'),
    -- not by querying auth.users.email directly. Without this row,
    -- password auth fails with 'Database error querying schema'.
    --
    -- The proper way to create a user is svc.auth.admin.createUser()
    -- which writes both rows; we used a direct INSERT INTO auth.users
    -- here for self-contained replayability, so we must mirror the
    -- identity row by hand.
    --
    -- Schema (Supabase 2024+):
    --   provider_id text       -- the user's id as text for 'email' provider
    --   provider text          -- 'email' for password auth
    --   user_id uuid           -- FK to auth.users(id)
    --   identity_data jsonb    -- { sub, email, email_verified: true, phone_verified: false }
    --   email text             -- GENERATED ALWAYS AS (lower(identity_data->>'email')) STORED
    --   id uuid primary key
    -- Composite unique: (provider_id, provider).
    begin
      insert into auth.identities (
        id,
        user_id,
        provider_id,
        provider,
        identity_data,
        last_sign_in_at,
        created_at,
        updated_at
      ) values (
        uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'identity:' || rec.email),
        v_user_id,
        v_user_id::text,
        'email',
        jsonb_build_object(
          'sub', v_user_id::text,
          'email', rec.email,
          'email_verified', true,
          'phone_verified', false
        ),
        null,
        seed_now - interval '120 days',
        seed_now - interval '120 days'
      ) on conflict (provider_id, provider) do nothing;
    exception
      when insufficient_privilege then
        raise notice 'Insufficient privilege to insert into auth.identities; skipping.';
      when others then
        -- If the schema differs (older Supabase versions), continue.
        raise notice 'auth.identities insert failed: %; password auth may not work for seeded users.', sqlerrm;
    end;

    -- tenant_members row.  status carries the access-request fields.
    insert into tenant_members (
      tenant_id, user_id, role, status, requested_role,
      requested_at, approved_by, approved_at, denied_by, denied_at, denied_reason,
      request_email, request_display_name, request_notes, created_at
    ) values (
      default_tenant,
      v_user_id,
      rec.role::obara_role,
      rec.status::tenant_member_status,
      case when rec.status in ('pending','denied','deactivated') then rec.role::obara_role else null end,
      seed_now - case rec.status
        when 'pending'     then interval '1 day'
        when 'denied'      then interval '20 days'
        when 'deactivated' then interval '60 days'
        else                    interval '90 days'
      end,
      case when rec.status = 'approved' and rec.email <> 'admin.primary@anvil.test'
           then uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test')
           when rec.status = 'approved' and rec.email = 'admin.primary@anvil.test' then v_user_id
           else null end,
      case when rec.status = 'approved' then seed_now - interval '89 days' else null end,
      case when rec.status = 'denied'
           then uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test')
           else null end,
      case when rec.status = 'denied' then seed_now - interval '19 days' else null end,
      case when rec.status = 'denied' then 'Outside contractor window; reapply through HR.' else null end,
      rec.email,
      rec.display_name,
      case rec.status
        when 'pending'     then 'Joined the new spares-engineering pod.'
        when 'denied'      then 'External candidate; not staffed yet.'
        when 'deactivated' then 'Offboarded May 2026.'
        else                    null
      end,
      seed_now - interval '120 days'
    ) on conflict (tenant_id, user_id) do nothing;

    -- user_security_settings: one row per user. TOTP fixture for 3.
    insert into user_security_settings (
      user_id, totp_enrolled, totp_secret, passkey_enrolled,
      require_mfa, last_security_change_at, created_at, updated_at
    ) values (
      v_user_id,
      rec.wants_totp,
      case when rec.wants_totp then totp_b32 else null end,
      rec.wants_passkey,
      rec.wants_totp,
      seed_now - interval '30 days',
      seed_now - interval '120 days',
      seed_now - interval '30 days'
    ) on conflict (user_id) do nothing;
  end loop;
end $auth$;

-- ───────────────────────────────────────────────────────────────────
-- 3. PASSKEY FIXTURE  --  one row for eng.beta (user #4)
-- ───────────────────────────────────────────────────────────────────
do $passkey$
declare
  beta_id uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.beta@anvil.test');
begin
  insert into user_passkeys (
    id, user_id, credential_id, public_key, counter, transports,
    label, backup_eligible, backup_state, device_type, last_used_at, created_at
  ) values (
    uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'passkey:eng.beta:macbook'),
    beta_id,
    -- 32 bytes of credential id, base64url-encoded fixture (random sha256 of a label)
    encode(digest('anvil-seed-passkey:eng.beta:credential-id', 'sha256'), 'hex'),
    -- 64 bytes of "public key" fixture
    encode(digest('anvil-seed-passkey:eng.beta:public-key-1', 'sha256'), 'hex')
      || encode(digest('anvil-seed-passkey:eng.beta:public-key-2', 'sha256'), 'hex'),
    7,
    array['internal','hybrid'],
    'MacBook Pro (Touch ID)',
    true,
    true,
    'multi_device',
    now() - interval '2 days',
    now() - interval '40 days'
  ) on conflict (credential_id) do nothing;
end $passkey$;

-- ───────────────────────────────────────────────────────────────────
-- 4. TENANT_SETTINGS  --  default tenant gets a settings row
-- ───────────────────────────────────────────────────────────────────
insert into tenant_settings (
  tenant_id, invoice_format, invoice_prefix, default_payment_terms,
  default_currency, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000001'::uuid,
  '{prefix}-{number:04}', 'INV', 'Net 30 days NEFT',
  'INR', now() - interval '120 days', now() - interval '5 days'
) on conflict (tenant_id) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 5. ADMIN_NOTIFICATIONS  --  in-portal bell items
-- ───────────────────────────────────────────────────────────────────
do $notif$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  charlie_id     uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.charlie@anvil.test');
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
begin
  -- Pending access request (the only unresolved one — drives the bell badge).
  insert into admin_notifications (
    id, tenant_id, kind, title, body, link_route, link_params,
    actor_user_id, actor_email, object_type, object_id, read_by, resolved, created_at
  ) values (
    uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'notif:access_request:eng.charlie'),
    default_tenant, 'access_request',
    'New access request: Chetan Sharma',
    'eng.charlie@anvil.test requested role sales_engineer. Notes: "Joined the new spares-engineering pod."',
    'admin', '{"tab": "access"}'::jsonb,
    charlie_id, 'eng.charlie@anvil.test',
    'tenant_member', null, '{}', false,
    now() - interval '1 day'
  ) on conflict (id) do nothing;

  -- Resolved access requests (background context).
  insert into admin_notifications (id, tenant_id, kind, title, body, link_route, link_params,
                                   actor_user_id, actor_email, object_type, read_by,
                                   resolved, resolved_by, resolved_at, resolution_note, created_at)
  values
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'notif:access_request:denied.user'),
     default_tenant, 'access_request', 'Access request: Denis Carter',
     'denied.user@anvil.test requested role sales_engineer.',
     'admin', '{"tab":"access"}'::jsonb,
     uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:denied.user@anvil.test'),
     'denied.user@anvil.test', 'tenant_member', '{}',
     true, primary_admin, now() - interval '19 days',
     'Denied: external; not staffed.', now() - interval '20 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'notif:cron_stalled:netsuite'),
     default_tenant, 'cron_stalled', 'NetSuite sync stalled',
     'sync_runs.last_run_at older than 90 minutes. Cron picked back up after manual restart.',
     'admin', '{"tab":"netsuite"}'::jsonb,
     null, null, 'sync_state', '{}',
     true, primary_admin, now() - interval '11 days',
     'Manual restart cleared the stall.', now() - interval '12 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'notif:push_failed:tata-pune'),
     default_tenant, 'push_failed', 'Push to vendor returned HTTP 503',
     'Tata Pune ack endpoint flapped; row recovered after retry #2.',
     'admin', '{"tab":"diag"}'::jsonb,
     null, null, 'sales_order', '{}',
     true, primary_admin, now() - interval '4 days',
     'Auto-recovered.', now() - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'notif:totp_enrolled:fin.alpha'),
     default_tenant, 'totp_enrolled', 'New TOTP enrollment',
     'fin.alpha@anvil.test enrolled an authenticator app.',
     'admin', '{"tab":"security"}'::jsonb,
     uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test'),
     'fin.alpha@anvil.test', 'user_security_settings', '{}',
     true, primary_admin, now() - interval '29 days',
     'Acknowledged.', now() - interval '30 days')
  on conflict (id) do nothing;
end $notif$;

-- ───────────────────────────────────────────────────────────────────
-- 6. ACCESS_REVIEWS  --  monthly SOC 2 ledger
-- ───────────────────────────────────────────────────────────────────
do $access$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  members_jsonb  jsonb;
begin
  -- Snapshot of the seeded members (fresh enough for the review record).
  members_jsonb := (
    select jsonb_agg(jsonb_build_object('email', request_email, 'role', role, 'status', status))
    from tenant_members
    where tenant_id = default_tenant
  );

  insert into access_reviews (id, tenant_id, reviewed_by, reviewed_at, members,
                              acknowledgement_text, signed_hash, notes)
  values
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'access_review:2026-04'),
     default_tenant, primary_admin, now() - interval '35 days',
     coalesce(members_jsonb, '[]'::jsonb),
     'I acknowledge this access review and confirm the role assignments above.',
     encode(digest('access_review:2026-04', 'sha256'), 'hex'),
     'Quarterly review. Two new sales_engineers approved; deactivated.user offboarded.'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'access_review:2026-05'),
     default_tenant, primary_admin, now() - interval '2 days',
     coalesce(members_jsonb, '[]'::jsonb),
     null,  -- pending acknowledgement -> in-progress review
     null,
     'In-progress monthly review.')
  on conflict (id) do nothing;
end $access$;

-- ───────────────────────────────────────────────────────────────────
-- 7. USER_SECURITY_AUDIT  --  30 events across the timeline
-- ───────────────────────────────────────────────────────────────────
do $secaudit$
declare
  seed_now timestamptz := now();
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
  recovery_admin uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.recovery@anvil.test');
  alpha          uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.alpha@anvil.test');
  beta           uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.beta@anvil.test');
  charlie        uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:eng.charlie@anvil.test');
  mgr_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:mgr.alpha@anvil.test');
  fin_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:fin.alpha@anvil.test');
  ops_alpha      uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:ops.alpha@anvil.test');
  denied         uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:denied.user@anvil.test');
begin
  insert into user_security_audit (id, user_id, user_email, event, ip, user_agent, detail, created_at)
  values
    -- TOTP enrollments + challenges
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:1'),  primary_admin, 'admin.primary@anvil.test', 'mfa_enrolled',          '203.0.113.10', 'Mozilla/5.0',                               jsonb_build_object('factor','totp','seed_marker','anvil-test-seed-v1'), seed_now - interval '60 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:2'),  primary_admin, 'admin.primary@anvil.test', 'mfa_challenge_ok',      '203.0.113.10', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:3'),  primary_admin, 'admin.primary@anvil.test', 'password_login_ok',     '203.0.113.10', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:4'),  mgr_alpha,     'mgr.alpha@anvil.test',     'mfa_enrolled',          '203.0.113.20', 'Mozilla/5.0',                               jsonb_build_object('factor','totp','seed_marker','anvil-test-seed-v1'), seed_now - interval '45 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:5'),  mgr_alpha,     'mgr.alpha@anvil.test',     'mfa_challenge_ok',      '203.0.113.20', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '1 day'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:6'),  fin_alpha,     'fin.alpha@anvil.test',     'mfa_enrolled',          '203.0.113.30', 'Mozilla/5.0',                               jsonb_build_object('factor','totp','seed_marker','anvil-test-seed-v1'), seed_now - interval '30 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:7'),  fin_alpha,     'fin.alpha@anvil.test',     'mfa_challenge_fail',    '198.51.100.7', 'curl/8.6.0',                                jsonb_build_object('reason','code_invalid','seed_marker','anvil-test-seed-v1'), seed_now - interval '14 days'),
    -- Passkey lifecycle for eng.beta
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:8'),  beta,          'eng.beta@anvil.test',      'passkey_registered',    '203.0.113.40', 'Mozilla/5.0 Macintosh',                     jsonb_build_object('label','MacBook Pro (Touch ID)','seed_marker','anvil-test-seed-v1'), seed_now - interval '40 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:9'),  beta,          'eng.beta@anvil.test',      'passkey_login_ok',      '203.0.113.40', 'Mozilla/5.0 Macintosh',                     jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '2 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:10'), beta,          'eng.beta@anvil.test',      'passkey_login_fail',    '198.51.100.8', 'Mozilla/5.0 Macintosh',                     jsonb_build_object('reason','counter_mismatch','seed_marker','anvil-test-seed-v1'), seed_now - interval '7 days'),
    -- Password resets + magic links
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:11'), alpha,         'eng.alpha@anvil.test',     'password_reset_requested', '203.0.113.50', 'Mozilla/5.0',                            jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '21 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:12'), alpha,         'eng.alpha@anvil.test',     'password_reset_completed', '203.0.113.50', 'Mozilla/5.0',                            jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '21 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:13'), recovery_admin,'admin.recovery@anvil.test','magic_link_requested',  '203.0.113.60', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '90 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:14'), recovery_admin,'admin.recovery@anvil.test','password_login_ok',     '203.0.113.60', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '90 days'),
    -- Failed logins (the security panel surfaces these)
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:15'), alpha,         'eng.alpha@anvil.test',     'password_login_fail',   '198.51.100.9', 'curl/8.6.0',                                jsonb_build_object('reason','wrong_password','seed_marker','anvil-test-seed-v1'), seed_now - interval '6 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:16'), null,          'unknown@anvil.test',       'password_login_fail',   '198.51.100.10','python-requests/2.32',                      jsonb_build_object('reason','user_not_found','seed_marker','anvil-test-seed-v1'), seed_now - interval '6 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:17'), null,          'unknown@anvil.test',       'password_login_fail',   '198.51.100.10','python-requests/2.32',                      jsonb_build_object('reason','user_not_found','seed_marker','anvil-test-seed-v1'), seed_now - interval '6 days'),
    -- Daily activity for ops.alpha
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:18'), ops_alpha,     'ops.alpha@anvil.test',     'password_login_ok',     '203.0.113.70', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '1 day'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:19'), ops_alpha,     'ops.alpha@anvil.test',     'password_login_ok',     '203.0.113.70', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '8 hours'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:20'), ops_alpha,     'ops.alpha@anvil.test',     'session_revoked',       '203.0.113.70', 'Mozilla/5.0',                               jsonb_build_object('reason','idle_timeout','seed_marker','anvil-test-seed-v1'), seed_now - interval '7 hours'),
    -- Pending user signup attempt + denied user
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:21'), charlie,       'eng.charlie@anvil.test',   'password_login_fail',   '203.0.113.80', 'Mozilla/5.0',                               jsonb_build_object('reason','membership_pending','seed_marker','anvil-test-seed-v1'), seed_now - interval '12 hours'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:22'), denied,        'denied.user@anvil.test',   'password_login_fail',   '198.51.100.11','curl/8.6.0',                                jsonb_build_object('reason','membership_denied','seed_marker','anvil-test-seed-v1'), seed_now - interval '15 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:23'), denied,        'denied.user@anvil.test',   'password_login_fail',   '198.51.100.11','curl/8.6.0',                                jsonb_build_object('reason','membership_denied','seed_marker','anvil-test-seed-v1'), seed_now - interval '14 days'),
    -- Older history
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:24'), alpha,         'eng.alpha@anvil.test',     'password_login_ok',     '203.0.113.50', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '70 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:25'), alpha,         'eng.alpha@anvil.test',     'password_login_ok',     '203.0.113.50', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '50 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:26'), alpha,         'eng.alpha@anvil.test',     'password_login_ok',     '203.0.113.50', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '20 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:27'), beta,          'eng.beta@anvil.test',      'password_login_ok',     '203.0.113.40', 'Mozilla/5.0 Macintosh',                     jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '60 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:28'), mgr_alpha,     'mgr.alpha@anvil.test',     'password_login_ok',     '203.0.113.20', 'Mozilla/5.0',                               jsonb_build_object('seed_marker','anvil-test-seed-v1'), seed_now - interval '40 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:29'), fin_alpha,     'fin.alpha@anvil.test',     'mfa_unenrolled',        '203.0.113.30', 'Mozilla/5.0',                               jsonb_build_object('factor','totp','seed_marker','anvil-test-seed-v1'), seed_now - interval '32 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','sec:30'), fin_alpha,     'fin.alpha@anvil.test',     'mfa_enrolled',          '203.0.113.30', 'Mozilla/5.0',                               jsonb_build_object('factor','totp','seed_marker','anvil-test-seed-v1'), seed_now - interval '30 days')
  on conflict (id) do nothing;
end $secaudit$;

-- ───────────────────────────────────────────────────────────────────
-- 8. MCP_TOKENS  --  3 tokens (active / revoked / expired)
-- ───────────────────────────────────────────────────────────────────
do $mcp$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  primary_admin  uuid := uuid_generate_v5(uuid_ns_dns(), 'anvil-seed-user:admin.primary@anvil.test');
begin
  insert into mcp_tokens (id, tenant_id, user_id, name, token_hash, token_prefix,
                          scopes, expires_at, revoked_at, last_used_at, use_count, created_at)
  values
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','mcp:active'),
     default_tenant, primary_admin,
     'Claude desktop on primary admin',
     encode(digest('anvil-seed-mcp:active', 'sha256'), 'hex'),
     'mcp_act_',
     array['read.orders','read.invoices','read.customers','read.inventory','read.pipeline','read.misc'],
     now() + interval '60 days', null, now() - interval '6 hours', 142, now() - interval '20 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','mcp:revoked'),
     default_tenant, primary_admin,
     'GitHub Copilot Workspace',
     encode(digest('anvil-seed-mcp:revoked', 'sha256'), 'hex'),
     'mcp_rev_',
     array['read.orders','read.customers'],
     now() + interval '30 days', now() - interval '3 days', now() - interval '5 days', 9, now() - interval '40 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','mcp:expired'),
     default_tenant, primary_admin,
     'Old laptop (expired)',
     encode(digest('anvil-seed-mcp:expired', 'sha256'), 'hex'),
     'mcp_exp_',
     array['read.orders','read.invoices'],
     now() - interval '5 days', null, now() - interval '20 days', 64, now() - interval '120 days')
  on conflict (id) do nothing;
end $mcp$;

-- ───────────────────────────────────────────────────────────────────
-- 9. REDACTION_RULES  --  3 global + 3 tenant
-- ───────────────────────────────────────────────────────────────────
insert into redaction_rules (id, tenant_id, field_path, pattern, replacement, enabled, notes, created_at)
values
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','redact:global:email'),
   null, 'free_text', '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[redacted-email]',
   true, 'Global email obfuscation across extracted free-text fields.', now() - interval '90 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','redact:global:phone'),
   null, 'free_text', '\+?\d[\d\s\-]{8,}\d', '[redacted-phone]',
   true, 'Strip phone numbers from PO descriptions and supplier remarks.', now() - interval '90 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','redact:global:credcard'),
   null, 'free_text', '\b(?:\d[ -]*?){13,16}\b', '[redacted-card]',
   true, 'Defence-in-depth: never let card-shaped numbers reach OCR cache.', now() - interval '90 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','redact:tenant:gstin'),
   '00000000-0000-0000-0000-000000000001', 'supplier_remarks', '\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d', '[redacted-gstin]',
   true, 'Tenant rule: GSTIN of OEM customers must not be echoed in supplier docs.', now() - interval '60 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','redact:tenant:pan'),
   '00000000-0000-0000-0000-000000000001', 'supplier_remarks', '[A-Z]{5}\d{4}[A-Z]', '[redacted-pan]',
   true, 'Tenant rule: PAN must not leak through supplier acks.', now() - interval '60 days'),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','redact:tenant:disabled'),
   '00000000-0000-0000-0000-000000000001', 'free_text', 'INTERNAL ONLY', '[redacted-internal]',
   false, 'Disabled rule kept for audit history.', now() - interval '40 days')
on conflict (id) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 10. HOLIDAY_CALENDAR  --  add EU/DE rows for the Globex fixture
-- ───────────────────────────────────────────────────────────────────
-- 004_seed_static_data.sql already covers IN/CN/JP/KR/US for 2026.
-- Phase 2 (200_master_data.sql) introduces a Globex Manufacturing GmbH
-- (DE) customer; pre-seed DE holidays so its delivery-window logic
-- has the data it needs.
insert into holiday_calendar (tenant_id, country, date, name) values
  (null, 'DE', '2026-01-01', 'Neujahrstag'),
  (null, 'DE', '2026-04-03', 'Karfreitag'),
  (null, 'DE', '2026-04-06', 'Ostermontag'),
  (null, 'DE', '2026-05-01', 'Tag der Arbeit'),
  (null, 'DE', '2026-05-14', 'Christi Himmelfahrt'),
  (null, 'DE', '2026-05-25', 'Pfingstmontag'),
  (null, 'DE', '2026-10-03', 'Tag der Deutschen Einheit'),
  (null, 'DE', '2026-12-25', 'Erster Weihnachtstag'),
  (null, 'DE', '2026-12-26', 'Zweiter Weihnachtstag')
on conflict do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 11. FX_RATES  --  recent USD/EUR/JPY/KRW <-> INR pairs
-- ───────────────────────────────────────────────────────────────────
do $fx$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  d              date;
begin
  -- Last 8 days of synthetic but realistic mid-rates against INR.
  for d in select generate_series((now() - interval '7 days')::date, now()::date, interval '1 day')::date
  loop
    insert into fx_rates (id, tenant_id, from_ccy, to_ccy, rate, as_of, source, fetched_at)
    values
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'fx:USD-INR:' || d::text),
       default_tenant, 'USD', 'INR', 83.20 + (extract(day from d)::numeric / 100), d, 'frankfurter', d::timestamptz),
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'fx:EUR-INR:' || d::text),
       default_tenant, 'EUR', 'INR', 90.10 + (extract(day from d)::numeric / 100), d, 'frankfurter', d::timestamptz),
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'fx:JPY-INR:' || d::text),
       default_tenant, 'JPY', 'INR', 0.555 + (extract(day from d)::numeric / 1000), d, 'frankfurter', d::timestamptz),
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001', 'fx:KRW-INR:' || d::text),
       default_tenant, 'KRW', 'INR', 0.0625 + (extract(day from d)::numeric / 10000), d, 'frankfurter', d::timestamptz)
    on conflict (id) do nothing;
  end loop;
end $fx$;

-- ───────────────────────────────────────────────────────────────────
-- 12. SUPPLIER_LEAD_TIMES  --  extend the 5 from migration 004
-- ───────────────────────────────────────────────────────────────────
-- 004 already inserts the 5 country-default rows. Extend with
-- supplier-specific rows so the lead-time engine has at least one
-- per category.
do $slt$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into supplier_lead_times (id, tenant_id, supplier, country, product_category, lead_days, notes, created_at, updated_at)
  values
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','slt:obara-korea:welding'),
     default_tenant, 'Obara Korea', 'KR', 'welding_equipment', 14,
     'Sister-company express. Air freight default.', now() - interval '90 days', now() - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','slt:obara-japan:welding'),
     default_tenant, 'Obara Japan', 'JP', 'welding_equipment', 21,
     'Tokyo factory. Sea LCL default.', now() - interval '90 days', now() - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','slt:obara-china:assemblies'),
     default_tenant, 'Obara China', 'CN', 'assemblies', 28,
     'Shanghai factory. Add 7 days for QA hold.', now() - interval '90 days', now() - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','slt:bks:cables'),
     default_tenant, 'BKS Cables Pvt Ltd', 'IN', 'cables', 5,
     'Domestic; truck delivery to Halol/Pune.', now() - interval '90 days', now() - interval '5 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','slt:globex:tooling'),
     default_tenant, 'Globex Manufacturing GmbH', 'DE', 'tooling', 35,
     'EU import; sea + customs.', now() - interval '60 days', now() - interval '3 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','slt:acme:robotics'),
     default_tenant, 'Acme Robotics LLC', 'US', 'robotics', 30,
     'US import; air freight standard.', now() - interval '60 days', now() - interval '3 days')
  on conflict (id) do nothing;
end $slt$;

-- ───────────────────────────────────────────────────────────────────
-- 13. CUSTOMER_LEAD_TIMES  --  per-customer SLA overrides
-- ───────────────────────────────────────────────────────────────────
-- Reference customers seeded by the corpus seed. Each row is global
-- across categories or scoped to one product_category.
do $clt$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
  mg_id    uuid; tata_id  uuid; jbm_id   uuid; rn_id    uuid;
begin
  select id into mg_id   from customers where tenant_id = default_tenant and customer_key = 'MG_MOTOR_INDIA';
  select id into tata_id from customers where tenant_id = default_tenant and customer_key = 'TATA_MOTORS_PV_PUNE';
  select id into jbm_id  from customers where tenant_id = default_tenant and customer_key = 'JBM_AUTO_PLANT_1';
  select id into rn_id   from customers where tenant_id = default_tenant and customer_key = 'RNAIPL';

  if mg_id is not null then
    insert into customer_lead_times (id, tenant_id, customer_id, product_category, lead_days, notes, created_at, updated_at)
    values
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','clt:mg:default'),
       default_tenant, mg_id, null, 10, 'Halol contract SLA: 10 days from PO.',
       now() - interval '60 days', now() - interval '10 days'),
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','clt:mg:assemblies'),
       default_tenant, mg_id, 'assemblies', 21, 'Servo-gun assemblies allowed 21 days.',
       now() - interval '60 days', now() - interval '10 days')
    on conflict (id) do nothing;
  end if;
  if tata_id is not null then
    insert into customer_lead_times (id, tenant_id, customer_id, product_category, lead_days, notes, created_at, updated_at)
    values
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','clt:tata:default'),
       default_tenant, tata_id, null, 14, 'Pune dock-to-dock window.',
       now() - interval '60 days', now() - interval '10 days')
    on conflict (id) do nothing;
  end if;
  if jbm_id is not null then
    insert into customer_lead_times (id, tenant_id, customer_id, product_category, lead_days, notes, created_at, updated_at)
    values
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','clt:jbm:default'),
       default_tenant, jbm_id, null, 7, 'Tier-1 line-builder; tight cycle.',
       now() - interval '40 days', now() - interval '5 days')
    on conflict (id) do nothing;
  end if;
  if rn_id is not null then
    insert into customer_lead_times (id, tenant_id, customer_id, product_category, lead_days, notes, created_at, updated_at)
    values
      (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','clt:rn:default'),
       default_tenant, rn_id, null, 12, 'Renault-Nissan India.',
       now() - interval '40 days', now() - interval '5 days')
    on conflict (id) do nothing;
  end if;
end $clt$;

-- ───────────────────────────────────────────────────────────────────
-- 14. LOST_REASON_TAXONOMY  --  global controlled vocabulary
-- ───────────────────────────────────────────────────────────────────
insert into lost_reason_taxonomy (id, tenant_id, code, label, category, active) values
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:price_undercut'),    null, 'PRICE_UNDERCUT',    'Competitor priced below our floor',          'price',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:price_unrealistic'), null, 'PRICE_UNREALISTIC', 'Customer expectation below cost',            'price',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:lead_time'),         null, 'LEAD_TIME',         'Lead time exceeded customer requirement',    'lead_time',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:quality'),           null, 'QUALITY',           'Quality concerns from prior shipments',      'quality',       true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:relationship'),      null, 'RELATIONSHIP',      'Incumbent supplier relationship preserved',  'relationship',  true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:scope_change'),      null, 'SCOPE_CHANGE',      'Customer scope reduced or paused',           'scope',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:no_response'),       null, 'NO_RESPONSE',       'Customer non-responsive after follow-ups',   'other',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:not_qualified'),     null, 'NOT_QUALIFIED',     'Lead failed qualification gate',             'other',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:budget_cut'),        null, 'BUDGET_CUT',        'Project funding withdrawn',                  'scope',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:tech_mismatch'),     null, 'TECH_MISMATCH',     'Technical fit insufficient',                 'quality',       true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:internal_make'),     null, 'INTERNAL_MAKE',     'Customer chose to in-source',                'relationship',  true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','loss:legacy_unused'),     null, 'LEGACY_UNUSED',     'Deprecated reason kept for audit',           'other',         false)
on conflict (tenant_id, code) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 15. INCO_TERMS_TAXONOMY  --  Incoterms 2020 codes
-- ───────────────────────────────────────────────────────────────────
insert into inco_terms_taxonomy (id, tenant_id, code, label, description, active) values
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:EXW'),  null, 'EXW',  'Ex Works',                       'Buyer collects from seller premises.',                    true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:FCA'),  null, 'FCA',  'Free Carrier',                   'Seller delivers to carrier nominated by buyer.',          true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:CPT'),  null, 'CPT',  'Carriage Paid To',               'Seller pays carriage to named destination.',              true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:CIP'),  null, 'CIP',  'Carriage and Insurance Paid To', 'Seller pays carriage + insurance.',                       true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:DAP'),  null, 'DAP',  'Delivered at Place',             'Seller delivers to named place; buyer unloads.',          true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:DPU'),  null, 'DPU',  'Delivered at Place Unloaded',    'Seller delivers and unloads at named place.',             true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:DDP'),  null, 'DDP',  'Delivered Duty Paid',            'Seller pays everything including import duties.',         true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:FAS'),  null, 'FAS',  'Free Alongside Ship',            'Sea / inland waterway only.',                             true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:FOB'),  null, 'FOB',  'Free On Board',                  'Sea / inland waterway only; risk passes at ship rail.',   true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:CFR'),  null, 'CFR',  'Cost and Freight',               'Seller pays freight to destination port.',                true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:CIF'),  null, 'CIF',  'Cost, Insurance and Freight',    'Seller pays freight + insurance to destination port.',    true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','inco:FOR'),  null, 'FOR',  'Free On Rail (legacy)',          'Indian commercial usage; seller delivers to railhead.',   true)
on conflict (tenant_id, code) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 16. LOGISTICS_PORTS  --  global Indian sea + air ports
-- ───────────────────────────────────────────────────────────────────
insert into logistics_ports (id, tenant_id, port_code, port_name, country, port_type, active) values
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INNSA'), null, 'INNSA', 'Nhava Sheva (JNPT)',     'IN', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INMUN'), null, 'INMUN', 'Mundra',                  'IN', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INMAA'), null, 'INMAA', 'Chennai',                 'IN', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INPAV'), null, 'INPAV', 'Pipavav',                 'IN', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INCOK'), null, 'INCOK', 'Cochin',                  'IN', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INBOM'), null, 'INBOM', 'Mumbai (CST air)',        'IN', 'air',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INDEL'), null, 'INDEL', 'Delhi IGI air cargo',     'IN', 'air',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:INMAA-A'), null, 'INMAA-A', 'Chennai air cargo',  'IN', 'air',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:KRPUS'), null, 'KRPUS', 'Busan',                   'KR', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:JPYOK'), null, 'JPYOK', 'Yokohama',                'JP', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:CNSHA'), null, 'CNSHA', 'Shanghai',                'CN', 'sea',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','port:DEHAM'), null, 'DEHAM', 'Hamburg',                 'DE', 'sea',     true)
on conflict (tenant_id, port_code) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 17. LOGISTICS_CARRIERS
-- ───────────────────────────────────────────────────────────────────
insert into logistics_carriers (id, tenant_id, carrier_code, carrier_name, mode, active) values
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:HX'),    null, 'HX',    'Hapag-Lloyd',     'SEA',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:MAEU'),  null, 'MAEU',  'Maersk',          'SEA',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:CMDU'),  null, 'CMDU',  'CMA CGM',         'SEA',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:ONEY'),  null, 'ONEY',  'Ocean Network Express', 'SEA', true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:6E'),    null, '6E',    'IndiGo Cargo',    'AIR',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:AI'),    null, 'AI',    'Air India',       'AIR',     true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:DHL'),   null, 'DHL',   'DHL Express',     'COURIER', true),
  (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','carr:GATI'),  null, 'GATI',  'GATI surface',    'ROAD',    true)
on conflict (tenant_id, carrier_code) do nothing;

-- ───────────────────────────────────────────────────────────────────
-- 18. EMAIL_INTAKE_RULES  --  classification of inbound mail
-- ───────────────────────────────────────────────────────────────────
do $emrules$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into email_intake_rules (id, tenant_id, match_subject, match_from, match_to,
                                  default_classification, notes, created_at)
  values
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','emrule:po'),
     default_tenant, 'PO|Purchase Order', null, 'orders@', 'purchase_order',
     'Bucket inbound POs by subject hint.', now() - interval '60 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','emrule:rfq'),
     default_tenant, 'RFQ|Request for Quote', null, null, 'rfq',
     'Inbound RFQs land in the opportunity inbox.', now() - interval '60 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','emrule:ack'),
     default_tenant, 'Acknowledg|ACK', '%@obara%', 'pos@', 'supplier_ack',
     'Supplier acks come from internal Obara mailboxes.', now() - interval '60 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','emrule:invoice'),
     default_tenant, 'Invoice', null, 'finance@', 'invoice',
     'Finance mailbox.', now() - interval '60 days'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','emrule:complaint'),
     default_tenant, 'Complaint|Defect|CAR', null, 'service@', 'service_request',
     'Service team triages CAR-shaped emails.', now() - interval '60 days')
  on conflict (id) do nothing;
end $emrules$;

-- ───────────────────────────────────────────────────────────────────
-- 19. AUTH_MAGIC_LINKS  --  audit timeline
-- ───────────────────────────────────────────────────────────────────
do $magic$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000001';
begin
  insert into auth_magic_links (id, tenant_id, email, requested_at, ip, user_agent, outcome) values
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:1'),  default_tenant, 'admin.recovery@anvil.test',  now() - interval '90 days', '203.0.113.60', 'Mozilla/5.0',          'verified'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:2'),  default_tenant, 'eng.alpha@anvil.test',       now() - interval '21 days', '203.0.113.50', 'Mozilla/5.0',          'verified'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:3'),  default_tenant, 'mgr.beta@anvil.test',        now() - interval '14 days', '203.0.113.21', 'Mozilla/5.0',          'sent'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:4'),  default_tenant, 'fin.beta@anvil.test',        now() - interval '7 days',  '203.0.113.31', 'Mozilla/5.0',          'verified'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:5'),  null,           'unknown1@anvil.test',        now() - interval '5 days',  '198.51.100.20','python-requests/2.32', 'failed'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:6'),  null,           'unknown2@anvil.test',        now() - interval '5 days',  '198.51.100.20','python-requests/2.32', 'failed'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:7'),  default_tenant, 'prc.alpha@anvil.test',       now() - interval '2 days',  '203.0.113.41', 'Mozilla/5.0',          'sent'),
    (uuid_generate_v5('d7a7e5e4-0001-0001-0001-000000000001','ml:8'),  default_tenant, 'eng.beta@anvil.test',        now() - interval '12 hours','203.0.113.40', 'Mozilla/5.0',          'verified')
  on conflict (id) do nothing;
end $magic$;

-- ───────────────────────────────────────────────────────────────────
-- 20. RATE-LIMIT LEDGERS
-- ───────────────────────────────────────────────────────────────────
-- password_reset_attempts has email PK; no conflict-do-nothing risk.
insert into password_reset_attempts (email, count, window_started_at, last_request_at) values
  ('eng.alpha@anvil.test',       1, now() - interval '21 days', now() - interval '21 days'),
  ('unknown@anvil.test',         5, now() - interval '6 days',  now() - interval '5 days'),
  ('mgr.beta@anvil.test',        2, now() - interval '14 days', now() - interval '13 days'),
  ('admin.recovery@anvil.test',  1, now() - interval '90 days', now() - interval '90 days')
on conflict (email) do nothing;

-- mfa_attempts and magic_link_attempts: log-shaped, guarded by absence
-- of a seed-marker row already inserted on previous runs.
do $rl$
begin
  if not exists (select 1 from mfa_attempts where identifier = 'anvil-seed:mgr.alpha@anvil.test') then
    insert into mfa_attempts (identifier, attempted_at) values
      ('anvil-seed:mgr.alpha@anvil.test', now() - interval '1 day'),
      ('anvil-seed:fin.alpha@anvil.test', now() - interval '14 days'),
      ('anvil-seed:fin.alpha@anvil.test', now() - interval '14 days'),
      ('anvil-seed:fin.alpha@anvil.test', now() - interval '14 days'),
      ('anvil-seed:admin.primary@anvil.test', now() - interval '5 days');
  end if;

  if not exists (select 1 from magic_link_attempts where identifier = 'anvil-seed:eng.alpha@anvil.test') then
    insert into magic_link_attempts (identifier, attempted_at) values
      ('anvil-seed:eng.alpha@anvil.test',     now() - interval '21 days'),
      ('anvil-seed:mgr.beta@anvil.test',      now() - interval '14 days'),
      ('anvil-seed:fin.beta@anvil.test',      now() - interval '7 days'),
      ('anvil-seed:198.51.100.20',            now() - interval '5 days'),
      ('anvil-seed:198.51.100.20',            now() - interval '5 days');
  end if;
end $rl$;

commit;
