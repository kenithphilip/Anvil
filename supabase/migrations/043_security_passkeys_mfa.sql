-- 043_security_passkeys_mfa.sql
--
-- Strong-auth surface: passkeys (WebAuthn) + a small audit log for
-- security-relevant events. TOTP MFA leverages Supabase's native
-- auth.mfa_factors table (managed by Supabase itself); we add a
-- denormalised flag here so the client doesn't have to hit the
-- mfa-list endpoint on every render.
--
-- Password reset uses Supabase's recovery-link flow (no extra
-- table needed); we just persist the request in user_security_audit
-- so an admin can spot a brute-force or stuffing attempt.
--
-- Idempotent.

-- ── 1. Per-user MFA flag mirror ─────────────────────────────────
--
-- Supabase already tracks MFA factors at auth.mfa_factors and
-- auth.mfa_challenges, but reading those from RLS-gated client
-- code is awkward. We mirror "is MFA enabled" + "is passkey
-- enrolled" onto the public user_security_settings table so the
-- client can render the security panel without elevated reads.
create table if not exists user_security_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  totp_enrolled boolean not null default false,
  -- Encrypted TOTP secret (base32 plaintext, AES-256-GCM via secrets.js).
  -- Plaintext fallback only when SECRETS_KEY isn't configured (dev).
  totp_secret_enc text,
  totp_secret text,
  totp_secret_iv text,
  -- During enrollment we generate a secret + QR code and ask the
  -- user to type a TOTP to confirm scanning worked. Pending
  -- secrets live here until the verify call promotes them.
  totp_pending_secret_enc text,
  totp_pending_secret text,
  totp_pending_secret_iv text,
  totp_pending_expires_at timestamptz,
  passkey_enrolled boolean not null default false,
  -- Used by /api/auth/password_login to know whether to issue a
  -- mfa-challenge response. Kept in sync by the enroll/unenroll
  -- endpoints.
  require_mfa boolean not null default false,
  last_security_change_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table user_security_settings enable row level security;
drop policy if exists "user_security_settings_owner" on user_security_settings;
create policy "user_security_settings_owner" on user_security_settings
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function user_security_settings_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists user_security_settings_updated_at on user_security_settings;
create trigger user_security_settings_updated_at before update on user_security_settings
  for each row execute function user_security_settings_touch_updated_at();

-- ── 2. Passkeys (WebAuthn credentials) ──────────────────────────
--
-- Stores one row per registered passkey. The server-side
-- `@simplewebauthn/server` library validates attestation +
-- assertion using credential_public_key + counter. The counter
-- gets incremented on every successful sign-in to detect cloned
-- credentials.
create table if not exists user_passkeys (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- The credential ID from the authenticator. Base64URL-encoded.
  credential_id text not null unique,
  -- Public key in COSE format, base64-encoded.
  public_key text not null,
  -- Signature counter; bumps on every assertion.
  counter bigint not null default 0,
  -- Transports the authenticator advertised: usb / nfc / ble /
  -- internal / hybrid. Stored as a text array.
  transports text[] not null default '{}',
  -- The user-visible label. Defaults to the device name the
  -- browser supplies; users can rename.
  label text,
  -- Backup-eligibility flags surfaced by the authenticator. Useful
  -- for the security UI (warn the user if their only passkey is
  -- non-backup-eligible).
  backup_eligible boolean,
  backup_state boolean,
  device_type text,                          -- "single_device" | "multi_device"
  -- For replay-protection during registration: the SHA-256 of the
  -- challenge we issued. Cleared after verification succeeds.
  pending_challenge_hash text,
  pending_challenge_expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_passkeys_user_idx on user_passkeys (user_id, created_at desc);

alter table user_passkeys enable row level security;
drop policy if exists "user_passkeys_owner_select" on user_passkeys;
create policy "user_passkeys_owner_select" on user_passkeys
  for select using (user_id = auth.uid());
drop policy if exists "user_passkeys_owner_modify" on user_passkeys;
create policy "user_passkeys_owner_modify" on user_passkeys
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── 3. Security audit log ───────────────────────────────────────
--
-- Every security-relevant action gets a row here. Used to surface
-- "you signed in from a new device" notifications and (later) to
-- feed anomaly detection. Service role only writes; users can
-- read their own rows.
create table if not exists user_security_audit (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  event text not null check (event in (
    'password_login_ok',
    'password_login_fail',
    'magic_link_requested',
    'password_reset_requested',
    'password_reset_completed',
    'mfa_enrolled',
    'mfa_unenrolled',
    'mfa_challenge_ok',
    'mfa_challenge_fail',
    'passkey_registered',
    'passkey_removed',
    'passkey_login_ok',
    'passkey_login_fail',
    'session_revoked'
  )),
  ip text,
  user_agent text,
  detail jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists user_security_audit_user_idx on user_security_audit (user_id, created_at desc);
create index if not exists user_security_audit_event_idx on user_security_audit (event, created_at desc);

alter table user_security_audit enable row level security;
drop policy if exists "user_security_audit_self_read" on user_security_audit;
create policy "user_security_audit_self_read" on user_security_audit
  for select using (user_id = auth.uid());

-- ── 4. Password reset rate-limit counter ────────────────────────
--
-- Supabase's recovery-link API doesn't rate-limit per-email at the
-- application layer; an attacker hitting /api/auth/request_reset
-- with a list of emails would burn user mailboxes. We track per-
-- email request counts in a small table so the endpoint can
-- short-circuit after N requests in a 1-hour window.
create table if not exists password_reset_attempts (
  email text primary key,
  count int not null default 0,
  window_started_at timestamptz not null default now(),
  last_request_at timestamptz not null default now()
);
-- Service-role only; clients never query this table.
alter table password_reset_attempts enable row level security;
