# Anvil design system

Audit Phase 13, Stage D. The reference doc for the v3 design
system: tokens, primitives, and section patterns. Read this before
adding a new screen or extending a primitive.

## Where things live

| What | Path |
|------|------|
| Design tokens (CSS custom properties, ~124 vars) | `src/v3-app/styles.css` |
| Primitive components | `src/v3-app/lib/primitives.tsx` |
| Icon set | `src/v3-app/lib/icons.tsx` |
| Helpers (date / format / fetch) | `src/v3-app/lib/helpers.ts`, `lib/fetch.ts` |
| Brand animations (kinetic verbs, scrollspy, counters) | `src/v3-app/lib/brand-anim.ts` |
| Routing | `src/v3-app/routes.ts`, `src/v3-app/App.tsx` |
| Shell (header, sidebar, dock, cmdk) | `src/v3-app/components/Shell.tsx`, `CmdK.tsx`, `MobileShell.tsx` |
| Backend client | `src/client/anvil-client.js`, surfaced as `ObaraBackend` via `src/v3-app/lib/api.ts` |

## Design tokens

Defined as CSS custom properties on `:root` in
`src/v3-app/styles.css`. Use the var, never the hex. Themes (light
and dark) override the same names so a primitive that reads
`var(--paper)` switches automatically.

### Type

```css
--sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, sans-serif;
--mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
--serif: "IBM Plex Serif", Georgia, serif;
```

### Surfaces (paper stack)

```
--bg       desk background
--paper    primary surface (cards, modals)
--paper-2  raised cells (table rows, secondary surfaces)
--paper-3  deep wells (code blocks, inline pre)
--paper-4  selected rows
```

### Ink (text)

```
--ink      primary text, strong dividers
--ink-2    secondary text
--ink-3    tertiary, supporting copy
--ink-4    metadata
--ink-5    placeholders, disabled
```

### Hairlines

```
--hairline    1px primary
--hairline-2  1px subtle
--hairline-3  1px barely-there (zebra striping, internal grid)
```

### Semantic colours

| Token | Hex (light) | Use |
|-------|-------------|-----|
| `--accent`  | `#C8FF2B` | live / active fill (chartreuse spark) |
| `--accent-2` | `#6BBA00` | live stroke + small text |
| `--accent-3` | `#F1FFC2` | live wash background |
| `--sage`    | `#355E3B` | good / positive |
| `--amber`   | `#B57810` | warn / caution |
| `--rust`    | `#A23A1F` | bad / blocked |
| `--plum`    | `#5B2C5F` | info / advisory |

Each colour has `-2` (darker) and `-3` (washed background) variants.

### Spacing + radius

`--gutter`, `--gutter-2`, `--gutter-3` (8/16/24 px). `--radius`,
`--radius-2` for control corners.

### Z-index

```
--z-rail      sidebar
--z-overlay   modal backdrop
--z-modal     modal content
--z-toast     notification stack
--z-cmdk      command palette
```

## Primitives

Every widget that appears on more than one screen lives in
`src/v3-app/lib/primitives.tsx`. Adding a one-off widget? Inline it
in the screen. Adding the same widget to a second screen? Promote
it here.

### Buttons + chips

`Btn` accepts `kind: 'live' | 'info' | 'warn' | 'bad' | 'good' |
'ghost' | 'plum'`, plus `sm`, `lg`, `icon`, `full`, `disabled`.
Icon-only buttons MUST set `title` so the accessible-name
fallback fires.

`Chip` is the small inline pill: `<Chip k="warn">queued</Chip>`.
Same kind values as `Btn`.

`Dot` is a colour-only glyph. Set `label` for any chip whose
meaning is communicated solely by colour, otherwise it fails
WCAG 1.4.1.

`Sev` renders the severity ladder used in findings + alerts.

### Workflow header

`WSTitle` is the page-header pattern at the top of every screen:

```tsx
<WSTitle
  eyebrow="Sales · Leads"
  title="Leads"
  meta={`${total} total · ${newCount} new`}
  right={<Btn sm kind="primary">New lead</Btn>}
/>
```

`WSTabs` is the in-page tab bar used right under `WSTitle`. It
implements the WAI-ARIA Tabs pattern: arrow-key navigation, Home /
End, roving tabindex.

```tsx
<WSTabs
  tabs={[{ id: "open", label: "Open", count: 12 }, ...]}
  active={tab}
  onChange={setTab}
/>
```

### Cards + KPIs

`Card` is the container. `flush` removes inner padding so a table
or list can extend edge-to-edge.

`KPI` is the headline-number tile. `KPIRow` lays out 3-5 of them
in a grid. `dKind` gives the supporting line a tone (`up | down |
flat`).

```tsx
<KPIRow cols={5}>
  <KPI lbl="Cycle" v="8.4 min" d="median PO->voucher" />
  <KPI lbl="First-pass" v="92%" dKind="up" />
</KPIRow>
```

### Banners

`Banner` is the inline alert at the top of a card or content
region. `kind` drives the role: `bad` and `warn` get
`role="alert"` so screen readers announce them.

### Side panels + streams

`RailPanel` is the right-rail accent panel (used on workspace
screens).

`Stream` renders a tabular activity feed (timestamp, actor,
message).

### Forms + modals

`KV` renders a `[label, value]` definition list.

`Modal` (with `Modal.Header`, `Modal.Body`, `Modal.Footer`) is
the standard dialog. Backdrop closes on click; ESC closes; focus
traps.

### Helpers

```ts
fmtINR(1234567)   // "₹ 12,34,567"
fmtUSD(1234.56)   // "$ 1,234.56"
fmtPct(0.034)     // "3.4%"
```

## Section patterns

Patterns shipped on the marketing landing (`screens/landing.tsx`)
and re-usable on any operator screen with similar density.

### Hero

Two-column on `>= 1000px`: left holds the kinetic headline
(`useKineticPair` from `lib/brand-anim.ts`), CTA buttons, and
sub-copy. Right holds the auth widget on landing OR the animated
4-scene product moment OR a screenshot composite. Below the
hero on viewport widths under 1000px the right column stacks
under the left.

### Spec strip

Four cells across, each with a number + suffix + label. Animate
counters with `useCountUp` (in `brand-anim.ts`). Source every
figure: if no real source exists, swap to honest fallback wording
(`< 10 min pilot median`, `target ≤ 5% FPR`) rather than fabricate.

### Connector tab grid

Six tabs (ERPs / Channels / Doc engines / Finance + Tax / PLM +
Ops / AI + Security). Each tab opens a 4-column grid of tiles.
Tile count must match the actual integrated client list in
`src/api/_lib/*-client.js`. Verify before shipping.

### Pillars (3-column)

Capture / Catch / Ship blocks. Each pillar gets a one-line
intro + 3-5 bullets. Bullet copy must be sourced from the
codebase (not aspirational). Cross-check `src/api/anomalies/`,
`src/api/docai/`, `src/api/_lib/` to find real numbers.

### Flow (timestamped steps)

5 steps with timestamps + activity descriptions. Mark the block
"Sample run" so it reads as a scenario walkthrough, not a metric
claim. Replace operator initials and customer names with
generic `operator` / `customer` placeholders.

### Proof block

Audit trail NDJSON sample (real format, not fabricated content)
plus 3-4 outcome cards drawn from the existing `STORIES` quotes
already on the landing. Do NOT ship named-customer testimonials
without a consent record in the repo.

### Coverage block

Surface count grid. Every label must resolve to a real screen
file in `src/v3-app/screens/`. Confirm by `ls
src/v3-app/screens/ | grep -v test.tsx | wc -l`.

### Footer

4-column on desktop, collapses to 1 on mobile. Columns:
Product (links to `#/landing` sections), Trust (status, security,
privacy), Resources (changelog, docs, API reference, status),
Company. Every link points to a real route or `#`; no dead URLs.

## Things explicitly NOT to ship

These were flagged in the design plan and rejected by the audit
team:

- Fabricated stats (8.4 min, 94.2%, ₹4.20, 112 hrs, ₹4.2L,
  78% drop, 4,312 SKUs, 320 SOs/mo). Use grounded substitutes or
  honest fallbacks.
- Named-customer testimonials without a consent record.
  `STORIES` carries the anonymized wording the codebase already
  approved.
- Pricing tiers (₹39 / ₹19 per SO). Need commercial sign-off.
- Named-customer marquee logos. Use the connectors marquee
  instead.
- Fake regulatory dates (Q3 / Q4 2026 SOC 2 / ISO 27001
  commitments). Keep "in progress" wording.

## How to add a new screen

1. Write the screen at `src/v3-app/screens/<id>.tsx` with a
   default export.
2. Register the lazy import in `src/v3-app/routes.ts` `screens`
   map and add a resolver entry.
3. Add a sibling `<id>.test.tsx` smoke test (mirror
   `screens/agents.test.tsx` for the minimal pattern). The
   migration audit at `src/scripts/audit-migration.mjs` blocks CI
   without one.
4. Hit `npm run check && npm run verify && npm test`.

## How to add a new primitive

1. Add it to `src/v3-app/lib/primitives.tsx` with explicit
   `interface`-typed props.
2. Add a sibling `primitives.test.tsx` assertion (the existing
   file lists every primitive's smoke test).
3. Use the existing `Kind` union for any tone prop. Don't invent
   a new colour scale.
4. If the primitive depends on a CSS class, add the class to
   `styles.css` next to the related primitives' rules.

## How to extend a token

1. Add it to `src/v3-app/styles.css` `:root`. Pick a name that
   matches the existing prefix family (`--paper-N`, `--ink-N`,
   `--accent-N`).
2. Add a dark-theme override in the same file so the token
   resolves under both themes.
3. Update this doc's "Design tokens" section with the new var.

## Cross-references

- Audit Phase 13 plan: `/Users/kenith.philip/.claude/plans/keep-going-why-aren-t-linked-squid.md`
- Frontend test patterns: `src/v3-app/test-utils.tsx`
- The full audit trail: `docs/AUDIT_2026_05_07_product_audit.md`
- Per-endpoint reference: `docs/API_REFERENCE.md`
- Operator walkthroughs: `docs/USER_GUIDE.md`
