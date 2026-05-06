# Anvil design system

> **Source of truth.** This document maps every design primitive to
> its file. New code should reach for these before inventing a
> one-off. Before adding a new primitive, check the existing list and
> consider extending it.

The design system has three layers:

1. **Tokens** (`src/v3-app/styles.css`): CSS custom properties for
   palette, type, spacing, hairlines, shadows, density.
2. **Primitives** (`src/v3-app/lib/primitives.tsx`): React components
   that wrap the tokens. The full inventory is at the end of this
   doc.
3. **Page patterns** (`src/v3-app/screens/*.tsx`): screens compose
   primitives into recognisable layouts. The recurring patterns are
   listed below.

---

## Tokens

### Palette

Defined in `:root` and re-asserted on `.lp` for the marketing
landing's locally-overridden tokens:

| Token | Value | Use |
|---|---|---|
| `--paper`     | `#FBFBF8` | Default page background. |
| `--paper-2`   | `#F4F4F0` | Card background. |
| `--paper-3`   | `#ECECE6` | Selected / hovered surface. |
| `--ink`       | `#15171A` | Primary text. |
| `--ink-2`     | `#2D3035` | Secondary text. |
| `--ink-3`     | `#5C6068` | Tertiary text / mono. |
| `--ink-4`     | `#8A8E96` | Muted / disabled. |
| `--accent`    | `#C8FF2B` | Live, primary CTA, brand spark. |
| `--accent-2`  | `#6BBA00` | Hover state of `--accent`. |
| `--rust`      | `#A23A1F` | Bad / error / over-budget. |
| `--amber`     | `#B57810` | Warn / pending. |
| `--lapis`     | `#1F4FA0` | Info. |
| `--sage`      | `#355E3B` | Good / approved. |
| `--hairline`  | `#D8D8D0` | Default border. |
| `--hairline-2`| `#E5E5DD` | Subtle separator. |

### Type

| Family | Source | Use |
|---|---|---|
| `--sans`  | IBM Plex Sans     | Default UI. |
| `--mono`  | IBM Plex Mono     | Codes, refs, KV labels, audit timestamps. |
| `--serif` | Source Serif Pro (italic) | Kinetic emphasis on the marketing pages, occasional inline emphasis. |

### Spacing

`--s-1` through `--s-6` scale linearly. `--r-1` through `--r-3` are
border-radius tokens. Density (compact / normal / comfortable)
scales padding via `[data-density]` selectors on the `.app` root.

---

## Primitives (`src/v3-app/lib/primitives.tsx`)

Reach for these first. Every screen in `src/v3-app/screens/` is
built on this list. New primitives go here, not into ad-hoc
component files.

| Primitive | Purpose |
|---|---|
| `Btn`     | All buttons. Variants: `primary`, `ghost`, `danger`, `icon`. Sizes: `sm`, default, `lg`. |
| `Card`    | Default container. `flush` removes padding for tables that use the full card width. `eyebrow` = small label above the title. |
| `Chip`    | Status tags. Tones: `good`, `warn`, `bad`, `info`, `live`, `ghost`. Use the same tone vocabulary across every screen so the operator's eye learns it. |
| `Dot`     | 6 px tone indicator. Same tone vocabulary as `Chip`. |
| `Sev`     | Severity badge for anomaly + delays. `high` / `medium` / `low`. |
| `KPI`     | Single metric card. `lbl`, `v`, `d` (description), `dKind`, `live`. |
| `KPIRow`  | Layout wrapper for KPIs. `cols={N}` where N is 2 to 6. |
| `WSTitle` | Workspace title strip. `eyebrow`, `title`, `meta`, `right` (CTA slot). |
| `WSTabs`  | Tab strip. `tabs`, `active`, `onChange`. |
| `Banner`  | Full-width notice. `kind` (`good`, `warn`, `bad`, `info`), `title`, `icon`, `action`. |
| `Steps`   | Linear progress (Capture, Preflight, Extract, Validate, Approve, Push). `current`, `items`. |
| `KV`      | Key-value rows with mono labels. `rows` = 2-tuples. |
| `RailPanel` | Right-rail container. Sticky on screens that opt into it. |
| `Stream`  | Live-event timeline. Used in audit, ThreadDrawer. |

### Animation hooks (`src/v3-app/lib/brand-anim.ts`)

| Hook | Purpose |
|---|---|
| `useReveal` | IntersectionObserver-backed fade-in. Used on landing sections. |
| `useCountUp` | Animated counter for KPIs. Honours `prefers-reduced-motion`. |
| `useScrollSpy` | Active section detection on long pages. |
| `useTicker` | Periodic re-render for live timestamps. |

---

## Page patterns

### Workspace page (most operator screens)

```
WSTitle  (eyebrow + title + meta + right CTAs)
WSTabs   (optional)
.ws-content
  Banner (loading / error / advisory)
  KPIRow (2 to 6 cells)
  Card flush (table)
  Card (form / detail)
```

Examples: `orders.tsx`, `source-pos.tsx`, `delays.tsx`, `audit.tsx`,
`customers.tsx`, `projects.tsx`.

### Inline create form (the "New X" pattern)

Every list screen with an `Icon.plus` button toggles inline create
state on click. The form lives as a `Card` above the list KPIs and
posts to the existing `/api/X` endpoint. This is the canonical
fix for the dead-button bug in PR #21 and PR #22.

Reference implementations:
- `leads.tsx` (the original, simplest)
- `source-pos.tsx` (with parent-order dropdown)
- `opps.tsx`, `projects.tsx`, `car.tsx` (PR #22)
- `so-intake.tsx` (the inline customer dialog)

### Phase timeline (lifecycle screens)

Used on screens that walk an entity through a numbered lifecycle
(projects, source POs, internal SOs). Renders dots + a connecting
line, with the active dot tinted by `--accent`.

CSS class: `.lp-flow-stage` for the marketing version,
`.phase-timeline` for the operator workspace version.

### Right-rail audit / activity panel

Workspace screens that focus on a single entity get a right rail
showing the most recent audit_events for that entity, mirrored from
ThreadDrawer's logic. The entity id comes from `?id=` in the hash.

---

## What NOT to build

- **One-off button styles.** Always extend `Btn` instead.
- **Custom toast implementations.** Use `window.notifySuccess` /
  `notifyWarn` / `notifyError` / `notifyLive`, all globals injected
  by `lib/toasts.tsx`.
- **Direct fetches from screens.** Always go through
  `ObaraBackend.X.Y(...)` so tests can stub the backend.
- **`.catch()` on Supabase query builders.** They are PromiseLike,
  not real Promises. Use `safeAwait` / `safeFire` from
  `src/api/_lib/safe-thenable.js`.
- **Floating UI obscuring page content.** Anchor popovers to a
  visible trigger (see the `SettingsMenu` pattern in `Shell.tsx`).
- **Hash params no resolver branches on.** Either branch in
  `routes.ts` `RESOLVERS` or read the param in the screen via
  `URLSearchParams(window.location.hash.split("?")[1])`. The audit
  scanner at `scripts/audit/route-deadlinks.mjs` flags new
  offenders.

---

## CI gates

Three regression scanners run on every deploy via `npm run
audit:systemic`:

| Scanner | Hard gate | What it catches |
|---|---|---|
| `promiselike-catch.mjs` | yes | Supabase `.catch` chains (the bug behind PR #20) |
| `route-deadlinks.mjs`   | no  | Hash params no resolver/screen reads |
| `column-drift.mjs`      | no  | Frontend reads of unknown columns |

Adding new patterns: drop a `<id>.mjs` script under
`scripts/audit/` that exits 1 on findings, then add an entry to
`AUDITS` in `run-all.mjs`. Set `gate: true` once existing offenders
are cleaned.
