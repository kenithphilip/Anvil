<!-- Thanks for the PR. Please answer the prompts below; CI fails if
the base check is left unchecked. -->

## Summary

<!-- 1-3 bullets. What changes, why. -->

## Test plan

<!-- How you verified this works. Bulleted markdown checklist. -->

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run check` passes
- [ ] Manually verified the change end-to-end

## Migration notes

<!-- If this PR adds a Supabase migration, note the next migration
     number + idempotency. Otherwise: "no migrations". -->

## Pre-merge checklist

> **Important:** Stacked PRs (where this PR's base is another open
> PR's head branch instead of `main`) have caused two production
> incidents on this repo. The PR base guard CI step blocks them
> automatically.

- [ ] **Base branch is `main`** (not another open PR's head)
- [ ] No secrets / API keys committed
- [ ] No `console.log` / `debugger` / `TODO` markers left in shipped code
- [ ] Migrations are idempotent (`if not exists` / `add column if not exists`)
- [ ] Schema changes have a corresponding `docs/SCHEMA_REFERENCE.md` update
- [ ] New endpoints have a corresponding `docs/API_REFERENCE.md` update
- [ ] New env vars have a corresponding `docs/ENV_VARS.md` update

<!-- Reference docs/CONTRIBUTING.md for the full submission rules. -->
