# Archive

Historical docs kept here for reference. They reflect the state of
the codebase at the time they were written; nothing here is the
current source of truth.

When a doc lands in this folder, that's the signal to read the live
counterpart instead. The cross-reference table:

| Archived | Was about | Current source of truth |
|----------|-----------|-------------------------|
| `AUDIT_2026_05_07_ux_flows.md` | UX-flow audit findings (May 7 2026) | All findings closed; no live successor |
| `AUDIT_2026_05_systemic.md` | Systemic audit findings (May 6 2026) | All findings closed; see `docs/SECURITY_AUDIT_2026_05.md` for security-side audits |
| `V3_ARCHITECTURE_AUDIT.md` | Pre-Vite v3 architecture review | Vite migration done; see `docs/ARCHITECTURE.md` |
| `V3_VERIFICATION.md` | Phase 5 cutover checklist | Cutover done; see `docs/V3_VITE_MIGRATION_REPORT.md` |
| `GAP_ANALYSIS.md` | Self-declared "Superseded" gap doc | See `docs/IMPROVEMENT_PLAN.md` |
| `ROADMAP.md` | Self-declared "Superseded" roadmap | See `docs/IMPROVEMENT_PLAN.md` + `docs/DEFERRED_ROADMAP.md` |
| `MIGRATING_BRAND.md` | Obara to Anvil rename | Migration complete; reference for new tenants |

Don't delete files from this folder; they're useful as a record of
what shipped + when. If a finding from one of these resurfaces, the
recovery path is to update the live counterpart, not to revive the
archive.
