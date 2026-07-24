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
   is a Teams inbound webhook (`src/api/inbound/teams/webhook.js`).
2. **`comms-send.js` cannot attach a file.** Five of the six document types
   *are* attachments. This blocks everything else.
3. **No contact functions, no routing, no To/CC** (see §1).
4. **No dispatched quantity at line grain** — see §4, the one real data gap.

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

---

## 8. Build plan

Smallest first. Each item is independently useful; nothing waits on Outlook.

| # | Item | Touches | Why |
|---|---|---|---|
| 1 | **Attachments in `comms-send.js`** | `_lib/comms-send.js`, `communications` (+`attachments` jsonb) | Nothing else works without it. Unblocks quote / invoice / PoD immediately. |
| 2 | **Contact functions + routing matrix + resolver** | new migration, `customer_contacts`, new `_lib/comms-routing.js`, admin UI | The actual ask. Pure resolver ⇒ To/CC is testable. |
| 3 | **Payment statement with GRN** | new renderer over `customer_receipts` + `invoices` | Data already exists; commercially the highest-value email. |
| 4 | **Service report renderer** | `service_visits`, `closure_reports` | Straightforward once 1–2 land; watch the internal-field leak. |
| 5 | **Dispatch register** | ERP sync or capture screen (§4) + renderer | **Blocked on the §4 decision.** |
| 6 | **Outlook/Graph provider** | new `_lib/providers/graph.js`, tenant OAuth settings | Swaps in behind the provider interface; 1–5 do not depend on it. |
| 7 | **Comms analytics** | metric catalog, cockpit | Needs 1–2 to have produced data first. |
| 8 | **Marketing path** | separate path + consent/suppression | Deliberately last, deliberately separate. |

### Decisions for Joel, not code

- **Does SCM's Tally entry contain per-line despatch quantities?** Determines
  §4 (a) vs (b), and the size of item 5.
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
