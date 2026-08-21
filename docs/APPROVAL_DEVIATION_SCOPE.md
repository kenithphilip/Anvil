# Deviation at the approval gate — scope

**Written** 2026-08-20 against `main`. Every claim marked *verified* was confirmed
by opening the file named. Three readers traced the path independently and every
load-bearing claim was re-checked.

## The requirement

> The obvious reason for checking a PO against a quote is to arrive at the PO
> acceptance question. Ideally this happens at review stage, and to the approver
> it needs to be understood that this deviation exists or not, and if it exists
> what's the potential impact.

---

## 0. Correcting what I told you earlier

I said the approver never sees the deviation. **That was wrong**, and the way it
was wrong matters.

The real approve button is in the SO workspace (`so-workspace.tsx:2018` →
`approveOrder` at `:631`), and the reconciliation banner renders at
`:2104-2258` — **above `<WSTabs>` at `:2260`**, so it is tab-independent and sits
on the same screen as the button. An approver working there *does* see
`⚠ PART: PO 1250 vs quote 1180 (+5.93%)`. *Verified.*

What I got right: there is no money figure anywhere, and no deviation can block
approval.

What I missed is worse than what I claimed — see §2.

---

## 1. There are three approval surfaces. One works.

| surface | what it does | verdict |
|---|---|---|
| **SO workspace** `so-workspace.tsx:2018` | PATCH `/api/orders/:id` `{status:"APPROVED", approval:{payloadHash}}` | **the only one that approves an order** |
| **Approvals queue** `approvals.tsx` | POSTs a `quote_approvals` row | **changes nothing about the order** |
| **Pipeline Kanban** `pipeline-kanban.tsx:139` | PATCHes `{status:"APPROVED"}` with no `approval` object | **always 400s** (`orders/[id].js:169`) |

The queue is the finding to sit with. `admin/quote_approvals.js` writes only to
the `quote_approvals` table — a `patch` at `:122`, an insert at `:132` — and
**never touches `orders`**. *Verified.* Nothing downstream reads `quote_approvals`
to gate a push or an approval.

So a manager who works the queue, presses approve on every row and goes home has
approved nothing. The orders are still `PENDING_REVIEW`. It is permissioned
`write`, not `approve`, and performs no blocker check.

**This outranks everything else in this document.** A deviation surfaced to a
queue that does not approve is worth nothing.

---

## 2. Two defects that silently defeat the comparison

### 2.1 — The approver's totals show the QUOTE's price, not the PO's

`quote-reconcile.js:189` enriches each matched line with

```js
discounted_unit_price: quotePriced ? quoteRate : (poRate ?? null)
```

*Verified.* The persisted line takes the **quote's** rate. So the line grid and
the grand total an approver reads are quote-priced — the deviation is
arithmetically erased from the very totals it should show up in. The banner says
the rates differ while the numbers beneath it agree.

This also means a rupee delta computed from the persisted lines would be **zero**.
It has to be computed from `_match.po_rate` / `_match.quote_rate`, which are
stamped per line and read by **no client code at all**.

### 2.2 — A quantity deviation is not a deviation

`quote-reconcile.js:176`:

```js
else { summary.matched += 1; if (qtyNote) summary.qty_note += 1; }
```

*Verified.* A line whose price and description agree but whose **quantity differs
from the quote** lands in the `matched` branch, never becomes a flag, and
`qty_note` is persisted and rendered nowhere.

A PO for 300 units against a quote for 30 reconciles clean. Given the quotation
that prompted this work states *"the quoted price is applicable only if the order
quantity is 60 units for both items"*, that is exactly the case the customer
wrote down and Anvil cannot see.

---

## 3. Nothing about a deviation blocks approval

`orders/[id].js:168-188` checks four things: a legal status transition, a
`payloadHash`, the `approve` permission, and `hasUnresolvedBlocker(rule_findings)`.

Only two things in the repo ever set `blocks: true` — the extraction
`line_count_shortfall` and the `-MOD` provisional-BOM finding. The reconciler's
output goes to `result.quoteReconciliation` and **never enters `rule_findings`**,
so it is structurally incapable of gating approve. *Verified.*

The override mechanism already exists and works: PATCH `{resolve_finding:{code,
note}}`, approve-permissioned, audited as `order_finding_resolved`, wired to an
inline note editor. It is offered **only** for blocking findings — so there is no
way to acknowledge a quote discrepancy, because there is nothing to acknowledge.

Also: `orders` has **no `created_by`** column (`001_init.sql:139-162` — only
`approved_by`). One `sales_manager` can upload the PO, attach the quote, run
reconcile and approve, in one session, with nothing recording that the same
person did all four.

---

## 4. Can we say what it costs?

### The rupee delta — arithmetic, not new data

Per flagged line the reconciler already has `po_rate`, `quote_rate` and `po_qty`
(`quote-reconcile.js:206`). So:

```
line delta   = (po_rate - quote_rate) * po_qty
order delta  = sum over flagged lines
```

Needs **no new table, no migration, no new extraction** — only that the numbers
are read from `_match` rather than from the enriched line (§2.1), and that
`_match` stops being read by nobody.

**Currency caveat.** `result.salesOrder.currency` exists but nothing normalises
across lines, and this codebase has form for summing mixed currencies and
labelling the result `₹`. Sum only within a single order currency and say so when
it is not INR.

### Margin impact — not available

Needs a landed cost reachable from an **order**. `price_composition_lines` is
keyed to `quote_id` and populated only when an operator opens the Composition
tab; there is no realized-cost path from an order at all. `#475` made the
**existing** order-level margin visible on the queue — that is quote-time
estimated margin, and it is a different question from *"what does this deviation
cost us"*.

Do not promise margin impact on a deviation until the cost side exists.

### Delivery date vs quoted lead time — a small new comparison

The quote states *"DELIVERY: 11-12 weeks from receipt of order"*. `#462` extracts
that into `delivery_terms` as **free text**; nothing parses it to a duration and
nothing compares it with `orders.committed_delivery_date` (migration 207).

A PO promising six weeks against a quote offering eleven passes silently today.
Parsing `N-M weeks|days|months` from the quote's own wording is a contained
addition; the comparison is then a date subtraction.

---

## 5. PRs, smallest and most valuable first

| # | what | size | migration | risk |
|---|---|---|---|---|
| 1 | **Make the queue's approve actually approve** — or, if it is meant to be a threshold sign-off rather than the order decision, say so on screen and remove the button's implication | small | no | **decide first**: this is a behaviour question, not a code one |
| 2 | Stop overwriting the PO's rate on the persisted line (§2.1), or keep both and make the totals PO-priced | small | no | medium — changes numbers on existing orders |
| 3 | `deviationValue(reconciliation)` in `_lib/` — per-line and order-level rupee delta from `_match`, single-currency guarded. Pure, unit-tested, no caller | small | no | low, inert |
| 4 | Surface it: `N deviations · ₹X against quote` on the approve surface, worst-first, with the existing banner as the detail | small | no | low |
| 5 | Raise a quantity flag when PO qty ≠ quoted qty (§2.2), and honour a stated MOQ / minimum-order condition | medium | no | medium — will flag orders that reconcile clean today |
| 6 | Parse quoted lead time and compare with `committed_delivery_date` | medium | no | low |
| 7 | Let a deviation raise a `rule_findings` entry so it can be acknowledged with a reason — reusing `resolve_finding`, which already works | medium | no | **high** — the first thing that can block an approval |
| 8 | Fix or remove the Kanban approve column | small | no | low |

PR 3 is inert. PR 4 is the first thing an approver sees. **PR 7 is the first thing
that can refuse an approval, and needs the tolerance and authority decisions in
`docs/PENDING.md` §1.1 answered first.**

---

## 6. Questions for the owner

1. **Is the Approvals queue supposed to approve the order?** If yes it is broken;
   if no, it is misleading. Everything in §5 depends on which.
2. **Should a deviation ever block approval, or only inform it?** PR 7 exists
   only if the answer is block.
3. **Must the approver be someone other than the uploader?** Today nothing
   prevents it and nothing records it — `orders` has no `created_by`.
4. **Is a quantity difference against the quote a deviation?** It is invisible
   today. Saying yes will flag orders that currently reconcile clean.
