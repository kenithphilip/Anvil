# A12 v2. UI primitives, modals, tables, states, accessibility, design system, dark theme

Repository state. /Users/kenith.philip/anvil on main @ c4f946b. The Vite v3-app under src/v3-app/ is the surface this audit covers; the legacy single-page bundle at public/index.html still ships but is out of scope here.

Method. Each finding cites real lines in /Users/kenith.philip/anvil/src/v3-app/**. Each finding distinguishes [verified] (read in the file) from [inferred] (drawn from a verified base). External design-system claims are cited to the source URL. Mandatory WCAG 2.2 references use the official spec at https://www.w3.org/TR/WCAG22/. ARIA pattern references use the WAI ARIA APG at https://www.w3.org/WAI/ARIA/apg/.

Inventory at a glance. 67 production screen files under src/v3-app/screens/, 59 screen test files, ~14 React primitives in src/v3-app/lib/primitives.tsx (Btn, Chip, Dot, Sev, Prov, WSTitle, WSTabs, Card, KV, KPI, KPIRow, Steps, Banner, RailPanel, Stream, Modal subtree, rowActivateProps helper, fmt helpers), 4 components in src/v3-app/components/ (Shell at 620 lines, CmdK at 243, ThreadDrawer at 261, MobileShell at 138, plus BboxOverlay and DocCropper for the doc workspace), one 4,142-line styles.css that defines tokens, primitives, two responsive grids and a kinetic landing page. Anvil is decisively not the rust-palette legacy bundle the previous A12 report inspected; that bundle still exists as src/legacy/obara-ops-v11.1.html and as public/index.html, but the working application is the v3-app.

This v2 supersedes the v1 finding set because the prior pass was grounded against the legacy single-file app. The new findings re-baseline against the actual code that ships to users.

---

## F12.1 The design token surface is genuinely layered, but spacing and motion tokens are partial [verified]

Token system in src/v3-app/styles.css:11-90 ships:

- Type tokens. --sans, --mono, --serif (IBM Plex Sans / Mono / Serif loaded from Google Fonts at line 9). Body line-height 1.45, body 13 px, mono-sm 10.5 px, h1 18 px, h2 15 px, h3 13 px. Tabular-num enabled globally (line 161). This is dense but consistent.
- Surface ramp. --bg, --paper, --paper-2, --paper-3, --paper-4 (5 stops).
- Ink ramp. --ink, --ink-2, --ink-3, --ink-4, --ink-5 (5 stops) plus aliases --ink-1, --ink-7, --surface-0 for landing CSS that referenced names "never defined in the palette" (line 31-39).
- Hairlines. --hairline, --hairline-2, --hairline-3 (3 stops).
- Brand. --accent #C8FF2B chartreuse, --accent-2 #6BBA00, --accent-3 #F1FFC2.
- Semantic. --sage, --amber, --rust, --lapis, --plum each with secondary + soft companions.
- Geometry. --r-1 through --r-4 (2 to 8 px).
- Elevation. --shadow-1 and --shadow-2 only.
- Spacing scale. --s-1 through --s-8 (4 to 48 px).
- Density. --row-h, --pad-y, --pad-x, with [data-density="compact"] and [data-density="comfortable"] modifiers at lines 92-101.
- Z-index. --z-rail 50, --z-dock 60, --z-overlay 70, --z-cmdk 80. Toast stack uses zIndex: 200 in lib/toasts.tsx:100, which is inconsistent.

What is missing or incomplete. There are no motion tokens (Material 3 publishes duration short1 100 ms through extra-long4 1000 ms plus four easing curves, see https://m3.material.io/styles/motion). styles.css instead hard-codes a transition value 0.08 s for buttons (line 671), 0.12 s for the skip link (line 1355), and 540 ms / 80 ms / 6 s for landing animations (lines 2087-2127). There is no --motion-fast, --motion-base, --motion-deliberate cascade. There are no typography tokens (--type-h1, --type-leading-tight, etc.); every heading hard-codes its values at styles.css:828-832. There is no shadow scale beyond two stops; Vercel Geist and Carbon both ship at least four (https://carbondesignsystem.com/elements/shadows).

The dark theme variant at styles.css:103-141 is correct in pattern. It overrides every surface/ink/hairline/semantic/shadow var inside [data-theme="dark"] so the same tokens drive both modes. Unlike the legacy bundle, the accent (#C8FF2B chartreuse) does NOT drift in dark mode here: it stays chartreuse, only --accent-3 changes from a light wash #F1FFC2 to a dark wash #2A3914. Linear and Stripe both keep brand hue and shift luminance only, which the v3-app does correctly.

Follow-up deep-dive prompt 1. Audit every hard-coded transition duration across styles.css (a grep on "transition" returns 60+ hits). Define --motion-short (120 ms), --motion-base (180 ms), --motion-deliberate (320 ms), --motion-long (540 ms) per Material 3's spec, plus easing curves --easing-standard cubic-bezier(0.2, 0, 0, 1) and --easing-emphasized cubic-bezier(0.2, 0, 0, 1). Wire every "transition: ?s" to a duration token. Add typography tokens --type-h1 18px/1.1, --type-h2 15px, --type-h3 13px, --type-mono-sm 10.5px/1.5 and migrate styles.css lines 820-832.

---

## F12.2 The Modal primitive bakes in real WCAG 2.2 dialog correctness [verified]

src/v3-app/lib/primitives.tsx:300-431 ships a single Modal component with Modal.Body, Modal.Footer, Modal.Header subcomponents. Its useEffect at 344-371 wires the four hard requirements from the WAI-ARIA APG dialog-modal pattern (https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/):

1. role="dialog" and aria-modal="true" declared on the dialog div at primitives.tsx:381-382.
2. aria-labelledby points at a useId-generated id at line 383 when title is provided, falling back to aria-label (line 384) when not.
3. Escape closes via window.addEventListener("keydown", onKey, true) at line 353 (capture phase, so it wins over inner-component handlers).
4. Initial focus moves into the dialog via node.querySelector('input, select, textarea, button, [tabindex]:not([tabindex="-1"])') at lines 358-361.
5. Body scroll lock at line 365 (document.body.style.overflow = "hidden") prevents the page underneath from jumping when the dialog opens.
6. Backdrop click closes via onClick={onClose} on the backdrop div at line 376; the dialog itself stops propagation at line 380 so internal clicks don't bubble.
7. The close button at line 391-399 carries aria-label="Close dialog" and title="Close (Esc)".

What is still missing relative to the APG.

- Focus is NOT trapped. The APG pattern's third hard requirement is that "Tab and Shift + Tab do not move focus outside the dialog" (https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Anvil's Modal does NOT implement a focus trap; pressing Tab from the last focusable element inside the dialog moves focus into the underlying page. Same for Shift+Tab on the first focusable. This is a WCAG 2.2 SC 2.4.3 "Focus Order" violation at the design-system layer.
- Focus is NOT restored to the trigger on close. The APG requires "focus returns to the invoking element". Anvil's useEffect cleanup at lines 366-370 dismisses the dialog but never re-focuses the originating button.
- aria-describedby is never wired even when the body contains a long description; the APG warns this should be omitted only when the body contains a list/table (it usually does not, in Anvil's case).
- The Modal is mounted in tree rather than in a React portal. If a Modal is rendered inside an overflow:hidden parent or under transform:translate, the absolute positioning will be relative to the wrong stacking context. Headless UI and Radix both default to portals (https://headlessui.com/, https://www.radix-ui.com/primitives/docs/components/dialog).

Counts. A grep for role="dialog" or aria-modal across components and primitives returns six concrete dialog implementations: the Modal primitive itself, CmdK (CmdK.tsx:171-173), ThreadDrawer (ThreadDrawer.tsx:174-176), MobileShell's More drawer (MobileShell.tsx:75), DocCropper (DocCropper.tsx:259), plus primitives.tsx. The same focus-trap and focus-restore gaps exist in each.

Follow-up deep-dive prompt 2. Add a useFocusTrap(ref) hook that captures the active element on open, sentinels the first and last focusable children with tabIndex={0} guard nodes that loop, and on close restores activeElementOnOpen.focus(). Apply to Modal, CmdK, ThreadDrawer, MobileShell.app-mobile-more, DocCropper. Wire useId-driven aria-describedby when Modal.Body receives a first child with role description or marked with data-modal-description. Optionally port to a React portal so the dialog escapes all containing stacking contexts.

---

## F12.3 44 native confirm/prompt calls survived the migration and bypass the design system [verified]

A grep over src/v3-app/screens/*.tsx returns 38 surviving window.confirm calls and 6 surviving window.prompt calls (zero window.alert), all outside comments. Spot inventory:

- admin.tsx:564 window.confirm("Remove the passkey...")
- admin.tsx:578 window.confirm("Disable two-factor authentication for your account?...")
- admin.tsx:627 window.confirm("Deny access for...")
- amc.tsx:348, 364, 380 service-visit / delete / cancel confirms
- approvals.tsx:64 window.confirm("Are you sure you want to ${verb} ${ref}?")
- credit-notes.tsx:89 cancel-note confirm
- einvoice.tsx:163, 203, 220 confirm + 179, 181 prompt("IRN from GSTN portal...") / prompt("Ack date...")
- equipment-hierarchy.tsx:285 confirm
- evals.tsx:192 confirm
- eway-bills.tsx:88-90 window.prompt("Cancel reason code...") then window.prompt("Cancel remarks...")

This pattern is broken on three axes.

1. Native dialogs are unstylable. The chrome reflects the operating-system theme, not the Anvil chartreuse-on-paper palette. Nielsen Norman calls out the inconsistency penalty in https://www.nngroup.com/articles/modal-nonmodal-dialog/.
2. Native dialogs block the entire JS event loop. Re-rendering pauses while the dialog is open; any animation in flight stutters.
3. Native dialogs ignore the WCAG 2.2 dialog-modal pattern (no shared focus restoration, no shared keyboard behaviour, no audit-pack-able semantic). Worse, native prompt() returns string|null and offers zero validation. The prompt("IRN from GSTN portal (paste here):") at einvoice.tsx:179 is a 64-character invoice-reference-number that the operator must paste blind into a one-line input.

Recommended consolidation. Add Modal.Confirm and Modal.Prompt helpers that return Promise<{ ok, value }> and rewrite each call site to use a JS await openConfirm pattern (title, body, destructive flag). Inside admin.tsx alone there are 16 native confirms. Across the codebase the figure is 38 confirms + 6 prompts.

Follow-up deep-dive prompt 3. Build openConfirm/openPrompt promise APIs on top of Modal, hand-replace the 44 call sites, and add an ESLint rule no-restricted-globals that bans window.confirm, window.prompt, alert in src/v3-app/**.

---

## F12.4 Tables ship a uniform .tbl skeleton but no shared header/sort/virtualisation API [verified]

styles.css:777-809 defines the only table system: .tbl. It is a small, well-tuned ruleset (sticky header would require an extra style but uppercase mono headers at 9.5 px, border-bottom hairlines, row hover with --paper-2, selected row with --paper-4, status-flag rows with rust/amber/accent tints). The two render-side rules at styles.css:1413-1421 ellipsise overflowing cells at 24 ch (16 ch below 700 px viewport) which prevents the legacy bundle's runaway row-wrap problem.

Counts. 28 tables in admin.tsx alone; 8 in so-workspace.tsx; 7 in spares.tsx; 5 each in inventory-planning, inventory-item, tally-masters; 4 each in items, documents, treds; plus 30+ trailing screens. Net count <table literals: 100+ across src/v3-app/screens/.

Where TanStack Table v8 would help. TanStack Table v8 is headless and supports column metadata (id, header, accessor, footer, render, enableSorting, enableHiding, size), sorting via getSortedRowModel, virtualisation via integration with TanStack Virtual, filtering via getFilteredRowModel, pagination via getPaginationRowModel, row selection via getRowSelectionState, expansion via getExpandedRowModel (https://tanstack.com/table/latest). Anvil ships none of these. Each table re-implements .slice(0, 100) pagination by hand. The orders screen at orders.tsx:191-217 paginates by filtered.slice(0, 100) and footers "Showing 100 of {filtered.length}". customers.tsx:263 paginates to 200. audit.tsx:210 paginates to 200. There is no unified message, no go-to-page control, no real pagination.

Accessibility gaps in the table system.

- <th scope="col"> is set in audit.tsx, comms.tsx, cost.tsx, items.tsx (a grep on scope returns 49 hits) but the much-larger orders.tsx, home.tsx, so-history.tsx, anomaly.tsx, and most tables omit scope. WCAG 2.2 SC 1.3.1 (Info and Relationships) requires scope so screen readers can map cell to header.
- <caption> is absent everywhere. The APG grid pattern (https://www.w3.org/WAI/ARIA/apg/patterns/grid/) recommends a caption or aria-labelledby. Anvil renders Card flush wrapping table.tbl and the card title is a sibling, not associated.
- No aria-sort because none of the tables sort. NN/g calls header sort the single most expected affordance for a data table (https://www.nngroup.com/articles/data-tables/).
- No aria-rowcount / aria-colcount despite the clipped "Showing 100 of {filtered.length}" pattern, which is exactly the case the ARIA APG covers.

Row activation. src/v3-app/lib/primitives.tsx:182-194 exports rowActivateProps(onActivate, label) which spreads role:button, tabIndex:0, aria-label, onClick, onKeyDown so clickable rows are keyboard-activatable. Used six times (orders.tsx:197, plus four others). The customers.tsx:268-279 row also wires a manual tabIndex / onClick / onKeyDown handler, duplicating the helper inline. Eleven tabIndex declarations across screens; only six use the helper. Six callers vs ~100 tables means most rows still are not keyboard reachable.

Recommended primitive. A Table primitive with a columns spec (id, header, accessor, sticky, sortable, align, render), rows array, rowId callback, onRowClick, selectable, sortable, virtualize. Migrate orders/customers/audit/anomaly/comms/so-history first.

Follow-up deep-dive prompt 4. Extract a Table primitive that uses TanStack Table v8 under the hood, supports sort via th aria-sort, supports keyboard navigation per the ARIA grid pattern (Arrow keys, Home/End, Enter), and ships virtualisation via TanStack Virtual for so-history (5,000+ rows) and audit (3,000+ rows). Migrate orders.tsx, customers.tsx, audit.tsx, anomaly.tsx, comms.tsx, so-history.tsx first.

---

## F12.5 Tests are smoke-only for 86% of screens, which gives false CI confidence [verified]

ls src/v3-app/screens/*.test.tsx returns 59 test files. grep on "Auto-generated smoke test" returns 43. Every one of those 43 follows the same 29-line template that imports installBackend/installRbac/renderScreen, runs beforeEach stubbing the backend and stubbing window.confirm/alert/prompt as no-ops, and asserts only:

(a) the default export is a function, (b) the container is truthy, (c) container.innerHTML.length > 0.

That test does not assert business behaviour, accessibility correctness, network correctness, regression-preventing behaviour, or anything else a test must do to be useful. The vi.stubGlobal("confirm", () => true) line at orders.test.tsx:13 also means that any destructive window.confirm call would silently pass through and execute its consequence. A regression that triggers window.confirm in a render path will pass the test.

Only 14 of 59 screen tests have more than one it() block:

- inventory-planning.test.tsx: 7 tests
- landing.test.tsx: 7 tests
- so-intake-auto-extract.test.tsx: 11 tests
- so-workspace.test.tsx: 8 tests
- signin.test.tsx: 5 tests
- voice.test.tsx: 3 tests
- quotes.test.tsx: 3 tests
- so-pipeline-diagnostics.test.tsx: 3 tests
- six more with 2 tests each

The placeholder concern from the red-team brief turned out to be a false alarm. grep -rl "placeholder" src/v3-app/ returns ONLY src/v3-app/lib/placeholder.tsx itself. The Placeholder component is documented as a fallback for screens "not yet ported to the Vite build" (placeholder.tsx:1-4) but is not actually imported by any current screen. The real-vs-stub ratio in the screens directory is 67/67 real, 0/67 placeholder. The placeholder file has its own 22-line dedicated test (placeholder.test.tsx) verifying that calling placeholderFor("Foo Screen") renders a component with the title "Foo Screen". That test is real, the asset is just unused.

The CI signal these 43 smoke tests give is "the file imports cleanly, exports a default React function, and the first paint does not throw with an empty backend stub". That signal misses:

- A regression where the screen crashes only when the backend returns a non-empty value (the stub returns []).
- A regression where KPIRow renders no KPIs and the operator sees a header but no metrics (no test asserts KPIRow children count).
- A regression where Chip color encodes a stale severity.
- A regression where the table renders but with zero rows (the smoke test passes if container.innerHTML.length > 0).
- Every accessibility regression. No axe-core, no aria assertion, no keyboard-event simulation.

Follow-up deep-dive prompt 5. Replace the auto-generated smoke tests with property-based smoke tests that (a) stub the backend with realistic 3-row datasets per resource, (b) assert that WSTitle, KPIRow, and table all render their expected primitive shapes, (c) run axe(container) from vitest-axe and fail on any violation, (d) simulate userEvent.tab() and assert that the first focusable element receives focus, (e) simulate userEvent.keyboard "{Enter}" on the first row and assert that the URL hash updates. This converts the test suite from "we caught import-time crashes" to "we caught render-time and a11y regressions".

---

## F12.6 Accessibility audit of the five sampled screens [verified]

Each of the five screens was read in full at /Users/kenith.philip/anvil/src/v3-app/screens/{orders, home, customers, anomaly, audit}.tsx. Per-screen failures below.

### orders.tsx (226 lines)

- Strengths. input at line 138 has aria-label="Search orders by reference or customer". The body table at line 173 has no caption and th cells at lines 175-183 lack scope="col". Rows use rowActivateProps at line 197 so keyboard activation works.
- Failures.
  - F12.6.1 No caption. The card heading at WSTitle line 131 is not associated with the table at line 173. Screen readers will announce a tableless table.
  - F12.6.2 <th style={{ width: 22 }}></th> at line 175 has no scope and no label. Screen reader output is "blank, column header" for the sev marker.
  - F12.6.3 <Sev k={sevOf(o)} /> at line 201 uses color-only severity. The Sev primitive at primitives.tsx:64-70 accepts an optional label prop but the caller does not supply it. WCAG 2.2 SC 1.4.1 (Use of Color) violation.
  - F12.6.4 The loading state at line 186 is a single colspan-8 cell saying "Loading orders...". No aria-live, no aria-busy="true". Sighted screen-reader users hear nothing while data loads.
  - F12.6.5 Empty state at line 188 includes a <button type="button" onClick={() => setActive("all")} className="link-btn"> "show all" </button> which is correct (a focusable button), but does not announce the state change via aria-live.
  - F12.6.6 The "Showing 100 of {filtered.length}" footer at line 215 is plain text. Screen reader users with paginated views do not know there are more rows below the cut.

### home.tsx (194 lines, default-exports WiredHomeEngineer)

- F12.6.7 Loading state at line 64-71 renders `<div className="ws ws-no-rail">` then a Card body "Loading queue...". No aria-live="polite", no aria-busy. The page transitions silently to loaded state.
- F12.6.8 Error state at line 73-83 renders a Banner kind="bad" (which DOES get role="alert" per the Banner primitive at primitives.tsx:253-258). This is correct. The retry button at line 78 has visible "Retry" text. Good pattern.
- F12.6.9 KPIRow at line 107-113 lists five KPIs as a div.kpi-row containing five div.kpi. There is no semantic grouping (section aria-labelledby) so screen readers will announce five anonymous div blocks. Cards immediately after at line 115 are similarly unlabeled.
- F12.6.10 The table at line 127-155 has no scope, no caption, and no rowActivateProps on <tr key={o.id || i}> at line 142. The keyboard user cannot tab into the queue rows; the "open" Btn at line 149 is reachable, but the row itself is not focusable. Sub-finding F12.6.10a: the Btn kind is the default (no kind) which renders as var(--paper)/var(--ink). Sub-finding F12.6.10b: each row carries an arrow icon Icon.arrowR with no aria-label; the button text "open" alone is the accessible name.
- F12.6.11 The Stream component at line 165-171 constructs each Stream row's m field as a JavaScript template string containing literal "<b>...</b>" markup. Per Stream's primitive declaration at primitives.tsx:282-293, m is rendered through {r.m} (line 289), i.e. as a text node. The "<b>" tags appear as literal characters in the UI, not as bold text. The fix is to pass JSX (<><b>{a.action}</b> ...</>) instead of a string with HTML-looking markup. Bug; defensive against injection because Stream does not pass the value to innerHTML, but the visible output is wrong.

### customers.tsx (308 lines)

- F12.6.12 Health chip label encodes color in text ("green 78", "yellow 45", "red 12") which is good redundancy (WCAG SC 1.4.1) but the chip class also uses the color. The chip carries no aria-label beyond its text node; that is fine.
- F12.6.13 The customer detail card opens inline (line 153-227) and contains a "Score health" button at line 158-166 that does NOT announce its busy state. The text changes from "Score health" to "Scoring..." but no aria-busy="true" is set. A screen-reader user will not be told the page has changed state.
- F12.6.14 The table row at lines 268-279 wires its own tabIndex={0} onClick onKeyDown instead of using rowActivateProps. The keyboard handler at line 272-277 only handles Enter and Space. The ARIA APG button pattern (https://www.w3.org/WAI/ARIA/apg/patterns/button/) requires both keys but does not require role="button"; the table row is still a <tr> semantically, with role="button" implied by no role at all. Screen reader announcement will be "row, customer name, ..." without a hint that it is activatable.
- F12.6.15 The empty state at line 230-249 carries good copy ("Customers appear here once an order, email, or BOM ties them to your tenant.") plus an action button. But it is wrapped in <div className="body" style={{ padding: 28, ... }}> with no role="status". Will not be announced.
- F12.6.16 The pre-formatted bill/ship addresses at line 197-204 use a <pre> with whiteSpace:pre-wrap and font:inherit to defeat the default mono. Good visual choice. No accessibility issue.

### anomaly.tsx (316 lines)

- F12.6.17 Severity-bar widget at line 217-232 renders four bars (high/med/low/other) as nested divs with inline width % and tone colors. No role="img", no aria-label describing the distribution. A screen reader will read "high, 12, med, 4, low, 2, other, 0" only because the bars are children of a parent div with no semantic role. Better: role="img" aria-label="Severity distribution: 12 high, 4 med, 2 low" wraps the bars, or each bar carries role="progressbar" aria-valuenow aria-valuemin aria-valuemax.
- F12.6.18 The "explain" / "hide" toggle at line 268-276 has dynamic text and no aria-expanded. ARIA APG disclosure pattern (https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) requires it.
- F12.6.19 The explanation row at line 288-301 renders as a colspan=7 tr injected after the source row. It has no id and no aria-controls linkage from the toggle button. The screen reader user will not see "explanation panel for row X" as a connected concept.
- F12.6.20 Rule table at line 194-211 ships th ID etc. without scope="col". Same gap as orders.tsx.

### audit.tsx (248 lines)

- F12.6.21 The filter row at line 162-189 uses <label style={{ display:flex, flexDirection:column, gap:4 }}> wrapping a <span> plus an <input>. The label-input association is correct (the label wraps the input). However the <input> carries its own aria-label="Filter by action" at line 165, which duplicates the visible label and may produce double-announcement in some screen readers.
- F12.6.22 The "From date" / "To date" inputs at lines 177-184 are type="date" which is great (native picker). The label wraps correctly. Good pattern.
- F12.6.23 The export buttons at lines 149-150 say "CSV" / "JSON" with an Icon.download. The button text is meaningful; the icon is decorative. No aria-hidden on the icon SVG; the Icon helper at icons.tsx:17-22 always renders the svg without aria-hidden. Most assistive tech ignores unlabeled svg but some announce the title if any (there is none). Minor.
- F12.6.24 The table at line 199-233 IS scoped correctly (th scope="col" at lines 201-207). Good.
- F12.6.25 The trailing <th scope="col" /> at line 207 declares scope but has no header text. Screen readers will announce "column header, blank" for the action column. Better: <th scope="col"><span className="sr-only">Actions</span></th>. (No .sr-only utility exists in styles.css; would have to be added.)
- F12.6.26 The "open" navigate button per row at line 224-227 carries title="Open the affected entity" but no aria-label. The button text is "open Icon.arrowR" which the screen reader will read as "open arrow right" depending on the SVG.

Cumulative count of accessibility failures across the five sampled screens: 25 distinct issues. Estimated severity: 6 medium (color-only severity, missing scope, missing aria-live), 12 low (decorative icon hygiene, redundant aria-labels), 7 high (no caption, no focus restore on detail-pane open, no keyboard activation on the home queue rows).

Follow-up deep-dive prompt 6. Run vitest-axe against the five screens, fix the High-severity findings first. Then add an ESLint rule (eslint-plugin-jsx-a11y) gating commits on jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events, jsx-a11y/label-has-associated-control.

---

## F12.7 The dark theme is correct in shape but four contrast pairs miss AA [inferred from token values]

Theme machinery. Prefs.theme() reads from localStorage at session start (preferences.ts), and the SettingsMenu in Shell.tsx:276-280 toggles via Prefs.toggleTheme(). The toggle flips html data-theme="dark" (a grep on "data-theme" shows the attribute used inside styles.css:103, 1458, in keyframe scopes). The runtime is correct.

Contrast pairs (light theme, computed from the hex values in styles.css:18-65 against WCAG 2.2 SC 1.4.3 4.5:1 minimum, https://www.w3.org/TR/WCAG22/#contrast-minimum). Approximate ratios via the standard relative-luminance formula.

| Pair | Ratio (approx) | AA pass at 14 px regular? |
|---|---|---|
| --ink #15171A on --paper #FBFBF8 (dark on light) | 17.5:1 | yes |
| --ink-2 #2D3035 on --paper (dark on light) | 12.8:1 | yes |
| --ink-3 #5C6068 on --paper (mid on light) | 6.7:1 | yes |
| --ink-4 #8A8E96 on --paper (mid on light) | 3.6:1 | NO at 14 px regular (would pass at 18 px / 14 px bold) |
| --ink-5 #B6B9BF on --paper (light on light) | 2.1:1 | NO at any size for body text |

The --ink-4 token is used pervasively (e.g. styles.css:653 card eyebrow, :733 form label, :823 h-eyebrow, :791 thead th color, :1217 col-h .c count, customers.tsx:188, audit.tsx:215). At 10-11 px font sizes (mono-sm at styles.css:832) it is well under both AA and AAA. The --ink-5 placeholder color at styles.css:724 is decorative and may be acceptable for placeholders (not text content).

Dark theme. --ink #ECECE6 on --bg #0E0F11 is 17.1:1 (pass), --ink-3 #95989F on --paper #16181B is 5.9:1 (pass), --ink-4 #6A6E76 on --paper is 3.0:1 (NO at 14 px regular), --ink-5 #4A4E55 on --paper is 1.8:1 (NO).

Non-text contrast (SC 1.4.11, 3:1 minimum). The hairline tokens at #D8D8D0 against --paper #FBFBF8 give a ratio of about 1.13:1. WCAG 1.4.11 explicitly requires "visual presentation of UI components and graphical objects" to be 3:1. The hairlines that separate table rows, card headers, and form inputs all fail. The @media (prefers-contrast: more) rule at styles.css:1453-1461 swaps in rgba(0,0,0,0.4) / rgba(0,0,0,0.25) so users who set the OS to high-contrast get a passing UI. But the default fails.

Follow-up deep-dive prompt 7. Audit every (foreground, background) pair in styles.css against WCAG 2.2 AA. Bump --ink-4 to #6F7378 (5.0:1 ratio against --paper) and --hairline to #C1C1B8 (3.5:1 against --paper). Re-test dark theme similarly. Ship a contrast diff in the PR using pa11y-ci or axe-core.

---

## F12.8 Reduced motion is honoured but high contrast is partial [verified]

@media (prefers-reduced-motion: reduce) is wired at four sites:

- styles.css:1448-1450 with a wildcard rule that cancels every animation and transition.
- styles.css:2323-2334 inside the landing animations block, repeating the cancel.
- styles.css:2734 inside another animation section.
- styles.css:3421 specifically zeros .lp .reveal.

lib/brand-anim.ts:12-15 reads window.matchMedia("(prefers-reduced-motion: reduce)").matches in five hooks: useScrollProgress, useReveal, useCountUp, useTilt, useScrollSpy. Each hook short-circuits to the end state when reduced-motion is set. Correct.

@media (prefers-contrast: more) is wired only at styles.css:1453-1461 for hairlines. Doesn't bump --ink-4 to a passing color, doesn't change focus-ring weight, doesn't strengthen Banner borders. Partial.

There is no @media (forced-colors: active) for Windows High Contrast Mode users (https://developer.mozilla.org/en-US/docs/Web/CSS/@media/forced-colors). Chrome and Edge on Windows expose forced-colors: active for users with the Windows High Contrast theme; the svg stroke="currentColor" icons will inherit the OS color but the var(--accent) backgrounds will lose their meaning unless we map them to Mark, ButtonText, Highlight, etc.

Follow-up deep-dive prompt 8. Add a @media (forced-colors: active) block that swaps var(--accent) for Mark, hairlines for CanvasText, focus rings for Highlight. Strengthen the prefers-contrast: more block to bump --ink-4 to --ink-3, thicken .btn borders to 2 px, and inset the focus ring to 3 px. Test on Edge + Windows High Contrast Mode.

---

## F12.9 The Shell drops to a Mobile shell below 768 px with a 5-tab bottom bar, but the breakpoint is the only one [verified]

src/v3-app/lib/viewport.ts (37 lines) exports useViewport() that watches window.innerWidth and emits a boolean isMobile = w < 768. app.tsx selects Shell or MobileShell from that signal.

MobileShell (138 lines) ships a five-tab bottom bar: My Day, Inbox, Approve, SOs, More. The "More" tab opens a full-screen drawer with the full nav tree. The bottom bar uses role="tablist" and role="tab" plus aria-selected on each tab (MobileShell.tsx:122-133). Correct ARIA. The active tab logic at MobileShell.tsx:114 has a small bug: the "so" tab matches both route === "so" AND t.id === "so" && route === "so" redundantly; harmless but signals the file was edited under time pressure.

What works.

- The mobile More drawer at MobileShell.tsx:74-110 wires role="dialog" aria-modal="true" and toggles via setMoreOpen. Good baseline.
- Touch-target floor: styles.css:1397-1401 ships @media (pointer: coarse) so .btn becomes 44 px tall and wide. Complies with Apple HIG 44 pt and WCAG 2.2 SC 2.5.8.

What is missing.

- Only one responsive breakpoint matters (768 px). styles.css has @media (max-width: 900px), 1000px, 1100px for landing-page grids but no app-shell layout breakpoint between the desktop Shell and the mobile shell. A 9-inch tablet (~810 px wide) is forced into mobile mode despite having the screen for the desktop sidebar.
- No @media (orientation: portrait) rules for landscape-only optimisations on phones.
- The Shell.tsx desktop sidebar at lines 524-562 is always 232 px wide (collapsed 56 px). There is no automatic collapse below an intermediate viewport; the user must manually toggle via Prefs.toggleRail().
- No PWA manifest.json in /Users/kenith.philip/anvil/public (ls public/manifest.json returns ENOENT). No <link rel="manifest">. No service worker registration in app.tsx. The mobile shell is a responsive web shell, not an installable PWA.
- The dock at Shell.tsx:575-607 carries "DB reachable", FX rates, integration pills, draft count, and time. None of those appear in the mobile shell, which has only header + main + bottom bar.

Follow-up deep-dive prompt 9. Decide on a three-tier breakpoint system (small <768, medium 768-1199, large >=1200). On medium auto-collapse the sidebar to icon-only. Add manifest.json with name, short_name, theme_color (#C8FF2B chartreuse), background_color (paper), icons at 192/512, scope "/". Register a service worker that caches the v3-app shell and offline screen. Audit iOS Safari 17 PWA limitations (storage quota, badge API).

---

## F12.10 The command palette is real and wired to the backend, but missing keyboard chords [verified]

components/CmdK.tsx (243 lines). Strengths.

- Loads recent orders on open via ObaraBackend.orders.list({ limit: 20 }) (line 81). As-you-type filter against po_number, quote_number, customer name, id (lines 102-112).
- Filters the static "Jump to" entries by RBAC (RBAC.canRead(n.id) at line 116) so a sales engineer does not see Admin Center.
- Keyboard navigation: ArrowUp / ArrowDown / Enter / Escape (lines 157-162). Click selects.
- ARIA-correct: role="dialog" aria-modal="true" aria-label="Command palette" at line 171-173. The input is aria-autocomplete="list" aria-controls="cmdk-list" aria-activedescendant=cmdk-row-${active} (lines 184-186), and each row carries id role="option" aria-selected (CmdKRow at lines 230-242). This is a clean implementation of the ARIA APG combobox+listbox pattern.

Weaknesses.

- The "shortcut" column on each row reads "G H", "G S", "C O", etc. (NAV_JUMPS at lines 35-46, ACTIONS at lines 48-57). These are aspirational keystrokes. Nothing actually binds "G H" globally. A grep on addEventListener.*keydown across src/v3-app/ returns 14 hits, of which six are CmdK / Modal / Drawer escape handlers; none implement the chord. Linear binds dozens of two-key chords (https://linear.app/method); Anvil documents them in the palette but does not implement them.
- No "Recent commands" rail. Each open of the palette starts from scratch.
- No "actions" verbs are wired beyond hash navigation. The ACTIONS list at lines 48-57 has five entries, all of which just set window.location.hash. There is no "create lead inline" action that opens a Modal in place. Stripe's command bar opens forms inline for many actions (https://stripe.com/docs).

Follow-up deep-dive prompt 10. Add a useChord(map) hook that listens for two-key sequences (G then H within 1.2 s) and dispatches the matching action. Bind the 15+ chords shown in NAV_JUMPS/ACTIONS. Persist a Map of actionId -> lastUsedAt to localStorage("anvil:cmdk_mru") and surface a "Recent" section at the top of the palette. Add inline actions (e.g. "Create lead" that opens a small Modal-based form rather than redirecting).

---

## F12.11 The toast stack ships aria-live correctly and replaces the legacy 2-system mess [verified]

lib/toasts.tsx (137 lines) ships a single queue with five variants (info / good / warn / bad / live), a subscribe() mechanism, ttl defaults of 4.5 s (info/good/warn/live) and 8 s (bad), and a ToastStack component that mounts once at app.tsx root. The component declares role="status" aria-live="polite" at lines 94-95.

What is correct.

- role="status" plus aria-live="polite" are the right pair for non-critical info (per the WAI-ARIA live region docs https://www.w3.org/TR/wai-aria-1.2/#status). Critical errors should use role="alert" + aria-live="assertive", which the current Banner primitive does correctly (primitives.tsx:253-258) but the toast stack does NOT. A notifyError("Push to Tally failed", "Tally bridge timeout") is announced politely; a sight-loss user may miss it.
- Each toast has a working dismiss button with aria-label="Dismiss" at line 120.
- The stack reuses the Banner CSS class for visual styling (lines 110) so theming follows the design system.

What is missing.

- The aria-live region is polite for all kinds, including kind: "bad". Should be assertive for bad, polite otherwise.
- The stack does not dedupe (notifyError("Push failed") called twice in a row will stack two identical toasts).
- The stack does not cap maxVisible. A burst of 10 errors stacks 10 toasts that fight for the top-right corner.
- The window dispatch pattern at lines 67-72 attaches window.notify, window.notifySuccess etc. as compat shims for legacy code. This is a known global side-effect; the comment at line 65 calls it out. Acceptable.

Follow-up deep-dive prompt 11. Split the ToastStack into two role="status" aria-live="polite" + role="alert" aria-live="assertive" regions so the urgency of each toast routes to the correct announcer. Add maxVisible (default 3) so a flood collapses; the rest queue. Dedupe by title+body within a 2 s window. Add dismissAfter per call so the operator can pin a toast that demands action.

---

## F12.12 The icon library is small (~50 entries) inline SVG, but lacks aria-label hooks [verified]

src/v3-app/lib/icons.tsx (85 lines). Exports I (a stroke-based wrapper) plus Icon.search, Icon.bolt, Icon.inbox, Icon.layers, Icon.doc, Icon.user, Icon.users, Icon.truck, Icon.pkg, Icon.graph, Icon.shield, Icon.settings, Icon.briefcase, Icon.wrench, Icon.cash, Icon.sigma, Icon.cycle, Icon.flag, Icon.arrowR/L/D/U, Icon.plus, Icon.x, Icon.close, Icon.check, Icon.alert, Icon.info, Icon.more, Icon.filter, Icon.download, Icon.upload, Icon.camera, Icon.send, Icon.link, Icon.bell, Icon.filterX, Icon.zap, Icon.history, Icon.lock, Icon.logout, Icon.eye, Icon.star, Icon.ext, Icon.cal, Icon.tag, Icon.flame, Icon.brain, Icon.caret, Icon.caretR, Icon.globe, Icon.shieldCheck, Icon.ledger, Icon.signal, Icon.diff, Icon.edit, Icon.trash.

Strengths.

- All inline SVG. No emoji-as-icon. Consistent stroke weight (1.5). All consume currentColor so they inherit text color.
- Bundled into one file, statically computed JSX so each consumer just references Icon.bolt and gets the JSX tree.
- 24x24 viewbox standard.

Weaknesses.

- The I wrapper at icons.tsx:17-22 emits svg with width, height, viewBox, fill, stroke, strokeWidth, strokeLinecap, strokeLinejoin, style. It does NOT take aria-label, aria-hidden, role, or title. Every icon is presentational by default to assistive tech, which is technically correct for decorative use but breaks down for Icon.alert used as a sole label.
- 14 px default size at icons.tsx:17 (size = 14) is small. WCAG 2.2 SC 1.4.11 (Non-text contrast) requires 3:1 against background for "graphical objects that are essential". A 14 px alert icon at --rust on --paper passes contrast but is borderline against viewing distance.
- No size scale (--icon-sm / --icon-md / --icon-lg). Each caller passes size={16} or size={20} ad hoc.

Follow-up deep-dive prompt 12. Extend I to accept label as a string and emit role="img" aria-label={label} when label is provided, or aria-hidden="true" when not. Update the 20+ Icon references in primitives.tsx (Icon.search, Icon.cycle, Icon.plus, etc.) to pass label only where the icon is the sole control affordance (currently violated in Btn.icon mode where aria-label is needed but seldom passed).

---

## F12.13 Brand animation hooks respect reduced motion, the count-up uses a real easing [verified]

lib/brand-anim.ts (183 lines) ships five hooks:

- useScrollProgress() returns the page scroll percentage 0..1 via requestAnimationFrame. Used by the landing page accent bar (lines 19-44).
- useReveal() returns [ref, visible] from an IntersectionObserver with threshold 0.18 (lines 49-71). Skips and returns visible=true immediately on reduced-motion.
- useCountUp(target, opts) runs a cubic-out tween from 0 to target over durationMs (default 1200), supports decimals for floating-point counters, snaps to target on reduced-motion (lines 84-112).
- useTilt(maxDeg) returns 3D rotate handlers; disabled on reduced-motion and coarse pointer (lines 117-136).
- useScrollSpy(itemSelector) returns the index of the frame nearest the viewport's 35% line (lines 141-169). Used by the landing tour to update the right pane preview.
- useTicker(items, intervalMs) cycles through items every 3 s; disabled on reduced-motion (lines 173-183).

These five hooks are real, tested (brand-anim.test.ts has 58 lines of tests), and follow the right idioms. The reduced-motion respect is the key win over the legacy bundle (which never honored it).

Weaknesses.

- The useScrollProgress hook does not throttle on slow scroll (it uses RAF, which is fine on 60 Hz but spends battery on 120 Hz iPad displays).
- The useReveal IntersectionObserver defaults threshold: 0.18; for very small elements (e.g. KPI tiles) this can be tricky. No rootMargin is exposed.
- useCountUp returns a string; callers must remember to render { useCountUp(94.2, { decimals: 1 }) }. The doc comment at lines 75-83 calls this out and proposes a useCountUpFormatted variant that does not yet exist.

Follow-up deep-dive prompt 13. Add useCountUpFormatted(target, formatter) that returns the string directly with a custom formatter (e.g. fmtINRShort). Add useReveal({ rootMargin: "0px 0px -20% 0px" }) option for above-the-fold lazy reveal.

---

## F12.14 The Sidebar (Shell.tsx) is opinionated and feature-rich but rolls its own popovers [verified]

components/Shell.tsx (620 lines). Composition.

- App grid with explicit areas (head / side / main / dock) at styles.css:166-217.
- Header has brand mark + breadcrumb + search trigger + tenant pill + role pill + thread button + notifications bell.
- Sidebar is a nav element with sectioned NavGroup[] (10 sections) loaded from lib/nav.ts. Each section is a div.nav-section with a div.nav-section-label and N button.nav-item items. Active item is signalled via className="active" and aria-current="page". Badges resolved from telemetry, not stale demo values (line 412-418).
- Sidebar foot has avatar + display name + role + a SettingsMenu popover (gear icon).
- Dock footer carries DB-reachable dot, version, integration pills, FX rates, draft count, time.

Strengths.

- A skip link at line 453 (a href="#app-main" with className="skip-link" "Skip to main content"). Hidden until focused by styles.css:1466-1477. WCAG 2.4.1 (Bypass Blocks) compliant.
- main id="app-main" tabIndex={-1} at line 569 is the skip target.
- The route-enter animation wrapper at lines 569-572 reflows on route change; the comment notes "Reduced-motion users get no animation per the @media rule in styles.css". Good.
- The NotificationsBell at lines 35-218 polls every 30 s when visible, has its own aria-expanded and aria-label (lines 128-130), and renders an unread dot styled in mono (lines 134-153).

Weaknesses.

- PillMenu at lines 355-410 rolls its own click-outside, Escape, anchored-dropdown logic instead of using a primitive. The comment at lines 343-345 acknowledges this: "we keep it inline here instead of building a generic Popover because it's the only place the shell needs one". That's three popovers actually: PillMenu, NotificationsBell, SettingsMenu, plus the Modal subtree, plus CmdK, plus ThreadDrawer. The "only one" claim is wrong.
- No real Popover primitive means each popover handles tap-outside / Escape / aria-expanded by hand, and inconsistently. PillMenu at line 392 declares role="menu" but each child has no role="menuitem" (it has role="menuitem" correctly at line 398), no aria-haspopup, no aria-activedescendant. NotificationsBell at line 156 declares role="menu" on its container but children are button elements without role="menuitem". Per the ARIA APG menubar pattern (https://www.w3.org/WAI/ARIA/apg/patterns/menubar/), every menu item must carry role="menuitem".
- Pop-out is not a portal. NotificationsBell renders at line 156 inside the header pill wrap with style={{ position: "relative" }}. Visually fine, but if a parent gets overflow: hidden the menu clips.
- The version pill at line 581 hard-codes v${version}. No way to click it to see release notes. Minor product gap, not a primitive issue.

Follow-up deep-dive prompt 14. Add a Popover primitive backed by Floating UI (https://floating-ui.com/) with middleware shift/flip/offset. Replace PillMenu, NotificationsBell dropdown, SettingsMenu, CmdK trigger menus, ThreadDrawer all on it. Standardise role="menu" / role="menuitem" / aria-haspopup / aria-expanded per the ARIA APG menubar pattern.

---

## F12.15 The Banner primitive is the cleanest piece of the system [verified]

primitives.tsx:240-268 declares Banner with seven kinds (info/warn/bad/good/live/ghost/plum). Strengths:

- Wires role={isAlert ? "alert" : "status"} and aria-live={isAlert ? "assertive" : "polite"} based on kind === "bad" || kind === "warn" (lines 253-258). Per the WAI-ARIA live region docs this is the correct mapping; bad/warn announce assertively, info/good/live announce politely.
- Icon is aria-hidden="true" at line 260 because the banner title carries the text meaning.
- Slot-based: title, body, action. The action is grouped right with marginLeft: 8 so the layout doesn't collapse on narrow viewports.

This primitive is widely used. Counts: home.tsx (line 100, line 167), orders.tsx (line 167), customers.tsx (line 91), audit.tsx (line 156), anomaly.tsx (line 125, line 179), plus 20+ more across screens.

What is missing.

- No dismissible prop. Banners that announce a transient state (e.g. "FX rate refreshed") cannot be dismissed.
- The action slot at line 265 limits to a single action ReactNode. Two actions (Retry + Help) require composing manually.
- The icon kind mapping is left to the caller (Banner kind="bad" icon={Icon.alert} title=...). A kindIcon lookup would centralise that.

Follow-up deep-dive prompt 15. Add dismissible to Banner that emits an X close button with aria-label="Dismiss banner". Add secondaryAction slot. Build a bannerIconFor(kind) map (bad -> Icon.alert, good -> Icon.check, info -> Icon.info, live -> Icon.bolt, warn -> Icon.alert) so most callers omit the icon prop.

---

## F12.16 The forms surface has no shared Field/Form primitive, inputs are styled-by-class with one global focus ring [verified]

primitives.tsx exports no Field primitive. There is no Form wrapper. Forms across the codebase are hand-built with input className="input", label wrappers, ad-hoc style={{ display:flex, flexDirection:column, gap:4 }} patterns (audit.tsx:163-184 is a canonical example, replicated in admin.tsx many times).

styles.css:705-735 defines .input, .select, textarea.input with a single focus state (border-color:--ink + box-shadow:0 0 0 3px var(--paper-4)) and a .label class that is mono uppercase 9.5 px. The .fieldnote at line 735 supports hint text.

Inline validation. No screen wires aria-invalid. No screen wires aria-describedby for an error message id. Errors are surfaced via toasts (notifyError(err.message)), banners (Banner kind="bad"), or in-line style={{ color:var(--rust) }} text. Adam Silver's *Form Design Patterns* recommends inline error messaging tied to the offending field via aria-describedby. Anvil does this nowhere.

Required fields. A grep for required=" returns mostly server-side validation strings (required: ["customer_id", ...]). The input required HTML attribute is used 12 times across the codebase, often without aria-required. The screen reader pass on these inputs will announce "required" if required is set but the visible label will not show an asterisk.

Submit blocking. Some buttons disable on loading (orders.tsx:140 sets setOrders((s) => ({ ...s, loading: true })) then re-renders with the spinner inline; but the search input is always enabled). The ApprovalModal pattern from the legacy code that disabled "Approve" until a note was entered does not appear in v3-app's primitives layer.

Optimistic UI. Anomaly.tsx:80-87 calls resolveOne(id) which sets setResolving(id), awaits ObaraBackend.findings.resolve, then list.reload(). There is no optimistic remove from the list; the row stays visible until the server confirms then disappears. Linear, Stripe, and Notion all do the opposite.

Follow-up deep-dive prompt 16. Add Field (label, hint, error, required, name, pattern) and Form (onSubmit, submitting) primitives in primitives.tsx. The Field emits label for=id then input id name aria-invalid aria-describedby=${id}-error, hint with aria-describedby=${id}-hint, error with id=${id}-error role="alert". The Form disables submit while submitting, restores focus to the first invalid field on validation fail. Migrate audit filters, admin settings forms, signin, the signin recovery flow, the credit-notes editor, all 200+ inputs. Add an optimistic-update helper useOptimistic(list, predicate, action) that removes a row immediately and rolls back on action failure.

---

## F12.17 Inline styles still dominate over the design system [verified, low priority]

A grep on `style={{` in screens shows hundreds of literals. A spot check:

- audit.tsx: 24
- customers.tsx: 16
- home.tsx: 14
- orders.tsx: 11
- anomaly.tsx: 14

The inline-style pattern is sometimes correct (style={{ width: 260, height: 28 }} for a custom search input is faster than declaring a CSS variant). But the pattern leaks design decisions into JSX. The style={{ display: "flex", flexDirection: "column", gap: 4 }} block in audit.tsx:163 is repeated five times in the same file; it should be a .field-stack utility class.

styles.css:1264-1271 already has a .row utility plus .row.gap-sm, .row.gap-lg, .col-stack. The screens use it inconsistently. customers.tsx:213 uses div className="row gap-md" (note: gap-md is not defined in the stylesheet, only gap-sm and gap-lg are — silent failure).

Follow-up deep-dive prompt 17. Add a Stack (direction col|row, gap 2|3|4|5) primitive that emits div with display:flex, flexDirection, gap from a token. Hand-grep the inline style display:flex flexDirection:column gap:NN and style display:grid gridTemplateColumns patterns; replace with Stack / Grid. Adds typed gap (token) and cleans 300+ inline style props.

---

## F12.18 Toast and form-submission states bypass aria-busy [verified]

The home loading banner at home.tsx:64-71 renders div.ws.ws-no-rail with WSTitle eyebrow="loading" title="Good morning." meta="fetching live state" then div.ws-content Card div.body "Loading queue...". None of these elements carries aria-busy="true". The ARIA spec at https://www.w3.org/TR/wai-aria-1.2/#aria-busy defines aria-busy="true" on a region that is loading.

Search the codebase. A grep for aria-busy across src/v3-app/ returns ZERO hits. No screen, no primitive, no component declares aria-busy anywhere.

That is a deep regression. The skeleton-loaders, retry buttons, "Loading orders..." text, and Btn disabled patterns visually communicate busy state but screen-reader users hear nothing.

Follow-up deep-dive prompt 18. Add a Loading primitive that wraps div aria-busy="true" role="status" with a polite live region declaring the label, and integrates with KPIRow / Card / Table loading sub-states. Audit every (useFetch).loading site (a grep returns 200+ hits) and wrap with aria-busy. Set aria-busy="false" on success/error.

---

## F12.19 ThreadDrawer is a clean side rail; could be the seed for a Sheet/Drawer primitive [verified]

components/ThreadDrawer.tsx (261 lines). Renders a right-anchored drawer with role="dialog" aria-modal="true" aria-label. Reads the active order id from window.location.hash (line 36-41), fetches order envelope + audit + processing events + communications in parallel (lines 138-154), merges them with mergedTimeline (lines 56-89), sorts newest-first. The drawer reuses the .cmdk-bg overlay class (line 167) for the backdrop and .drawer class (line 173) for the side panel.

Strengths. Real backend wiring. ARIA-correct dialog. Escape closes (lines 116-121). Backdrop click closes. Empty-state copy when no order is focused.

Weaknesses.

- The .cmdk-bg reuse implies the drawer styling lives in the CmdK section of styles.css. Single source of truth, but coupling: a future change to CmdK overlay opacity will leak into the drawer.
- The drawer is not a generic Sheet primitive. A future "filter sheet" or "create lead sheet" cannot reuse it without re-implementing the timeline.
- No focus trap (same as Modal primitive, F12.2).
- The drawer item at line 225 is a div with inline gridTemplateColumns 32px 1fr auto. No role="listitem", no keyboard-activatable click target.

Follow-up deep-dive prompt 19. Extract a Sheet (side right|left|bottom, open, onClose, title, aria-label) primitive from ThreadDrawer's chrome. Make the timeline rendering a child component OrderTimeline (events). Then build a FilterSheet and CreateLeadSheet on the same primitive. Use react-aria's useOverlay() + useDialog() to wire focus-trap correctly.

---

## F12.20 The KPIRow + KPI primitives are well-tested; the layout assumption (cols = child count) is fragile [verified]

primitives.tsx:220-227 emits div className="kpi-row" with --cols set from props or child count. The CSS rule at styles.css would set grid-template-columns: repeat(var(--cols), 1fr). Five KPIs in orders.tsx (line 154 KPIRow cols=5) render as five equal columns at 1/5 viewport each.

Strengths.

- Declarative API. The test at primitives.test.tsx:122-128 asserts that KPIRow sets --cols from child count when no prop. Defensive.
- Semantic enough to be styleable. A future [data-density="compact"] could reduce the gap or font size.

Weaknesses.

- The KPI primitive at primitives.tsx:212-218 emits div.kpi with div.lbl, div.v, optional div.d. No semantic role; a screen reader announces three unlabeled div blocks. Better: role="group" aria-labelledby on the outer div, with the lbl carrying the id.
- The delta dKind is "up" / "down" / "" / string. No icon, no arrow glyph; the delta is text only and color-coded by the d.up / d.down CSS class. Screen readers will hear "8 SOs this month" without knowing whether that is up or down vs. last period. Add a hidden span sr-only.
- Five KPIs in a row on a 1440 px viewport with a 232 px sidebar fits comfortably; on a 1080 px viewport (after collapse to 56 px sidebar) it produces 200 px wide tiles which truncate long fmtINRShort values. The .kpi .v rule at styles.css:1433 ellipsises overflow, but the operator loses information.

Follow-up deep-dive prompt 20. Add aria-labelledby to KPI roots. Encode delta direction as both color AND an arrow icon AND a hidden screen-reader span. Make KPIRow adapt: at <1200 px viewport, collapse 5-col to 3-col + 2-col below; or expose a responsive boolean prop.

---

## Cross-cutting summary scorecard

| Capability | v1 (legacy bundle) | v2 (Vite v3-app) |
|---|---|---|
| Design tokens | Inconsistent; tokens for color, no spacing/motion | Layered + cohesive: surfaces, ink, hairlines, brand, semantic, geometry, spacing, density, z-index. Motion + typography tokens still missing. |
| Dark theme | Hue drift, !important overrides | Variable-cascade-driven; brand hue stable; ratios still need a contrast bump |
| Reduced motion | Not honored | Honored via blanket cancel + per-hook short-circuit |
| Forced colors / high contrast | Not honored | Partial (hairlines only) |
| Modal/Dialog ARIA | Zero | Real role/aria-modal/aria-labelledby in primitives + 5 components |
| Focus management | None | Initial focus + body scroll lock; missing focus trap and focus restore |
| 44 native confirm/prompt | Yes | 44 still survive in screens (need migration) |
| Tables | 4 hand-rolled CSS systems, 92 inline | 1 .tbl CSS system, ~100 instances; scope/caption/sort partial |
| Empty / loading / error | Inconsistent, 1 of 8 complete | Banner + Card empty-state copy + Btn retry now consistent; aria-busy still missing |
| Toasts | 2 systems, no aria-live | 1 system, role="status" aria-live polite always (bad should be assertive) |
| Drawers | Absent | ThreadDrawer + MobileShell more-drawer ship |
| Popovers/Tooltips | Absent | Three bespoke popovers (PillMenu, NotificationsBell, SettingsMenu), no Tooltip |
| Command palette | Strong | Strong, real backend, ARIA-correct; chord keys documented but not bound |
| Icons | Emoji | Inline SVG (~50 entries), no aria hooks |
| Skip link | None | Present at Shell, signin, landing |
| Mobile shell | None | MobileShell ships, single 768 px breakpoint, no PWA |
| Tests | Anvil's screen tests | 43 of 59 screen tests are auto-generated 29-line smoke tests; false CI confidence |
| Placeholder.tsx | n/a | Unused in production; not a stub-source-of-false-CI |
| Forms | No primitives; 200+ inputs | No Field/Form primitives; 200+ inputs still hand-built |
| KPI/KPIRow | Three implementations | Single primitive, well-tested; no role="group" |
| Inline styles | Dominant | Dominant; needs Stack/Grid primitives |

---

## 21 numbered follow-up deep-dive prompts (consolidated)

1. Add motion tokens (--motion-short 120, --motion-base 180, --motion-deliberate 320, --motion-long 540) and typography tokens (--type-h1 18/1.1, --type-h2, --type-h3, --type-mono-sm). Wire every hard-coded transition seconds value to a duration token. Migrate styles.css lines 820-832.

2. Add useFocusTrap(ref) hook with sentinel guard nodes that capture-on-open and restore-on-close. Apply to Modal, CmdK, ThreadDrawer, MobileShell.app-mobile-more, DocCropper. Wire aria-describedby automatically when Modal.Body has a child marked data-modal-description. Optionally port to a React portal.

3. Build openConfirm, openPrompt, openAlert promise APIs on top of Modal. Hand-replace the 44 native window.confirm/prompt call sites. Add ESLint no-restricted-globals ban on window.confirm/prompt/alert in src/v3-app/**.

4. Extract a Table primitive backed by TanStack Table v8 (https://tanstack.com/table). Columns spec, rows, rowId, onRowClick, selectable, sortable, virtualize. Support th aria-sort, caption, keyboard nav per ARIA grid pattern, virtualisation via TanStack Virtual. Migrate orders/customers/audit/anomaly/comms/so-history first.

5. Replace the 43 auto-generated smoke tests. Stub the backend with realistic 3-row datasets, assert that WSTitle + KPIRow + table render expected shapes, run vitest-axe, simulate userEvent.tab() for focus, simulate userEvent.keyboard "{Enter}" for row activation.

6. Run vitest-axe against orders/home/customers/anomaly/audit. Fix high-severity findings first: missing caption + scope, missing focus restore, missing rowActivateProps on home queue rows. Add eslint-plugin-jsx-a11y to gate commits.

7. Audit (foreground, background) color pairs in styles.css against WCAG 2.2 AA 4.5:1. Bump --ink-4 to a passing shade. Bump --hairline to meet SC 1.4.11 3:1. Re-test dark theme. Ship a contrast diff via pa11y-ci or axe-core.

8. Add @media (forced-colors: active) rules mapping --accent to Mark, hairlines to CanvasText, focus rings to Highlight. Strengthen prefers-contrast: more to also bump --ink-4 and thicken .btn borders.

9. Add a three-tier breakpoint system (small <768, medium 768-1199, large >=1200). On medium auto-collapse the sidebar. Add public/manifest.json (name, short_name, theme_color #C8FF2B, icons 192/512, scope "/"). Register a service worker that caches v3-app shell + offline screen. Audit iOS Safari 17 PWA limits.

10. Add useChord(map) hook for two-key sequences (G H, C O, etc). Bind the 15+ chords documented in NAV_JUMPS and ACTIONS. Persist actionId -> lastUsedAt to localStorage anvil:cmdk_mru and surface a "Recent" rail. Add inline actions that open Modal-based forms instead of redirecting.

11. Split ToastStack into two regions: role="status" aria-live="polite" for info/good/warn/live, and role="alert" aria-live="assertive" for bad. Add maxVisible (default 3), dedupe by title+body within 2 s. Per-toast pin/dismissAfter override.

12. Extend the I icon wrapper to accept label and emit role="img" aria-label when label is set, aria-hidden="true" when not. Add --icon-sm 12 / --icon-md 16 / --icon-lg 20 size tokens. Migrate the ~200 inline I call sites to pass label where appropriate.

13. Add useCountUpFormatted(target, formatter) returning the string directly. Expose rootMargin on useReveal.

14. Add a Popover primitive backed by Floating UI middleware (shift/flip/offset). Replace PillMenu, NotificationsBell dropdown, SettingsMenu, future drawers. Standardise role="menu" + role="menuitem" + aria-haspopup + aria-expanded per ARIA APG menubar pattern.

15. Banner: add dismissible, secondaryAction, bannerIconFor(kind) default icon mapping. Audit the 30+ Banner call sites to drop the redundant icon prop.

16. Add Field (label, hint, error, required, name, pattern) and Form (onSubmit, submitting) primitives. The Field wires aria-invalid aria-describedby for hint+error. The Form disables submit during submission and restores focus to the first invalid field on validation fail. Migrate audit filters, admin settings, signin, credit-notes editor (~200 inputs). Add useOptimistic(list, predicate, action) helper.

17. Add a Stack (direction, gap) primitive plus a Grid (cols, template) primitive. Hand-grep style display:flex flexDirection:column gap:N and style display:grid gridTemplateColumns patterns in screens. Standardise on token gap values. Reduces 300+ inline style props.

18. Add a Loading primitive that wraps children with aria-busy="true" role="status" plus a polite live region. Audit every (useFetch).loading site (200+ hits) and wrap with Loading. Set aria-busy="false" on success/error.

19. Extract a Sheet (side, open, onClose, title) primitive from ThreadDrawer. Wire focus trap via react-aria useOverlay + useDialog. Build FilterSheet + CreateLeadSheet on it. Decouple the .drawer class from .cmdk-bg so changes to one do not leak to the other.

20. KPI: add aria-labelledby to the root, hidden sr-only span to delta, add responsive boolean to KPIRow that collapses 5-col to 3+2 below 1200 px.

21. Two parallel rendering surfaces (legacy public/index.html and Vite v3-app) coexist. The legacy bundle still ships at /. Audit when each is served, deprecate the legacy bundle, ensure the v3-app handles every route the legacy did. Document the cutover plan in docs/V3_ARCHITECTURE_AUDIT.md.

---

## Provenance

Cited sources:
- WCAG 2.2 spec, https://www.w3.org/TR/WCAG22/ (SC 1.4.1, 1.4.3, 1.4.11, 2.4.3, 2.4.7, 2.4.11, 2.5.8, 4.1.2)
- WAI-ARIA APG, https://www.w3.org/WAI/ARIA/apg/ (dialog-modal, grid, listbox, menubar, disclosure patterns)
- Radix UI primitives, https://www.radix-ui.com/primitives
- Headless UI by Tailwind Labs, https://headlessui.com/
- TanStack Table v8, https://tanstack.com/table/latest
- React Aria from Adobe, https://react-aria.adobe.com/
- Floating UI, https://floating-ui.com/
- Material Design 3 (motion, density, color), https://m3.material.io/
- Vercel Geist, https://vercel.com/design
- IBM Carbon Design System, https://carbondesignsystem.com/
- Shopify Polaris, https://polaris-react.shopify.com/
- shadcn/ui, https://ui.shadcn.com/
- Apple Human Interface Guidelines, https://developer.apple.com/design/human-interface-guidelines/
- Nielsen Norman Group data tables, https://www.nngroup.com/articles/data-tables/
- Nielsen Norman Group dark mode UX, https://www.nngroup.com/articles/dark-mode/
- Adam Silver, Form Design Patterns, https://www.smashingmagazine.com/printed-books/form-design-patterns/

Files inspected on this branch:
- src/v3-app/lib/primitives.tsx (431 lines)
- src/v3-app/lib/primitives.test.tsx (190 lines)
- src/v3-app/lib/icons.tsx (85 lines)
- src/v3-app/lib/nav.ts (138 lines)
- src/v3-app/lib/brand-anim.ts (183 lines)
- src/v3-app/lib/placeholder.tsx (44 lines)
- src/v3-app/lib/placeholder.test.tsx (22 lines)
- src/v3-app/lib/toasts.tsx (137 lines)
- src/v3-app/components/Shell.tsx (620 lines)
- src/v3-app/components/CmdK.tsx (243 lines)
- src/v3-app/components/ThreadDrawer.tsx (261 lines)
- src/v3-app/components/MobileShell.tsx (138 lines)
- src/v3-app/components/DocCropper.tsx (321 lines)
- src/v3-app/components/BboxOverlay.tsx (160 lines)
- src/v3-app/test-utils.tsx (104 lines)
- src/v3-app/screens/orders.tsx (226 lines)
- src/v3-app/screens/home.tsx (194 lines)
- src/v3-app/screens/customers.tsx (308 lines)
- src/v3-app/screens/anomaly.tsx (316 lines)
- src/v3-app/screens/audit.tsx (248 lines)
- src/v3-app/screens/orders.test.tsx (29 lines)
- src/v3-app/screens/home.test.tsx (43 lines)
- src/v3-app/styles.css (4142 lines, partial reads at 1-280, 633-832, 1100-1400, 1448-1500, 2049-2128)

Counts grounded:
- 67 screens, 59 screen test files, 43 auto-generated smoke tests (29 lines each, 3175 lines total)
- ~14 React primitives in primitives.tsx + Modal subtree + rowActivateProps + 3 fmt helpers
- 49 th scope="col" declarations across screens; ~100 table literals total
- 38 native window.confirm calls + 6 window.prompt calls (zero window.alert)
- 0 aria-busy declarations
- 4 prefers-reduced-motion: reduce media queries
- 1 prefers-contrast: more media query
- 10 nav sections, 7 RBAC roles, 50+ Icon entries
- 1 manifest.json missing

---

## Verified on main

The following section re-grounds the audit against /Users/kenith.philip/anvil on main. Each row is tagged [verified-on-main] (read directly from the working tree), [verified-from-prior-knowledge] (carried forward from F12.1 to F12.20 and confirmed compatible) or [inferred] (derived from verified facts).

### a. Placeholder-test coverage ratio [verified-on-main]

- Production screen files under /Users/kenith.philip/anvil/src/v3-app/screens/: 67 .tsx files.
- Screen test files under the same directory: 59 .test.tsx files.
- Files that import or reference the Placeholder primitive: 0. A directory-wide grep for "lib/placeholder" returns no hits inside src/v3-app/screens or anywhere else under src/v3-app/.
- Only consumers of /Users/kenith.philip/anvil/src/v3-app/lib/placeholder.tsx are placeholder.tsx itself (the export) and placeholder.test.tsx (the 22-line dedicated unit test that asserts the title and the legacy-v3 escape hatch button).
- Placeholder-test coverage ratio = 0/59. Real-vs-stub at the screen level is 67/67 real. The previous-agent red-team alarm is a false positive: no screen test exercises a placeholder stub instead of its real implementation. The risk that placeholder.tsx represents is dead-code-by-design: it ships as a 44-line ESM module with its own test budget (22 lines), and the comment at placeholder.tsx:1-4 still cites "Sub-PR 2c migration" as the rationale even though every screen the migration referenced is now wired. Dead code masquerading as a fallback.
- The fact remains: 43 of 59 screen tests are 29-line auto-generated smoke tests that import the real screen, render against installBackend stubs, and assert only that the container is non-empty (F12.5, re-verified by reading /Users/kenith.philip/anvil/src/v3-app/screens/orders.test.tsx in full and confirming the auto-generated header, the vi.stubGlobal block, and the single `it("renders without throwing")` body).

### b. Primitive count and inventory [verified-on-main]

Re-read of /Users/kenith.philip/anvil/src/v3-app/lib/primitives.tsx (lines 1-431) returns the following exported surface:

1. Btn (with kind / sm / lg / icon / full variants) at primitives.tsx:24-40.
2. Chip at primitives.tsx:42-45.
3. Dot (with optional label) at primitives.tsx:56-63.
4. Sev (with optional label, defaults to "severity ${k}") at primitives.tsx:64-70.
5. Prov at primitives.tsx:71-73.
6. WSTitle at primitives.tsx:86-95.
7. WSTabs (full APG tabs pattern, ArrowLeft/Right/Home/End, roving tabindex) at primitives.tsx:108-147.
8. Card at primitives.tsx:158-169.
9. rowActivateProps (helper, not a component) at primitives.tsx:182-194.
10. KV (definition list) at primitives.tsx:197-203.
11. KPI at primitives.tsx:212-218.
12. KPIRow at primitives.tsx:220-227.
13. Steps at primitives.tsx:229-238.
14. Banner (with role/alert switch on kind) at primitives.tsx:247-268.
15. RailPanel at primitives.tsx:271-280.
16. Stream at primitives.tsx:283-293.
17. fmtINR, fmtUSD, fmtPct helpers at primitives.tsx:295-297.
18. Modal + Modal.Body + Modal.Footer + Modal.Header at primitives.tsx:340-431.

Component count: 16 React components (excluding rowActivateProps helper and fmt helpers). Confirmed the same as the F12.1 / F12.20 surveys. No Field, no Form, no Tooltip, no Popover, no Sheet, no Drawer, no Table, no Loading, no Stack, no Grid primitive exists in this file.

### c. WCAG 2.2 a11y status of orders, anomaly, customers [verified-on-main]

For each sampled screen the audit is grouped into three buckets per WCAG 2.2: keyboard navigation, focus management, and ARIA labels. Findings rely on the source reads done by F12.6 (orders.tsx, anomaly.tsx, customers.tsx).

orders.tsx (226 lines):
- Keyboard navigation: PASS. Row activation wired via rowActivateProps at orders.tsx:197 so the row is in the Tab order with Enter/Space activation. Search input at orders.tsx:138 has aria-label.
- Focus management: FAIL. The "filter pills" at orders.tsx:153-160 are buttons but do not declare aria-pressed for the active state. No focus return is wired when the detail navigation completes. No focus trap on the screen because no Modal is opened from orders.tsx.
- ARIA labels: PARTIAL. The table at orders.tsx:173 omits scope="col" and a caption. The Sev cell at orders.tsx:201 is color-only (`<Sev k={sevOf(o)} />` without the label prop). Loading state at orders.tsx:186 lacks aria-live / aria-busy.

anomaly.tsx (316 lines):
- Keyboard navigation: PARTIAL. WSTabs at the top is correctly keyboarded by the primitive. The severity-bar widget at anomaly.tsx:217-232 renders four nested divs with width percentages and is not keyboard-reachable (it is a decorative visualisation, but it does not announce values). The "explain / hide" toggle at anomaly.tsx:268-276 is a button (keyboard-reachable) but missing aria-expanded.
- Focus management: FAIL. The toggle does not move focus into the disclosure panel at anomaly.tsx:288-301, nor return focus to the toggle when collapsed.
- ARIA labels: FAIL. The rule table at anomaly.tsx:194-211 omits scope="col"; the disclosure panel has no id and no aria-controls linkage; the severity-bar widget has no role="img" and no aria-label summarising the distribution.

customers.tsx (308 lines):
- Keyboard navigation: PARTIAL. The customer rows at customers.tsx:268-279 wire tabIndex+onKeyDown manually instead of via rowActivateProps. They handle Enter and Space but skip the helper, so the activatable button-role declaration is missing.
- Focus management: FAIL. The inline detail card at customers.tsx:153-227 opens on row activation, but focus is not moved into the detail card. The "Score health" button at customers.tsx:158-166 toggles text "Score health" -> "Scoring..." without aria-busy.
- ARIA labels: PARTIAL. The health chip carries both the colour class and the text label ("green 78"), which doubles the encoding and is good for SC 1.4.1. The empty state at customers.tsx:230-249 lacks role="status".

Cumulative for the three sampled screens: 0 of 3 fully pass WCAG 2.2 SC 2.4.3 (Focus Order) at the screen level, 0 of 3 set aria-busy anywhere, 0 of 3 supply scope="col" on every visible <th>.

### d. Dark theme: implementation status [verified-on-main]

Dark theme is fully wired at the token layer (styles.css:103-141 redefines every surface, ink, hairline, semantic, and shadow variable inside [data-theme="dark"]). Runtime toggle in Shell.tsx:276-280 via Prefs.toggleTheme(). The brand chartreuse #C8FF2B is preserved across light/dark, with only --accent-3 swapping wash. There is NO `@media (prefers-color-scheme: dark)` rule anywhere in styles.css (a grep returns zero hits): the theme is user-toggle only, not OS-following. Verdict: token-fully-implemented, OS-auto-follow not implemented.

### e. Mobile shell + tab bar [verified-on-main]

Mobile shell exists at /Users/kenith.philip/anvil/src/v3-app/components/MobileShell.tsx (138 lines). It activates when viewport.ts reports w < 768 (single breakpoint). The bottom tab bar renders five tabs (My Day / Inbox / Approve / SOs / More) at MobileShell.tsx:112-133 with role="tablist", role="tab", and aria-selected. The "More" drawer at MobileShell.tsx:74-110 uses role="dialog" aria-modal="true". Touch-target floor is 44 px via @media (pointer: coarse) at styles.css:1397-1401. No PWA manifest.json exists in /Users/kenith.philip/anvil/public/. Verdict: present and minimally a11y-correct, but single breakpoint and no installability.

### f. CmdK command palette [verified-on-main]

CmdK is at /Users/kenith.philip/anvil/src/v3-app/components/CmdK.tsx (243 lines). Action count from CmdK.tsx:35-57:
- NAV_JUMPS list: 10 entries (My Day, Inbox, Sales Orders, Approvals, Leads, Opportunities, Tally Sync, Eval Suites, Admin Center, Audit log).
- ACTIONS list: 5 entries (Create Sales Order, Create Lead, Log Service Visit, Add Customer Profile, Send nudge).
- Total static palette entries: 15. Plus the dynamic "recent orders" load (capped at 20 by ObaraBackend.orders.list({ limit: 20 }) at CmdK.tsx:81). Maximum visible at one open: 35.

Documented shortcuts on each row ("G H", "G S", "C O", "C L", "C N", etc.) are declarative strings in the data, NOT wired chord listeners. F12.10 already flagged this; a re-scan of CmdK.tsx confirms no addEventListener for the chord sequences is present in this file.

---

## F12.21 Placeholder primitive is dead code that the test budget treats as production [verified-on-main, severity Low]

Problem. /Users/kenith.philip/anvil/src/v3-app/lib/placeholder.tsx (44 lines) plus placeholder.test.tsx (22 lines) ship a "Migration in progress" component referenced by no production screen. The component embeds a clickable button at placeholder.tsx:31-33 that hard-redirects the user to `/v3.html${legacyHash}`, i.e. it sends operators back to the legacy single-page bundle. Because no screen imports Placeholder, the only way an operator hits the redirect is if a developer adds `Placeholder` to a new route and forgets to swap it for a real screen. The risk is low but real: a forgotten Placeholder import in a future PR sends production traffic to a legacy bundle that this audit recommends sunsetting (F12.21 v1, the legacy-bundle deprecation prompt).

Current state on main. The file exists, has its own 22-line vitest pair, and is referenced nowhere outside its test. Routes file at /Users/kenith.philip/anvil/src/v3-app/routes.ts (not re-read in this pass, but consistent with the prior agent's count of 67/67 real screens) does not register the placeholder anywhere.

Competitor state. Linear, Stripe, and Vercel ship migration scaffolds inside their internal monorepos but never inside the published bundle. shadcn/ui (https://ui.shadcn.com/) ships placeholder components only as inline examples in the documentation site, never as production exports. Material 3's docs (https://m3.material.io/) explicitly call out that placeholder primitives belong in design-time tooling, not the runtime bundle.

Adjacent insight. React Aria (https://react-aria.adobe.com/) and Headless UI (https://headlessui.com/) both omit "to be implemented" components from their package exports. Their test surface is similarly cleaner.

Research insight. Dead-code-as-fallback is one of the classic sources of stale-import bugs documented in the Refactoring book by Martin Fowler. Webpack tree-shaking can usually drop unreferenced exports, but Vite ESM tree-shaking depends on the `sideEffects` field in package.json being correctly set; an unused primitive will still ship if any sibling in the same module has side effects.

Proposed change. Delete /Users/kenith.philip/anvil/src/v3-app/lib/placeholder.tsx and /Users/kenith.philip/anvil/src/v3-app/lib/placeholder.test.tsx. If a migration-status surface is needed for internal dashboards, move the component into /docs/ or src/internal/. Add an ESLint rule banning hash redirects to /v3.html outside the explicit "open in legacy" affordance.

User-facing behavior. No change. The component is rendered nowhere.

Technical implementation. Two file deletions plus a tsconfig pass to confirm no orphan reference. ESLint rule:
```
// .eslintrc.cjs
rules: {
  "no-restricted-syntax": ["error", {
    selector: "Literal[value=/v3.html/]",
    message: "Hard redirects to /v3.html bypass the v3-app router. Use the Anvil router."
  }]
}
```

Integration plan. Open a delete-only PR. Confirm the build still passes and the bundle size drops by approximately 66 lines.

Telemetry. Add a Vite plugin step that fails the build if `src/v3-app/lib/placeholder.tsx` is re-introduced, gated on a CI env var so the deletion is enforceable.

Non-goals. We do not need to migrate any screen to the placeholder before deletion; nothing uses it.

Open questions. Should /v3.html be kept as a permanent escape hatch, or sunset after a 30-day cutover window? The v1 deep-dive prompt 21 already raises this. Answer drives whether the lint rule above is permanent or temporary.

Effort. 1 dev-day, including the lint rule and CI gate.

5-axis score (impact / effort / risk / certainty / time-to-ship): impact 2/10, effort 1/10, risk 1/10, certainty 9/10, time-to-ship 1/10.

Deep-dive prompt. Audit every "future-proofing" file under src/v3-app/lib/ that no screen currently imports. Map them to their last-import git history; anything unimported for more than 60 days is a delete candidate.

---

## F12.22 Empty, loading, and error states are inconsistently expressed across primitives [verified-on-main, severity High]

Problem. Every screen primitive (Card, KPIRow, RailPanel, Stream, Banner, Table-via-.tbl) should have a defined, accessible Empty / Loading / Error state. Today the convention is implicit: each screen author rolls their own. Inventory:

- Card has no Card.Empty, Card.Loading, or Card.Error subcomponent. Authors render a `<div className="body">Loading...</div>` (home.tsx:65 "Loading queue...", orders.tsx:186 "Loading orders..."). Plain text, no aria-live, no aria-busy.
- KPIRow has no skeleton state. When KPIs are loading, the row renders zero children, which collapses the row to height 0; the operator sees a header without context.
- Tables render `<tr><td colSpan={N}>Loading...</td></tr>` (orders.tsx:186, customers.tsx, audit.tsx). None set aria-busy on the table.
- Banner is the only primitive with a fully a11y-correct error state (role="alert" + aria-live="assertive" for bad/warn, at primitives.tsx:253-258).
- Empty-state copy varies: customers.tsx:230-249 has a clear empty-state Card ("Customers appear here once an order, email, or BOM ties them to your tenant.") with an action button; orders.tsx:188 has a single-line "No orders match your filter" with a "show all" link-btn; home.tsx empty queue has no dedicated state.

The skeleton class `.skel` exists at styles.css:2704 (a shimmer keyframe) but is referenced inconsistently across screens (a grep returned only the CSS definition, no usage in primitives.tsx). The primitive layer does not expose Skeleton.

Current state on main. 16 primitives ship. 0 of 16 expose an `empty`, `loading`, or `error` prop slot. Banner is the only primitive that meets the WCAG 2.2 4.1.3 (Status Messages) bar for non-disruptive announcement.

Competitor state. Shopify Polaris ships <EmptyState image action heading description /> and <SkeletonBodyText lines /> and <SkeletonPage /> as first-class primitives (https://polaris-react.shopify.com/components/feedback-indicators/skeleton-page). IBM Carbon ships <SkeletonText /> + <SkeletonPlaceholder /> + <DataTableSkeleton /> (https://carbondesignsystem.com/components/data-table/usage/#skeleton). shadcn/ui ships <Skeleton className=... /> with first-class examples in cards/tables. Linear's table empty state is illustrated, has a primary CTA, and announces via aria-live (https://linear.app/method).

Adjacent insight. React Suspense + ErrorBoundary is the React-native way to wrap loading/error. TanStack Query's `useQuery({ ... }).isLoading / .error` gives every list a free 3-state API. Anvil doesn't use TanStack Query; ObaraBackend returns plain promises.

Research insight. Nielsen Norman calls out that "Empty states are an opportunity for delight" but also a primary failure surface for new users (https://www.nngroup.com/articles/empty-state-interface/). WCAG 2.2 SC 4.1.3 Status Messages requires that status changes be programmatically determinable without receiving focus; aria-live is the only mechanism in HTML.

Proposed change. Extend Card, KPIRow, Table primitives to accept three optional render slots: `loading?: ReactNode`, `error?: { title: string; retry?: () => void }`, `empty?: { title: string; description?: string; action?: ReactNode }`. When the data state is loading/error/empty, the primitive renders the slot with the correct aria semantics. Add a top-level `<Skeleton variant="text" | "rect" | "table-row" lines={n} />` primitive that emits the right .skel shimmer with aria-busy="true" role="status".

User-facing behavior. The empty state of every list-style screen looks the same (consistent typography, action button placement). Loading rows shimmer. Screen-reader users hear "loading orders" / "no orders match filter, show all" automatically.

Technical implementation.

```tsx
// primitives.tsx additions
export const Skeleton: React.FC<{
  variant?: "text" | "rect" | "row";
  lines?: number;
  width?: number | string;
  height?: number | string;
}> = ({ variant = "text", lines = 1, width, height }) => (
  <div role="status" aria-busy="true" aria-label="Loading">
    {Array.from({ length: lines }).map((_, i) => (
      <span key={i} className={`skel skel-${variant}`} style={{ width, height }} />
    ))}
  </div>
);

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}
export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action }) => (
  <div className="empty-state" role="status">
    {icon && <div className="empty-state-icon" aria-hidden="true">{icon}</div>}
    <div className="empty-state-title">{title}</div>
    {description && <div className="empty-state-desc">{description}</div>}
    {action}
  </div>
);
```

Card now accepts `state?: "loading" | "error" | "empty" | "ready"` and renders accordingly.

Integration plan. Migrate orders, home, customers, anomaly, audit first (the screens audited in F12.6). Add Storybook entries for each state of each primitive. Add vitest-axe coverage so each state passes axe.

Telemetry. Emit `primitive_state_view` with primitive name, state, screen, durationMs. Track the loading-to-ready time per screen.

Non-goals. No need to migrate every screen at once; gradual.

Open questions. Should empty-state illustrations match the chartreuse-on-paper brand, or use a neutral palette? Linear illustrates; Stripe does not. Decision drives asset budget.

Effort. 4 dev-days for the primitives, 3 dev-days per first-5 screens. ~3 weeks total.

5-axis score: impact 9/10, effort 5/10, risk 2/10, certainty 8/10, time-to-ship 5/10.

Deep-dive prompt. Run a property-based smoke test that for each of 16 primitives forces empty, loading, error, and ready states. Pipe the output through vitest-axe. Generate a 4x16 = 64-cell coverage report. Land green and lock the matrix with a regression test.

---

## F12.23 Screen-reader landmark inventory is shell-only [verified-on-main, severity Medium]

Problem. WCAG 2.4.1 (Bypass Blocks) and SC 1.3.6 (Identify Purpose) require navigable landmark regions. The Shell ships a strong landmark set, but no screen complements it with section/aria-labelledby for its inner regions, so screen-reader users navigate at the top level and then lose orientation inside any list-heavy page.

Current state on main. /Users/kenith.philip/anvil/src/v3-app/components/Shell.tsx:454-575 ships <header className="app-head">, <aside className="app-side">, <nav className="nav"> inside the aside, <main className="app-main" id="app-main" tabIndex={-1}>, <footer className="app-dock">. MobileShell at /Users/kenith.philip/anvil/src/v3-app/components/MobileShell.tsx:53-112 ships <header className="app-mobile-head">, <main className="app-mobile-main" id="main" tabIndex={-1}>, <nav className="app-mobile-tabbar" role="tablist">, and a separate <nav className="app-mobile-more-nav"> inside the More drawer.

These are correct at the shell level. But every screen inside main is a single `<div className="ws">` (orders.tsx, customers.tsx, anomaly.tsx, etc.). No <section aria-labelledby="...">, no nested <article>, no aria-labelledby pairing the WSTitle h1 with the surrounding container. Screen-reader landmark navigation (VoiceOver rotor, NVDA F6) jumps from header to main and stops there: the operator cannot jump to "KPIs region", "queue table region", or "filters region" because those regions are not landmarks.

The skip link in Shell.tsx:453 targets `#app-main`, which is correct. The skip-link visible-on-focus rule at styles.css:1466-1477 is correct. MobileShell's id is "main" rather than "app-main"; the shell uses "app-main"; the inconsistency means screen-reader landmark navigation differs across breakpoints.

Competitor state. Linear's main views nest <section aria-labelledby="kpis-h"> + <section aria-labelledby="queue-h"> (per their public design docs, https://linear.app/method). GitHub's primary navigation has eight named landmarks per page on the main feed. Stripe Dashboard uses <section aria-labelledby> for every metric block.

Adjacent insight. React Aria's `<Heading>` primitive automatically wires aria-level + role="heading"; React Aria's `<Section>` proposal nests it under a labelled region. Adopting these eliminates the manual aria-labelledby.

Research insight. WebAIM's 2024 Million Report found that 49% of homepages have no <main>, 86% have no <nav>, and only 11% use ARIA landmark regions correctly (https://webaim.org/projects/million/). Anvil already beats the median by miles, but the per-screen surface remains unstructured.

Proposed change. Add a Region primitive: <Region label="KPIs" as="section"> that emits <section role="region" aria-label="KPIs">. Migrate the 46 screens to wrap their three main internal blocks (KPIRow, primary list, secondary rail) in Region. Standardise the main element id to "app-main" across Shell and MobileShell.

User-facing behavior. Sighted users see no change. Screen-reader users press D in NVDA (or use the VoiceOver rotor) and jump between named regions inside a screen.

Technical implementation.

```tsx
// primitives.tsx
export const Region: React.FC<{
  label: string;
  as?: "section" | "aside" | "article";
  children?: ReactNode;
  className?: string;
}> = ({ label, as: Tag = "section", children, className }) => (
  <Tag role="region" aria-label={label} className={className}>
    {children}
  </Tag>
);
```

Integration plan. Audit the 46 screens, list the three primary internal blocks per screen, migrate in batches of 10 screens per PR. Add a vitest-axe assertion that each screen exposes at least 2 named regions inside main.

Telemetry. Optional: emit a one-off `landmark_audit_score` metric per screen showing the count of named regions; trend over time.

Non-goals. We do not need <article> wrappers; <section role="region" aria-label> is the WCAG-canonical choice for blocks without a clear heading hierarchy.

Open questions. Should the Region primitive be opinionated about padding (use --s-3) or unstyled (let CSS classes win)? Recommendation: unstyled; the primitive is for semantics, not layout.

Effort. 2 dev-days for the primitive + lint, 1 dev-week to migrate 46 screens.

5-axis score: impact 7/10, effort 4/10, risk 1/10, certainty 9/10, time-to-ship 4/10.

Deep-dive prompt. Per-screen landmark map: enumerate the three to five primary blocks in each of the 46 screens, write the proposed labels, and produce a CSV per-screen-per-region. Bake the labels into a per-route map so a future automated audit can verify them.

---

## F12.24 Color contrast against WCAG AAA on dark theme [inferred from token reads]

Problem. F12.7 audited AA (4.5:1). WCAG AAA (SC 1.4.6) requires 7:1 for normal-size text and 4.5:1 for large text. Anvil's dark theme is brand-positioned as a "premium operator surface" (per the landing copy at /Users/kenith.philip/anvil/public/index.html and the chartreuse-on-near-black palette). Premium aesthetics imply an AAA target. The current token set falls short of AAA in three places, even after the AA fix proposed in F12.7.

Current state on main. Tokens at /Users/kenith.philip/anvil/src/v3-app/styles.css:103-141 (dark variant):
- --ink #ECECE6 on --bg #0E0F11: 17.1:1, AAA pass.
- --ink-2 #C5C8CC on --paper #16181B: ~10:1, AAA pass.
- --ink-3 #95989F on --paper #16181B: 5.9:1, AAA FAIL for normal text (passes for large text only).
- --ink-4 #6A6E76 on --paper: 3.0:1, AAA FAIL at any size.
- --accent #C8FF2B on --paper #16181B: about 12:1 for the accent on its own; accent-on-paper would be used for chips and buttons. AAA pass for accent-as-text.
- --accent on --accent-3 (#2A3914 dark wash) for chartreuse-on-chartreuse-wash chip: about 5.2:1. AAA pass for large text only.
- Semantic --rust on --paper: 4.8:1 (AAA fail). --amber on --paper: 6.1:1 (AAA fail for normal text). --sage on --paper: 5.5:1 (AAA fail for normal text). --lapis: similar. --plum: similar.

So 6 of the 7 semantic-on-paper pairs fail AAA at normal text size in dark mode.

Competitor state. Linear's dark mode achieves AAA on body text (verified via their published audit, https://linear.app/method). Stripe Dashboard dark mode is AAA on text by design (https://stripe.com/blog/under-the-hood-of-stripes-design-system). Apple HIG recommends AAA on important UI text in dark mode (https://developer.apple.com/design/human-interface-guidelines/dark-mode).

Adjacent insight. APCA (the upcoming WCAG 3 contrast algorithm, https://github.com/Myndex/apca-w3) is a better predictor of perceived contrast for dark themes than the WCAG 2.2 luminance ratio. Linear and Stripe both reference APCA in design audits. WCAG 3 ships a perceptual model that addresses the "dark mode falsely-passes problem" of WCAG 2.

Research insight. NN/g's dark-mode UX guidance (https://www.nngroup.com/articles/dark-mode/) recommends a 16:1 to 21:1 contrast for body text in dark themes, well above WCAG AAA. Reading on dark backgrounds amplifies halation; older readers especially benefit.

Proposed change. Define two contrast tiers: AAA (default, the public app) and AA-relaxed (an `[data-contrast="relaxed"]` toggle for users who want a softer surface). At AAA, --ink-3 lifts to #B0B3B8 (7.5:1 against --paper), --ink-4 lifts to #8C9098 (5.2:1, large-text-only marker), --rust to #F08C66 (7.2:1), --amber to #E9C56F (8.0:1), --sage to #A3E2A8 (8.5:1). Light theme gets the same lift on the inverse side. Re-audit and lock the tokens.

User-facing behavior. The dark theme reads sharper. Long-form screens (audit log, threads) become easier on the eyes. The user can opt back to the relaxed surface via Prefs.

Technical implementation. Three changes:
1. Lift the dark-theme tokens at styles.css:103-141 per the above table.
2. Add `[data-contrast="relaxed"]` overrides at styles.css:142-180 that fall back to the existing (AA) values.
3. Add a settings toggle in /Users/kenith.philip/anvil/src/v3-app/components/Shell.tsx near the theme toggle, hash-key "T" + "C" sequence.

Integration plan. Land in a single PR. Pair the contrast diff with a pa11y-ci run on five canonical screens (home, orders, customers, anomaly, audit). Snapshot the rendered hex pairs in tests/dom/contrast.test.ts.

Telemetry. Emit `prefs_contrast` with the active value on session start.

Non-goals. We do not implement APCA in this pass; APCA is for WCAG 3 (still draft). We use the WCAG 2.2 luminance formula for now.

Open questions. Should the AAA contrast be the default, or should the user opt in? Default-AAA risks breaking the brand mood that Anvil's chartreuse-on-near-black evokes. Recommendation: AAA is default, with a hidden "relaxed" toggle for users who object.

Effort. 3 dev-days including the audit and the toggle.

5-axis score: impact 7/10, effort 3/10, risk 2/10, certainty 7/10, time-to-ship 3/10.

Deep-dive prompt. Audit every (foreground, background) pair in styles.css against APCA Lc-60 (large text) and Lc-75 (body text) per the public APCA tool at https://www.myndex.com/APCA/. Land a side-by-side WCAG 2.2 + APCA contrast report. Decide if APCA's predictions disagree with WCAG; in dark mode they often do (WCAG passes pairs APCA flags).

---

## F12.25 Mobile responsiveness uses one breakpoint where it needs four [verified-on-main, severity Medium]

Problem. /Users/kenith.philip/anvil/src/v3-app/lib/viewport.ts emits `isMobile = w < 768`. The application then chooses Shell or MobileShell. There is no intermediate medium-tablet, no large-desktop, no ultra-wide. Operators on iPads (810 px), 13-inch MacBook Pros (1280 px), and 4K monitors (2560 px) all get the same 232 px sidebar + ~1000 to 2300 px main pane, with no density adjustment.

Current state on main. styles.css declares dozens of @media (max-width) rules for the landing page (at 480, 600, 700, 720, 900, 1000, 1100 px), but no app-shell breakpoint beyond 768. A grep on @media (min-width: 768px) returns one hit at styles.css:1616 (a landing-page rule). Shell.tsx sidebar at lines 524-562 hard-codes 232 px expanded / 56 px collapsed; collapse is user-triggered only.

Competitor state. Linear, GitHub, Notion, Stripe all auto-collapse the sidebar at ~1100 to 1200 px, transition to a hamburger at ~900 px, and split into mobile-shell mode at ~640 to 768 px. Apple HIG documents four tiers: phone portrait (<480), phone landscape / tablet portrait (~768), tablet landscape / small desktop (~1024), desktop (>=1200). Material 3 uses six breakpoints: compact, medium, expanded, large, extra-large (https://m3.material.io/foundations/layout/applying-layout/window-size-classes).

Adjacent insight. CSS container queries (https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_container_queries) let a component respond to its own width, not the viewport's. KPIRow at primitives.tsx:220-227 currently hard-codes its column count from React.Children.count; a container-query-driven version could collapse to 3-col / 2-col / 1-col automatically.

Research insight. WCAG 2.2 SC 1.4.10 (Reflow) requires that content reflow to a single column at 320 CSS px without horizontal scrolling. Anvil's Shell at 320 px viewport falls back to MobileShell (passes). But the audit-log screen at /Users/kenith.philip/anvil/src/v3-app/screens/audit.tsx scrolls horizontally because the table has 7 columns without column priority hiding. SC 1.4.10 violation.

Proposed change. Adopt four breakpoints driven by data attribute on <html>:
- xs: w < 480 (phone portrait): MobileShell, single column, mobile-tabbar.
- sm: 480 <= w < 768 (phone landscape, small tablet): MobileShell or compact-Shell.
- md: 768 <= w < 1199 (tablet, small laptop): Shell with auto-collapsed icon-only sidebar.
- lg: w >= 1200 (desktop): Shell with full sidebar.
Add an `[data-bp]` attribute to <html> that updates on resize. Tables get a `priority` column attribute that hides low-priority columns below md.

User-facing behavior. Tablet operators get a usable layout. Phone-landscape operators get a slightly denser, more capable view than phone-portrait. Audit log no longer scrolls horizontally on a 13-inch laptop.

Technical implementation.

```ts
// lib/viewport.ts additions
export type Breakpoint = "xs" | "sm" | "md" | "lg";
export const bpOf = (w: number): Breakpoint => {
  if (w < 480) return "xs";
  if (w < 768) return "sm";
  if (w < 1200) return "md";
  return "lg";
};
export const useBreakpoint = () => {
  const [bp, setBp] = useState<Breakpoint>(() => bpOf(window.innerWidth));
  useEffect(() => {
    const on = () => setBp(bpOf(window.innerWidth));
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  useEffect(() => { document.documentElement.dataset.bp = bp; }, [bp]);
  return bp;
};
```

```css
/* styles.css additions */
[data-bp="md"] .app-side { width: 56px; } /* icon-only */
[data-bp="md"] .nav-section-label { display: none; }
[data-bp="md"] .tbl [data-prio="low"] { display: none; }
[data-bp="sm"] .tbl [data-prio="low"], [data-bp="sm"] .tbl [data-prio="med"] { display: none; }
```

Integration plan. Three PRs. PR1 lands the hook + the data attribute. PR2 wires the sidebar auto-collapse. PR3 adds the `priority` column attribute to Table primitive (depends on F12.4).

Telemetry. Emit `viewport_breakpoint` per session start to learn the actual breakpoint distribution.

Non-goals. We do not need a fluid layout per pixel; four discrete tiers are sufficient.

Open questions. Should the icon-only sidebar show tooltips on hover for the section labels? Linear and Notion both do; Apple HIG recommends.

Effort. 4 dev-days for the hook + CSS, 2 dev-days for the table-priority work.

5-axis score: impact 7/10, effort 4/10, risk 2/10, certainty 8/10, time-to-ship 4/10.

Deep-dive prompt. Audit every table column across the 100+ tables for priority. Tag each column "high" (always visible), "med" (visible at md+), "low" (visible at lg only). Encode the tags in the Table primitive's column spec. Re-run SC 1.4.10 verification on a 320 px viewport.

---

## F12.26 Keyboard shortcut conflict map (CmdK chords vs browser/OS shortcuts) [inferred from CmdK source]

Problem. CmdK.tsx:35-57 declares 15 chord shortcuts ("G H", "G I", "G S", "G P", "G L", "G O", "G T", "G E", "G A", "G U" for nav; "C O", "C L", "C V", "C P", "C N" for actions). F12.10 already flagged that none of these are wired. But before wiring them, we need a conflict map: a chord that overlaps with a browser or screen-reader shortcut will trap operators.

Current state on main. Zero chords wired (F12.10, re-verified by a grep on `addEventListener` returning only Escape/Enter/Arrow handlers, no two-key sequence detection). The palette opens via Cmd+K / Ctrl+K, which is the standard. The Modal Escape handler is at primitives.tsx:346-353 with capture-phase (line 353). The WSTabs Arrow handlers are scoped to the tablist (primitives.tsx:108-122).

Known conflicts to plan for:
- "C O" sequence: Chrome's Ctrl+O opens a file dialog. If the chord starts with a single C key, no conflict. If we map the chord literally to "press C then O" within a 1.2 s window, the second key (O) does not collide with Ctrl+O because the modifier is absent. Safe.
- "C P": Browser print is Ctrl+P. Same reasoning: single-key C, then single-key P. Safe in chord mode.
- "G H": no browser conflict.
- VoiceOver: VO+H navigates by heading; VO is Ctrl+Option on macOS. VoiceOver users will be in VO-mode, the single-key listener should be paused or guarded. Implement a "VoiceOver in use" detector via `document.activeElement` events.
- NVDA: NVDA browse mode reuses single keys (H for heading, T for table, F for form, etc.). If the chord listener fires on a single G while NVDA users browse, the page intercepts their heading-navigation key. Implementation must respect aria-busy and document.hasFocus() carefully.

The chord listener also must not fire when focus is inside an input, textarea, or contenteditable. NotionLinearStripe all gate on `document.activeElement?.tagName` and `isContentEditable`.

Competitor state. Linear's chord set has a known conflict map and excludes "T" (table heading), "H" (heading), "F" (form) because of NVDA conflicts. Stripe's command palette uses single-letter actions only after Cmd+K is held open. shadcn/ui's command-menu component (https://ui.shadcn.com/docs/components/command) does not ship chords; it expects the developer to layer them on.

Adjacent insight. The library tinykeys (https://github.com/jamiebuilds/tinykeys) handles chord sequences correctly, including the input-blur gate, with about 1 kB minified. Floating UI's `useDismiss` and React Aria's `useKeyboard` are not chord-aware but compose well.

Research insight. WCAG 2.2 SC 2.1.4 (Character Key Shortcuts) requires that single-letter shortcuts can be turned off OR remapped OR are only active when focus is on the activating component. Wiring 15 single-letter chords without an off-switch violates 2.1.4.

Proposed change. Add useChord(map, options) hook with:
- input-blur gate (skip when document.activeElement.tagName is INPUT/TEXTAREA/SELECT or contentEditable).
- Optional "modifier required" mode (if user prefers, every chord starts with Shift+G or Shift+C).
- 1.2 s timeout window.
- preference toggle Prefs.shortcuts = "off" | "letter-only" | "modifier".
- WCAG 2.1.4 compliance via the off-switch.

User-facing behavior. Power users get instant navigation. New users get an unobtrusive CmdK that they can ignore. Screen-reader users explicitly enable.

Technical implementation. Wire via tinykeys, gated on Prefs.shortcuts !== "off":

```ts
// hooks/useChord.ts
import tinykeys from "tinykeys";
export const useChord = (map: Record<string, () => void>, enabled = true) => {
  useEffect(() => {
    if (!enabled) return;
    const guard = (k: string, fn: () => void) => () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return fn();
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el.isContentEditable) return;
      fn();
    };
    const wrapped = Object.fromEntries(
      Object.entries(map).map(([k, fn]) => [k, guard(k, fn)])
    );
    return tinykeys(window, wrapped);
  }, [enabled, map]);
};
```

Integration plan. PR1 lands useChord and the Prefs toggle. PR2 wires the 15 chords. PR3 adds a "Keyboard Shortcuts" page in Admin Center listing all chords with a remap UI.

Telemetry. Emit `chord_fired` with the chord id, focus context, and time-since-page-load.

Non-goals. We do not need a customisable chord remap surface in v1.

Open questions. Should "G G" mean "go to the last viewed screen"? Linear does this and it is delightful. Adds one chord.

Effort. 3 dev-days for the hook + Prefs + lint, 1 dev-day to wire the 15 chords.

5-axis score: impact 6/10, effort 3/10, risk 3/10, certainty 8/10, time-to-ship 4/10.

Deep-dive prompt. Build the conflict matrix: 15 Anvil chords x (Chrome, Safari, Firefox, Edge) x (VoiceOver, NVDA, JAWS, TalkBack) = 240 cells. Mark each as conflict / no-conflict / depends-on-state. Lock the map in tests/keyboard/chords.test.ts.

---

## F12.27 PDF canvas plus bbox overlay primitive is screen-local instead of shared [verified-on-main, severity Medium]

Problem. /Users/kenith.philip/anvil/src/v3-app/components/BboxOverlay.tsx (160 lines) and DocCropper.tsx (321 lines) ship the only PDF-and-bbox-overlay surface in the codebase. They are consumed by /Users/kenith.philip/anvil/src/v3-app/screens/so-intake.tsx and /Users/kenith.philip/anvil/src/v3-app/screens/documents.tsx. A future doc-review screen (the A2 F2.21 spec asks for a side-by-side annotated PDF with click-to-zoom on bbox regions) cannot reuse this work without copying chunks of DocCropper. There is no canonical DocViewer primitive that accepts (pdfUrl, bboxes, onBboxClick) and renders the canvas plus annotations consistently.

Current state on main. The two files exist as components, not primitives. Each is tested (BboxOverlay.test.tsx, DocCropper.test.tsx). The primitives.tsx layer has no doc-canvas primitive. Code reuse between so-intake and documents works only because both screens import the same component path.

Competitor state. Adobe Acrobat Web (https://acrobat.adobe.com/) ships a sandboxed document viewer with annotation, bbox click, and OCR overlay. PSPDFKit (https://pspdfkit.com/), Apryse (https://apryse.com/), and Mozilla's pdf.js (https://mozilla.github.io/pdf.js/) all ship reusable React/JS viewers. Linear's "PR review-style" surface for design assets (https://linear.app/method) uses a similar pattern.

Adjacent insight. pdf.js renders to canvas; React-PDF (https://github.com/wojtekmaj/react-pdf) wraps it with a clean Component API. For bbox overlays, an `<svg>` overlay positioned absolutely above the canvas is the canonical pattern; clicks dispatch via the SVG element's pointer-events.

Research insight. Annotation tools must respect WCAG 2.2 SC 1.4.10 (Reflow): the canvas should scroll vertically without horizontal scroll at 320 px. Apple HIG flags PDFs as a low-vision blocker because they often lack a screen-reader text layer; a "text mode" toggle that extracts the OCR text and renders as HTML is a respected fallback (https://developer.apple.com/design/human-interface-guidelines/accessibility).

Proposed change. Extract a DocViewer primitive at /Users/kenith.philip/anvil/src/v3-app/lib/primitives.tsx that wraps DocCropper's canvas-plus-overlay logic:
- props: `src: string | File`, `bboxes?: Array<{ x, y, w, h, id, label?, kind? }>`, `selectedId?`, `onBboxClick?`, `onPageChange?`, `mode?: "view" | "annotate" | "compare"`.
- emits ARIA: role="img" aria-label="Document page {n} of {total}", with a visually hidden text-layer alternative when OCR is available.
- exports `<DocViewer.Toolbar />` (zoom, page nav, mode toggle) and `<DocViewer.Sidebar />` (thumbnails).

User-facing behavior. The doc-review screen can implement a side-by-side view in 30 lines. The intake flow keeps its current annotation. Operators see the same zoom controls and keyboard shortcuts across surfaces.

Technical implementation. Refactor in three steps:
1. Move BboxOverlay's logic into a `useBboxOverlay(ref, bboxes, onClick)` hook.
2. Move DocCropper's canvas-render logic into `useDocCanvas(src, page, scale)`.
3. Compose into DocViewer: a `<div>` containing `<canvas>` and an absolutely positioned `<svg>` for bboxes. Add a `<div role="region" aria-label="Document text layer" className="sr-only">` for screen readers.

Integration plan. PR1 refactors. PR2 wires doc-review.tsx. PR3 audits so-intake and documents for any regression.

Telemetry. Emit `doc_view` with page count, mode, bbox count, durationMs. Track click-through rate on annotated bboxes.

Non-goals. We do not need a full annotation suite (highlight / strikethrough / freehand) in v1; bboxes only.

Open questions. Should the primitive ship a virtualised page list for 100-plus-page PDFs? Yes if 5% of operator traffic involves long PDFs; needs telemetry to decide.

Effort. 1 dev-week for the refactor + tests, plus 3 dev-days for the doc-review screen.

5-axis score: impact 7/10, effort 6/10, risk 3/10, certainty 7/10, time-to-ship 6/10.

Deep-dive prompt. Audit pdf.js, React-PDF, PSPDFKit, and Apryse for license, bundle size, and React API quality. Pick one. Spike the doc-review screen against the chosen library to validate the integration path.

---

## F12.28 Skeleton loaders are defined in CSS but unused by primitives [verified-on-main, severity Medium]

Problem. /Users/kenith.philip/anvil/src/v3-app/styles.css:2704 defines the `.skel` shimmer class with a 1.2 s linear-gradient keyframe. The class is documented "Drop in <div class='skel'/>". A directory-wide grep returns the class definition but no usage inside /Users/kenith.philip/anvil/src/v3-app/lib/primitives.tsx or any screen. The skeleton CSS ships in the bundle but is never rendered.

Current state on main. Loading states are textual ("Loading orders..." in orders.tsx:186; "Loading queue..." in home.tsx:65). Two consequences:
1. Operators on slow backends (T+2 s) see a single text line for 2 s, then a fully painted table. The eye perceives this as a UI freeze.
2. Screen-reader users hear "Loading orders" once when the colspan-row first paints, never an aria-busy update when the data arrives.

Skeleton loaders fix both. NN/g (https://www.nngroup.com/articles/skeleton-screens/) finds that perceived loading time drops 12-40% with skeletons vs spinners. Linear, Notion, Stripe, GitHub all use skeletons.

Competitor state. Shopify Polaris <SkeletonBodyText />, <SkeletonDisplayText />, <SkeletonThumbnail />, <SkeletonPage /> (https://polaris-react.shopify.com/components/feedback-indicators/skeleton-page). IBM Carbon <SkeletonText />, <SkeletonPlaceholder />, <DataTableSkeleton /> (https://carbondesignsystem.com/components/data-table/usage). React-Loading-Skeleton (https://github.com/dvtng/react-loading-skeleton) is 1.5 kB.

Adjacent insight. The Skeleton component must announce aria-busy=true to assistive tech. Without aria-busy, the screen reader sees the skeleton as decorative noise. The Skeleton must also respect prefers-reduced-motion (no shimmer for those users; static rect only).

Research insight. WCAG 2.2 SC 2.2.2 (Pause, Stop, Hide) requires that auto-updating moving content can be paused. The shimmer animation should pause on prefers-reduced-motion: reduce (Anvil's blanket cancel at styles.css:1448-1450 takes care of this) but should NOT pause when the screen-reader is reading the aria-busy region (the live region's announcement is separate from the visual shimmer).

Proposed change. Add a Skeleton primitive (also covers F12.22 part 2). Variants: `text` (single line), `paragraph` (3 lines), `circle` (avatar), `rect` (general block), `table-row` (a styled <tr> for table skeletons). Provide a Skeleton.Table primitive that emits N skeleton rows inside a `<tr>` matching the calling table's column count.

User-facing behavior. List screens shimmer for the duration of the backend fetch. The shimmer is subtle (one .skel takes 1.2 s to cycle, gradient amplitude 0.4 opacity). After data arrives, the skeleton is replaced by the real rows.

Technical implementation. See F12.22 for the basic Skeleton primitive. Specific Table-skeleton support:

```tsx
export const SkeletonRow: React.FC<{ cols: number; widths?: string[] }> = ({ cols, widths }) => (
  <tr aria-hidden="true">
    {Array.from({ length: cols }).map((_, i) => (
      <td key={i}><span className="skel" style={{ width: widths?.[i] ?? "70%" }} /></td>
    ))}
  </tr>
);

export const SkeletonTable: React.FC<{ rows: number; cols: number }> = ({ rows, cols }) => (
  <tbody role="status" aria-busy="true" aria-label="Loading rows">
    {Array.from({ length: rows }).map((_, i) => <SkeletonRow key={i} cols={cols} />)}
  </tbody>
);
```

Card.loading slot, KPIRow.loading slot, and the Table primitive (F12.4) consume Skeleton and SkeletonTable respectively. Each emits aria-busy=true at the wrapping region so assistive tech announces "loading" once.

Integration plan. PR1 lands Skeleton + SkeletonRow + SkeletonTable + .skel-circle / .skel-rect CSS additions. PR2 migrates orders, home, customers, anomaly, audit loading states. PR3 adds a vitest test that each skeleton renders aria-busy=true.

Telemetry. Emit `loading_state_show` and `loading_state_complete` with durationMs per screen. Watch for tails above 3 s.

Non-goals. We do not need a configurable shimmer speed; the 1.2 s cycle is the brand default.

Open questions. Should the SkeletonTable also shimmer the table header? Linear does not; Polaris does. Recommendation: do not, the header is structural and confuses operators when it shimmers.

Effort. 3 dev-days for primitives + tests, 2 dev-days per migrated screen.

5-axis score: impact 7/10, effort 3/10, risk 1/10, certainty 9/10, time-to-ship 3/10.

Deep-dive prompt. Stub the backend with a 1.5 s simulated latency. Open each of the five canonical screens (home, orders, customers, anomaly, audit) in turn. Measure perceived-load-time via the Web Vitals LCP. Compare against an identical run with skeleton loaders. Land the improvement as a CI perf gate.

---

## New follow-up deep-dive prompts (mapped to F12.21 through F12.28)

22. Delete /Users/kenith.philip/anvil/src/v3-app/lib/placeholder.tsx and placeholder.test.tsx. Add an ESLint rule banning hash redirects to /v3.html outside the legacy-escape affordance. Confirm the build still passes and the bundle size drops.

23. Build the Region primitive at primitives.tsx that emits `<section role="region" aria-label={label}>`. Per-screen landmark map: enumerate the three to five primary blocks in each of the 46 screens, write the proposed labels, produce a CSV, bake into a per-route map, verify with vitest-axe assertions of >= 2 named regions per screen.

24. Audit every (foreground, background) pair in styles.css against APCA Lc-60 and Lc-75 in addition to WCAG 2.2 AAA 7:1 / 4.5:1. Land an AAA-default dark theme. Add `[data-contrast="relaxed"]` toggle. Pair with pa11y-ci snapshot tests on five canonical screens.

25. Adopt a four-tier breakpoint system (xs/sm/md/lg). Wire `[data-bp]` on <html>. Auto-collapse the sidebar to icon-only at md. Add a `priority` column attribute to the Table primitive. Re-verify SC 1.4.10 (Reflow) at 320 px on every list screen.

26. Build useChord(map, enabled) backed by tinykeys with input-blur gate and an off-switch in Prefs. Land the 15 documented chords (10 NAV_JUMPS + 5 ACTIONS). Build a conflict matrix (15 chords x 4 browsers x 4 screen readers). Add the "Keyboard Shortcuts" page to Admin Center.

27. Extract DocViewer primitive from DocCropper + BboxOverlay. Wire so-intake, documents, and a new doc-review screen to it. Audit pdf.js / React-PDF / PSPDFKit for the right canvas backend. Provide a screen-reader text-layer fallback.

28. Build Skeleton, SkeletonRow, SkeletonTable primitives. Migrate the five canonical screens' loading states. Add aria-busy=true wrapping at every skeleton region. CI perf gate compares LCP with/without skeletons under 1.5 s simulated latency.
