# Anvil Roadmap

Living document of work that is planned but not yet shipped, kept next to the
code so it does not drift out of sync with the implementation.

Last updated: 2026-05-03.

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

### v3 migration gap closures (Phase 7) — substantially complete

Phase 7 closed the major user-visible gaps from the Phase 6 migration
audit. Status of each sub-release:

- 7.1 Spare Matrix worksheet: **DONE** (commit 70d7838).
- 7.2 BOM Import workflow: **DONE** (commit 70d7838).
- 7.3 Guns viewer: **DONE** (commit 70d7838).
- 7.4 SO History import: **DONE** (commit 70d7838).
- 7.5 JBM spare matrix importer: **DONE** (commit 70d7838).
- 7.6 Equipment hierarchy editor: **DONE** (commit 70d7838).
- 7.7 Project + Opportunity enum alignment: **DONE** (commit 1fa7aca).
- 7.8 CRUD completeness: **PARTIAL** (commit a67e9f2 covers Shipments,
  Internal SOs, e-Invoice). Remaining: see below.
- 7.9 Master Data Graph Cytoscape view: **DONE** (commit 70d7838).
- 7.10 Drawing-link configuration: **DONE** (commit 70d7838 inside
  AdminCenter Settings tab).
- 7.11 Storage status / Diagnostics tab: **DONE** (commit 70d7838 +
  api/admin/diagnostics.js).
- 7.12 Schedule Lines editor: **DONE** (commit 70d7838 inside
  SOWorkspace as a 9th tab).
- 7.13 Communications timeline merge: **DONE** (commit 70d7838 inside
  the SOWorkspace Activity tab, merging audit_events +
  communications + processing_events into one chronological feed).

### Phase 7.8 CRUD remaining (~5 surfaces)

These wired screens have read-only views but no create / edit / delete:

- **Service Visits**: check-in / check-out / delete actions and a
  plan-visit form (date + technician + checklist).
- **AMC**: bulk-seed UI (contract picker + frequency form), per-row
  Generate-visit button, per-row delete.
- **Eval Cases**: add / run / delete cases form (the fourth legacy tab
  that existed inside the eval modal).
- **Profile Studio**: visual fingerprint diff editor with
  edit-and-save (currently rollback-only).
- **Admin Center**: customer locations editor, item master inline
  edit, contracts manager (ARC / Blanket / AMC), CSV bulk import
  wizard, holiday delete, approval thresholds CRUD (currently
  read-only).

Each is approximately the same shape as the Shipments / Internal SOs /
e-Invoice CRUD overlays already shipped: a `wired-X-crud.jsx` file that
overrides `wired-X.jsx` via build-v3.mjs load order. The pattern is
codified in [docs/V3_WIRING_PATTERN.md](V3_WIRING_PATTERN.md).

7.1. **Spare Matrix worksheet** (largest user-impact gap)
- Per-customer/project worksheet with editable rows + columns.
- Add row, add spare column, configure columns dialog.
- Auto-fill all from gun BOMs, template download, multi-format
  import preview (XLSX / CSV / TSV / JSON).
- Recommended Spares sub-tab with sync-from-matrix button + Excel
  export.
- Lives at `#/spares?worksheet=1` or as a sub-tab inside the
  existing Spares Matrix screen.

7.2. **BOM Import workflow**
- Multi-file XLSX/XLS upload with origin auto-detection (India /
  Korea / China / Japan).
- Drag-drop zone, file queue, hierarchy markers L1/L2/L3.
- Gun-number auto-suggest, mod-detection diff.
- Lives as a sub-tab inside Items > BOM with "Import" button.

7.3. **Guns viewer**
- Two-pane gun list + BOM detail viewer.
- Assembly hierarchy, drawing PDF link, customer-usage chips,
  click-to-spare-matrix navigation.
- Lives at `#/items?view=guns` or as a sub-tab on Items.

7.4. **SO History import**
- Drag-drop XLSX/XLS/CSV/TSV/TXT.
- Format auto-detection (PO-tracker layout vs Tally export).
- Multi-format export (XLSX/CSV/TSV/JSON).
- Lives at `#/so?view=history` or its own nav id.

7.5. **JBM spare matrix importer**
- One-click XLSX -> equipment_hierarchy + equipment_installed_parts.
- Schema and API exist; only UI is missing.
- Lives inside Items > BOM as a customer-specific import variant.

7.6. **Equipment hierarchy editor**
- No v3 surface for the `equipment_hierarchy` table at all.
- Tree-view editor with add/remove/move nodes.
- Lives at `#/items?view=equipment` or under Service.

7.7. **Project/Opportunity enum migration**
- Legacy phase enum (`INSTALLATION_COMMISSIONING / LB_FINALIZATION /
  KICKOFF / PAYMENT_FOLLOWUP`) vs v3 phase enum (`MATERIALS_IN /
  MANUFACTURING / FAT / SAT`).
- Same drift on `opportunities.stage`.
- Decide on canonical taxonomy, data migration script, UI updates.

7.8. **CRUD completeness on existing wired screens**
- Shipments: create form, status update, POD-received toggle, delete.
- Service Visits: check-in / check-out / delete + plan-visit form.
- Internal SOs: per-type create form (FOC/Warranty/Trial/Expected/
  Transfer).
- Tally Masters: XML/JSON upload to seed masters.
- AMC: bulk-seed UI + Generate-visit + delete per row.
- Eval Suites: cases editor (add/run/delete).
- Profile Studio: visual fingerprint diff with edit-and-save.
- Admin Center: customer locations editor, item master inline edit,
  contracts manager, equipment hierarchy editor, holiday delete,
  approval thresholds CRUD.
- e-Invoice: compose-draft form + Send to GSTN action.

7.9. **Master Data Graph Cytoscape view**
- Replace the placeholder list with a real Cytoscape graph.
- Customer / order / part / supplier nodes, drillable.

7.10. **Drawing-link configuration**
- Legacy Settings tab has OneDrive base URL for drawing PDFs.
- Add a tab to AdminCenter > Settings.

7.11. **Storage status / Diagnostics tab**
- AdminCenter > Diagnostics is currently a placeholder.
- Build `/api/admin/diagnostics` endpoint.
- Surface localStorage usage, last backup time, integration health.

7.12. **Schedule Lines editor**
- Per-order TSV-paste delivery schedule editor inside SOWorkspace.
- API method `scheduleLines.bulkCreate / clear / deleteOne` exists.

7.13. **Communications timeline merge**
- SOWorkspace > Activity tab currently shows audit events only.
- Merge `communications` + `processing_events` for full timeline.

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
