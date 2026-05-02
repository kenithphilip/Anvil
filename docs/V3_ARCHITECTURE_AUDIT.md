# v3 Architecture Audit (honest)

## What's wrong with the current build

The v3 app is built by `src/scripts/build-v3.mjs` into a single
`public/v3.html` of 1.0+ MB. That's a real problem and the size is
**not a measure of progress**. It's a measure of bad packaging.

What the build does today:

1. Reads `src/v3/styles.css` (35 KB) and inlines it inside `<style>`.
2. Reads `src/v3/rbac.js`, `preferences.js`, `obara-client.js` and
   inlines them as plain `<script>` blocks.
3. Reads `primitives.jsx`, every static screen in `screens/*.jsx`,
   every wired screen in `screens-wired/*.jsx`, `shell.jsx`, and
   `app.jsx` and inlines them all as `<script type="text/babel">`
   blocks.
4. The browser loads `@babel/standalone` from CDN and transpiles every
   JSX block at runtime on first paint.

Consequences:

- **Slow first paint.** Babel-standalone needs to parse and transpile
  the entire 700 KB JSX bundle in the browser before anything renders.
- **No module system.** Every wired screen lives in the same script
  scope. We've already had three `const` redeclaration bugs from this
  (Customers, Cover, CostSimulator, parseDelimited, parseXlsx).
- **No code splitting.** Visiting `#/home` downloads the SO Workspace,
  the Spare Matrix worksheet, the BOM importer, and 30+ other screens
  the user may never open.
- **No tree shaking.** Every primitive is shipped even if unused.
- **No source maps.** A runtime error gives you a line number into the
  generated HTML, not into the source `.jsx` file.
- **No production build.** Babel-standalone is explicitly labeled "do
  not use in production."
- **Naming collisions enforce filename suffixes** (-c, -d, -e, -f,
  -crud) instead of letting modules import each other safely.

The legacy app at `public/index.html` (979 KB) has the same shape, plus
inline jQuery for the Tally voucher renderer. We tolerated that because
the legacy app is in maintenance.

## What we should move to

A real bundler with a module system. Recommended stack:

- **Vite 5** (esbuild for dev, Rollup for prod). Fast HMR, real ESM,
  per-route code splitting via `import()`.
- **React 18** as a normal `npm` dependency, not a CDN script.
- **TypeScript** is optional but makes the contract test in
  `src/scripts/test-v3-contract.mjs` redundant: the type checker
  catches the same class of issues at compile time.
- **Vitest** for fast unit tests of the wired screens (right now we
  have zero tests; the contract test is a static-analysis safety net,
  not a behavior check).

Concrete migration plan (4 sub-PRs, roughly 1 day of focused work):

### Sub-PR 1: scaffold Vite (LANDED)

- Added `vite`, `@vitejs/plugin-react`, `react@18`, `react-dom@18`,
  `vitest`, `jsdom`, `@testing-library/react` as deps.
- `vite.config.js` outputs to `public/v3-app/` so the existing
  `public/v3.html` legacy build keeps working until the cutover.
  Vercel already serves `public/`, so the Vite bundle is reachable
  at `/v3-app/` immediately.
- `src/v3-app/` holds the new module tree (kept disjoint from
  `src/v3/` so the legacy concatenator does not pick up ESM):
  - `lib/helpers.js`: `useFetch`, `ageLabel`, `fmtINRShort`,
    `stageOf`, `sevOf` lifted from globals to ESM exports.
  - `lib/primitives.jsx`: `Btn`, `Card`, `Banner`, `Chip`, `KPI`,
    `KPIRow`, `WSTitle`, `WSTabs`, `KV`, `Stream`, etc.
  - `lib/icons.jsx`: `Icon` namespace + `I` wrapper.
  - `lib/rbac.js`, `lib/preferences.js`: ESM ports of the legacy
    files. Keep the same `localStorage` keys + custom events so
    legacy code still sees the same state.
  - `lib/api.js`: ESM facade over `src/client/obara-client.js`.
    Side-effect import runs the legacy IIFE; the wrapper exports
    `ObaraBackend` + `storage`. No client refactor needed.
  - `index.html`, `index.jsx`, `app.jsx`, `routes.js`: lazy router
    via `React.lazy` + `Suspense`.
- Two proof screens converted: `screens/home.jsx`,
  `screens/orders.jsx`. Each is a `default export` with explicit
  `import` statements; no globals.
- Vitest scaffold: `lib/helpers.test.js` (13 tests, all passing).
  `npm run test` switched from the placeholder to `vitest run`;
  `npm run test:watch` for HMR-style test cycles.
- New scripts: `build:v3-vite` (production build),
  `dev:v3-vite` (Vite dev server with HMR on port 5180).
  `npm run build` now runs all three (legacy unified, legacy v3,
  Vite v3-app), so existing CI keeps both alive.

Bundle breakdown after Sub-PR 1:

```
public/v3-app/index.html                     0.6 kB │ gzip:  0.3 kB
public/v3-app/assets/index-*.css            23.7 kB │ gzip:  5.2 kB
public/v3-app/assets/home-*.js               3.4 kB │ gzip:  1.4 kB
public/v3-app/assets/orders-*.js             3.4 kB │ gzip:  1.5 kB
public/v3-app/assets/icons-*.js             22.4 kB │ gzip:  6.2 kB
public/v3-app/assets/index-*.js            146.8 kB │ gzip: 47.8 kB
```

Initial paint: ~50 kB gzipped. Legacy `public/v3.html` is still
1224 kB on disk. Cutover (Sub-PR 4) deletes the legacy file.

### Sub-PR 2: per-route code split + lazy load

- App router uses `React.lazy(() => import("./screens/orders/SOList"))`
  per route.
- Heavy parsers (XLSX, JSZip, Cytoscape) move into the routes that
  need them; the lazy boundary defers the parser download until the
  user clicks "Import" or "Open graph".
- First-paint bundle target: < 250 KB gzipped.

### Sub-PR 3: real tests

- Vitest snapshot tests for every wired screen against canned API
  responses (mock `ObaraBackend.*`).
- Playwright smoke that walks every route and asserts no console
  errors.
- Drop the static contract test once vitest covers the same ground.

### Sub-PR 4: cutover

- Vercel build now runs `vite build` instead of `node build-v3.mjs`.
- `public/v3.html` is replaced by the Vite-emitted `index.html` plus
  hashed JS chunks under `public/assets/`.
- Old `build-v3.mjs` and the giant `screens-wired/` concatenation
  disappear.
- Legacy `public/index.html` stays as-is (it's a different app).

## Why we haven't done it yet

We picked feature work over architecture in this session because:

1. The user's primary concern was UX completeness (the migration audit
   identified 33 gaps; closing those needed JSX, not bundler).
2. The build pipeline, while crude, *works* and is testable
   (`npm run check && build && verify` all green).
3. A bundler migration is a 1-day focused task that will block all
   feature work while it's in flight.

The right time to do it is **after Phase 7.8** is wrapped up. Once
every screen has full CRUD, the bundler migration is a mechanical
file-by-file refactor with no functional changes. We can verify the
new build matches the old one screen-by-screen with screenshots.

## Metrics that actually matter

Going forward, ignore `public/v3.html` size. Track instead:

- **Routes wired**: 30 of 30 nav routes + 6 sub-routes.
- **Wired screens**: 39 (20 wave A-F + 4 Phase 7 large + 3 CRUD overlays
  + 7 helpers + 5 misc). Each backed by real ObaraBackend.* calls.
- **Static analysis**: contract test passes — every nav id resolves to
  a window-defined component.
- **CI pipeline time**: < 30 seconds end to end (npm ci + check + build
  + verify).
- **First-paint time** (after Vite migration): target < 1s on a
  warm cache.
- **Bundle size after gzip + per-route split** (after Vite migration):
  initial < 250 KB, full app < 1.5 MB.

## Tracking

This document plus the Vite migration is logged as Phase 8 in
`docs/ROADMAP.md`. Sub-PRs land independently so feature work is never
blocked.
