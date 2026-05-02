# v3 Vite Migration Report (Phase 8)

End-to-end audit of the v3 design overhaul migration from a hand-rolled
concatenator to a real bundler. Covers what was migrated, what was
deleted, what was added, and how to prove parity.

## TL;DR

The 1.0+ MB `public/v3.html` monolith built by `src/scripts/build-v3.mjs`
is gone. Every wired screen, primitive, helper, RBAC + preferences
module, the Shell, the Cmd+K palette, the Thread drawer, the toast
queue, and the route shim now lives under `src/v3-app/` as ESM +
TypeScript. The new build runs through Vite, splits per-route, and ships
to `public/v3-app/`. Tests run on Vitest. Type-checking runs on tsc.

Audit script confirms 9 of 9 invariants:

```
OK  legacy-source-removed          none of 4 legacy paths remain
OK  routes-cover-nav               33 routes resolve
OK  screen-files-exist             44 lazy imports resolve
OK  screen-tests-exist             44 screens have tests
OK  lib-tests-exist                8 lib modules have direct tests
OK  no-window-wired-exports        no matches in src/v3-app/
OK  no-w-suffixed-hooks            no matches in src/v3-app/
OK  no-local-useFetch-redef        no matches in src/v3-app/
OK  npm-scripts                    9 required scripts present
```

## What was migrated

### Sources

| Legacy path                                 | New path                                   | Type    |
| ------------------------------------------- | ------------------------------------------ | ------- |
| `src/v3/styles.css`                         | `src/v3-app/styles.css`                    | css     |
| `src/v3/rbac.js`                            | `src/v3-app/lib/rbac.ts`                   | typed   |
| `src/v3/preferences.js`                     | `src/v3-app/lib/preferences.ts`            | typed   |
| `src/v3/primitives.jsx` (Icon namespace)    | `src/v3-app/lib/icons.tsx`                 | typed   |
| `src/v3/primitives.jsx` (UI primitives)     | `src/v3-app/lib/primitives.tsx`            | typed   |
| `src/v3/shell.jsx` Shell + CmdK + Drawer    | `src/v3-app/components/Shell.tsx`          | typed   |
| `src/v3/shell.jsx` NAV + ROLES + crumbFor   | `src/v3-app/lib/nav.ts`                    | typed   |
| `src/v3/app.jsx`                            | `src/v3-app/app.tsx`                       | typed   |
| `src/v3/screens/wired-home.jsx` helpers     | `src/v3-app/lib/helpers.ts`                | typed   |
| `src/v3/screens/wired-toasts.jsx`           | `src/v3-app/lib/toasts.tsx`                | typed   |
| `src/v3/screens-wired/wired-tally-*.jsx`    | `src/v3-app/lib/tally.ts`                  | typed   |
| `src/v3/screens-wired/*.jsx` (39 wired)     | `src/v3-app/screens/*.tsx`                 | nocheck |
| `src/v3/screens/*.jsx` (13 static demos)    | merged into wired counterparts             | n/a     |
| `src/client/obara-client.js`                | re-exported via `src/v3-app/lib/api.ts`    | typed   |

### Routes

The legacy `App` resolved 33 nav ids (30 visible + 3 hidden). All 33 are
registered in `src/v3-app/routes.ts` as `React.lazy(() =>
import("./screens/X"))` entries with a per-route resolver function so
sub-routes (`so?id=`, `so?view=history`, `items?view=guns`,
`tally?sub=masters`, etc.) lazy-load distinct chunks.

### Shell-level surfaces

- Header (brand, breadcrumb, Cmd+K search bar, tenant pill, role pill,
  thread button, notifications) → `Shell.tsx`.
- Sidebar (9 groups, RBAC-filtered) → `Shell.tsx` reading from
  `lib/nav.ts`.
- Dock (live status, Tally bridge, FX, ClamAV, autosave count) →
  `Shell.tsx`.
- Cmd+K palette → `Shell.tsx` `<CmdK />` (static groups; the wired
  live-search overlay from `wired-cmdk.jsx` is a follow-up).
- Thread drawer → `Shell.tsx` `<ThreadDrawer />` (static rows; live
  per-order timeline overlay from `wired-thread.jsx` is a follow-up).
- Toast queue → `lib/toasts.tsx` `<ToastStack />` mounted in
  `app.tsx`. Exposes `notify*` on `window` for wired-screen
  compatibility.
- Theme + density + rail toggle → `app.tsx` `<ThemeBar />`, persists via
  `lib/preferences.ts`, fires `prefs:change` events the rest of the app
  listens for.

## What was added

| File                                            | Purpose                                  |
| ----------------------------------------------- | ---------------------------------------- |
| `vite.config.js`                                | Vite + plugin-react + per-route chunks   |
| `tsconfig.json`                                 | TS scaffold, bundler resolution          |
| `src/v3-app/index.html`                         | Vite entry HTML                          |
| `src/v3-app/index.tsx`                          | createRoot mount + Prefs.apply           |
| `src/v3-app/lib/placeholder.tsx`                | Stub component for not-yet-ported routes (unused after cutover) |
| `src/v3-app/test-setup.ts`                      | Vitest global setup                      |
| `src/v3-app/test-utils.tsx`                     | stubBackend + installRbac + renderScreen |
| `src/scripts/convert-v3-screens.mjs`            | Globals → ESM converter (one-shot)       |
| `src/scripts/gen-screen-tests.mjs`              | Smoke-test generator                     |
| `src/scripts/rename-to-ts.mjs`                  | .js/.jsx → .ts/.tsx renamer (one-shot)   |
| `src/scripts/audit-migration.mjs`               | Phase 8 invariants checker               |
| `docs/V3_VITE_MIGRATION_REPORT.md`              | This file                                |

## What was deleted

| Path                                  | Reason                                       |
| ------------------------------------- | -------------------------------------------- |
| `src/v3/`                             | Entire legacy v3 source replaced by v3-app/  |
| `src/scripts/build-v3.mjs`            | Concatenator obsolete after Vite cutover     |
| `src/scripts/test-v3-contract.mjs`    | Static-analysis safety net replaced by tsc   |
| `public/v3.html`                      | Legacy 1.2 MB monolith                       |

## Bundle comparison

**Before (legacy `public/v3.html`)**

- 1224 kB single file
- Babel-standalone transpiles every JSX block at runtime
- No code splitting, no tree shaking, no source maps
- Every visit to /v3.html downloads the SO Workspace, BOM importer,
  Cytoscape graph, Cmd+K palette, etc., regardless of route

**After (Vite `public/v3-app/`)**

```
index.html                               0.6 kB │ gzip   0.3 kB
index.css (design system)               23.7 kB │ gzip   5.2 kB
index.js (React + Shell + icons)       201.9 kB │ gzip  62.7 kB
spares chunk (largest)                  34.4 kB │ gzip   9.8 kB
admin chunk                             34.2 kB │ gzip   7.5 kB
so-history chunk                        32.9 kB │ gzip  10.5 kB
so-workspace chunk                      23.9 kB │ gzip   7.7 kB
… 40 more route chunks 0.2 kB - 20 kB each
```

First paint: ~70 kB gzipped (CSS + index). Each route is one HTTP/2
request away when navigated. Source maps emitted for every chunk.

## Tests

```
Test Files  52 passed
     Tests  129 passed
  Duration  ~6s
```

Coverage:

- `lib/helpers.test.ts`: 13 cases on ageLabel / fmtINRShort / stageOf /
  sevOf.
- `lib/primitives.test.tsx`: 14 cases across every primitive (Btn /
  Card / KPI / Banner / Stream / formatters / etc.).
- `lib/rbac.test.ts`: matrix shape, role gates, action gates, filterNav
  pruning.
- `lib/nav.test.ts`: NAV groups, ids, roles, breadcrumb helper.
- `lib/preferences.test.ts`: theme/density/rail get/set/toggle, apply
  side-effects.
- `lib/toasts.test.tsx`: queue lifecycle, ttl, window compat surface,
  ToastStack render.
- `lib/tally.test.ts`: row unwrap helpers, shortHash.
- `lib/placeholder.test.tsx`: stub component + factory.
- `screens/*.test.tsx` (44 files): smoke test per screen with stubbed
  backend + admin RBAC. Asserts the screen renders without throwing
  through one effect tick.

## Type-checking

`tsconfig.json` runs `tsc --noEmit` over every file under `src/v3-app/`.
Lib + components + app.tsx + routes.ts + index.tsx are strictly typed
(explicit prop interfaces, generic helpers, narrow union types for
roles + themes). Each converted screen carries `// @ts-nocheck` because
the bulk converter doesn't have visibility into nested API response
shapes; tightening per-screen types is a follow-up that doesn't block
the migration.

## Operational notes

- `npm run build`: legacy unified app + Vite v3 app.
- `npm run dev:v3`: Vite dev server on port 5180 with HMR.
- `npm run typecheck`: tsc against tsconfig.json.
- `npm test`: Vitest (CI mode).
- `npm run test:watch`: Vitest watch mode.
- `npm run verify`: legacy index.html script-block verifier only.
- `npm run check`: API + client syntax + typecheck.
- `npm run predeploy`: chains build + check + verify.

Old links to `/v3.html` are rewritten to `/v3-app/index.html` in
`vercel.json` so external bookmarks keep resolving. The unified app's
`?v3=1` shim now redirects to `/v3-app/` directly.

## Open follow-ups

These don't block the cutover but are worth tracking:

1. **Strict-typed screens.** Replace `// @ts-nocheck` headers one screen
   at a time, defining response-shape types as we touch each. Mostly
   value-add when screens get edited next anyway.
2. **Wired Cmd+K + ThreadDrawer overlays.** The legacy `wired-cmdk.jsx`
   and `wired-thread.jsx` brought live backend search + per-order
   timeline. The Shell ports the static fallback; the wired versions
   are a contained next sub-PR.
3. **Playwright smoke.** Vitest covers per-component behavior. A
   browser smoke that walks every route and asserts no console errors
   would catch styling regressions the JSDOM tests miss.
4. **Drop the converter scripts.** `convert-v3-screens.mjs`,
   `gen-screen-tests.mjs`, `rename-to-ts.mjs` are one-shots. Keep them
   for archaeology or delete them in a tidy-up PR.
5. **Cytoscape lazy import.** `screens/graph.tsx` currently includes a
   global script tag pattern from the legacy file. Migrate to a real
   `import("cytoscape")` so it's part of the route chunk graph.
