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

Computes `failed_rate_window` and `sap_repair_rate_window`, with a comment
calling `failed` *"the signal Bet 4 is trying to drive to 0."* No screen or
component consumes it. Computed on every call and thrown away.

### `_lib/metrics/catalog.js` — the governed metric layer

22 metrics with provenance sentences — the only trustworthy analytics surface
in the app. **Zero extraction metrics.** No accuracy, no defect rate, no parse
failure. Everything the copilot can reason about excludes extraction quality.

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
| `quote` | yes | yes | no | 0 |
| `invoice` | yes *(new)* | yes | no | 0 |
| `packing_list` | yes *(new)* | yes | no | 0 |
| `eway_bill` | yes *(new)* | — | no | 0 |
| `supplier_ack` | yes | — | no | 0 |
| `assembly_bom` | yes | yes | no | 0 |
| `part_drawing` | yes | — | no | 0 |

**Every guarantee that matters is PO-only.** The correction loop — the thing
that actually improves extraction — can only be fed from `so-workspace.tsx`.
Upload a quotation whose price is misread and there is nowhere to say so.

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
| 1 | **Record `prompt_version` on every run** — call `resolvePromptVersion`, fix the mis-named integration point, write the column | *"which prompt produced this?"* | nothing |
| 2 | **Extraction metrics in the governed catalog** — accuracy, defect rate, parse-failure, by kind and by prompt version | *"is it getting better?"* | 1 |
| 3 | **Wire the replay scorer** — client method, screen action, and act on `regression` | **"did that prompt change help?"** | 1 |
| 4 | Golden fixtures for the non-PO kinds, harvested the same self-populating way | *"does the gate protect quotes too?"* | nothing |
| 5 | Correction UI on the quote review surface | feeds the override loop beyond POs | nothing |
| 6 | Turn on the traffic split, canary one prompt | *"can we improve without a deploy?"* | 1, 2, 3 |

**PR 3 is the one the brief is actually asking for.** PR 1 is its precondition
and is a day's work on code that already exists.

---

## 8. How this goes wrong

- **A quality number nobody can act on.** The DPMO alarm already lands in an
  admin bell with no drill-down to the runs behind it. Guard: every metric
  links to the `extraction_runs` rows it aggregates.
- **The golden set drifts to what we already pass.** It harvests from APPROVED
  orders, so it fills with documents the pipeline handled well. Guard: harvest
  corrected runs too, deliberately.
- **A/B on a corpus of three.** A traffic split judged against three PO
  fixtures will report noise as signal. Guard: PR 4 before PR 6.
- **Prompt version recorded and never read.** Exactly what happened to
  migration 124 for a year. Guard: PR 1 and PR 2 ship together or not at all.
- **The correction loop is one screen wide** and, being permissioned `approve`,
  is fed only by people who approve orders. Widening the UI without widening
  the permission moves the bottleneck rather than removing it.
