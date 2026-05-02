# Tests

There are no unit tests yet. Today's verification:

- `npm run check` runs `node --check` on every api file, the bridge client, and the build script.
- `npm run build` compiles the unified HTML.
- `npm run verify` parses every plain `<script>` block in the built HTML with `vm.Script`.

When adding tests:

- Put unit tests under `tests/unit/`.
- Put integration tests that hit a real Supabase instance under `tests/integration/`.
- Add a `test` script to `package.json` that runs them.
- Wire CI in `.github/workflows/ci.yml` to call the new script.

Patterns to lift from when starting:

- `node:test` for runner (built-in, zero deps).
- Snapshot the built HTML size and grep for required symbols, like the audit
  block in the project plan.
- Mock Supabase with a minimal stub that returns deterministic rows; do not
  depend on a live Supabase instance for unit tests.
