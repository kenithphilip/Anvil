# Security

This document is the canonical reference for how Anvil authenticates
users, gates access, stores secrets, audits actions, and protects
itself against the threats listed below. It supersedes the older,
shorter "Security Notes" page.

If you are an operator standing up a deployment, jump to
[Production checklist](#production-checklist) first, then come back
for the detail.

---

## Threat model

Anvil is a multi-tenant industrial sales-ops platform. The threats it
defends against:

1. **Cross-tenant leakage.** Mitigated by Postgres row-level security
   on every domain table plus an explicit `tenant_id` filter on every
   service-role query. Tenant resolution happens once per request in
   `_lib/auth.resolveContext`; no handler can quietly drop the gate.
2. **Account takeover.** Defended in depth: per-user TOTP MFA, optional
   passkeys (WebAuthn), single-use rate-limited password resets, an
   approval gate that refuses sessions for non-approved memberships,
   and a per-event security audit log.
3. **Account enumeration via reset / signin probing.** Reset endpoint
   always returns a generic 200; sign-in distinguishes only between
   "wrong credentials" and "membership not approved" (the latter only
   after a successful password validation).
4. **Approval bypass / replay** of the SO payload. The approval-bound
   payload hash (`stableStringify` + SHA-256) is re-checked on every
   state transition.
5. **ERP push double-write.** Each push is idempotent on
   `(tenant_id, voucher_no, payload_hash)`; recoverable failures land
   in a per-ERP retry queue with exponential backoff.
6. **Prompt injection** via customer documents. Mitigated by the
   prompt firewall in `api/claude/messages.js`, the redaction
   patterns, and the injection test runner under Security Center.
7. **Malware in uploads.** Deterministic ZIP guards (size, count,
   nesting, executable, macro hint) plus optional ClamAV.
8. **PII / secrets in logs.** `REDACTION_PATTERNS` for credit cards,
   Aadhaar, PAN, plus admin-managed redaction rules.
9. **Stolen recovery / MFA tokens.** Recovery tokens are single-use
   and Supabase-signed, with a server-side rate limit. TOTP unenroll
   requires a fresh code so a stolen session can't disable MFA.
   Passkeys verify a server-issued challenge tied to the request.

## Reporting issues

If you find a vulnerability, do not open a public issue. Email the
security contact (set this up before going live) and include
reproduction steps.

---

## Authentication and access flow

Anvil supports four sign-in methods plus password reset. All four
land on the same approval gate before a session is issued.

### Sign-up (request access)

`POST /api/auth/signup`

1. The user submits email, password (min 10 chars), display name,
   requested role, and optional notes from the landing page.
2. The endpoint creates the Supabase auth user, then creates a
   `tenant_members` row with `status='pending'`, the requested role,
   and the request notes. The first user on an empty tenant lands
   `status='approved'` as `admin` so the loop can ever start.
3. **No session is returned for pending users.** The response is
   `202 Accepted` with `{ status: "pending" }`.
4. Every approved admin on the target tenant gets an
   `admin_notifications` row of kind `access_request` deep-linking to
   `#/admin?tab=access`. The notification bell polls every 30s.

### Sign-in via password

`POST /api/auth/password_login`

1. Body: `{ email, password, totp_code? }`.
2. Supabase validates the credentials.
3. If the user has TOTP enrolled (`user_security_settings.totp_enrolled`)
   and the body has no `totp_code`, the response is
   `{ mfa_required: true }` with no session. The freshly-minted
   Supabase session is signed out so its access token can't be
   replayed. The frontend prompts for the code and re-submits.
4. With a valid `totp_code`, the server runs `verifyTotp` (RFC 6238,
   ±30s skew, constant-time compare). Wrong code returns 401
   `INVALID_TOTP` and again signs out the recovery session.
5. Membership status check. Pending / denied / deactivated members
   get a 403 with a structured `code` (`MEMBERSHIP_PENDING`,
   `MEMBERSHIP_DENIED`, `MEMBERSHIP_DEACTIVATED`) and a friendly
   message. The session is signed out.
6. Approved members get the Supabase session in the response.

### Sign-in via magic link

`POST /api/auth/magic_link`

Same approval gate as password sign-in: the magic-link callback
runs `auth/verify` which calls `_lib/tenancy.ensureMembership`, then
`_lib/auth.resolveContext` enforces approval status on every request.

### Sign-in via passkey

`POST /api/auth/passkey/auth/begin` then `POST /api/auth/passkey/auth/finish`

1. `begin` accepts the user's email (anonymous endpoint), looks up
   their registered credentials, generates an authentication
   challenge via `@simplewebauthn/server.generateAuthenticationOptions`,
   stores a SHA-256 of the challenge against a 5-minute placeholder
   row in `user_passkeys`. The response is the
   `PublicKeyCredentialRequestOptions` the browser feeds to
   `navigator.credentials.get`.
2. The browser produces an assertion (TouchID / FaceID /
   Windows Hello / hardware key).
3. `finish` verifies the assertion via
   `verifyAuthenticationResponse`, bumps the credential counter,
   runs the same membership-status approval gate as
   `password_login`, then mints a Supabase session by generating
   and verifying a magic-link token via the service role.
4. WebAuthn binds the passkey to the deployment's `APP_URL` origin.
   A passkey registered on `app.example.com` will not work on
   `staging.example.com`.

### Password reset

`POST /api/auth/request_reset` then `POST /api/auth/complete_reset`

1. `request_reset` looks up the user via the Supabase admin API,
   generates a single-use recovery link via
   `auth.admin.generateLink({ type: 'recovery' })`, emails it via
   SendGrid (best-effort; without SendGrid the dev response carries
   the link directly so local testing still works).
2. **Always returns `200`.** Account existence, email shape, and
   throttle hits all collapse into the same generic response so an
   attacker cannot enumerate accounts.
3. Per-email rate limit of `RESET_RATE_LIMIT` (default 5) requests
   per hour, sliding window in `password_reset_attempts`. Throttle
   hits are audited.
4. The recovery link redirects to `<APP_URL>/#/reset` where the
   pre-auth `reset-password` screen mounts (the auth gate's
   `PRE_AUTH_ROUTES` allowlist exempts this route).
5. `complete_reset` validates the recovery token, updates the
   password via `auth.admin.updateUserById`, signs out the recovery
   session so a stolen link can't outlive the reset, drops the
   rate-limit row so a typo doesn't lock the user out for an hour.
6. Audited at every step: throttled, sent, succeeded, failed.

### Approval gate (the rule on every request)

`_lib/auth.resolveContext` runs on every authenticated route.
Memberships are filtered to `status='approved'`. Anything else
raises a 403 with `code='MEMBERSHIP_<STATUS>'`. Even if a token
slips past the sign-in gate, every fetch will refuse it.

The frontend's `App.tsx` adds a hard render gate: if
`isSessionValid()` returns false, only the Landing page (or
`reset-password`) mounts. The Shell, sidebar, route resolvers,
telemetry hooks, and command-palette overlay are not rendered at
all.

---

## Two-factor authentication (TOTP)

Self-hosted, RFC 6238, no third-party MFA dependency.

`/api/auth/mfa` exposes three actions:

- `enroll` generates a 20-byte secret, base32-encoded, returns the
  `otpauth://` URI for QR rendering plus the secret as a manual
  fallback. The pending secret is stored encrypted (when
  `ANVIL_SECRETS_KEY` is set) on `user_security_settings.totp_pending_secret_enc`
  with a 10-minute TTL.
- `verify` accepts a 6-digit code, validates it with ±30s skew via
  `verifyTotp` (constant-time compare), promotes the pending secret
  to active (`totp_secret_enc`), and flips `totp_enrolled` +
  `require_mfa` to true.
- `unenroll` accepts a 6-digit code, validates it against the
  active secret, and clears the secret. **A stolen session cannot
  disable MFA without producing the current TOTP.**

Encryption: when `ANVIL_SECRETS_KEY` is set (32 raw bytes / 64 hex
chars), every secret column is wrapped with AES-256-GCM via
`_lib/secrets.js`. Without the key, secrets are stored plaintext
and the helpers log a `[secrets] running unencrypted` warning. Set
the key in production.

---

## Passkeys (WebAuthn)

`@simplewebauthn/server@^11` (server) + `@simplewebauthn/browser@^11`
(client, lazy-imported only when the user opens passkey management
or clicks Sign in with passkey).

Endpoints:

- `/api/auth/passkey/register/begin` and `/finish`: enrol a new
  credential. The flow stashes a placeholder row in `user_passkeys`
  carrying the SHA-256 challenge hash + 5-minute expiry; on
  `finish` we verify attestation, replace the placeholder with the
  real credential row, and mirror `passkey_enrolled` +
  `require_mfa` onto `user_security_settings`.
- `/api/auth/passkey/auth/begin` and `/finish`: anonymous sign-in
  flow (the user types their email, server returns a challenge,
  browser produces assertion, server verifies and mints a session).
- `/api/auth/passkey/list`: GET / DELETE for the management UI.

Counter-based replay detection: every successful assertion bumps
the credential counter on `user_passkeys.counter`. A clone
attempt would replay an old counter and `verifyAuthenticationResponse`
would refuse.

WebAuthn rpID is computed from `APP_URL`. **Set this correctly in
production.** A mismatch makes every existing passkey unusable.

---

## Secrets management

- Never commit `.env.local`. `.gitignore` blocks it.
- Rotate keys at least quarterly: Supabase service role, Anthropic,
  Mistral, `CRON_SECRET`, `EMAIL_INBOUND_TOKEN`, SendGrid,
  `ANVIL_SECRETS_KEY` (rotate carefully; old encrypted blobs
  decrypt only with the prior key).
- ERP credentials, chat-channel credentials, voice provider keys,
  PLM credentials, and TOTP secrets are all stored encrypted via
  `_lib/secrets.js` (AES-256-GCM) when `ANVIL_SECRETS_KEY` is set.
  Without it, plaintext fallback is allowed for dev.
- Service-role and anon keys live in Vercel project env vars and
  never in the browser bundle. `SUPABASE_ANON_KEY` is bundle-safe
  but only used server-side via the auth proxy.

---

## Audit trails

Three layers:

1. **`audit_events`** (existing): every write through
   `_lib/audit.recordAudit` lands here. Approvals, amendments,
   ERP pushes, admin CRUD, access-request approvals, MFA enroll /
   unenroll, passkey register / remove. Read-only via
   `/api/audit` and the Audit screen.
2. **`user_security_audit`** (added in 043): every security-
   relevant event keyed to the user. Events:
   `password_login_ok`, `password_login_fail`,
   `magic_link_requested`, `password_reset_requested`,
   `password_reset_completed`, `mfa_enrolled`, `mfa_unenrolled`,
   `mfa_challenge_ok`, `mfa_challenge_fail`,
   `passkey_registered`, `passkey_removed`, `passkey_login_ok`,
   `passkey_login_fail`, `session_revoked`. Per-user readable.
3. **`admin_notifications`** (added in 042): in-portal feed for
   admins. Includes access requests, ERP push gave-up,
   permanent-failure events. Polls every 30s while the tab is
   visible.

---

## Production checklist

Before going live:

- [ ] `ANVIL_SECRETS_KEY` set to 32 raw bytes (`openssl rand -hex 32`).
- [ ] `APP_URL` set to the public origin (no trailing slash). All
      passkey registrations and password-reset emails depend on
      this.
- [ ] `MAGIC_LINK_REDIRECT_URL` = `<APP_URL>/auth/callback.html`.
- [ ] `REQUIRE_APPROVAL=true` (default).
- [ ] `ALLOW_ANONYMOUS_TENANT=false`.
- [ ] `ALLOWED_ORIGINS=https://app.example.com` (your real origin,
      comma-separated if multiple).
- [ ] `CRON_SECRET` set.
- [ ] `SENDGRID_API_KEY` + `SENDGRID_FROM_EMAIL` set, sender domain
      authenticated (SPF + DKIM passing).
- [ ] `RESET_RATE_LIMIT=5` (default) or tighter.
- [ ] First user signs up → automatically becomes admin → uses
      Admin > Security to enrol TOTP + register a passkey BEFORE
      anyone else signs up.
- [ ] All migrations through `043_security_passkeys_mfa.sql`
      applied.
- [ ] `RBAC_AUDIT.md` and `WRITE_PATH_AUDIT.md` show 0 findings
      (`npm run audit`).
- [ ] Vercel function logs configured and retained ≥30 days.

## Database migrations relevant to security

- `001_init.sql`: tenants, tenant_members, role enum.
- `042_access_approvals.sql`: tenant_member_status enum, approval
  audit columns, `tenant_members_enriched` view,
  `admin_notifications`.
- `043_security_passkeys_mfa.sql`: `user_security_settings`,
  `user_passkeys`, `user_security_audit`,
  `password_reset_attempts`.

Always apply migrations in order. The supabase CLI handles this;
manual operators should `psql -f` each file in numerical order.
