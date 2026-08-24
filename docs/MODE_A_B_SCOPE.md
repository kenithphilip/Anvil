# Mode A / Mode B: prove the accuracy before you depend on it

Scoping note. A tenant chooses whether Anvil *processes* their sales orders or
merely *watches* while a person does it in Tally — and either way, Anvil scores
itself against what Tally actually recorded. Backlog; nothing built.

Grounded in one real PO → Tally SO pair supplied 2026-08-23. Identifiers are
paraphrased below; the structural findings are exact.

---

## 0a. REVISED 2026-08-24 — the foundation was wrong

**`tally_voucher_state` is empty and no tenant has Tally connected.** PR 0 was
asked precisely to find this, and it did: everything below §0 was designed
around the Tally bridge, and the bridge has never carried a byte for anybody.

That does not block Mode A/B. It corrects it.

**The comparison does not need a Tally connection. It needs the Tally sales
order, and the customer already has that as a PDF.** The pair that produced
every structural finding in §1 arrived that way — exported from Tally and sent
over. Nobody had to integrate anything.

And requiring a connector for Mode B was backwards on its own terms. Mode B's
whole promise is *change nothing about your process*; asking a customer to
install an ERP bridge before they trust the software is a bigger ask than the
thing they are evaluating. A customer who will never connect Tally to a
vendor's system is exactly the customer Mode B exists for.

### What this changes

| | was | now |
|---|---|---|
| How Anvil sees the Tally SO | reverse sync into `tally_voucher_state` | **extract the PDF the customer already exports** |
| Prerequisite | a working Tally bridge per tenant | none |
| Missing piece | the voucher→order join | a `sales_order` extraction kind |
| Reuses | `tally/reconcile.js` drift machinery | **the extraction pipeline**, hardened all through #486–#493 |

The join key is unchanged and still clean: the SO prints `Buyer's Ref./Order No`,
`orders.po_number` holds the other side. The adjudicator (#503) plugs in
unaltered — it takes three values and a spec, and does not care how any of them
were obtained.

### What is genuinely missing now

1. A **`sales_order` extraction kind** — schema, prompt, a branch in both
   adapters (grep BOTH; that drift has cost this repo three times), and the
   `extraction_kind` CHECK.
2. Golden fixtures for it, per #489's per-kind profiles.
3. The **join** from an extracted SO to its order, on the buyer's reference.
4. The **three-way report**, feeding `adjudicateField`.
5. The **mode flag and selector**.

Notably absent from that list: a bridge, a connector, credentials, or an IT
project on the customer's side.

### The bridge is not wasted, but it is not the on-ramp

Eleven files under `src/api/tally/` — push, sync, reconcile, drift_addon,
health, diagnostics, masters, amend, retry, validate, companies — plus a paid
SKU gated on `tally_drift_addon_enabled`, have never run against a live
connection. That is worth knowing on its own.

Once a tenant trusts Anvil enough to connect Tally, the push-and-drift path is
the mature version of this and it is already built. But it is the destination,
not the doorway, and the doorway is what Mode B was asked for.

---

## 0. The short version

The comparison is the product. A customer will not hand sales-order processing
to software on a promise, and "our extraction is 97% accurate" is a claim about
a benchmark, not about their POs. What convinces them is a month of *their own*
orders where Anvil's answer and their clerk's answer are put side by side.

Most of the machinery exists. `tally/sync.js` already pulls **every** voucher
altered in Tally since a watermark — not only ones Anvil pushed — into
`tally_voucher_state` with the full payload in `raw`. `tally/reconcile.js`
already runs a drift check, persists findings, and has a runs/findings model
and an admin screen. `eval/kind-profiles.js` already does profile-driven
field-by-field scoring with per-field tolerances.

What is missing is small and specific: a **mode flag**, a **join key**, and a
**profile** describing which fields must agree.

---

## 1. What the real pair shows

A single-line PO and the Tally SO raised from it.

| | PO (customer → us) | Tally SO (us) |
|---|---|---|
| reference | `PO No` | **`Buyer's Ref./Order No`** ← the join |
| our doc no | — | `Voucher No` (Tally's own sequence) |
| buyer's code | `Item Code` | `Cust Part No` |
| our code | *absent* | **`Part No`** ← the lookup Anvil must get right |
| qty / rate / disc | present | present, identical |
| line amount | ex-tax | ex-tax, identical |
| document total | **grand total, tax-inclusive** | **ex-tax** |
| delivery | "Within 6-8 weeks" | `Due on` — a specific date |
| payment | "after 60 days on receipt of goods" | `30 Days` |
| batch | — | the PO number |

Five things follow directly.

**1. The join key is clean.** The SO carries the PO number in
`Buyer's Ref./Order No`. No fuzzy matching, no date-window heuristics. Anvil's
`orders.po_number` already holds the other side.

**2. The part-code translation is the thing worth measuring.** The PO names the
buyer's code; the SO carries both that *and* our own part number. Nothing in
the PO says what our code is — a person looked it up. That mapping is
`item_customer_parts`, it is where a manual process actually errs, and it is
the single field whose accuracy most justifies the product.

**3. Totals are not comparable as printed.** The PO's grand total is
tax-inclusive; the SO body is ex-tax and its total equals the PO's *subtotal*.
Comparing the two printed totals would fail every correct order. The
comparison must be per-line and ex-tax, which is what `scoreCase` already does.

**4. Tally assigns things Anvil cannot predict** — the voucher number and
voucher date. These must be excluded from scoring exactly as `modelOwnedExpected`
already strips `grandTotal` and item-master-backfilled `hsn` before a live
replay.

**5. And the finding that decides the framing.** In this pair, **two fields
disagree with the PO — and neither is Anvil's doing**:

- the PO states payment *after 60 days on receipt of goods*; the SO says
  **30 days**
- the PO allows *6–8 weeks*; the SO commits to a date about **4 weeks** out

Both are a person's entry departing from the document. Whatever else this
harness does, on its first real pair it finds two commitments the business made
that its customer's PO did not ask for — one of them a payment term worth 30
days of working capital.

So the report is not "how good is Anvil". It is **"where do the PO, Anvil and
Tally disagree, and who was right"**. That reframing matters: it is sellable in
Mode B, where Anvil has no authority at all, and it is the honest description
of what the numbers mean.

---

## 2. The two modes

| | **Mode A — Anvil processes** | **Mode B — Anvil observes** |
|---|---|---|
| who creates the SO | Anvil, pushed to Tally | a person, by hand in Tally |
| Anvil's role | system of action | system of record + auditor |
| what Anvil writes to Tally | the voucher | **nothing** |
| the comparison | Anvil's pushed SO vs Tally's stored SO — catches drift *after* the fact | Anvil's *proposed* SO vs the person's SO — catches disagreement *before* Anvil is trusted |
| failure cost | a wrong voucher in the ledger | a line in a report |
| who it is for | a tenant that has already seen the numbers | a tenant deciding whether to |

Mode B is the on-ramp, and it is safe by construction: Anvil computes an SO,
stores it, pushes nothing. The customer's process is untouched. After a month
they have a scored comparison over their own orders, and the decision to switch
to Mode A is evidence-led rather than a leap.

**The comparison runs in both modes.** In B it earns trust; in A it keeps it —
a clerk amending a pushed voucher in Tally is exactly the drift `reconcile.js`
was built for.

---

## 3. What exists, and what does not

| Piece | State |
|---|---|
| Pull vouchers from Tally | exists, but **has never run** — no tenant has Tally connected and `tally_voucher_state` is empty. See §0a: the design no longer depends on it |
| Mirror table | **exists** — `tally_voucher_state`, keyed `(tenant, company, external_voucher_no)` |
| Drift run + findings + resolution | **exists** — `tally/reconcile.js`, `drift_check` mode, runs/findings history, admin screen |
| Field-by-field scoring with tolerances | **exists** — `eval/score.js` + `kind-profiles.js` |
| Buyer-code → our-code map | **exists** — `item_customer_parts` |
| Anvil's proposed SO | **exists** — `orders.result.salesOrder`, and `so_pdf` already renders it in the Tally layout |
| Suppress the push in Mode B | **missing** — one gate |
| Link a pulled voucher to an Anvil order | **missing** — the `Buyer's Ref./Order No` → `orders.po_number` join |
| Line-level detail in the pull | **UNKNOWN** — `tally_voucher_state` stores `total`, `status`, `altered`, `cancelled` and `raw`; whether `raw` carries lines depends on the bridge. **Verify before anything else** |
| A scoring profile for an SO | **missing** — a `so_tally` profile |
| Mode selector + explanation | **missing** |

---

## 4. The build

**PR 0 — DONE, and it changed the plan.** The question was whether the bridge
returns voucher lines. The answer was that the bridge has never run at all:
`tally_voucher_state` is empty, no tenant has Tally connected. See §0a — the
input is the SO PDF the customer already exports, and PRs 1–5 below should be
read against that, not against the bridge.

```sql
select external_voucher_no, voucher_type,
       jsonb_pretty(raw) as raw
from tally_voucher_state
where tenant_id = '<tenant>' and voucher_type ilike '%sales order%'
order by last_seen_at desc limit 1;
```

**PR 1 — the mode flag.** `tenant_settings.so_processing_mode` (`'A'|'B'`,
default `'A'` so nothing changes for anyone). Gate `tally/push.js`: in Mode B it
refuses with a clear reason rather than silently no-oping — a push that quietly
does nothing is how a tenant discovers the mode by finding an empty ledger.

**PR 2 — the join.** Resolve a pulled voucher to an Anvil order by the buyer's
reference. Pure `_lib/tally-so-match.js`, tested against the shapes the bridge
actually returns.

**PR 3 — the profile.** An `so_tally` entry in `kind-profiles.js`: match lines
on the buyer's part code; score our part no, qty, rate, discount, ex-tax
amount; **exclude** voucher number and voucher date. Reuses `scoreCase`
unchanged.

**PR 4 — the three-way report.** PO vs Anvil vs Tally, per field. Three
outcomes, not two: *agree*; *Anvil differs from Tally*; **and *both differ from
the PO*** — the case the real pair produced twice. Rides `tally_reconcile_runs`
/ findings rather than adding a table.

**PR 5 — the selector.** Admin > a Mode card. Both paths described in the
customer's terms, the current mode, and — once PR 4 has data — the running
score, because that is the number the decision turns on.

---

## 5. What not to build

- **A second comparison engine.** `scoreCase` already does per-field compare
  with tolerances and distinct-line matching. A `so_tally` profile is the
  whole extension.
- **A new findings table.** `tally_reconcile_runs` + findings already model
  run → findings → resolution, with a UI.
- **Writing to Tally in Mode B — including "safe" writes.** The mode's entire
  promise is that the customer's ledger is untouched.
- **Auto-switching a tenant to Mode A on a good score.** The decision is the
  customer's; the report informs it.

---

## 6. Adjudication: who was right

Answering the question §7.2 raised. Implemented as
`src/api/_lib/three-way-adjudicate.js` — pure, 24 tests — because a design
this easy to get subtly wrong is better specified in code than in prose.

### The rule

**A field is never judged by Anvil-vs-Tally. It is judged by what each of them
says against an AUTHORITY.** Agreement between Anvil and a clerk is not
evidence of anything; both can be wrong together, and on a real pair they
nearly were.

Seven outcomes:

| verdict | meaning | counts against |
|---|---|---|
| `agree` | authority, Anvil and Tally all match | nobody |
| `anvil_correct` | Anvil matches the authority, Tally does not | the manual process |
| `anvil_wrong` | Tally matches the authority, Anvil does not | **Anvil** |
| `both_deviate` | Anvil and Tally agree *with each other*, not the authority | both |
| `all_differ` | three different answers | both |
| `undecidable` | the authority is silent, or could not be read | nobody |
| `not_applicable` | nothing outside Tally could know this field | nobody |

### `both_deviate` is why this exists

The PO stated payment after 60 days; the Tally SO said 30. Suppose Anvil had
*also* said 30 — because it defaulted to the customer master's usual terms
rather than reading the document. A two-way comparison scores that field
**agreed, perfect**, while the business has committed to terms worth 30 days
of working capital that its customer never asked for.

Only the three-way view sees it. That single case is the whole argument.

### The authority is per field, not global

The awkward fields are awkward in *different* ways, and one global authority
forces them all to be fudged the same way:

| field | authority | why |
|---|---|---|
| qty, rate, discount, ex-tax amount, buyer's part code | **the PO** | stated literally on the document |
| **our own part number** | **`item_master`** | the PO carries the *buyer's* code and never says ours. Judged against the PO it would be permanently `undecidable`; judged against the map it is the most valuable field in the comparison |
| voucher number, voucher date | **none** | Tally's own sequence — not a pass, not a fail |
| payment terms, delivery date | the PO, *once a normaliser exists* | prose. `undecidable` until someone writes and tests one |

### Default to undecidable

A field with no normaliser, a silent authority, or a value the normaliser
cannot read returns `undecidable` and is excluded from **both** the numerator
and the denominator. Resolving ambiguity in somebody's favour is worse than
admitting the gap — and this repo has already watched an exception engine that
fired ~2,000 mostly-wrong criticals get switched off. A harness nobody trusts
measures nothing.

That is also the phasing rule: ship the literal fields, where decidability is
near-perfect, and let each interpreted field earn its way in behind its own
tested normaliser.

### Two rates, never one

- **`anvil_error_rate`** = (`anvil_wrong` + `both_deviate` + `all_differ`) ÷ decidable
- **`process_deviation_rate`** = (`anvil_correct` + `both_deviate` + `all_differ`) ÷ decidable

`both_deviate` counts against *both*, symmetrically: neither party matched the
authority, and agreeing with the clerk is not an excuse.

Reporting only the first would bury the finding that sells the product. A
tenant deciding whether to trust Anvil needs both numbers — how often Anvil is
wrong, **and how often the process they have today already is**.

Both are `null`, never `0`, when nothing was decidable. A rate over an empty
denominator reads as a perfect score.

### Still to design

- **Evidence.** Every verdict should cite the PO span it was decided from. The
  pipeline already stamps `field_provenance` and per-glyph bboxes (#323), so
  the link exists; wiring it is not yet designed.
- **Override.** An operator must be able to overrule a verdict with a reason —
  "the customer agreed 30 days by email". That is an amendment made outside the
  PO, and recording it both stops the finding recurring and creates the trail
  that a term was deliberately changed. It is what turns the harness from a
  report into a control.

---

## 7. Open questions

1. Does the bridge return voucher lines? (PR 0 — everything below depends.)
2. ~~When Tally and Anvil disagree and the PO supports Anvil, is that scored as
   an Anvil error?~~ **Answered in §6**: no — it is `anvil_correct`, and it
   counts against the manual process instead. The remaining sub-question is
   whether a tenant should be able to see `process_deviation_rate` at all, or
   only their own Anvil score. Showing it is more useful and more honest; it is
   also a number about their staff, so it is their call who sees it.
3. Mode at tenant level, or per customer? A tenant may trust Anvil for one
   buyer's simple POs and not another's.
4. How long is a fair trial — a fixed window, or a line count?
5. Does a Mode B tenant still get the SO acknowledgment PDF? It is Anvil's
   proposal, not the ledger's record, and saying which is which matters.
