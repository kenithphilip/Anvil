# Grounding extraction in Anvil's own data

Status: Phase 1 building (branch `feat/extraction-grounding-gstin`).

## Problem

DocAI extraction produces a customer + line items + confidences from the PO
pixels. Anvil already owns authoritative data about the same entities —
`customers` (with validated GSTINs), `item_master`, `item_customer_parts`
aliases, `learned_corrections`, prior `extraction_runs`. Today that data is used
in two places, but there is a gap between them:

- **Pre-extraction (in the prompt):** `customer-hints.js` injects the customer
  record, `customer_field_overrides`, decay-weighted `learned_corrections`, and
  a *sample* of `item_customer_parts`.
- **Post-extraction (operator-facing):** the reconciliation screen resolves line
  items to `item_master` (item-mapper + fuzzy/hybrid/cross-encoder) and lets the
  operator fix the customer.

What is missing is a **deterministic verify-and-correct stage between the two**:
nothing cross-checks each extracted value against Anvil's authoritative data and
rewrites per-field confidence / auto-pins high-precision matches *before* the
operator sees it. Matching happens at the recon layer, decoupled from the
extraction confidence, so the operator re-does work the data could have settled.

This is where extraction "accuracy" — as the operator feels it (fewer
corrections, higher auto-confidence, fewer review-queue trips) — actually
improves. It needs neither OpenRouter nor MCP; it is Anvil's own Postgres called
deterministically inside the pipeline.

## The grounding verifier (target)

A deterministic stage in `run.js`, right after `customer_field_overrides` are
applied and before the review-queue classifier, gated per-tenant on
`tenant_settings.grounding_verify_enabled` (dark-launch pattern, default false).
It cross-checks the normalized extract against Anvil data and returns field
patches + confidence floors/caps + flags, applied with the same conservative
"fill blanks only, never clobber operator-visible values" rule the template and
override merges already use.

### Phase 1 — customer identity from GSTIN (this PR)

The GSTIN is a high-precision key (15 chars, Mod-36 checksum, encodes the state).

- `validateGstin(extracted.gstin)` — checksum. Invalid → flag
  `gstin_invalid_checksum` + cap `customer.gstin` confidence low so it surfaces
  in review.
- Valid → `findByGstin(tenant, gstin)`:
  - **Match** → this customer is *known*. Fill blank customer fields from the
    canonical row (name, state_code, payment_terms), derive `state_code`
    deterministically from the GSTIN, and floor the confidence of corroborated
    fields. Record the matched `customer_id` on a run event so the workspace can
    one-click confirm. If the extracted name shares no significant token with the
    canonical name, flag `customer_name_gstin_mismatch` (do **not** silently
    overwrite — could be a GSTIN typo or a subsidiary).
  - **No match, valid GSTIN** → flag `gstin_valid_unknown_customer` (a new
    customer; the operator gets a clean "create customer" signal).

Conservative on purpose: it never overwrites a non-blank extracted value, so the
worst case is an unchanged extraction. Auto-setting `orders.customer_id` from the
match is **Phase 2** (touches the order object, higher blast radius).

Phase 1 records the outcome (matched customer_id + flags) on a `docai_gstin_grounding`
run event and adjusts per-field `field_confidences`. **Pilot-readiness note:** for the
flags (`gstin_invalid`, `customer_name_gstin_mismatch`, `gstin_valid_unknown_customer`)
to actually pull the doc into the review queue, they must be surfaced there — either
the review view renders per-field `field_confidences`, or (Phase 1.1) the flags are
folded into `validator_issues` / the review-queue classifier. Confirm one of those is
wired before enabling the flag for a real tenant; today the capped `customer.gstin`
confidence does not lower `confidence_overall` (which drives run status).

### Phase 2 — retrieval-augmented line-item verification

Per extracted line, run `hybrid-item-search` + `cross-encoder-rerank` over
`item_master` (scoped to the tenant, primed by `item_customer_parts` for the
matched customer). Snap deterministically when the top score is decisive; else
attach top-K candidates and lower the line's confidence so recon shows the
operator a short pick-list instead of a blank. This moves the matching Anvil
already does at recon *into* the extraction confidence loop.

### Phase 3 — auto-resolve customer_id + full catalog grounding

Promote the Phase 1 match to actually set `orders.customer_id` when confidence is
decisive and the order has none; feed the matched customer's catalog slice back
for a cheap "confirm the line matches" second pass on ambiguous lines.

## Non-goals / what this is NOT

- **Not MCP.** MCP connects *external* tools to an assistant. Anvil calling its
  own DB during its own extraction is a function call. (Anvil's existing MCP
  server, `_lib/mcp.js`, serves the operator copilot — a different axis. It could
  later expose these same verify tools to external agents, but that is not the
  accuracy lever.)
- **Not OpenRouter.** Routing/model choice is orthogonal to grounding; see
  `docs/OPENROUTER_FAILOVER_NOTES.md` (separate track).

## Risk / blast radius

- Gated dark (`grounding_verify_enabled` default false) → lands byte-identical
  until a tenant opts in; pilot on one tenant, diff correction rates before/after.
- Conservative fill-blanks-only + flag-don't-clobber → cannot corrupt a value the
  model got right.
- Pure logic (`_lib/docai/grounding.js`) is unit-tested; the only I/O is one
  indexed `customers` lookup by GSTIN (reuses the canonicalizer's `findByGstin`).
- Migration 180 adds one nullable-default flag column; no data change.
