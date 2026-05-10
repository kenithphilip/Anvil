# Extraction Pipeline, Hardening Plan

Status: Draft v1, May 2026
Owner: Anvil engineering, in collaboration with Obara India operations.
Trigger: operator frustration with repeat-broken extractions across PRs
#58, #66, #68, #70, #82, #83, #84.

The retrospective in PR #84 found that the docai pipeline has been
treated as "send the file to an LLM and hope" while every operator
complaint patched a different UI surface. The audit attached to
this doc shows we already have most of the building blocks but they
do not feed each other:

- A working multi-adapter dispatcher (Claude / Reducto / Azure DI /
  Unstructured / Excel / GAEB).
- Mistral OCR producing per-block bboxes.
- An `extraction_corrections` feedback loop with a 50-correction
  threshold rebuilding per-customer few-shot bundles.

What's missing is the orchestration: **a deterministic-first
hybrid pipeline that uses the cheap, accurate paths before falling
through to an LLM, validates every field against domain rules, and
votes across adapters when they disagree.**

---

## 1. Goals

| # | Goal | Measure |
|---|------|---------|
| G1 | Eliminate the `image_pdf_no_text` failure mode | 0 occurrences over 100 uploads |
| G2 | Cut average extraction cost per PO by 70% | mean LLM tokens per PO |
| G3 | Auto-extract 95%+ of fields on POs from repeat customers (Tata, JBM, Mahindra, etc.) | per-customer field-fill rate |
| G4 | Surface a categorised reason for every failed extraction | every extract response carries `status_reason` (already shipped in PR #84) |
| G5 | Same pipeline serves SO intake, source PO ack, invoice match, e-Way bill | one extraction service called by 5+ modules |
| G6 | Operator corrections feed back to the engine, not just Claude | corrections dictionary applies pre-LLM |

---

## 2. The hybrid pipeline (target architecture)

The pipeline runs in this order. Earlier layers handle the common
cases cheaply; LLM is the fallback, not the default.

```
Upload --> [L0 file gate] --> [L1 deterministic text]
                              |
                              v
                              [L2 layout-aware OCR] (only if L1 found < 200 chars)
                              |
                              v
                              [L3 template / anchor extractor] (per-customer profile)
                              |
                              v
                              [L4 LLM adapter chain] (Claude / Reducto / Azure DI)
                              |
                              v
                              [L5 validator pass] (GSTIN, currency, line-math)
                              |
                              v
                              [L6 cross-adapter voter] (only if 2+ adapters ran)
                              |
                              v
                              [L7 operator review banner] (if confidence < threshold)
```

### L0: file gate

Already mostly built (ClamAV scan + zip guard). Adds:

- File-type detection without trusting `mime` claim from the client.
- Page count + page-image density heuristic (binary-noise vs text-PDF).
- Stamps `documents.text_layer_status = 'has_text' | 'image_only' | 'mixed'`.

### L1: deterministic text extraction

**New**. Today we have nothing here. Most POs from established
customers are text-PDFs with a structured table; pulling text +
bbox positions deterministically is O(ms) and free.

- Library: `unpdf` (modern, edge-runtime-friendly, wraps PDF.js)
  or `pdf-parse` (simpler, less metadata).
- Output: `{ text, pages: [{ items: [{ text, x, y, w, h, font }] }] }`.
- Stored in a new `extraction_text_layer` table keyed by document_id.

### L2: layout-aware OCR (existing Mistral)

Already shipped. **Currently runs in parallel and never feeds the
docai dispatcher.** Wire it in:

- If L1 returns `< 200 chars` of text, the dispatcher invokes
  Mistral OCR synchronously, takes the page text, feeds it as
  `hints.bodyText` to L3 / L4.
- This eliminates the `image_pdf_no_text` failure mode at its
  source.

### L3: template / anchor extractor

**New**. Per-customer format profiles. After N successful
extractions for a customer, the engine snapshots the document's
fingerprint:

- Header/footer text anchors ("Tata Steel Ltd · Purchase Order")
- Field positions ("GSTIN at bbox (450, 78)-(620, 96)")
- Per-field regex / coordinate rules

On subsequent uploads matching the fingerprint, the engine reads
the fields directly via regex / coordinate lookup, skipping the
LLM entirely. Falls through to L4 if any required field is
unmatched.

### L4: LLM adapter chain

Existing. After L1 + L2 + L3, the LLM is invoked with a much
smaller, cleaner prompt because:

- The text is already extracted.
- The customer template tells the LLM "fields x, y, z are at these
  coordinates; fill in just w".
- The few-shot bundle from prior corrections is included.

Net effect: tokens per call drop from ~6000 to ~1500 for known
customers, and Claude is doing classification + edge cases instead
of trying to read binary PDF bytes.

### L5: validator pass

**New shared module**. Today the GSTIN regex lives in the Claude
prompt text. Pull it out:

- `validateGstin(s)`: returns `{ valid, normalized, state_code }`.
- `validateStateCode(s)`: India 2-letter codes + GSTIN prefix
  reconciliation.
- `validateCurrency(s)`: ISO 4217 codes + tenant default.
- `validateHsnSac(s)`: 4 to 8 digit numeric.
- `validateLineMath(qty, rate, lineTotal)`: 0.5% tolerance for
  rounding; flags mismatches.
- `validatePhone(s)`: E.164 + India NDNC normalisation.
- `validateEmail(s)`: RFC 5322 + DNS MX hint.

Every validator returns a confidence multiplier. The aggregate
post-validator confidence is the product of per-field multipliers.
A field that fails validation flags as `needs_review` instead of
silently corrupting the order.

### L6: cross-adapter voter

**New**. When 2+ adapters ran (L3 anchor + L4 LLM, or 2 LLMs in the
chain), reconcile per field:

- Both agree → confidence 0.99
- One has higher source-confidence → that one wins, confidence
  averaged
- Neither passes validators → `needs_review`

The provenance table (which adapter produced which field) becomes a
column on `extraction_runs.field_provenance jsonb`.

### L7: operator review banner

Already partially shipped (status_reason banner in PR #84). Extend
to per-field flagging:

- The reconciliation tab highlights fields that came from a
  low-confidence path (LLM with no validator support, or single-
  adapter with no template).
- Operator edits feed L3 + Claude few-shot.

---

## 3. Cross-cutting: corrections feedback for ALL adapters

The `extraction_corrections` table feeds Claude today via per-
customer prompt overrides (`tenant_settings.docai_prompt_overrides`).
That works only because Claude is the catch-all.

Refactor so corrections become **canonical truth** the engine uses
BEFORE any LLM call:

1. Each correction promotes to a `customer_field_overrides` row:
   `(tenant_id, customer_id, field_path, expected_value, source = 'operator_correction')`.
2. The L3 anchor extractor checks overrides first. If we know
   "Customer Tata Steel always has currency=INR", we never ask
   the LLM.
3. The validator layer (L5) treats overrides as ground truth.
4. The few-shot bundle for Claude reads overrides too, so even
   when the LLM IS invoked it has the operator's most recent
   knowledge.

The 50-correction rebuild threshold (currently used to update
prompt overrides) gets replaced with a per-correction
incremental update. Operators see their fixes take effect on the
NEXT upload, not the 50th.

---

## 4. Schema changes

Migration `089_extraction_layered_pipeline.sql` (new):

```sql
-- L1 deterministic text-layer cache
create table extraction_text_layer (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  text_chars int not null default 0,
  pages_with_text int not null default 0,
  raw jsonb not null default '{}'::jsonb,    -- page-by-page text + bboxes
  extracted_at timestamptz not null default now(),
  unique (tenant_id, document_id)
);

-- L0 + L2 file-type signal
alter table documents
  add column if not exists text_layer_status text
    check (text_layer_status is null or text_layer_status in
      ('has_text', 'image_only', 'mixed', 'unparseable'));

-- L3 customer format templates (per-customer per-document-shape)
create table customer_format_templates (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  fingerprint_hash text not null,
  template_name text,                        -- "Tata Steel PO 2026 v1"
  anchors jsonb not null default '[]'::jsonb, -- regex + bbox rules
  field_rules jsonb not null default '{}'::jsonb,  -- per-field extractor
  hit_count int not null default 0,
  miss_count int not null default 0,
  last_hit_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, customer_id, fingerprint_hash)
);

-- L6 + Validators: per-field confidence + provenance on every run
alter table extraction_runs
  add column if not exists field_provenance jsonb default '{}'::jsonb,
  add column if not exists validator_results jsonb default '{}'::jsonb;

-- Cross-adapter ground-truth overrides
create table customer_field_overrides (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  field_path text not null,         -- 'customer.gstin', 'customer.payment_terms'
  expected_value jsonb not null,
  source text not null check (source in
    ('operator_correction','admin_set','imported')),
  set_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, customer_id, field_path)
);
```

---

## 5. Adapters added

| Adapter | File | Layer | Tech | Cost |
|---------|------|-------|------|------|
| pdf_text | `src/api/_lib/docai/pdf_text.js` (new) | L1 | unpdf (PDF.js wrapper) | free |
| ocr_text | extends `src/api/_lib/mistral.js` (existing) | L2 | Mistral OCR | per-page |
| anchor | `src/api/_lib/docai/anchor.js` (new) | L3 | regex + bbox lookup | free |
| claude | existing | L4 | Anthropic | per-token |
| reducto / azure_di / unstructured | existing | L4 fallback | provider-specific | per-page |

---

## 6. Validators module

`src/api/_lib/docai/validators.js` (new). Functions:

```ts
validateGstin(s: string): { valid, normalized, state_code, confidence_mult }
validateStateCode(s: string, opts?): { valid, normalized, confidence_mult }
validateCurrency(s: string, opts?): { valid, normalized, confidence_mult }
validateHsnSac(s: string): { valid, normalized, confidence_mult }
validateLineMath(qty, rate, lineTotal, opts?): { valid, computed_total, confidence_mult }
validatePhone(s: string, opts?): { valid, normalized, country, confidence_mult }
validateEmail(s: string): { valid, normalized, confidence_mult }
validatePartNo(s: string, customerId: uuid): { valid, normalized, alias_id, confidence_mult }  // hits part_aliases
```

Used by L5, but ALSO by:
- `customers/index.js` POST handler
- `orders/index.js` POST handler
- inbound email / source PO / invoice handlers

So a malformed GSTIN never reaches the database regardless of source.

---

## 7. Self-improving loop

Every operator correction:

1. Writes `extraction_corrections` (existing).
2. Promotes to `customer_field_overrides` if the correction
   stabilises (same field, same value, 2+ POs in a row).
3. If a customer has >=3 successful extractions of the same shape,
   auto-creates a `customer_format_templates` row from the
   intersection of their layouts.
4. Templates with `miss_count > hit_count` over a 30-day window
   auto-archive (so a customer changing their PO format doesn't
   send the engine off a cliff).

The result: the longer the system runs, the less it depends on
LLMs.

---

## 8. Cross-module reuse

The pipeline above lives behind a single function:

```ts
extractDocument({
  bytes, mime, customer_id?, expected_kind: "po"|"quote"|"invoice"|...,
  apply_overrides?: boolean,
}): Promise<ExtractionResult>
```

Modules that call it:

- SO intake (`/api/docai/extract`, current consumer) -> `expected_kind: "po"`
- Source PO ack (`/api/source_pos/[id]/ack` parses supplier confirmation)
- Inbound email (`/api/inbound/email/persist_attachments` already exists; route through new pipeline)
- Invoice match (`/api/invoices/match` parses 3-way match docs)
- e-Way bill (`/api/eway_bills` parses GSTN response PDFs)
- Tally voucher reconciliation

Each module passes a different `expected_kind` so the L4 prompt is
specialised, but L1 + L2 + L3 + L5 + L6 + L7 are shared.

---

## 9. Phased rollout

| Phase | Scope | Effort | Net effect |
|-------|-------|-------:|------------|
| A | L1 deterministic text + L5 validators | 3 d | Cuts LLM cost ~50% on text-PDFs; surfaces field validation errors |
| B | L2 OCR-augmented prompt for image PDFs | 2 d | Eliminates `image_pdf_no_text` failure |
| C | L6 cross-adapter voter + field provenance | 2 d | Per-field confidence visible to operator |
| D | L3 anchor / template extractor + customer_format_templates | 4 d | Repeat-customer extractions go LLM-free |
| E | Customer-field overrides + immediate-feedback corrections | 2 d | Operator corrections take effect on next upload |
| F | Module-wide rollout (source PO, invoice, e-Way bill) | 3 d | One extraction service across the product |

Total: ~16 days sequential, ~10 days parallel-2.

Phase A delivers the most operator-visible improvement on day one
because it solves the "0 lines, no signal" complaint at source.

---

## 10. What we deliberately won't do (yet)

- **LayoutLM / Donut self-hosted**: requires Python + GPU infra.
  Defer to Year-2; the Reducto / Azure DI cloud APIs cover the
  same need with no infra.
- **Field-level human-in-the-loop UI for every field**: the L7
  banner approach is enough for v1. Bbox-overlay approval per
  field is Phase 7 follow-up.
- **Multi-modal LLMs replacing the entire pipeline**: Claude
  vision is good but slow + expensive. The L1+L3 deterministic
  layers cut 80% of cases for free; only Phase F extends the L4
  catch-all.

---

## 11. Risks

- **R1: unpdf / pdf-parse fails on edge-case PDFs**. Mitigation:
  L2 OCR is the immediate fallback.
- **R2: anchor templates over-fit and miss when customer changes
  layout**. Mitigation: miss_count auto-archive in 30 days.
- **R3: validator over-rejects**. Mitigation: validators downgrade
  confidence rather than reject; operator can still accept on
  review.
- **R4: cross-adapter voter creates surprise overrides**.
  Mitigation: provenance is logged on every field; operator can
  see "we picked Reducto over Claude on line 6" and override.

---

## 12. Acceptance criteria

| # | Criterion | Verification |
|---|-----------|--------------|
| A1 | A text-PDF PO from a known customer extracts in < 500 ms with no LLM call | telemetry on extraction_runs |
| A2 | An image-only PDF auto-routes through OCR + LLM with no operator action | end-to-end test |
| A3 | GSTIN validator rejects malformed GSTINs at every entry point | RLS test + integration test |
| A4 | An operator correction takes effect on the NEXT extraction for that customer | smoke test |
| A5 | Per-field provenance + confidence visible on the workspace's reconciliation tab | UI test |
| A6 | The same extractDocument function serves SO intake AND source PO ack | call-site grep |

---

End of plan v1. Pending operator decisions: (a) priority of Phase
A vs Phase D; (b) whether to budget for Reducto/Azure DI tier-1
keys to give Phase C something to vote against; (c) module-rollout
order in Phase F.

## Sources

- [unpdf (UnJS PDF extraction)](https://github.com/unjs/unpdf)
- [pdf-parse vs unpdf vs pdfjs-dist comparison 2026](https://www.pkgpulse.com/blog/unpdf-vs-pdf-parse-vs-pdfjs-dist-pdf-parsing-extraction-nodejs-2026)
- [Reducto's multi-pass confidence-scored approach](https://reducto.ai/blog/document-parsing-unstructured-files)
- [Document parser comparison: Reducto vs LlamaParse vs Unstructured](https://llms.reducto.ai/document-parser-comparison)
- [LayoutLM family for invoice/PO extraction](https://www.nitorinfotech.com/blog/how-can-layoutlm-transform-text-extraction/)
- [Donut vs LayoutLM accuracy comparison](https://www.researchgate.net/publication/375116616_A_Comprehensive_Analysis_of_LayoutLM_and_Donut_for_Document_Classification)
- [OpenDataLoader hybrid PDF parser](https://github.com/opendataloader-project/opendataloader-pdf)
- [Claude PDF support, 2025](https://platform.claude.com/docs/en/build-with-claude/pdf-support)
- [Best Document AI tools 2026 benchmark](https://www.atlasworkspace.ai/blog/best-document-ai-tools)
