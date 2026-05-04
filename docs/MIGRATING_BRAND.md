# Migrating from Obara to Anvil

Status: shipped on `main` as Phase 1.1 of the Now block. This file is
the operator runbook for moving an existing deployment over.

## What changed

| Surface | Before | After | Migration |
|---|---|---|---|
| Package description | "Obara India sales-ops execution layer" | "Anvil. Multi-tenant industrial sales-ops platform" | automatic on next deploy |
| Client filename | `src/client/obara-client.js` | `src/client/anvil-client.js` | already in repo |
| Browser global | `window.ObaraBackend` | `window.AnvilBackend` | both names point at the same object so existing screens keep working |
| LocalStorage prefix | `obara:` | `anvil:` | helper reads both, prefers new, migrates on first read |
| Storage bucket | `obara-documents` | `anvil-documents` | per-deployment via `ANVIL_DOCUMENTS_BUCKET` env var |
| Legacy unified HTML | `src/legacy/obara-ops-v11.1.html` | (deleted) | replaced by Vite v3 |
| Wire-level header | `x-obara-tenant` | `x-obara-tenant` (unchanged) | renaming would break every in-flight request from a deployed client |

## Storage bucket rename

The Supabase Storage bucket is the only piece that needs operator
action. The code defaults to a new bucket name (`anvil-documents`) but
falls back to the legacy name when the env var is set. Two paths.

### Option A: keep the legacy bucket (no migration)

For deployments with existing files in `obara-documents`, set
`ANVIL_DOCUMENTS_BUCKET=obara-documents` in the Vercel project. Every
upload + read goes to the legacy bucket; no data moves. This is the
zero-downtime default for upgrading deployments.

### Option B: rename the bucket via Supabase

If your deployment is fresh or you can take a brief downtime window:

1. In Supabase Dashboard > Storage, rename the bucket
   `obara-documents` to `anvil-documents`. Object paths are preserved.
2. Update any RLS policies that reference the bucket name by string.
3. Set `ANVIL_DOCUMENTS_BUCKET=anvil-documents` in Vercel (or unset:
   the new code defaults to the new name).
4. Existing signed URLs in flight (e.g. share links emailed to
   customers) will start 404'ing within their TTL. Regenerate any
   long-lived links.

A future migration may add an automatic `withBucketFallback` reader
(see `src/api/_lib/storage.js`) that tries the new name first then
falls back to the legacy name on 404. For now operators choose one
bucket per deployment.

## LocalStorage migration

No operator action needed. The new `lsGet` / `lsSet` helpers
(`src/v3-app/lib/storage-keys.ts` for the v3-app and the same pattern
inline in `src/client/anvil-client.js`) read both prefixes and migrate
forward on first access. After the first page load on the new bundle
every key the user touches lives under `anvil:`; legacy keys are
removed lazily.

The wire-level header `x-obara-tenant` is intentionally unchanged.
Renaming it would break every in-flight request from a tab still
running the old bundle.

## Browser global

`window.ObaraBackend` is preserved as an alias of `window.AnvilBackend`.
Both point at the same object, so:

- Existing screens that import `{ ObaraBackend } from "../lib/api"`
  keep working.
- Tests that do `window.ObaraBackend = stubBackend()` keep working.
  `installBackend()` in `test-utils` now writes both globals.

A future PR can do a one-shot search-and-replace of `ObaraBackend` to
`AnvilBackend` across the 102 call sites; until then the alias is the
load-bearing compat layer.

## Inline copy

The user-visible copy in `package.json`, the connect screen banners,
the README, the integrations doc, and the gap analysis are all updated
in this round. Inline mentions inside header comments and JSDoc that
say "Obara" are left as historical record where the file's history
specifically references the Obara India deployment.

## Verification

After deploying:

1. `npm run typecheck` exits 0.
2. `npm run audit` shows 0 findings across all phases.
3. `npm run test` shows 169 passing.
4. Sign in to a fresh browser profile. Confirm the sidebar avatar
   shows your initials (not "Guest"), the role pill says ADM (not
   "SAL"), and the Billing tab in Admin Center loads.
5. Inspect localStorage in DevTools: keys are `anvil:*`. The
   `obara:*` keys are absent if you started fresh, or removed
   lazily if you upgraded an existing browser session.
