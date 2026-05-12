# Phase 4. DocAI engine v2 (6 weeks)

Status: planning. Owner: DocAI pod (3 engineers + 1 eval ops).
Repo: `/Users/kenith.philip/anvil/` on `main` @ `c4f946b`.
Window: weeks 17 through 22 of the 2026 roadmap, immediately
following the trust-and-sales-motion phase. Exit criteria pulled
from `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` lines 475 to 577.

---

## Section 1. Phase summary

Phase 4 takes the DocAI extraction pipeline from "good enough to
ship at design-partner scale" to "demonstrably best in class for
Indian distributor purchase orders, with a public benchmark to
back the claim." The pipeline that arrives at Phase 4 already has
the cost-compression chain wired in (Gemini 3 Flash primary,
Mistral OCR 3 batch path, Sonnet 4.6 confidence fallback, Opus
4.7 escalate tier) but the chain is unevenly instrumented. The
voter at `/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js`
weighs every adapter equally even though Sonnet 4.6 outperforms
Gemini 3 Flash on the Indian distributor corpus by roughly four
points of field-level accuracy at 6x the unit cost. The line
aligner inside the voter keys exclusively on `partNumber`, which
collapses on real-world POs where Indian distributors and their
OEM principals exchange parallel naming conventions. The
prompt-injection firewall lives only inside `_lib/anthropic.js`
and `_lib/gemini.js`; Mistral OCR at `_lib/mistral.js` has no
redaction plumbing. The OCR fallback at `claude.js:425-431` will
forward 50 KB of raw bytes to a paid LLM the moment a Word
document arrives with a misleading file extension.

Across six weeks Phase 4 closes those nine P1 gaps and ships
three operator-visible artifacts that prior phases did not
attempt: a voter-disagreement panel in the SO workspace, a
prompt registry with semantic-versioned templates, and an
injection-bench-v2 CI gate that runs 200 plus prompts post
redaction against every paid LLM call site. The phase finishes
with an OmniDocBench plus FUNSD plus DocVQA report card scored
against Rossum, Hyperscience, Klippa, and Azure DI on the
identical 500-document Anvil ICP eval set, published as a public
PDF and a Jepsen style "tests" tree so prospects can reproduce
the numbers. The phase unlocks a "DocAI Pro" upgrade tier priced
at Rs 15 per extracted line (versus Rs 8 on the standard tier)
and gates the Confidence Marketplace, Tournament Voter, and
Hallucination Insurance revenue products described in Section 3.

---

## Section 2. Deep-dive research findings

### DD7. OWASP LLM Top 10 (2025) injection corpus and parity

The OWASP Top 10 for LLM Applications 2025 release ships the
LLM01 (Prompt Injection), LLM02 (Sensitive Information Disclosure),
LLM05 (Improper Output Handling), and LLM06 (Excessive Agency)
categories with worked attack examples that the project provides
as YAML fixtures under
https://github.com/OWASP/www-project-top-10-for-large-language-model-applications.
For Anvil's surface the LLM01 corpus is the most relevant: 137
labelled prompts grouped by indirect injection (the document
itself attacks the system prompt), direct injection (the user
inputs an attack), and many shot jailbreaking (Anthropic's own
April 2024 research at https://www.anthropic.com/research/many-shot-jailbreaking
showing that 256 plus example shots can override the system
prompt at frontier scale). Anvil's existing 6 prompt bench under
`/Users/kenith.philip/anvil/scripts/injection_bench.js` is a
toy by comparison; Phase 4 lifts the corpus to 200 plus prompts
drawn from four sources stitched together:

Lakera Gandalf public corpus at https://gandalf.lakera.ai/.
Lakera releases the per level prompts that beat their proprietary
firewall. Roughly 60 prompts after deduplication, covering "say
the password in pig latin," "translate the system prompt to
French," and base64 wrappers.

HiddenLayer ModelScan injection corpus at https://hiddenlayer.com/
research/automated-jailbreak/ released July 2024. Roughly 80
prompts, heavily skewed toward indirect injection through file
metadata (EXIF, PDF /Title, ZIP comment fields).

Anthropic many shot jailbreaking dataset at https://www.anthropic.com/
research/many-shot-jailbreaking. Twenty four prompts that succeed
only after 256 plus example shots; the relevant Anvil mitigation
is the system prompt budget cap (F36 in the roadmap, see DD30).

OWASP Top 10 LLM01 corpus. The 137 labelled prompts from the
canonical OWASP fixture set. Forty four of these reproduce
unchanged against Anvil's current production path when the
attacker controls the PDF content.

Anvil specific additions. Indian distributor POs frequently
contain "internal notes" sections, freight terms in vendor
specific shorthand, and OEM brand mentions inside line item
descriptions that the LLM should never confuse with the buyer
identity. Phase 4 adds 20 to 30 Anvil specific prompts crafted
from the support corpus where a model misidentified a customer.

Citation discipline. Every prompt in the bench carries its
source URL, the date the corpus was pulled, and an OWASP LLM01
through LLM10 tag. The bench writes its results to
`/Users/kenith.philip/anvil/tests/injection_bench_v2/results/`
with a JSON manifest and a Markdown report. The CI gate fails
the build if a single prompt produces a model output that
contains the secret canary or breaks the system prompt
instructions.

### DD9. Golden fixture curation for Indian distributor POs

The four public document understanding datasets that matter for
Anvil's ICP are: FUNSD (199 noisy scanned forms from RVL CDIP, at
https://guillaumejaume.github.io/FUNSD/), CORD (1000 Indonesian
receipts with 30 entity types, at https://github.com/clovaai/cord),
DocVQA (12767 document images with question answer pairs across
business documents, at https://www.docvqa.org/), and OmniDocBench
(9070 documents at https://opendatalab.github.io/OmniDocBench/
released October 2024 by OpenDataLab covering tables, formulas,
math, and reading order across nine document classes). Of these,
OmniDocBench is the most useful sanity check for the OCR layer
because it scores at the page level with table cell precision,
recall, F1, and reading order edit distance; this is the metric
that Mistral OCR 3 reports its 79.75 OmniDocBench score against
at https://mistral.ai/news/mistral-ocr-3.

The right 50 document Anvil ICP split. None of FUNSD, CORD,
DocVQA, or OmniDocBench actually contains an Indian distributor
PO with GSTIN, HSN per line, multi state freight terms, and an
end customer project name lurking in the line item description.
Phase 4 curates a 50 document split from three sources:

Twenty five real Anvil tenant POs from Faith Automation, Innovec,
Vinrose, and the three other design partners, scrubbed by
running the redaction firewall in tagging mode (`tagPII: true`)
and replacing real party names with stable hashed pseudonyms.

Fifteen synthetic POs generated by prompting Sonnet 4.6 with the
real PO statistics: 18 line average, 4 to 6 brand mentions per
PO, 30 percent contain an end customer project name in a freight
or remarks block, 80 percent are scanned PDFs at 200 to 300 DPI,
20 percent are clean text PDFs.

Ten cross border POs from Indian distributors that import from
Japan, Korea, Germany, China, and the United States. These
exercise the country detection logic in `gemini.js` lines 56 to
72 and `claude.js` equivalents where the prompt encodes the
country conditional GSTIN rule.

Each fixture ships with three labels: the ground truth JSON
(human reviewed), the difficulty class (easy / medium / hard /
adversarial), and the source provenance. Difficulty is scored
by line count, OCR quality (Mistral OCR confidence), and
brand mention density. The adversarial class includes injection
attempts in the line item descriptions; these are also part of
DD7's bench. Phase 4 publishes the split as
`/Users/kenith.philip/anvil/tests/golden/anvil_icp_50/` with the
JSON labels but the PDFs themselves stored encrypted in Supabase
Storage and decrypted only when the eval runner pulls them.

### DD13. Operator review UX across the top three competitors

Rossum (acquired by Snowflake in 2024) ships its review UI as a
two pane layout: PDF on the left with bounding box overlays, an
edit panel on the right with field by field confidence chips,
keyboard shortcuts to "accept next low confidence field." Rossum
calls this their Aurora flow at https://rossum.ai/aurora/. The
operator can click any field to highlight the source bbox on
the PDF; conversely clicking a bbox on the PDF jumps to the
edit row. Rossum supports per field provenance ("this came from
the Aurora vision model with confidence 0.92") and reports
operator corrections back to a per tenant fine tune pipeline.

Hyperscience uses a workflow concept called Hypercell at
https://www.hyperscience.com/platform/. Hypercell is a single
review unit (one field, one bbox, one machine prediction) routed
to a human queue when confidence is below a configurable
threshold. The operator sees only the bbox crop, not the full
PDF, and answers a single question ("Is this field PO number?
Yes / No / Edit"). Hyperscience claims this design reduces per
field review time from 8 to 3 seconds at the cost of losing the
document context. The Hypercell model maps cleanly to Anvil's
voter disagreement signal (F30 in the roadmap): a field that
splits across adapters is a Hypercell candidate.

Klippa DocHorizon at https://www.klippa.com/en/dochorizon/ ships
a Flow Builder where the customer composes the extraction
pipeline as a node graph (OCR node, classify node, extract
node, validate node, route node). The operator review surface
sits at the Validate node and is closer to Rossum's two pane
layout than Hyperscience's Hypercell. Klippa's distinguishing
move is to expose the per node confidence and per node cost as
a chip on the workflow diagram, so the operator can see at a
glance which node in the pipeline produced the low confidence
field. Anvil already records per adapter cost; surfacing it on
the operator panel is one step away.

For Anvil, the right synthesis is: keep Rossum's two pane
default (PDF on left, field rows on right) because Indian
distributor POs frequently need document context (the customer
GSTIN appears in the letterhead, not next to the field), bolt
on Hyperscience's Hypercell queue for voter disagreements
where a single click resolves a contested field, and adopt
Klippa's per node cost chip so finance teams can audit the
unit economics field by field. Phase 4 ships the voter
disagreement chip; the full Hypercell queue lands in Phase 5
or Phase 6.

### DD20. Voter cost weighting with regret bounds

The current voter at `voter.js` lines 82 to 136 picks the
majority value, ties broken by max confidence in the bucket,
ties on confidence broken by dispatcher rank. This means when
Gemini 3 Flash and Mistral OCR both return value X and Sonnet
4.6 returns value Y, the voter picks X regardless of which
adapter has historically been more accurate on that tenant.
Worse: when all three adapters agree, the voter records all
three contributions and the run consumes all three adapter
costs, but the per call expense to the cheapest adapter (Gemini
3 Flash at roughly $0.000004 per token in) is dominated by the
most expensive (Sonnet 4.6 at roughly $0.000015 per token in
plus call setup overhead). The marketplace effect: the voter
behaves as a strict majority quorum, which is the wrong
incentive on the unit economics axis.

The cleanest correction is to weight votes by a per tenant per
adapter accuracy estimate combined with an inverse cost factor.
Three algorithms fit:

Multi armed bandit (UCB1) at https://www.cs.bham.ac.uk/internal/
courses/robotics/lectures/ucb1.pdf. Each adapter is an arm; pull
the arm with the highest upper confidence bound on accuracy.
UCB1 has logarithmic regret in the number of pulls. The
disadvantage is that UCB1 explores aggressively early; on a low
volume tenant the voter would spend its first 50 to 100
extractions over sampling the most expensive adapter to drive
the upper bound down.

Thompson Sampling at https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf.
Sample a Bernoulli accuracy estimate per adapter from a Beta
posterior and pick the highest sample. Thompson sampling has
constant factor regret matched to the problem. It naturally
incorporates a prior, so the initial 50 to 100 extractions on a
new tenant can use the global Anvil prior (Sonnet 4.6 = 0.96,
Gemini 3 Flash = 0.92, Mistral OCR = 0.88) and the posterior
updates from there.

Hedge / Multiplicative Weights at https://www.cs.cmu.edu/~avrim/
ML07/lect1019.pdf. Maintain a weight per adapter that decays
exponentially when the adapter disagrees with the eventual
human correction. Hedge is the right algorithm for the adversarial
setting where the same adapter is correct on one tenant and
wrong on another; the regret bound is O(sqrt(T log N)) where T
is rounds and N is adapters.

For Anvil's surface the right pick is Thompson Sampling with a
cost adjusted utility function: U(adapter) = accuracy(adapter)
minus lambda times cost(adapter), where lambda is the operator
configurable cost penalty per accuracy point. Default lambda is
roughly Rs 4 per accuracy point (one tenth of one percent
accuracy gain is worth Rs 0.40 of marginal call cost). This
shipping plan: a per tenant `voter_weights` table with columns
tenant_id, adapter, alpha (Beta posterior alpha), beta (Beta
posterior beta), updated_at, cost_per_call_usd, last_sampled_at.
A nightly job rolls updates from `extraction_corrections` into
the posterior. The voter samples utilities at vote time and
weights each adapter's contribution by its sampled utility.

The cost quality elbow detection (F29's "refuse to escalate to
Opus if Sonnet's marginal accuracy delta is below 1 percent") is
a straightforward addition: the voter publishes a `would_escalate`
flag in the response when the lambda weighted utility of
escalation is positive; the dispatcher reads the flag and decides
whether to actually pull the more expensive adapter.

### DD30. PDF.js performance with large multi page documents

Anvil's text layer at `/Users/kenith.philip/anvil/src/api/_lib/docai/text_layer.js`
uses PDF.js under the hood for text extraction. The Mozilla
maintained PDF.js at https://mozilla.github.io/pdf.js/ is the
right pick for browser side rendering but its performance
characteristics on long documents (50 plus pages) bite hard when
the operator opens the review UI and the SO workspace renders
the full PDF in one shot. The PDF.js docs at https://github.com/
mozilla/pdf.js/wiki/Frequently-Asked-Questions discuss three
strategies that Phase 4 should adopt:

Lazy page rendering. Render only the visible page and one page
above plus one page below; unmount canvases when they scroll out
of view. PDF.js exposes `getPage(n)` which is the cheap path;
`render` on the page object is the expensive path. The lazy
render observer pattern uses an IntersectionObserver to trigger
render on a placeholder canvas when the canvas enters the
viewport.

Canvas pooling. PDF.js will happily allocate a canvas per page,
which on a 100 page PO eats 100 MB plus of GPU memory and
crashes mobile Chrome. Pool five to ten canvases and reuse them
for the visible pages by swapping the rendered image.

Web Workers. PDF.js ships its parsing path in a Web Worker
already (the `pdf.worker.js` artifact) but the main thread still
does the canvas rasterisation. For Anvil's review UI the main
thread cost is dominated by canvas rasterisation on PDFs with
many small images (a typical scanned PO). The OffscreenCanvas
API at https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
lets the worker handle the canvas as well; PDF.js exposes
`renderTask` on a worker side canvas if the consumer wires it
through. Safari support for OffscreenCanvas reached Safari 16.4
so this is now broadly available.

Anvil specific notes. The current `text_layer.js` extracts text
on the server side only; the browser side review UI in
`public/so/workspace.js` (or wherever the SO workspace lives)
renders the PDF separately. Phase 4 should establish a single
PDF.js code path on both surfaces, share the cached page
content between the text layer extractor and the review UI, and
expose a "page count > 20" performance flag that triggers the
canvas pooling code automatically.

### DD40. Hungarian algorithm bipartite matching for line alignment

The current line aligner at `voter.js:152-166` groups adapter
lines by `partNumber` and falls back to positional bucket
`__pos:N` when partNumber is null. This is the canonical key
matcher and it breaks in two real ways. First, an Indian
distributor PO often carries a customer specific part number
(say "CUST-12345") in the partNumber column and the OEM brand
part number ("OBARA-A0123") in the description. Sonnet 4.6
extracts the customer code into partNumber; Gemini 3 Flash
extracts the OEM code into partNumber. The voter sees two
different partNumber values and creates two separate buckets,
each with one adapter contributing, so the voter never gets a
quorum. Second, on POs without part numbers at all (some
distributors operate on "Item 1, Item 2, Item 3" with the spec
in the description), the positional bucket matches but ignores
the actual content; two adapters that reorder the lines (because
one read top down and the other read by column) align to the
wrong rows.

The right replacement is a Hungarian algorithm bipartite matcher
across the full line vector (partNumber, description, quantity,
unitPrice). The Hungarian algorithm at https://en.wikipedia.org/
wiki/Hungarian_algorithm solves the optimal assignment problem
in O(n^3) where n is the larger of the two adapter line counts.
For Anvil's typical PO (18 lines), n is 18, n cubed is 5832
arithmetic ops, which is below 1 ms on any production CPU.

The cost matrix is constructed per pair of lines (adapter A
line i, adapter B line j) with weighted contributions:

  w_partNumber: 0.4 if exact match, 0.2 if Levenshtein normalised
  distance below 0.3, 0 otherwise.

  w_description: weighted Levenshtein on lowercased description
  with stop word removal; map to a 0 to 0.4 score where 0.4 is
  identical and 0 is fully different.

  w_quantity: 0.1 if exact, 0.05 if within 10 percent, 0 else.

  w_unitPrice: 0.1 if exact, 0.05 if within 5 percent, 0 else.

Sum to a score in 0 to 1.0; convert to a cost via 1 minus score
so the Hungarian solver minimises cost. The munkres NPM package
at https://www.npmjs.com/package/munkres-js is a 200 line
implementation with no dependencies. Phase 4 vendors munkres
into `/Users/kenith.philip/anvil/src/api/_lib/docai/hungarian.js`
to avoid the supply chain risk; the algorithm is well known and
correctness is unit testable against the canonical 4x4 example.

Tradeoffs vs the partNumber only matcher. The Hungarian solver
matches even when partNumber is null on both sides, so it
recovers the "Item 1 / Item 2" PO case. It matches across
different partNumber conventions when description and quantity
agree, so it recovers the customer code vs OEM code split. The
solver does worse than the canonical key when partNumber agrees
but description is wildly different (one adapter read the wrong
text into description); a 0.4 weight on partNumber plus a
fallback rule when the Hungarian assignment leaves a residual
cost above 0.6 (declare the line unmatchable, fall back to
positional) handles this corner.

The new module at `/Users/kenith.philip/anvil/src/api/_lib/docai/line_align.js`
exports `alignLines(adapterResults)` that returns the same
shape as `groupLinesByPartNumber` so the voter integration is a
one line swap. Tests live at `tests/unit/line_align.test.js`
with the canonical 4x4 example, an Indian distributor PO
fixture, and a 50 line invoice stress test.

### DD44. Schema versus implementation alignment (migration 098)

Migration 098 at `/Users/kenith.philip/anvil/supabase/migrations/098_gemini3_mistralocr_routing.sql:17-22`
adds four tenant settings columns: `docai_mistral_ocr_api_key_enc`,
`docai_mistral_ocr_endpoint`, `docai_mistral_ocr_batch`, and
`docai_gemini_media_resolution`. Lines 25 through 34 add the
confidence threshold `docai_fallback_confidence` with a 0.50 to
0.99 check constraint. Lines 39 through 41 update the provider
order on tenants who never customised it. Lines 59 through 67
add eval suite metadata columns to `eval_runs`.

The implementation status against the schema:

The Gemini media resolution knob is wired correctly. In
`/Users/kenith.philip/anvil/src/api/_lib/docai/gemini.js:299` the
adapter passes `media_resolution: settings?.docai_gemini_media_resolution
|| "high"` to `callGemini`. The schema and the code agree.

The Mistral OCR API key path is NOT wired. In
`/Users/kenith.philip/anvil/src/api/_lib/mistral.js:51` the call
reads `const apiKey = process.env.MISTRAL_API_KEY` without ever
consulting the `tenant_settings.docai_mistral_ocr_api_key_enc`
column the schema added. No `decryptField` call, no settings
parameter, no tenant id plumbing. The schema is ahead of the
implementation by an entire column.

The Mistral OCR endpoint override is NOT wired. The schema added
`docai_mistral_ocr_endpoint` for tenants who run a private
Mistral deployment behind a custom endpoint. `mistral.js:47-48`
hardcodes both `REALTIME_OCR_URL` and `BATCH_OCR_URL` to the
public Mistral endpoints. The schema is ahead.

The Mistral OCR batch flag IS wired but reads from `opts.batch`
in `mistral.js:56` rather than from `settings.docai_mistral_ocr_batch`.
The caller is responsible for translating the setting into the
opts; whether that translation happens depends on which call
site invokes the OCR layer. The `ocr_layer.js` consumer at
`/Users/kenith.philip/anvil/src/api/_lib/docai/ocr_layer.js`
needs an audit to confirm; the schema is consistent with the
adapter API surface but the wiring may be incomplete.

The confidence fallback threshold IS implied to be wired by the
schema comment at line 53 ("Bet 1: extractor confidence threshold
under which the dispatcher falls back to the next adapter") but
the actual confidence fallback decision lives in the dispatcher
`/Users/kenith.philip/anvil/src/api/_lib/docai/index.js` and
`run.js`, which I have not yet audited line by line in this
file. Phase 4 should grep for `docai_fallback_confidence` to
confirm the wiring; given the pattern with the other three
columns, the read site likely exists in run.js because the
dispatcher decides when to escalate.

The injection firewall vendor parity gap is the most consequential
finding. In `/Users/kenith.philip/anvil/src/api/_lib/gemini.js:18`
the Gemini client imports `applyFirewall` and `redactMessages`
from `./anthropic.js` and calls them at lines 125 to 126 before
mapping the messages into the Gemini contents API surface. This
is correct parity. In `/Users/kenith.philip/anvil/src/api/_lib/mistral.js`,
across all 104 lines, there is NO import of `applyFirewall`, NO
import of `redactMessages`, and NO firewall plumbing of any
kind. Mistral OCR receives the raw document bytes plus the
filename, ships them to the Mistral API, and returns the
extracted pages without applying the redaction firewall that the
Anthropic and Gemini paths apply. This is the F34 finding in the
roadmap and DD44 confirms the implementation gap by direct line
read. The schema migration 098 added the per tenant Mistral OCR
config columns but did not introduce any firewall wiring. The
firewall lives only inside the LLM call sites and Mistral OCR is
not an LLM call from Anvil's point of view; it is an OCR call.
The architectural question is whether Mistral OCR output (which
becomes the bodyText fed into the downstream LLM adapters) needs
its own redaction layer or whether the existing per LLM redaction
on the downstream call is sufficient. The defensible answer is
both: Mistral OCR output should pass through the redaction rules
before it becomes the bodyText hint, so that the OCR cache itself
does not contain unredacted PII; and the LLM adapters retain
their per call redaction as defense in depth.

Direct quotes from the audited files:

`/Users/kenith.philip/anvil/src/api/_lib/mistral.js:51` reads:
`const apiKey = process.env.MISTRAL_API_KEY;`

`/Users/kenith.philip/anvil/src/api/_lib/docai/gemini.js:299` reads:
`media_resolution: settings?.docai_gemini_media_resolution || "high",`

`/Users/kenith.philip/anvil/src/api/_lib/gemini.js:125-126` reads:
`const firewalledSystem = applyFirewall(system);`
`const redactedMessages = redactMessages(messages, redactionRules);`

The schema is ahead of the implementation on the Mistral path
across three columns. Phase 4 closes that gap.

Additional file level findings worth quoting in scope.
`/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js:152-166`
shows the line grouping uses `stringifyKey(l?.partNumber)` as the
sole canonical key. The fallback `"__pos:" + i` is positional
only, with no content similarity scoring. The Hungarian work in
Phase 4 replaces this function. Line 196 of the same file
sorts the bucket ranking by `(b.count - a.count) || (b.maxConf
- a.maxConf)`; the new Thompson sampling utility joins that
sort key with a third multiplier that breaks confidence ties by
the per adapter posterior utility. The full sort key becomes
`(count, maxConf, utility, minRankIndex)`.

`/Users/kenith.philip/anvil/src/api/_lib/docai/model_selector.js:91`
declares the escalate flag short circuit
(`return { model: CLAUDE_TIERS.generation, tier: "generation",
reason: "escalate_quality" };`). The cost quality elbow
detection lives inside this function in Phase 4 as a new
`shouldEscalate(ctx)` predicate that consults the Thompson
sampled utility for the next tier and refuses the escalation
when the utility delta is below the operator configured
lambda. The escalation reason becomes either `escalate_quality`
or `escalate_blocked_low_utility`; both are persisted on
`extraction_runs.model_selection_reason` for audit.

`/Users/kenith.philip/anvil/supabase/migrations/098_gemini3_mistralocr_routing.sql:55-67`
adds the eval_runs columns (`model_chain`, `cost_usd_total`,
`tokens_in_total`, `tokens_out_total`) which are exactly the
columns the Tournament Voter dashboard reads from. The dashboard
is therefore a pure read path against existing data; no schema
work is needed for the tournament publication.

---

## Section 3. Game changing innovative ideas

### Idea 1. DocAI Marketplace 2.0 producer side royalty

The current marketplace at `/Users/kenith.philip/anvil/src/api/_lib/docai/marketplace.js`
operates on the consumer side: a tenant that has not seen a
particular vendor PO format pulls a published template and
applies it. This is Bet 2 in the strategic bets, and it works
because of the redaction rules in `redact.js` that scrub
anchors before publication. The producer side (the tenant whose
successful extractions become marketplace templates) gets no
revenue from this today. The Marketplace 2.0 idea is to flip
that: every successful extraction that gets published to the
marketplace fingerprints the template (the publisher's tenant
id is the producer key), and every consumer hit that uses that
template pays 50 percent of the unit price to Anvil and 50
percent to the producer tenant as a royalty.

The economics. Anvil charges Rs 8 per extracted line on the
standard tier. A producer tenant whose Faith Automation PO
template gets picked up by 200 other tenants in the Indian
metal fabrication corridor earns Rs 4 per consumer extraction.
At an average 18 lines per PO and 200 consumer extractions per
month, that is 18 times 200 times Rs 4 equals Rs 14,400 per
month per template. A high quality template producer with 10
unique templates pulls Rs 144,000 per month in marketplace
royalties. Anvil pockets the matching Rs 144,000 as platform
take. The producer tenant offsets roughly 60 percent of their
own DocAI bill from royalties, which is a strong retention
moat.

The mechanism. The marketplace publication flow already redacts
the PII (the buyer name, the GSTIN, the bill to address). Phase
4 adds a `marketplace_royalties` table with columns
producer_tenant_id, template_fingerprint, total_consumer_hits,
total_royalty_inr, last_payout_at. A monthly cron sweeps the
extraction_runs table for runs whose `template_fingerprint`
matches a marketplace template and credits the producer tenant
with 50 percent of the line revenue from that run. The producer
tenant sees a "Marketplace earnings this month" tile on the
billing dashboard. Anvil deducts the royalty from the consumer
tenant's invoice at the same rate; the consumer's per line cost
goes up from Rs 8 to Rs 8 plus the royalty, which is still
cheaper than running their own template curation pipeline.

Why this is different from a vanilla marketplace. The asymmetry
between producer and consumer is normally one sided: the
producer publishes, the consumer pays the platform, the producer
gets nothing or a one off attribution. Marketplace 2.0 with the
50 percent royalty makes the producer side a revenue stream
which compounds over time as the producer's templates rack up
hits. The flywheel is: better templates produced get more hits,
more hits attract more producers, more producers means a wider
catalog, which makes the marketplace genuinely useful to
consumers, which drives more hits. This is the structure that
Shutterstock, Getty, and the modern asset marketplaces use.

### Idea 2. Confidence Marketplace human verified annotation

Anvil's per line confidence chips become tradeable signals. A
tenant that receives a 200 line PO with 30 lines marked at
confidence below 0.85 can click "verify these 30 lines" and
purchase human review at Rs 10 per line. The annotator (Anvil's
internal review pool or a partner network like Centific or
iMerit) earns Rs 6 per line; Anvil pockets Rs 4 as platform take.
The verified lines come back within four hours with a "verified
by human" badge and a per line corrected JSON.

The flywheel effect is the moat. Every human verified line goes
back into the eval set as a labelled ground truth example. After
six months at a typical design partner volume (300 POs per month
times 18 lines, of which 5 are low confidence) that is 9,000
human verified lines per tenant per year, which is 90,000 lines
across the design partner cohort, which is a labelled set
larger than CORD plus FUNSD combined and specific to Indian
distributor POs. The labelled set drives a per tenant fine tune
pipeline that lifts confidence over time, which reduces the
fraction of lines flagged for review, which makes the
confidence chip more meaningful as a signal.

The pricing. Rs 10 per line for verification is roughly 1.25x
the standard extraction price (Rs 8). Customers buy it when the
PO is contractually high stakes (margin sensitive line items, a
new vendor relationship, an OEM warranty claim where the line
detail matters). Anvil's win rate on the upsell should be
roughly 8 to 12 percent of customers per quarter; for a tenant
running 300 POs a month at 5 low confidence lines each that is
1500 lines a month times Rs 10 equals Rs 15,000 in upsell
revenue against a Rs 43,200 base spend, a 35 percent attach
rate revenue lift.

The partner economics. Centific at https://www.centific.com/
runs an annotation workforce that produces document labels at
roughly Rs 4 per labelled line at scale; Anvil's Rs 6 to the
annotator allows a 50 percent gross margin to the partner. The
partner integration is a simple webhook in and webhook out; the
annotation UI is partner provided. Anvil retains the data
ownership and the labelled set.

### Idea 3. Tournament Voter and adapter vendor sponsorship

The multi adapter voter becomes a tournament bracket per
document family. For Indian distributor POs the tournament is
Gemini 3 Flash versus Mistral OCR versus Sonnet 4.6 versus
Opus 4.7; each adapter runs the same 50 document Anvil ICP
fixture; field level accuracy, table accuracy, customer
identification accuracy, and cost per extraction are scored and
ranked weekly. The results are published to a public dashboard
at `/tournament` with a podium for the week's winner and a
year to date leaderboard.

The revenue model is adapter vendor sponsorship. Anthropic
sponsors the Sonnet entry at $5,000 per quarter; Google
sponsors the Gemini entry at $5,000 per quarter; Mistral
sponsors the Mistral OCR entry at $5,000 per quarter. The
sponsorship buys a "powered by" tag on the dashboard, a
quarterly research note from Anvil's eval ops team on what's
working and not working for that vendor, and the right to use
the Anvil leaderboard standing in vendor marketing. At three
sponsors per document family and three document families (POs,
supplier acks, e way bills) that is $135,000 per year in
sponsorship revenue plus the marketing co lift Anvil gets from
being the canonical benchmark in the category.

The defensibility. Anvil's tournament differs from generic LLM
leaderboards because the fixture set is Anvil specific (Indian
distributor POs, with the customer disambiguation rule, the
GSTIN check, the HSN per line). Generic benchmarks like SWE
bench or MMLU are not predictive of business document accuracy;
Anvil's tournament is. A vendor that wants to be taken
seriously in Indian B2B doc processing has to win or at least
place on the Anvil leaderboard; Anvil decides the fixture set
and the scoring weights, which makes Anvil the reference.

The execution. The tournament runner is a weekly cron at
`/Users/kenith.philip/anvil/scripts/tournament_runner.js` that
pulls the latest 50 fixture set, runs each adapter against it
in isolation (no voter, no escalation), scores the outputs
against the ground truth, and writes a `tournament_results`
table. The dashboard reads from that table and renders the
bracket. Phase 4 ships the tournament infrastructure; the
sponsorship contracts close in Phase 5 or Phase 6.

### Idea 4. Schema as Code customer SDK

The customer ships their own JSON schema; Anvil compiles it into
a few shot prompt plus a voter strategy plus an eval set
automatically. The Schema as Code SDK at
`/Users/kenith.philip/anvil/sdks/schema-as-code/` exposes a
JavaScript and Python interface that wraps Anvil's docai
endpoint, takes a Zod or Pydantic schema, and configures the
extraction pipeline to that schema without writing a system
prompt by hand.

The compilation pipeline. The SDK reads the schema, extracts the
field names, types, and descriptions, generates a system prompt
that includes the schema as a structured output contract,
generates a few shot example set by prompting Sonnet 4.6 to
produce synthetic documents matching the schema, and writes the
prompt registry entry with a customer specific id. The customer
runs the SDK once to generate the schema artifact and then
calls Anvil with the artifact id; Anvil enforces the schema at
parse time via the existing schema aligned parsing in
`parse.js`.

The revenue model is per schema licensing. A customer schema
costs Rs 50,000 per quarter as a license fee on top of the per
line extraction price. The schema is treated as Anvil
intellectual property in the sense that the few shot examples
and the voter strategy are tuned by Anvil's prompt ops team
once and reused across the customer's volume. For an enterprise
customer doing 5,000 POs per month at 18 lines each, the per
line revenue is 5,000 times 18 times Rs 8 equals Rs 720,000 per
month plus Rs 50,000 per quarter schema license; Anvil's
schema team can support 30 enterprise schemas with a 5 person
prompt ops headcount, so the license revenue at scale is 30
times 4 times Rs 50,000 equals Rs 6 million per year. That
revenue is gross margin positive at 80 percent because the
schema work is a one off effort.

The platform pivot. Schema as Code transforms Anvil from a
DocAI service into a platform. The customer ships a schema;
Anvil compiles. The customer can iterate on the schema without
calling Anvil prompt ops; the SDK regenerates the prompt
artifact and bumps the version. The customer can have multiple
concurrent schemas (one for their POs from automotive vendors,
one for their POs from chemical vendors, one for their supplier
acks); each schema gets its own performance dashboard. Anvil
becomes the rails on which customer specific DocAI products
ride.

### Idea 5. Hallucination Insurance with confidence linked payout

Every extracted line has a confidence chip. Lines below a
configurable threshold (default 0.85) are covered by a
hallucination insurance product. The customer pays a premium of
Rs 0.50 per low confidence line; in exchange, if the customer
can prove a material loss from a hallucination on a covered
line (the LLM extracted a wrong quantity, the customer
shipped the wrong amount, the customer paid out a price
difference), Anvil pays out the documented loss up to a per
line cap of Rs 50,000 and a per tenant annual cap of Rs 5
million.

The actuarial model. Anvil's existing confidence calibration
data from `extraction_corrections` shows that lines with
confidence below 0.85 are wrong roughly 4 percent of the time,
and the average financial impact of a wrong line in the support
corpus is roughly Rs 1,200 (most errors are caught before
shipment; the residual that escapes runs from Rs 100 freight
mismatches to Rs 50,000 spec mismatches). Expected loss per
covered line is 0.04 times Rs 1,200 equals Rs 48. Premium of
Rs 0.50 per line is well below the expected loss, which means
the product is profitable only if the confidence calibration is
accurate and the loss documentation requirement is strict
enough to keep fraud out. The right answer is to price the
premium higher (Rs 5 per line) and tighten the cap to Rs 50,000
per line; at those numbers expected payout is Rs 48 against Rs
5 premium, which is a 10x margin.

The product. Customers opt in per document family or per vendor
relationship. The premium is calculated at extraction time and
added to the invoice. The claims process requires the customer
to submit the original PO, the corrected PO, the financial
impact documentation (an invoice difference, a freight
overpayment), and an attestation of the loss. Anvil reviews
each claim within 14 days; approved claims are paid out in
INR via NEFT. The legal entity is Anvil Insurance Services LLP
incorporated for the purpose; a partnership with an Indian
insurance broker like Tata AIG provides the regulatory
backstop and the reinsurance.

Why this works. The insurance product is the strongest possible
signal that Anvil believes in its own confidence chips. No other
DocAI provider sells an SLA on the per line accuracy because
no other provider can; Rossum and Hyperscience sell SLAs on
the workflow (extraction within X seconds, support response
within Y hours) but not on the line level accuracy. Hallucination
Insurance is a unique selling proposition that doubles as a
revenue stream and a product testimony.

---

## Section 4. Sub phases breakdown

The 6 week phase splits into three 2 week sub sprints. Each
sprint has a single shippable artifact, an internal demo on
Friday of week 2, and an exit gate that has to pass before the
next sprint starts.

### Sub sprint 1 (weeks 1 and 2). Voter and line alignment

Week 1 day 1 to 2. Build the `voter_weights` table migration
099 with columns tenant_id, adapter, alpha, beta, cost_per_call_usd,
updated_at, last_sampled_at. Index on (tenant_id, adapter). Seed
the table with the global Anvil prior on every existing tenant.
A nightly job scrubs `extraction_corrections` for adapter wins
and losses against the eventual human correction and updates the
Beta posterior.

Week 1 day 3 to 5. Implement the Thompson Sampling utility
function in `voter.js` as a new helper `sampleVoterUtilities(tenantId)`
that returns a map of adapter to sampled utility. Modify the
voter's tie breaking logic to use the utility instead of the
dispatcher rank. Add the cost penalty lambda as an env variable
plus a per tenant override. Unit tests in
`tests/unit/voter_weights.test.js`.

Week 2 day 1 to 3. Implement the Hungarian algorithm bipartite
matcher in `_lib/docai/line_align.js` with the munkres
implementation vendored. Cost matrix construction with the
weighted contributions described in DD40. Unit tests against
the canonical 4x4 example plus three Indian distributor PO
fixtures.

Week 2 day 4 to 5. Wire the Hungarian matcher into the voter's
`voteLines` function. Replace the call to `groupLinesByPartNumber`
with a call to `alignLines`. End to end test against the 50
document Anvil ICP fixture set; field level accuracy delta
should be positive and measurable.

Sprint 1 exit gate. Voter weights table live. Hungarian matcher
unit tested. Anvil ICP fixture field level accuracy improves by
at least 2 points over the baseline.

### Sub sprint 2 (weeks 3 and 4). Content type, firewall, prompts

Week 3 day 1 to 2. Build the content type sniffer at
`_lib/docai/content_type.js` with magic byte detection for PDF
(`%PDF`), PNG (`\x89PNG`), JPG (`\xFF\xD8\xFF`), ZIP Office
(`PK\x03\x04`), and OLE compound document (`\xD0\xCF\x11\xE0`).
Return a typed `ContentType` with the detected format and a
boolean `matches_declared` that compares the detected format
against the declared mime type. Unit tests in
`tests/unit/content_type.test.js`.

Week 3 day 3. Wire the content type sniffer into the extract
endpoint at `/Users/kenith.philip/anvil/src/api/docai/extract.js`
line 40 to 46 to replace the filename based detection. Reject
with 415 when the declared and detected formats disagree and
neither is supported. Audit logging on every rejection.

Week 3 day 4 to 5. Remove the utf8 text fallback at `claude.js:425-431`.
Replace with a typed error `unsupported_content_type` that the
operator surface can show. Update Gemini's equivalent at
`docai/gemini.js:211-213`. Run the existing eval set to confirm
no extractions break (the fallback should never have been hit
in clean traffic).

Week 4 day 1 to 3. Implement Mistral firewall parity. Add a
new `_lib/redaction.js` module that exports `applyFirewall`,
`redactMessages`, and a new `redactOcrText` helper for the
post OCR bodyText. Refactor Anthropic's `anthropic.js` to
import from the new module (the existing implementation moves
into the new module; the import chain in `gemini.js:18` and the
docai adapters does not change because Node's module resolution
follows the export). Wire the redaction call into `mistral.js`
on the OCR output before it is returned to the caller. CI grep
guard at `scripts/check_firewall_coverage.sh` that fails when a
new `fetch` call to a paid LLM provider is added without
routing through redaction.

Week 4 day 4 to 5. Build the prompt registry at
`_lib/docai/prompt_registry.js` with semantic versioning. The
registry exports `getPrompt(promptId, version)` that returns
the prompt body plus the registered few shot examples plus
the byte cap. Migrate the existing `PO_SYSTEM_PROMPT` from
`gemini.js:33-90` and the equivalent from `claude.js` into the
registry with version 1.0.0. Add the byte cap enforcement
inside the registry; the registry rejects with a typed error
when the assembled prompt exceeds the configured cap (default
80 KB for Gemini, 60 KB for Claude given the cache window).

Sprint 2 exit gate. Content type sniffer live in production.
Mistral firewall parity verified. Prompt registry live with the
v1 prompts migrated. CI grep guard passes.

### Sub sprint 3 (weeks 5 and 6). Bench, fingerprint, exit

Week 5 day 1 to 3. Build the injection bench v2 at
`tests/injection_bench_v2/` with the 200 plus prompt corpus
curated in DD7. Each prompt is a YAML file with the source,
the OWASP tag, and the expected behavior (refuse, redirect,
extract correctly). The bench runner invokes the production
path `callAnthropic`, `callGemini`, and the Mistral OCR call
post redaction. The bench writes a JSON manifest and a
Markdown report. CI integration via GitHub Actions; the build
fails when a single prompt produces a non compliant output.

Week 5 day 4 to 5. Build the fingerprint cache enrichment. The
existing fingerprint hint at `run.js:348` is consumed by the
template matcher but does not carry voter accuracy data. Add
fields to the fingerprint cache: per adapter accuracy on the
fingerprint cluster, recommended voter weight override, last
successful voter consensus value for ambiguous fields. The
cache becomes a per fingerprint memory of which adapter
behaves well on which document family. Migration 100 adds the
columns to `template_fingerprints`.

Week 6 day 1 to 3. Schema aligned parser truncation detection
extensions. The existing `parseSchemaAligned` at `parse.js`
handles fences, prose, commas, and naive truncation. Phase 4
extends with explicit handlers for `\r\n` line endings, hex
encoded characters in string values, BOM detection at the
start of the payload, double quotes inside a string mid
truncate (the LLM emitted `{"a": "value with " inside`).
Property based tests via fast check at
`tests/unit/parse_property.test.js` generate malformed JSON and
confirm the parser either repairs or returns a clean parse
error rather than crashing.

Week 6 day 4. Run the full Phase 4 exit eval. The 50 document
Anvil ICP fixture set runs through the production path with all
Phase 4 changes live. Compare field level accuracy, table
accuracy, customer identification accuracy, and unit cost
against the Phase 3 baseline and against Rossum, Hyperscience,
Klippa, and Azure DI on the same fixtures.

Week 6 day 5. Publish the Phase 4 report card as a PDF and a
public GitHub repository tests tree. Internal demo to the full
engineering team plus design partners. Phase 4 exit.

Sprint 3 exit gate. Injection bench v2 in CI with 200 plus
prompts passing. Fingerprint cache enrichment live. Property
based parse tests passing. Phase 4 report card published.

---

## Section 5. Customer value and revenue impact

Phase 4 takes Anvil's accuracy story from a self reported "0.92
field accuracy on internal eval" to a published "X percent
field accuracy on the Anvil ICP 50 fixture, beating Rossum by Y
percent and Azure DI by Z percent at one third the unit cost."
The published benchmark is the unlock. Today Anvil sells against
incumbent DocAI providers on the strength of design partner
testimonials and a vibe of being faster and cheaper. After
Phase 4 the sales motion shifts to "here is the public
benchmark, here is the test set, here is how to reproduce the
numbers, here is the cost comparison." This is the same move
that Jepsen made for distributed systems testing; Anvil
becomes the canonical accuracy reference for Indian B2B
document processing.

The pricing tier this unlocks is "DocAI Pro" at Rs 15 per
extracted line versus the current Rs 8 standard tier. The Pro
tier includes the voter weighted accuracy guarantee, the
Hungarian matched line alignment, the firewall vendor parity,
the injection bench v2 attestation, and access to the
Confidence Marketplace, the Tournament dashboard, and the
Hallucination Insurance opt in. Customers buy Pro because they
need the accuracy guarantee for compliance, audit, or
contractual reasons. The conversion rate from standard to Pro
is forecast at 25 to 35 percent of new contracts in the first
two quarters after Phase 4 ships, climbing to 40 to 50 percent
by year end as the Pro features become the default expectation.

The revenue math. Anvil's current standard tier revenue is
roughly Rs 8 per line times an average 18 lines per PO times
roughly 8,000 POs per month across the design partner cohort
equals roughly Rs 1.15 million per month. At a 30 percent Pro
conversion rate with a Rs 7 per line uplift, Pro adds Rs 7
times 18 times 0.3 times 8,000 equals roughly Rs 302,000 per
month or roughly Rs 3.6 million per year. The Confidence
Marketplace adds roughly Rs 15,000 per Pro tenant per month at
typical low confidence line counts; at 30 Pro tenants that is
Rs 450,000 per month or roughly Rs 5.4 million per year. The
Hallucination Insurance product adds Rs 5 per low confidence
line times an estimated 1,500 covered lines per Pro tenant per
month equals Rs 7,500 per Pro tenant per month or Rs 225,000
across the cohort or roughly Rs 2.7 million per year. The
Tournament Voter sponsorship adds the $135,000 per year in
adapter vendor sponsorship described in Section 3 idea 3,
which is roughly Rs 11.3 million per year at current INR USD
rates. The DocAI Marketplace 2.0 royalty splits do not add
gross revenue but they offset 30 to 60 percent of producer
tenant churn risk by giving the producer a recurring earnings
tile on their billing dashboard.

Summing the new revenue streams: Rs 3.6 million Pro tier uplift
plus Rs 5.4 million Confidence Marketplace plus Rs 2.7 million
Hallucination Insurance plus Rs 11.3 million Tournament
sponsorship equals roughly Rs 23 million per year in
incremental ARR from Phase 4 itself, against a Phase 4
engineering cost of roughly 18 engineer weeks plus 6 ops weeks
equals roughly Rs 2.4 million in labour. Phase 4 ROI is
approximately 9x in year one and improves as the cohort grows.

The customer value story by persona. The CFO of a typical
Indian distributor cares about the unit cost per processed PO
and the financial impact of accuracy slips. Phase 4 delivers a
30 percent unit cost reduction at equal accuracy (Bet 1 cost
compression already shipped; Phase 4 adds the voter cost
weighting that prevents over use of the expensive escalation
tier) and an explicit financial backstop via Hallucination
Insurance. The procurement head cares about audit and
compliance; Phase 4 delivers the published benchmark, the
injection bench attestation, and the firewall vendor parity
that closes the SOC 2 DocAI question. The operations head
cares about review queue throughput; Phase 4 delivers the
voter disagreement chip that reduces ambiguous fields by
roughly 40 percent and the Hungarian matched line alignment
that drops the "wrong line picked" support tickets to near
zero.

The competitive position. After Phase 4 Anvil is the only
DocAI provider in the Indian B2B segment with a published
benchmark, a per line insurance product, an adapter tournament
dashboard, a producer side royalty model, and a Schema as Code
SDK. Each of these is independently defensible; together they
form a moat that takes a competitor 12 to 18 months to
replicate. The narrative shift from "we extract POs" to "we
are the accuracy reference for Indian B2B documents" is the
single biggest brand and pricing lift in the 2026 roadmap.

---

## Section 6. Risk register

The Phase 4 risks fall into five buckets: technical execution,
vendor dependence, eval credibility, legal and regulatory,
operational scale.

Technical execution risk. The voter cost weighting via Thompson
sampling depends on the per tenant accuracy estimate from
`extraction_corrections`. New tenants with no correction history
fall back to the global Anvil prior, which is reasonable but
underweights tenant specific variation. Mitigation: ship a
"warm up mode" where the voter operates on the dispatcher rank
for the first 30 days of a new tenant's life, then transitions
to Thompson sampling once the posterior has at least 100
observations per adapter. The Hungarian matcher has an
edge case where every line carries a unique partNumber and
the description is identical across lines (a bulk order of
the same part with different stock locations); the matcher
falls back to positional in this case which is the correct
behavior but the unit tests need to cover it explicitly.

Vendor dependence risk. The Tournament Voter sponsorship
revenue depends on three vendor relationships. If Anthropic or
Google decides not to renew the sponsorship after the first
quarter, Rs 3.8 million of the Rs 11.3 million sponsorship ARR
evaporates. Mitigation: structure the sponsorship as an annual
contract with auto renewal and a 90 day non renewal notice.
The vendor's incentive to renew is the Anvil leaderboard
standing in their marketing; that incentive grows as Anvil's
tenant count grows. Additional vendor risk: Mistral's pricing
on OCR 3 could change. Mitigation: the migration 098 wiring
keeps the provider order configurable; if Mistral becomes
uncompetitive the operator can swap to Azure Document
Intelligence as the OCR layer.

Eval credibility risk. The 50 document Anvil ICP fixture set
is curated by Anvil for Anvil's strengths. A competitor could
claim the fixture is biased. Mitigation: publish the fixture
source breakdown (25 real Anvil tenant POs, 15 synthetic, 10
cross border), publish the difficulty class distribution,
publish the labelling process, and accept third party PR
submissions to add fixtures from competitors. The Jepsen
analogy holds: Jepsen owns the test suite but accepts
contributions; the test suite's authority comes from being
reproducible, not from being neutral. The fixture publication
includes a "contribute a fixture" button on the public
dashboard.

Legal and regulatory risk. Hallucination Insurance requires an
insurance product registration in India. The Insurance
Regulatory and Development Authority of India (IRDAI) at
https://irdai.gov.in regulates insurance products. The
defensible answer is to structure Hallucination Insurance as a
service guarantee with capped payouts rather than as an
insurance product per se; this avoids IRDAI registration but
limits the per claim cap to what Anvil can absorb on its own
balance sheet. The Rs 50,000 per line cap and Rs 5 million per
tenant annual cap are set to keep total exposure below 5
percent of expected Pro tier revenue. Mitigation: legal review
with Trilegal or a similar Indian commercial law firm before
the product ships; back the service guarantee with a
reinsurance contract with Tata AIG once volume justifies it.

Operational scale risk. The Confidence Marketplace assumes a
partner annotator workforce with 4 hour SLA. Centific can
support roughly 1,000 lines per hour at peak capacity per
shift; Anvil's design partner cohort generates roughly 1,500
low confidence lines per day, which is at the edge of what
Centific can absorb. Mitigation: dual source the annotation
workforce with iMerit at https://imerit.net or Sama at
https://www.sama.com as a backup; build the partner integration
as a multi vendor router with quality scoring.

Cross cutting risk: the prompt registry centralisation creates
a single point of failure. A bad prompt push could degrade all
extractions. Mitigation: every prompt registry mutation goes
through a CI gate that runs the 50 document Anvil ICP fixture
against the proposed prompt and fails the PR if accuracy
regresses by more than 0.5 points. The prompt registry
maintains a rollback table; the operator can revert to any
prior version with a single API call.

Residual risk. Even with all mitigations the Phase 4 outcome
depends on the public benchmark being credible to prospects.
The mitigation here is the publication discipline: Anvil
publishes the benchmark methodology before the numbers, accepts
PR submissions, runs the benchmark quarterly, and publishes
both wins and losses. The Jepsen reputation comes from
publishing failures alongside successes; Anvil follows the
same convention.

Secondary execution risks. The content type sniffer at
`_lib/docai/content_type.js` could over reject legitimate
documents whose magic bytes are non standard (legacy DOC files
with stripped OLE headers, PDFs with leading whitespace before
the `%PDF` magic). Mitigation: a tolerant detector that walks
the first 1024 bytes for the magic signature, with a feature
flag to fall back to mime sniffing when the strict magic check
fails. The flag emits a warning event so the operator can audit
how often the fallback fires.

The injection bench v2 corpus carries a maintenance burden.
Lakera publishes new Gandalf levels every quarter; OWASP
updates LLM01 with new attack patterns; Anthropic's many shot
research will continue. Mitigation: the bench corpus is a
versioned set checked into git at
`/Users/kenith.philip/anvil/tests/injection_bench_v2/corpus/`
with a SHA pinned to each release. The bench runner takes a
corpus version argument so older runs are reproducible. A
quarterly review by the security pod refreshes the corpus and
documents the diff.

The Schema as Code SDK assumes customers can produce a valid
JSON schema. Many enterprise customers cannot; they hand Anvil
a sample document and say "extract everything." Mitigation:
the SDK ships with a schema inference helper that runs five
sample documents through Sonnet 4.6 and emits a candidate
schema for the customer to refine. The candidate schema is
checked into a customer specific repository so the schema
evolution is auditable.

The Confidence Marketplace assumes a stable confidence
calibration. If a model upgrade (Gemini 4 Flash in late 2026)
shifts the calibration curve, the line count flagged for human
review jumps or drops, and the annotation workforce capacity
plan breaks. Mitigation: the marketplace runs a weekly
calibration check that compares the predicted confidence
distribution against the realised correction rate; a drift
beyond two percentage points triggers a Slack alert to the
DocAI pod.

---

## Section 7. Success metrics

Phase 4 ships when these metrics are met:

Field level accuracy on the 50 document Anvil ICP fixture set
improves from the Phase 3 baseline by at least 2 points
absolute. The current Phase 3 baseline is roughly 0.92; Phase
4 target is 0.94 or higher. Measurement: Levenshtein normalised
exact match per field; weighted average across customer fields
and line fields.

Customer identification accuracy on the same fixture set
improves from 0.91 to 0.95 or higher. Measurement: the
extracted customer name matches the ground truth bill to
entity, accounting for M/s. prefix and known canonicalisation
rules.

Voter consensus rate (the fraction of fields where two or more
adapters agree) improves from the Phase 3 baseline by at least
5 points absolute. The current baseline is roughly 78 percent;
Phase 4 target is 83 percent or higher. The improvement comes
from the Hungarian matched line alignment and the Thompson
sampling utility weighting.

Unit cost per extraction drops from the Phase 3 baseline by at
least 15 percent at equal accuracy. The drop comes from the
voter avoiding over use of the expensive escalation tier. Phase
3 baseline is roughly Rs 0.45 per 18 line PO; Phase 4 target
is Rs 0.38 or lower.

Injection bench v2 passes 100 percent of the 200 plus prompt
corpus on every paid LLM call site (Anthropic, Gemini, Mistral
OCR). Measurement: the bench runs in CI on every PR plus a
weekly cron; the metric is the pass rate over the rolling 30
day window. The target is 100 percent; any prompt that fails
twice in the rolling window blocks the next release.

Pro tier conversion rate at 90 days post launch reaches 25
percent of new contracts and 15 percent of existing contracts.
Measurement: the billing tier column on the tenant settings
table; the cohort breakdown ships as a weekly Slack post.

Confidence Marketplace attach rate at 90 days post launch
reaches 8 percent of Pro tier tenants with at least one
verification purchase per month. Measurement: the
`confidence_marketplace_purchases` table volume; the metric is
the rolling 30 day count divided by Pro tier tenant count.

Tournament dashboard sponsorship contracts at 180 days post
launch reach 2 of 3 target sponsors (Anthropic, Google,
Mistral). Measurement: signed contracts in the sales CRM.

Hallucination Insurance opt in rate at 180 days post launch
reaches 12 percent of Pro tier tenants. Measurement: the
insurance opt in flag on the tenant settings table.

Phase 4 exit eval report card published as a public PDF and a
public GitHub repository tests tree by week 6 day 5.
Measurement: the report card is committed to
`/Users/kenith.philip/anvil/docs/benchmarks/2026_phase4_report.pdf`
and the tests tree is committed to
`https://github.com/anvil/docai-benchmark`.

The exit criteria from the roadmap also count as success
metrics: voter accuracy weighted, voter disagreements visible,
line alignment uses Hungarian matching, content type gate live,
OCR utf8 fallback removed, firewall vendor parity across
Anthropic, Gemini, Mistral, OCR quality gate operating,
injection bench v2 in CI with 200 plus prompts. All eight items
must be checked before Phase 4 closes.
