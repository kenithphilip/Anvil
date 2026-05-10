# Billing outcomes

Anvil bills on completed outcomes, not seats. This page is the public
contract: which audit events count as billable work, what the public
unit price is, and how the meter is computed.

The runtime mapping lives in `src/api/_lib/outcomes.js`. Any change
there must be reflected here.

## Outcomes and pricing

| Outcome | Public price | What counts |
|---|---:|---|
| Orders processed | $0.50 each | A new sales order entered the system. |
| Orders pushed to ERP | $1.00 each | An SO was pushed, amended, or reconciled in a real ERP (Tally today; NetSuite/SAP next). |
| Quotes drafted | $0.25 each | A customer-facing quote was drafted. |
| Invoices generated | $0.50 each | An invoice was created or its PDF rendered. Both `einvoice_*` (GSTN) and `invoice_*` (non-India, Phase 2.1 module) flow through this category. |
| Payments collected | $1.00 each | A payment landed against an invoice (Stripe `payment_intent.succeeded` once Phase 2.2 ships). |
| Approval decisions | $0.10 each | A manager or finance role accepted or rejected an approval. |
| Documents extracted | $0.10 each | A document was uploaded, scanned, or ingested via email and turned into structured fields. |
| Communications sent | $0.10 each | An outbound email, SMS, or WhatsApp message was sent through the platform. |
| Service visits closed | $0.50 each | A service-visit closure report or CAR was filed; an AMC visit auto-generated. |
| Autonomous agent actions | $0.05 each | An autonomous follow-up agent took a step (reminder sent, escalation, missing-doc request). |
| Anomalies resolved | $0.25 each | An anomaly or duplicate was acknowledged or resolved. |

## How the meter works

`GET /api/billing/usage?from=<iso>&to=<iso>` reads `audit_events` for
the caller's tenant in the requested window, maps each `action` to a
billable outcome via the static dictionary in `outcomes.js`, and
returns per-outcome counts plus a USD subtotal at the public price.

Rows whose `action` is not in the dictionary are platform overhead
and are not metered. Adding a new metered action is two edits:

1. Append the verb to `ACTION_TO_OUTCOME` in
   `src/api/_lib/outcomes.js`.
2. Add a row to the table above so the customer-facing meter and the
   engineering source agree.

Outbound billing is wired:

- **Stripe Connect**: shipped. `/api/billing/stripe/connect_onboard`,
  `connect_status`, `checkout`, `webhook` cover platform-fee onboarding,
  hosted-checkout sessions, and the Stripe webhook that flips invoices
  to paid. See `src/api/billing/stripe/`.
- **Non-India invoicing**: shipped (migration 012). The
  `/api/invoices` endpoints generate AR invoices independent of GSTN
  e-Invoice, with hosted PDFs via `/api/invoices/pdf` and email send
  via `/api/invoices/send`.
- **Recurring invoices**: shipped (migration 073).
  `/api/billing/recurring` lets operators set up monthly schedules;
  `/api/billing/recurring_cron` generates the per-period invoices.
- **Credit / debit notes**: shipped (migration 072).
  `/api/credit_notes` covers the full lifecycle.

The meter table above is now both the read side (what we measure) and
the input to the outbound flows.

## Tenant overrides

Per-tenant pricing overrides are not implemented yet. When they land
they will live in `tenant_settings.billing_overrides` and will be
applied at meter-compute time. The public price card stays as the
default for any tenant without an override row.

## Where to see it

Admin Center, Billing tab. Reads `/api/billing/usage` for the signed-in
admin's tenant. Filters by month-to-date / 7d / 30d / 90d windows.
