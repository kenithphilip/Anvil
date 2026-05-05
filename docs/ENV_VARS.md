# Environment Variables

Every variable Anvil consumes, in one table. Set them on Vercel under
**Project Settings → Environment Variables**. For local dev copy
`.env.example` to `.env.local` and fill in the values you want to test
against.

## Required

| Variable | Where it's used | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | every api file via `_lib/supabase.js` | from Supabase **Project Settings → API** |
| `SUPABASE_ANON_KEY` | `_lib/supabase.js` user-token client | safe to expose to the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | `_lib/supabase.js` service client | bypasses RLS; mark as secret |
| `ANTHROPIC_API_KEY` | `api/claude/messages.js` | from https://console.anthropic.com |

## Identity, approval, and security

These control the sign-up / sign-in / approval gate and the security
flows landed in Phase 5. Set them deliberately for production: the
defaults below are correct for a fresh deployment but you'll often
want to tighten them.

| Variable | Where it's used | Default | Notes |
| --- | --- | --- | --- |
| `DEFAULT_TENANT_ID` | `_lib/tenancy.js`, `_lib/auth.js`, `inbound/email/parse.js` | `00000000-0000-0000-0000-000000000001` | matches the seed in 007. Replace if you operate a multi-tenant SaaS where the default row should be your "platform" tenant. |
| `AUTO_ONBOARD_TENANT` | `_lib/tenancy.js` | `true` | when `true`, a brand-new authenticated user without a `tenant_members` row gets one created on the default tenant during `resolveContext`. Set `false` when you provision memberships exclusively via `/api/admin/members`. |
| `REQUIRE_APPROVAL` | `_lib/tenancy.js`, `auth/signup.js`, `auth/password_login.js` | `true` | the access-approval gate. New signups land `status='pending'` and an admin must approve them before they can sign in. **Always leave this on in production.** Setting `false` reverts to the legacy auto-approve flow for dev environments. The first user on a fresh tenant always lands approved as admin regardless of this flag, so you can never lock yourself out. |
| `SIGNUP_ALLOWED` | `auth/signup.js` | `true` | when `false`, public signup is rejected outright. Use when only an admin can invite users (via `/api/admin/members`). |
| `NEW_USER_ROLE` | `_lib/tenancy.js` | `sales_engineer` | role assigned to a new user's pending membership. Admin can change it on approve. Must be one of: `viewer`, `sales_engineer`, `sales_manager`, `procurement`, `finance`. |
| `FIRST_USER_ROLE` | `_lib/tenancy.js` | `admin` | role assigned to the very first user on a fresh tenant (auto-approved, since nobody else can approve them). Must be one of the role list above plus `admin`. |
| `ALLOW_ANONYMOUS_TENANT` | `_lib/auth.js` | `false` | when `true`, calls without an Authorization header are accepted under `DEFAULT_TENANT_ID`. Useful for local dev; turn off for prod. |
| `ALLOWED_ORIGINS` | `_lib/cors.js` | `*` | comma-separated origin allowlist for CORS. Pin to your production hostnames. |
| `APP_URL` | `auth/passkey/*`, `auth/request_reset.js`, `auth/complete_reset.js` | `http://localhost:5173` | Public origin of the deployed frontend. **WebAuthn binds passkeys to this exact origin** so a passkey registered on `app.example.com` will not work on `staging.example.com`. Used as the redirect target for password-reset emails. |
| `PUBLIC_APP_URL` | `auth/request_reset.js` (alternate name) | unset | older alias accepted by the password-reset flow. Set either this or `APP_URL`. |
| `MAGIC_LINK_REDIRECT_URL` | `auth/magic_link.js`, the unified app | none | set to `<APP_URL>/auth/callback.html` |
| `RESET_RATE_LIMIT` | `auth/request_reset.js` | `5` | max password-reset requests per email per hour. Sliding window in the `password_reset_attempts` table. Throttle hits return a generic 200 (no enumeration) but get audited. |
| `CRON_SECRET` | `fx/cron.js`, `service/amc_cron.js`, `cron/tick.js`, `cron/daily.js`, every ERP `retry.js` and `sync.js` | none | when set, cron endpoints require `Authorization: Bearer <secret>`. **Always set in production.** |
| `ANVIL_SECRETS_KEY` | `_lib/secrets.js` (encrypts ERP creds, TOTP secrets, chat-channel creds, voice creds, PLM creds) | unset | 32 raw bytes (64 hex chars) of secret key material. **Always set in production.** Without it the secret-encryption helpers fall back to plaintext storage with a `[secrets] running unencrypted` warning, which is fine for dev only. Generate with `openssl rand -hex 32`. |

## Anthropic configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_MODEL_DEFAULT` | `claude-sonnet-4-20250514` | generation tier |
| `ANTHROPIC_MODEL_PREFLIGHT` | `claude-haiku-4-5-20251001` | cheap preflight tier |
| `ANTHROPIC_BETA_HEADER` | unset | passed as `anthropic-beta` header when set |

## Email delivery (password reset, comms send, dunning)

`/api/auth/request_reset`, `/api/communications/send`, the AR-loop
agent, and the access-request notifications all route outbound email
through SendGrid when configured. Without it, the password-reset
endpoint exposes the action_link in its dev response so local
testing still works.

| Variable | Activates | Notes |
| --- | --- | --- |
| `SENDGRID_API_KEY` | live email send for password reset, comms drafts, dunning | from your SendGrid account. **Required in production** for the password-reset flow to actually email anyone. |
| `SENDGRID_FROM_EMAIL` | `from` address on every Anvil-sent email | needs to be a verified sender or a domain with SPF/DKIM. |
| `SENDGRID_FROM_NAME` | `from` display name | defaults to `Anvil`. |
| `COMMS_PROVIDER_URL` | generic webhook fallback for comms send when SendGrid isn't set | unauthenticated unless `COMMS_PROVIDER_TOKEN` is also set |
| `COMMS_PROVIDER_TOKEN` | bearer auth for the generic comms webhook | none |
| `EMAIL_INBOUND_TOKEN` | inbound email webhook (Postmark / Graph) | endpoint refuses all calls when unset |

## Optional integrations

These activate features when set. The endpoints check for presence and
gracefully degrade when unset.

| Variable | Activates | Falls back to |
| --- | --- | --- |
| `MISTRAL_API_KEY` | server-side OCR with bbox provenance | text-only OCR via the legacy frontend Tesseract pipeline |
| `MISTRAL_OCR_MODEL` (default `mistral-ocr-latest`) | OCR model selection | the default |
| `FX_PROVIDER_URL` (default `https://frankfurter.dev`) | FX rate source | Frankfurter (free, no key) |
| `CLAMAV_URL` | live malware scanning of uploads | deterministic-only guards (size, count, nesting, exe, macro hint, ZIP bomb) |
| `CLAMAV_TOKEN` | bearer auth for ClamAV proxy | unauthenticated ClamAV |
| `TALLY_BRIDGE_URL` | actual SO export to Tally | failed voucher rows |
| `TALLY_BRIDGE_TOKEN` | bearer auth for Tally bridge | unauthenticated bridge |
| `GSTN_API_URL` | real e-Invoice IRN generation | drafts park in `PENDING_GSTN` |
| `GSTN_API_KEY` | client_id passed to GSTN | none |

## Document AI v2 (per-adapter)

The Document AI dispatcher (`_lib/docai/index.js`) tries each adapter
in order; the first one configured wins. GAEB XML routes
deterministically before any LLM and needs no env.

| Variable | Activates |
| --- | --- |
| `REDUCTO_API_KEY` | layout-aware extraction via Reducto |
| `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY` | Azure Document Intelligence |
| `UNSTRUCTURED_API_KEY`, `UNSTRUCTURED_API_URL` | Unstructured.io |

## How to generate secrets

```sh
openssl rand -hex 32          # for ANVIL_SECRETS_KEY (32 raw bytes -> 64 hex)
openssl rand -base64 32       # for CRON_SECRET, EMAIL_INBOUND_TOKEN
uuidgen | tr '[:upper:]' '[:lower:]'  # for DEFAULT_TENANT_ID if creating a new tenant
```

## Local dev `.env.local` example

Minimum to run `vercel dev` locally and exercise everything except the
optional integrations:

```sh
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
ANTHROPIC_API_KEY=sk-ant-...

DEFAULT_TENANT_ID=00000000-0000-0000-0000-000000000001
ALLOW_ANONYMOUS_TENANT=true
ALLOWED_ORIGINS=*

# Approval gate. Leave true even in dev so the flow matches production.
REQUIRE_APPROVAL=true

# Public origin: WebAuthn passkeys + the password-reset redirect both
# read this. The default below is fine for `vite dev`.
APP_URL=http://localhost:5173
MAGIC_LINK_REDIRECT_URL=http://localhost:5173/auth/callback.html

# Optional in dev. Without it the password-reset endpoint will return
# the action_link in its dev response so you can copy-paste; with it
# the email is actually sent.
# SENDGRID_API_KEY=SG.xxx
# SENDGRID_FROM_EMAIL=auth@example.com

# Optional in dev. With ANVIL_SECRETS_KEY set, encrypted columns
# (TOTP secrets, ERP creds, chat creds, voice creds, PLM creds) round-
# trip via AES-256-GCM. Without it they store plaintext for dev only.
# ANVIL_SECRETS_KEY=$(openssl rand -hex 32)
```

## Production checklist

For a real deployment, set **all** of:

```
SUPABASE_URL                   # required
SUPABASE_ANON_KEY              # required
SUPABASE_SERVICE_ROLE_KEY      # required
ANTHROPIC_API_KEY              # required
ANVIL_SECRETS_KEY              # encrypts every credential at rest
APP_URL                        # WebAuthn rpID + reset redirects
MAGIC_LINK_REDIRECT_URL        # = $APP_URL/auth/callback.html
REQUIRE_APPROVAL=true          # access gate
ALLOW_ANONYMOUS_TENANT=false   # close the open-tenant fallback
ALLOWED_ORIGINS=https://app.example.com
CRON_SECRET                    # required for /api/cron/*
SENDGRID_API_KEY               # outbound email (password reset, comms)
SENDGRID_FROM_EMAIL            # verified sender
RESET_RATE_LIMIT=5             # per-email password-reset cap
```

Optional but typically wanted: `MISTRAL_API_KEY`,
`EMAIL_INBOUND_TOKEN`, `GSTN_API_URL`, `GSTN_API_KEY`, the
Document AI keys.

## Where each var is read

If you grep the codebase for `process.env.NAME` you will find the exact
files. The inventory above was built by doing exactly that.

```sh
grep -rn 'process.env\.' api/ src/ | sort -u
```
