# Freight assumption engine — scope

**Written** 2026-08-20 against `main`. Everything asserted here was verified by
opening the file named; three readers inventoried the signals and every claim
was independently re-checked. Where a number could not be measured offline it
says so.

The brief:

> I don't want to stockpile more docs, instead I want to create an ML/AI flow
> for an accurate assumption engine that's able to plan freight forwarder
> selection for Anvil's customer base.

---

## 0. The short answer

**The inference half is mostly buildable now and needs no model. The selection
half is blocked on something duller than a model — carriers are not entities.**

Two corrections to the record before anything else, because both change the
plan:

- **A mass estimator already exists and is wired to a screen.**
  `src/api/_lib/pdm/raw-material-infer.js` computes mass from material density
  × dimensions, with a real grade table (CuCrZr 8900, EN8/EN19 7850, SS304
  8000, AL6061 2700 kg/m³) and alias matching for Indian drawing nomenclature.
  It is routed at `/pdm/raw-material` and drives `screens/pdm-material.tsx`.
  It writes to `composition_material_lines.gross_qty` and **never** to
  `item_master.weight_kg`. Migration 216 reserves `weight_source='derived'` for
  "material × dimensions from a part drawing, *once that extraction is built*"
  — the extraction is built. That comment was written today and was wrong.
- **Carrier identity does not exist.** `freight_bids.carrier` is free text with
  no foreign key, and `logistics_carriers` (migration 009, ten seeded rows) is
  read by no API, screen or lookup anywhere in `src`. "Maersk", "MAERSK LINE"
  and "maersk " are three carriers. **No forwarder track record can accumulate
  until this changes**, and no amount of modelling substitutes for it.

---

## 1. What this actually is

Not "an ML flow". Four specific predictions, serving one decision:

| prediction | serves |
|---|---|
| per-unit **weight** of a part | container fill, and the freight allocator's basis (#481) |
| per-unit **volume** of a part | the *other* half of container fill — LCL is priced on weight-or-measure |
| **transit time** on a lane | promise-vs-reality, and whether a forwarder is worth its premium |
| **cost** on a lane | whether an awarded bid is good, and what to expect before bidding |

Consumed by: the freight allocator, the consolidation planner, and — once
carriers are real — a ranked forwarder recommendation at award time.

---

## 2. The cold-start truth

Stated plainly because this codebase has twice built columns nothing writes.

- `item_master.weight_kg` / `volume_cbm`: **0 of 1,000** live items. Two
  document sources now exist (#482 quotes, #483 packing lists) and neither has
  run against real volume yet.
- `freight_bids`: needs counting (see §7). If awarded bids are in single
  digits, **there is no supervised model** and anything shipped this quarter is
  priors and heuristics wearing a confidence score. That is fine — say so
  rather than calling it ML.
- **Nothing measures a promise against reality.** `shipment_eta_observations`
  (migration 212) logs ETA *revisions*; both sides of every comparison are
  promises. No code compares a promised ETA to actual arrival. The most
  valuable label for a reliability model has never been computed.
- One live tenant, so there is **no network** to learn across yet.

---

## 3. The layered engine

Copy the idiom already in the codebase. `inventory/lead-time.js` grades itself:

```
'data_driven'         N >= 12   trust the empirical fit
'priored'             4 <= N < 12  widen toward a conservative prior
'item_master_default' N < 4     fall back, sigma heuristic
```

Every prediction below returns a **value, a confidence tier, and the reason** —
the same contract `freight-allocate.js` `chooseBasis` uses. Tiers degrade
automatically and promote themselves as data arrives.

### Weight

| tier | source | promotes when |
|---|---|---|
| `measured` | a packing list or quote line stated it (#482 / #483) | — |
| `derived` | **`raw-material-infer.js`**: density × dimensions from a part drawing | a drawing is extracted |
| `cohort` | a sibling's known weight, scaled | any sibling reaches `measured` |
| `prior` | HSN chapter density × a size proxy | — |
| `none` | allocator falls back to value (#481 already does this) | — |

**Four cohort structures exist, all verified:**

1. **Spare matrix** (`spare_matrix_columns`, migration 159) — a column *is* the
   set of parts doing the same job across different guns. The strongest cohort
   in the product: if one shank's weight is known, the column's other shanks
   are within a factor.
2. **`bill_of_materials`** (migration 003) — parent ≈ Σ(child × qty). A
   *conservation constraint*, not a correlation: it can both impute a missing
   child and **validate** a measured one.
3. **`hsn_codes.chapter`** (migration 105, ~62 rows seeded) — chapter 73
   (iron/steel) vs 76 (aluminium) vs 39 (plastic) is a coarse density prior
   *already populated for tax reasons*. Free labels.
4. **`item_embeddings`** (migration 125, 1536-dim, HNSW) — description-space
   nearest neighbour, i.e. a ready-made "which known part is this most like".

**Caveats on the derived tier, both real.** `inferStock` adds a 3 mm machining
allowance to every envelope dimension, so it yields *stock* mass — an upper
bound on the finished part, legitimately `derived` but never to be labelled
`measured`. And it only fires for `procurement_type='make'`, which
`classifyMakeBuy` defaults to **buy** when uncertain — so for an importer of
bought-out components this covers the machined minority, not the master.

### Volume

Same tiers, weaker sources. Only #483 supplies a measured value. `raw-material-infer`
computes volume en route to mass and discards it — a second cheap bridge.

### Transit time

`inventory/lead-time.js` already fits a per-supplier distribution and grades
itself. The freight analogue needs an **actual arrival**, which nothing
currently records against a promise. Until that exists this tier is `prior`
only, and saying otherwise would be inventing a measurement.

### Lane cost

`freight_bids.total_cost` is the only real awarded number in the product.
`freight_rates` is configured constants read by nothing. Count the bids before
promising a median.

---

## 4. Where an inference may be written — and where it must not

**Not into `item_master.weight_kg`.** That column now means "a document said
so" (`weight_source` ∈ manual | document | derived). Writing a cohort guess
there, where a packing-list value would go, is exactly the quiet corruption
this codebase keeps producing — and it is unrecoverable, because nothing
records that the number was invented.

`weight_source='derived'` is the one exception migration 216 already sanctions,
and only for the physics estimator, which is a computation from measured inputs
rather than a guess.

**Proposal:** a separate `item_attribute_estimates` table — part, attribute,
value, tier, method, inputs, computed_at — that the allocator reads *after*
`item_master`. A consumer can then always tell an observation from an
inference, and an estimate can be recomputed or discarded without touching the
master.

---

## 5. Forwarder selection

**The first PR is not a model. It is making a carrier an entity.**

Today `freight_bids.carrier` is free text; `logistics_carriers` is read by
nothing. Until a bid points at a carrier row, there is no key to attach a track
record to, and every downstream idea here is unbuildable.

Ranking inputs, honestly split:

| input | state |
|---|---|
| awarded cost per lane | exists (`freight_bids`), volume unknown |
| supplier on-time rate | exists (`on_time_delivery_rate_90d`, migration 085) — but that is per **supplier**, not per carrier |
| customer OTD | exists (`_lib/logistics/otd.js`) — per **customer**, not per carrier |
| carrier on-time | **does not exist** |
| transit variance | **does not exist** — no actual-vs-promised anywhere |
| claims / damage | **does not exist** |
| RFQ responsiveness | derivable from `freight_bids` timestamps once carriers are real |

So: two of the seven exist and neither is about a carrier.

---

## 6. The cross-tenant part

`src/api/sourcing/network/search.js` is the precedent — a cross-tenant search
with anonymised peer matches. A lane-price benchmark is the same shape: "this
lane, this month, N tenants, median and spread", never naming a tenant or an
amount attributable to one.

With one live tenant there is no network. Build the aggregation so it is
*possible*, do not ship a benchmark computed from one participant, and set a
floor (no benchmark below N tenants) so the first one is not a single tenant's
own number reflected back at them.

---

## 7. Ordered PRs

| # | what | model? | outcome that proves it |
|---|---|---|---|
| 0 | **Count what exists.** `freight_bids`, awarded, distinct carriers, shipments delivered | no | a number that decides 1–6 |
| 1 | **Carriers become entities** — FK from `freight_bids.carrier`, backfill by fuzzy match with human confirm, surface `logistics_carriers` | no | distinct carriers drops to the real count |
| 2 | **Bridge the estimator** — `raw-material-infer` mass → `item_attribute_estimates` at tier `derived` | no | non-zero derived weights on machined parts |
| 3 | **`item_attribute_estimates` + allocator reads it** after `item_master` | no | #481 basis moves off `value` for some lanes |
| 4 | **Actual arrival vs promise** — record the arrival, compute the delta | no | transit variance exists for the first time |
| 5 | **Cohort imputation** — spare-matrix column and BOM conservation | statistical, not ML | weight coverage rises without new documents |
| 6 | **Forwarder ranking** on cost + transit variance + responsiveness | maybe | a recommendation an operator can disagree with |
| 7 | **Cross-tenant lane benchmark**, floored at N tenants | no | — |

PR 0 is a query. PRs 1–5 involve **no model at all**. If that reads as a
let-down, the honest version is that the accuracy this brief asks for comes
from making four existing things talk to each other, and only then from
learning.

---

## 8. How this goes wrong

- **The estimate becomes indistinguishable from a measurement.** Guard: tier
  and method are non-null on every estimate row; the allocator reports which
  tier it used, as `chooseBasis` already does.
- **A cohort imputes from an imputation.** Guard: only `measured` and `derived`
  rows may seed a cohort; estimates never chain.
- **The stock-mass allowance is read as finished mass.** Guard: `derived` rows
  carry the allowance in `inputs`, and BOM conservation flags a parent lighter
  than its children.
- **A model is trained on promises.** Guard: PR 4 before PR 6, always.
- **A benchmark of one tenant.** Guard: the N floor, enforced server-side.
- **A column nothing writes.** This has happened twice — `weight_kg`
  (migration 145) and the approvals margin field. Guard: no PR here adds a
  column without the writer in the same PR.
