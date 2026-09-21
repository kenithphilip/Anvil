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

### 2.J — Job shops: are we compatible, and what would it take?

Assessed in [JOB_SHOP_FIT.md](JOB_SHOP_FIT.md) from a real prospect profile — a
Pune precision-machining and fixture business, two plants, ~130 staff, 30+ CNC
machines, CMM to 2 microns, tier-1 automotive/aerospace/oil-and-gas customers,
exporting to Europe and the Americas.

**Useful today for the FRONT half of their business, absent for the back half.**
Anvil was built around a company selling its OWN products — catalogue, spare
matrix, installed base, aftersales. A job shop sells CAPACITY against someone
else's drawing.

**What already fits, and unusually well:** multi-format PO extraction (25+ OEM
layouts is exactly the problem we have spent most on); matching on the
CUSTOMER's part number — for a product company the buyer's code is a
convenience, for a job shop it is the only identity a part has, and #506/#508's
tiers describe their world more accurately than ours; quote↔PO reconciliation;
Mode A/B as an on-ramp; GST/e-invoice/e-way; drawing extraction.

**What is missing is the core of their business:** there is no operation, no
work centre, no machine, no routing anywhere in the schema. `bill_of_materials`
is parent→child parts — a structure, not a process. No capacity, no machine
envelope, no hourly rate. **They cannot quote in Anvil**, and quoting is where a
job shop wins or loses money. No work order or shop floor. No material-cert /
heat-number / CMM-report traceability, which is also what stands between their
ISO 9001 and the AS9100 their aerospace customers will ask for. No inbound-RFQ
workflow — their sales motion starts with a customer sending a DRAWING.

**The strategic question is not technical.** Three options in §4: stay a
product-company system and sell the commercial layer as a front end; build the
job-shop spine (routing, costing, work orders — a lot of company, against
entrenched incumbents in a price-driven segment); or take the INBOUND-RFQ WEDGE
only — drawing in, quote out, on the extraction machinery already built.
Option 3 uses what Anvil has rather than what it would have to become, and
estimating is the bottleneck in every job shop.

§5 lists what can honestly be said to such a shop today, and what must not be.

### 2.D — Nothing records what we actually shipped, per line

**ANSWERED 2026-09-21, and the answer redirected the work.** Owner: *"if it's
invoiced it has to leave the store, and against invoices a despatch register
format exists (generated in Tally by entering docket number, e-way bill details
if the item is above a particular amount)."*

Two consequences:

1. **The under-delivery leg is vacuous for this tenant.** Invoicing IS the
   despatch event, so nothing can be invoiced that has not left the store. The
   leg #538 built is correct and will report "not checked" forever here. That is
   the right behaviour, not a gap — leave it. It becomes meaningful only for a
   tenant who invoices ahead of despatch.
2. **What actually holds a consignment is the paperwork**, and the despatch
   register names it: the docket number and the e-way bill. Built instead — see
   below. `dispatch_lines` already had `lr_number`, `carrier`, `invoice_number`
   and `invoice_date`: migration 193's schema is a direct mirror of the Tally
   register, which is why nothing needed adding to it.

Shipped as the dispatch-readiness check: `_lib/dispatch-readiness.js` decides
whether an e-way bill is required (threshold by place of supply, both figures
tenant settings via migration 225 — they are jurisdictional and intra-state
thresholds differ per state), whether one is actually filed as GENERATED rather
than DRAFT/CANCELLED/EXPIRED, whether a road bill has a vehicle, and whether any
docket exists at all. It REFUSES — `required: null`, never false — when the
consignment value or the place of supply cannot be determined.

**Still open, and now the real gap:** nothing WRITES the despatch register. The
docket number is entered by hand in Tally at despatch, and Anvil never sees it,
so `docket_missing` will fire on every invoice until something captures it. The
options remain a `delivery_note` extraction kind, a workbook importer on the
`sales/shipment_import.js` pattern, or rendering the `delivery_note` template
migration 106 already anticipates. That is a data-capture decision, not a
reconciler one.

Original scoping follows, kept because the dead ends are worth not
rediscovering.

#538 added the under-delivery leg to the pre-send invoice check: are we billing
more than we shipped? A buyer raises their goods receipt against what arrived,
so this is one of the four reasons an invoice goes unpaid. The leg is built,
tested and correct — and it reports **"not checked"** on every order, because
its data source is empty.

`dispatch_lines` (mig 193) is the right table. It is read by the dispatch
register, the pending-SO view and the comms rail. Its writer exists
(`upsertDispatchLines`, `POST /api/comms/dispatch_lines`) and is tested. What
does not exist is anything that CALLS it: no client method, no UI, no importer,
no ERP sync, no seed.

**Every other candidate source fails, and each for a different reason:**

| candidate | why it does not work |
|---|---|
| `shipment_lines` (mig 209) | Populated from the logistics workbooks — but keys on `source_po_id`, so it is the INBOUND import ladder. Wrong direction. |
| `packing_list` extraction + `documents/packing_list_ingest.js` | Real and working, but inbound supplier packing lists, and it writes only `item_master.weight_kg`. Its own comment deliberately refuses the shipment ladder because "which shipment?" has no safe answer there. That refusal was right. |
| `eway_bills` (mig 074) | Carries `line_items` and is really written — but generated FROM the invoice, so validating the invoice against it is circular. |
| Tally delivery-note sync | Never implemented. `tally_voucher_state` is empty and no tenant has Tally connected, so the eleven files under `src/api/tally/` have never run. |
| `delivery_note` document template | A value in mig 106's `doc_type` CHECK and an `<option>` in the admin template editor. No renderer, no issuer — a tenant can author the template and nothing ever produces one. |
| Manual entry form | Violates the prefill rule: data-capture forms must prefill from a DocAI extract plus existing masters, not ship blank fields. |

**The question only the owner can answer: what physically exists when goods
leave the door?** The work is different for each, and picking wrong makes it
useless:

- **A Tally delivery challan / delivery note PDF** → a new `delivery_note`
  extraction kind. Most Anvil-native, reuses the strongest thing we have, and
  the document is upstream of the invoice so the check stays non-circular.
- **An Excel dispatch tracker the logistics team already maintains** → a
  workbook importer on the `sales/shipment_import.js` pattern, which is proven
  and already handles their file conventions. Cheapest and most certain.
- **Nothing structured — it lives in the transporter's LR and people's heads**
  → then the honest move is to render the `delivery_note` template that mig 106
  already anticipates, making Anvil the thing that produces the dispatch record
  instead of trying to read one. Biggest build, and the only one that also
  gives the customer a despatch document.

Until this is answered, #538's leg stays dormant. That is the correct behaviour
— it refuses rather than guessing — but it is not yet useful.

---

### 2.PM — Project management: the schedule runs through lead times, not tasks

Scoped 2026-09-21 in `docs/PROJECT_MANAGEMENT_SCOPE.md`. Nothing built.

Asked after reviewing an open-source task-manager comparison. The comparison is a
useful negative result: by its own admission all five tools lack Gantt, critical
path, estimates-vs-actuals and team assignment. Integrating one would add a second
place to type things and would not touch the stated problem — that the long-lead
component must be ordered before the design specifying it is signed off.

**The surprise is how much already exists.** `projects` (mig 006) carries the
entire schedule baseline — six `expected_*_date` milestones, three
`budgeted_*_mandays` effort figures — and a 15-value `project_phase` enum whose
phases ARE the described time sink (`PRICE_NEGOTIATION`, `DESIGN`,
`APPROVAL_PROCESSING`). `project_phase_log` carries the actual: phase,
`started_at`, `completed_at`, `responsible_user`, `progress_pct`. So schedule
variance is computable from data already stored, and **nothing computes it** —
`sales/projects.js` is CRUD that writes those fields and no code reads them for
analysis. Fifth instance this session of build-it-and-never-wire-it.

The scheduling primitives exist too: `_lib/datemath.js` already does working-day
arithmetic with per-country holidays, and `_lib/spare-minmax.js` already parses
free-text lead times.

Genuinely absent: any task/dependency object, a per-part lead time, a backward
pass from required date to order-by date, and any variance reporting.

Six PRs in the scope doc. PR 1 is the whole bet and needs **no new tables**:
compute `order_by = required − lead − transit − inspection` in business days per
BOM component and show the slack. It makes an invisible deadline visible from data
already held, and it must REFUSE on an unresolvable lead time rather than default
to 56 days — a default dressed as an estimate is how a schedule tool loses trust
in week one.

Five open questions in the doc, two of which gate everything: whether the phase
timestamps are recorded as work happens or retro-filled in batches, and whether
the customer's required date is contractual or aspirational.

---

## 3. Known-unfixed defects

Each verified, none currently breaking a user flow.

- ~~The reconciler never matches on `customer_part_number`~~ — **fixed**
  (#506, #508). Three tiers now: our code, the buyer's code on a quote line,
  then the canonical `item_customer_parts` map.
- ~~`forecast_snapshots` has no cron~~ — **fixed** (#507). Registered in the
  daily group, drained per tenant, with the writer shared between the cron and
  the admin button.
- ~~`#467` has no UI caller~~ — **fixed**: an "Invoice vs PO" tab on the SO
  workspace. Read-only; refusing to SEND on a blocking verdict is still PR3 and
  still gated on §1.1.
- **The analytics refresh is a sequential per-row upsert** — fine at current
  volume, a timeout at scale.
- ~~**`app.tsx:188` listens for `anvil:session`, which nothing emits.**~~ Fixed
  in PR #535, and it was worse than recorded here. The listener's handler was
  `setRoute((r) => r)`, which React bails out of, so the `storage` listener
  beside it was equally inert — and the note's own reassurance ("same-tab
  sign-in works via the ordinary re-render") was true only by luck. The case
  that never worked: sign out in one tab and the other tab keeps rendering the
  authenticated Shell, because the cross-tab listener re-routes only when
  `next?.access_token` is truthy. The client now dispatches `anvil:session`
  from its writeSession/clearSession funnel, which also covers the 401 handler
  and the blank-backend-url path, neither of which propagated at all.

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
