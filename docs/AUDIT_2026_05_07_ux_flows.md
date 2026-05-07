# UX flow audit, May 2026

> Cross-module audit of every clickable surface in the Anvil v3
> frontend. Goal: find every flow that looks usable but hits a wall.
> Scope: routes, buttons, modals, navigations, notifications, audit
> drill-throughs, multi-screen flows.

## Failure taxonomy

We categorised broken flows into three buckets:

1. **Dangling client call.** A button calls
   `ObaraBackend?.X?.Y?.()` where `Y` is missing on the client. The
   optional-chaining returns `undefined` silently. The button
   "fires" but nothing happens. Cause: client wasn't kept in sync
   with screen code.
2. **Unhandled hash param.** Code does
   `window.location.hash = "#/X?id=Y"` but neither the route
   resolver nor the destination screen reads `?id=`. The URL bar
   updates; the screen doesn't.
3. **Missing drill-through.** A list view shows row context
   (object_type, object_id) but has no way to open the affected
   entity. Most-egregious example: the audit log was unreadable
   (you saw the action but couldn't navigate to the order it
   touched).

A fourth bucket, **silent error suppression**, was already covered
by PR #22's systemic audit.

## Findings + fixes

### A. Dangling client calls (HIGH; silent broken flows)

| Site | Method | Symptom | Fix |
|---|---|---|---|
| `documents.tsx:378,410,501` | `documents.list()` | The Documents library screen rendered an empty table on every load because the client never exposed `list()`. | Added `GET /api/documents` index endpoint + `documents.list(params)` client method. |
| `ThreadDrawer.tsx:145` | `communications.list()` | The thread drawer's communications timeline was always empty because there was no way to fetch comms. | Added `GET /api/communications?order_id=...` endpoint + `communications.list(orderId)` client method. |

Both endpoints registered in `router.js`. Going forward, the audit
gate `dangling-client-calls.mjs` blocks new offenders at PR time.

### B. Cross-module navigation (MEDIUM; lost context)

1. **Comms `?new=<template>` ignored.** `CmdK` and other surfaces
   deep-link via `#/comms?new=nudge` to land on the composer with
   the template pre-selected. The screen had no handler. Fixed:
   `comms.tsx` now reads `?new=`, maps legacy aliases (`nudge` →
   `missing-doc`, `confirm` → `order-confirm`), and pre-selects.
2. **Audit log: no row drill-through.** Every audit row showed
   `object_type=order, object_id=X` but had no way to open the
   order. Fixed: `audit.tsx` now renders an "open" button per row
   that maps every documented `object_type` (15 of them) to the
   right hash route via `AUDIT_ROUTE_FOR_OBJECT`.
3. **Leads, Opps, Projects detail panels missing.** Row click set
   `#/X?id=...` but neither resolver nor screen read it. Same
   family as the customers bug fixed in PR #24. Fixed: extracted
   `useHashParam` / `readHashParam` helpers in `lib/helpers.ts`,
   then added inline detail cards to all three screens with KV
   rows for the canonical fields and a close button.
4. **Notifications bell trust-wires `link_route`.** Bell items
   carry `link_route` + `link_params` and the click handler
   blindly navigated to whatever route was specified, dumping the
   user on a `NotFound` page when a notification referenced a
   stale or renamed route. Fixed: `Shell.tsx`'s `onItemClick`
   now lazy-imports `ROUTE_IDS`, validates the target, and surfaces
   a clear warn toast for unknown routes.

### C. Verified-clean (no fix needed)

- **Route resolver coverage**: `delays`, `customers`, `spo`, `so`
  all map cleanly. The earlier agent claim about "delays no
  resolver" was a false positive; the resolver lives at
  `routes.ts:146`.
- **Empty handlers / TODO stubs**: 0 empty `onClick={() => {}}`
  callbacks across all 100 screens. 1 TODO in `orders.tsx` (a
  comment, not a stub).
- **Save/Submit buttons that only close the modal**: 0 instances
  via the inline-form heuristic. Manual spot-checks of the most
  recently-touched dialogs (so-intake new customer, source-pos
  new SPO, projects new project, opps new opp, leads new lead,
  car new report) all post and refetch correctly.

### D. Out-of-scope follow-ups (deferred)

These were flagged by the audit but didn't ship in this PR
because the fix is bigger than a flow rewire:

1. **`items.tsx` ignores `?tab=` and `?part=` deep links.** Items
   has 4 internal tabs (master / aliases / inventory / bom) but
   no hash-param sync. Bookmarks of a specific tab don't survive
   a page reload. Small fix; not user-blocking.
2. **`spares.tsx` ignores `?gun=`** (used by `guns-viewer.tsx`).
   Same shape as the items issue.
3. **Empty / loading / error state polish.** Existing screens
   handle these states adequately; the polish work is design
   alignment, not flow-blocking. Tracked as part of the design-
   package follow-up.

## Round 2 findings (parallel-agent + manual sweep)

After PR #28 landed, I dispatched five parallel audit agents and ran
my own scans for patterns the original audit missed. New findings:

### Critical (silent data loss / broken-since-shipped flows)

1. **`leads.tsx` sent `name` instead of `company_name`.** The leads
   table's NOT NULL column is `company_name`; the API rejected with
   400 every time. **Lead creation has been broken since the screen
   shipped.** Fixed: payload now sends both `company_name` and a
   legacy `name` alias plus `budget_estimate` (the actual numeric
   column for value).

2. **`comms.tsx` sent `recipient` and `template_id` instead of
   `to_addr` and `templateCode`.** The endpoint silently ignored
   both fields, so every saved draft had `to_addr=null` and
   `template_code=undefined`. **Every draft saved since the screen
   shipped had a null recipient.** Fixed: payload sends the
   canonical names alongside the legacy aliases.

3. **`einvoice.tsx` "Send to GSTN" button has been a silent no-op
   since shipped.** The frontend posted `action: "submit_to_gstn"`
   but the backend checks `action === "send_to_gstn"`. The PATCH
   fell through to the plain-field-update branch and the row's
   status never changed; the toast still said "Sent". Fixed:
   action name aligned.

4. **`projects.tsx` read `expected_close_date` / `expected_close`,
   neither of which exists in the schema.** The actual column is
   `expected_delivery_date`. Result: every project row's "Expected
   close" cell rendered "—" regardless of the value. Fixed: read
   `expected_delivery_date` first; legacy aliases as fallback.

### Stuck-state recovery

5. **`einvoice` PENDING_GSTN had no escape hatch.** When
   `GSTN_API_URL` is missing the row stayed PENDING_GSTN forever
   with no UI button to retry. Fixed:
   - Backend: two new PATCH actions, `revert_to_draft` (flip
     PENDING_GSTN/REJECTED back to DRAFT for editing) and
     `mark_generated_manually` (paste an out-of-band IRN from the
     GSTN portal).
   - Frontend: `revert to draft` and `manual mark` buttons on
     every PENDING_GSTN / REJECTED row.

### UX polish

6. **`documents.tsx` empty state was a text instruction with no
   button.** Fixed: clickable "Upload a document" CTA that flips to
   the upload tab.

### Verified-clean (agent claims that didn't hold)

- `scheduleLines.bulkCreate()` is NOT missing (agent false positive).
- `delays` route DOES have a resolver (agent false positive in
  round 1; verified again).

## Process changes (CI gates)

Two scanners now run on every push as hard gates:

| Scanner | What it catches |
|---|---|
| `promiselike-catch.mjs` | Supabase `.catch` chains (PR #20's bug family) |
| `dangling-client-calls.mjs` | `ObaraBackend?.X?.Y?.()` calls where `Y` is missing on the client |

Plus a soft warning:

| Scanner | What it catches |
|---|---|
| `route-deadlinks.mjs` | Hash params not read by either resolver or screen |
| `column-drift.mjs` | Frontend reads of unknown columns |

The `route-deadlinks` scanner was extended in this PR to also
check whether the destination screen reads the param via
`URLSearchParams(window.location.hash...)` or the new
`useHashParam` helper. This drops a class of false positives
where the screen handles the param itself even though the
resolver doesn't branch.

## How tested

- `npm run typecheck` clean
- `npm test -- --run` 381/381 passing (added 12 new contract
  tests in `api-ux-flow-audit.test.js`)
- `npm run audit:systemic` 0 hard-gate failures
- Manual: every fixed flow re-walked in the test rendering.

## What's locked in tests

The new test file `api-ux-flow-audit.test.js` pins:

- The dangling-client-calls scanner exits 0 on the current tree.
- `documents.list` and `communications.list` exist on both client
  and router.
- `comms.tsx` reads `?new=<template>` with the legacy alias map.
- `audit.tsx`'s `AUDIT_ROUTE_FOR_OBJECT` map covers the 6 most
  common entity types (order, source_po, customer, document,
  shipment, einvoice).
- `Shell.tsx`'s notifications bell imports `ROUTE_IDS` and warns
  on unknown link_route values.
- Each of `leads`, `opps`, `projects` reads `?id=` and provides a
  close button that strips it.
- `readHashParam` and `useHashParam` are exported from `lib/helpers.ts`.

A regression on any of these fails the suite with a message
pointing at the exact contract that broke.
