# Deploy

## Supabase

1. Create a new Supabase project. Note the URL, anon key, service role key.
2. Open the SQL editor and run each file in `supabase/migrations/` in order.
   The migrations are idempotent (create-if-not-exists).
3. Create the storage buckets the app references (defaults: `documents`,
   `audit-pack`). Set them to private.
4. Configure Auth: enable email magic-link sign-in. Add the deployed URL to
   the redirect allow-list (e.g., `https://anvil.example.com/auth/callback.html`).
5. (Optional) Enable Realtime for the `orders` table if you want live
   approval-banner updates.

## Vercel

1. Connect the GitHub repo to Vercel. The repo root is the project root.
2. Set environment variables from `.env.example`. At minimum:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
   - `ANTHROPIC_API_KEY`
   - `DEFAULT_TENANT_ID` (the seed tenant uuid)
   - `EMAIL_INBOUND_TOKEN` (random)
   - `CRON_SECRET` (random)
3. Optional vars enable extra features:
   - `MISTRAL_API_KEY` for server-side OCR with bbox
   - `CLAMAV_URL` + `CLAMAV_TOKEN` for malware scanning of uploads
   - `TALLY_BRIDGE_URL` + `TALLY_BRIDGE_TOKEN` for actual Tally export
   - `COMMS_PROVIDER_URL` for outbound email send
4. Deploy. The build command (`npm run build`) writes `public/index.html`.
   Vercel serves `public/` and discovers serverless functions in `api/`.

## First-run checks

After deploy, hit these endpoints to confirm wiring:

- `GET /api/orders` with a valid Supabase access token. Should return `{orders: []}`.
- `POST /api/admin/fx_rates` with `{ asOf: "2024-04-01" }` and an admin
  session. Should return a row count.
- Open `https://<your-domain>/` and run "Show Integration Report" from the
  Ops palette. All rows should be `ok`.

## Rolling out a new migration

1. Add a new file `supabase/migrations/007_*.sql`. Make it idempotent.
2. Run it locally against a Supabase branch before merging.
3. After merge to main, apply on production via SQL editor or
   `supabase db push --include-all`.

## Rollback

- Frontend: redeploy a prior Vercel commit.
- Backend functions: same.
- Database: write a reverse migration. Migrations only roll forward; never
  edit a committed migration.
