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

**Status**: scope approved (May 2026), not yet implemented.

**Approved scope**:

- **Both** inbound and outbound calls.
- **Full conversational agent**, not transcription-only. Same
  action vocabulary the existing voice/process_actions worker
  already drains (place_order, quote_request, check_delivery,
  verify_customer, escalate, note); the realtime layer just
  plugs into the same downstream.
- **Provider**: Vapi or Retell (both are wired in
  `voice/webhook.js`); pick the one whose Indian-network
  latency tests cleanest in pilot.

**What still needs decision before code**:

- Recording-disclosure copy per region (US single-party, EU
  two-party, India two-party). Not blocking the realtime work,
  blocking the launch.
- Outbound dialler compliance: TRAI DND scrubbing for India,
  TCPA prior consent for US numbers. Either we wire to a
  compliance vendor's API, or we limit outbound to numbers the
  customer has already messaged us from.

**What would land in Anvil** (~3 weeks):

- New `voice_calls` table (call_id, direction, started_at,
  duration_s, transcript, summary, action_extracted_jsonb).
- `/api/voice/webhook` to receive transcripts from the realtime
  provider, write to the table, audit `voice_call_received`.
- New autonomous-agent goal type `voice_followup` that consumes
  the extracted actions (intake from a phone PO, AR collection
  callback, service-visit scheduling).
- Consent + recording-disclosure UI per region (US single-party,
  GDPR two-party, etc.). This is the feature we'd actually need
  legal sign-off for.

**Already in place**: `/api/agents/run.js` (the autonomous agent
runtime), `/api/communications/send.js` (could route a call summary
to email/WhatsApp), redaction helpers in `/api/_lib/audit.js`.

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

**Code-side controls still owed when the program kicks off** (~2 weeks
of work spread over the audit window):

- An **access review** endpoint: monthly snapshot of every member's
  role per tenant, persisted for evidence.
- An **audit log export** endpoint: time-bounded JSONL dump of
  `audit_events` for the auditor.
- A **change log** for production deploys (Vercel deploy hook ->
  Supabase row).
- A **vulnerability scan** runbook (npm audit + Snyk / GitHub
  Dependabot output collected weekly).
- **Incident response playbook**: single doc, linked from this one.

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
