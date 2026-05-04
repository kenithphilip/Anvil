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

**Status**: not started.

**Why deferred**: voice AI is two products glued together (a
real-time speech provider, and a domain-tuned LLM). The product
decisions we don't have:

- Buyer or seller surface? Inbound calls from customers vs. outbound
  call agent driving collections look completely different.
- Live transcription only, or full conversational agent that can
  *act* (e.g., "the agent took the customer's PO over the phone and
  pushed it to NetSuite")? Compliance scope changes by 10x between
  these.
- Realtime provider: Vapi, Retell, OpenAI Realtime, or a stack on
  Twilio Media Streams + a self-hosted Whisper-distil + Claude.

**What would land in Anvil if green-lit** (~3 weeks):

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

**Status**: not started, blocked on product decisions.

**Why deferred**: a "vertical pack" is a meaningful artifact only
once we know *which* vertical and *what changes*. Every pack we'd
ship is a tradeoff between two paths:

- **Configuration packs** (fast). A bundle of seed data: lead times,
  approval thresholds, contract types, item-master examples, lost-
  reason taxonomy tuned for the vertical.
- **Code packs** (slow). New screens or workflows specific to the
  vertical (e.g., HVAC equipment hierarchies, MRO spares matrix,
  industrial machinery service contracts).

The decision we don't have: which 2-3 verticals matter for the
first wave (HVAC distribution, industrial pumps, bearings & power
transmission, instrumentation, MRO) and how deep we'll go.

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

**Status**: not started; **partially redundant with the PWA mobile
shell** that's already in `MobileShell.tsx` + `public/sw.js` +
`/api/push/*` (web push).

**Why deferred**: the PWA covers the four flows that matter on the
go (My Day, Inbox, Approvals, Sales Orders). iOS-native gives:

- App Store presence (mostly a marketing benefit).
- Better push reliability + lock-screen badges (real benefit).
- Native camera/biometric APIs (real benefit for intake document
  capture and approve-by-Face-ID).

The decision we don't have: does the marketing value plus the
reliability gain justify a Capacitor (or React Native, or full
Swift) build + maintaining two app distributions?

**What would land in Anvil if green-lit** (~6 weeks):

- Wrap the existing v3-app build in **Capacitor**. The Vite output
  becomes the WebView; we add native plugins for Push (APNs),
  Biometrics, Camera (for intake), and File System (for offline
  approvals).
- New `/api/push/subscribe` extension to accept APNs device tokens
  (the `device_token` + `channel='apns'` columns are already on
  `push_subscriptions`).
- Native APNs sender added to `/api/push/send` alongside the web-
  push branch.
- TestFlight + App Store submission flow (out of code scope; that's
  ops + marketing).

**Already in place**:

- `MobileShell.tsx` mobile shell.
- `public/manifest.json` PWA manifest + icons.
- `public/sw.js` service worker that handles push events.
- `push_subscriptions` table already supports `channel='apns'` +
  `device_token`.
- `/api/push/send` is provider-agnostic; the APNs branch is one
  concrete addition.

---

## 4. SOC 2 / ISO 27001

**Status**: programs, not features. Not "build this in code".

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

| Item            | Code work? | Decision blocker                              |
|-----------------|------------|-----------------------------------------------|
| Voice AI        | Yes (3w)   | Inbound vs. outbound; provider choice         |
| Vertical packs  | Yes (1-3w) | Which 2-3 verticals first                     |
| Native iOS      | Yes (6w)   | PWA already covers the flows; ROI question    |
| SOC 2 / ISO     | Mostly no  | Pick a GRC vendor, start the observation clock |
