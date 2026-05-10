# Strategic Bet 04: Schema-aligned parsing migration

> Source: research synthesis 2026-05-10. Companion to
> `docs/STRATEGIC_PLAN_2026_05.md` Bet 4.
> Status: research complete, ready for implementation.

## TL;DR

Migrate every LLM-output JSON parse path from "ad-hoc + regex" or
"function calling" to **native structured outputs as primary** plus
a **schema-aligned-parsing repair pass** (BAML-style) as the safety
net. Keep schemas in **Zod** as the single source of truth.

Drop the `parse_failed` rate from the current ~2% (per
`extraction_runs.status_reason`) to **<0.1%**.

Effort: ~7-8 engineering days, 3 PRs, plus 14-day staging soak gate
before production rollout. Migration `097`.

---

## 1. Research summary

### 1.1 Anvil's current parse-error surface

Two clear hot paths:

- `parseStructuredGemini()` in `src/api/_lib/gemini.js:181-186`:
  single `JSON.parse` over candidate text.
- `findToolUse()` in `src/api/_lib/docai/claude.js:304-308`: reads a
  structured `tool_use` block; fails when the model returns text
  instead of calling the tool.

Migration `088_extraction_runs_status_reason.sql` already encodes
`parse_failed` and `model_refused` as enum values, so the audit
trail exists.

The bet's premise of "rank 5 (prompt + regex) in many places" is
**overstated for the docai pipeline**: both extraction adapters are
already at rank 2 (native structured) or rank 3 (function calling).
The real rank-5 risk lives in `dunning-drafter.js` and
`email-classifier.js`, which use Anthropic `tool_use` (rank 3)
without schema-aligned recovery.

### 1.2 The candidate technologies

**BAML Schema-Aligned Parsing**:
- Rust core with TypeScript bindings via `@boundaryml/baml`,
  Apache-2.0, latest 0.222.0 (April 2026).
- SAP corrects: trailing commas, unquoted strings, missing brackets,
  markdown-wrapped JSON, "yapping" prose prefix/suffix, type
  mismatches (string for array), misnamed keys, partial streaming
  objects. <10ms in Rust.
- Berkeley Function Calling Leaderboard:
  - GPT-4o function-calling 87.4% -> SAP 93%
  - Claude 3.5 Sonnet 78.1% -> SAP 94.4%
  - GPT-4o-mini 19.8% -> SAP 92.4%
- Workflow: `.baml` schema files -> `baml-cli generate
  --target typescript` -> typed client in `baml_client/`.

**Anthropic Structured Outputs**: GA after the Nov 14 2025 beta
(header `structured-outputs-2025-11-13`, now stable on Sonnet 4.5+ /
Opus 4.1+). Compiled grammar -> parse failure structurally
impossible.

**Gemini `responseSchema`**: mature since Nov 2025. Now accepts
`additionalProperties` and richer JSON Schema.

**Vercel AI SDK + Zod `generateObject`**: TypeScript de-facto
standard. Runs natively on Vercel.

**Instructor (Python-first)**: TS port exists but is small relative
to Vercel AI SDK.

**Outlines / XGrammar**: server-side decoding (vLLM / SGLang) -
irrelevant for hosted Anthropic + Gemini.

### 1.3 Vendor comparison matrix

| Tool | TS support | License | Hosted vs self-host | Streaming | Vercel-fit |
|---|---|---|---|---|---|
| BAML SAP | Production (NAPI native binary per platform) | Apache-2.0 | Both. Studio is hosted; parser is local | Yes | Marginal - native `.node` binary risks 50MB lambda zip limit |
| Anthropic Structured Outputs | Plain `fetch` | Vendor SaaS | Hosted | Yes | Native fit |
| Gemini `responseSchema` | Plain `fetch` | Vendor SaaS | Hosted | Yes | Native fit |
| Vercel AI SDK + Zod | First-class | Apache-2.0 | Local | `streamObject` | Native fit |
| Instructor TS | Newer port | MIT | Local | Partial | OK |
| Outlines / XGrammar | Server-side only | Apache-2.0 | Self-host vLLM | Server | Wrong category |

---

## 2. Recommended approach

**Layered: native structured outputs as primary + a SAP-style local
repair pass as safety net + Zod (no codegen) as schema source of
truth.** Reject pure BAML for now.

Why not BAML codegen:
- imposes `.baml` files plus a build step,
- generated `baml_client/` becomes the new schema authority,
- NAPI native binary is a real Vercel cold-start risk
  (`@boundaryml/baml-linux-x64-gnu` ~30-60MB pre-zip),
- Anvil's docai adapters are 8 files of vanilla JS with zero runtime
  deps; pulling in a Rust-native build step undoes that simplicity.

Adopt instead - "BAML-lite":

1. **Anthropic `output_config.format`** (post-beta name) for
   `claude.js`. Drop `tool_use` for the extraction adapter (keep it
   for `dunning-drafter.js` and `email-classifier.js` where it's
   already working).
2. **Gemini `responseSchema`** (already in place) plus a thin SAP-
   style repair pass.
3. **Shared `parseSchemaAligned(text, zodSchema)` helper** in
   `src/api/_lib/docai/parse.js`:
   - try native `JSON.parse`,
   - on failure, strip ```` ```json fences ````, trim chain-of-
     thought prefix to first `{`, remove trailing commas, fix
     unquoted keys, retry,
   - validate with Zod, returning
     `{ ok, value, repairs: ['fences','trailing_comma'], errors }`,
   - on Zod failure, single retry to the model with the validation
     error injected.

Coexistence: keep the existing tool_use path on `claude.js` behind a
feature flag (`docai_use_structured_outputs`). The voter
(`voter.js`) doesn't need to know - both paths deliver the same
`{ ok, normalized, ... }` envelope.

---

## 3. Data model + migrations

**Migration `097_extraction_runs_parse_method.sql`** (idempotent;
re-number if Bet 1/2/3 land first):

```sql
alter table extraction_runs
  add column if not exists parse_method text
    check (parse_method is null or parse_method in (
      'native_structured',  -- Anthropic output_config / Gemini responseSchema
      'tool_use',            -- legacy Anthropic tool_use
      'sap_repaired',        -- raw text + repair pass succeeded
      'sap_zod_retry',       -- repair failed once, retry succeeded
      'failed'
    )),
  add column if not exists parse_retries smallint not null default 0,
  add column if not exists parse_repairs text[];

create index if not exists extraction_runs_parse_method_idx
  on extraction_runs (tenant_id, parse_method, finished_at desc)
  where parse_method is not null;
```

`parse_repairs` is a string array enumerating each repair the SAP
pass applied (`['trailing_comma','fences','prose_prefix']`) so the
diagnostics tab can show which classes of error happen most.
`parse_retries` increments per round-trip the pipeline made.

---

## 4. User-visible UX

Diagnostics tab (`src/v3-app/screens/so-workspace.tsx:1325` already
renders status-reason copy for `parse_failed`):

- 30-day trend sparkline next to the existing extraction reason
  chips, sourced from `extraction_runs(parse_method, finished_at)`.
  Lines: `native_structured` (target rising to 100%),
  `sap_repaired` (small, healthy), `failed` (target <0.1%).
- Per-tenant "common repairs" badge: *"trailing_comma 14, fences 9,
  prose_prefix 3 in last 24h"*. Operators don't act on it; the
  engineering team uses it to harden prompts.

Operator-facing intake (`so-intake.tsx:494`): nothing changes. The
existing `parse_failed` chip stays; users see fewer of them.

---

## 5. Technical implementation plan

### Phase 1 - Shared parser (1 PR)

1. New `src/api/_lib/docai/parse.js` exporting
   `parseSchemaAligned(text, validator, opts)`. Validator is a
   function `(value) => { ok, errors }` so we don't lock to Zod
   (caller can pass existing JSON-Schema validators). Returns
   `{ ok, value, repairs[], retries }`.
2. New `src/api/_lib/docai/parse.test.js` (vitest). Tests: bare
   JSON, fences, trailing comma, prose prefix ("Sure, here's the
   JSON: {...}"), prose suffix, mixed comma+fence, nested escape,
   truncated mid-array (returns `ok:false, repairs:['truncated']`).
3. Wire `voter.js` and `run.js` to read `result.parse_method` /
   `result.parse_repairs` / `result.parse_retries` and persist on
   `extraction_runs`.

### Phase 2 - Migrate `claude.js` and `gemini.js` (1 PR each)

4. `claude.js`: add `output_config: { format: { type: "json_schema", schema: TOOL_DEFINITION.input_schema } }` via a new `useStructuredOutputs` flag in `callAnthropic`. When the flag is on, drop the `tools`/`tool_choice` block and read `result.data.content[0].output` instead of `findToolUse`. Defensive `parseSchemaAligned` if the model returned text instead of structured. Keep tool_use as fallback behind tenant flag `docai_use_structured_outputs` (defaults to true after staging soak).
5. `gemini.js`: `parseStructuredGemini` already calls `JSON.parse`; replace with `parseSchemaAligned(extractTextFromGemini(data), validatePoSchema)`. Surface `repairs` on adapter return.
6. Update `src/api/_lib/anthropic.js` to plumb `output_config` through `callAnthropic`. Extend with `output_config` and the `anthropic-version` / `anthropic-beta` header transitional shim.

### Phase 3 - LLM-adjacent paths (1 PR)

7. `dunning-drafter.js` and `email-classifier.js`: keep `tool_use`
   (works, low risk, low volume) but route the tool's `input`
   through `parseSchemaAligned` against a Zod schema before
   persisting. Buys "field-name typo" recovery.
8. `source_pos/ack_extract.js`: routes through
   `runExtractionPipeline`, inherits Phase 2 changes for free.
9. `gaeb.js`: deterministic XML, no LLM, no change.
10. `edi/`: deterministic, no change.

### Test strategy

- **Unit**: `parse.test.js` covers every documented SAP repair;
  hand-author 30 known-bad fixtures from production parse_failed
  runs.
- **Integration**: extend `src/v3-app/api-docai-gemini.test.js` and
  the claude analogue. Assert
  `parse_method='native_structured'` happy path, `'sap_repaired'`
  when we mock a fenced response, `'failed'` when the model truly
  hallucinates.
- **Backfill audit**: new `scripts/audit-parse-method.mjs` querying
  `extraction_runs` and asserting `parse_method` populated for all
  rows in the last 7 days. Add to `audit:systemic` chain.
- **Soak**: ship Phase 1+2 to staging, run for 14 days, watch
  `parse_method='failed'` count - target <0.1% before flipping
  `docai_use_structured_outputs` to default-on in production.

---

## 6. Risks and open questions

- **Vercel cold-start**. If we ever revisit BAML proper, the NAPI
  native binary inflates the lambda zip and can break Vercel's 50MB
  compressed / 250MB unzipped limit. Recommended path avoids this.
- **Gemini schema complexity ceiling**. Gemini's `responseSchema`
  rejects deeply nested optional self-references and
  `additionalProperties` only landed Nov 2025. Anvil's `PO_SCHEMA`
  and `SUPPLIER_ACK_SCHEMA` are flat - safe. Add a deploy-time
  audit script that runs each schema through Gemini's validator.
- **Streaming**. Anvil does not stream extraction results today
  (`callAnthropic` / `callGemini` both buffer the full response).
  No regression risk.
- **Vendor lock-in**. Native structured outputs ties schema
  definitions to vendor JSON Schema dialects. Mitigation: keep
  canonical schema in a single Zod object (or JSON-Schema doc) and
  serialise per-vendor in the adapter. Hoist schemas to
  `src/api/_lib/docai/schemas.js` as part of Phase 2.
- **`structured-outputs-2025-11-13` beta vs stable**. Anthropic
  moved from `output_format` (beta) to `output_config.format`
  (stable). Confirm production-stable status as of 2026-05 before
  enabling without the beta header. Feature-flag protects roll-back.
- **Confidence emission**. Current schema includes a self-reported
  `confidence` field. Native structured outputs preserve this.
  `parse_method='sap_repaired'` correlates with reduced
  `confidence_overall` weight - operator should know.

---

## 7. Effort estimate

- Phase 1 (shared parser + tests + migration 097): 2 days
- Phase 2 (claude.js + gemini.js + anthropic.js plumbing + new
  schemas.js): 3 days
- Phase 3 (drafter + classifier hardening): 1 day
- Diagnostics tab additions (sparkline + repairs badge): 1 day
- Staging soak + telemetry watch: 14 days calendar, 0.5 day
  engineering touch
- **Total: ~7-8 engineering days, 3 PRs, plus a 2-week soak gate**.

---

## 8. Sources cited

- [BAML SAP technique + benchmark](https://boundaryml.com/blog/schema-aligned-parsing)
- [BAML on GitHub (Apache-2.0)](https://github.com/BoundaryML/baml)
- [BAML TypeScript install + codegen](https://docs.boundaryml.com/guide/installation-language/typescript)
- [BAML pricing (open-core, Studio paid)](https://boundaryml.com/pricing)
- [Anthropic Structured Outputs / `output_config.format`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Anthropic fine-grained tool streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming)
- [Gemini structured outputs (additionalProperties Nov 2025)](https://blog.google/innovation-and-ai/technology/developers-tools/gemini-api-structured-outputs/)
- [Vercel AI SDK + Zod `generateObject`](https://vercel.com/docs/ai-sdk)
- [Instructor multi-language](https://github.com/567-labs/instructor)
- [XGrammar / Outlines / vLLM](https://blog.mlc.ai/2026/05/04/xgrammar-2-fast-customizable-structured-generation)
- Codebase: `src/api/_lib/docai/claude.js:304-308`, `src/api/_lib/docai/gemini.js:309-322`, `src/api/_lib/gemini.js:181-186`, `src/api/_lib/docai/voter.js`, `src/api/_lib/docai/run.js`, `supabase/migrations/088_extraction_runs_status_reason.sql:33-37`, `docs/EXTRACTION_PIPELINE_PLAN.md:34`.
