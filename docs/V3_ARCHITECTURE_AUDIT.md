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

### Sub-PR 1: scaffold Vite

- Add `vite`, `@vitejs/plugin-react`, `react`, `react-dom` as deps.
- Add `vite.config.js` with output to `public/v3-app/` so we don't
  break the existing `public/v3.html` until the cutover lands.
- Add a real `src/v3/index.jsx` entry that imports `./app` etc.
- Convert every `screens-wired/*.jsx` from "uses globals" to "uses
  ES imports". The `useFetch / ageLabel / fmtINRShort / stageOf /
  sevOf` helpers move from globals to a `src/v3/lib/helpers.js`
  module. Each wired screen `import`s what it needs.
- The window-export pattern (`window.X = WiredX`) gets replaced with
  default exports + a routes table that imports lazily via
  `React.lazy`.

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
