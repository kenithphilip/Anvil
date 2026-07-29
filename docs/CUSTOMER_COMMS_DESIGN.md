# Customer Communications — Outlook integration, function-based routing, and comms analytics

Status: **design only, no code** (2026-07-24). Written from a code audit of the
live repo; every "exists today" claim below is cited to a file or migration.

---

## 1. The problem

Anvil sends six kinds of document to customers:

| Document | Trigger |
|---|---|
| Quote | sales, on request |
| Dispatch register for PO line items (+ invoice when required) | after despatch, logged in the ERP by SCM |
| Pending payments, each with GRN number + GRN entry date | AR follow-up |
| Proof of Delivery | on customer request |
| Marketing | campaign |
| Service report for completed activity | after a service visit |

**A customer is not a person — it is a company with functions.** A dispatch
register goes TO the stores team with purchase and accounts in CC. A payment
reminder goes TO accounts. A service report goes TO maintenance with management
in CC. The same customer, three different recipient sets, per document type.

Anvil today has no way to express that. `customer_contacts` (migration
`065_customer_contacts.sql:31-46`) has `name`, `email`, `phone`, a **free-text
`role`**, and `is_primary`. There is no function taxonomy, no per-document-type
subscription, and no To/CC distinction anywhere in the codebase.

---

## 2. What already exists

Stronger foundations than expected. Build on these; do not rebuild them.

**Outbound rail.** `communications` (`005_close_remaining_gaps.sql:22-43`) —
`direction`, `channel`, `thread_id`, `from_addr`, `to_addr`, `subject`, `body`,
`status` (`draft→sent→failed→replied→archived`), `template_code`, `sent_at`,
plus `order_id` / `source_po_id` links. `_lib/comms-send.js` has live SendGrid
(`:34`) and Twilio/WhatsApp (`:54`) adapters. `draft_and_send_comms` already
exists as a GenOps propose→confirm safe action.

**The GRN data is already modelled.** `customer_receipts` (migration
`181_customer_receipts.sql`) is the seller-side GRN/SRN capture:
`receipt_type` (`GRN`|`SRN`), `receipt_number`, `receipt_date`, with FKs to
`invoice_id` / `einvoice_id` / `order_id` / `shipment_id` / `customer_id`. Its
own header states the point exactly: *"terms usually clock off the GRN date,
not the invoice date."* This is the hardest dependency of the pending-payments
email and it already exists.

**Proof of Delivery exists.** `shipments` (`006_corpus_alignment.sql:442-467`)
carries `pod_received` and `pod_document_id`, plus `customer_delivery_date` and
a `POD_RECEIVED` status.

**Per-tenant encrypted secrets.** `_lib/secrets.js` (`encryptField` /
`decryptField` + a shared per-tenant IV), already used for the DocAI provider
keys (`docai_*_api_key_enc`, migration 187). OAuth tokens follow this pattern.

**Inbound rail.** `inbound_emails`, `inbound_email_threads`,
`email_intake_rules`, `_lib/email-classifier.js` (which already labels
`complaint` / `support_question` / `delivery_query`).

### The gaps

1. **No Microsoft Graph / Outlook / MSAL anywhere.** The only Microsoft surface
   is a Teams inbound webhook (`src/api/inbound/teams/webhook.js`) — and the
   Teams *send* path is a stub that returns `ok:true` while transmitting
   nothing (`_lib/comms-send.js:90`). A comment at
   `src/api/cron/drift-report.js:104-106` claims "Anvil already has SendGrid /
   Postmark / Microsoft Graph adapters wired" — **that is false**; only
   SendGrid, Twilio/WhatsApp, Slack and a generic webhook exist.
2. **`comms-send.js` cannot attach a file.** Five of the six document types
   *are* attachments. This blocks everything else. Note the `communications`
   table **already has an `attachments jsonb` column**
   (`005_close_remaining_gaps.sql:36`) with **zero writers and zero readers** —
   the storage exists, the plumbing was never built.
3. **No contact functions, no routing, no To/CC** (see §1). There are no
   `cc`/`bcc` columns at all, and the SendGrid payload
   (`_lib/comms-send.js:24-32`) sends `personalizations[0].to` — a single
   recipient, no cc, no attachments, no reply-to.
4. **No dispatched quantity at line grain** — see §4, the one real data gap.

### The rail is not sound enough to build on as-is

A full audit of the outbound path found the `communications` table is defined
once (`005_close_remaining_gaps.sql:22-43`) and **never altered**, yet **twelve
writers use six mutually-incompatible schemas**. Only three conform.

The rest insert columns that do not exist (`object_type`, `object_id`, `kind`,
`sent_by`, `to_address`, `recipient`, `body_html`, `template_kind`, `meta`,
`origin_ref`, `external_ref`) and statuses the CHECK constraint rejects
(`queued`, `manual`, `pending_send`). Verified examples: `quotes/send.js:443`
and `invoices/send.js:147` both write four phantom columns, an invalid status,
and **omit the NOT NULL `direction`**. Several are wrapped in swallowed
catches, so they fail silently.

Three consequences that matter before any new feature lands on this rail:

- **`GET /api/communications` is broken.** `communications/list.js:32` selects
  `updated_at`, which does not exist → PostgREST 400 on every call. The comms
  timeline it was built for has always been empty.
- **A send with no provider configured is recorded as `sent`.**
  `_lib/comms-send.js:141`: `const newStatus = !configured ? "sent" : …`, and
  `sent_at` is stamped. Nothing was transmitted. The parallel reaper in
  `agents/run.js:337-341` was explicitly fixed for this exact bug; the path the
  copilot and `/api/communications/send` use still lies. **Any analytics built
  on `status='sent'` would be measuring fiction.**
- **Two send cores.** `agents/run.js:255-296` re-implements SendGrid + webhook
  inline with no chat channels and different status semantics.

**Therefore item 0 in the build plan is a schema + writer reconciliation.** It
is unglamorous, it is not what was asked for, and skipping it means the routing
matrix and the analytics both sit on a table whose contents are unreliable.

---

## 3. Core model: a routing matrix

The central abstraction is **document type × customer function → To/CC**,
per tenant, per customer.

```
contact_functions
  tenant_id, code, label, sort_order, is_active
  Seeded per tenant (stores, purchase, accounts, quality, management) and
  EDITABLE. Not an enum in code: another tenant's "stores" is "warehouse" or
  "receiving", and a services business has none of them.

customer_contacts                      (extend, do not replace)
  + function_id  -> contact_functions
  + is_active
  `role` stays as legacy free text; nothing reads it for routing.

comms_routing_rules
  tenant_id, customer_id, document_type, function_id,
  disposition ('to' | 'cc' | 'bcc'), is_active
  e.g. dispatch_register → stores = TO, purchase = CC, accounts = CC
```

`document_type` is the shared vocabulary across routing, templates, analytics
and suppression: `quote`, `dispatch_register`, `invoice`, `payment_reminder`,
`proof_of_delivery`, `service_report`, `marketing`.

### Three properties that are not negotiable

**Degrades gracefully — redundancy, not a gate.** Resolution order per document
type: explicit rule → any contact in the matching function → the customer's
`is_primary` contact → the operator, with a visible warning. A customer with
zero configuration still receives mail; the send records *which* fallback
fired, so coverage is measurable and improves over time. Nothing blocks.

**Entity-agnostic.** No seller, buyer, function label or document format is
hardcoded. A new tenant gets seed functions they can rename or delete.

**Resolution is a pure function.**

```
resolveRecipients(documentType, customerId, contacts, rules)
  -> { to: [], cc: [], bcc: [], fallback_used: null | 'function' | 'primary' | 'operator' }
```

Testable with no network and no database, which is what makes the To/CC
behaviour verifiable rather than hoped-for.

---

## 4. Per-document-type readiness

| Document | Assemble today? | What is missing |
|---|---|---|
| **Quote** | **Yes** — `quotes` + `quote_lines` + `quotes/pdf.js` | attachment plumbing only |
| **Proof of Delivery** | **Yes** — `shipments.pod_document_id` | attachment plumbing only |
| **Pending payments + GRN** | **Yes** — `customer_receipts` + `invoices` + AR aging (`_lib/ops-kpis.js`) | a statement renderer |
| **Invoice** | **Yes** — `invoices` / `einvoices` | attachment plumbing only |
| **Service report** | **Partial** — `service_visits`, `closure_reports` | a customer-facing renderer; internal fields (cost, engineer notes) must not leak |
| **Marketing** | **Partial** — `prospecting_campaigns` / `_targets` / `_suppressions` | must NOT share this path — see §6 |
| **Dispatch register** | **No, not at the required grain** | see below |

### The dispatch-register gap — the one real blocker

You said SCM logs the dispatch register in the ERP. Anvil today has:

- `shipments` — **header grain**: `shipment_number`, `carrier`,
  `shipper_invoice_no`, dates, `pod_received`. One row per consignment.
- `order_schedule_lines` (`006_corpus_alignment.sql:588-601`) — per-line, but
  it holds **`scheduled_qty` / `scheduled_date`**: what was *promised*, not what
  *shipped*.

Grepping the whole repo for `dispatched_qty` / `shipped_qty` / `delivered_qty`
returns **nothing**. There is no per-line despatched quantity anywhere, and the
Tally sync (`src/api/tally/sync.js`) pulls voucher records, not delivery notes.

So a dispatch register *per PO line item* — "against your PO line 3, 40 of 100
despatched on 12 Mar under LR 4471" — cannot be produced today.

**Two ways to close it, and this is a decision for Joel, not a code choice:**

- **(a) Mirror the ERP delivery note.** If SCM enters a Delivery Note / Despatch
  voucher in Tally with line quantities, extend the Tally sync to pull that
  voucher type into a new `dispatch_lines` table (`order_id`, `line_index`,
  `part_no`, `dispatched_qty`, `dispatch_date`, `lr_number`, `shipment_id`).
  This is the right answer if the data already exists in the ERP.
- **(b) Capture at despatch in Anvil.** A screen where SCM records despatched
  quantity per line. Only worth building if the ERP does *not* already hold it —
  otherwise it is double entry, which SCM will (correctly) resent.

**Which applies depends on what SCM actually enters in Tally.** That answer
determines whether the dispatch register is a two-day feature or a two-week one.

### RESOLVED — option (a). Joel confirmed the ERP delivery-note entry carries
the per-line despatched quantity, so we mirror it rather than add a capture
screen (which would be double entry). **Shipped:**

- `dispatch_lines` (migration 193) — one row per despatched PO line, keyed to
  `order_id` + `line_index` (the 0-based ordinal into
  `orders.result.salesOrder.lineItems[]`, the same per-line key the rest of the
  schema uses), with `part_no`, `dispatched_qty`, `dispatch_date`, `lr_number`,
  `carrier`, `invoice_number`, `shipment_id`. Idempotent on a single-column
  `source_ref` (voucher id + line ref) via a **partial** unique index — the same
  null-safe pattern as the service-report template fix, not a null-blind
  composite.
- `_lib/dispatch-register.js` — the pure builder. The **ordered** side is the PO
  line items (never `order_schedule_lines`, which is the one-to-many delivery
  schedule and would double-count). Matches a despatch to its PO line by
  `line_index`, else `part_no`; an unmatched despatch is still shown; a line with
  nothing despatched is "awaited"; and with no line grain at all it degrades to
  one row per shipment. Fail-safe column visibility.
- `comms/dispatch_register.js` — GET assemble / POST draft via `commsRow`, routed
  to `dispatch_register` (stores = TO, purchase + accounts = CC). Unions
  `invoices` + `einvoices` (the India GST path) for the invoice column.
- `comms/dispatch_lines.js` + `_lib/dispatch-lines.js` — the generic ingest
  writer (normalises importer vocabulary, idempotent upsert). This is the
  redundancy path so the register is never hostage to the ERP connector.

**Follow-ups (graceful degradations until built):**

- **Tally `/delivery_notes` reverse-pull** — a new sync entity (modelled on
  `syncPayments`) that calls `upsertDispatchLines()`. Blocked on the on-prem
  bridge exposing the delivery-note voucher lines. Until then the generic ingest
  endpoint (CSV / manual / portal) feeds the same table.
- **Per-customer routing seed + new-customer hook** — `comms_routing_rules` needs
  a per-customer row to get the stores=TO / purchase+accounts=CC split; without
  it the resolver degrades to the function fallback (delivers, no CC split).
- **`eway_bills` LR/transporter join** — for an LR number on the shipment-header
  fallback (`shipments` has no LR field).
- **Optional per-tenant/customer layout template table** — the builder already
  takes a `template` (column set + labels + visibility); a table would persist
  it. Falls back to `DEFAULT_COLUMNS` today.

---

## 5. Outlook / Microsoft Graph

Per-tenant OAuth (authorization-code flow), tokens stored with the existing
`encryptField`/`decryptField` envelope alongside the DocAI keys. Graph slots in
behind the existing provider interface in `comms-send.js`, so nothing else in
the plan depends on it landing.

**What it buys over SMTP/SendGrid — three things that matter here:**

1. **Sent mail appears in the rep's own mailbox.** The customer sees a normal
   person emailing them, and the rep sees the thread in Outlook. A SendGrid API
   send is invisible in the sender's own Sent Items, which is why reps quietly
   stop trusting it.
2. **Real threading.** Graph returns `conversationId` and `internetMessageId`;
   storing them on `communications` lets a customer's reply attribute back to
   the exact dispatch register that prompted it. Today's `thread_id` is
   heuristic.
3. **Send-as a shared mailbox** (`dispatch@`, `accounts@`) — which matches how
   these functions actually correspond, and survives a rep leaving.

**Compliance.** Graph means customer correspondence transits Microsoft. Given
the DPDPA posture, decide explicitly: the tenant region, whether message bodies
are retained in `communications.body` or only referenced by `conversationId`,
and the retention window. This is a decision to make deliberately rather than
inherit by default.

### SHIPPED — the send provider. **Reused, not duplicated:** migration 028
already added the Azure app-registration columns to `tenant_settings` for the
*inbound* Graph integration (`graph_tenant_id`, `graph_client_id`,
`graph_client_secret_enc`, `graph_creds_iv`, `graph_mailbox`) — the same app and
mailbox that receives replies. The send provider reuses them (and is the first to
actually store the client secret encrypted; inbound left it a TODO).

- **`_lib/graph-client.js`** — authorization-code flow. Pure builders
  (`buildAuthorizeUrl`, `buildGraphMessage`) + HMAC `signState`/`verifyState`
  (tenant-bound, expiring — CSRF-safe with no session) + `graphAccessToken`
  (lazy refresh-and-persist) + `sendViaGraph`. Sends via **create-draft-then-send**
  because a bare `sendMail` returns 202 with no ids; the draft-create response
  carries `conversationId` + `internetMessageId`.
- **Token storage** — migration 194 adds only the token bundle
  (`graph_access_token_enc`/`graph_refresh_token_enc`/`graph_token_iv`/
  `graph_token_expires_at`/`graph_connected_at`) under a **second IV** so the
  hourly refresh never re-encrypts the client secret.
- **`comms/graph.js`** (admin: config / status / disconnect) + **`comms/graph_callback.js`**
  (public; validates the signed state instead of a session, exchanges the code,
  persists encrypted tokens). All outbound HTTP via `safeFetch`; no secret or
  provider body ever reaches a log, error, or response.
- **`comms-send.js`** — `sendViaGraph` runs before SendGrid, gated on the tenant
  being connected; persists `conversationId`→`thread_id`, `internetMessageId`→
  `provider_message_id`.

**Security posture** (independently critiqued): CSRF state signed with
`ANVIL_SECRETS_KEY` + `timingSafeEqual` + expiry; Azure directory id validated
against URL-path injection; sender mailbox `encodeURIComponent`-d; redirect URI
from `PUBLIC_APP_URL`/`GRAPH_REDIRECT_URI` only (never a request header);
connect refuses to run without `ANVIL_SECRETS_KEY` (no plaintext refresh tokens).

**Follow-ups (documented, none blocking a send):**

- **Close the reply loop.** Storing `conversationId`/`internetMessageId` is
  necessary but not sufficient: inbound still threads on the RFC Message-ID chain,
  and `inbound/email/webhook.js` `handleGraph` is a stub that never fetches the
  message. A Graph-fetch worker that reads a reply's `conversationId`/`in_reply_to`
  and joins `communications` on `thread_id`/`provider_message_id` is what actually
  attributes a reply to the originating outbound.
- **Refresh scheduler.** Refresh is lazy on-send; a tenant that sends nothing for
  the refresh-token lifetime silently falls back to SendGrid. A cron (the
  `sap/sync.js` precedent) would keep long-idle connections alive.
- **Refresh concurrency.** Last-write-wins on the shared row — safe *because the
  app is a confidential client* (rotated refresh tokens stay valid). A conditional
  update on `graph_token_expires_at` would harden it.
- **Scopes.** `Mail.ReadWrite` grants full-mailbox access (the price of
  draft-based threading-id capture); scoped to the one sender mailbox. Narrowing
  to `Mail.Send`-only would drop threading ids.
- **Admin UI** for entering the app registration + a Connect button, and the
  **DPDPA compliance decision** above.

**Ops** — set `PUBLIC_APP_URL`, `ANVIL_SECRETS_KEY` (64 hex), the SPA origin in
`ALLOWED_ORIGINS`; register `<PUBLIC_APP_URL>/api/comms/graph/callback` as the
Azure redirect URI; **apply migration 194 manually** (merged ≠ applied).

---

## 6. Marketing must not ride the transactional path

Transactional mail (a dispatch register to a buyer's stores team) and marketing
mail are legally distinct under DPDPA and most equivalents.

- Marketing requires recorded **consent**, honours **suppression**, and carries
  **unsubscribe**.
- Transactional must **never** carry an unsubscribe that could suppress a
  payment reminder or a PoD.

Therefore: a separate send path, a separate sender identity, and
`prospecting_suppressions` enforced on marketing only. **A marketing
suppression must never block a transactional send** — encode that as a test,
not a convention. Add `marketing_consent` + `consent_source` +
`consent_recorded_at` to `customer_contacts`; absence of consent means no
marketing, and no effect on anything else.

### SHIPPED — a structurally separate marketing path

- **`_lib/marketing-send.js`** — the ONLY place the marketing gates live. Its own
  sender identity (`MARKETING_FROM_EMAIL`, never the rep's mailbox), its own
  provider call, and consent + suppression + unsubscribe enforced here. The
  transactional path (`comms-send.js`) imports nothing from it and never reads
  `prospecting_suppressions` / `marketing_consent` — that's the structural
  guarantee, asserted by a test.
- **`marketing/send.js`** (admin) — sends only to `marketing_consent = true`
  contacts of a customer; logs each with `document_type='marketing'`.
- **`marketing/unsubscribe.js`** (public) — an HMAC(`tenant_id`,`email`) token
  (no lookup table); **GET renders a confirm page and does not mutate**
  (prefetch-safe), **POST performs** the unsubscribe (the RFC 8058 one-click
  target). Adds a *marketing* suppression only.
- Every marketing email carries an unsubscribe footer + `List-Unsubscribe` /
  `List-Unsubscribe-Post` headers.
- **Every transactional entry point refuses `document_type='marketing'`** — both
  the reaper (`agents/run.js`) and `sendCommunication` itself (which
  `POST /api/communications/send` + the copilot path reach), so a failed marketing
  row can never be re-sent with the transactional identity. `prospecting/run.js`
  now sends through the marketing path.

**The invariant is a test** (`api-marketing-path.test.js`): a non-consented,
suppressed contact still receives a `payment_reminder`, while the same contact
gets no marketing.

**No migration** — `marketing_consent` (190) + `prospecting_suppressions` (057)
already exist; the unsubscribe token is stateless HMAC.

**Follow-ups:** a marketing-consent capture UI on the contact record; a
double-opt-in flow if required by region; opens/clicks via provider webhooks
(separable, §7 note). **Ops:** set `MARKETING_FROM_EMAIL` (a distinct sender)
and `PUBLIC_APP_URL` for the unsubscribe links.

---

## 7. Analytics

"Customer communication analytics" should mean, per customer and per function:

| Metric | Source |
|---|---|
| What was sent, when, by whom, to which function | `communications` + routing snapshot |
| Reply rate, **time to first response** | inbound thread linkage; reuse `median`/`percentile` from `_lib/ops-kpis.js` |
| Dispatch-register cadence (are we informing them, or do they chase us?) | `communications` where `document_type='dispatch_register'` |
| Open payment follow-ups, aged from **GRN date** | `customer_receipts.receipt_date` + AR aging |
| Coverage: customers with no routing configured | `comms_routing_rules` vs `customers` |

Route these through the **existing metric catalog** so they inherit the
provenance contract (`{value, unit, provenance, as_of}`) and appear in Ask Anvil
for free, rather than building a parallel reporting stack.

Engagement (opens / clicks / bounces) needs provider webhooks and is a separable
later increment — deliberately not in the first build.

### SHIPPED — five governed comms metrics in the existing catalog
(`src/api/_lib/metrics/catalog.js`, `domain: "communications"`). They inherit the
`{value, unit, provenance, as_of}` contract and appear in Ask Anvil's
`query_metric`/`list_metrics` tools for free — no parallel reporting stack.

| Metric | Unit | What it measures |
|---|---|---|
| `comms_sent` | count | Outbound messages in the window, **broken down by document_type**. |
| `comms_delivery_rate` | percent | `sent`+`replied` ÷ attempted — surfaces messages **stuck `queued` because no provider is configured** (the false-`sent` bug's analytics twin). |
| `dispatch_register_cadence` | count | Dispatch registers proactively sent — are we informing them, or do they chase us? |
| `payment_followups_sent` | count | Payment reminders sent in the window. |
| `routing_coverage` | percent | Distinct customers with an active routing rule ÷ all customers — the coverage gap the routing matrix is meant to close. |

**Deliberately deferred (would measure fiction today):** `reply_rate` and
`time_to_first_response`. Both need inbound thread linkage, and **no inbound row
lands in `communications`** (every writer is outbound). They unblock with the
same Graph reply-loop join called out in §5 — shipping them now would report a
permanent "0 replies." The §7 "open follow-ups **aged from GRN date**" view is
also deferred: today `ar_overdue` ages by invoice **due_date**, not
`customer_receipts.receipt_date`, so the GRN-anchored aging isn't built yet.
`payment_followups_sent` adds the follow-up *activity* view in the meantime.

---

## 8. Build plan

Smallest first. Each item is independently useful; nothing waits on Outlook.

| # | Item | Touches | Why |
|---|---|---|---|
| **0** | **Reconcile the `communications` schema + its 12 writers** | migration (add `cc`/`bcc`/`customer_id`/`document_type`/`updated_at`/`provider_message_id`, widen the status CHECK), all 12 writers, `communications/list.js`, `_lib/comms-send.js:141` | **Prerequisite.** 9 of 12 writers insert phantom columns; the list endpoint 400s; a send with no provider is recorded as `sent`. Routing and analytics both sit on this table — build on it unreconciled and the analytics measure fiction. |
| 1 | **Attachments in `comms-send.js`** | `_lib/comms-send.js` (the `attachments` column already exists, unused) | Nothing else works without it. Unblocks quote / invoice / PoD immediately. |
| 2 | **Contact functions + routing matrix + resolver** | new migration, `customer_contacts`, new `_lib/comms-routing.js`, admin UI | The actual ask. Pure resolver ⇒ To/CC is testable. |
| 3 | **Payment statement with GRN** | new renderer over `customer_receipts` + `invoices` | Data already exists; commercially the highest-value email. |
| 4 | **Service report renderer** | `service_visits`, `closure_reports` | Straightforward once 1–2 land; watch the internal-field leak. |
| 5 | **Dispatch register** | `dispatch_lines` (193) + builder + endpoint + ingest | **Shipped (option a).** Tally `/delivery_notes` pull is the one follow-up. |
| 6 | **Outlook/Graph provider** | `_lib/graph-client.js` + `comms/graph.js` + callback (194) | **Shipped.** Auth-code flow, reuses 028 config cols; reply-loop join is the follow-up. |
| 7 | **Comms analytics** | 5 metrics in `_lib/metrics/catalog.js` (`communications` domain) | **Shipped.** Reply-rate/TTFR deferred to the inbound-join follow-up. |
| 8 | **Marketing path** | `_lib/marketing-send.js` + `marketing/{send,unsubscribe}.js` | **Shipped.** Separate sender + consent + suppression + unsubscribe; the "never blocks transactional" invariant is a test. |

### Decisions for Joel, not code

- ~~**Does SCM's Tally entry contain per-line despatch quantities?**~~
  **RESOLVED: yes.** → option (a), item 5 shipped (see §4).
- **Shared mailbox or send-as-the-rep?** Changes the Graph scopes and consent
  screen.
- **Message-body retention** under DPDPA — store bodies, or reference by
  `conversationId` only?
- **Who owns the function taxonomy per tenant** — is `stores` vs `warehouse` an
  admin setting or fixed at onboarding?

---

## 9. Explicitly not in scope

- Opens/clicks/bounce tracking (needs webhooks; separable).
- A full campaign builder — `prospecting_*` already exists; item 8 wires
  consent and suppression, not a marketing suite.
- Replacing the portal. The portal is pull; this is push. They share
  `document_type` and nothing else.
