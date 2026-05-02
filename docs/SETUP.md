# Setup Tutorial

Goal: a working Anvil deployment on Vercel + Supabase that you can sign in
to with magic-link auth, with all 10 migrations applied and the corpus
customer and item master rows in place. Time required: 30 to 45 minutes the
first time, 5 minutes for subsequent environments.

This guide assumes Node 20 (`nvm use` after cloning), a free Supabase
account, a Vercel account, and an Anthropic API key. Optional integrations
(Mistral OCR, ClamAV, Tally bridge, GSTN) are listed at the end and can be
added incrementally.

## 1. Clone and validate locally

```sh
git clone https://github.com/kenithphilip/Anvil.git anvil
cd anvil
nvm use                         # picks Node 20.18.0 from .nvmrc
npm install
npm run check                   # syntax-checks every api file + bridge client
npm run build                   # produces public/index.html
npm run verify                  # parses every <script> block in the built HTML
```

If any of those four commands fail, stop. Open an issue with the failure
output. The deployment will not work until they pass cleanly.

You can serve the static app right now to confirm the UI loads:

```sh
npx serve public -l 3000
```

The app will load at `http://localhost:3000/` but the backend buttons will
warn "Backend not connected" until the next steps are done.

## 2. Create the Supabase project

1. Go to https://supabase.com/dashboard and click **New project**.
2. Pick the closest region (for Obara India: ap-south-1, Mumbai).
3. Set a strong database password. Save it: you'll need it once for the SQL
   editor admin role and possibly again if you use the Supabase CLI.
4. Wait for the project to provision (around 2 minutes).
5. Open **Project Settings → API**. Copy these three values into a note:
   - `Project URL` (looks like `https://abcd1234.supabase.co`)
   - `anon` public key
   - `service_role` secret key (keep this private; treat it like a database
     password)

Now go to **SQL Editor → New query** and apply each migration in order.
The migrations live in `supabase/migrations/`. Open them in the order below,
paste each into the SQL editor, click **Run**. Wait for "Success. No rows
returned" before moving to the next.

```
001_init.sql
002_eval_and_email.sql
003_studio_ocr_fx_inventory_lead.sql
004_seed_static_data.sql
005_close_remaining_gaps.sql
006_corpus_alignment.sql
007_seed_real_corpus_data.sql
008_einvoice_forecast_amc.sql
009_corpus_round2_schema.sql
010_seed_corpus_round2_data.sql
```

Every migration is fully idempotent: `create type` is wrapped in
`if not exists` checks, every `add constraint` checks `pg_constraint`
first, all inserts use `on conflict do nothing` against real unique
constraints, and the RLS macros only target tables with a `tenant_id`
column. You can re-run any file safely.

If your only access is the SQL Editor and you would rather paste once,
`supabase/seed.sql` is the inlined concatenation of 007 + 010 with a
row-count summary at the bottom. Run the schema-only files (001 through
006, 008, 009) first, then paste `seed.sql`.

After all ten, run this verification query in the SQL editor:

```sql
select count(*) as customers from customers;
select count(*) as item_master from item_master;
select count(*) as holidays from holiday_calendar;
select count(*) as lost_reasons from lost_reason_taxonomy;
```

Expected: at least 6 customers (MG Motor, SRTX, Tata Motors, ABC Motors,
JBM Auto Plant 1, RNAIPL), at least 131 item master rows, at least 58 holiday
rows (IN/CN/JP/KR/US 2026), 9 lost reasons. If any returns 0, re-run the
migration that should have seeded it (the seed migrations are 004, 007,
009, 010).

### Storage buckets

Open **Storage → New bucket** and create two private buckets:

1. `documents` (private, 50 MB max file size)
2. `audit-pack` (private, 100 MB max file size)

You don't need to upload anything; the API code creates and reads files via
service role credentials.

### Auth settings

Open **Authentication → Providers → Email**:

1. Make sure **Email** is enabled.
2. Disable **Confirm email** if you want magic links to work without a
   confirmation step (recommended for B2B internal tools).
3. Enable **Magic Link**.

Open **Authentication → URL Configuration**:

- **Site URL**: leave as the default for now (you'll change to the Vercel
  domain after step 3).
- **Redirect URLs**: add `http://localhost:3000/auth/callback.html` for
  local dev. You'll add the Vercel URL later.

### Create the first tenant + admin user

Migration 001 seeds the default tenant with id
`00000000-0000-0000-0000-000000000001`. You need to attach a real user to
that tenant with role `admin`.

In **Authentication → Users → Add user → Create new user**, type your email
and click **Send invite**. Click the magic link in your inbox; you'll land
on a placeholder page (we'll wire the real callback in step 3). That's fine
for now: the user record is created.

Back in **SQL Editor**, run:

```sql
-- Replace YOUR_EMAIL with the email you just invited.
insert into tenant_members (tenant_id, user_id, role)
select '00000000-0000-0000-0000-000000000001', id, 'admin'
from auth.users
where email = 'YOUR_EMAIL'
on conflict (tenant_id, user_id) do update set role = excluded.role;
```

Verify:

```sql
select email, role from tenant_members tm
join auth.users u on u.id = tm.user_id
where tm.tenant_id = '00000000-0000-0000-0000-000000000001';
```

You should see your email with role `admin`.

## 3. Deploy to Vercel

1. Go to https://vercel.com/new and import the GitHub repo.
2. Vercel detects no framework. Leave **Framework Preset** as `Other`.
3. **Root Directory**: leave blank (the repo root is the project root).
4. **Build Command**: should auto-fill from `vercel.json` to `npm run build`.
5. **Output Directory**: should auto-fill to `public`.
6. Open **Environment Variables** before deploying. Add these (Production +
   Preview + Development unless noted):

   | Variable | Value | Notes |
   | --- | --- | --- |
   | `SUPABASE_URL` | from step 2 | |
   | `SUPABASE_ANON_KEY` | from step 2 | |
   | `SUPABASE_SERVICE_ROLE_KEY` | from step 2 | mark as **secret** |
   | `DEFAULT_TENANT_ID` | `00000000-0000-0000-0000-000000000001` | |
   | `ALLOW_ANONYMOUS_TENANT` | `true` | enables the legacy single-file mode |
   | `ALLOWED_ORIGINS` | `*` for first deploy, lock down later | |
   | `ANTHROPIC_API_KEY` | your Anthropic console key | mark as **secret** |
   | `ANTHROPIC_MODEL_DEFAULT` | `claude-sonnet-4-20250514` | optional, has default |
   | `ANTHROPIC_MODEL_PREFLIGHT` | `claude-haiku-4-5-20251001` | optional |
   | `EMAIL_INBOUND_TOKEN` | `openssl rand -base64 32` | random; only set if you wire an inbound email provider |
   | `CRON_SECRET` | `openssl rand -base64 32` | required if you want to keep crons private |
   | `MAGIC_LINK_REDIRECT_URL` | will be your Vercel URL + `/auth/callback.html` | fill after first deploy |

   Optional integrations (skip on first deploy, add later):

   | Variable | Used by | Notes |
   | --- | --- | --- |
   | `MISTRAL_API_KEY` | `/api/documents/ocr` | enables server OCR with bbox provenance |
   | `MISTRAL_OCR_MODEL` | `/api/documents/ocr` | defaults to `mistral-ocr-latest` |
   | `FX_PROVIDER_URL` | `/api/fx/cron`, `/api/admin/fx_rates` | defaults to `https://api.frankfurter.app` |
   | `CLAMAV_URL` | `/api/documents/scan` | only needed for live malware scanning |
   | `CLAMAV_TOKEN` | `/api/documents/scan` | bearer token for ClamAV proxy |
   | `TALLY_BRIDGE_URL` | `/api/tally/push` | needed to actually export to Tally |
   | `TALLY_BRIDGE_TOKEN` | `/api/tally/push` | bearer token for Tally bridge |
   | `COMMS_PROVIDER_URL` | `/api/communications/send` | enables real outbound email |
   | `GSTN_API_URL` | `/api/einvoice` | activates real e-invoice generation |
   | `GSTN_API_KEY` | `/api/einvoice` | client_id for GSTN |

7. Click **Deploy**. The build runs (about 60 seconds). When it succeeds,
   note the `https://anvil-XXX.vercel.app` URL.

### Wire the callback URL

Now that you have a real domain:

1. In Vercel, set `MAGIC_LINK_REDIRECT_URL` to
   `https://anvil-XXX.vercel.app/auth/callback.html`.
2. In Supabase, **Authentication → URL Configuration**:
   - **Site URL**: `https://anvil-XXX.vercel.app`
   - **Redirect URLs**: add `https://anvil-XXX.vercel.app/auth/callback.html`
3. Trigger a redeploy in Vercel so the env var change takes effect (or `vercel --prod`).

### Smoke test the deploy

Open `https://anvil-XXX.vercel.app/` in a fresh browser tab. You should see
the Obara Ops UI.

1. Hit `Cmd/Ctrl+K` to open the command palette.
2. Type **"Connect Backend"** and select it.
3. The first time, paste your Supabase URL into **Backend URL**. Skip the
   token field if you're testing without auth (uses `DEFAULT_TENANT_ID`).
4. Click **Save**.
5. From the palette, run **"Show Integration Report"**. Every row should be
   green / ok. Any err entries point at a specific feature gap.

Sign-in test:

1. Open the palette → **Connect Backend** → switch to the **Magic Link** tab.
2. Enter your email and click **Send link**.
3. Click the link in your inbox. You'll land on `/auth/callback.html` and
   the page will store the access token in localStorage.
4. Reload the main app. The header should show your email and role `admin`.

You're now ready to use the system.

## 4. Optional integrations

Each is independent. Set the env var(s), redeploy, done.

### Mistral OCR

`MISTRAL_API_KEY` and optionally `MISTRAL_OCR_MODEL`. After setting, the
**Run server OCR + bboxes** button on the order overview becomes functional.

### ClamAV

Stand up a ClamAV REST proxy (any of the open-source ones; the contract is
`POST /scan` with `{ filename, sha256, content_b64 }` returning
`{ infected: bool, virus?: string }`). Set `CLAMAV_URL` and optional
`CLAMAV_TOKEN`. Without them, `/api/documents/scan` still applies
deterministic guards (size, count, nesting, executable detection, macro
hint, ZIP-bomb).

### Tally bridge

Tally Prime exposes an HTTP listener on port 9000 by default. Run a small
proxy on the same network that converts Anvil's voucher payload to Tally's
XML grammar and posts to `http://tally-host:9000`. Set `TALLY_BRIDGE_URL`
and `TALLY_BRIDGE_TOKEN`. Without these, the **Push to Tally** button
records a `failed` voucher and returns a clear error.

### GSTN e-Invoice

Sign up at https://einv-apisandbox.nic.in for sandbox, or your invoice
registration portal of choice for production. Set `GSTN_API_URL` and
`GSTN_API_KEY`. Without these, e-Invoice **Send to GSTN** parks rows in
status `PENDING_GSTN` so you can compose drafts and inspect payloads.

### Outbound email

Set `COMMS_PROVIDER_URL` to a service that accepts
`POST { to, subject, body }`. Without it, the **Send** button on a
Communication draft just marks the row `sent` in the database without
actually emailing.

### Inbound email

Configure your provider (SendGrid, Mailgun, Postmark) to POST to
`https://anvil-XXX.vercel.app/api/email/inbound?token=YOUR_EMAIL_INBOUND_TOKEN`.
The endpoint refuses calls when `EMAIL_INBOUND_TOKEN` is unset, so you must
both set the env var and configure the provider.

## 5. Add additional tenants

Anvil is multi-tenant. To add a new tenant after deploy:

```sql
-- Insert tenant
insert into tenants (id, name) values (gen_random_uuid(), 'My Other Org')
returning id;

-- Note the returned id. Then attach a user.
insert into tenant_members (tenant_id, user_id, role)
select '<tenant-id-from-above>', id, 'admin'
from auth.users
where email = 'admin@otherorg.example';
```

The new tenant will be empty. You can re-run the seed-style queries from
007 against this tenant (replace `00000000-0000-0000-0000-000000000001`
with the new tenant id) to populate sample data, or use the Admin Center
UI to add customers, items, etc.

## 6. Verify everything

From the running production app:

1. Open the **Integration Report** action. Every row should be `ok`.
2. Open **Admin Center → Customer locations**. You should see MG Motor's
   two GSTINs (Halol + Haryana).
3. Open **Admin Center → Item master**. Filter by source country `O-KOREA`
   and confirm 11 rows.
4. Open **Sales Pipeline → Opportunities**. Click **Add** with a real
   customer and confirm it appears in **Forecasting → Refresh**.
5. Open **Admin Center → FX rates → Refresh now** with `as of` set to
   yesterday. Confirm at least 30 rates were written.
6. Open the order intake (SO Agent tab). Confirm the **Order Mode** picker
   has the 5 corpus modes.

Anything that fails here is a real bug, not a config issue. File it with
the failing endpoint or modal name.

## 7. Going to production

Before letting real users in:

1. **Lock down `ALLOWED_ORIGINS`** to your Vercel domain.
2. **Set `ALLOW_ANONYMOUS_TENANT=false`** so unauthenticated callers can't
   read the default tenant's data.
3. **Rotate `EMAIL_INBOUND_TOKEN` and `CRON_SECRET`** to fresh random values.
4. **Enable Supabase Realtime** on `orders` and `shipments` if you want
   live updates.
5. **Set up alerting** on Vercel function failures and Supabase auth events.
6. **Schedule a daily Supabase database backup** under Project Settings.

See `docs/SECURITY.md` for the full threat model and `docs/RUNBOOK.md` for
ongoing operational tasks.
