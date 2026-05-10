# Contributing

## Branching

- Feature work goes on a topic branch off `main`.
- Branch name = short slug of the change. Example: `add-amc-renewal-cron`.
- PRs **must** target `main`. Stacked PRs (one PR's base = another PR's
  head branch) are blocked by CI. See "The stacked-squash gotcha" below
  for why.
- `main` is the only long-lived branch. Topic branches are deleted after
  merge.

## The stacked-squash gotcha (read this once)

GitHub squash-merge folds the squash commit into the PR's declared base
branch. If the base is another open PR's head branch, the squash lands
on that head branch, not on `main`. GitHub reports the PR as MERGED
because, technically, it was. But `main` never sees the diff.

This has bitten this repo twice:

| Incident | What happened | Recovery |
|----------|---------------|----------|
| April 2026 | PRs #79 #80 #81 stacked. #79 squashed onto #78's head. | PR #82 cherry-picked the 3 commits onto a fresh branch off `main`. |
| May 2026 | PRs #84 #85 #86 #87 stacked. Only #83 actually reached `main`. | PR #88 cherry-picked the 8 commits onto a fresh branch off `main`. |

The CI job `pr-base-guard` (`.github/workflows/pr-base-guard.yml`) now
fails any PR whose base is not `main`, so the mistake is structurally
impossible.

If you genuinely need to share state between PRs:

1. Open PR A with `base = main`.
2. **Wait for #1 to merge.**
3. Rebase your PR B branch onto the now-updated `main`:
   ```sh
   git fetch origin main
   git rebase origin/main
   git push --force-with-lease
   ```
4. Open PR B with `base = main`.

It's slower than a stack, but `main` always reflects what you opened
PRs for.

## Commits

- Imperative mood, present tense. "Add member invite endpoint" not "Added"
  or "Adds".
- One logical change per commit. Squash before merge if you ended up with
  noise.
- Reference the issue or ticket if there is one.

## Code style

- Two-space indent, semicolons, double quotes.
- Run `npm run format` before committing.
- Keep comments terse. Explain why, not what. Self-explanatory code does not
  need a comment.

## Schema

- New tables go in a new migration file. Never edit a committed migration.
- Always enable RLS and add the standard tenant select/write policies.
- Use lower snake_case for column names.
- Migrations must be idempotent (`if not exists` everywhere). Re-running
  a migration on a partially-applied database must be safe.
- Update `docs/SCHEMA_REFERENCE.md` in the same PR when you add tables
  or columns.

## API routes

- One responsibility per file. If a route grows beyond ~200 lines, split it.
- Always `resolveContext` and `requirePermission`.
- Return shape: `{ <resource>: data }` for reads, `{ ok: true }` for writes
  where the body would be redundant.
- Errors: HTTP status + `{ error: { message: string } }`.
- New endpoints go in `docs/API_REFERENCE.md` in the same PR.

## Environment variables

- New env vars belong in `docs/ENV_VARS.md` in the same PR. Default values
  + a one-line description per var.
- Tenant-specific overrides (encrypted in `tenant_settings`) get an entry
  in the table too.

## Frontend

- The unified app is a single HTML file. New surfaces become Ops Assistant
  modals (vanilla JS) or React components patched into the SO Agent (via
  `patchSo` in the build script).
- Avoid `innerHTML =` direct assignment. Use the `setOpsHtml(el, html)`
  wrapper which routes through `el["innerHTML"]` to satisfy the project
  security hook.
- Avoid em dash and en dash characters anywhere (code, copy, comments).

## Tests

The repo has 790+ vitest tests under `src/v3-app/`. Naming conventions:

- `api-<area>-<feature>.test.js` for backend tests (mocked Supabase shim).
- `screens/<screen>.test.tsx` for React screen tests.
- `lib/<helper>.test.ts` for pure-helper unit tests.

Run before committing:

```sh
npm test          # vitest 790/790 must pass
npm run typecheck # tsc --noEmit must pass
npm run check     # syntax + cold-import + audit
```

`npm run check` also runs the migration linter and the cross-screen audit
that catches missing data-flows.

## PR checklist

The PR template (`.github/pull_request_template.md`) renders a checklist
on every new PR. The CI job `pr-base-guard` fails the PR if the base
isn't `main`. Other items in the checklist are advisory but reviewers
will look for them.

## Recovery if you're already stacked

If you opened a stacked PR before reading this doc:

1. Don't merge it. The CI guard will fail it anyway, but don't try to
   bypass.
2. Rebase your branch onto `main`:
   ```sh
   git fetch origin main
   git rebase origin/main
   git push --force-with-lease
   ```
3. In the GitHub UI, edit the PR's base from `<other-branch>` to `main`.
4. Resolve any conflicts that surface.
5. The CI guard turns green; you can merge.

If your stacked PRs already merged into the wrong branch (the failure
mode that caused #82 and #88), you need a recovery PR:

```sh
git fetch origin main
git checkout origin/main
git checkout -b recover-<topic>
git cherry-pick <first-stacked-commit>..<last-stacked-commit>
git push -u origin recover-<topic>
gh pr create --base main --head recover-<topic> --title "recover: ..."
```
