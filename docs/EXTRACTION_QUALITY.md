# Is extraction systematic, and can we improve it?

**Assessed** 2026-08-22 against `main`. Every component below was opened.
Classified **WORKING** (called, and its output changes something), **UNWIRED**
(exists, nothing calls it or nothing acts on its output), or **ABSENT**.

Four of sixteen audit agents dropped on connection errors, so the per-surface
coverage in §4 was completed by hand rather than by the sweep. Called out
because it is the least-verified section here.

The brief:

> Wherever data extraction is involved and AI agents need to be used, Anvil
> should have infrastructure in place to make sure the agents are extracting
> data systematically, and if possible levers need to be added so it can be
> continuously improved.

---

## 1. The two-sentence answer

**Not systematic.** Ten document kinds share one pipeline, but the guarantees
fall off a cliff outside purchase orders — the golden corpus is **three
fixtures, all POs**, and the correction UI exists on **exactly one screen**.

**The levers exist, and the most important one is dead code.** The correction →
override loop is genuinely closed and genuinely running. But
`prompt-versions.js` — the A/B registry built precisely so someone could change
a prompt and measure it — is imported by nothing except its own unit test.

---

## 2. What is built and inert

Leading with the inert, because this codebase's characteristic failure is
building machinery and not connecting it — and because it changes the cost.
**Most of what the brief asks for is already written.**

### `_lib/docai/prompt-versions.js` — the A/B registry

A complete implementation: named versions, traffic weights, deterministic
tenant/customer hashing, canary status, pinning. Its own header states the
exact problem the brief describes — *"Changing it means a code commit + deploy
+ waiting to see whether accuracy moved on the next 100 runs."*

- The only importer in `src/` or `scripts/` is its own test.
- Its header at `:29` tells adapters to *"import `getPromptVersion()`"*.
  **There is no such export.** The file exports `resolvePromptVersion` and
  `listPromptVersions`. The documented integration point was never even named
  correctly — nobody has ever tried to wire it.
- Migration **124** added `extraction_runs.prompt_version` so a dashboard could
  chart accuracy per version. The three writes to `extraction_runs` in the
  pipeline — `run.js:389`, `:413`, `:1297` — **none set it**.
- The registry currently advertises `po_extractor` v1 at 70% / v2 at 30%. No
  traffic has ever been split.

### `api/eval/replay.js` — the only prompt-sensitive scorer

Re-runs extraction on the golden's **original PDF bytes** and scores the fresh
output. Cost-bounded, tested, routed at `router.js:1007`.

- **No client method.** `anvil-client.js` exposes `run`, `dashboard`,
  `listCases`, `upsertCase`, `deleteCase` — no `replay`.
- The `evals.tsx` screen never references it.
- Its cron slot is gated on `EVAL_REPLAY_ENABLED`, off by default.
- It returns a `regression: true/false` flag **to a runner that reads only
  `r.ok`**. Enabling the flag is necessary and not sufficient.

### `docai/cost_status.js` — parse-failure rollup

Computed `failed_rate_window` and `sap_repair_rate_window`, with a comment
calling `failed` *"the signal Bet 4 is trying to drive to 0."* No screen or
component consumed it — computed on every call and thrown away. **PR 2 moved
that math into `_lib/extraction-kpis.js` (`parseHealth`) and published it as
`extraction_parse_failure_rate`**, with the repair rate alongside it as the
leading indicator. `cost_status.js` still computes its own copy for its own
response shape.

### `_lib/metrics/catalog.js` — the governed metric layer

22 metrics with provenance sentences — the only trustworthy analytics surface
in the app. **Zero extraction metrics.** No accuracy, no defect rate, no parse
failure. Everything the copilot could reason about excluded extraction quality.

**Closed by PR 2**: six metrics under a new `extraction` domain — defect rate
(DPMO + sigma), failure rate, review rate, parse-failure rate, documents read,
and prompt-version lift — all sliced by document kind, all carrying the
`extraction_runs` ids they aggregate. They reach the copilot through the
existing `list_metrics` / `query_metric` tools and the frontend through the
existing `metrics.list` / `metrics.query` client methods, so nothing new had
to be built to consume them.

---

## 3. What genuinely works

**The correction → override loop, and it is the best machinery in the repo.**
`ReviewPaneContext.tsx` POSTs a correction; `correction.js` records the diff;
after **two agreeing corrections** it writes `customer_field_overrides`; and
`run.js:987` applies those on the next upload, flooring confidence at 0.95. An
operator's fix takes effect on the next document, per customer, per field.

*Caveat:* the 50-correction few-shot rebuild is counted per
`(customer_id, field_path)`, which makes it effectively unreachable. The
2-correction override is the lever that actually fires.

**Validators run on every extraction and effectively fail a run.** A GSTIN
checksum failure downgrades confidence to ≤0.69, `run.js:1272` flips that to
`low_confidence`, and `review-queue.js` turns it into a queue row a human can
reach. Deterministic routing to review.

**The golden corpus harvests itself.** Every transition to APPROVED snapshots
human-verified output into `eval_cases` with full provenance —
`extraction_run_id`, `payload_hash`, `approved_by`, `source_sha256`. Ground
truth for free, from work operators already do. Genuinely clever.

**CI blocks a regression.** `npm run eval:golden` runs on every PR and exits
non-zero below baseline.

**A DPMO alarm fires** on the daily cron when the operator-corrected defect
rate breaches ~4σ.

---

## 4. The measurement gap

> If someone changed a prompt today, what would tell them whether accuracy
> improved?

**Nothing.**

The golden gate would catch a catastrophic regression against **three PO
fixtures**. Beyond that: the run carries no prompt version, so no before/after
can be attributed; the only scorer that re-runs the model is unreachable from
the client and its regression flag is ignored; and no accuracy metric exists in
the governed catalog for anyone to chart.

The DPMO alarm is the one real signal — but it measures *operator corrections*,
which arrive days later and only from the one screen that has a correction UI.

---

## 5. The asymmetry

| kind | schema | ingest | correction UI | golden fixture |
|---|---|---|---|---|
| `po` | PO (native) | yes | **yes** | **3** |
| `rfq` | PO-shaped | — | no | 0 |
| `quote` | yes | yes | **yes** *(PR 5)* | **1** |
| `invoice` | yes *(new)* | yes | no | **1** |
| `packing_list` | yes *(new)* | yes | no | **1** |
| `eway_bill` | yes *(new)* | — | no | 0 |
| `supplier_ack` | yes | — | no | 0 |
| `assembly_bom` | yes | yes | no | 0 |
| `part_drawing` | yes | — | no | 0 |

**Every guarantee that matters was PO-only.** The correction loop — the thing
that actually improves extraction — could only be fed from `so-workspace.tsx`.
Upload a quotation whose price is misread and there was nowhere to say so.

PR 5 closed that for quotes: the Quotes tab's line cells are correctable, and
because the harvest shipped in PR 4 is kind-agnostic, a corrected quote now
becomes a `quote-extraction` golden without anyone curating one. The remaining
kinds still have no correction surface — that is the next widening, and each
one is now a mount rather than a mechanism.

Two defects surfaced while wiring it, both of the same family — *code written
against the tool schema when the stored extract is a different object*:

- `QUOTE_PROFILE.customer` read `customer_name`, a real `QUOTE_TOOL` property
  that the normalizer consumes and re-emits as `customer: { name }`. The read
  returned `undefined`, `toScorableFor` omitted the key, and `scoreCase` skips
  a key that is undefined — so **every quote golden scored the customer as a
  pass**, including one that read the seller's name instead of the buyer's.
- The committed `quote-two-price-columns` fixture carried the same flat shape,
  so the gate was not exercising what production stores.

Both fixed, with a test that grounds the correctable field map against the
normalizer's own output rather than against the schema.

Three more defects, found by an adversarial pass over the first cut and fixed
in the same PR — each one would have made the feature *look* like it worked:

- **The override half of the loop could never fire.** `correction.js` promotes
  a customer-field override only `if (customerId)`, and `customer-hints`
  refuses to prime the next extraction without one — but the quote extraction
  was called with no `customer_id`, so every quote run stored null. Corrections
  were recorded and could never change an extraction. `QuotesStrip` now passes
  the customer id (as the id, replacing a `hasCustomer` boolean that threw the
  value away one line from where it was needed).
- **A `dedupe_hit` run swallowed the harvest.** A content-hash match mints a
  *fresh* run stamped `status: "ok"` with a new `finished_at`, so it sorted
  first — and `harvest-corrected` excludes `dedupe_hit`. The operator saw
  "Correction recorded" and no golden was created. The route now skips it.
- **`original_value` was a value the model never produced.** `quote_lines` is
  not a faithful copy of the extract: the ingest writes
  `listed_unit_price: list ?? governing`, so a single-price quote stores the
  *net* price in the list column while the extract holds null, and it appends
  `" · MOQ=n"` to `remark`. The route now sends the extract's own lines and a
  cell with no extract entry stays read-only rather than guessing.

Header fields (quote number, currency, grand total) are deliberately *not*
correctable yet: the header is a chip strip rather than a table, so it is a
real interaction change rather than another cell — and shipping a tested but
unmounted field map would be the exact habit this document exists to break.

Of the surfaces the brief named: **logistics planning and manufacturing have no
extraction at all.** That is coverage, not quality, and belongs in a different
conversation.

---

## 6. The levers, ranked

| lever | state | to connect |
|---|---|---|
| correction → override | **works** | — (widen it, §7) |
| validator → review queue | **works** | — |
| self-harvesting golden corpus | **works** | — |
| CI regression gate | **works** | broaden past 3 PO fixtures |
| DPMO alarm | **works** | — |
| **prompt A/B registry** | **inert** | call `resolvePromptVersion`, write the column. ~1 day |
| **replay scorer** | **inert** | client method + act on `regression`. ~1 day |
| parse-failure rollup | inert | one panel |
| extraction metrics in the catalog | **absent** | 3–4 metrics over `extraction_runs` |
| correction UI beyond POs | **absent** | the real cost — a review surface per kind |

Five of ten work. Three are written and unplugged. **Two need building, and one
of those is most of the work.**

---

## 7. Ordered PRs

| # | what | makes what answerable | depends on |
|---|---|---|---|
| 1 | ~~**Record `prompt_version` on every run**~~ — **shipped (#487)** | *"which prompt produced this?"* | nothing |
| 2 | ~~**Extraction metrics in the governed catalog**~~ — **shipped**: six metrics, `extraction` domain, by kind and by prompt version | *"is it getting better?"* | 1 |
| 3 | ~~**Wire the replay scorer**~~ — **shipped (#487)**: client method + `eval_replay_regression` admin alert | **"did that prompt change help?"** | 1 |
| 4 | ~~Golden fixtures for the non-PO kinds, harvested the same self-populating way~~ — **shipped**: per-kind scoring profiles, three non-PO fixtures, corrected-run harvest | *"does the gate protect quotes too?"* | nothing |
| 5 | ~~Correction UI on the quote review surface~~ — **shipped**: correctable cells on the Quotes tab, run resolved through `source_document_id` | feeds the override loop beyond POs | nothing |
| 6 | Turn on the traffic split, canary one prompt | *"can we improve without a deploy?"* | 1, 2, 3 |

**PR 3 is the one the brief is actually asking for.** PR 1 is its precondition
and is a day's work on code that already exists.

---

## 7b. The two golden stores (PR 4)

They are separate on purpose, and it is worth writing down because they look
like one thing:

| | `scripts/eval/fixtures/*.json` | `eval_cases` (DB) |
|---|---|---|
| written by | hand, committed | harvested from approvals + corrections |
| content | synthetic — no customer data in the repo | real tenant documents |
| runs in | CI, on every build (`npm run eval:golden`) | the nightly rescore / replay crons |
| blocks a merge | **yes** | no |

Nothing promotes between them, and nothing should: an export from `eval_cases`
to disk would commit real part numbers and customer names into the repository.
The disk corpus stays synthetic and gates the build; the harvested corpus stays
in the tenant and gates the model.

**What PR 4 does not reach.** The corrected-run harvest is kind-agnostic, but
today the only correction UI is the SO workspace, which produces `kind='po'`
runs — so in practice it harvests POs. The non-PO suites are filled by the
three committed fixtures until **PR 5** puts correction on the other review
surfaces, at which point they self-populate with no further work. This is the
honest state: the machinery is kind-agnostic, the *inputs* are not yet.

---

## 8. How this goes wrong

- **A quality number nobody can act on.** The DPMO alarm already lands in an
  admin bell with no drill-down to the runs behind it. Guard: every metric
  links to the `extraction_runs` rows it aggregates. **Held in PR 2** — every
  extraction metric returns `evidence: { table, total_runs, run_ids[], truncated }`,
  and the ids are the ones you would open: the *failed* runs for the failure
  rate, the *waiting* runs for the review rate.
- **A comparison that looks attributable and is not.** Two guards in PR 2:
  runs predating prompt-version recording group as `unrecorded` and are never
  crowned best or worst, and no version is declared a winner on fewer than 20
  shipped runs — `extraction_prompt_version_lift` returns `null`, not a
  flattering number, when there is nothing to compare.
- **The golden set drifts to what we already pass.** It harvests from APPROVED
  orders, so it fills with documents the pipeline handled well. Guard: harvest
  corrected runs too, deliberately. **Held in PR 4** — `eval/harvest-corrected.js`
  applies an operator's corrections back onto the run's `normalized_extract`
  and snapshots the result, so a document the extractor got WRONG becomes a
  golden. It hangs off `POST /api/docai/correction`, is idempotent (correcting
  five fields refreshes one case, not five), and is kind-agnostic by
  construction — it reads `extraction_runs`, never `orders`.
- **A fixture that scores a vocabulary it does not speak.** The scorer guarded
  every check with `if (expected.X !== undefined)`, so a non-PO fixture did not
  fail — it scored the two or three fields it happened to share and passed. A
  packing list with a corrupted `weight_basis` (a 2×–50× error on every
  shipping weight) scored **1.000**. Guard: per-kind profiles in
  `eval/kind-profiles.js`; a kind with no profile is SKIPPED, never scored
  against the wrong field set.
- **A/B on a corpus of three.** A traffic split judged against three PO
  fixtures will report noise as signal. Guard: PR 4 before PR 6.
- **Prompt version recorded and never read.** Exactly what happened to
  migration 124 for a year. Guard: PR 1 and PR 2 ship together or not at all.
- **The correction loop is one screen wide** and, being permissioned `approve`,
  is fed only by people who approve orders. Widening the UI without widening
  the permission moves the bottleneck rather than removing it.
