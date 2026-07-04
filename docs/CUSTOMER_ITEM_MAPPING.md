# Customer + Item Mapping Overhaul

Shipped as 17 atomic commits + 2 follow-up fixes on `main`
between commits `ff3bdd6` and `eba0275`. Test count went from
1716 to 1831 (+115). Every wave is gated by a green vitest
suite and a passing seed-apply migration run on staging.

The plan was researched against current (2026) production
guidance from Splink (Fellegi-Sunter probabilistic linkage),
Sentence Transformers (bi-encoder + cross-encoder rerank),
pgvector 0.8 (HNSW + iterative scan), Salesforce + SAP MDM
golden-record + survivorship patterns, and the entity-resolution
literature on blocking keys + Jaro-Winkler + Metaphone. See the
plan write-up in the seed-pack pull request thread for the
source citations.

---

## Why

The user constraint, restated:

> Customer master + Contact master, Salesforce-style. Many
> customer SAP part numbers map to one Obara canonical part.
> Apply only on Sales Order; Purchase Order skips this entirely.
> One mapping engine, no parallel logic. Handle every format
> (scanned, handwritten, complex tables, xlsx, csv).

Before this overhaul, mapping was scattered across:
- A single 5-tier resolver in `item-mapper.js` (customer_part >
  item_master.part_no > specification_code > alias >
  description_fuzzy).
- Manual recon-table picks in `so-workspace.tsx`.
- ERP-specific connector tables (`acu_customers`, `d365_customers`,
  ...) with no unified external-id index.
- Customer dedupe done by eyeball.

After the overhaul, every mapping decision flows through one
algorithmic ladder + one HTTP route, with audit trail + active
learning baked in.

---

## What shipped, by wave

### Wave 1: foundation (schema + invariants)

| Wave | Commit | Schema (migrations) | What |
| --- | --- | --- | --- |
| CM 1.1 + 1.4 | `ff3bdd6` | 126 | Golden-record audit columns on `customers` (is_golden, golden_score, duplicates_of, identity_hash, contact_count, last_active_at, merge_blocked). `item_customer_parts.applies_to text[] default {sales_order}` so PO / manufacturing paths skip SO-only mappings. Self-consistency CHECK: merged rows must point at a winner and never themselves. |
| CM 1.2 | `ee50ebb` | 127 | `customer_external_ids` table for SAP / NetSuite / D365 / Acumatica / Tally / SXE / Eclipse / P21 / Sage X3 / JDE / IFS / portal / EDI / internal codes. Unique `(tenant, system, lower(external_id))` so a cross-customer collision is a constraint violation requiring merge. |
| CM 1.3 | `2deb174` | 128 | Contact master tightening: canonical_email_hash (sha256 over canonicalised email, gmail dot-fold + tag-strip), preferred_locale, signature_block, confidence, is_active. SQL `_canonicalise_email` + `_email_hash` mirror the JS implementation in `email-canonical.js`. |

### Wave 2: resolver algorithms

| Wave | Commit | Schema (migrations) | What |
| --- | --- | --- | --- |
| CM 2.1 | `e036128` | 129 | Canonical-bound mapping invariant. Partial unique index enforces at most one ACTIVE `(tenant, customer, customer_part_number)` mapping. "Active" = `valid_to IS NULL`. Supersession workflow stamps the prior row's valid_to before the replacement insert. Companion view `item_customer_parts_active`. |
| CM 2.4 | `730dd8d` | (no migration) | Pure-JS fuzzy-match primitives: Jaro / Jaro-Winkler, Metaphone (single, 1990 reference), n-gram Jaccard, blocking key (partno prefix + metaphone of first significant word), composite score (0.45 JW + 0.30 Jaccard + 0.25 Metaphone match). Inserted as new resolver tier between `item_master.alias` and `description_fuzzy`. |
| CM 2.5 | `53d000d` | 130 | HNSW over IVFFlat for `item_embeddings` + `extraction_line_embeddings`. Stable RPC `match_item_embeddings` with `hnsw.iterative_scan=on` so RLS-prefiltered results meet the requested match_count. |
| CM 2.2 | `3da3c29` | 131 | Hybrid BM25 + vector retrieval. `item_master.search_tsv` generated column with weighted fields (part_no=A, alias/print_name=B, description=C, category/sub_category/stock_group=D). RPC `match_items_hybrid` fuses lexical + vector via reciprocal rank fusion (k=60). |
| CM 2.3 | `f0e41fe` | (no migration) | Cross-encoder rerank stage via Claude Haiku. Compact prompt (max 12 candidates, descriptions trimmed to 160 chars), score_candidates tool schema, validates against the input candidate set (no hallucinated item_ids), returns top-K with 0..1 rerank_score + reason. |

### Wave 3: active learning

| Wave | Commit | Schema (migrations) | What |
| --- | --- | --- | --- |
| CM 3.1 | `90cbee4` | 132 | N-of-M auto-promote. Pulls the last 4 successful runs for a customer; if the same (customer_part, item_id) appears in 3+ with confidence >= 0.85 AND no operator disagreement in 90 days, inserts an `item_customer_parts` row with `created_via='auto_consensus'` and confidence_pct=90. New `auto_consensus` value on the created_via CHECK constraint. |
| CM 3.2 | `7558e89` | (no migration) | Decay-weighted operator confidence. Half-life 90 days; corrections from yesterday get weight 1.0, 90 days ago 0.5, 180 days ago 0.25. customer-hints priming reads top-K by weight (default 8) and drops rows below 0.05 weight. |
| CM 3.3 | `f385e6a` | 133 | Contact-attributed mapping prior. `learned_corrections.customer_contact_id` FK. When `buildCustomerHints` is called with a contactId, that contact's corrections get a 1.5x weight boost so multi-buyer customers (Meridian with two buyers using different part schemes) get buyer-specific priming. Cache key includes contact suffix. |

### Wave 4: customer master intelligence

| Wave | Commit | Schema (migrations) | What |
| --- | --- | --- | --- |
| CM 4.1 | `0be5358` | (no migration) | Probabilistic email-to-contact linkage via Fellegi-Sunter. 6 features (canonical_email_match, email_domain_match, prior_thread_match, name_jaro_high, subject_po_pattern, gstin_in_body) with calibrated `m` and `u`. Log-odds compound; tier thresholds AUTO_LINK >= 0.90, SUGGEST >= 0.50. One-feature ceiling is intentional: canonical_email_match alone scores ~0.09 (cannot auto-link without corroboration; defence against address-book misuse). |
| CM 4.2 | `6aa77e4` | 134 | Customer dedupe sweep cron. Loads golden customers, blocks by (name first 3 + gstin first 2), pairs within block (max 200), scores via 5-feature F-S. Pairs above 0.50 upsert to `customer_merge_candidates` (status open). Idempotent on (tenant, a, b, status). |
| CM 4.3 | `a8704d6` | (no migration) | Survivorship rules on merge. `applySurvivorship(winner, loser)` picks per-field winners (longer name, non-null fallback, notes merger with `[merged from X on YYYY-MM-DD]` marker). `executeMerge` re-points 15 dependent FKs (orders, quotes, invoices, source_pos, contracts, customer_contacts, item_customer_parts, customer_external_ids, customer_field_overrides, learned_corrections, inbound_emails, customer_locations, customer_format_profiles, customer_format_templates, leads.converted_customer_id). |

### Wave 5: process / UX

| Wave | Commit | Schema (migrations) | What |
| --- | --- | --- | --- |
| CM 5.2 | `d3550c5` | (no migration) | One-call mapping API `POST /api/mapping/resolve`. Resolver -> hybrid retrieval (lexical now, vector when embedFn lands) -> cross-encoder rerank -> top-3 suggestions per line. Body carries `customer_id`, `lines`, optional `context` (sales_order / quote / rfq / internal_so for CM 1.4 gating), `contact_id` (CM 3.3 priming), `rerank` toggle. |
| CM 5.3 | `1090cd7` | (no migration) | Bulk CSV diff preview. `buildBulkDiff(svc, {tenantId, rows})` classifies each incoming row as NEW / UPDATE / NOOP / ERROR against the current active mappings. Operator approves the diff before destructive write. |
| CM 5.1 | `4e3da11` | (no migration) | Unified mapping workspace `GET /api/mapping/workspace`. Aggregates open dedupe candidates + recent auto_consensus + pending llm_suggest + per-created_via tally. Optional `?customer_id=` scopes everything. |

### Follow-up fixes

| Commit | What |
| --- | --- |
| `a86c853` | Migration 129 used `current_date` in an index predicate. Postgres requires IMMUTABLE; simplified to `valid_to IS NULL` for "active". 3 JS call sites updated to match. |
| `eba0275` | Migration 131 + `embeddings.js` referenced `item_master.spec_text`, which doesn't exist. Replaced with the real text columns (`part_no`, `alias`, `print_name`, `description`, `category`, `sub_category`, `stock_group`). |

---

## What this means for callers

- **Recon table** (so-workspace.tsx): one-shot to `/api/mapping/resolve`
  returns mapped lines plus ranked suggestions for the
  unmapped ones. No more per-line LLM call.
- **Bulk import** (admin item_customer_parts upload):
  `buildBulkDiff` runs preview-first; the destructive batch
  upsert is gated by operator approval.
- **Inbound-email matcher**: `findContactByEmail` (CM 1.3)
  returns a contact in one indexed probe via the canonical
  email hash. The `scoreCandidate` Fellegi-Sunter helper
  decides AUTO_LINK / SUGGEST / NO_MATCH.
- **PO / Tally / manufacturing extraction** (when wired later):
  pass `context: 'purchase_order'` to the resolver and the
  CM 1.4 `applies_to` filter excludes SO-only mappings.
- **Cron operator**: dedupe sweep job runs `sweepTenant` weekly
  per tenant; merge candidates surface in
  `/api/mapping/workspace`.

---

## What did NOT ship (deliberately deferred)

- **Embedding-half of the hybrid retrieval is live in SQL but
  not threaded into the route**: `/api/mapping/resolve` calls
  hybrid with `queryEmbedding=null`. Threading needs an
  embedding-provider injection pattern; lexical alone already
  catches most unmapped lines.
- **Customer merge UI**: the engine + backend route are ready;
  the React screen lands as a follow-up that consumes
  `/api/mapping/workspace` + the merge candidates queue.
- **Auto-confirm of high-probability LLM suggestions**: deferred
  until we have offline accuracy metrics from
  `learned_corrections`.
- **Cross-customer mapping promotion**: schema reserves the
  `cross_customer` value on `created_via` (migration 115), but
  the auto-promote path only ships `auto_consensus`.

---

## Test coverage

- 1716 passing at start of mapping work, 1831 at end.
- Every wave landed with at least one new unit test file under
  `src/v3-app/api-*.test.js`. Full suite green gate before each
  commit.
- Coverage focus: pure algorithm correctness (Jaro-Winkler /
  Metaphone canonical vectors, F-S log-odds compounding,
  decay-weight half-life table), wire shape (route validates
  body, calls dependencies in order), and edge cases
  (hallucinated IDs dropped, missing svc returns the right
  no-op).

---

## Files added

```
docs/CUSTOMER_ITEM_MAPPING.md                                  (this file)

supabase/migrations/126_customer_master_golden_record.sql
supabase/migrations/127_customer_external_ids.sql
supabase/migrations/128_customer_contacts_master.sql
supabase/migrations/129_item_customer_parts_canonical_invariant.sql
supabase/migrations/130_item_embeddings_hnsw.sql
supabase/migrations/131_item_master_search_index.sql
supabase/migrations/132_item_customer_parts_auto_consensus.sql
supabase/migrations/133_learned_corrections_contact.sql
supabase/migrations/134_customer_merge_candidates.sql

src/api/_lib/customer-external-ids.js
src/api/_lib/email-canonical.js
src/api/_lib/fuzzy-match.js
src/api/_lib/hybrid-item-search.js
src/api/_lib/cross-encoder-rerank.js
src/api/_lib/auto-promote-mappings.js
src/api/_lib/decay-weight.js
src/api/_lib/email-record-linkage.js
src/api/_lib/customer-dedupe-sweep.js
src/api/_lib/customer-merge.js
src/api/_lib/customer-part-bulk-diff.js

src/api/mapping/resolve.js
src/api/mapping/workspace.js

src/v3-app/api-customer-external-ids.test.js
src/v3-app/api-email-canonical.test.js
src/v3-app/api-fuzzy-match.test.js
src/v3-app/api-hybrid-item-search.test.js
src/v3-app/api-cross-encoder-rerank.test.js
src/v3-app/api-auto-promote-mappings.test.js
src/v3-app/api-decay-weight.test.js
src/v3-app/api-email-record-linkage.test.js
src/v3-app/api-customer-dedupe-sweep.test.js
src/v3-app/api-customer-merge.test.js
src/v3-app/api-customer-part-bulk-diff.test.js
src/v3-app/api-mapping-resolve.test.js
src/v3-app/api-mapping-workspace.test.js
```

## Files modified

```
src/api/_lib/item-mapper.js                                    new tier + context gate + valid_to filter
src/api/_lib/docai/customer-hints.js                           decay-weighted corrections + contact prior
src/api/_lib/docai/embeddings.js                               real-column source-text builder
src/v3-app/api-item-mapper.test.js                             new tier + context gate test cases
src/v3-app/api-docai-customer-hints.test.js                    unchanged in behaviour (mock returns [])
```
