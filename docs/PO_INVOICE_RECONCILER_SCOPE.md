# PO ↔ invoice reconciliation — scope

**Written** 2026-08-19. Everything marked *verified* was confirmed by reading the file named.

## The requirement

> flag differences between sales order (or PO from customer) and quote, and decide whether to accept
> or ask customer for amendment or cancel the sales order. Ideally extraction needs to be carried
> from customer PO and matching invoice will be processed, because a customer may not carry out GRN
> if the invoice doesn't match the PO.

Three distinct things. Anvil has the first, has nothing for the second, and has one leg of the third.

| hop | state |
|---|---|
| quote ↔ PO | **built** — `orders/reconcile_quotes.js` + `_lib/quote-reconcile.js` |
| a recorded decision on a mismatch | **nothing** |
| PO ↔ our outbound invoice | **nothing** (the PO *reference* now reaches the invoice — see below) |

## What exists today, precisely

**`quote-reconcile.js` is a general two-list line comparator.** *Verified.* It takes PO lines and
quote lines, matches on normalised part code, and emits per-line verdicts — `price_mismatch`
(with `po_rate`, `quote_rate`, `price_delta_pct`), `description_mismatch` (below a token-agreement
floor), `unmatched`, plus a reverse walk producing `quoted_not_ordered`. It already pools *many*
quotes against one PO and prefers `discounted_unit_price` over `listed_unit_price` (`:157`).

**Nothing consumes the verdicts except a banner.** The findings render in the SO workspace; the
operator proceeds or doesn't. No verdict is persisted as a decision, and `order_status` has no state
that could hold one (`DRAFT, PENDING_REVIEW, APPROVED, BLOCKED, DUPLICATE, REUSED,
EXPORTED_TO_TALLY, FAILED_TALLY_IMPORT, RECONCILED, CANCELLED` — 001_init.sql:118).

**`ap/match.js` is a real three-way match pointed the other way.** *Verified.* It joins
`ap_invoices` → `source_pos` → `ap_goods_receipts` — **supplier** invoice vs **our** PO to the
supplier vs receipt, with tolerances and an auto-approve setting. It protects us from overpaying
vendors. It is not, and cannot be reused as, a customer-side check: different tables, opposite
direction.

**The outbound invoice is seeded from the order and then unconstrained.** *Verified.*
`invoices/index.js` builds a draft via `invoiceFromOrder`, then lets the caller replace
`line_items`, `subtotal`, `tax_total` and `grand_total` outright (`:63-68`). The override exists for
partial invoicing on multi-shipment orders — a genuine need — but nothing checks the result is a
subset of what was ordered, at the prices that were ordered.

**There is no over-invoicing guard.** *Verified* — no cumulative check, no invoiced-quantity
tracking, no remaining-to-invoice anywhere in `src/api/invoices/` or `_lib/invoicing.js`. The same
order can be invoiced twice at full value.

**There is no `invoice_lines` table.** *Verified.* Lines live in `invoices.line_items` JSONB, the
same shape as `orders.result.salesOrder.lineItems`. A per-line comparison cannot be expressed in
SQL; it has to run in code over two JSON blobs — which is exactly what `quote-reconcile.js` already
does for the quote hop.

## Already shipped alongside this doc

The buyer's PO number now reaches the invoice: `invoices.customer_po_number` (migration **214**,
needs applying), snapshotted by `invoiceFromOrder`, printed as **“Your PO …”** in the invoice
header. Previously `orders.po_number` was SELECTed by `invoices/index.js` and discarded, and the
only place the reference survived was the GSTN e-invoice payload — the tax filing carried it and
the customer's copy did not.

That is the clerical half of the GRN problem. This doc is the substantive half.

## Design

### Reuse the comparator; do not write a second one

`quote-reconcile.js` compares two line lists with tolerance, code normalisation and typed verdicts.
The PO↔invoice hop is the same problem with different inputs:

```
compareLines(orderLines, invoiceLines)      // instead of (poLines, quoteLines)
```

Extract the comparison core so both hops share it. Divergences to handle explicitly:

- **Partial invoicing is legitimate.** A quantity below the ordered quantity is not a defect on its
  own — it is a defect only against the *cumulative* invoiced total. So the comparator needs prior
  invoices for the order, not just this one.
- **Price must match exactly, quantity need not.** An invoice at a different rate than the PO is
  always a problem; an invoice for fewer units usually is not.
- **Extra lines are always a problem.** A line on the invoice that is not on the PO cannot be
  received. This is the mirror of `quoted_not_ordered` and the reverse walk already exists.

### Verdicts

| verdict | means | GRN consequence |
|---|---|---|
| `qty_over_ordered` | cumulative invoiced qty exceeds PO qty | rejected |
| `price_mismatch` | invoice rate ≠ PO rate | rejected |
| `not_on_po` | invoice line absent from the PO | rejected |
| `not_invoiced` | PO line with nothing invoiced yet | informational — open balance |
| `tax_mismatch` | GST rate differs from the PO | often rejected; India-specific |
| `po_ref_missing` | no `customer_po_number` | rejected clerically |

### The decision, which is the part with no home today

A verdict is not an outcome. The requirement names three outcomes — **accept**, **request
amendment**, **cancel** — and none can currently be recorded.

Minimum shape: one table, `order_variance_decisions`, holding `(tenant_id, order_id, finding_code,
decision, reason, decided_by, decided_at)` with `decision in ('accepted','amendment_requested',
'cancelled')`. Keyed by finding so a decision is against a specific discrepancy rather than the
whole order, and append-only so the trail survives a later reversal.

Two deliberate consequences:

- **A blocking verdict with no decision should block the invoice**, not the sales order. Blocking
  the SO punishes the operator for the customer's paperwork; blocking the invoice is where the
  actual risk sits.
- **`amendment_requested` needs an outbound message**, and the internal comms rail is broken end to
  end — no role→address resolution, and queued communications drain only from an unscheduled cron.
  Treat that as a prerequisite, not a detail.

### What is NOT in scope

- Changing `order_status`. The enum gap is real and separately consequential (it is also why
  win/loss cannot report a loss), but a variance decision is not an order state and should not wait
  on that migration.
- An `invoice_lines` table. Tempting, and it would make this SQL-expressible, but it is a large
  migration touching a live billing path. The JSON comparison works and matches the quote hop.

## PRs, smallest shippable first

| # | what | size | needs migration | risk |
|---|---|---|---|---|
| 1 | Extract the comparison core from `quote-reconcile.js` behind its current callers, no behaviour change | small | no | low |
| 2 | `POST /api/orders/reconcile_invoice` — order lines vs invoice lines, cumulative across prior invoices, returns verdicts. Read-only. | medium | no | low |
| 3 | Surface it on the invoice screen, and refuse **send** while an unaccepted blocking verdict stands | medium | no | medium — first thing that blocks a user action |
| 4 | `order_variance_decisions` + accept / request-amendment / cancel, applied to **both** hops | medium | **yes** | medium |
| 5 | Over-invoicing guard at creation, using the cumulative logic from PR 2 | small | no | medium — closes a path that currently succeeds |
| 6 | `amendment_requested` actually emails the customer | medium | no | **blocked** on the comms rail |

PRs 1–2 are inert: they add a read-only endpoint and change nothing an operator sees. The first
behavioural change is PR 3.

## Open questions for the owner

1. **Tolerance.** Should a rounding-level price difference (say ≤ ₹1 or ≤ 0.5%) pass silently, or is
   an invoice required to match the PO to the paisa? `ap/match.js` has a configurable tolerance
   already; the customer side may need to be stricter.
2. **Who decides.** Is accepting a variance a sales-engineer act or an approver act? It determines
   whether this is an RBAC `write` or an `approve` permission.
3. **Tax.** Is a GST-rate difference between PO and invoice a hard block, given the buyer's ITC
   depends on it?
