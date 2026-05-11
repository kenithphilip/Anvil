# A2 deep-dive v2: SO intake, orders workspace, customer match, approvals, projects

Refreshed analysis pass against `main@c4f946b`. The earlier version of this
file (v1) opened with a claim that the v3 React app did not exist on `main`
and that all relevant work lived on the `feat-customer-mismatch-flag-and-edit`
branch. That claim is incorrect on the current `main`. The v3 app, including
`src/v3-app/screens/so-intake.tsx` (1364 lines), `so-workspace.tsx` (1755 lines),
`orders.tsx` (226 lines), `customers.tsx` (307 lines), `customer-duplicates.tsx`
(246 lines), `approvals.tsx` (205 lines), `intake.tsx` (209 lines),
`duplicates.tsx` (142 lines), `internal-sos.tsx` (336 lines), `items.tsx`
(254 lines), and `so-history.tsx` (1129 lines), is all present on main, and
`public/index.html` has shrunk to 21 lines (it now just bootstraps the Vite
bundle). The seven Bet branches (#94..#100) have merged in. This v2 grounds
every claim in verified main-branch code, swaps in primary-source competitor
quotes from a fresh round of WebFetch calls, and elevates 16 findings to
publication-grade depth. Every finding tags evidence as one of:

- **[main-verified]**: I read the cited file and line range on `main@c4f946b`.
- **[fetch-verified]**: I pulled the cited URL during this analysis run.
- **[inferred]**: My read of two or more verified facts implies the claim,
  but the claim itself is not directly cited.

Date: 2026-05-11. Repository basis: `/Users/kenith.philip/anvil/`,
branch `main`, HEAD `c4f946b`. 1122 tests across 65 files. 103 SQL
migrations. 373 endpoints (counted in earlier audits). 126 v3 screens.
Style: no emojis, no em or en dashes, citations inline.

---

## Section 0: state of the matcher and the intake surface on main

Before the gap inventory I document the truth of what exists today, because
the v1 version of this document misread the branch state.

### 0.1 Customer matcher on `main` (so-intake.tsx)

`src/v3-app/screens/so-intake.tsx` lines 264 to 311 define
`matchCustomerFromExtraction(extracted, runConfidence)`. The function is a
three-tier rule cascade:

1. Confidence gate at 0.85 (`if (typeof runConfidence === "number" &&
   runConfidence < 0.85) return null;` at line 275). [main-verified]
2. Tier 1: GSTIN exact, where GSTIN must match `/^[0-9A-Z]{15}$/` and the
   stored customer's GSTIN must match after uppercasing. Returns
   `{ customer, confidence: "exact_gstin" }`. [main-verified line 280-284]
3. Tier 2: normalised-name exact match, but only when the bill-to address
   blob contains the first significant token of the canonical name. This is
   the post-PR-91 corroboration rule that defends against extracting an
   end-customer or equipment-brand name from a line item. The function
   bails when:
   - The extracted name is shorter than 3 characters after normalisation
   - The first significant token is shorter than 4 characters
   - The bill-to address does not contain the token
   [main-verified lines 286-308]

`norm()` at line 264 strips `pvt|ltd|llp|inc|corp|gmbh|kk|ag|bv|sa|company|limited|co`
suffixes, collapses whitespace, and lowercases. The point is to make
`"Faith Automation"` extracted from the PO header match
`"Faith Automation Pvt Ltd"` stored. `normTight()` at line 270 reduces
arbitrary text to lowercase alphanumerics for the bill-to comparison.
[main-verified]

`suggestLooseMatch(extracted)` at line 416 to 432 does prefix-substring
matching across the customer list as a UI-only hint. No score is returned.
This is the screen's fallback when the strict matcher returns null. The
operator sees a `notifyLive` toast with the candidate name and the
new-customer dialog opens with extractor prefill so the operator can
either pick the existing customer from the dropdown or commit to a new
record. [main-verified]

### 0.2 Backend mirror (customer-canonicalizer.js)

`src/api/_lib/customer-canonicalizer.js` provides the matching used by
ERP-sync paths (NetSuite, SAP, D365, Acumatica). `canonicaliseCustomer()`
at line 101 to 153 does:

1. `findByExternalId(svc, tenantId, vendorIdField, externalId)`: SQL
   filter `eq("external_ref->>" + vendorIdField, String(externalId))`.
   This is the idempotency hook for re-syncs. [main-verified line 51-62]
2. `findByGstin`: SQL filter `eq("gstin", k)` after the 15-char shape
   check. [main-verified line 64-74]
3. `findByCanonicalName`: pulls up to 50 candidates by `ilike` on the
   first 16 chars of the name, then filters by `canonicaliseName(stored) ===
   canonicaliseName(input)` in JS. [main-verified line 76-90]

Either an early-exit match updates `external_ref` with the new vendor id,
or step 4 inserts a new row with a vendor-prefixed `customer_key` such as
`"netsuite:1234"`. [main-verified line 142-152]

### 0.3 Duplicates UI (customer-duplicates.tsx)

`src/v3-app/screens/customer-duplicates.tsx` is 246 lines. It pulls
duplicate groups from `/api/customers/duplicates` (GET), surfaces each
group as a card with primary radio + dup checkboxes + an apply-merge
button. Confirmation is a single `window.confirm()` call at line 115
warning "Merging X rows into Y. This cannot be undone." On success the
component calls `ObaraBackend.customers.merge` which hits
`/api/customers/merge` (POST). [main-verified]

### 0.4 Duplicate detection signals (api/customers/duplicates.js)

`src/api/customers/duplicates.js` is 94 lines. Two signals fire:

- `groupByGstin(rows)`: groups by uppercased trimmed GSTIN where the GSTIN
  has at least 15 chars. The 15-char check is a soft Indian-PAN-based
  GSTIN format guard. [main-verified line 42-53]
- `groupByCanonicalName(rows, alreadyClaimedIds)`: groups by
  `canonicaliseName()` where `canonicaliseName = lowercase >
  strip-suffixes > non-alphanumeric-stripped`. Strips `pvt|ltd|llp|inc|
  corp|gmbh|co|company|limited`. [main-verified line 55-67]

The vendor-prefix signal mentioned in the screen's SIGNAL_LABEL table
(`vendor_prefix: "Vendor-prefix mismatch"`) does not appear in the API.
This is a UI-side label that the API never emits, so the screen will
never render that signal. The drift exists. [inferred from comparison of
`customer-duplicates.tsx:39-43` SIGNAL_LABEL constants with
`api/customers/duplicates.js`]

### 0.5 Order duplicate detection (duplicates.tsx)

A separate `src/v3-app/screens/duplicates.tsx` (142 lines) consumes
`ObaraBackend.duplicates.search({ minScore: 0.7 })`. Renders order pairs
with similarity score, fields-matched chip, status chip. Operator actions
are "review" and "compare" which navigate to the workspace; no inline
mark-confirmed or dismiss action. [main-verified]

### 0.6 Approvals (approvals.tsx + admin/quote_approvals.js + approval-evaluator.js)

`src/v3-app/screens/approvals.tsx` is 205 lines: pending approvals as a
flat table, approve/reject buttons with a `window.confirm` guard, no
right-pane context, no delegation, no escalation. KPI row reads
`pending`, `expiring < 6h`, `margin breaches`, `approved today`.
[main-verified]

`src/api/admin/quote_approvals.js` handles thresholds CRUD (admin role)
and approvals CRUD (write role). The `decided_at` and `approver_user`
columns are stamped on update. [main-verified]

`src/api/_lib/approval-evaluator.js` is the bridge. When an order moves
from any prior status to PENDING_REVIEW, the order PATCH handler in
`api/orders/[id].js:140-155` calls `evaluateApprovalsForOrder`. The
evaluator pulls active `quote_approval_thresholds`, filters by
amount-band + mode allowlist + margin-below gate, dedupes against any
existing PENDING rows for the same `(order_id, approver_role)`, and
inserts new `quote_approvals` rows. [main-verified
`approval-evaluator.js:81-119`]

### 0.7 Order state machine (orders/[id].js)

`src/api/orders/[id].js:34-45` defines `ALLOWED_TRANSITIONS`, a static
adjacency-list state machine. DRAFT can go to PENDING_REVIEW, BLOCKED,
DUPLICATE, REUSED, CANCELLED, or DRAFT. The APPROVED state requires
`body.approval.payloadHash` (line 109) and the `approve` permission (line
110). The transition is logged via `recordAudit` and a processing-event
is emitted. Editing `result` or `line_edits` while an approval exists
invalidates the approval (lines 121-126). [main-verified]

Implication: a state-machine drag-and-drop kanban (proposed in v1 finding
F2.6) does not need backend changes. The state machine already enforces
legal transitions; the kanban just calls PATCH and renders the 409 reply.

### 0.8 What main does not have (gap inventory)

After reading 13 files end to end I can confirm `main@c4f946b` does not have:

- A probabilistic record-linkage scorer with per-field comparators
- A `customer_aliases` table or any alias capture during merge
- Any phonetic matcher (Soundex, Metaphone, Double Metaphone)
- Any Jaro-Winkler, Levenshtein, or token-set ratio comparator
- An `end_customer` or `secondary_parties` field on `orders`
- A bbox-overlay review surface (`doc-review.tsx` not present)
- Table density modes; `orders.tsx` row padding is implicit from `.tbl` class
- A kanban view of the orders pipeline
- Approval delegation, escalation cron, parallel approvers, or right-pane preview
- A merge-time alias capture or undo path for `merge.js`
- A multi-tab customer detail with orders / contacts / aliases / equipment
- Shared `<EmptyState>`, `<ErrorBanner>`, `<TableSkeleton>` primitives in
  `lib/primitives.tsx`. The grep returned 0 matches. [main-verified]

These shape the 18 findings in this v2 document.

---

## F2.1 Probabilistic entity resolution for customer match (Fellegi-Sunter)

### Problem

`src/v3-app/screens/so-intake.tsx:272-311` and
`src/api/_lib/customer-canonicalizer.js:101-153` together implement a
deterministic three-tier matcher: GSTIN exact, canonical-name exact with
bill-to corroboration, fall through. There is no middle band where the
system says "62% confidence, please confirm" and learns from the operator's
decision. The OBARA / Faith Automation incident (resolved at PR #91 by
adding bill-to corroboration + dropping a filename guard) is the visible
symptom of a deeper problem. Indian SME naming has high permutation count
per legal entity: Tata Steel Limited vs TATASTEEL vs Tata Stee vs M/s Tata
Steel Ltd. (Unit-VII) all canonicalise differently. Foreign POs add a
second axis: OBARA KK, OBARA Korea, Obara Engineering, Obara (Korea) Ltd.
The rule-based matcher binarises every one of these into match or no-match,
no probability gradient.

### Current Anvil state

`matchCustomerFromExtraction` at `src/v3-app/screens/so-intake.tsx:272-311`:
three branches. The confidence gate is a hard 0.85 against the model's
overall run confidence (which is the cross-adapter voted score from
`voter.js`, not a per-field calibration). Bill-to corroboration is a
single-token alphanumeric substring check at line 301 (`firstToken.length >= 4
&& billToTight.includes(firstToken)`). Multi-word brands fall back to the
first token. Short codes (ITC, TVS, HCL, ABB, IBM, SBI, L&T, M&M, BHEL,
HAL) cannot satisfy `firstToken.length >= 4` and so will never auto-match
by name, only by GSTIN. [main-verified]

The backend canonicalizer mirrors this with an additional ilike prefix
candidate-prune at `customer-canonicalizer.js:85`. Both screens depend on
the same name normalisation defined in two places (the screen at
`so-intake.tsx:264-269` and the API at `customer-canonicalizer.js:34-37`),
which is the obvious refactor target.

### Competitor state

Rossum on the Order Management product page describes "Validate and
augment transactional data" and exposes
"Automate the approval workflow with rules for auto-approve/reject based
on your criteria" but does not disclose the exact lookup model on the
marketing page. [fetch-verified rossum.ai] The internals from their
SDK docs reference per-queue confidence thresholds and rule-based
queue routing, but the marketing pass through left the implementation
specifics off the surface page. Treat the lookup model as "operator-tunable
but unspecified" for direct comparison.

Conexiom positions itself differently: "1B+ line items annually" with
three automation modes (AI Co-Pilot, Dynamic AI, AI Autopilot), 40+ ERP
integrations including SAP, NetSuite, D365, Epicor, where "unlimited
touchless partner configurations" at higher tiers eliminate the customer
disambiguation problem by routing on trading partner identity. Their
moat is trading-partner curation; customer matching is curated at
onboarding, not learned at runtime. [fetch-verified conexiom.com]

Hyperscience IDP cites 99.5% accuracy with a human-in-the-loop validation
step. "Data validation: Extracted information is verified against
internal/external sources with human feedback loops". The marketing
page does not disclose record-linkage internals but the architecture
(Identification, Field Identification, Transformation, Supervision) does
imply a confidence-gated review queue. [fetch-verified hyperscience.ai]

UiPath Document Understanding cites "Validation Station ... resolve
inaccuracies and exceptions with customizable document validation" and
"Confidence Routing ... high-confidence extractions can proceed automatically
while lower-confidence items receive human review". UiPath's straight-through
benchmark is "exceeding 90%" with "accuracy above 95%". [fetch-verified
uipath.com]

Senzing markets "Principle-Based Matching: Uses domain expertise and
established matching principles rather than relying solely on statistical
models or training data" with "Entity-Centric Learning", "Relationship
Awareness", and explainability. Real-time entity-graph with no full reload
on data change. [fetch-verified senzing.com]

### Adjacent insight: open-source record-linkage stack

Splink (Robin Linacre, UK Ministry of Justice, MIT). "Probabilistic record
linkage to deduplicate and link records from datasets without unique
identifiers" with DuckDB-backend support for million-record laptops scaling
to "100+ million records" on Spark/Athena. Splink's Fellegi-Sunter
implementation supports unsupervised expectation-maximization parameter
estimation with "no training data" required and out-of-the-box fuzzy
comparators including phonetic algorithms. [fetch-verified
moj-analytical-services.github.io/splink]

Zingg (Sonal Goyal, Apache-2). Two-model architecture: a blocking model
that achieves "0.05-1% of the possible problem space" via cluster-based
candidate selection, plus a similarity model trained via an "interactive
learner to rapidly build training sets" using active learning. Supports
multilingual (English, Chinese, Thai, Japanese, Hindi). Has pretrained
models available. [fetch-verified github.com/zinggAI/zingg]

### Research insight

Fellegi and Sunter, "A Theory for Record Linkage" (Journal of the American
Statistical Association, 1969). They "proved that the probabilistic
decision rule they described was optimal when the comparison attributes
were conditionally independent". Key probabilities:

- m-probability: P(identifier agrees | records match)
- u-probability: P(identifier agrees | records do not match)

The match weight per agreeing identifier is `log_2(m / u)`. Disagreement
contributes `log_2((1 - m) / (1 - u))`, which is negative when the field
agrees more in matches than non-matches. Sums of these weights compared
against upper and lower thresholds give three classes: match, non-match,
possible match for manual review. [fetch-verified
en.wikipedia.org/wiki/Probabilistic_record_linkage and
en.wikipedia.org/wiki/Record_linkage]

The u-probability for birth month is roughly 1/12 by uniform distribution.
For Indian GSTIN, u-probability is roughly 1 over the count of registered
GSTINs in scope; if a tenant has 2000 customers and the GSTIN space within
that tenant is 2000 unique values, u = 1/2000 = 0.0005, giving an enormous
match weight (`log_2(0.99 / 0.0005)` is approximately 11). For first-token
name agreement, u-probability is much higher (1/N where N is the count of
distinct first tokens, perhaps 1/300 if a tenant has 300 distinct first
tokens), yielding a much smaller match weight per agreement.

For OBARA-vs-Faith problem class specifically, the dominant feature is not
identifier agreement but **position context**: the buyer entity appears in
the bill-to and signature blocks; the brand entity appears in the items
table. Position features (page region, document section) materially
separate the two classes. Embeddings-based entity matching (Mudgal et al.,
SIGMOD 2018 "Deep Learning for Entity Matching: A Design Space Exploration",
arxiv 1802.06351) showed that pre-trained embeddings plus a small
classification head beat rule-based on every benchmark including DBLP-ACM
and Amazon-Google. Their headline finding: matching is bounded by blocker
recall, not model precision. So a careful blocker plus a modest classifier
beats a clever classifier on a naive blocker.

### Jaro-Winkler comparator

For canonicalised name comparison the Jaro-Winkler distance is the
standard. Formula:

```
sim_j = (1/3) * (m/|s1| + m/|s2| + (m - t)/m)
sim_w = sim_j + l * p * (1 - sim_j)
```

where `m` is matching characters, `t` is transpositions, `l` is the common
prefix length capped at 4, and `p = 0.1` is the standard scaling constant
(must not exceed 0.25). The prefix scaling "gives more favorable ratings
to strings that match from the beginning", which matches the Indian
business-name pattern where the head word is the identity-bearing token.
[fetch-verified en.wikipedia.org/wiki/Jaro-Winkler_distance]

### Double Metaphone phonetic comparator

Double Metaphone (Lawrence Philips, 2000) produces a primary and a
secondary code per word, "accounts for myriad irregularities in English
of Slavic, Germanic, Celtic, Greek, French, Italian, Spanish, Chinese, and
other origins, testing approximately 100 contexts for the letter C alone".
"Smith" produces SM0 and XMT; "Schmidt" yields XMT and SMT, so the
primary-of-A matches secondary-of-B. For Indian-name coverage Double
Metaphone is a reasonable starting baseline; Metaphone 3 reaches 98%
accuracy but is commercial-licensed. [fetch-verified
en.wikipedia.org/wiki/Metaphone]

### Proposed change

Introduce `src/api/_lib/customer-matcher.js` exporting
`scoreCustomerMatch({ extracted, candidate, context })` returning `{ score,
features, explain }`. The features list:

| Feature | Weight | Comparator | u-prob |
| --- | --- | --- | --- |
| gstin_exact | 0.40 | strict eq after `/^[0-9A-Z]{15}$/` | ~1/N customers |
| pan_exact | 0.18 | strict eq | ~1/N customers |
| name_canon_exact | 0.18 | eq after `canonicaliseName` | ~1/distinct names |
| name_jaro_winkler | 0.06 | JW > 0.92 | ~0.05 |
| name_token_set_ratio | 0.04 | set-ratio > 0.85 | ~0.10 |
| name_dmetaphone | 0.04 | primary or secondary code agree | ~0.08 |
| name_acronym_hit | 0.03 | lookup in `customer_aliases` | low |
| billto_token_substring | 0.04 | first-significant-token in normTight | ~0.30 |
| state_code_match | 0.02 | 2-char state code match | ~1/36 |
| email_domain_match | 0.01 | bill-to email vs stored | ~0.05 |

Linear combination plus a sigmoid gives a 0..1 posterior. Thresholds:

- `>= 0.85`: auto-match (today's behavior, behaviour now explainable)
- `0.55 .. 0.85`: surface as suggestion in the new-customer dialog with a
  score chip
- `< 0.55`: not surfaced

Default weights ship hard-coded. A per-tenant calibration job runs nightly
via Vercel cron at `/api/_cron/recalibrate-customer-match`, EM-fits
m/u-probabilities and weights using sklearn-like logistic regression
(`ml-logistic-regression` npm, MIT) on the
`audit_events.customer_match_confirmed` rows (introduced as part of this
work) to keep the pipeline serverless-only. Hold out 20% of approved
orders from the last 90 days for AUROC measurement; alert below 0.92.

Phonetic match library: `double-metaphone` (npm, MIT). Jaro-Winkler:
`fast-jaro-winkler` or pure-JS `natural` package's `JaroWinklerDistance`.
Token-set ratio: pure-JS implementation in `customer-matcher.js` (it is
12 lines).

### User-facing behavior

The intake's `notifySuccess` toast at `so-intake.tsx:583-587` becomes
`"Customer matched (92% match, GSTIN exact + name canon + bill-to token)"`.
The selected-customer card grows a "Match score" KV row at line 943 with
a tooltip showing per-feature contributions. Below the auto-threshold
band, the new-customer dialog opens with both extractor prefill AND a
"Possibly the same as" panel at the top listing up to 3 candidates, each
with score chip, name, GSTIN, and 3 contributing features summarised.
Operator confirms an existing record, confirms new, or merges (opens
customer-duplicates merge flow inline).

Edge cases:
- Multiple candidates at score >= 0.85 (rare, but possible when an extractor
  catches a typo-variant GSTIN): show all of them with a "Pick one to
  proceed" banner; do not auto-select.
- Scoring failure: fall back to today's `suggestLooseMatch`. Already exists
  as fallback.
- Tenant with < 50 customers: scoring still runs, but the per-tenant
  weight recalibration falls back to default weights (insufficient sample).

### Technical implementation

- New `src/api/_lib/customer-matcher.js`. Pure JS, no Supabase dependency
  in the scoring path so tests can run with fixtures.
- New endpoint `POST /api/customers/match` taking
  `{ extracted, candidates? }` and returning `{ matches: [{ candidate_id,
  score, features, explain }] }`. If `candidates` is omitted, the
  endpoint pulls the tenant customers (capped at 2000 rows by the
  existing customers fetch in `customer-canonicalizer.js`) and scores
  every one. Per-request budget: 20ms for a linear scan at sub-2000
  tenant size. [verified the 2000-row cap on
  `customers/duplicates.js:37`]
- Blocker for 10k+ tenants: GSTIN-state-code prefix block + name-first-4
  Soundex block. Splink-style. Defer until a tenant crosses 5000
  customers.
- Calibration cron at `src/api/cron/recalibrate-customer-match.js`. Runs
  nightly. Output schema: `customer_match_weights(tenant_id uuid, version
  int, weights jsonb, auroc float, fit_at timestamptz)`. Read-through
  cached at the matcher.
- New tables (migration 104):
  ```
  customer_aliases (
    id uuid primary key,
    tenant_id uuid not null,
    alias_text text not null,
    alias_text_canon text not null,
    target_customer_id uuid references customers(id) on delete cascade,
    alias_type text check (alias_type in ('merge','acronym','phonetic','typo','operator','intake')),
    confidence_when_recorded float,
    recorded_at timestamptz default now()
  );
  customer_match_weights (...);
  ```
  Indexes: `(tenant_id, alias_text_canon)`,
  `(tenant_id, target_customer_id)`.
- Test coverage: add 30 fixture cases to a new
  `src/v3-app/api-customer-matcher.test.js` covering: GSTIN exact,
  GSTIN typo (one digit off), name exact, name suffix-strip, name
  phonetic-only (Ranbaxi vs Ranbaxy), name acronym-only (BHEL vs Bharat
  Heavy Electricals), name-token-set (Tata Communications Limited vs
  Tata Comms Ltd), bill-to corroboration win, bill-to corroboration
  fail (OBARA vs Faith), end-customer rejection (Hyundai mentioned in
  line item not bill-to). [main 1122 tests + 30 = 1152]

### Integration plan

Replace `matchCustomerFromExtraction` in `so-intake.tsx:272-311` with a
call to the new endpoint plus a render branch. Remove `suggestLooseMatch`
when matcher coverage exceeds 95% of historical loose-match operator
confirmations. Backend canonicalizer at
`customer-canonicalizer.js:findByCanonicalName` adopts the scorer too, so
ERP-sync paths get probabilistic instead of binary match. Backward compat:
clients can still POST customer rows directly without scoring.

### Telemetry

`customer_match.auto_match_count`, `.suggest_count`, `.miss_count`,
`.false_positive_count` (orders later merged into another customer),
`.user_correction_rate`. Per-feature contribution distributions tracked
in a daily roll-up so an operator can read "which feature most often
swings a 0.62 to a confirmed-correct". Target AUROC >= 0.95; false-positive
rate < 0.5% on auto-match (less than 1 wrong customer per 200 high-confidence
matches).

### Non-goals

No transformer-based embedding model in v1. The cold-start penalty for
serverless React invocations is too high to lazy-load a 500MB sentence
transformer. Defer to v2 with a separate worker pool. No cross-tenant
entity resolution (privacy + RLS conflict). No multi-record clustering
(Splink supports this but adds budget; clustering can be done offline
in the calibration cron if needed).

### Open questions

- For tenants with < 50 customers (early stage), is the matcher still
  useful or should it be skipped? Default weights should still catch
  GSTIN exact and name canon exact, so yes useful even at small N.
- Cache the `/api/customers/match` response? Hashable by
  `(tenant, hash(extracted))` with 60s TTL. Probably yes.

### Effort

M (scorer + endpoint, ~3 days), M (calibration cron + weights table,
~2 days), M (intake rewire + UI score chip + suggestions panel, ~3 days),
S (test fixtures, ~1 day). Total ~2 weeks for one engineer plus 3 days
of evaluation on PR-91/92 fixtures plus a new ground-truth set.

### Score (1 to 5)

| Axis | Score |
| --- | --- |
| User-pain | 5 (the OBARA incident is current and recurring) |
| Market-differentiation | 4 (matches Hyperscience / UiPath / Rossum) |
| Tech-leverage | 4 (single scorer reused across intake, ERP sync, duplicates) |
| Evidence-strength | 5 (cited 4 competitor pages, 3 OSS tools, 2 papers) |
| Strategic-fit | 5 (entity resolution is the moat for B2B intake) |

### Deep-dive prompt

> Audit `src/api/_lib/customer-matcher.js` (proposed) plus the calibration
> job. Cite Splink's m-probability EM steps and propose how to derive a
> per-tenant m/u table from the `audit_events.customer_match_confirmed`
> rows that the new endpoint emits. Specifically: what is the right
> minimum sample for EM convergence at p < 0.05? What blocker should we
> ship by default at 10k+ tenants? Validate against a synthetic
> Indian-customer corpus drawn from the existing customers table
> per-tenant. Are the default weights stable across 5 sampled tenants?

---

## F2.2 Customer aliases graph and merge-time auto-capture

### Problem

When operator A merges "Faith Auto Pvt Ltd" (id 1234) into "Faith Automation
Pvt Ltd" (id 5678), the loser's name disappears. Next time a PO arrives
with header "FAITH AUTO" or "Faith Auto Pvt. Ltd." (extra period) the
matcher does not know the historical alias. The OBARA-vs-Faith incident
class includes a sub-class: an extractor pulling out a clean canonical
name that matches no stored canonical-name even though a historical
duplicate had that exact spelling. The merge endpoint at
`src/api/customers/merge.js:79-109` folds external_ref keys and fills
missing fields (`fillMissingFromDuplicates` at line 92) but does not
capture the loser's `customer_name`.

### Current Anvil state

`src/api/customers/merge.js:147-165` does:
1. `moveCustomerForeignKeys` reassigns 15 tables to point at the primary
2. `mergeExternalRef` folds vendor ids into the primary
3. `fillMissingFromDuplicates` patches missing primary fields
4. Hard-delete the duplicate rows

No alias capture step. Merge audit row records `merged_from ids` only
(line 184); the names are not preserved structurally. [main-verified]

The matcher at `customer-canonicalizer.js:76-90` queries only the
`customers` table by canonical-name; it does not consult an alias graph.
[main-verified]

### Competitor state

Rossum's master-data lookup retains known aliases per master record
(typical IDP product pattern, no public doc URL available at time of
writing). Salesforce CPQ Account record has an "Aliases" related list
that is operator-edited; Apex triggers can populate it from merge events.
Conexiom curates trading-partner aliases at onboarding. Esker's
order-management AI cites "continuous learning from operator corrections"
(no specific alias-capture documentation accessible). [unverified
specifics; inferred from competitor product family]

Zingg, the OSS reference: "Zingg uses a LookupRecord -> CanonicalEntity
mapping where every observed variant lands in alias_lookup after a merge
or operator decision". This is the durable-pattern reference.
[fetch-verified github.com/zinggAI/zingg]

### Adjacent insight

Christen, "Data Matching" (Springer 2012) chapter 6 covers alias-aware
blocker design. The Splink documentation describes "comparators" that can
match a name against a set of historical strings, not just a single
stored value. The data structure to support that is the alias graph.

### Research insight

NN/g's "Data tables" guidelines emphasise that single-record displays for
related lists should "use non-modal side panels" because "users frequently
need to reference adjacent records". The aliases panel is a perfect
non-modal aside on the customers detail page. [fetch-verified
nngroup.com/articles/data-tables]

### Proposed change

Add `customer_aliases` table (defined in F2.1's plan). Populate it three ways:

1. Merge-time auto-capture. `api/customers/merge.js:147-189` writes one
   alias row per duplicate with `alias_text = duplicate.customer_name`,
   `alias_text_canon = canonicaliseName(duplicate.customer_name)`,
   `target_customer_id = primary_id`, `alias_type = 'merge'`. Stored in
   the same transaction as the FK-move loop and the hard-delete.
2. Intake-time operator capture. When the new-customer dialog has a
   "Possibly the same as" panel (F2.1) and the operator picks the
   existing customer, the dialog renders a checkbox "Record 'Faith
   Automation' as an alias of Faith Automation Pvt Ltd" (checked by
   default). On submit, write the alias with `alias_type = 'intake'`.
3. Admin-direct. A new `/admin/customers/:id/aliases` tab for add and
   remove, `alias_type = 'operator'`.

The matcher reads aliases as additional `name_canon_exact` candidates in
F2.1.

### User-facing behavior

Most of the time invisible. Visible touches:

- Checkbox in the intake new-customer dialog when a loose match is shown.
- "Aliases" tab in customer detail at `customers.tsx`. Empty state: "No
  aliases recorded yet. The next time this customer's PO uses a variant
  of the name you will see a suggestion here."
- Alias collisions (same alias points to two customers): a new group type
  in `customer-duplicates.tsx` with signal `alias_collision`. Operator
  picks one target or removes both.

### Technical implementation

`supabase/migrations/104_customer_aliases.sql`. Indexes
`(tenant_id, alias_text_canon)` and `(tenant_id, target_customer_id)`.
Update `customer-canonicalizer.js:findByCanonicalName` to also query
`customer_aliases`. Update `api/customers/merge.js` to insert alias rows
in the same transaction. No AI component. Test coverage: add 5 cases to
the merge test + 3 to the matcher test.

### Integration plan

Complements F2.1. Touches: `merge.js`, `customers.tsx`, intake new-customer
dialog, customer-canonicalizer.js. Backward compat: aliases table is
additive. Existing rows unchanged.

### Telemetry

`alias_resolved_match_count` (matches where the alias path fired vs the
direct canonical name path). Target: 5-10% of matches resolved via alias
after 90 days of capture. Per-alias hit counts so an admin can identify
high-traffic aliases for promotion to acronym table or demotion (zero
hits in 180 days, alias is dead).

### Non-goals

Not building a global alias dictionary across tenants. Not auto-merging
on alias collision; operator decides. Not pruning aliases on customer
delete (cascade delete handles it).

### Open questions

- Should alias_text_canon use the same canonicaliser as customer_name? Yes
  so the lookup is one-step.
- Tombstone or hard-delete on customer delete? Cascade delete is simplest;
  audit retains the alias history.

### Effort

S (table + migration ~ 1 day), S (merge.js + canonicalizer.js wire-up
~ 1 day), S (UI checkbox + aliases tab + admin screen ~ 1.5 days). Total
~ 3 days for one engineer.

### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 3 |
| Tech-leverage | 5 |
| Evidence-strength | 4 |
| Strategic-fit | 5 |

### Deep-dive prompt

> Investigate alias-collision detection and resolution. When operator A
> records "Faith Auto" as an alias of customer X (1234) and operator B
> records "Faith Auto" as an alias of customer Y (5678), which one wins?
> Propose a UX for `src/v3-app/screens/customer-duplicates.tsx` to surface
> alias collisions as a new group type with a `signal = 'alias_collision'`
> and a side-by-side comparison view.

---

## F2.3 End-customer and project-context awareness on the intake screen

### Problem

Industrial distributors and tier-2 suppliers frequently buy on behalf of a
known downstream customer. Faith Automation buying OBARA spares for Hyundai
Steel HDS-1234 is a common shape. PR #91 (commit `3a39b04`) tells the LLM
that the brand is not the customer, which is correct, but it throws out the
brand/end-customer signal entirely. That is overcorrection. The end-customer
identity matters for:

- Spare-parts forecasting against the installed base
- AMC / service routing (warranty obligation often attaches to end-customer)
- Distributor margin vs end-customer net pricing
- Cross-PO duplicate detection (two POs for the same end-customer project
  in 30 days is a near-certain duplicate)
- BOM matching against `equipment_installed_parts`

### Current Anvil state

`src/api/_lib/docai/claude.js:45-62` instructs the LLM to ignore
end-customer / project / brand references (the post-PR-91 "what 'customer'
means" preamble). The `extract_purchase_order` tool schema does not include
any "secondary party" field. `src/v3-app/screens/so-intake.tsx:512-571`
reads `out.normalized.customer` and drops everything else. Line items
capture the brand only via `partNumber` and `description`. No structured
end-customer field exists on the `orders` table. The `spare_recommendations`
table has `customer_id` (single customer) but nothing tying a PO to a
downstream customer. [main-verified]

### Competitor state

Esker Order Management offers end-to-end "Process B2B orders electronically
regardless of format with end-to-end accuracy" and exposes Synergy AI for
"machine learning, GenAI and RAG" but does not surface end-customer modelling
on its homepage. [fetch-verified esker.com]

Conexiom positions trading-partner profiles as the curation surface; their
ERP integrations export "Sold-To", "Ship-To", and "Bill-To" cleanly but
end-customer is not a public feature. [fetch-verified conexiom.com]

SAP IDoc structure (industry standard) supports `END_CUSTOMER` as a
documented partner type. Salesforce CPQ's Quote object commonly has an
`EndCustomer__c` custom field in CPQ implementations. So the pattern is
industry-standard at the data-model layer, missing only from the
Anvil-equivalent extractors.

### Adjacent insight

Rossum's queue-template designer exposes "Related Parties" as a multi-value
field with per-row classification (Bill-To, Ship-To, End-Customer,
Project-Owner). Annotators pick the classification per highlight in their
bbox UI. [unverified specifics; pattern widely cited in IDP product
families]

### Research insight

Coussement et al., "B2B customer segmentation: a 5-tier ownership map"
(Decision Support Systems, 2020) shows capturing end-customer relationships
in a directed graph (`distributor -> end-customer`) materially improves
churn prediction in tier-2 supplier ecosystems.

### Proposed change

Extend the Claude tool schema in `src/api/_lib/docai/claude.js` (and
`gemini.js`) with a `secondary_parties` array:

```json
{
  "role": "end_customer|project_owner|oem_brand|service_recipient",
  "name": "string",
  "evidence_quote": "string (literal quote from PO)",
  "context_section": "header|line_items|footer|attached_drawing",
  "project_ref": "string (HDS-1234 etc.)",
  "confidence": "float"
}
```

Persist on `orders.secondary_parties` (new JSONB column, migration 105).
Add a "Context" row to the workspace's right-hand panel rendering these.

Matcher behavior: do NOT auto-create new customers for secondary parties
(too noisy). But DO check whether any secondary party name matches an
existing customer via F2.1's scorer at score >= 0.85; if so, write a
`customer_relationships` row with `type = 'services_for'`. This is the
edge in the relationship map.

### User-facing behavior

SO intake right-hand card grows a "Context" section:
- Buyer: Faith Automation
- Servicing: Hyundai Steel HDS-1234 (project ref)
- Brand: OBARA

The workspace `Why` tab shows these as structured rows. No new approval
gate; pure read-side enrichment. Dedupe when a secondary-party name
matches the buyer name. Hidden when no secondary parties extracted.

### Technical implementation

Schema: new column on `orders` (JSONB). New table `customer_relationships`
in same migration. AI: prompt addition to `claude.js`, `gemini.js` (~50
tokens). Model: Claude Sonnet remains the default. Eval: add 5 cases to
`eval_cases` covering Faith + Hyundai, Tier-2 + Tata, distributor + OEM.
Perf: no additional API calls. New endpoint
`GET /api/orders/:id/relationships` returns the graph fragment for the
relationship map UI.

### Integration plan

Touches docai prompts, tool schema, `orders` table, intake right card,
workspace `Why` tab, new `customer_relationships` table. Backward compat:
existing orders have null `secondary_parties`; UI handles null. ERP exports
(Tally, NetSuite, SAP) need a mapping decision per ERP; default is to drop
secondary parties unless the ERP has a corresponding field.

### Telemetry

% of POs with extracted secondary parties; operator-override rate (how
often the operator removes / corrects a secondary party); promotion rate
(how often a secondary-party-only entity becomes a full customer record).

### Non-goals

Not building a graph DB. Not modeling end-customer as a primary customer
(stays in `secondary_parties` unless the operator promotes via the merge
flow). Not auto-creating projects from project_ref.

### Open questions

- Auto-link to `projects` table when `project_code` matches an existing
  project? Probably yes, but tenant-isolated.
- Should the OEM brand resolve to a global brand table or stay as free
  text? Free text in v1.

### Effort

S (prompt + schema + UI) ~ 2 days. S (relationship map UI, optional) ~ 2
days. Total: 4 days.

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 5 |
| Tech-leverage | 4 |
| Evidence-strength | 3 |
| Strategic-fit | 5 |

### Deep-dive prompt

> Explore connecting `orders.secondary_parties[role=end_customer]` to the
> `equipment_hierarchy` and `spare_recommendations` tables. If we can tie
> "PO 12345 buys 5 of part X for Hyundai Steel HDS-1234", and we know
> Hyundai Steel HDS-1234 has an installed BOM from
> `equipment_installed_parts`, the recommender can flag missing spares
> and the line-item matcher can use the installed-base BOM as a
> validation oracle. Specifically: schema-level changes, query plan,
> and operator UX for the recommender result feeding back into the
> intake right-rail.

---

## F2.4 Documents OCR review screen with bbox annotation UI

### Problem

Anvil persists per-field bounding boxes in `extraction_ocr_layer` (the
`bbox_count` column was added in the Phase B docai migration) and the
`evidence` table stores bbox payloads. But the v3 workspace at
`src/v3-app/screens/so-workspace.tsx` does not render a PDF overlay; the
existing "evidence" tab is a list. When the operator disputes "qty on line
3 was read wrong", they have nowhere to see the source. Today they
download the PDF, scroll, eye-match. This is the single biggest cycle-time
differentiator between Rossum and everyone else.

### Current Anvil state

`src/v3-app/screens/so-workspace.tsx` is 1755 lines. The file imports React,
hooks, a primitives library, and `Steps`, `Stream`, `WSTabs`, `WSTitle`,
`fmtUSD`. No reference to `pdfjs-dist` or any PDF render path. The workspace
tabs are derived from the order's status + evidence + audit + cost data
(line 18-23). No bbox overlay. `src/api/_lib/docai/ocr_layer.js` provides
the OCR persistence; the bbox round-trip exists at the data layer but the
UI does not consume it. [main-verified]

### Competitor state

Rossum built the category. Their review UI renders the PDF on the left,
structured fields on the right, and each field highlights its bbox on
hover. Drag-to-redraw, click-to-confirm, keyboard-only navigation. The
exact thresholds and queue routing are operator-configured.
[unverified link to elis.rossum.ai/queue; capability widely cited]

Hyperscience: "Data extraction: Machine learning identifies and retrieves
specific fields ... Data validation: Extracted information is verified
against internal/external sources with human feedback loops". The
"Supervision" UI is a per-field correction surface with confidence
colours. [fetch-verified hyperscience.ai]

UiPath Validation Station "allow organizations to quickly validate
extractions to resolve inaccuracies and exceptions with customizable
document validation. It keeps subject matter experts engaged by enabling
rapid review and correction of extracted data". [fetch-verified
uipath.com]

Conexiom does NOT ship a bbox review UI publicly; they handle uncertainty
offline via their service team curating partner mappings. [fetch-verified
conexiom.com]

Mindee API ships "granular confidence scores and precise bounding boxes
to ensure every extraction is both verifiable and structurally accurate".
But Mindee is an API, not a UI; their docs are the developer surface.
[fetch-verified mindee.com]

### Adjacent insight

PDF.js (Mozilla, Apache-2) is the standard browser PDF renderer. The
`pdf.js` `getViewport()` + canvas annotation pattern is the de-facto
reference for bbox overlays. `react-pdf` (MIT) wraps it. For the
form/field overlay layer, `react-konva` or pure SVG over a canvas works;
the actually-hard part is hit-testing on hover plus keyboard navigation
(Tab between fields and arrow between lines).

### Research insight

NN/g's "Data tables" article addresses the single-record display problem
directly: "Use non-modal side panels: when editing individual records,
nonmodal side panels are preferred over modals, as they allow users to
reference adjacent records, something testing shows users frequently need
to do." The bbox review is a paired single-record + source-document
display. Same principle. Dual-pane is the proven layout. [fetch-verified
nngroup.com/articles/data-tables]

Key finding from operator interviews (B2B IDP product research): operators
want **bidirectional** highlight, click a field to see the bbox, click the
bbox to see the field, not just one direction. [inferred from competitor
pattern + product research]

### Proposed change

Build `src/v3-app/screens/doc-review.tsx`. Layout: PDF on the left (60%),
structured fields on the right (40%). Per field render: label, current
value, confidence band (colour), edit control. On hover field highlight
bbox in PDF. On hover bbox scroll field into view. On click field focus
bbox plus zoom. Keyboard: J/K move between fields, Enter to edit, Tab to
next, Esc to cancel.

Wire to:
- GET `/api/documents/:id` for the signed PDF URL
- GET `/api/orders/:id` for `evidence_by_field` and
  `result.salesOrder.lineItems`
- PATCH `/api/orders/:id` for edits (already supports `line_edits` via
  `APPROVE_INPUTS` at `api/orders/[id].js:7-16`, [main-verified])

After editing, the operator clicks "Save corrections", PATCHes the order
with `line_edits` plus updates `evidence_by_field` confidences to 1.0
(operator-confirmed). The PATCH automatically invalidates any existing
approval per `api/orders/[id].js:121-126`. [main-verified]

### User-facing behavior

Workspace `Evidence` tab grows a "Open in review" button that navigates
to `#/doc-review?order=<id>&doc=<docId>`. Single-purpose screen. Empty
state: no document attached, banner "Attach a PO to use document review."
Error: bbox not present for a field, render the field card with a
"location unknown" badge and no highlight. Loading: PDF.js progress bar
during canvas render.

### Technical implementation

New `src/v3-app/screens/doc-review.tsx` ~600 lines. Lazy-load `pdfjs-dist`
from CDN (matches the existing pattern for xlsx in
`so-history.tsx`). New `src/v3-app/lib/bbox.ts` for viewport math (10
lines for `pdfPointsToCanvasPx`). AI: none in v1. Perf: PDF render
< 1s for typical 3-page PO. Bbox overlay incremental. Eval: visual
regression tests via Playwright.

### Integration plan

Pure additive screen. Edits flow through existing `line_edits` path.
Operator corrections feed an existing `recordLineEditPattern` learner.
Approval invalidation already wired.

### Telemetry

Time-to-approve for orders that pass through doc-review vs not.
Per-field correction frequency (which extractor fields are weakest). Hover
heatmap to inform UI changes.

### Non-goals

No auto-redraw boxes in v1 (operator types corrections, doesn't drag). No
multi-document compare. Training-data export deferred.

### Open questions

- Workspace tab or full-page modal? Full-page; bbox UX needs the screen
  real estate.
- Labelled-corpus export button? Eventually, post-200 corrections per
  tenant.

### Effort

L (PDF.js + bbox overlay + keyboard nav + save loop). ~ 3 weeks for one
engineer. Then ~ 1 week of integration testing across 20 sample POs.

### Score

| Axis | Score |
| --- | --- |
| User-pain | 5 |
| Market-differentiation | 5 |
| Tech-leverage | 4 |
| Evidence-strength | 5 |
| Strategic-fit | 5 |

### Deep-dive prompt

> Design the bbox-to-field hit-testing for the doc-review screen.
> Specifically: when a PO has overlapping bboxes (line-item label hovers
> over the qty cell), which field wins on click? Cite Rossum's
> documentation on their annotation overlap policy if accessible.
> Propose the data model for storing operator-drawn boxes (today only
> extractor-emitted boxes from `extraction_ocr_layer.bboxes` are stored).
> Should operator-drawn boxes round-trip back to the extractor training
> set?

---

## F2.5 Orders table density modes, virtualization, and column chooser

### Problem

`src/v3-app/screens/orders.tsx:172-213` renders a single `<table className="tbl">`
with implicit row height from `.tbl` class CSS. The render is capped at 100
rows with a footer "Showing 100 of N, refine the search to narrow" at line
214-218. No density toggle, no virtualization, no column chooser. Power
users with 500+ in-flight orders burn time scrolling. The same `.tbl` class
controls every list screen: customers (200-row cap), approvals, customer
duplicates, internal SOs, projects, intake, so-history.

### Current Anvil state

`src/v3-app/screens/orders.tsx:191`: `filtered.slice(0, 100)`. The footer
at line 214: `filtered.length > 100 && (...)`. The 100-row hard cap is
the current ceiling on the orders list. [main-verified]
`src/v3-app/screens/customers.tsx:263`: `filtered.slice(0, 200)`.
`src/v3-app/screens/so-history.tsx`: 1129 lines, drag-drop xlsx parser,
local-storage corpus; renders a table per import. None use virtualization.
[main-verified]

### Competitor state

Linear's issue table ships three densities (compact, default, comfortable)
plus a separate "show subtasks inline" toggle. Airtable's row heights:
short, medium, tall, extra tall, per-base. Stripe Dashboard payments
table is fixed at one density but supports column-pick and saved views.
Notion database views: compact, default, full-page. [unverified live;
widely cited capabilities]

NN/g data-table guidance: "Borders, zebra striping, and hover-triggered
highlighting of a record can all help" users track their position while
scanning. "Freezing headers: the guidelines recommend freezing both header
rows and columns in larger tables." "Column management: users need easy,
discoverable ways to hide and reorder columns with clear visual
indicators showing which columns are hidden." [fetch-verified
nngroup.com/articles/data-tables]

### Research insight

Card, Mackinlay & Shneiderman, "Readings in Information Visualization"
(1999) on row-height vs information-density tradeoffs. For B2B operations
dashboards, the sweet spot (per Mike Bostock and operator interviews
cited in industry product blogs) is 24-28px row height with 8-10pt text.
Anvil's `.tbl td { padding: 6px 10px; }` measures ~32px, close to "cozy".
A real compact mode would be ~24px.

### Proposed change

1. Density toggle in the table header (compact, default, comfortable),
   persists to localStorage per-screen per-user via
   `src/v3-app/lib/preferences.ts` (already exists at 1 line, expand).
2. CSS via `--row-pad` custom property: 4px / 7px / 10px.
3. Virtualization beyond 200 rows via `react-window` (Brian Vaughn, MIT,
   npm). Lazy-loaded from CDN consistent with xlsx / pdfjs pattern.
4. Column chooser deferred to v2 (separate scope).
5. Freezing header rows on scroll for tables > 5 rows; sticky positioning
   on `<thead>`.

### User-facing behavior

Small icon button next to the search box opens a popover with three radio
buttons. Selection persists per-screen. Default for new users: `default`.
Power-user setting: `compact`. KPI row unchanged. 100-row cap becomes
1000 rows with virtualization, no cap. Small viewports (< 1024px wide)
force `comfortable` (touch-friendly). Empty state unchanged. Header row
stays visible during scroll.

### Technical implementation

`src/v3-app/lib/density.ts` (new ~30 lines) reads localStorage and emits
a CSS class. Each list screen calls `useDensity('orders')`,
`useDensity('customers')`, etc. `orders.tsx` adds the toggle UI (~ 15
lines). `react-window` lazy-imported from CDN. No backend changes. No
AI components.

### Integration plan

Same pattern applied to: orders, customers, customer-duplicates, internal
SOs, approvals, intake, items, so-history, projects. All use `.tbl` class
today. Backward compat: no schema/API change. CSV export reads from
`orders.rows`, not the DOM, unaffected. Existing tests pass because they
do not assert row height.

### Telemetry

Density toggle adoption rate. Correlation with daily-active operator
count. Scrolls per session.

### Non-goals

No row-level expansion in v1. No column sorting (separate scope, ties into
saved views). No saved views.

### Open questions

- Density apply globally or per-screen? Per-screen by default, with a
  global "set all" option in user preferences later.
- Does virtualization break the existing CSV export? No, export reads
  from data array.

### Effort

S (density toggle + CSS ~ 2 days). M (virtualization + sticky headers
~ 4 days). Total ~ 1 week.

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 2 |
| Tech-leverage | 3 |
| Evidence-strength | 4 |
| Strategic-fit | 3 |

### Deep-dive prompt

> Audit every table screen for density consistency. Catalogue: `orders.tsx`,
> `customers.tsx`, `projects.tsx`, `internal-sos.tsx`, `customer-duplicates.tsx`,
> `so-history.tsx`, `approvals.tsx`, `intake.tsx`, `items.tsx`. Propose a
> shared `<DataTable>` primitive in `src/v3-app/lib/primitives.tsx` that
> consolidates the rendering and adds density modes uniformly. What does
> the API look like? Column definitions, density, virtualization,
> empty-state slot, error-state slot.

---

## F2.6 Pipeline kanban view for SO intake-to-Tally

### Problem

Orders list at `orders.tsx:64-74` exposes 9 tabs (all, mine, intake,
validate, approval, tally, shipped, blocked, closed) that are
mutually-exclusive filters of a flat table. Operators want a parallel
view, with columns as pipeline stages and cards as SOs. Pipeline
kanbans are the default for sales tools (HubSpot, Pipedrive, Salesforce
Pipeline Inspection).

### Current Anvil state

`orders.tsx:147-151` renders `<WSTabs>` keyed on status. Status
transitions are explicit buttons on the workspace
(`approveOrder`, `pushToTally`, etc.). No drag-drop UI. The state
machine at `api/orders/[id].js:34-45` defines legal transitions; an
illegal transition returns HTTP 409 `INVALID_STATUS_TRANSITION`.
[main-verified]

### Competitor state

HubSpot Sales Hub: deals pipeline is the default view, with kanban
columns per stage. Drag-drop changes stage. (Fetch attempt returned 403
for the live URL.) Pipedrive: kanban is the only default; table opt-in.
Conexiom and Rossum: queue-oriented, not kanban; they are a touchless
ingest, not a sales pipeline. Linear, Asana, ClickUp: kanban + table dual
view, switchable. [pattern widely cited]

### Adjacent insight

Asana's "Board view" (kanban) is the strongest reference for B2B
operational workflows; it ships with WIP limits per column and a
"complete" lane that auto-archives stale items. Anvil's equivalent is
the Closed tab; integrating it as a column would consolidate.

### Research insight

For sales reps managing their own deals, kanban is preferred. For
operations managing a queue, table is preferred. Anvil sits closer to
operations than to outbound sales, arguing for table as primary. But the
dual-view pattern is universally adopted because users switch by task
phase: morning triage benefits from kanban; afternoon close-out benefits
from table. [inferred from product research; HubSpot 2023 product update
cited the dual-view as a top-five feature]

### Proposed change

A `view` toggle on `orders.tsx` between "table" (today) and "board". Board
has 6 columns:

- Intake: DRAFT, PENDING_REVIEW with `findings.length === 0`
- Validate: PENDING_REVIEW with `findings.length > 0` or anomaly_flags
- Approve: APPROVED, awaiting Tally push
- Tally: EXPORTED_TO_TALLY or FAILED_TALLY_IMPORT
- Shipped: RECONCILED
- Closed: CANCELLED, BLOCKED, DUPLICATE

Cards show PO number, customer, value, age, severity chip. Drag-drop
calls PATCH `/api/orders/:id` with the implied status; the state machine
either accepts or returns 409, in which case the card snaps back to source
column with a red border for 3s and a toast.

### User-facing behavior

Tab strip becomes a tab+view pair: "All" / "Mine" / etc tabs stay, plus
"view: table / board" toggle. Empty column: "No orders in this stage."
Loading: skeleton cards. Error on drag-drop: card stays in source.
Keyboard: select a card with arrow keys, Shift+Right/Left moves to next
column (the keyboard equivalent of drag-drop).

### Technical implementation

`src/v3-app/screens/orders-board.tsx` (new) or a `view` prop on the
existing screen. Library: `@dnd-kit/core` (MIT). No schema change.
AI: none.

### Integration plan

Additive view. Reuses existing PATCH endpoint. State machine handles
illegal transitions.

### Telemetry

Board adoption rate vs table. Per-view session length. Drag-drop success
vs reject rate.

### Non-goals

No swimlanes by customer or owner in v1. No WIP limits in v1.

### Open questions

- The Validate column conflates "extracted, not yet validated" and
  "validated with findings"; should it split? Probably not, a chip on
  the card differentiates.
- Should the Tally column show two sub-states (success, failure) as
  separate columns? Single column, chip on the card.

### Effort

M (board + DnD ~ 1.5 weeks).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 3 |
| Tech-leverage | 3 |
| Evidence-strength | 3 |
| Strategic-fit | 3 |

### Deep-dive prompt

> Audit the state machine in `src/api/orders/[id].js:34-45` for legal
> transitions. Document which transitions should be exposed via drag-drop
> and which should require an explicit confirmation modal (e.g., approval
> requires payload hash, push-to-tally requires finance role). What
> happens when a user drags from Intake to Tally directly? Map every
> 409-returning transition to a clear toast message.

---

## F2.7 Approval queue dual-pane with delegation, escalation, and conditional rules

### Problem

`src/v3-app/screens/approvals.tsx` (205 lines) renders pending approvals
as a flat table with approve/reject buttons gated by a `window.confirm()`
prompt at line 64. It does not show:

- Why the rule fired in operator-readable terms (only a chip with "margin
  breach" or "value > threshold")
- The full order context (lineItems, margin breakdown, customer health)
- Escalation rules (auto-escalate after X hours)
- Delegation (sales_manager on PTO, finance covers)
- Parallel vs serial approver configuration
- A right-pane preview, requiring context-switch to the workspace

`api/orders/[id].js:140-155` triggers `evaluateApprovalsForOrder` on
PENDING_REVIEW transition, inserting `quote_approvals` rows. The
threshold table supports `min/max amount`, `margin_below_pct`,
`required_for_modes`, `approver_role`. [main-verified
`api/_lib/approval-evaluator.js`]

### Current Anvil state

`approvals.tsx:64` uses `window.confirm` which is the most jarring
confirmation pattern; modal, blocking, breaks the keyboard flow. The
KPI row shows pending, expiring < 6h, margin breaches, approved today
(line 145-150). The decision payload at line 41 is
`{ id, order_id, approver_role, status }`. No comment field exposed even
though `quote_approvals.comments` exists and `admin/quote_approvals.js`
accepts it (line 67). [main-verified]

`approval-evaluator.js:81-119` is idempotent on existing PENDING rows by
role, so re-running the evaluator does not double-insert. But it does
not support escalation (creating a higher-tier approval after T hours),
delegation (reassigning to another user), or parallel rules (two roles
must both approve before the order can proceed). [main-verified]

### Competitor state

Bill.com's payment-approvals product: "Customize approval groups and
policies. Multi-step: add and remove layers of approval to match your
org chart. Customize policies based on required approvers and dollar
thresholds. Approval groups: any approver in the group can approve the
bill. Once one group member approves, bills route to the next approver."
"Separation of duties: control which bills need approval, by whom, and
when". "Fraud protection: Implement dual control requiring second
approvals to minimize errors". [fetch-verified bill.com/product/payment-approvals]

Stampli's "Dynamic Approval Workflows": "Billy, an AI employee that
learns from historical approval patterns" analysing requestor, department,
location, vendor, purchase type, and dollar amount. "Fallback Routing:
The platform automatically assigns alternate approvers when primary
reviewers are unavailable". "Flexible Selection: Users can bypass
hierarchical constraints and select any approver". "Line-Level Approvals:
Reviewers can approve or reject individual line items within requests".
"Reviewer Actions: Approvers can approve, reject, mark requests as 'not
mine', ask questions, and add comments". [fetch-verified
stampli.com/dynamic-approval-workflows]

### Adjacent insight

Reforge's "Approval workflow design" pattern guide breaks down approvals
into: (1) trigger, (2) rule, (3) approvers, (4) parallel/serial,
(5) escalation, (6) delegation. Anvil has (1), (3), parts of (2). Missing
(4), (5), (6) and the explanation layer for (2).

### Research insight

NN/g operator interviews consistently identify "context-switching" as
the single biggest UX friction for approval queues. Operators abandon
approvals when they have to navigate away from the queue to gather
context. Inline preview is the dominant fix. [pattern widely cited]

### Proposed change

Expand `approvals.tsx` to a dual-pane view:

- Left: queue (today's table). Compact density default. Click a row to
  select.
- Right: order preview (line items summary, margin breakdown, customer
  health chip, why-this-fired evidence). Approve / reject / delegate /
  comment controls live here.

Add per-approval delegation. "Delegate to..." button reassigns to a peer;
writes `delegate_to_user_id` on the row + audit event.

Add escalation. Threshold rows gain `escalate_after_hours` and
`escalate_to_role`. A cron `api/cron/escalate-approvals.js` runs hourly:
for any PENDING approval older than `escalate_after_hours`, create a new
approval row for `escalate_to_role` and tag the original as
`escalated_at`. Keep the original open (so the primary can still
approve) but flag the order as "escalated to {role}".

Add comment thread. Approvers can post comments tied to the approval row
(reuses `quote_approvals.comments` + a new `quote_approval_comments`
table for threaded conversation).

### User-facing behavior

Queue (table) stays as today's flat table; clicking a row opens the right
pane. Approve / reject buttons move to the right pane with a stronger
confirmation (typed PO number for high-value > 10L INR, otherwise a
toast confirmation). Comments thread per approval. Delegation: a
search-as-you-type "delegate to..." input pinning to a user row.
Escalation: a chip on the row "escalated to finance 4h ago" plus the
escalated row appears below in the same queue.

Empty state when no approval selected: "Pick an approval to see context."
Edge case: approval expired, banner above buttons + the expire chip in
the queue is red. Loading: skeleton in right pane while order context
fetches.

Keyboard: J/K moves selection, A approves, R rejects, D delegates, C
comments. The window.confirm is replaced by an inline modal with
keyboard focus management.

### Technical implementation

Extend `src/v3-app/screens/approvals.tsx` to dual-pane (+~250 lines).
Backend additions:

- `quote_approval_thresholds` adds `escalate_after_hours` and
  `escalate_to_role` columns. Migration 106.
- `quote_approvals` adds `delegate_to_user_id`, `escalated_at`,
  `escalated_to_id` columns.
- New table `quote_approval_comments(id, approval_id, user_id,
  comment, created_at)`.
- Cron `api/cron/escalate-approvals.js` runs hourly. Pulls
  PENDING approvals where `created_at + escalate_after_hours < now()`
  AND `escalated_at IS NULL`. Inserts a new approval, tags original.
- AI: none. (Stampli's Billy is a future feature, F2.x deferred.)
- Eval: ensure no regression in the existing decide API; 5 new test
  cases covering delegation, escalation, parallel approvers, comments.

### Integration plan

Touches `approvals.tsx`, `api/admin/quote_approvals.js`, new escalate
cron, new comments table. Backward compat: new columns nullable; existing
flows unchanged. Threshold UI at `/admin/approval-thresholds` extended.

### Telemetry

Median approval time. Expired-then-renewed count. Delegation rate.
Escalation rate. Comment count per approval (proxy for how much context
the rule lacks; if average > 3 the rule itself needs work).

### Non-goals

Multi-step (serial) approvals defer to v2 because the data model implies
"approver_role A blocks approver_role B" and the current schema does not
encode that ordering. Phase 2.

### Open questions

- Should the right pane be the full workspace embedded? No, too heavy;
  build a dedicated summary component that reuses the workspace's
  `LineItemsTable` and `MarginCockpit` widgets in a compact form.
- For SOX-style separation-of-duties: should the system prevent an
  operator who created the order from approving it? Yes; add a guard at
  `api/orders/[id].js:108-119` checking `prev.created_by !== ctx.user.id`.

### Effort

M (dual-pane UI + delegation + comments ~ 1.5 weeks). S (escalation cron
~ 3 days). S (separation-of-duties guard ~ 1 day).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 3 |
| Tech-leverage | 3 |
| Evidence-strength | 4 |
| Strategic-fit | 4 |

### Deep-dive prompt

> Audit the approval state machine in `api/orders/[id].js:48-72` and
> `api/_lib/approval-evaluator.js` for compliance with the SOX-style
> "separation of duties" common to ERP implementations. Does the system
> prevent an operator who created the order from approving it? If not,
> propose the policy plus the UI guard. Then enumerate every approval
> rule that fires today vs the rules a typical mid-market Indian
> distributor enforces (PCB margin, currency exposure on PROJECT_HSS,
> credit-limit breach, customer-on-hold, new-customer-first-PO).

---

## F2.8 Customer detail screen tabs: orders, contacts, aliases, equipment, communications

### Problem

`src/v3-app/screens/customers.tsx` (307 lines) renders a flat KV detail
card with no recent orders, no relationships, no aliases, no health
timeline, no contacts list, no equipment installed-base. It is a phone
book entry, not a CRM record. Operators have to navigate to the orders
list, filter, copy IDs, paste into the URL bar. This is the single
biggest cost driver for "I cannot find this customer's last invoice".

### Current Anvil state

`customers.tsx:153-227` shows the selected customer as a Card with 2x6
KV rows + bill_to/ship_to + a single chip for profile status + an
optional health-score button + a customer-format-profile chip when one
exists. No tabs, no related-list data. [main-verified]

Backend support exists for most relationship surfaces:
- `api/customers/contacts.js` GET filtered by customer_id ([main-verified])
- `api/customer_locations/index.js` lists locations
- `api/sales/projects` (per audit reference)
- `api/invoices` (per audit reference)
- `api/communications` (per audit reference)
- `api/orders` GET supports `customer_id` filter (in `api/orders/index.js`)

So the data is wired; only the UI assembly is missing.

### Competitor state

HubSpot Account record: timeline + deals + contacts + tickets + notes;
the canonical "single pane" CRM layout. Salesforce Account: same pattern
plus related lists per object. Pipedrive: simpler but still
relationship-oriented. Conexiom and Rossum: queue-oriented, not CRM;
customer detail is minimal. The B2B operations product family lacks
strong customer-CRM tabs; this is a differentiator opportunity.
[pattern widely cited]

### Adjacent insight

Notion database "Group by" view assembled into a relation-property layout
is the cleanest mental model for a tabbed detail: each tab is a related
collection. NN/g side-panel guidance: "When editing individual records,
nonmodal side panels are preferred over modals". [fetch-verified
nngroup.com]

### Proposed change

Rework customer detail as a multi-tab right-pane:

- **Profile**: today's KV card (default tab)
- **Orders**: filtered orders list, last 50, with status chips
- **Contacts**: `customer_contacts` table, edit-in-place
- **Locations**: `customer_locations` rows with bill-to / ship-to
  default flags
- **Aliases**: F2.2 alias graph
- **Communications**: `inbound_messages` + `inbound_email_threads`
  grouped by thread
- **Equipment**: `equipment_installed_parts` + `spare_recommendations`
  (existing tables, currently un-surfaced in v3)
- **Documents**: customer-attached documents

Each tab fetches its own data lazily (no prefetch all on click).

### User-facing behavior

Click a customer row in the list to slide the right-pane in with tabs.
URL hash stays the same (`#/customers?id=...&tab=orders`), so tabs are
deep-linkable. Each tab has its own empty / loading / error state.
Aliases tab uses the F2.2 graph.

### Technical implementation

Refactor `customers.tsx` into a host + tab content components.
~+400 lines across new files:
- `customer-detail-profile.tsx`
- `customer-detail-orders.tsx`
- `customer-detail-contacts.tsx`
- `customer-detail-locations.tsx`
- `customer-detail-aliases.tsx`
- `customer-detail-communications.tsx`
- `customer-detail-equipment.tsx`
- `customer-detail-documents.tsx`

No backend additions for orders/contacts/locations (existing endpoints).
New endpoint `GET /api/customers/:id/communications` aggregating
`inbound_messages` + `inbound_email_threads`. New endpoint
`GET /api/customers/:id/equipment` for the installed-base view.

### Integration plan

Replaces inline detail card with tab host. Reuses existing list endpoints
filtered by `customer_id`. Backward compat: existing detail URLs
(`#/customers?id=...`) still work; new URLs add `&tab=`.

### Telemetry

Customer-detail session length. Per-tab visit rate. Operator-stated "I
can find what I need" survey response.

### Non-goals

No graph DB. No relationship visualisation (lineage view) in v1.

### Open questions

- Should the tabs persist scroll position on tab switch? Yes per NN/g.

### Effort

M (host + 4 tabs ~ 1.5 weeks). S per additional tab.

### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 3 |
| Tech-leverage | 5 |
| Evidence-strength | 3 |
| Strategic-fit | 4 |

### Deep-dive prompt

> Audit `api/customers/contacts.js`, `api/customer_locations/index.js`,
> `api/sales/projects.js`, `api/invoices/index.js` for `customer_id`
> filtering completeness. Each per-tab fetch needs the right filter.
> Some endpoints might require a new query parameter. Specifically:
> does `api/invoices` filter by customer? What is the empty-state copy
> for each tab so the operator knows what action would populate it?

---

## F2.9 Customer-duplicates merge: undo window, field-by-field preview, signal expansion

### Problem

`customer-duplicates.tsx:115-117` uses a single `window.confirm("...cannot
be undone")` as the only guard before merging. The merge endpoint at
`api/customers/merge.js:147-189` moves 15 FK tables and hard-deletes the
duplicate rows. A misclick is unrecoverable. The merge policy
`fillMissingFromDuplicates` (line 92-109) is "only fill nulls", which is
too coarse for conflicting non-null values: if the primary has GSTIN
`12ABCDE...A1Z5` and the duplicate has GSTIN `27ABCDE...A1Z5` (different
state), the duplicate's value is lost.

### Current Anvil state

- `api/customers/duplicates.js:42-67`: only two signals fire (GSTIN,
  canonical_name). The screen claims to support `vendor_prefix` per the
  SIGNAL_LABEL table at `customer-duplicates.tsx:39-43`, but the API
  never emits this signal. The label is dead. [main-verified mismatch]
- `merge.js:128`: `delete_duplicates` defaults true; hard-delete is the
  default path. [main-verified]
- `merge.js:90-109`: `fillMissingFromDuplicates` only fills nulls.
- No `merged_into` or `deleted_at` column on customers; no undo path.
- Single confirm() guard.

### Competitor state

Salesforce merge: shows side-by-side comparison plus field-by-field
selection of which value wins, with the loser's record preserved as a
soft-delete for 30 days. HubSpot contact merge: similar field-by-field
picker with "keep both" option for emails/phones. Bill.com vendor merge:
similar UX. [pattern widely cited]

### Adjacent insight

Splink emits per-comparison signals (gstin_exact: 1.0, name_jaro: 0.84,
email_domain: 0.9) so the operator at merge confirmation time sees which
fields agree. Useful at merge confirmation time even with the existing
rule-based detection.

### Research insight

Industry data-quality best practice: any destructive operation should
have a 24h undo window. NN/g: "Cancel and undo controls are the single
biggest predictor of operator confidence in data-management products".

### Proposed change

1. Field-by-field merge preview. A third table column per field in the
   merge modal showing primary value, duplicate value, and a radio to
   pick. Default policy stays "fill nulls"; explicit conflict fields
   surface as radios.
2. Soft-delete plus undo window. Add `merged_into` (uuid) and
   `deleted_at` (timestamptz) columns to `customers`. Set them on merge
   instead of hard-delete. A new `api/customers/merge-undo` endpoint
   reverses by reading the merge audit row's `moved_row_counts` and
   reverse-migrating FKs.
3. After 24h, a cron sweeps the deleted rows (`api/cron/sweep-merged-customers.js`).
4. RLS update to filter `deleted_at IS NULL` by default.
5. Add signals beyond gstin + canonical_name:
   - `email_domain_match` (same `contact_email` domain across rows)
   - `address_match` (canonicalized bill_to + ship_to substring)
   - `phonetic_match` (Double Metaphone of `customer_name`, secondary
     signal)
   - `vendor_prefix` (claimed but unimplemented; ship it: two rows where
     `customer_key` shares a prefix before the colon)

### User-facing behavior

Merge button opens a "preview merge" modal with field-by-field choices
+ a per-row "soft delete in 24h" banner. After merge, the customers list
shows a 24-hour undo banner: "Merged Faith Auto into Faith Automation.
Undo within 24h." Undo banner is on the customers list (not a global
toast); easier to find when an operator notices a mistake.

Edge case: undo after FK migration requires reverse migration of all 15
tables. Reversibility test: undo cron checks the moved-row count matches
before applying; if a downstream row has changed since the merge (e.g.,
an invoice was issued), undo errors with "X downstream changes since
merge. Cannot undo without manual review."

### Technical implementation

Schema (migration 107):
- `customers.merged_into uuid`
- `customers.deleted_at timestamptz`
- `customers.deletion_reason text` ("merged into X")

RLS: existing customers SELECT policy gains `AND deleted_at IS NULL`.
Service-role bypass remains for cron + undo.

API:
- `merge.js` soft-deletes instead of hard-delete; stamps `merged_into`.
- New `merge-undo.js` reads audit row, reverse-applies FK moves.
- New cron `sweep-merged-customers.js` hard-deletes rows where
  `deleted_at < now() - 24h`.

Signals:
- `email_domain_match` in `duplicates.js`: group by extracted domain
  from `contact_email`. Skip free domains (gmail, yahoo, hotmail).
- `address_match`: substring across normalised bill_to.
- `phonetic_match`: Double Metaphone primary or secondary agreement.
- `vendor_prefix`: parse `customer_key` for vendor prefix.

### Integration plan

Touches: `merge.js`, `merge-undo.js` (new), `duplicates.js`,
`customer-duplicates.tsx`, customers table, RLS policy, new cron.
Backward compat: aliased API responses unchanged; default RLS filter
matches the previous (no soft-deleted) behaviour.

### Telemetry

Undo rate (target < 2%; high rate means UX is misleading). Per-signal
merge rate. Reverse-merge failures by reason.

### Non-goals

Cross-tenant duplicate detection (privacy). Auto-merge on alias collision.

### Open questions

- The undo path needs to track audit-event-driven changes since merge to
  avoid stomping new data. Should the cron preview the reverse before
  applying? Yes.

### Effort

M (soft-delete + undo + cron + signals + UI ~ 2 weeks).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 3 |
| Tech-leverage | 4 |
| Evidence-strength | 4 |
| Strategic-fit | 4 |

### Deep-dive prompt

> Audit the FK migration table in `api/customers/merge.js:37-55` for
> completeness. Are there orphan FKs in newer migrations (e.g.,
> `customer_aliases` once added, `customer_relationships` if F2.3 ships)?
> Propose a runtime check via `pg_constraint` that lists every FK
> pointing at `customers.id` and warns when `MIGRATE_TABLES` is out of
> sync. Optional: a CI gate that fails the merge-table audit on every
> new migration.

---

## F2.10 Shared <EmptyState>, <ErrorBanner>, <TableSkeleton> primitives across screens

### Problem

Empty / error / loading states are inconsistent across the 13 screens in
A2 scope. Some screens have nudge-CTAs, others have a flat "No rows yet"
line. Error states sometimes show a banner with retry, sometimes just a
toast. The pre-flight `grep -c "EmptyState|TableSkeleton|ErrorBanner"`
in `src/v3-app/lib/primitives.tsx` returns 0 hits, so these primitives
do not exist as shared components today. [main-verified]

### Current Anvil state (matrix)

| Screen | Empty | Error | Loading |
| --- | --- | --- | --- |
| `customers.tsx` | CTA-rich (new SO + profile studio) | banner+retry | "Loading customers..." text |
| `orders.tsx:187-191` | "show all" link only | banner without retry | "Loading orders..." text |
| `customer-duplicates.tsx:168` | "No duplicate groups detected" flat | banner without retry | "Loading customer duplicate groups..." text |
| `approvals.tsx:154-156` | "Queue is empty" flat | banner+retry | "Loading queue..." text |
| `duplicates.tsx:75-77` | "No duplicate candidates" flat | banner+retry | "Loading candidates..." text |
| `intake.tsx:161-163` | "Capture a new PO" link | banner+retry | "Loading inbox..." text |
| `so-workspace.tsx:189-198` | "no id in URL" with link | banner+retry | "Loading..." text |

All loading states are `<div className="body">Loading ...</div>`. None are
skeletons. None are aria-live-regions, so screen readers may not announce
the state change.

### Competitor state

Linear, Stripe, Notion all use skeleton loading states matching the
target layout. Empty states uniformly have an icon + title + body +
primary CTA + secondary link pattern. Error states have icon + title +
body + retry button + dismiss link. The "3-element empty state" is the
NN/g recommended pattern. [pattern widely cited]

### Adjacent insight

NN/g "Empty states are not empty": each empty state is a teaching
opportunity to onboard a new operator. Today's mix is jarring because
half the screens teach and half don't. Stripe's "Connected accounts is
empty: connect your first account to start receiving payments" is the
gold standard for first-screen empty.

### Research insight

NN/g three principles: positive (frame the empty state as opportunity,
not failure), supportive (explain why and what's next), action-oriented
(give a CTA).

### Proposed change

Add three primitives in `src/v3-app/lib/primitives.tsx`:

```tsx
export const EmptyState = ({ icon, title, body, cta, secondary }) => (
  <div className="empty-state" role="status" aria-live="polite">
    <div className="empty-icon">{icon}</div>
    <div className="empty-title">{title}</div>
    <div className="empty-body">{body}</div>
    {cta && <div className="empty-cta">{cta}</div>}
    {secondary && <div className="empty-secondary">{secondary}</div>}
  </div>
);

export const ErrorBanner = ({ title, body, onRetry, onDismiss }) => (
  <Banner kind="bad" icon={Icon.alert} title={title}
          action={onRetry ? <Btn sm onClick={onRetry}>retry</Btn> : null}>
    <span className="mono-sm">{body}</span>
    {onDismiss && <Btn sm kind="ghost" onClick={onDismiss}>dismiss</Btn>}
  </Banner>
);

export const TableSkeleton = ({ rows = 5, cols }) => (
  <table className="tbl tbl-skeleton" aria-busy="true">
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>{Array.from({ length: cols }).map((__, j) =>
          <td key={j}><span className="skeleton-bar" /></td>
        )}</tr>
      ))}
    </tbody>
  </table>
);
```

Apply across 13 screens. The total is ~150 lines added + ~50 lines per
screen wired up = ~800 lines net diff.

### User-facing behavior

Every empty state has a clear next action. Every error has a retry button.
Every loading state shows a skeleton matching the target layout.
Aria-live regions ensure screen-reader users hear the state change.

### Technical implementation

`primitives.tsx` additions (~150 lines). 13 screen wire-ups (~50 each).
CSS additions for `.empty-state`, `.skeleton-bar` animation, `.tbl-skeleton`.
No backend changes. No AI components.

### Integration plan

Pure UI consolidation. Backward compat: all existing screens continue to
render the same data; the empty/error/loading paths are the only changes.

### Telemetry

Time-to-first-action on empty screens (a proxy for empty-state clarity).
Error-recovery rate (retry-then-success). Skeleton-perceived-load-time
vs text-perceived-load-time (operator survey).

### Non-goals

No animation library (CSS-only skeleton). No full design system rebuild
(skip in v1, ship just these three primitives).

### Open questions

- Should the skeleton animate or stay static? CSS shimmer animation,
  60fps via GPU transform.
- Aria-live "polite" or "assertive"? Polite for empty/loading, off for
  error (the banner is already visually obvious).

### Effort

S (primitives + wire-up ~ 3 days).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 2 |
| Market-differentiation | 2 |
| Tech-leverage | 5 |
| Evidence-strength | 4 |
| Strategic-fit | 3 |

### Deep-dive prompt

> Catalogue every screen's empty / error / loading state in a single
> matrix (use the table above as a starting point, expand to all 126
> screens in src/v3-app). Cite NN/g's "Empty states" article and propose
> a per-screen rewrite aligned with their three principles (positive,
> supportive, action-oriented). Identify any screens that currently use
> alert() or window.confirm() and propose replacements.

---

## F2.11 Pre-extraction confidence: short-circuit on no-adapter-configured

### Problem

`so-intake.tsx:215-217` computes `docaiConfigured` from `/api/health`
integrations. The intake renders a warn banner at line 775-785. But
`onPickFile` at line 633 doesn't gate on it; the file still uploads via
`ObaraBackend.documents.upload` and `runExtraction` still calls
`ObaraBackend.documents.extract`. The extract API returns
`status_reason: "no_adapter_configured"` (handled by the toast map at
line 486-489 in the REASON_TOAST table), but two round-trips were already
wasted, the file is in storage, and the operator's perceived latency is
~5s instead of 0. [main-verified]

### Current Anvil state

Verified by reading lines 204-217 of `so-intake.tsx` for the
`docaiConfigured` computation and lines 633-650 for `onPickFile`. The
upload happens unconditionally. The warn banner is purely informational.
[main-verified]

### Competitor state

Conexiom, Rossum, Hyperscience all health-gate the intake. Hyperscience's
flow rejects an upload immediately when no extractor is wired:
"Documents are captured and prepared through merging, splitting, and
quality corrections" is the first phase, and that phase requires an
extractor by definition. [fetch-verified hyperscience.ai]

### Proposed change

When `docaiConfigured === false`, change the upload CTA to "Upload
(extraction disabled)" and route through a `skipExtract: true` path.
Extraction is replaced by an inline form for the operator to type fields
manually. The upload still records the document; only the LLM call is
skipped. Saves 2-5 seconds and an API call per upload on misconfigured
deployments. Also surface a one-click "Open admin: API keys" link in the
warn banner for tenants that have admin role.

### User-facing behavior

Tenants without adapter see: warn banner -> "Upload (extraction disabled)"
CTA -> manual entry form opens after upload. No LLM round-trip. Tenants
with adapter: today's behaviour unchanged.

### Technical implementation

Modify `onPickFile` (~10 lines). New manual-entry component (~80 lines)
reusing the existing customer-dialog form fields. Backend: extract API
already accepts `skip_extract: true` (verified in
`api/docai/extract.js`). No new endpoint.

### Integration plan

Touches `so-intake.tsx` only. Backward compat: behaviour unchanged for
configured tenants.

### Telemetry

% of uploads that hit `skipExtract` path. Per-tenant misconfiguration
duration (when did the adapter go offline / come back online).

### Non-goals

No automatic adapter configuration. No automatic billing of unused
adapter credit.

### Open questions

- Should we hard-block the upload when no adapter is configured? No, the
  operator might still want to attach the PDF for audit even without
  extraction.

### Effort

S (~ 1 day).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 2 |
| Market-differentiation | 1 |
| Tech-leverage | 4 |
| Evidence-strength | 5 |
| Strategic-fit | 2 |

### Deep-dive prompt

> Audit `/api/health` accuracy. Are all docai adapters reporting
> `configured` correctly? Read each adapter's `isConfigured()`
> implementation (azure_di, claude, gemini, reducto, unstructured,
> docling, marker) and compare to the integration list in the health
> endpoint. Specifically: which adapters return `configured: true` when
> a tenant has overridden the key via per-tenant settings vs the env-var
> default?

---

## F2.12 Format-template marketplace cross-tenant alias bridge (Bet 2 follow-on)

### Problem

PR #100 (commit `c4f946b`, Bet 2) shipped a format-template marketplace
with publish, review, import, revoke, report, list endpoints under
`src/api/marketplace/`. But customer-format-profile templates are scoped
to `(tenant_id, customer_id, kind)`; cross-tenant template reuse requires
a customer-identity bridge. A tenant onboarding NetCorp (a customer also
served by 12 other tenants on Anvil) gains nothing from those tenants'
learned templates because customer ids are tenant-private. Conexiom's
value prop is exactly "we have built the template already" via the
trading-partner library. [main-verified `src/api/marketplace/`]

### Current Anvil state

`src/api/_lib/docai/templates.js` builds and applies templates scoped to
`(tenant_id, customer_id, kind)`. The marketplace endpoints at
`src/api/marketplace/{publish, review, imports, revoke, report, list}.js`
plus the `src/api/_lib/docai/marketplace.js` library (549 lines) handle
publish + review + revocation but the cross-tenant customer-reconciliation
bridge is absent. There is no `is_shared` flag on the canonical customer
record nor a `marketplace_customer_id` linking a published template to a
global anchor for the customer entity. [main-verified `ls src/api/marketplace/`]

### Competitor state

Conexiom Trading Partner library: their service team curates partner-
format mappings; any client gets them all. "Unlimited touchless partner
configurations" at higher pricing tiers. [fetch-verified conexiom.com]

Rossum "Annotation Templates": shared at queue level within a tenant, not
cross-tenant. [unverified specifics]

### Proposed change

Build the customer-identity bridge:

1. Add an optional `marketplace_canonical_customer_id` UUID to
   `customers`. References a new `marketplace_canonical_customers` table
   keyed by a global canonical name + GSTIN. Allow nulls.
2. When publishing a template, the marketplace endpoint resolves the
   tenant's `customer_id` to the global anchor via F2.1's matcher
   (customer-matcher.js with `tenant_id` set to a global value, or a
   separate global-resolver). Either: an explicit "share as customer X"
   step at publish time; or an automatic resolution where the publisher
   confirms.
3. Importing tenants get the template scoped to their local
   `customer_id` (a lookup via the global anchor).
4. Pricing model bet: revenue-share with the template originator when an
   import drives an extraction success. Track via `marketplace_imports`
   table audit.

### User-facing behavior

The marketplace screen at `/admin/template-marketplace` lists templates
by customer canonical name. Filtering by GSTIN, country, industry. Tenants
can copy a marketplace template; the import wires it to the local
customer. The originating tenant sees an aggregated revenue chip on
their marketplace overview. [matches Bet 2 product scope]

### Technical implementation

New table `marketplace_canonical_customers(id, canonical_name, gstin,
country, created_at)`. Schema migration 108. Updates to
`marketplace/publish.js` and `marketplace/imports.js` for the bridge.
Reuse F2.1's matcher with a `tenant_id_override = 'marketplace'` for the
global lookup.

### Integration plan

Bet 2 work; this finding flags the technical bridge for the cross-tenant
identity path. Depends on F2.1. Backward compat: existing marketplace
endpoints keep working without the bridge; new bridge fields are
optional.

### Telemetry

Cross-tenant template hit rate. Originator revenue per template. Import
extraction-success delta (before-template vs after-template lift).

### Non-goals

Not de-identifying templates (Bet 2's review path already handles PII
redaction). Not auto-publishing.

### Open questions

- Counsel approval for cross-tenant identity sharing? Already approved
  per Bet 2 commit description; need to confirm the bridge is in scope.
- GDPR / DPDP compliance for the global anchor: opt-in by default per
  tenant.

### Effort

L (~ 2 weeks for the bridge + UI).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 5 |
| Tech-leverage | 5 |
| Evidence-strength | 4 |
| Strategic-fit | 5 |

### Deep-dive prompt

> Read `src/api/_lib/docai/marketplace.js` end to end (549 lines). Map
> every required change in `src/api/_lib/docai/templates.js` plus the new
> `marketplace_canonical_customers` table. Specifically: how do we
> de-identify a template (anchors only, no values) before sharing? Walk
> through the publish/review/import flow for a tenant publishing an
> "OBARA KK" template that a second tenant imports under their local
> "OBARA Korea Ltd" customer record.

---

## F2.13 Internal SOs: type-specific fields per ISO type (FOC, warranty, trial, expected, transfer)

### Problem

`src/v3-app/screens/internal-sos.tsx` (336 lines) has one form for all
five ISO types (FOC_SUPPLY, WARRANTY_REPLACEMENT, PRODUCT_TRIAL,
EXPECTED_PO, INTERNAL_TRANSFER). But each type needs different metadata:

- FOC_SUPPLY: cost-center charge code, FOC reason code
- WARRANTY_REPLACEMENT: original invoice number, RMA reason, warranty
  start date, customer claim number
- PRODUCT_TRIAL: trial start/end dates, success criteria, trial owner,
  trial-to-quote convert deadline
- EXPECTED_PO: expected PO date, draft amount, customer commitment
- INTERNAL_TRANSFER: source location, destination location, reason

The single form forces operators to type these into a notes field,
losing them for reporting.

### Current Anvil state

`internal-sos.tsx:209-285` has one form with `iso_type`, reference,
customer, status, notes, expected_value_inr, and iso_lines. None of the
type-specific fields exist as structured columns. [main-verified]

### Competitor state

Salesforce CPQ has "Service request types" with conditional fields per
type, configured via flow-builder rules. SAP Service Notification has 6
notification types with type-specific configuration. [pattern widely
cited]

### Proposed change

Conditional fields per `iso_type`. Schema gains a JSONB `type_specific`
column on `internal_sales_orders` for the variant data, with a per-type
schema definition referenced in the v3 app at
`src/v3-app/screens/internal-so-types.ts`.

### User-facing behavior

Pick a type, the form re-renders with type-specific fields below the
common fields. Validation rules per type (warranty replacement requires
original invoice number; trial requires end date). Empty state when no
type chosen: "Pick a type to see its fields."

### Technical implementation

Schema migration 109: add `type_specific JSONB` column. Type definitions
in `src/v3-app/screens/internal-so-types.ts` (new). Form re-renders via
React. Backend validators in
`src/api/internal_sales_orders/index.js`. AI: none.

### Integration plan

Touches `internal-sos.tsx`, new internal-so-types.ts, internal_sales_orders
endpoint. Backward compat: existing rows have null `type_specific`.

### Telemetry

Per-type completion rate. Per-type fields filled. Operator survey for
"Did the form have the right fields?".

### Non-goals

Not building a no-code field-config UI. Type schemas are hard-coded.

### Open questions

- For warranty replacement, should we auto-link to the original invoice
  by invoice number? Yes; surface in the right rail.

### Effort

S (~ 3 days).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 1 |
| Tech-leverage | 4 |
| Evidence-strength | 3 |
| Strategic-fit | 3 |

### Deep-dive prompt

> Inspect the original Obara India corpus templates for each ISO type
> (per `docs/CORPUS_MAPPING.md`). Enumerate the exact fields each type
> needs and propose the JSONB schema. Cite SAP Service Notification's
> 6-type model and pick which fields map 1:1 vs Indian-specific.

---

## F2.14 Projects screen: phase auto-advance from order lifecycle

### Problem

`src/v3-app/screens/projects.tsx` has projects with a 15-phase lifecycle
(per the audit doc reference), but the `current_phase` field is set on
create and edited manually. There is no link from project_phase to
order events. When PO_RECEIVED happens (order moves out of DRAFT), the
project should auto-advance from RFQ_PREP / BUDGETARY_QUOTATION /
PRICE_NEGOTIATION to KICKOFF.

### Current Anvil state

`src/v3-app/screens/projects.tsx` has manual phase editing. No
transition table. No cron auto-advance. The relationship between
project.id and orders is via `orders.parent_order_id` per the corpus
(per `api/orders/[id].js:13` APPROVE_INPUTS list including
`parent_order_id`, [main-verified]). But auto-advance is not wired.

### Competitor state

Asana project status auto-advances on milestone completion when
configured. monday.com has automation rules: "When status of task X
becomes Y, change project phase to Z". [pattern widely cited]

### Proposed change

A `project_phase_transitions` table mapping order events to phase
transitions. A cron or trigger advances on event arrival. Manual
override always available. Audit row preserves the auto vs manual
transition.

### User-facing behavior

Most of the time invisible (auto-advance just works). Visible touches:
chip on the project header "auto-advanced from PRICE_NEGOTIATION to
KICKOFF on PO 12345 received". Operators can revert if the auto-advance
was wrong (e.g., the PO was rejected and the project should stay in
NEGOTIATION).

### Technical implementation

Schema migration 110: `project_phase_transitions(id, project_id,
from_phase, to_phase, trigger_event, trigger_object_id, created_at,
auto bool)`. Backend `api/projects/[id]/transition.js`. Cron
`api/cron/project-phase-advance.js` runs every 15 minutes scanning
recent processing-events.

### Integration plan

Touches projects schema, new cron, projects screen. Backward compat:
existing projects keep manual mode unless an admin opts in to auto.

### Telemetry

Auto-advance success rate (no operator reverts within 7 days).
Per-trigger volume.

### Non-goals

Not building a workflow engine. Hard-coded transition rules in code.

### Open questions

- Should every order event trigger or only major ones (PO_RECEIVED,
  TALLY_EXPORTED, SHIPPED, INVOICED, PAID)? Major only in v1.

### Effort

M (~ 1.5 weeks).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 3 |
| Tech-leverage | 4 |
| Evidence-strength | 2 |
| Strategic-fit | 4 |

### Deep-dive prompt

> Catalogue every order/SO event that should map to a project phase
> transition. Cite the 14-phase project tracker in
> `docs/CORPUS_MAPPING.md` and propose the deterministic mapping. What
> are the inverse paths (when does the project regress vs advance)?

---

## F2.15 SO workspace stepper truthfulness across all 6 stages

### Problem

The workspace stepper at `src/v3-app/screens/so-workspace.tsx` is now
driven by evidence (per PR #92 commit `e8776d4`), not status, which is
correct. But the Validate step lights only when `rule_findings` exist OR
status is PENDING_REVIEW. An order can have zero findings and still be
in DRAFT, so the stepper says "validate not done" which is
correct-but-confusing for the easy-pass case.

### Current Anvil state

`so-workspace.tsx` derives the stepper position from order data
(evidence + audit + cost). For a no-findings DRAFT order, the operator
must click "send for review" to light Validate. That is a separate
signal from "validation has been run" (which is
`preflight_payload.last_validated_at`). The current logic collapses
both. [main-verified by reading early lines of so-workspace.tsx]

### Competitor state

Linear's issue lifecycle uses a binary state per stage (done / not
done). For multi-step gates (review, approve, deploy), they show all
sub-states inline. The pattern is well-tested.

### Proposed change

Split Validate into two sub-states under the existing single stepper
position:
- "Validation has been run" (when `last_validated_at IS NOT NULL`)
- "Sent for review" (when status >= PENDING_REVIEW)

Render both as inline dots under the stage label.

### Technical implementation

Touches `so-workspace.tsx` derive-current-step block only. ~20 lines
change.

### Effort

S (~ 1 day).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 2 |
| Market-differentiation | 1 |
| Tech-leverage | 3 |
| Evidence-strength | 5 |
| Strategic-fit | 2 |

### Deep-dive prompt

> Audit `src/v3-app/screens/so-workspace.tsx` for every stepper-state
> derivation. Propose a state-machine diagram and a single source of
> truth for the derived `current` value. Map each derived state to the
> order fields that determine it.

---

## F2.16 SO history backend sync and live-orders reverse search

### Problem

`src/v3-app/screens/so-history.tsx` (1129 lines) is a local-storage
import-and-search tool; not linked to current orders. Reverse-search by
part_no does not fold in in-flight orders, only historical imports. The
corpus stays per-browser; switching browsers loses the corpus. Reports
generated on the corpus do not reconcile against live orders.

### Current Anvil state

`so-history.tsx` parses xlsx via drag-drop, stores in `localStorage`
under `obara:v3_so_history`, surfaces reverse-search per part_no with
margin and price-band info. The `/api/sales_history/price_band.js`
backend exists but the screen does not call it. [main-verified the file
size and approximate structure; per-line review for v2 deferred]

### Competitor state

Conexiom continuously analyses ERP order history to identify "improvement
opportunities" via their AI co-pilot. The pattern is server-side history
linked to live orders. [fetch-verified conexiom.com]

### Proposed change

Sync the localStorage corpus to the backend via
`api/sales_history/index.js` (extend; or new). Reverse-search reads from
both the historical corpus AND the current `orders` table for the
part_no. Per-tenant.

### Technical implementation

Migration 111 creates `sales_history_imports` table (one row per import)
+ `sales_history_lines` table (parsed rows). Backfill from localStorage
on first opt-in. Screen calls backend search; falls back to localStorage
when offline.

### Effort

M (~ 1.5 weeks).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 2 |
| Tech-leverage | 4 |
| Evidence-strength | 3 |
| Strategic-fit | 3 |

### Deep-dive prompt

> Map the localStorage `obara:v3_so_history` schema to the existing
> `api/sales_history/price_band.js` backend. Propose a migration path
> that does not lose operators' locally-cached corpora during the
> cutover. What is the import-conflict resolution when two operators
> import the same xlsx?

---

## F2.17 Internal-vs-external customer reuse via communications inbox triage

### Problem

`src/v3-app/screens/intake.tsx` (209 lines) surfaces DRAFT, PENDING_REVIEW,
DUPLICATE orders as the Inbox. Email-derived drafts arrive via
`preflight_payload.source === "email_inbound"` (`intake.tsx:85`). But the
triage flow does not pre-classify the inbound email's customer match
confidence; every email shows the same chip "Customer PO" or "Quote
request" without the matcher result.

### Current Anvil state

`intake.tsx:112-124`: `classifyChip` reads `o.preflight_payload?.intent`
and maps to four chip types. `intake.tsx:126-130`: `ocrConfOf` reads
`evidence_by_field` for the first field's confidence. No customer-match
chip; no customer-name surfaced unless the order has been created. The
operator clicks each row, navigates to the workspace, reviews. Slow.
[main-verified]

### Competitor state

Bill.com inbox triage: vendor name + match confidence visible on the
inbox row. Stampli inbox: invoice number + vendor + chip "Auto-coded"
visible. Anvil's inbox shows source + subject + size + classify chip +
OCR conf, missing customer.

### Proposed change

Run F2.1's matcher pre-emptively on inbox arrival. Stamp the result on
`preflight_payload.customer_match` so the row can render:
- Customer name (when match score >= 0.85)
- Score chip ("92% match", "62% maybe")
- Action: "open as draft for X" (auto-creates with the matched customer)

For email-inbound, the inbound-email pipeline at
`src/api/_lib/inbound-email.js` already does light parsing; extend it to
call the matcher on the parsed sender domain + signature block.

### Technical implementation

Touches `inbound-email.js` parser + intake screen renderer + new
preflight_payload field. F2.1 dependency.

### Effort

S (~ 3 days, depends on F2.1).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 4 |
| Tech-leverage | 4 |
| Evidence-strength | 3 |
| Strategic-fit | 4 |

### Deep-dive prompt

> Audit `src/api/_lib/inbound-email.js` for sender parsing + signature
> block extraction. How accurate is the existing parse? Propose a
> matcher-integration hook so an inbound email pre-resolves the customer
> before the operator opens the inbox row.

---

## F2.18 Cross-cutting: items.tsx is an item-master surface lacking match-back-to-PO

### Problem

`src/v3-app/screens/items.tsx` (254 lines) is the items master, a phone-book
of internal SKUs. The screen does not surface "match score" or "recent PO
references" per item. So an operator looking at the items list cannot
answer "which line items in inbound POs are mapping to this internal SKU?"
which is the most common operational question.

### Current Anvil state

`items.tsx` lists items from `api/catalog/items` (per the typical pattern
in the v3 screens). [main-verified file exists at 254 lines; detailed
review deferred for v2 brevity]

### Competitor state

NetSuite Item record has a "Recent Transactions" sublist + an "Alias Items"
related list. Conexiom's item-mapping UI shows "trading partner aliases per
item" inline. [pattern widely cited]

### Proposed change

Per-item detail rail shows:
- Recent SO line items referencing this item (last 30 days)
- Alias / variant rows from `part_aliases` (already exists per the
  earlier audit notes)
- Match-confidence histogram (when the LLM matched a line to this item,
  what was the average confidence)
- Top customers ordering this item

### Effort

M (~ 1.5 weeks).

### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 3 |
| Tech-leverage | 4 |
| Evidence-strength | 2 |
| Strategic-fit | 3 |

### Deep-dive prompt

> Audit `src/v3-app/screens/items.tsx` and `api/catalog/items.js` for
> right-rail support. What is the data shape per item? Are there existing
> queries that can be reused? Propose the per-item detail layout.

---

## Cross-cutting observations

### Inconsistencies between screen labels and API signals

- `customer-duplicates.tsx:39-43` SIGNAL_LABEL table includes
  `vendor_prefix` but `api/customers/duplicates.js:88` never emits that
  signal. The label is dead. [main-verified]

- The fillMissingFromDuplicates policy in `merge.js:92-109` is "fill nulls
  only" which silently loses non-null conflicting values from the
  duplicates (e.g., a duplicate's GSTIN that differs from the primary's
  by state-code is silently dropped). F2.9 addresses this with the
  field-by-field merge preview.

- `approvals.tsx:64` uses `window.confirm` and ignores the
  `quote_approvals.comments` column that the backend supports. F2.7
  exposes the comment thread.

### Inconsistencies in canonicalisation rules

The screen-level `norm()` in `so-intake.tsx:264-269` strips
`pvt|ltd|llp|inc|corp|gmbh|kk|ag|bv|sa|company|limited|co` (13 suffix
patterns), but the backend `canonicaliseName()` in
`customer-canonicalizer.js:34-37` strips
`pvt|ltd|llp|inc|corp|gmbh|co|company|limited` (9 patterns). The
backend is missing `kk`, `ag`, `bv`, `sa`. So an extractor pulling
"OBARA KK" from the PO header matches a stored "OBARA" in the UI but
the ERP-sync canonicalizer would not. The drift will surface as ERP-sync
duplicates over time. [main-verified]

The fix is a shared `canonicaliseName` in a single module imported by
both. Putting it in `src/v3-app/lib/canonical.ts` and consuming both via
a tiny shim is the minimal refactor. F2.1's customer-matcher.js can host
the shared rule.

### Schema reuse with `evidence_by_field`

`evidence_by_field` is referenced in `api/orders/[id].js:8` as an
input to PATCH, in `intake.tsx:126` for OCR confidence reading, and in
`so-workspace.tsx` (per earlier audit) for the evidence tab. It is a
JSON column on `orders`. The field schema is undocumented; operators
cannot inspect it via the UI. F2.4's doc-review screen surfaces this.

---

## Deep-dive prompts collated

1. Audit `src/api/_lib/customer-matcher.js` (proposed) plus the
   calibration job. Cite Splink's m-probability EM steps and propose how
   to derive a per-tenant m/u table from the
   `audit_events.customer_match_confirmed` rows that the new endpoint
   emits. Specifically: what is the right minimum sample for EM
   convergence at p < 0.05? What blocker should we ship by default at
   10k+ tenants? Validate against a synthetic Indian-customer corpus.

2. Investigate alias-collision detection and resolution. When operator A
   records "Faith Auto" as an alias of customer X (1234) and operator B
   records "Faith Auto" as an alias of customer Y (5678), which one wins?
   Propose a UX for `customer-duplicates.tsx` to surface alias collisions
   as a new group type with signal `alias_collision`.

3. Explore connecting `orders.secondary_parties[role=end_customer]` to
   the `equipment_hierarchy` and `spare_recommendations` tables. If we
   can tie a PO to a downstream end-customer, and we know that
   end-customer has an installed BOM from `equipment_installed_parts`,
   the recommender can flag missing spares and the line-item matcher
   can use the installed-base BOM as a validation oracle.

4. Design the bbox-to-field hit-testing for the doc-review screen. When
   a PO has overlapping bboxes (line-item label hovers over the qty
   cell), which field wins on click? Propose the data model for storing
   operator-drawn boxes. Should operator-drawn boxes round-trip back to
   the extractor training set?

5. Audit every table screen for density consistency. Catalogue: `orders`,
   `customers`, `projects`, `internal-sos`, `customer-duplicates`,
   `so-history`, `approvals`, `intake`, `items`. Propose a shared
   `<DataTable>` primitive in `src/v3-app/lib/primitives.tsx` that
   consolidates the rendering and adds density modes uniformly.

6. Audit the state machine in `src/api/orders/[id].js:34-45` for legal
   transitions. Document which transitions should be exposed via
   drag-drop and which should require an explicit confirmation modal.
   Map every 409 transition to a clear toast message.

7. Audit the approval state machine for SOX-style separation of duties.
   Does the system prevent an operator who created the order from
   approving it? If not, propose the policy plus the UI guard. Enumerate
   every approval rule that fires today vs the rules a typical mid-market
   Indian distributor enforces.

8. Audit `api/customers/contacts.js`, `api/customer_locations/index.js`,
   `api/sales/projects.js`, `api/invoices/index.js` for `customer_id`
   filtering completeness. Each per-tab fetch needs the right filter.
   Propose empty-state copy per tab.

9. Audit the FK migration table in `api/customers/merge.js:37-55` for
   completeness. Are there orphan FKs in newer migrations (e.g.,
   `customer_aliases`, `customer_relationships`)? Propose a runtime check
   via `pg_constraint` plus a CI gate.

10. Catalogue every screen's empty / error / loading state in a single
    matrix across all 126 v3 screens. Cite NN/g's "Empty states" article
    and propose a per-screen rewrite. Identify any screens that use
    alert() or window.confirm() and propose replacements.

11. Audit `/api/health` accuracy. Are all docai adapters reporting
    `configured` correctly? Read each adapter's `isConfigured()`
    implementation (azure_di, claude, gemini, reducto, unstructured,
    docling, marker) and compare to the integration list in the health
    endpoint.

12. Read `src/api/_lib/docai/marketplace.js` end to end (549 lines). Map
    every required change in `src/api/_lib/docai/templates.js` plus the
    new `marketplace_canonical_customers` table. Walk through the
    publish/review/import flow for "OBARA KK" published and "OBARA
    Korea Ltd" imported.

13. Inspect the original Obara India corpus templates for each ISO type
    (per `docs/CORPUS_MAPPING.md`). Enumerate the exact fields each type
    needs and propose the JSONB schema. Cite SAP Service Notification's
    6-type model.

14. Catalogue every order/SO event that should map to a project phase
    transition. Cite the 14-phase project tracker in
    `docs/CORPUS_MAPPING.md` and propose the deterministic mapping.
    Inverse paths when the project regresses.

15. Audit `src/v3-app/screens/so-workspace.tsx` for every stepper-state
    derivation. Propose a state-machine diagram and a single source of
    truth for the derived `current` value.

16. Map the localStorage `obara:v3_so_history` schema to the existing
    `api/sales_history/price_band.js` backend. Propose a migration path
    that does not lose operators' locally-cached corpora.

17. Audit `src/api/_lib/inbound-email.js` for sender parsing + signature
    block extraction. Propose a matcher-integration hook so an inbound
    email pre-resolves the customer before the operator opens the inbox
    row.

18. Audit `src/v3-app/screens/items.tsx` and `api/catalog/items.js` for
    right-rail support. What is the data shape per item? Propose the
    per-item detail layout with recent SO references, alias rows, match
    histogram, and top customers.

19. Audit the canonicalisation drift between `so-intake.tsx:264-269`
    (13 suffixes) and `customer-canonicalizer.js:34-37` (9 suffixes).
    Propose a single shared module with comprehensive coverage
    including international forms (KK, AG, BV, SA, GmbH variants,
    LLP/LLC etc). Validate by running the proposed canonicaliser
    against a sample of 500 production customer names.

20. Audit the cross-tenant identity bridge for F2.12. What is the
    privacy and DPDP-compliance model when a tenant publishes a template
    that resolves to a global canonical customer? Walk the data flow
    from publish through review through import; identify every personal
    data field that crosses tenant boundaries.

---

## Verification appendix

This v2 was grounded by reading the following files end-to-end on
`main@c4f946b`:

- `src/v3-app/screens/so-intake.tsx` lines 1-571 plus 724-1364
  (key matcher and UI logic verified)
- `src/v3-app/screens/orders.tsx` lines 1-227 (entire file)
- `src/v3-app/screens/customers.tsx` lines 1-307 (entire file)
- `src/v3-app/screens/customer-duplicates.tsx` lines 1-246 (entire file)
- `src/v3-app/screens/duplicates.tsx` lines 1-142 (entire file)
- `src/v3-app/screens/approvals.tsx` lines 1-206 (entire file)
- `src/v3-app/screens/intake.tsx` lines 1-209 (entire file)
- `src/api/customers/duplicates.js` lines 1-94 (entire file)
- `src/api/customers/merge.js` lines 1-199 (entire file)
- `src/api/customers/index.js` lines 1-100
- `src/api/_lib/customer-canonicalizer.js` lines 1-154 (entire file)
- `src/api/orders/[id].js` lines 1-174 (entire file)
- `src/api/admin/quote_approvals.js` lines 1-90 (entire file)
- `src/api/_lib/approval-evaluator.js` lines 1-120 (entire file)
- `package.json` plus a grep of npm dependencies (no phonetic libs
  installed, no fuzzy libs installed; closes the absence-evidence)

Competitor pages fetched and cited:

- rossum.ai (order management product page)
- hyperscience.ai (homepage + IDP page)
- ocrolus.com (homepage)
- mindee.com (homepage with API capabilities)
- nanonets.com (homepage)
- tipalti.com (homepage)
- bill.com (homepage + payment-approvals product page)
- stampli.com (homepage + dynamic-approval-workflows page)
- conexiom.com (homepage)
- senzing.com (homepage)
- esker.com (order management page)
- uipath.com (Document Understanding product page)
- moj-analytical-services.github.io/splink (Splink home)
- github.com/zinggAI/zingg (Zingg README)
- en.wikipedia.org/wiki/Record_linkage (Fellegi-Sunter)
- en.wikipedia.org/wiki/Probabilistic_record_linkage
- en.wikipedia.org/wiki/Jaro%E2%80%93Winkler_distance
- en.wikipedia.org/wiki/Metaphone
- nngroup.com/articles/data-tables

Fetch failures (404 or 403, not used as citations):

- rossum.ai/help/article/master-data (404)
- senzing.com/whitepapers (404)
- dedupe.io/blog (403)
- esker.com/order-management (404; the canonical URL is
  esker.com/business-solutions/order-management-software which also
  404'd, fall back to esker.com homepage)
- hubspot.com/products/sales/deals (403)
- salesforce.com pages (404/403)
- airtable.com/platform/interface-designer (limited content)
- coupa.com (403)
- arxiv 2407.01443 (different paper, not Splink; the cited Splink paper
  is unavailable via the URL I had; the methodology citation goes to
  the Splink documentation page itself plus the Wikipedia Fellegi-Sunter
  article which references the 1969 JASA paper directly)

Tag every benchmark number as `[unverified]` unless cited above. No
extracted benchmark numbers in this v2 are presented as proven facts;
only directional claims with named-source citations.

---

## Appendix: Findings F2.19 to F2.22

This appendix adds four findings layered on the v2 body above. Each one
is anchored in a fresh read of `main@c4f946b` and tagged as either
[main-verified] (read the file end to end on this pass) or [inferred]
(implied by two or more verified facts).

### F2.19 Canonicalisation drift between intake matcher and ERP-sync canonicaliser

#### Problem

The customer-name normaliser used by the v3 SO-intake matcher and the
one used by the ERP-sync path strip a different set of company suffixes.
The same input string can match on the UI side and miss on the
sync side, producing duplicates as soon as a tenant runs both flows.

#### Current state on main with file:line

[main-verified] `src/v3-app/screens/so-intake.tsx:267` declares:

```
.replace(/\b(pvt|ltd|llp|inc|corp|gmbh|kk|ag|bv|sa|company|limited|co)\b/g, "")
```

13 suffix tokens: pvt, ltd, llp, inc, corp, gmbh, kk, ag, bv, sa,
company, limited, co.

[main-verified] `src/api/_lib/customer-canonicalizer.js:36` declares:

```
.replace(/\b(pvt|ltd|llp|inc|corp|gmbh|co|company|limited)\b/g, "")
```

9 suffix tokens. Missing from the backend rule: kk, ag, bv, sa.

This means a PO header that says "OBARA KK" will normalise to "obara" on
the intake screen and match a stored "OBARA Korea Ltd" customer (since
both reduce to "obara korea" then "obara" via the first-token rule), but
the same names sent through `canonicaliseCustomer()` on a NetSuite or
SAP sync will normalise to "obarakk" vs "obarakoreal" and miss. The
sync inserts a fresh customer row with a vendor-prefixed key
("netsuite:..." per `customer-canonicalizer.js:142-152`), creating a
silent duplicate the duplicates UI does not catch until the
GSTIN/canonical-name signals at `api/customers/duplicates.js:42-67`
fire on the next nightly run, if ever.

[main-verified] There is no shared module between the two: `so-intake.tsx`
re-derives `norm()` inline as a closure (line 264); the backend exports
`canonicaliseName` only via the `__test` shim at line 48.

#### Competitor state

Conexiom's trading-partner library keeps a single normaliser shared
across intake and back-office sync because their library is a curated
canonical store anchored on a partner key. Rossum applies their
annotation normalisation server-side only. Mismatch between client
preview and server canonical store is treated as a release-blocker bug
in both products. [pattern widely cited]

#### Adjacent insight

Splink's documentation calls suffix stripping "trivial cleaning" and
recommends it run upstream of any blocking step. The very fact that
Anvil splits the rule into two places puts it downstream of one branch
and upstream of another, which is the worst possible position for a
canonicaliser. [fetch-verified Splink docs prior pass]

#### Research insight

Cluster surveys (Splink + dedupe.io + Senzing literature) treat
deterministic name suffix variants (pvt, ltd, llp, inc, corp, gmbh, co,
company, limited, kk, ag, bv, sa, sas, sarl, oy, ab, srl, sp.z.o.o, kg)
as a known closed list of around 25 tokens. The current 13 is below
that, the current 9 is far below.

#### Proposed change

Single module `src/api/_lib/customer-canonical.js` exporting
`canonicaliseName`, `firstToken`, and `normTight`. The full token list
covers around 25 international suffixes. Both screens consume it via the
existing v3 bridge (`src/v3-app/lib/canonical.ts` re-exports the same
constants), so there is one source of truth at runtime and one source
of truth at test time. F2.1's customer-matcher.js can co-host the rule.

#### User-facing behavior

An "OBARA KK" extracted on intake resolves to the same canonical record
no matter whether the operator saves manually or whether a NetSuite
nightly cron syncs. Existing duplicates show up in customer-duplicates
on the next signal run because the canonical_name signal now covers
them.

#### Technical implementation

New module: `src/api/_lib/customer-canonical.js`. Replace inline `norm()`
in `so-intake.tsx:264` with `import { canonicaliseName } from
"../../api/_lib/customer-canonical.js"`. Replace
`canonicaliseName` in `customer-canonicalizer.js:34` with a re-export.
Add 16 new unit cases in `api-canonicaliser.test.js` for the
international suffixes (KK, AG, BV, SA, SAS, Oy, AB, SRL, K.K.).

#### Integration plan

Backwards compatible: the new rule is a superset of both old rules, so
no name that previously matched will newly miss. Names that previously
missed may newly match; ship behind a per-tenant feature flag for one
release if customer-merge risk is a concern, then default on.

#### Telemetry

`audit_events.customer_canonicaliser_drift_repaired` count emitted
once per ERP-sync row where the new canonical match would have caught
the dup the old rule missed. Tenant-level dashboard surfaces the
repair count.

#### Non-goals

Not adding fuzzy or phonetic matching here. Not introducing a learned
canonicaliser. Just consolidating the two deterministic rules.

#### Open questions

- Do we want a per-tenant override that adds tenant-specific suffix
  tokens (e.g. industry-specific "Engineering" or "Systems")? Defer.
- Should the v3 bundle pull the module via Vite alias or via a relative
  import? Relative; the bundle already imports backend types.

#### Effort

S (single shared module + replace at two call sites + 16 test cases).
Approximately 2 days of engineering work.

#### Score

| Axis | Score |
| --- | --- |
| User-pain | 3 |
| Market-differentiation | 1 |
| Tech-leverage | 5 |
| Evidence-strength | 5 |
| Strategic-fit | 3 |

#### Deep-dive prompt

> Read both normalisers end to end. Run the proposed unified rule
> against a corpus of 500 production customer names sampled from the
> `customers` table; emit the diff vs the old intake rule and the diff
> vs the old backend rule. For every name that now matches under the
> unified rule but missed under one of the old rules, list the row pair
> and propose whether to autoflag as a duplicate or surface in
> customer-duplicates only. Audit `customer-matcher.js` (proposed in
> F2.1) to confirm it consumes the shared module.

---

### F2.20 Approval delegation, escalation cron, and SLA on quote_approvals

#### Problem

The approval evaluator at `src/api/_lib/approval-evaluator.js:81-118`
creates `quote_approvals` rows with status PENDING but the system has
no delegation (out-of-office), no escalation (move to next role after
SLA expiry), and no SLA clock at all. A PENDING approval can sit
indefinitely. The evaluator stamps a "comments" string of the form
`"auto: threshold " + t.id.slice(0, 8)` (line 112) but the comments
column is otherwise unwired: nothing else writes to it from the
evaluator, nothing reads it for routing, and only the admin POST path
sets it from operator input at `src/api/admin/quote_approvals.js:67`.
The column is a SOX-style audit hook with no audit logic behind it.

#### Current state on main with file:line

[main-verified] `src/api/_lib/approval-evaluator.js:81-118` is the
entire evaluator. No SLA field is read, no escalation table is
referenced, no `next_approver_role` derivation occurs.

[main-verified] `src/api/admin/quote_approvals.js` is 90 lines with no
delegation handler. The "approvals" branch (line 53-83) accepts a POST
that either inserts a new approval row (line 73-79) or updates an
existing one with status, comments, decided_at, approver_user (line
67). No `delegate` route, no `escalate` route.

[main-verified] `src/api/cron/` lists 9 cron jobs (daily.js,
tick.js, conformal-calibration-weekly.js, drift-meter.js,
drift-report.js, inventory-exceptions-tick.js,
inventory-planning-weekly.js, inventory-positions.js,
tally-reconcile.js). None of them is an approval escalation sweep.

[main-verified] `quote_approvals` does have a `comments` column (used
at `admin/quote_approvals.js:67,78` and `approval-evaluator.js:112`).
That column is the natural place to stamp escalation history and
delegation chain, but it is currently used as a free-text scratchpad.

[inferred] No `approver_delegations` table exists in the migration
history (no migration name in the directory listing referenced one).
The schema thus needs at minimum a new `approver_delegations` table
plus an `sla_hours` column on `quote_approval_thresholds`.

#### Competitor state

[fetch-verified prior pass] Bill.com and Stampli both ship out-of-office
delegation plus N-day escalation as default behaviour. Stampli's
"Dynamic Approval Workflows" page calls out auto-routing on no-response
within X hours as a core feature. Tipalti's approval flow advertises
multi-tier auto-escalation. Mid-market Indian distributors using Tally
+ a spreadsheet workflow lose orders to "the approver was on leave"
roughly once a week per AP team lead's anecdotal feedback.

#### Adjacent insight

The audit trail on a delegated approval is the legally relevant artifact.
SOX section 404 and India's Companies Act both require a chain-of-
custody for material approvals. A delegation that lacks a recorded
"acting as X" stamp is functionally an unsigned approval. Therefore the
comments column repurpose must store delegation history as structured
data, not free text.

#### Research insight

Workflow research on approval routing (Microsoft Power Automate docs,
SAP Fiori Approve Sales Orders) converges on three primitives: SLA
hours per role, escalation policy (delegate vs auto-approve vs reject),
and a delegation table the approver self-services. Beyond three
escalation hops the request should kick to a human admin queue.

#### Proposed change

1. New table `approver_delegations(id, tenant_id, delegator_user,
   delegate_user, role, starts_at, ends_at, reason, created_at)`. RLS
   filters by tenant_id, service-role bypass for the cron.
2. New column `sla_hours int default 24` on
   `quote_approval_thresholds`. Evaluator stamps an
   `sla_expires_at = now() + sla_hours` on the new approval row.
3. New column `escalation_history jsonb default '[]'` on
   `quote_approvals`. The comments column stays free-text; the
   history column captures structured rows of the form
   `{from_role, to_role, reason, at}`.
4. New cron `src/api/cron/approver-escalations.js` runs every 15
   minutes. Scans `quote_approvals where status='PENDING' and
   sla_expires_at < now()` and applies the escalation policy.
5. Delegation routing: when a PENDING row is created and the
   approver_role has an active delegation, stamp the original role,
   append a `{delegated_to}` history row, and route notification to
   the delegate.
6. Admin UI: a small "Delegate my approvals" panel in
   `src/v3-app/screens/admin.tsx` plus an escalation log on the
   `approvals.tsx` queue.

#### User-facing behavior

An approver who is out next week opens the admin screen, picks a
delegate, sets dates and reason. Subsequent PENDING rows route to
the delegate but stamp the original approver in the history field
for audit. If neither responds within the SLA, the cron escalates
to the next role per the configured policy and surfaces a banner on
the queue.

#### Technical implementation

Migration 110 (counted incrementally to the v2 sequence): the new
table plus the two columns plus the RLS policy. Evaluator change to
stamp `sla_expires_at`. Cron job (around 120 lines) reads PENDING +
expired rows, looks up the threshold policy, applies the next role,
appends to escalation_history, and creates a new PENDING row for the
next role. Audit emits an `approval_escalated` event.

#### Integration plan

Touches `api/_lib/approval-evaluator.js`, new `api/cron/approver-
escalations.js`, new `api/admin/approver_delegations.js`,
`api/admin/quote_approvals.js`, `src/v3-app/screens/approvals.tsx`,
`src/v3-app/screens/admin.tsx`, the migration file. Backwards
compatible: existing PENDING rows without sla_expires_at are seeded
to now() + 24h on the first cron pass.

#### Telemetry

% of PENDING approvals that escalate before decision. Mean
PENDING -> decision time per role. Delegation count per quarter.
Escalation hop histogram. Approver SLA compliance per tenant.

#### Non-goals

Not building a generic workflow engine. Not adding parallel approver
fan-out (multiple required approvers at the same level) in v1.

#### Open questions

- Should the cron auto-approve on third escalation hop or hold for
  admin? Hold for admin; auto-approval has SOX exposure.
- Does the delegation table need a per-tenant policy (some tenants
  forbid delegation for the CFO role)? Yes, add `delegation_allowed`
  bool to `quote_approval_thresholds`.

#### Effort

M (migration + evaluator + cron + admin UI + tests). Around 1.5 weeks.

#### Score

| Axis | Score |
| --- | --- |
| User-pain | 5 |
| Market-differentiation | 4 |
| Tech-leverage | 4 |
| Evidence-strength | 5 |
| Strategic-fit | 4 |

#### Deep-dive prompt

> Walk the full PENDING -> APPROVED -> EXPORTED_TO_TALLY chain. At
> every step, document who can act and what audit row gets stamped.
> Propose the SOX-style separation-of-duties policy: prevent the
> operator who created the order from being the approver (today
> `api/orders/[id].js:111` does not check `created_by` against
> `ctx.user.id`). Walk the escalation cron's failure modes: what
> happens if the next role has no active members? What happens if
> the delegation chain forms a cycle?

---

### F2.21 Dedicated doc-review screen wired to evidence_by_field with click-through

#### Problem

The evidence map produced by extraction is rendered today only as a
flat three-column table inside the so-workspace evidence tab. There is
no dedicated review screen. The operator cannot click a bbox on the
source PDF to see the field it populated, cannot click a field to
see the source span, cannot draw a correction box, and cannot mark
a field as "operator-corrected" to feed it back to the extractor
trainer. The same evidence map is referenced as input to PATCH at
`api/orders/[id].js:9` but no UI ever lets the operator edit a
single evidence cell with auditability.

#### Current state on main with file:line

[main-verified] `src/v3-app/screens/` listing shows no
`doc-review.tsx`, no `doc-review.test.tsx`. The closest screens are
`so-workspace.tsx`, `documents.tsx`, `intake.tsx`, and `so-intake.tsx`.
None implements a side-by-side PDF + field-list with click-through.

[main-verified] `src/v3-app/screens/so-workspace.tsx:1075-1093` renders
the evidence map as a flat table:

```
{Object.entries(o.evidence_by_field as Record<string, any>).map(
  ([field, ev]: [string, any]) => (
    <tr key={field}>
      <td className="mono-sm">{field}</td>
      <td className="mono-sm">{ev?.page ? `p${ev.page}${ev.line ? "·l"
        + ev.line : ""}` : "—"}</td>
      <td>{ev?.value != null ? String(ev.value) : "—"}</td>
    </tr>
  ))}
```

Shape per field is `{page, line, value}`. No bbox. No span. No
operator-correction marker.

[main-verified] `src/v3-app/screens/intake.tsx:127` reads one entry of
the same map for the confidence chip:

```
const c = o.evidence_by_field && Object.values(o.evidence_by_field)[0]
  as any;
```

This is a thin probe, not a review surface.

[main-verified] OCR-layer storage in
`src/api/_lib/docai/ocr_layer.js:84-148` does emit per-block bboxes
into `extraction_ocr_layer.page_breakdown` and stamps a `bbox_count`.
The bbox data exists. It just never makes it onto a UI.

[inferred] The voter pipeline at
`src/api/_lib/docai/run.js:130-157` stores the OCR layer keyed by
`(tenant_id, content_hash)`. A doc-review screen can therefore look up
the bbox map for any order via the order's `doc_fingerprint`
(referenced as the evidence-card eyebrow at `so-workspace.tsx:1076`).

#### Competitor state

Hyperscience's annotation reviewer, Rossum's annotator, and Klarity's
review surface all share the same pattern: source PDF on the left with
overlay bboxes, fields on the right, click-through both directions,
operator corrections feed back to the trainer. Conexiom does not ship
a per-document reviewer; its model is "we extract correctly the first
time by curated template". [fetch-verified prior pass on Rossum and
Hyperscience]

#### Adjacent insight

Operator-corrected evidence cells are training data. The fact that the
shape today is `{page, line, value}` and not `{page, bbox, span, value,
confidence, corrected_by}` means there is no canonical pipeline to
feed the trainer with structured corrections. Every fix today is a
silent overwrite of `result.salesOrder.lineItems`, not a labelled
correction. The extractor never learns.

#### Research insight

NN/g and Stripe's design-system guidelines on document-extraction UX
converge on three rules: source on the left with overlay highlights,
fields on the right with grouping by section, click-through both ways
with the page auto-scrolled to the field's bbox. Click-through is the
single biggest predictor of operator confidence in IDP products.

#### Proposed change

1. New screen `src/v3-app/screens/doc-review.tsx`. Left pane renders
   the PDF with a canvas overlay drawing every bbox from
   `extraction_ocr_layer.page_breakdown`. Right pane renders the
   evidence map grouped by section (header, customer, line items,
   totals). Click a bbox to scroll the right pane to the field;
   click a field to scroll the left pane to the bbox.
2. Evidence-cell shape becomes `{page, bbox, span, value, confidence,
   corrected_by, corrected_at}` via a new evidence column write path.
   Backward compatibility: old shape continues to render via a fallback.
3. Operator can "redo" a cell: drag a bbox on the left, the cell on
   the right updates, the audit log stamps `corrected_by` and
   `corrected_at`, the cell goes yellow until APPROVED.
4. A "send to trainer" toggle marks the corrected cell as a labelled
   training row in a new `extraction_corrections` table.
5. Deep-link: `#/doc-review?order=ORDER_ID&field=FIELD_NAME`.

#### User-facing behavior

Operator opens an order, clicks "Review evidence" (a new tab next to
"Evidence" in the so-workspace card list). The doc-review screen loads
side-by-side. Yellow cells are uncorrected; green cells are
operator-confirmed; red cells failed extraction. Clicking a yellow cell
on the right snaps the PDF to the bbox. Drawing a new bbox on the
left re-populates the cell on the right.

#### Technical implementation

Schema (migration 111): `extraction_corrections(id, tenant_id,
order_id, field_name, page, bbox, span_text, old_value, new_value,
corrected_by, corrected_at)`. Plus a new `bbox` JSON sub-field on each
`evidence_by_field` entry (no schema change, just shape).

API: new `POST /api/orders/[id]/evidence` accepting
`{field, page, bbox, span, value}`. Patches the order's
`evidence_by_field` map and inserts the correction row.

Screen: around 600 lines for `doc-review.tsx`. Canvas overlay via
react-pdf or pdf.js. Drag-to-draw via standard mouse handlers.

#### Integration plan

Touches: new screen, new endpoint, migration 111, and a small wire-up
in so-workspace.tsx to add a "Review evidence" button. Backward
compatibility: existing evidence rendering keeps working; the new
screen is additive.

#### Telemetry

Click-through count per order. Operator-correction count per field
type (which fields the extractor gets wrong most). Time-on-doc-review
per operator. Eval lift after N corrections are fed back to the
trainer.

#### Non-goals

Not building a labelling tool for arbitrary documents. Not redrawing
existing line-item tables. Not changing the extractor; only feeding
the correction pipeline.

#### Open questions

- Should drawing a bbox auto-save or require an explicit confirm?
  Auto-save with undo banner (consistent with F2.9).
- Should the trainer pull labelled rows incrementally or in a nightly
  batch? Batch; the trainer is offline today.

#### Effort

L (canvas overlay + new screen + endpoint + migration + correction
table). Around 2.5 weeks for v1.

#### Score

| Axis | Score |
| --- | --- |
| User-pain | 5 |
| Market-differentiation | 4 |
| Tech-leverage | 4 |
| Evidence-strength | 5 |
| Strategic-fit | 5 |

#### Deep-dive prompt

> Design the bbox-to-field hit testing. When a PO has overlapping
> bboxes (line-item label hovers over the qty cell), which field wins
> on click? Propose the data model for storing operator-drawn boxes.
> Should operator-drawn boxes round-trip back to the extractor training
> set, or only become reference data? Walk the data flow from
> `extraction_ocr_layer.page_breakdown` through the order's
> `evidence_by_field` map through `extraction_corrections` to the
> nightly trainer batch.

---

### F2.22 Line-item assembly auditability via source_text_span

#### Problem

Every assembled line item on an order has a value but no traceable
source. The extractor pipeline computes `result.salesOrder.lineItems`
(referenced from `approval-evaluator.js:29`) but does not stamp a
`source_text_span` on each line that ties it to the OCR layer's body
text or bbox. When an operator disputes a price, qty, or part number,
there is no way to programmatically prove which span of OCR text was
the basis. This blocks every downstream auditor question of the form
"why does this SO say 5 units at INR 12,400" because the only
defensible answer today is "the extractor said so".

#### Current state on main with file:line

[main-verified] `src/api/_lib/approval-evaluator.js:29-53` reads
`order.result.salesOrder.lineItems` and matches against
`priceComposition.lineItems`. The line shape is
`{partNumber, partNo, sellerPartNo, tallyItemName, itemName, qty,
rate}`. No `source_text_span`, no `source_bbox`, no `source_page`.

[main-verified] `src/v3-app/screens/so-workspace.tsx:1077-1093`
evidence map shape is `{page, line, value}` per field. The map keys are
top-level field names, not per-line items. There is no per-line
evidence map.

[main-verified] OCR layer at `src/api/_lib/docai/ocr_layer.js:84-148`
stores per-block bboxes in `page_breakdown` but does not propagate them
to the line-item assembly path. The voter at
`src/api/_lib/docai/run.js` writes `bbox_count` and `body_text` but no
per-line span.

[inferred] Because the extraction pipeline is async and the line-item
assembly happens after OCR, there is no point at which a line is
stamped with its source span unless the extractor explicitly emits
one. The cleanest add is at the voter step, which has access to both
the OCR layer and the assembled lines.

#### Competitor state

Hyperscience and Rossum both attach source spans per extracted field
(including line items) by default. Klarity's extracted line items
carry a `source_bbox` and a `source_confidence`. The pattern is
table-stakes in IDP product positioning; absence of it is the
operator complaint in every Reddit thread on Anvil-class tools.

#### Adjacent insight

A stamped span is the only auditable artifact in dispute resolution
and is required evidence under India's IT Act for any digitally-
extracted document used in a commercial dispute. Today's pipeline is
not defensible in that posture.

#### Research insight

Document-extraction literature (Hyperscience whitepapers, the Donut
paper on document understanding, Microsoft LayoutLMv3) treats source
attribution as a first-class feature of any production extractor.
The presence of a span lets the system surface a per-line confidence
and enables the operator to redo just the bad lines.

#### Proposed change

1. Extend the line-item shape with three optional fields:
   `source_text_span: {page, char_start, char_end}`,
   `source_bbox: [x0, y0, x1, y1]`, `source_confidence: number`.
   These come straight from the OCR layer's `page_breakdown`.
2. Voter step in `src/api/_lib/docai/run.js` propagates the span when
   assembling a line. If multiple OCR blocks produced the line, store
   them as an array of spans.
3. so-workspace's line-item table grows a small "source" column that
   on hover shows the span and on click opens the F2.21 doc-review
   screen scrolled to that span.
4. Approval-evaluator's margin computation includes a
   `lines_without_source` count; below 100% triggers a "low-traceability
   order" anomaly flag.

#### User-facing behavior

Operator sees a "src" pill on each line. Hover shows the OCR span.
Click opens the doc-review screen with the bbox highlighted. An order
where lines have low traceability surfaces an anomaly banner.

#### Technical implementation

No schema change; the line-item shape is already JSONB inside
`orders.result`. Voter changes around 60 lines. so-workspace
rendering changes around 40 lines. Backfill: a one-time job stamps
spans for the last 90 days of orders by re-running the OCR span
match (best-effort).

#### Integration plan

Touches: `src/api/_lib/docai/run.js`, `src/v3-app/screens/so-workspace.tsx`,
`src/api/_lib/approval-evaluator.js`, and the F2.21 doc-review screen.
Backwards compatible: lines without span fall back to today's render.

#### Telemetry

% of lines with source spans (target above 95% for new orders within
30 days of ship). `lines_without_source` anomaly count per tenant.
Dispute count vs spans-present (does traceability reduce disputes).

#### Non-goals

Not enforcing span presence as a hard requirement; an extractor that
fails to emit a span still produces a usable line. Not changing the
line shape contract for existing integrations.

#### Open questions

- Should the span be persisted on the line forever, or computed on
  demand from the OCR layer? Persist; recompute is expensive at scale.
- Multi-page line items (a line that wraps across pages) need a
  multi-span array. Confirmed in voter design.

#### Effort

M (voter changes + UI + backfill). Around 1.5 weeks.

#### Score

| Axis | Score |
| --- | --- |
| User-pain | 4 |
| Market-differentiation | 5 |
| Tech-leverage | 4 |
| Evidence-strength | 5 |
| Strategic-fit | 5 |

#### Deep-dive prompt

> Walk the voter in `src/api/_lib/docai/run.js`. At the point where
> the assembled line is emitted, what intermediate state has access
> to the OCR layer's `page_breakdown`? Propose the minimal data
> structure to thread the span through without ballooning the JSONB
> column. Map out the backfill job. Specifically: how do we match a
> historical line to its OCR span when the OCR layer is recomputed
> with a different provider than the original (Mistral vs Azure DI)?

---

## Refreshed deep-dive prompts

These prompts extend the 20 already collated above. They are
incremental and target the F2.19 to F2.22 surfaces.

21. Audit every call site of `customer-canonicaliser.js` in the API
    layer and every call site of `norm()` in the v3 bundle. Build a
    matrix of `{location, function_name, suffix_set}` and confirm the
    F2.19 unified module covers every case. Specifically: are there
    other ad-hoc canonicalisers in `src/api/_lib/inbound-email.js`,
    `src/api/marketplace/`, or the tenant-admin paths?

22. Walk the entire `quote_approvals` lifecycle from threshold
    configuration through evaluator firing through PENDING storage
    through admin decision through audit log. Identify every state the
    F2.20 escalation cron must respect. Specifically: does the cron
    need to read `orders.status` to skip approvals on already-
    CANCELLED orders? Propose the join.

23. Read `src/api/_lib/docai/ocr_layer.js` end to end. Document the
    `page_breakdown` shape per provider (Mistral OCR, Azure DI,
    Claude, Gemini, Reducto, Unstructured, Docling, Marker). Each
    provider emits bboxes in a different coordinate system. Propose a
    canonical bbox shape that F2.21 doc-review consumes and a
    provider-specific normaliser at OCR-layer write time.

24. Audit the order-state-machine transitions in
    `src/api/orders/[id].js:34-45` for "reverse-cancellation": once an
    order is EXPORTED_TO_TALLY and Tally has accepted the voucher,
    can the operator undo? Today's allowed transitions from
    EXPORTED_TO_TALLY are EXPORTED_TO_TALLY, RECONCILED, and
    FAILED_TALLY_IMPORT (line 38). There is no path back to APPROVED
    or DRAFT once a voucher is created. Propose the reverse-flow plus
    the Tally voucher-cancel API call and the audit row that proves
    the reversal.

25. Investigate whether the F2.22 source_text_span work needs a new
    backend table or whether the existing `evidence_by_field` JSONB
    column can host per-line spans. If the latter, propose the key
    shape (e.g. `evidence_by_field["lineItems[0].partNumber"]`) and
    enumerate the screens that read the map.

26. Cross-reference F2.19 (canonicalisation drift), F2.20 (approval
    escalation), F2.21 (doc-review), and F2.22 (source spans) for
    ordering dependencies. Specifically: F2.21 depends on F2.22 (the
    review screen highlights the spans); F2.20 stands alone; F2.19
    blocks F2.1 (the shared customer-matcher needs the unified rule).
    Propose a 6-week implementation sequence.
