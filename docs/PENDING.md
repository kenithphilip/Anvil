# Pending

Snapshot at 2026-08-20. Everything here is either verified in the code or an
explicit decision waiting on the owner. Items are removed when done, not ticked.

---

## 1. Decisions only the owner can make

Nothing below is blocked on engineering.

### 1.1 — Three answers gate PR3 of the PO↔invoice reconciler

PRs 1 and 2 are merged (#464, #467) and are read-only. PR3 is the first change
that would **refuse a user action**, so it should not be built on a guess.

- **Price tolerance.** Must an invoice match the PO to the paisa, or is a
  rounding allowance acceptable? `ap/match.js` already has a configurable
  tolerance on the supplier side; the customer side may need to be stricter.
- **Who may accept a variance.** Sales-engineer act (`write`) or approver act
  (`approve`)? This decides the RBAC permission, not just the button.
- **GST-rate differences.** Hard block, given the buyer's input-tax credit
  depends on the rate matching?

### 1.2 — How a lost order is recorded

`order_status` has no `LOST`, `REJECTED` or `EXPIRED`
(`001_init.sql:118-121`, no later `ALTER TYPE`). Until it does, win/loss can
only ever report wins: `quotes_lost`, `quotes_expired`, `total_lost_value` and
`lost_reasons` are structurally zero, and "win rate" actually means *% of POs
that reached APPROVED*. Needs a migration and a decision about where a loss is
captured.

### 1.3 — Is `anvil.app` a domain we own?

Five "Book a demo" CTAs are `mailto:hello@anvil.app`; the product is deployed
at `anvil-flame.vercel.app` and **nothing in the repo configures that domain**.
If it is not ours, every inbound lead bounces or reaches a stranger. Everything
else in `docs/LANDING_PAGE_BACKLOG.md` is downstream of this answer.

### 1.4 — Quote schema: MOQ as text or as a number

#462 puts MOQ into `quote_lines.remark` as free text, which works and is not
queryable. A real `moq numeric` column plus price breaks is the alternative.
Only worth doing if MOQ needs to be *checked* against PO quantity rather than
merely displayed.

---

## 2. Open engineering work, in the order I would take it

### 2.1 — DONE: the approval path is verified

See `docs/APPROVAL_DEVIATION_SCOPE.md`. Headline: the **Approvals queue does not
approve orders** — it writes a `quote_approvals` row and never touches
`orders.status`. The only working approve is in the SO workspace, where the
deviation banner IS already visible. Two silent defeats found: the persisted line
takes the QUOTE's rate so the approver's totals hide the deviation, and a
quantity difference against the quote is counted as `matched`.

Four questions for the owner are at the end of that document; the first one
(is the queue meant to approve?) gates the rest.

### 2.1b — Superseded framing, kept for the record

The owner's framing: the point of comparing a PO to a quote is to reach the
**PO acceptance decision**, which belongs to the **approver at review** — who
needs to know whether a deviation exists and what it would cost.

Measured against that, the SO workspace currently offers six separate surfaces
(attach panel, quotes card, quote viewer, reconcile banner, variance control,
quote-check button) and none of them says *accept* or *do not*.

**Not yet verified, and must be before proposing anything:** whether a blocking
finding reaches the approver at all, what the approve action shows, and whether
the reconciliation result is readable from the approval screen.

Two halves, with very different costs:

- **Available now.** The deviation as a single verdict with a **rupee** figure —
  quoted price x PO qty versus PO price x PO qty, per line and summed. Today a
  price mismatch reports only a *percentage*, and nobody approves on a
  percentage. No new tables required.
- **Not available.** Margin impact. Per `backlog_margin_bi`, an operator cannot
  see margin on a PO before approving, the pricing engine is bolted to the
  quote rather than the order, and there is no realized-cost path.

### 2.2a — DONE since this doc was written

- **The deviation now has a rupee figure** (#478). `_lib/deviation-value.js`,
  surfaced on the approve surface. Three separate numbers — over/under against
  agreed prices, unquoted-line exposure, and quoted-not-ordered — deliberately
  not summed. Currency-guarded; unpriceable exceptions counted rather than
  dropped. This INFORMS; nothing blocks yet.
- **Supplier RFQ compared bids on raw digits across currencies** (#479). A
  ¥1,500 bid lost to a $20 bid while being less than half the price. Now ranked
  on converted value against `fx_rates`, and no winner is crowned at all when a
  rate is missing.
- **The approvals margin column was blank on every row** (#475) — two
  derivations existed and the queue used the broken one.

### 2.2 — Reconciler PRs 3-6

From `docs/PO_INVOICE_RECONCILER_SCOPE.md`. PR3 surfaces the check and blocks
invoice **send** on a blocking verdict; PR4 adds `order_variance_decisions`
(accept / request-amendment / cancel) and needs a migration; PR5 is the
over-invoicing guard at creation; PR6 emails the customer and is **blocked** on
the internal comms rail.

### 2.3 — The shipment import has never completed

Roughly **130 of ~1,013 rows**. Every known code defect is fixed and merged; it
needs someone to hard-refresh, select the two workbooks and press Preview then
Apply. It cannot be finished without a human at the file picker.

### 2.4 — Landing page

`docs/LANDING_PAGE_BACKLOG.md` — ten ordered items. The two with real exposure
are the domain question (1.3 above) and four trust badges asserting compliance
the code does not support.

---

## 3. Known-unfixed defects

Each verified, none currently breaking a user flow.

- **The reconciler never matches on `customer_part_number`** — only on our own
  part code. A PO carrying only the customer's reference cannot match.
- **`forecast_snapshots` has no cron.** `forecast/index.js:4` documents it as
  nightly; `cron/daily.js` registers 13 jobs and forecast is not one. The
  cockpit's weighted-pipeline figures are as old as the last manual click.
- **The analytics refresh is a sequential per-row upsert** — fine at current
  volume, a timeout at scale.
- **`app.tsx:188` listens for `anvil:session`, which nothing emits.** Dead
  wiring that reads as live; same-tab sign-in works via the ordinary re-render.
- **`#467` has no UI caller** — deliberate, but nothing yet checks invoices
  against POs in practice.

---

## 4. Deliberately not done

- **Hard-deleting duplicate documents.** #472 unlinks the redundant attachment
  and keeps the file, because the `documents` row is referenced by audit
  events, extraction runs and evidence rows. Deleting it to tidy a screen would
  break the trail explaining how an order was priced. Say so if the bytes
  should actually go.
- **Backfilling `invoices.customer_po_number`** (migration 214). We cannot know
  whether an old invoice was issued against the PO its order now names, and
  inventing that reference on a legal document is worse than a blank.

---

## 5. Stale PRs not mine

`#287`, `#269`, `#268`, `#238`, `#237`, plus dependabot. Untouched this
session; none reviewed.
