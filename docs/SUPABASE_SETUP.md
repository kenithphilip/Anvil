# Supabase setup runbook

End-to-end procedure for a new Supabase project. Follow once, top to bottom.
Estimated time: 20 to 30 minutes.

The app uses a single Supabase project as Postgres + Auth + Storage. There
is no Edge Functions usage; all server-side logic runs as Vercel serverless
functions reading the service-role key.

> **TL;DR**: clone the repo, run [supabase/setup.sh](../supabase/setup.sh)
> with `SUPABASE_DB_URL` exported, configure auth + storage in the
> dashboard (4 clicks), done.

## 1. Create the project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and click
   **New project**.
2. Choose the closest region. For Obara India use `ap-south-1` (Mumbai).
3. Set a strong database password. Save it. You need it once for the SQL
   editor admin role and again if you use the Supabase CLI from a CI box.
4. Wait for provisioning (around 2 minutes).

## 2. Capture the API keys

Open **Project Settings, API** and copy three values into a notes file:

- `Project URL` (looks like `https://abcd1234.supabase.co`)
- `anon` public key
- `service_role` secret key

The service-role key is sensitive; treat it like a database password. It
goes only into Vercel environment variables, never into the browser bundle.

## 3. Apply the schema

There are 10 idempotent migrations under `supabase/migrations/`. Apply
them in numeric order. Three options:

### Option A: Supabase CLI (cleanest)

```sh
supabase link --project-ref <project-ref>
supabase db push --include-all
```

The CLI applies every file in `supabase/migrations/` in order. Re-running
is a no-op because every statement is guarded.

### Option B: One-shot script

```sh
export SUPABASE_DB_URL="postgres://postgres:<password>@db.<ref>.supabase.co:6543/postgres?sslmode=require"
./supabase/setup.sh
```

The script is idempotent: it runs every migration in order, then runs
`supabase/seed.sql` for the corpus seed data, then prints a row-count
summary so you can confirm what landed.

### Option C: Paste each file into the SQL Editor

Open `https://supabase.com/dashboard/project/<id>/sql, New query`. For
each `supabase/migrations/00*.sql` file in numeric order, paste, click
**Run**, wait for `Success. No rows returned` before moving on. After 010
finishes, paste `supabase/seed.sql` once.

Expected result after migrations + seed.sql:

| relation | count |
| --- | --- |
| customers | 6 |
| customer_locations | 5 |
| customer_format_profiles | 6 |
| item_master | 131 |
| engineering_specs | 1 |
| payment_milestones | 8 |
| expense_rate_cards | 11 |
| inco_terms_taxonomy | 7 |
| logistics_ports | 9 |
| logistics_carriers | 10 |
| contracts | 3 |
| orders | 12 |
| shipments | 3 |
| equipment_hierarchy | 15 |
| equipment_installed_parts | 54 |
| quote_approval_thresholds | 4 |

## 4. Storage bucket

Open **Storage, New bucket** and create one private bucket:

- Name: `obara-documents`
- Public: **off**
- File size limit: `100 MB`
- Allowed MIME types: leave empty (the API enforces ZIP guards
  separately)

The API code uses the service-role key to read and write, so the bucket
permissions only matter for direct browser uploads (which Anvil does not
do).

## 5. Auth settings

### Magic link

Open **Authentication, Providers, Email** and confirm:

- **Email** is enabled.
- **Confirm email** is **off** (so magic links work without a confirm
  step; recommended for B2B internal tools).
- **Magic Link** is **on**.

### Redirect URLs

Open **Authentication, URL Configuration**:

- **Site URL**: leave default for now.
- **Redirect URLs**: add **both**:
  - `http://localhost:3000/auth/callback.html`  (local dev)
  - `https://YOUR-VERCEL-URL/auth/callback.html`  (replace with your Vercel
    domain after deploy)

When the user clicks the email link, Supabase posts to your callback page,
which stores the access token in `localStorage` and redirects back into
the app.

### Optional: SMTP

The default Supabase SMTP is rate-limited to ~3 emails per hour. For
production, swap to a real provider under **Project Settings, Auth, SMTP**.
SendGrid, Postmark, Resend, or AWS SES all work; only the host, port,
username, password, and from-address fields are needed.

## 6. First tenant member

Migrations seed a default tenant with id
`00000000-0000-0000-0000-000000000001`. To sign in, your `auth.users`
row needs to be a member of that tenant.

After you sign in once via magic link (which creates the
`auth.users` row), open the SQL editor and run:

```sql
-- Replace <YOUR_USER_UUID> with the id from auth.users for your email.
insert into tenant_members (tenant_id, user_id, role)
values ('00000000-0000-0000-0000-000000000001', '<YOUR_USER_UUID>', 'admin')
on conflict (tenant_id, user_id) do update set role = excluded.role;
```

Refresh the app. You are now an admin of the default tenant.

To add additional members later, use the v3 Admin Center, Members tab.
The legacy app has the same flow under the Backend modal.

## 7. Verify

In the SQL editor:

```sql
select 'customers' as t, count(*) from customers
union all select 'orders', count(*) from orders
union all select 'tenant_members', count(*) from tenant_members
union all select 'auth.users', count(*) from auth.users;
```

Open the app at your Vercel URL with `?v3=1`. Click the tenant pill in
the header (right side). The Backend Connect screen shows your config.
Click any nav item to confirm data loads.

## 8. Pitfalls

- **CORS error in browser**: ALLOWED_ORIGINS is missing your domain. Set it
  in Vercel env vars to your Vercel URL (or use `*` for dev).
- **`row violates row-level security policy`**: the user is not a member
  of the target tenant. Add a `tenant_members` row (step 6).
- **`column tenant_id does not exist`**: an old version of migration 001
  is applied and missing the patch. Pull latest, re-run 001 (it is
  idempotent).
- **Supabase warns "New tables will not have Row Level Security
  enabled"** while running a migration: false positive. Migrations
  001, 005, 006, 008, 009 enable RLS plus tenant policies on every
  table they create. Verify by grepping the migration file:
  `grep -c "enable row level security"` should match
  `grep -c "create table if not exists"`. Click "Run" on the
  warning dialog. If you want belt-and-suspenders, paste only the
  RLS block first, then the rest, but the migration is idempotent
  and safe to run end-to-end.
- **Magic link does not arrive**: the default Supabase SMTP is severely
  rate-limited. Use a real provider for any volume above 3 emails per hour.

## 9. Optional: enable additional integrations

| Integration | Env var | Effect when missing |
| --- | --- | --- |
| Mistral OCR | `MISTRAL_API_KEY` | OCR routes 500 |
| ClamAV proxy | `CLAMAV_URL`, `CLAMAV_TOKEN` | scans return `skipped` |
| Tally bridge | `TALLY_BRIDGE_URL`, `TALLY_BRIDGE_TOKEN` | Tally push fails fast |
| Comms provider | `COMMS_PROVIDER_URL`, `COMMS_PROVIDER_TOKEN` | comms.send marks drafts as `manual` |
| GSTN e-Invoice | `GSTN_API_URL`, `GSTN_API_KEY` | e-invoices stay PENDING_GSTN |
| Inbound email webhook | `EMAIL_INBOUND_TOKEN` | /api/email/inbound returns 401 |

See [docs/INTEGRATIONS.md](INTEGRATIONS.md) for per-service runbooks.
