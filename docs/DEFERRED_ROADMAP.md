# Deferred Roadmap

> **See also**: `docs/IMPROVEMENT_PLAN.md` is the active source of truth
> for shipped vs. pending work. This file is the narrower companion that
> covers items requiring product or program decisions before code can
> proceed (voice AI scope, vertical-pack scope, native iOS, SOC 2 program
> kickoff). When a deferred item gets a decision and code is greenlit, it
> moves into a phase in IMPROVEMENT_PLAN.md.

This doc covers items the gap analysis flagged in **Later** that we
have **deliberately not built in code yet**. Each item explains
*why* it's deferred (what scope decision needs to land first), what
we'd build if green-lit, and what's already in place that the work
would build on.

If you're picking one of these up: search this file, copy the
acceptance criteria, and open a ticket.

---

## 1. Voice AI

**Status**: shipped (May 2026). Pilot-ready pending the
operational + legal items called out at the end.

**Shipped (May 2026)**:

- ✓ `voice_configs`, `voice_calls`, `voice_call_actions` tables
  (migration 041).
- ✓ `voice_consent` + `voice_dnd_list` tables (migration 080).
- ✓ `/api/voice/webhook` (Vapi + Retell adapters) with
  signature verification.
- ✓ `/api/voice/outbound`: compliance-gated dialler. Refuses
  before placing the call when the destination is on a DND
  list (TRAI NDNC, FCC DNC, tenant-manual, customer-request)
  or when there is no active voice_consent row. Audits both
  refusals and successful placements.
- ✓ `/api/voice/consent`: GET / POST / DELETE consent records.
  Withdraw is a soft-delete (`withdrawn_at`) so the trail is
  preserved for audit.
- ✓ `/api/voice/process_actions`: drains `voice_call_actions`
  every 5 min via cron tick, creates DRAFT orders / processing
  events.
- ✓ `voice_followup` autonomous-agent handler (registered in
  `_handlers/index.js`, expanded into the agent_goals
  CHECK constraint by migration 080). When a call ends with a
  pending callback intent, the runtime arms a goal here; the
  handler emits a `place_outbound_call` action that the runner
  posts to `/api/voice/outbound`.
- ✓ `_lib/voice-compliance.js`: pure helpers for E.164
  normalization, region detection, recording-disclosure
  templates per region/locale (IN en + hi, US, EU, UK, AE, SG,
  OTHER), DND lookup, consent lookup, and the full
  pre-call gate.
- ✓ `screens/voice.tsx` operator UI: Calls / Outbound / Consent
  tabs, with consent capture + withdrawal, compliance posture
  surfaced in a KPI row, and an outbound form that pre-checks
  via the same gate before submitting.

**Operational items still needed before pilot launch** (not
engineering work):

- Pick **Vapi or Retell** based on Indian-network latency tests
  with a real pilot tenant.
- **Counsel review** of the per-region recording-disclosure
  copy in `_lib/voice-compliance.js`. The shipped templates are
  reasonable defaults; legal sign-off may revise the wording.
- **TRAI NDNC / FCC DNC list integration**. The `voice_dnd_list`
  table is in place with `source = 'trai_ndnc'` /
  `'fcc_dnc'` rows reserved; a small cron worker pulls the
  registry snapshot periodically. Out of scope for this PR
  because the registry credentials are operator-side.
- **Outbound enable**: `voice_configs.outbound_enabled` is
  `false` by default. The tenant flips this to `true` after
  their compliance review. The outbound endpoint refuses to
  dial when it's off, regardless of per-number consent.
- **Compliance review acknowledgement**: the
  `voice_configs.compliance_reviewed_at` column captures the
  most-recent operator attestation. Annual renewal expected
  per DPDP / GDPR / TCPA.

---

## 2. Vertical packs

**Status**: scope approved (May 2026), not yet implemented.

**Approved scope**: ship every potential vertical, prioritised by
TAM (largest first). The opening cut, with the rough Indian
B2B-distribution TAM band each one anchors to:

1. **Industrial pumps + valves + flow control** (largest, ~₹35k cr
   annual distribution spend; OBARA-shaped customers).
2. **Bearings + power transmission** (~₹25k cr; SKF / FAG / NSK
   distributor channel).
3. **HVAC + refrigeration distribution** (~₹20k cr; chillers +
   ducting + spares).
4. **MRO + industrial fasteners + abrasives** (~₹18k cr; long
   tail of catalogue items).
5. **Machine tools + cutting tools + tooling spares** (~₹15k cr;
   capital + consumable mix).
6. **Process instrumentation + electrical control gear**
   (~₹12k cr; Siemens / ABB / Schneider partner channel).

Each pack ships as a **configuration pack** first (1 week per
vertical: seed lead times, approval thresholds, contract types,
lost-reason taxonomy, GAEB / item-master starter content). A
follow-up **code pack** lands per-vertical only when a paying
pilot proves a code-level workflow (~3 weeks each).

**What would land in Anvil if green-lit** (~1 week per vertical
for config-pack mode, ~3 weeks per vertical for code-pack mode):

- New `tenant_settings.vertical` text column with a free-form
  vertical id (e.g., `hvac_distribution`).
- New seed runner `/api/admin/install_vertical_pack` that loads
  approval thresholds, contract types, lead-time defaults, lost-
  reason values from a JSON pack at `src/v3-app/verticals/<id>.json`.
- For code-packs: a `verticals/` folder of conditionally-rendered
  components keyed off `tenant_settings.vertical`.

**Already in place**: every CRUD endpoint that takes seed data is
admin-gated (members, holidays, lead times, thresholds, contracts,
items). The plumbing is here; we're missing the curated content.

---

## 3. Native iOS

**Status**: **declined (May 2026)**. Will not build.

The PWA mobile shell (`MobileShell.tsx` + `public/sw.js` +
`/api/push/*` web push) covers the four operator flows that
actually matter on the go: My Day, Inbox, Approvals, Sales
Orders. The reliability and marketing gains from a native
build do not justify a Capacitor or React Native track plus
the maintenance cost of two app distributions.

If a customer requires App Store presence later, this can be
re-opened: the `push_subscriptions` table already supports
`channel='apns'` + `device_token`, so an APNs branch in
`/api/push/send` is the only meaningful code addition. The PWA
shell is fine until then.

---

## 4. SOC 2 / ISO 27001

**Status**: in progress (May 2026). GRC vendor selection +
observation window kickoff under way; code-side controls
listed below are mostly shipped.

**Why deferred**: SOC 2 Type II and ISO 27001 are organisational
certifications. They require:

- A written security program (policies, procedures, risk register).
- Continuous monitoring evidence (audit logs, access reviews).
- An audit firm (Drata, Vanta, Secureframe; then a CPA firm for
  Type II).
- Multi-month observation window (3+ months for Type II).

Code work is a small part of the program. What's relevant for the
codebase:

**Code-side controls already shipped**:

- Audit logging on every mutation (`audit_events` table; verified
  by `audit-write-paths.mjs`).
- RLS on every per-tenant table (verified by `audit-rbac.mjs`).
- Per-tenant credential encryption with AES-256-GCM (`secrets.js`,
  used by NetSuite/SAP/D365/Acumatica/Tally/Razorpay/DocuSign).
- Webhook signature verification (Stripe, Razorpay, DocuSign).
- 401 handling that clears session and forces re-auth.
- Redaction of PII in LLM prompts (`/api/claude/messages.js`).
- Service-role isolation: only server-side endpoints carry it.
- Idempotency keys on every external push (Tally, NetSuite, SAP,
  D365, Acumatica).

**Code-side controls (May 2026):**

- ✓ **Access review** endpoint: `/api/admin/access_review.js`.
  Monthly snapshot of every member's role per tenant; signed
  acknowledgement persisted for evidence.
- ✓ **Audit log export** endpoint: `/api/audit/export.js`.
  Time-bounded HMAC-signed JSONL dump of `audit_events`.
- ✓ **Change log** for production deploys: `/api/deploys` +
  `deploy_events` table (migration 079). Vercel deploy hook
  POSTs each event; auditors read GET. SOC 2 CC8.1 evidence.
- ✓ **Vulnerability scan runbook**: `docs/VULN_SCAN_RUNBOOK.md`.
  Weekly Dependabot + npm audit + Snyk triage workflow with
  patch-now / patch-this-sprint / VEX-rejected / accept-risk
  dispositions. SOC 2 CC7.1 + CC7.2.
- ✓ **Incident response playbook**: `docs/INCIDENT_RESPONSE.md`.
  Severity ladder, 7-step runbook (triage / classify / contain /
  investigate / remediate / communicate / post-mortem),
  drill cadence. SOC 2 CC7.4.

**What's a program-level item**:

- Vendor management (DocuSign, SendGrid, Twilio etc. signed BAAs/
  DPAs).
- Risk register, security policy doc, encryption-at-rest doc.
- Background checks for engineering hires.
- Access provisioning + deprovisioning tickets.

These don't go in the codebase; they go in your security-program
folder + GRC tool (Drata is the typical pick).

---

## What's not on this list

The original "Later" block also mentioned a few items that are
**already shipped** in the recent commits and don't need a roadmap
entry:

- NetSuite credential encryption-at-rest -> shipped commit
  `1b7036e` (NetSuite v2)
- NetSuite cursor-based sync checkpointing -> shipped commit
  `1b7036e`
- Mobile push notifications -> shipped this commit (web-push,
  service worker, push_subscriptions schema)
- Razorpay sibling for India tenants -> shipped this commit
  (`/api/billing/razorpay/*`)

If those resurface in a roadmap doc later, point at the commit and
the migration that landed them.

## Summary

| Item            | Status (May 2026)        | Next step                                              |
|-----------------|--------------------------|--------------------------------------------------------|
| Voice AI        | Scope approved           | Pick Vapi vs Retell on Indian-network latency; 3w build |
| Vertical packs  | Scope approved           | Ship config-pack #1 (industrial pumps); 1w each         |
| Native iOS      | Declined                 | PWA shell stays as the mobile surface                  |
| SOC 2 / ISO     | Program in progress      | Land the access-review + audit-export endpoints        |
