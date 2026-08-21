# Trajectory-compression → fine-tuning pipeline for extraction

Status: design (branch `docs/extraction-finetuning-design`).
Implements `IMPROVEMENT_PLAN.md` §7.5 (per-customer fine-tuned extraction models —
"router shipped, out-of-process worker pending"). Inspired by Nous Research's
Hermes Agent, whose learning loop compresses agent *trajectories* into training
data for the next model — applied here to PO extraction.

## Why

Anvil's extraction already self-learns **in-context**: operator corrections →
`customer_field_overrides` rules + `docai_prompt_overrides` few-shot + consensus
`item_customer_parts` aliases + correction-aware adapter ranking (#265), all
injected via `customer-hints`. That is a real loop, but it has a ceiling: it
teaches the *prompt*, not the *weights*. For a high-volume customer with a
stable, quirky PO layout and persistent correction patterns the prompt can't
fully capture, **weight-level learning** (a small per-customer / per-cohort
fine-tune) is the next lever.

The durable asset is not the fine-tuned model — models churn. It is the
**labeled trajectory dataset**, which Anvil already produces as a side-effect of
every extraction + operator review. This design turns that exhaust into a
versioned training corpus, then makes the actual fine-tuning step a pluggable,
out-of-process backend. Build the dataset first; it is valuable standalone (eval,
analytics, prompt-optimization) even before any model is trained.

## What a "trajectory" is here

One extraction event is a complete labeled trajectory:

```
input      : the PO document (extraction_runs.source_* + its text/OCR layer)
model_out  : extraction_runs.normalized_extract + field_confidences + adapter/model
corrections: extraction_corrections (per-field original -> corrected deltas)
gold       : the FINAL, human-APPROVED order (orders.result.salesOrder)
```

The supervised example is **(input → gold)**; the corrections are the "why" and a
difficulty/quality signal (a trajectory with many corrections is a *hard* example
worth keeping; one with none is an easy example worth compressing away).

## Data sources — all already exist

| Source | Contributes |
|---|---|
| `extraction_runs` | input refs (`source_type/id/url/filename`), `normalized_extract`, `field_confidences`, `adapter_used`, `selected_model`, `status`, `customer_id`, `doc_fingerprint` |
| `extraction_corrections` (+ `learned_corrections`, #256) | per-field operator deltas — the label signal + difficulty |
| `orders` (APPROVED / EXPORTED_TO_TALLY / RECONCILED) | the human-verified **gold** output |
| documents / storage | the raw source bytes + text/OCR layer for the input |
| `layout-fingerprint.js` | cluster key for compression |
| `/api/rlhf/dataset.js` | sibling **preference-pair** export (RLHF/DPO); this design adds the **SFT** export |

## Pipeline

### A. Trajectory assembly
For each `extraction_runs` row (`status='ok'`) join to the order it produced
(`orders.preflight_payload.extraction_run_id`), **require the order reached a
human-verified terminal state** (APPROVED / EXPORTED_TO_TALLY / RECONCILED), take
`orders.result.salesOrder` as gold, and attach that run's corrections. Emit a
candidate example `{ input_text, gold_json, corrections, meta }`.

### B. Compression + quality filtering ("trajectory compression")
The Hermes move — distill many trajectories into the *informative* ones:
- **Human-verified only.** Drop runs whose order never got sign-off. No
  self-labeling.
- **Dedup** by `doc_fingerprint` / `payload_hash` — never train on the same PO N×.
- **Layout clustering** (`layout-fingerprint.js`): per cluster keep a small
  representative sample **plus every HARD example** (runs that required
  corrections). This is the compression: near-identical easy trajectories collapse
  to a few; corrected edge cases are all kept.
- **Contamination guard.** Flag/exclude runs that were themselves few-shot-primed
  by `customer-hints`/overrides, so the model doesn't learn from its own primed
  output (distribution collapse). Prefer gold that came from *human* corrections.
- **PII redaction** on the training text (reuse `redactMessages`) — the corpus
  will leave Anvil to a trainer.
- **Balance + cap** per customer and per layout to avoid overfitting one format.
- **Split**: hold out a per-customer eval set that is *never* trained on — it is
  the promotion gate (Stage E).

### C. Dataset store + JSONL export
New tenant-scoped tables (RLS, per the modern pattern):
- `finetune_examples` — one row per compressed example: `input_ref`, `gold_json`,
  `layout_cluster`, `split (train|eval)`, `source_run_id`, `verified_at`,
  `redacted`, `contaminated`.
- `finetune_datasets` — a versioned snapshot: `tenant_id`, `customer_id | null`
  (cohort), `version`, `n_train`, `n_eval`, `built_at`, `jsonl_url`.

Export as SFT JSONL the way TRL / Axolotl / provider fine-tune APIs consume:
```
{ "messages": [ {role: system, content: SYSTEM_PROMPT},
                 {role: user,   content: "DOCUMENT:\n<text>"},
                 {role: assistant, tool_calls: [{name: extract_purchase_order,
                                                 arguments: <gold_json>}]} ] }
```
(Same shared `SYSTEM_PROMPT` + `TOOL_DEFINITION` contract the adapters use, so the
fine-tune is trained on the exact schema the pipeline expects.)

### D. Fine-tuning worker (OUT-OF-PROCESS, provider-agnostic)
Vercel serverless cannot train (no GPU, no long jobs), so the worker is external.
Anvil side is only orchestration:
- `finetune_runs` table + `/api/docai/finetune` (admin, per-tenant) that snapshots
  a dataset version and **hands it to an external backend** (webhook/queue), then
  records status. GPU work happens off-platform.
- Pluggable backends (pick per cost/control):
  1. **Provider fine-tune API** (OpenAI / Together / Fireworks) — submit JSONL,
     poll, get a `model_id`. Cheapest to operate.
  2. **LoRA on an open VLM/LLM** (Qwen2-VL / Llama-3.1-8B) via Modal or EC2 +
     TRL/Axolotl — §7.5's stated path; most control, heaviest.
  3. **OpenRouter-hosted fine-tune** — serve through the OpenRouter adapter
     (#263/#267) once trained.
- **Trigger**: a (tenant, customer|cohort) accumulates ≥ N *new verified* examples
  since the last train (§7.5's "large N"), and prompt-override effectiveness has
  plateaued.

### E. Eval gate (promotion) — reuse the §7.6 correction-as-ground-truth pattern
Run the fine-tuned candidate **and** the current base on the held-out eval set;
score = **field-level accuracy vs verified gold** + predicted correction rate
(the metric operators feel). Record in `finetune_eval_runs`. **Promote the
fine-tune to `active` only if it beats base by a margin on that customer's eval
set.** This is the guard against a bad fine-tune silently degrading a customer.

### F. Model registry + routing
New `finetuned_models` (tenant, customer|cohort, base_model, provider, model_id,
version, eval_score, `status: shadow | active | retired`). `/api/docai/route`
(§7.5) / the model selector picks the **active** fine-tune for a (tenant,
customer) when one exists and wins eval; else falls back to the prompt-overrides
path (small N) → base model. Serve via the OpenRouter adapter (#263/#267) or the
provider endpoint. **Shadow first**: run the candidate in parallel with the served
model, log the delta, don't serve until it wins.

### G. Continuous loop + collapse guards
Corrections on the fine-tune's own output feed the *next* dataset version.
Guards, because closed-loop training on your own outputs is how models collapse:
- **Never SFT on the model's uncorrected output** — only human-verified gold +
  corrections. (Corrections are the only trusted new signal.)
- **Monitor eval score across versions**; auto-retire a fine-tune whose successor
  regresses (rollback to the last winner).
- **Cap retrain frequency** + require a minimum of new hard examples per round.

## Schema (new)
`finetune_examples`, `finetune_datasets`, `finetune_runs`, `finetune_eval_runs`,
`finetuned_models` — all tenant-scoped + RLS. No change to existing extraction
tables; the pipeline reads them.

## Safety / compliance
- **Data egress**: the training corpus leaves Anvil to a fine-tuning provider — a
  new subprocessor, the same data-egress / vendor-security gate as OpenRouter
  (`OPENROUTER_FAILOVER_NOTES.md`). PII redaction on the JSONL is mandatory;
  per-tenant opt-in; clear the compliance gate before exporting any real tenant
  data.
- **Dark + shadow-first + versioned + rollback** throughout. A fine-tune can only
  reach production traffic after winning its customer's held-out eval.

## When it's worth it (economics)
Per §7.5: in-context (prompt overrides + few-shot) covers **small N** cheaply and
should stay the default. Fine-tuning pays off at **large N** — a high-volume
customer with a stable, idiosyncratic layout and persistent patterns the prompt
can't encode. Target the top-volume customers; do **not** fine-tune everyone. The
plateau of prompt-override effectiveness (measured via the Stage-E eval) is the
trigger.

## Phasing (incremental, low-risk first)
- **P0 — Dataset builder (the asset).** Stages A+B+C: assemble → compress → store
  → export the SFT corpus from existing tables + new `finetune_examples/_datasets`
  tables. Read-only over existing data; **valuable standalone** (eval baseline,
  analytics, better few-shot selection) even before any training. Dark. *First PR.*
- **P1 — Extraction eval harness.** Stage E's scorer standalone: measure current
  base-model field accuracy per customer on the held-out set — turns "how good are
  we" into a number, and doubles as the pilot metric for #262/#265.
- **P2 — Fine-tuning worker (shadow).** Stage D + one provider backend, shadow
  mode, no serving.
- **P3 — Promotion + routing.** Stage F, eval-gated, per-tenant opt-in.
- **P4 — Continuous + collapse guards.** Stage G.

## Relationship to shipped work
- **#256** — makes corrections actually captured (`learned_corrections`); the label
  source for this whole pipeline.
- **#262** grounding — complementary: deterministic verification vs learned
  extraction; both raise accuracy.
- **#263/#267** OpenRouter — serves fine-tuned / open models.
- **#264** MCP — orthogonal (agent surface).
- **#265** correction-aware adapter selection — same correction signal; the
  Stage-E eval reuses it.
- **§7.6** eval pattern (replay historical runs, score vs corrections) — reused as
  the promotion gate.

## Realism
Vercel can't train, so the worker is out-of-process by necessity; fine-tuning is
operationally heavy (worker infra, GPU cost, eval, compliance). The **dataset is
the durable asset** — P0 is worth doing on its own and de-risks everything after
it. Weight-level learning is the ceiling-lift over in-context, but it is a
top-of-funnel, high-volume-customer play, not a default.
