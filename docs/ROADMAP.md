# Anvil Roadmap

Living document of work that is planned but not yet shipped, kept next to the
code so it does not drift out of sync with the implementation.

Last updated: 2026-05-02.

## Now

### v3 design overhaul (in progress)
Replacing the 4756-line legacy shell + 35 modal-driven flows with the v3
operator console. Scope:

- Anvil v3 design tokens (light + dark, IBM Plex fonts, chartreuse accent).
- New Shell (header, sidebar, dock) with Cmd+K palette + Thread drawer.
- 30 route screens, every former modal becomes a route or a sub-tab.
- Native Sales Order intake + workspace, replacing the legacy SO-Agent React
  iframe component. The legacy component is preserved at `src/legacy/` for
  reference until the cutover ships.
- Role-based access control: 7 roles, each with explicit route + action
  permissions. See `docs/RBAC.md`.
- Feature flag: `?v3=1` opts a tab into the new shell. Flag flips to default
  after the verification phase passes. Legacy shell stays available at `?v3=0`
  through one release cycle, then is deleted in a follow-up PR.

Tracking: see the migration plan in conversation thread + the per-wave PR
sequence under `feature/v3-*` branches.

## Next

### Mobile shell (post-v3 cutover)
The v3 design system already provides mobile screens in
`screens-mobile.jsx` (MobileSignIn, MobileApprovals, MobileCapture,
MobileOrderDetail, plus state screens for empty / error / offline). They
are not wired up in the first v3 release. Plan:

1. Add a viewport check to the v3 App router. On `< 768px`, render the
   mobile shell instead of the desktop Shell. Mobile shell is single-column
   with a bottom tab bar (Home, Inbox, Approvals, Search, More).
2. Mobile-specific surfaces:
   - Sign in via magic link (mobile-friendly form).
   - Approvals queue (manager role) with one-tap approve / reject.
   - Capture flow (PO upload from camera + classification).
   - Order detail read-only view with status timeline.
3. Touch targets: all interactive elements 44 × 44 px minimum.
4. Offline-friendly: cache the last 50 viewed orders + customers in IndexedDB.
5. Push notifications for approval-needed events (Service Worker + Web Push).

Estimated: 2 weeks.

### Native iOS app (research only)
The `screens-mobile.jsx` patterns map cleanly to SwiftUI. If the mobile web
shell adoption is < 30% of approvals after 3 months, we re-evaluate a thin
native wrapper. Not committed.

## Later

### RBAC ergonomics
- Self-service tenant invites: admin can issue a magic-link invite with a
  pre-bound role.
- Role audit log: every role change recorded in `audit_events` with the
  before / after pair.
- Policy DSL: replace hardcoded role-route table with a YAML policy file
  loaded at build time.

### Internationalization
- Locale switch (English IN default, with hooks for additional locales).
- Number formatting respects `tnum` so en-IN and en-US look identical in the
  table grid.
- INR / USD / JPY / CNY dual-display pattern: store in source currency,
  display in tenant currency, both shown in tooltips.

### Notifications
- Browser push for approval-needed.
- Slack channel webhook for tenant admins (`OBARA-IN-alerts`).
- Email digest for managers (weekly margin summary).

### Real-time
- Supabase Realtime channel for `orders` table → live update of the SO list
  when another user pushes to Tally.
- Live presence indicator in Cmd+K (who's looking at the same order).

### Power-user features
- Saved filters per route (server-side, scoped to user).
- Bulk actions on the SO list (select N rows + assign owner / set tag).
- Quick-keys per nav item (`G H` for home, `G I` for inbox, etc.).
- "Snooze until" on findings + approvals, instead of binary resolved.

## Tracking

- Mobile sub-tasks: open issues with label `area:mobile`.
- v3 sub-tasks: open issues with label `area:v3`.
- This file is the source of truth; if you add a roadmap item in a comment,
  PR description, or Slack thread, copy it here too.
