# Strategic Bet 02: Format-template marketplace

> Source: research synthesis 2026-05-10. Companion to
> `docs/STRATEGIC_PLAN_2026_05.md` Bet 2.
> Status: research complete; pending counsel review for the DPA
> amendment before code work begins.

## TL;DR

Lift Anvil's per-tenant format templates (Phase D anchor templates,
`customer_format_templates`) into an opt-in global library keyed on
*layout fingerprint*, not `customer_id`. New tenants whose PO matches
a published template skip the 3-4-PO LLM warm-up. Privacy model:
redact-then-publish, k-anonymity >= 5, anonymous publisher by default.
Curation: hybrid, auto-publish for templates that pass static checks
plus AppExchange-style human review only for first-time publishers.

Target: 30% of new-tenant POs hit a global template within 6 months
of launch.

Effort: ~14 engineering days plus ~2-3 weeks counsel review plus
~1 month soft-launch with 3-5 friendly tenants. Total ~6-8 weeks
calendar.

---

## 1. Research summary

### 1.1 Codebase audit

- `customer_format_templates` row (migration 091): jsonb `anchors[]`
  of `{ field, pattern, capture_group, label, sample_value, hits }`,
  plus `sample_doc_hashes[]`, `source_run_ids[]`, `hit_count`,
  `miss_count`, `kind`, FKs `(tenant_id, customer_id)`. RLS scopes
  every row to the owning tenant.
- The matcher in `src/api/_lib/docai/templates.js` walks back ~60
  chars from a known field value, captures the textual label
  ("PO Number:", "GSTIN:") and stores the regex plus the raw
  `sample_value`.
- Dispatcher (`src/api/_lib/docai/run.js:305-326`) calls
  `applyTemplate` only when `customerId` is already known and falls
  through to L4 (LLM) otherwise.

So today's payload contains:
- regex labels (often safe English / German nouns),
- raw sample values (some PII-adjacent: GSTIN, PO numbers, payment
  terms),
- source run IDs (internal).

The `customer_format_profiles.fingerprint` (migration 001) is a
separate, broader artefact (layout signature + page count + header
tokens) and is the natural matching surface for cross-tenant lookups.

### 1.2 Industry precedent

Direct extraction-template marketplaces are rare:

- [Rossum Marketplace](https://rossum.ai/blog/idp-marketplace/)
  exists since 2021 but offers connectors / validation extensions /
  workflow recipes, **not** customer-tuned extraction templates.
  Their Aurora T-LLM trains on aggregated customer corpora under the
  DPA, so cross-tenant signal is invisible model weights.
- [Hyperscience Hypercell](https://www.hyperscience.ai/platform/hypercell/)
  ships pre-built schemas for common document classes; no public
  marketplace.
- [Nanonets pre-built models](https://docs.nanonets.com/docs/setup-pre-built-model)
  are vendor-built, not customer-published.
- [LlamaCloud Extract](https://developers.llamaindex.ai/llamaparse/extract/)
  schemas are private to the org; no marketplace.

The closest precedents are generic plugin marketplaces:

- VS Code Marketplace: malware-scanned, dynamic sandbox detection,
  "Verified Publisher" status after 6 months + domain age
  ([source](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)).
- npm: no central review; relies on version-cooldown + lockfiles
  after the 2025-2026 SANDWORM_MODE worm wave
  ([source](https://www.helpnetsecurity.com/2026/02/24/npm-worm-sandworm-mode-supply-cain-attack/)).
- [Salesforce AppExchange](https://developer.salesforce.com/docs/atlas.en-us.packagingGuide.meta/packagingGuide/security_review_how_it_works.htm):
  formal security review, ~4-5 weeks first listing, attestation per
  version after that.

Anvil sits between: small artefacts, narrow attack surface (regex),
high blast radius if a malicious template mis-extracts a PO total.
Hybrid model: auto-publish on static checks + AppExchange-style human
review for first publication per tenant.

---

## 2. Recommended approach

**Decision: opt-in, hybrid curation, fingerprint-first matching,
redact-then-publish privacy.**

| Dimension | Decision |
|---|---|
| Visibility | Per-template, operator-initiated. Default private. |
| Curation | Stage 1 deterministic (regex sanity, redaction proof, k-anonymity >= 5, anchor count >= 3, miss_rate < 10%). Stage 2 human review only on first publication per tenant. |
| Matching | Fingerprint Jaccard + cosine + anchor hit-rate. `total = 0.4 * fp + 0.6 * anchor_hit`. Threshold 0.7 to fire; 0.5-0.7 hint mode. |
| Privacy | Redact `sample_value` before publish. Keep label tokens. k-anonymity >= 5. Tenant DPA opt-in checkbox. |
| Publisher identity | Anonymous by default. "Verified publisher" badge after the first human-reviewed approval. |

### 2.1 Score function

```
fingerprintScore = jaccard(localFP.tokens, globalFP.tokens) * 0.5
                 + cosine(localFP.layoutVec, globalFP.layoutVec) * 0.5
anchorHitRate    = matchingAnchors(globalAnchors, bodyText) / globalAnchors.length
total            = 0.4 * fingerprintScore + 0.6 * anchorHitRate
```

---

## 3. Data model + migrations

**Migration 097_template_marketplace.sql** (next free if Bet 1's 097
hasn't landed first; otherwise 098).

```sql
-- Tenant-level opt-in to the marketplace DPA amendment.
alter table tenant_settings
  add column if not exists template_marketplace_publisher_optin boolean not null default false,
  add column if not exists template_marketplace_consumer_optin boolean not null default true,
  add column if not exists template_marketplace_publisher_verified_at timestamptz;

-- Global, tenant-less library.
create table if not exists customer_format_templates_global (
  id uuid primary key default uuid_generate_v4(),
  kind text not null check (kind in ('po','quote','invoice','supplier_ack','eway_bill')),
  fingerprint jsonb not null default '{}'::jsonb,
  anchors jsonb not null default '[]'::jsonb,                -- redacted: sample_value stripped
  line_anchors jsonb not null default '[]'::jsonb,
  publisher_tenant_id uuid references tenants(id) on delete set null,
  publisher_display text,                                     -- "Anonymous" | tenant short_name
  status text not null default 'pending_review'
    check (status in ('pending_review','approved','rejected','revoked','superseded')),
  approval_kind text check (approval_kind in ('auto','human')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  k_anonymity int not null default 0,
  hit_count int not null default 0,
  miss_count int not null default 0,
  upvotes int not null default 0,
  downvotes int not null default 0,
  source_template_id uuid references customer_format_templates(id) on delete set null,
  superseded_by uuid references customer_format_templates_global(id),
  created_at timestamptz not null default now()
);
create index on customer_format_templates_global (kind, status);
create index on customer_format_templates_global using gin (fingerprint);

-- Per-tenant publication audit trail.
create table if not exists template_publications (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references customer_format_templates(id) on delete cascade,
  global_id uuid references customer_format_templates_global(id) on delete set null,
  published_by uuid references auth.users(id),
  redaction_report jsonb not null,
  anonymise_publisher boolean not null default true,
  created_at timestamptz not null default now()
);
alter table template_publications enable row level security;
create policy "tp_owner" on template_publications
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- One row each time a consumer tenant adopts a global template.
create table if not exists template_imports (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid references customers(id),
  global_id uuid not null references customer_format_templates_global(id) on delete cascade,
  match_score numeric(4,3) not null,
  fingerprint_score numeric(4,3),
  anchor_hit_rate numeric(4,3),
  used_for_extraction_ids uuid[] default array[]::uuid[],
  reverted_at timestamptz,
  created_at timestamptz not null default now()
);
alter table template_imports enable row level security;
create policy "ti_owner" on template_imports
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);

-- Reports of suspected malicious templates.
create table if not exists template_reports (
  id uuid primary key default uuid_generate_v4(),
  global_id uuid not null references customer_format_templates_global(id) on delete cascade,
  reporter_tenant_id uuid references tenants(id) on delete set null,
  reason text not null,
  evidence jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- Analytics split.
alter table extraction_runs
  add column if not exists global_template_used uuid;
```

---

## 4. User-visible UX

### 4.1 Publish flow (Profile Studio)

1. Operator opens an active template in Studio. Sees a new "Share with the Anvil community" panel.
2. **First time only**: tenant-admin must check *"I've read the [DPA amendment](#) and authorise publication of redacted templates"*. Flips `template_marketplace_publisher_optin`.
3. **Per template**: operator clicks Publish. Modal previews the redacted payload:
   - Anchor labels visible.
   - Sample values masked as `<redacted:gstin>` style placeholders.
   - Publisher display name with an "Anonymous" toggle.
4. Submit -> `template_publications` row -> Stage 1 auto-checks -> Stage 2 (first-time only) creates a Linear / Jira ticket for human review with 5-business-day SLA.

### 4.2 New-tenant extraction flow

1. New tenant uploads a PO. Customer not yet known. Today's flow goes straight to L4 LLM.
2. New L3.5 step (after L3 miss): build the doc's fingerprint, query `customer_format_templates_global` where `kind='po'` and `status='approved'`, score top 5.
3. **If best score >= 0.7**: banner above the extraction preview - *"This looks like a layout we've seen before. Used a community template by Anonymous (12 successful imports)."* Templated fields highlighted with a "Marketplace" chip. Operator can click "Don't use this" to revert.
4. **If 0.5 <= score < 0.7**: silent hint mode (passed as `hints.knownFields` to L4, no banner).
5. After 2 successful operator approvals on a global-template-fed run: row in `template_imports` blessed; tenant's local `customer_format_templates` seeded from the global version, so subsequent docs run the L3 fast path locally.

### 4.3 Admin dashboards

- **Tenant admin** (Studio Marketplace tab): list global templates the tenant has imported, success rate per template, "stop using" action.
- **Super-admin**: review queue (Stage 2 pending), report queue, kill switch per global template.

### 4.4 Privacy disclaimer copy

> Publishing this template makes the regex anchors and field labels available to other Anvil tenants. The actual values from your customer's purchase orders are NOT shared - they are replaced with placeholders before publication. Your tenant's name is hidden by default and never linked to specific customers. You can revoke any published template at any time.

---

## 5. Technical implementation plan

### 5.1 New modules

1. **`src/api/_lib/docai/redact.js`** (new). `redactTemplateForPublication(template) -> { redacted, report }`. Strips `sample_value`, replaces with `<redacted:gstin>`-style tokens, scans labels with a Presidio-style regex set for accidental PII (email, phone, PAN, GSTIN with sample vals, addresses).
2. **`src/api/_lib/docai/marketplace.js`** (new). Three exports:
   - `publishTemplate(svc, { tenantId, templateId, anonymise, userId })` - validates k-anonymity (>=5 distinct `sample_doc_hashes`), runs `redact()`, inserts into `customer_format_templates_global` with `status='pending_review'`, runs auto-checks, transitions to `approved` if pass.
   - `findGlobalCandidates(svc, { fingerprint, kind, bodyText })` - top-5 candidates ranked by fingerprint Jaccard + anchor hit-rate.
   - `applyGlobalTemplate(svc, { tenantId, customerId, globalId, bodyText })` - mirrors `applyTemplate` but reads from `customer_format_templates_global`, writes a `template_imports` row.

### 5.2 Dispatcher integration

3. `src/api/_lib/docai/run.js` lines 305-322: insert L3.5 step between L3 (`applyTemplate`) and L4 (LLM). If `templateApplied?.used` is false, call `findGlobalCandidates`, apply top match if >= 0.7, drop into hint mode if 0.5-0.7. Write `extraction_runs.global_template_used` and `template_imports`.

### 5.3 API endpoints

4. `POST /api/marketplace/publish`
5. `POST /api/marketplace/revoke`
6. `GET /api/marketplace/imports`
7. `POST /api/marketplace/report`
8. `POST /api/marketplace/review` (super-admin only)

All RBAC-gated through the existing `RBAC` helper.

### 5.4 Profile Studio UX

9. `src/v3-app/screens/studio.tsx`: new panel below the rollback list, gated on `template_marketplace_publisher_optin`. Reuses `Card` / `Btn` / `Banner` primitives. ~150 LOC.

### 5.5 Anti-abuse hardening (in `marketplace.js`)

10. Regex linter: reject patterns with backtracking-prone constructs (`.*.*`, nested `(.+)+`); enforce 200 ms timeout per anchor.
11. Sample-value diff check: re-run published anchors against the publisher's last 5 docs in CI; reject if extracted values differ from the operator-confirmed normalized extracts (catches deliberately mis-extracting templates).
12. Capture-group count cap (max 1 per anchor) - blocks regexes that exfiltrate the whole body via a wide capture.
13. Per-template kill switch: `status='revoked'`. Matcher skips and consumers get a "this template was revoked, falling back to LLM" toast.

### 5.6 Tests

14. New `src/v3-app/api-docai-marketplace.test.js`. Mirror the shape of the existing `api-docai-templates.test.js`. Cover redaction, scoring, publish flow, anti-abuse rejections, dispatcher hint-mode integration.

---

## 6. Risks and open questions

- **Customer-IP concern**. Even with redaction, the *layout* of a customer's PO is arguably a derivative work of that customer's IP; some MSAs explicitly prohibit it. Need a per-customer "do not publish my templates" flag in addition to the tenant-level opt-in. DPA amendment must explicitly cover anchor regexes as anonymised processed data, citing [DPDP Act treatment of irreversible anonymisation](https://www.dpdpa.com/dpdpa-faq.html). External counsel review ~2-3 weeks.
- **Anti-abuse**. A malicious template can (a) silently mis-extract a value (e.g. wrong PO total), (b) exfiltrate adjacent text via wide regex captures, (c) cause regex DOS. Mitigations: hint-mode default below 0.7 (operator confirms each hit for the first 5 imports), capture cap, timeout. There is no purely deterministic way to know a template is correct on a never-seen layout; this is why hint mode (rather than full skip-LLM) is the correct default.
- **PII leak surface in current schema**: `sample_value` (raw GSTIN, payment terms strings), `label` (in rare cases customer name appears in label text - "Acme Corp PO Number:"). Redactor must scan both.

Open:
- **Publisher name visibility**. Default proposal: anonymous, with a "verified publisher" badge after the first human review. Avoids accidental disclosure that "Tenant A serves customer X" while still giving consumers a trust signal.
- **Pricing / incentives**. Free for v1. Revenue-share for high-hit templates is unlikely (turns extractions into rent-seeking).

---

## 7. Effort estimate

- **Code days**: ~14 engineering days. Migration + redactor (1d), `marketplace.js` core (3d), dispatcher integration + tests (2d), API endpoints (2d), Studio UX (3d), super-admin review queue (2d), anti-abuse hardening (1d).
- **Legal review**: 2-3 weeks elapsed (1-2 weeks external counsel + internal back-and-forth). DPA amendment template + per-tenant click-through.
- **Pilot / curation**: 1 month soft-launch with 3-5 friendly tenants before opening to all. Stage 2 human review for every publication during pilot, then auto-approve thereafter.
- **Total to GA**: ~6-8 weeks calendar.

---

## 8. Sources cited

- [Rossum Marketplace - Building an IDP Marketplace for All](https://rossum.ai/blog/idp-marketplace/)
- [Rossum Marketplace press release](https://rossum.ai/company/newsroom/rossum-marketplace/)
- [Rossum Aurora proprietary LLM](https://www.intelligentdocumentprocessing.com/idp-vendor-rossum-introduces-aurora-with-its-proprietary-llm/)
- [Hyperscience Hypercell platform](https://www.hyperscience.ai/platform/hypercell/)
- [Nanonets Pre-Built Models](https://docs.nanonets.com/docs/setup-pre-built-model)
- [Nanonets Custom Model](https://docs.nanonets.com/docs/setup-custom-model)
- [Klippa DocHorizon Flow Builder](https://www.klippa.com/en/dochorizon/platform/flow-builder/)
- [LlamaCloud Extract overview](https://developers.llamaindex.ai/llamaparse/extract/)
- [VS Code Extension Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
- [VS Code Extension Runtime Security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)
- [Salesforce AppExchange Security Review process](https://developer.salesforce.com/docs/atlas.en-us.packagingGuide.meta/packagingGuide/security_review_how_it_works.htm)
- [npm SANDWORM_MODE typosquatting wave (Help Net Security, Feb 2026)](https://www.helpnetsecurity.com/2026/02/24/npm-worm-sandworm-mode-supply-cain-attack/)
- [Veracode Spring 2026 supply chain report](https://www.veracode.com/blog/threat-research-spring-2026-software-supply-chain-security/)
- [DPDP Act 2023 official text](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf)
- [DPDPA FAQ on anonymisation](https://www.dpdpa.com/dpdpa-faq.html)
- [AI Training Data under India's DPDP regime](https://www.khuranaandkhurana.com/ai-training-data-under-india-s-dpdp-regime-compliance-challenges-and-strategies)
- [GDPR for SaaS - DPA Article 28 obligations](https://complydog.com/blog/gdpr-for-saas-companies-complete-compliance-guide)
- [Microsoft Presidio - PII detection patterns](https://towardsdatascience.com/building-a-customized-pii-anonymizer-with-microsoft-presidio-b5c2ddfe523b/)
- [k-anonymity meets differential privacy (CERIAS)](https://www.cerias.purdue.edu/assets/pdf/bibtex_archive/2010-24-report.pdf)
- Codebase: `src/api/_lib/docai/templates.js`, `src/api/_lib/docai/index.js`, `src/api/_lib/docai/run.js`, `supabase/migrations/091_extraction_pipeline_phases_b_thru_f.sql`, `supabase/migrations/001_init.sql`, `src/v3-app/screens/studio.tsx`.
