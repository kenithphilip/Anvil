# Delivery-to-Cash: POD → GRN/SRN → payment-collection layer

Status: scope (branch `docs/delivery-to-cash-design`).

## The problem

For a manufacturing operator, an invoice sent is not cash coming. Payment is
gated by a chain the seller can see only partially:

```
ship → 3PL delivers to customer premises → signed POD/acknowledgement
     → customer's stores post a GRN (goods) / SRN-SES (services) in THEIR ERP, dated
     → 3-way match on the customer side (their PO ↔ their GRN ↔ our invoice) clears
     → payment released (terms often run from the GRN date, not the invoice date)
```

The two events that actually unlock cash — **POD** (proof the goods arrived) and
the **customer's GRN/SRN + its date** — happen in the *customer's* world, so most
sellers chase them by hand. An invoice with no posted GRN is the #1 reason B2B
payments stall, and the AR team burns days emailing the customer's stores/AP for
"the GRN number and date."

## Industry standard (validated)

- **3-way match (PO ↔ GRN ↔ Invoice)** is the universal AP control; the **GRN is
  "official internal proof that a delivery has been received"** and carries the
  actual receipt date. Services use an **SRN / Service Entry Sheet (SES)** —
  "confirming a contracted service was performed to standard." (Manufacturing/
  pharma often go 4-way, adding QC.) [Ramp](https://ramp.com/blog/accounts-payable/goods-receipt), [HighRadius GRN](https://www.highradius.com/resources/Blog/goods-received-note/), [Dokka 2/3/4-way](https://dokka.com/what-is-invoice-matching/)
- The **AR / seller side is the "lesser-known counterpart"** of match — most tools
  are AP-focused, so the outbound POD→GRN→pay chain is under-tooled. That is the
  opportunity. [Dokka](https://dokka.com/what-is-invoice-matching/)
- **Enterprise (HighRadius):** invoice-to-cash suite that **auto-fetches PODs and
  claim documents**, **matches invoices to POs + GRNs** to flag price/qty/freight/
  tax variances, runs deductions/dispute workflows, syncs to ERP, and does
  collections + cash application. [HighRadius invoice-to-cash](https://www.highradius.com/product/invoice-to-cash-automation-solution/), [collections](https://www.highradius.com/product/collections-automation-software/)
- **India (Kapittx):** dunning across **email + SMS + WhatsApp**, tone/timing
  personalised by segment + payment history; **layers on TallyPrime via API**
  (no rip-and-replace); AI **cash application** matching UPI/NEFT/RTGS/IMPS/cheque
  to open invoices at 90%+. [Kapittx AR India](https://kapittx.com/accounts-receivable-automation-in-india/)

Net: the standard "collections" motion is **POD capture → GRN/SRN matching →
variance/dispute handling → multi-channel dunning → cash application → ERP sync**,
with terms clocked from the GRN date.

## What Anvil already has (verified from code)

| Piece | State |
|---|---|
| `shipments` table | Has `customer_delivery_date`, `pod_received bool`, `pod_document_id`, status incl. `DELIVERED`/`POD_RECEIVED` — **POD is modelled but captured manually** |
| Buyer-side 3-way match | **Built** — `api/ap/match.js` + `ap_goods_receipts` (migration 054), short-pay deductions. This is Anvil-**as-buyer**; the seller-side mirror is missing |
| Dunning | **Built + good** — `ar_collect` agent (tiered gentle/firm/final, LLM-drafted via `dunning-drafter.js` off payment history + thread), queued through `communications`. But keyed on **invoice `due_at`**, not delivery/GRN |
| Inbound email + DocAI extraction | **Built** — the same pipeline that reads POs can read POD/GRN emails |
| Logistics monitor + notifications | **Built (P0)** — delays scan, OTD, escalation delivery |
| Customer portal | **Planned** (`project_customer_portal_plan`), not built |
| Cash application (payment→invoice) | Partial (Tally reconcile); no UPI/NEFT/cheque auto-match |

The gap is precise: **no customer-side GRN/SRN capture, no automated POD capture,
and dunning is clocked off the wrong event.**

## Scope

### 1. Data model (new)
- `customer_receipts` — one row per customer GRN/SRN against an invoice:
  `tenant_id`, `invoice_id | einvoice_id`, `order_id`, `shipment_id`,
  `receipt_type ('GRN'|'SRN')`, `receipt_number`, `receipt_date`, `posted_qty`,
  `short_qty`, `rejected_qty`, `status ('expected'|'captured'|'matched'|'disputed')`,
  `source ('email'|'portal'|'edi'|'manual')`, `evidence_doc_id`, `captured_at`. RLS.
- Extend `shipments` POD: `pod_signed_by`, `pod_delivered_at`, `pod_source
  ('carrier_api'|'email'|'manual')` (keep existing `pod_received`/`pod_document_id`).
- A **collection-milestone** view per invoice: `invoiced → shipped → delivered(POD)
  → receipt_posted(GRN/SRN date) → payment_due(receipt_date + terms) → paid`.

### 2. POD capture (delivery confirmation) — the first event
Three ingest paths into the shipment's POD state, best-effort in order:
- **Carrier ePOD** — a `/api/logistics/pod/webhook` + poller for 3PL APIs
  (Delhivery / Blue Dart / DTDC / FedEx / Maersk etc.): status `delivered` +
  signed-POD URL → set `pod_delivered_at`, attach the POD doc, flip status.
- **Email POD extraction** — courier/customer emails a signed POD → the existing
  inbound-email + DocAI pipeline extracts delivery date + signatory, links to the
  shipment (a POD "document kind").
- **Manual / device** — operator upload, or a delivery-ack QR/device at the
  customer dock (Phase 3).

### 3. Customer GRN/SRN capture — the event that unlocks cash (the new core)
The customer must hand us a number from *their* ERP. Four capture paths:
- **Email extraction (reuse DocAI)** — the highest-leverage: customers routinely
  email the GRN / SES. A `grn` document kind runs through the extraction pipeline
  to pull `receipt_number`, `receipt_date`, `posted/short/rejected qty`, then
  auto-matches to the open invoice/shipment (by PO no + invoice no + item). Same
  engine as PO extraction, new schema.
- **Customer portal entry** — a scoped surface (customer-portal plan) where the
  buyer's stores/AP enter the GRN/SRN + date, or upload the acknowledgement.
- **Reminder-to-customer loop** — after POD/expected-delivery, an automated,
  tone-graded ask to the customer's stores/AP for the GRN number + date (the
  "please share the GRN so we can align payment" nudge), tracked as an open item.
- **EDI / customer-ERP API** — for high-volume customers on SAP/Oracle, pull the
  posted GRN/SES directly (biggest reliability, highest integration cost).

### 4. Milestone-driven collection (re-key the dunning that already exists)
- Compute AR aging from the **GRN/receipt date + terms** (fallback: invoice date)
  — this is the correct clock.
- Extend `ar_collect` into a **milestone-aware** collector with the right ask per
  stage: chase **POD** if delivered-but-no-POD → chase **GRN/SRN** if
  POD-but-no-receipt → chase **payment** (existing tiered dunning) once
  receipt-dated + past terms. `dunning-drafter` already personalises tone.
- Surface **disputes/short-receipts** (short_qty/rejected_qty) as a deductions
  queue (mirror the AP short-pay pattern from migration 054, now on the AR side).

### 5. Channels + customer surface
- Multi-channel per the standard: **email (built) + WhatsApp + SMS**, tone/timing
  by segment + history (Kapittx pattern) — wire new channels into the queued-comms
  reaper.
- **Customer portal / device** (ties to `project_customer_portal_plan`): a
  read-mostly page per customer to see open invoices, confirm delivery, enter
  GRN/SRN, and (India) see e-invoice/e-way-bill status — the self-serve version of
  the reminder loop.

### 6. Cash application (close the loop)
Match incoming payment (bank statement / UPI / NEFT / RTGS / cheque) to the open
invoice (India: reuse Tally reconcile + a fuzzy payment-matcher; the AI-match
pattern Kapittx cites). Marks the milestone `paid` and stops dunning.

## Reuse map
DocAI extraction + inbound email (POD/GRN parsing) · `ar_collect` + `dunning-drafter`
(milestone dunning) · logistics monitor + notifications (POD/GRN reminders +
escalation) · the AP 3-way-match + short-pay pattern (migration 054) **mirrored to
AR** · customer-portal plan (self-serve GRN/POD) · Tally reconcile (cash
application, India).

## India specifics
GRN posting gates SAP-AP payment (see `project_payment_reality` — customers pay by
bank transfer with **TDS** withholding, not cards); terms clock off the GRN date;
the **e-invoice IRN + e-way-bill** already produced by Anvil are the delivery-side
evidence that should reconcile against the customer's GRN. Cash application must
handle TDS-short payments (paid = invoice − TDS) so a correct payment isn't dunned
as short.

## Phasing
- **P0 — receipt capture (the missing core).** `customer_receipts` table + the
  **GRN/SRN email-extraction path** (reuse DocAI) + manual entry, and compute AR
  aging from the receipt date. Highest value, reuses the most; no new vendor. Dark.
- **P1 — POD automation.** Carrier ePOD webhook/poller + email-POD extraction →
  auto-fill the shipment POD state.
- **P2 — milestone-aware collection.** Re-key `ar_collect` to POD/GRN/payment
  stages + the AR deductions (short-receipt) queue.
- **P3 — customer portal + multi-channel.** Self-serve GRN/POD entry + WhatsApp/SMS.
- **P4 — cash application.** Payment↔invoice auto-match (TDS-aware), stop-dunning
  on paid.

## Realism
POD/ePOD is mechanical (carrier APIs + email). The **customer GRN/SRN is the hard
part** — it lives in the buyer's ERP, so the durable win is (a) extracting it from
the emails customers already send (DocAI) and (b) the portal/reminder loop to pull
it, with EDI only for the few highest-volume customers. Start at P0: capture +
correct aging turns "invoice sent" into "cash forecast," and everything else keys
off it.
