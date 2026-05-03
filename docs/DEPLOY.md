# Deploy

Short version: see `docs/SETUP.md` for the zero-to-deployed walkthrough.
This document covers the deployment lifecycle: pushing changes, applying
migrations, rolling back, and managing per-environment config.

## Branches and environments

Two long-lived environments:

| Env | Branch | Vercel project | Supabase project |
| --- | --- | --- | --- |
| Production | `main` | `anvil` | `anvil-prod` |
| Preview | feature branches | auto-preview | `anvil-preview` (or branch DBs) |

Vercel auto-creates a preview deploy for every PR. Supabase branch
databases are optional and require Pro plan; for personal projects use a
single shared `anvil-preview` Supabase project for all PRs.

## Deploy flow

```
local change -> git push feature -> Vercel preview -> review -> merge to main -> Vercel prod
```

Migrations are NOT auto-applied. Apply them manually after merge:

1. Open Supabase production project -> SQL Editor.
2. Open the new migration file from `supabase/migrations/`.
3. Paste, click **Run**.
4. Verify with the queries at the bottom of `docs/SCHEMA_REFERENCE.md`.

## Build configuration

`vercel.json` declares:

- `buildCommand: npm run build`
- `outputDirectory: public`
- `functions:` `maxDuration` 60s for the catch-all dispatcher
- `crons:` daily fx_cron at 04:00 UTC and amc_cron at 05:00 UTC
- `headers:` CORS for `/api/*` and immutable cache for `/assets/*`
- `rewrites:` `/v3.html` and `/v3-app/*` map back to `/index.html`
  for any user with stale bookmarks from the soft-launch period

`npm run build` runs Vite directly. There is no second build step:

```
rm -rf public/assets public/index.html public/v3-app && vite build
```

The clean step removes any stale chunks from previous builds (the
hashed filenames mean old chunks would otherwise pile up because
`emptyOutDir: false`). `public/auth/callback.html` is preserved
because it sits outside `public/assets/` and `public/index.html`.

The Vite build:

- Reads `src/v3-app/index.html` as the entry document
- Bundles `src/v3-app/index.tsx` and the per-route lazy imports from
  `src/v3-app/routes.ts`
- Writes `public/index.html` (the entry HTML, around 4 KB) and
  `public/assets/*` (per-route hashed chunks, source maps, CSS)
- Initial paint loads ~70 KB gzipped (React + Shell + design system).
  Visiting a route lazy-loads only that route's chunk.

There is no separate "legacy" or "unified" build anymore. The
src/legacy/ directory is preserved for historical reference but is
not wired into any script.

### Function consolidation

Vercel Hobby plans cap a deployment at 12 serverless functions. The
backend has 75+ REST endpoints, so we consolidate everything into a
SINGLE function:

- The dispatcher lives at `api/[...path].js`. Vercel sees one file
  and provisions one function.
- The actual handlers live under `src/api/`. They are unchanged from
  before the consolidation; only the directory moved.
- The dispatcher imports from `src/api/router.js`, which has a
  static-import map of every endpoint plus a tiny dynamic resolver
  for `/orders/<id>`, `/source_pos/<id>`, `/documents/<id>`.

To add an endpoint:

1. Write the handler under `src/api/<group>/<name>.js` with
   `export default async function handler(req, res) { ... }`.
2. Add a row to `STATIC_ROUTES` (or `DYNAMIC_ROUTES`) in
   `src/api/router.js`.
3. Done. No Vercel config tweak needed.

The router test at `src/v3-app/api-router.test.js` walks every literal
`/api/...` path the obara-client uses and asserts each resolves. CI
catches a missing route the moment a screen calls a method without a
matching handler.

### Function runtime

Vercel auto-detects Node.js from the `engines.node` field in
`package.json` (currently `"20.x"`, pinned to a single major so the
auto-upgrade warnings stop). Do NOT specify a `runtime` value in
`vercel.json`. The legacy `nodejs20.x` literal is not a valid
descriptor in current Vercel projects and causes:

```
Error: Function Runtimes must have a valid version, for example
`now-php@1.0.0`.
```

Vercel's Active CPU billing model also IGNORES `memory` overrides
in `vercel.json` (it allocates per-request automatically). Only
`maxDuration` is honored. The catch-all dispatcher uses the highest
duration any inner endpoint needs (60s for OCR + Claude + Tally).

### Pre-deploy check

`npm run predeploy` chains `build` + `check` + `verify`. The `check`
step runs `node --check` over every API handler under `api/` and
`src/api/`, plus the obara-client, then `tsc --noEmit` over the
v3-app TypeScript sources. The `verify` step runs `npm run audit`
which chains all eight audits:

- `audit-migration`     (9 invariants: legacy paths gone, route
                         coverage, screen tests, etc.)
- `audit-screens-deep`  (forbidden globals)
- `audit-cross-screen`  (legacy hoist references that broke after
                         the ESM split)
- `audit-ux`            (modal a11y, anchor-vs-button, icon labels)
- `audit-backend-calls` (silent dead method calls)
- `audit-hardcoded-data` (no demo customer names / dates / refs)
- `audit-data-model`    (form payload keys match handler reads)
- `audit-cross-module`  (every window.location.hash points at a
                         registered route)

All eight pass with 0 findings. If any reports a finding, the build
fails fast before Vercel ever sees it.

If you want to ship a hotfix without running the full audit, set the
`SKIP_AUDIT=1` env var locally and run `npm run build` directly. The
production Vercel project should never have that var set.

## Environment variables

See `docs/ENV_VARS.md` for the full inventory. Required for prod:

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY      (mark secret)
ANTHROPIC_API_KEY              (mark secret)
DEFAULT_TENANT_ID
ALLOW_ANONYMOUS_TENANT=false   (lock down for prod)
ALLOWED_ORIGINS=https://your-prod-url
MAGIC_LINK_REDIRECT_URL=https://your-prod-url/auth/callback.html
CRON_SECRET                    (mark secret)
EMAIL_INBOUND_TOKEN            (mark secret)
```

Optional (set when integrating each):
`MISTRAL_API_KEY`, `CLAMAV_URL`, `CLAMAV_TOKEN`, `TALLY_BRIDGE_URL`,
`TALLY_BRIDGE_TOKEN`, `COMMS_PROVIDER_URL`, `GSTN_API_URL`, `GSTN_API_KEY`,
`FX_PROVIDER_URL` (default Frankfurter).

## Applying a new migration

1. Add `supabase/migrations/00N_description.sql`. Make it idempotent.
   The patterns we use across 001 - 010:
   - `create table if not exists`, `add column if not exists`,
     `create index if not exists`
   - `create type` wrapped in `do $$ begin if not exists (select 1 from
     pg_type where typname = 'X') then ... end if; end $$;`
   - `add constraint` wrapped in `do $$ begin if not exists (select 1 from
     pg_constraint where conname = 'X' and conrelid = 'T'::regclass) then
     alter table T add constraint X ...; end if; end $$;`
   - `insert ... values ... on conflict (target) do nothing` against a real
     unique constraint, or wrap rows in `where not exists (select 1 ...)`.
   - `drop policy if exists` ahead of `create policy`.
   - RLS macros only loop over tables with a `tenant_id` column.
2. Test locally against a Supabase branch project or scratch project.
3. Push the branch. Open the PR.
4. After merge, paste the file into Supabase prod SQL Editor and run.
5. Verify by counting rows / checking RLS:
   ```sql
   select c.relname, c.relrowsecurity
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' and c.relname like 'YOUR_NEW_TABLE%';
   ```

Never edit a previously applied migration. If you find a mistake, write a
new migration that corrects it.

## First-deploy checklist

After Vercel build succeeds:

- [ ] Open `https://your-prod-url/`. UI loads.
- [ ] Cmd/Ctrl+K -> **Show Integration Report**. Every row green.
- [ ] Cmd/Ctrl+K -> **Connect Backend** -> magic link tab. Send to
      yourself, click the link, callback page lands at `/auth/callback.html`,
      session stored.
- [ ] Reload main app. Header shows your email and role admin.
- [ ] Open **Admin Center -> Customer locations**. MG Motor shows two
      GSTINs.
- [ ] Open **Admin Center -> Item master**. At least 35 rows.
- [ ] Run an end-to-end test: upload a sample PO, click through preflight
      and generation, approve, push to Tally (will fail without the bridge
      configured, that is expected).

## Production hardening

Before letting real users in:

```
ALLOW_ANONYMOUS_TENANT=false
ALLOWED_ORIGINS=https://your-prod-url
```

This prevents unauthenticated callers from acting under
`DEFAULT_TENANT_ID` and locks CORS to the production origin.

Other production concerns:

- Enable **Supabase Realtime** on `orders` and `shipments` if you want
  live approval-banner updates.
- Set up Vercel **Speed Insights** for frontend performance monitoring.
- Set up Vercel **Log Drains** to forward function logs to a SIEM.
- Schedule daily Supabase backups.

## Rolling back

### Frontend / functions

In Vercel: **Deployments -> click a previous successful deploy -> Promote
to Production**. Atomic, no DB changes.

### Database

Migrations only roll forward. To "roll back" a schema change:

1. Write a new migration that reverses it (`drop column`, `drop table`,
   re-create RLS as it was).
2. Apply via SQL editor.

For a deeper rollback (e.g., recover from a bad data migration), restore
from a Supabase point-in-time backup:

1. **Project Settings -> Database -> Backups -> Point-in-Time**.
2. Pick a timestamp before the problem.
3. Restore to a new project.
4. Repoint Vercel env vars at the new project URL/keys.

This is destructive: data added between the restore point and now is
lost. Plan accordingly.

## Multi-tenant onboarding

To add a new customer (tenant) to an existing deploy:

```sql
-- 1. Create the tenant
insert into tenants (id, slug, display_name)
values (gen_random_uuid(), 'newco', 'NewCo Manufacturing')
returning id;
-- save the returned id, e.g. 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

-- 2. Attach an admin user (user must have signed in once already)
insert into tenant_members (tenant_id, user_id, role)
select 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', id, 'admin'
from auth.users where email = 'admin@newco.example';

-- 3. Optional: copy the seed data from migration 007
--    Replace tenant id in the migration file and re-run.
```

The new tenant's members will see only their own data thanks to RLS.

## Cron triggers

Two cron jobs are wired in `vercel.json`:

- `0 4 * * *` (daily 04:00 UTC): `/api/fx/cron`
- `0 5 * * *` (daily 05:00 UTC): `/api/service/amc_cron`

Both accept an optional `Authorization: Bearer $CRON_SECRET` header. Vercel
sends this automatically when `CRON_SECRET` is set in the project env. To
trigger manually:

```sh
curl -X GET 'https://YOUR-URL/api/fx/cron' \
  -H "Authorization: Bearer $CRON_SECRET"

curl -X GET 'https://YOUR-URL/api/service/amc_cron' \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Cost optimization

Anvil uses the model routing ladder (Haiku preflight -> Sonnet generation
-> Opus reasoning) plus extraction caching. A typical SO costs $0.02-0.05
in Anthropic API. Watch the **Cost Analytics Deep** modal weekly.

To force the cheaper path on a specific customer:

1. Open **Profile Studio** for that customer.
2. Toggle **Force Claude fallback** OFF (default).
3. Save. Subsequent intakes use the local template extractor where
   possible.

To diagnose unexpected Sonnet/Opus usage, check `model_routing_log` for
`fallback_reason`.

## Disaster recovery

Recovery scenarios and their RTOs:

| Scenario | Detection | Recovery | RTO |
| --- | --- | --- | --- |
| Vercel deploy bad | Integration Report fails, user reports | Roll back via Deployments | 5 min |
| Anthropic outage | 500s on /api/claude/messages | Wait, no fallback | up to Anthropic |
| Supabase outage | every API call 5xx | Wait, status.supabase.com | up to Supabase |
| Migration broke prod | data missing, queries fail | Forward-fix migration or restore | 30 min |
| Service role leaked | external party access | Rotate immediately, audit access | 15 min to rotate, hours to audit |

For the service-role-leaked case:

1. Rotate the key in Supabase **Settings -> API**.
2. Update Vercel env var.
3. Redeploy.
4. Pull `audit_events` for the past 30 days, look for unusual patterns.
