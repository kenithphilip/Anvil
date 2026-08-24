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

### 2.2b — Freight assumption engine (scoped, not started)

`docs/FREIGHT_ASSUMPTION_ENGINE.md`. Two findings changed the plan: a mass
estimator already exists (`_lib/pdm/raw-material-infer.js`, density x
dimensions, wired to a screen) and writes to `composition_material_lines`
rather than `item_master.weight_kg`; and carrier identity does not exist
(`freight_bids.carrier` is free text, `logistics_carriers` read by nothing), so
no forwarder track record can accumulate until that is fixed. PRs 1-5 involve
no model at all. PR 0 is a query, and its answer decides the rest.

### 2.3 — The shipment import has never completed

Roughly **130 of ~1,013 rows**. Every known code defect is fixed and merged; it
needs someone to hard-refresh, select the two workbooks and press Preview then
Apply. It cannot be finished without a human at the file picker.

### 2.4 — Landing page

`docs/LANDING_PAGE_BACKLOG.md` — ten ordered items. The two with real exposure
are the domain question (1.3 above) and four trust badges asserting compliance
the code does not support.

---

### 2.N — Capital-items product catalog (configurator)

Scoped in [PRODUCT_CATALOG_SCOPE.md](PRODUCT_CATALOG_SCOPE.md). The sales
workbook is a configurator hand-built in Excel five times — *family + option
values → part number* — and the ATD sheet is simultaneously an option matrix
and a bill of materials.

The reason to do it is not the spreadsheet. `opportunity_line_items` has
required a `product_family` since migration 086, and its own comment says the
engine "falls back to the (family, category) → part_no map maintained on
item_master". **That map was never built** — `item_master` has no
`product_family` column and nothing in `src/api` resolves one. Every forecast
line has carried an unresolvable family ever since.

Three new tables (`product_families`, `product_options`, `product_variants`);
everything else extends `item_master` / `inventory_positions` /
`item_customer_parts` / `bill_of_materials`. Every line table in Anvil joins on
`part_no text`, so a catalog that resolves to one reaches every stage without
re-keying anything.

PRs 1–3 (model → importer → resolve the 086 hole) are the spine and are worth
doing on their own. Five owner questions are listed in §10 of the scope doc;
the identity question (part number vs model code — 81 cells carry both) blocks
PR 1.

Adjacent and deliberately separate: engineering change control does not exist
in any form, and the design sign-off the request describes has no home —
`gun_drawings.approval_status` is a provision its own migration says is "not
enforced yet" (`commit.js` never reads it, no UI sets it, an uploader can
approve their own drawing), and `bom_assets.approval_status` is touched by zero
lines of application code.

### 2.M — Mode A / Mode B: prove the accuracy before depending on it

Scoped in [MODE_A_B_SCOPE.md](MODE_A_B_SCOPE.md). A tenant chooses whether Anvil
PROCESSES their sales orders (Mode A) or only WATCHES while a person does it in
Tally (Mode B) — and either way Anvil scores itself against what Tally actually
recorded.

Most of it exists. `tally/sync.js` already pulls EVERY voucher altered in Tally
since a watermark — not only ones Anvil pushed — into `tally_voucher_state` with
the full payload in `raw`. `tally/reconcile.js` already has drift runs, findings
and resolution with a UI. `eval/score.js` + `kind-profiles.js` already do
profile-driven field comparison with tolerances. Missing: a mode flag, the
`Buyer's Ref./Order No` → `orders.po_number` join, and an `so_tally` profile.

**PR 0 IS DONE (2026-08-24) and it changed the plan.** `tally_voucher_state` is
empty and NO TENANT HAS TALLY CONNECTED — the bridge has never carried a byte.
The comparison does not need a connection: it needs the Tally sales order, and
the customer already exports that as a PDF (the pair that produced every
structural finding arrived that way). Requiring a connector for Mode B was
backwards anyway — its whole promise is "change nothing about your process".
Now missing: a `sales_order` extraction kind, golden fixtures for it, the join
on the buyer's reference, the report, and the mode selector. No bridge. See §0a
of the scope doc.

**The finding that shapes it:** on the first real PO→SO pair, two fields
disagreed with the PO and neither was Anvil's doing — the PO stated payment
after 60 days, the SO said 30; the PO allowed 6–8 weeks, the SO committed to
~4. So the report is not "how accurate is Anvil" but "where do the PO, Anvil and
Tally disagree, and who was right". That reframing is what makes it sellable in
Mode B, where Anvil has no authority at all.

### 2.P — A product manifesto / first principles

Asked for 2026-08-24: a set of first principles to guide product iteration and
product management.

**Not a blank page.** Anvil has been making the same handful of judgements
over and over, and they are recoverable from the code and the commit history
rather than needing to be invented. A manifesto assembled from decisions
already taken is one the team can recognise; one written from scratch is a
wish-list. Candidates, each with a real instance behind it:

1. **Machinery that is built and never wired does not exist.** `prompt-versions.js`
   sat unwired for a year, `plm_changes` and `plm_boms` were written on every
   cron tick and read by nothing, migration 124's `prompt_version` column was
   never written to, `gun_drawings.approval_status` is a provision its own
   migration calls "not enforced yet". This is the single most-repeated failure
   in the repo.
2. **A label must never outrun the truth.** A run tagged `v2` that ran the
   default prompt; a `dedupKey` that deduplicates nothing; a comment asserting
   parity between two adapters that had diverged. If the system says it did
   something, it must have done it.
3. **Default to undecidable.** A harness that resolves ambiguity in somebody's
   favour is worse than one that admits the gap — see the exception engine that
   fired ~2,000 mostly-wrong criticals and got switched off.
4. **Quiet is not the same as broken, and the difference must be visible.**
   "0 drifted" reads identically whether everything matched or every tree was
   refused; those call for opposite responses.
5. **Never ask for what the document already says.** The PO names its order,
   the sales order names the PO it answers. Joel's standing "reduce clicks"
   lens.
6. **State the cost, not only the benefit.** A selector listing only upsides is
   a recommendation wearing a toggle.
7. **The authority is per-field.** Agreement with a person is not correctness.
8. **A change arriving must not change behaviour nobody asked to change** —
   the reasoning behind both migration 218's default-off and 221's default-A.
9. **Fail closed on a discriminator, open on an attribute.** The 42703 retry
   that dropped `extraction_kind` and cost a customer's PO lines.

**Open questions for the owner:** is this a document for the team, for
customers, or for both? Who arbitrates when two principles conflict — (5) and
(6) pull against each other on any screen that removes a decision. And does it
carry authority over a roadmap item, or only over how one is built?

### 2.K — Kit lines: when one PO line is a whole quote

Scoped in [KIT_LINE_SCOPE.md](KIT_LINE_SCOPE.md), from a real project order.

The customer took each of two multi-line quotations, lifted the labour line
out, and ordered the remaining goods as ONE priced SET — then combined the
labour from both quotes into a third PO line. The arithmetic is exact to the
rupee in both directions, so the relationship is provable rather than inferred.

**Today this reads as a total failure on a correct order.** The reconciler is
one-to-one, so all three PO lines come back unmatched and ~40 quoted lines come
back never-ordered — forty invitations to add a variance that should not exist.
Worse, the sales order would carry three lines called "one SET", so no work
order can be raised for the transformer, the pendant or the six hose variants,
`bill_of_materials` never sees them, and aftersales records a SET rather than
its contents.

**The constraint that shapes the design:** the customer-facing figure must not
change. They ordered one SET at one price and the invoice has to say so or it
will not be paid. A kit line is therefore BOTH a header (one line, SET price —
invoice, acknowledgement, AR) AND a composition (the quote's lines at quote
prices — work orders, BOM, inventory, spares). Neither derives from the other;
both are recorded.

**Do the extraction fix first (§5 of the doc).** The quote's lines were not
extracted at all, and a kit match is arithmetic against those lines — without
them there is nothing to compute with. Two checkable causes: `QUOTE_SYSTEM_PROMPT`
has ZERO of the 34-line multi-row block `SYSTEM_PROMPT` carries and calls "the
single biggest cause of a shredded line count" (100 lines vs 171); and the
layout has two price column GROUPS rather than the two adjacent columns #462
designed `unitPrice`/`listUnitPrice` for, with the SPECIAL PRICE group being
the one the totals are struck from.

**That prompt gap is the THIRD instance of one drift pattern** — the same block
missing from gemini.js (#491), the unsupported_kind guard on one adapter only
(#485), and now a prompt fix on one document kind and not its sibling. It is
not adapter-specific: a fix lands where the bug was reported and nowhere else.

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
