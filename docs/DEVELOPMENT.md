# Development

## Prereqs

- Node 20 (use `nvm use` to pin from `.nvmrc`)
- A Supabase project (free tier works) and `.env.local` populated from
  `.env.example`
- Anthropic API key with access to Claude Sonnet and Haiku
- Optional: Mistral API key for server-side OCR

## Run the unified app locally

```sh
npm install
npm run build
# open public/index.html in a browser, or serve it:
npx serve public -l 3000
```

The app calls `/api/*` routes that come from your deployed Vercel project. To
run end-to-end locally:

```sh
npm install -g vercel
vercel dev
```

`vercel dev` runs both the static site at `http://localhost:3000/` and the
serverless functions at `http://localhost:3000/api/*`.

## Touching the bridge client

Edit `src/client/obara-client.js`, then `npm run build`. The client is inlined
into `public/index.html` at build time, so a rebuild is required for changes
to land.

## Touching an API route

Edit the file in `api/`. `vercel dev` hot-reloads. Live deploy: `git push` to
the connected branch and Vercel rebuilds.

## Running checks

```sh
npm run check        # node --check on every api file + bridge client + build script
npm run build        # rebuild public/index.html
npm run verify       # parse every <script> block in the rebuilt HTML
```

## Schema changes

1. Create a new file in `supabase/migrations/` with the next sequence number.
2. Use `create table if not exists` and `drop policy if exists` patterns to
   keep it idempotent.
3. Always enable RLS and add the tenant select/write policies.
4. Apply locally first.

## Conventions

- Every endpoint resolves the auth context via `_lib/auth.resolveContext` and
  calls `requirePermission(ctx, "read|write|admin")`.
- Every endpoint includes CORS via `_lib/cors.applyCors` and handles
  `OPTIONS` via `handlePreflight`.
- Every write calls `recordAudit` from `_lib/audit`.
- Status fields use uppercase enum values matching the SQL enums.
- Dates use ISO 8601 strings. UTC for timestamps; local YYYY-MM-DD for date
  fields. Display formatting is the frontend's job.
- JSON keys are lower snake_case to match Postgres column names.
