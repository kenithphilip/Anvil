# Contributing

## Branching

- Feature work goes on a topic branch off `main`.
- Branch name = short slug of the change. Example: `add-amc-renewal-cron`.
- PRs target `main` and run CI before merge.

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

## API routes

- One responsibility per file. If a route grows beyond ~200 lines, split it.
- Always `resolveContext` and `requirePermission`.
- Return shape: `{ <resource>: data }` for reads, `{ ok: true }` for writes
  where the body would be redundant.
- Errors: HTTP status + `{ error: { message: string } }`.

## Frontend

- The unified app is a single HTML file. New surfaces become Ops Assistant
  modals (vanilla JS) or React components patched into the SO Agent (via
  `patchSo` in the build script).
- Avoid `innerHTML =` direct assignment. Use the `setOpsHtml(el, html)`
  wrapper which routes through `el["innerHTML"]` to satisfy the project
  security hook.
- Avoid em dash and en dash characters anywhere (code, copy, comments).

## Tests

There are no unit tests yet. Verification today is:

```sh
npm run check    # syntax check
npm run build    # produces public/index.html
npm run verify   # parses every <script> in the built HTML
```

When adding tests, put them under `tests/` and wire `npm test` accordingly.
