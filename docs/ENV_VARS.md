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

## Recommended

| Variable | Where it's used | Default | Notes |
| --- | --- | --- | --- |
| `DEFAULT_TENANT_ID` | `_lib/auth.js`, `email/inbound.js` | `00000000-0000-0000-0000-000000000001` | matches the seed in 007 |
| `ALLOW_ANONYMOUS_TENANT` | `_lib/auth.js` | `false` | when `true`, calls without an Authorization header are accepted under `DEFAULT_TENANT_ID`. Useful for local dev; turn off for prod |
| `ALLOWED_ORIGINS` | `_lib/cors.js` | `*` | comma-separated origin allowlist for CORS |
| `MAGIC_LINK_REDIRECT_URL` | `auth/magic_link.js`, the unified app | none | set to `https://YOUR-VERCEL-URL/auth/callback.html` |
| `CRON_SECRET` | `fx/cron.js`, `service/amc_cron.js` | none | when set, cron endpoints require `Authorization: Bearer <secret>` |

## Anthropic configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_MODEL_DEFAULT` | `claude-sonnet-4-20250514` | generation tier |
| `ANTHROPIC_MODEL_PREFLIGHT` | `claude-haiku-4-5-20251001` | cheap preflight tier |
| `ANTHROPIC_BETA_HEADER` | unset | passed as `anthropic-beta` header when set |

## Optional integrations

These activate features when set. The endpoints check for presence and
gracefully degrade when unset.

| Variable | Activates | Falls back to |
| --- | --- | --- |
| `MISTRAL_API_KEY` | server-side OCR with bbox provenance | text-only OCR via the legacy frontend Tesseract pipeline |
| `MISTRAL_OCR_MODEL` (default `mistral-ocr-latest`) | OCR model selection | the default |
| `FX_PROVIDER_URL` (default `https://api.frankfurter.app`) | FX rate source | Frankfurter (free, no key) |
| `CLAMAV_URL` | live malware scanning of uploads | deterministic-only guards (size, count, nesting, exe, macro hint, ZIP bomb) |
| `CLAMAV_TOKEN` | bearer auth for ClamAV proxy | unauthenticated ClamAV |
| `TALLY_BRIDGE_URL` | actual SO export to Tally | failed voucher rows |
| `TALLY_BRIDGE_TOKEN` | bearer auth for Tally bridge | unauthenticated bridge |
| `COMMS_PROVIDER_URL` | actual outbound email send | rows marked `sent` in DB without emailing |
| `EMAIL_INBOUND_TOKEN` | inbound email webhook | endpoint refuses all calls when unset |
| `GSTN_API_URL` | real e-Invoice IRN generation | drafts park in `PENDING_GSTN` |
| `GSTN_API_KEY` | client_id passed to GSTN | none |

## How to generate secrets

```sh
openssl rand -base64 32        # for CRON_SECRET, EMAIL_INBOUND_TOKEN
uuidgen | tr '[:upper:]' '[:lower:]'  # for DEFAULT_TENANT_ID if creating a new tenant
```

## Local dev .env.local example

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
MAGIC_LINK_REDIRECT_URL=http://localhost:3000/auth/callback.html
```

Production should add `MISTRAL_API_KEY`, `CRON_SECRET`, `EMAIL_INBOUND_TOKEN`,
plus any other integration the deployment needs, and set
`ALLOW_ANONYMOUS_TENANT=false`.

## Where each var is read

If you grep the codebase for `process.env.NAME` you will find the exact
files. The inventory above was built by doing exactly that.

```sh
grep -rn 'process.env\.' api/ src/ | sort -u
```
