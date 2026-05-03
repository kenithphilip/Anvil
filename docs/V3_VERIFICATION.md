# v3 Verification Checklist (Phase 5)

Run this before flipping the default load away from legacy. Each item is a
hard pass/fail; record results inline as `[x]` / `[ ]`.

## Build pipeline

- [ ] `npm run check` exits 0 (every JS/JSX file syntax-clean).
- [ ] `npm run build` produces both `public/index.html` (legacy) and
      `public/v3-app/` (v3) without warnings.
- [ ] `npm run verify` reports `0 failed` on script blocks.
- [ ] No new files in `node_modules/` or unstaged secrets.

## Feature flag

- [ ] Open `/?v3=1` → redirects to `/v3-app/`, pins
      `localStorage.obara:v3_pinned = "1"`.
- [ ] Open `/?v3=0` → unpins and lands on the legacy shell.
- [ ] Open `/` while pinned → lands on `/v3-app/` (no manual flag needed).
- [ ] Open `/v3-app/?v3=0` → unpins, redirects to `/`.
- [ ] Reload the v3 page → still v3 (pin survives).

## Shell & navigation

- [ ] Sidebar lists 9 sections, route count varies by role.
- [ ] Click each nav item → workspace updates; active state highlights left.
- [ ] Cmd+K opens palette; Esc closes.
- [ ] Search "OIQ" → orders matching show up in palette.
- [ ] Search a customer name → customer matches show up.
- [ ] Arrow keys navigate the palette; Enter activates.
- [ ] Thread drawer opens via header button + closes on Esc + backdrop.
- [ ] Tenant pill shows "OBARA-IN" (or local override).
- [ ] Role pill cycles through 7 roles. Sidebar updates per role.

## Theme & density

- [ ] Default theme is dark (per user request).
- [ ] Click theme button in floating bar → toggles light/dark, persists.
- [ ] Density button cycles compact / normal / comfortable; row heights
      change accordingly.
- [ ] Sidebar collapse button hides labels, keeps icons.

## RBAC

- [ ] As `viewer`, no write/approve buttons render. Sidebar still shows
      every readable route.
- [ ] As `sales_engineer`, "approvals" route is hidden in admin/security.
- [ ] As `admin`, every route is visible including security + admin.
- [ ] Switching role re-filters the sidebar instantly (no reload).
- [ ] Try to navigate to `#/admin` as `viewer` → bounces to `#/home` per
      app.jsx safeguard.
- [ ] `RBAC.canDo("so.push_tally")` returns false for `viewer`,
      `sales_engineer`; true for `sales_manager`, `finance`, `admin`.

## Wired data on every route (smoke test as `admin`)

For each of the 30 routes, click the nav item and confirm the screen
either:
1. shows real data fetched from ObaraBackend, or
2. shows an empty-state explanatory message, or
3. shows a clearly-labeled error banner with retry.

A blank or mock-data render = fail.

| Route | Source(s) | Smoke test |
| --- | --- | --- |
| home | orders.list, audit.list | KPI numbers match orders count |
| intake | documents+email | Inbox table renders |
| so | orders.list | Tabs filter; row click → so workspace |
| internal | sales.listInternalSos | type chip per row |
| approvals | quote_approvals | pending count > 0 (if any) |
| leads | sales.listLeads | empty state if no leads |
| opps | sales.listOpportunities | kanban renders |
| projects | sales.listProjects | phase chips |
| shipments | sales.listShipments | status chips |
| spo | sourcePos.list | scorecard KPIs |
| spares | spareMatrix.recommend | regenerate button works |
| svc-visits | service.visits | scheduled tab |
| amc | service.amc | next visit countdown |
| car | service.car_reports | severity chips |
| tally | orders.list (status filters) | push queue + recently pushed |
| einvoice | einvoice.list | 4-tab queue |
| cost | cost.breakdown | bar chart renders |
| customers | customers.list | search filters live |
| items | item_master | aliases / inventory / BOM tabs |
| graph | masterData.graph | stats render |
| forecasts | forecast.pipeline | tabs render |
| evals | evalExt.dashboard | pass rate KPI |
| studio | profileVersions.list | version list |
| anomaly | findings | open / resolved / suppressed |
| duplicates | duplicates.search | candidates row |
| comms | audit (drafts) | composer renders |
| email | email.inbound | two-pane layout |
| security | security.* | admin-only |
| audit | audit.list | filter bar |
| admin | admin.* | tabs render per area |

## WCAG (semi-automated)

- [ ] HTML has `lang="en"`.
- [ ] Skip link `<a href="#v3-root" class="skip-link">` present, becomes
      visible on focus.
- [ ] Every clickable rendered as `<button>` (via `<Btn>`) or `<a href>`,
      not bare `<div onClick>`. Quick grep:
      `grep -rE 'onClick=' src/v3-app/screens/ | grep -v "<Btn\\|<button\\|<a "`
      should return `0` rows ideally.
- [ ] Contrast: chartreuse accent on dark theme = 4.6:1 (passes).
      Ink #ECECE6 on #16181B (paper) = 14:1 (passes AA + AAA).
- [ ] Forms: every `<input>` has an associated `<label>` or
      `aria-label`.
- [ ] Tables use `<thead>` + `<th>` (semantic).
- [ ] Modal dialogs (Cmd+K, ThreadDrawer) have `role="dialog"`,
      `aria-modal="true"`, and trap focus.

## Spill / overflow

- [ ] Resize the window to 1280×720 → no horizontal scrollbar.
- [ ] Resize to 1920×1080 → content fills width, no awkward gaps.
- [ ] Resize to 1100×720 → sidebar collapses or content reflows; no
      clipped chips/buttons.
- [ ] Long customer names truncate with `text-overflow: ellipsis`
      (already on `.tbl td`), no breaking the row.
- [ ] Long PO numbers in `.mono` columns wrap or scroll horizontally
      inside the cell, never push the row width.

## Cross-screen integration

- [ ] Click a row in `home > my queue` → lands in
      `#/so?id=<id>` and the workspace loads that order.
- [ ] On SOWorkspace, the breadcrumb in the header reads
      "Anvil / Workflows / Sales Orders / <ref>".
- [ ] Click "Push to Tally" (as a finance role) → calls
      `tally.push` and shows status banner.
- [ ] Open Cmd+K, type a known order number → palette navigates to
      that order on Enter.

## Final

- [ ] All commits pushed to `origin/main`.
- [ ] `docs/USER_GUIDE.md` updated (if user-facing change).
- [ ] `docs/V3_ROUTE_CONTRACT.md` matches the wired files.
- [ ] No stray `console.log` in production code:
      `grep -r 'console.log' src/v3-app/screens/` should be 0.
