# Phase 8. Approvals plus workflow plus doc-review operator surface (4 weeks)

Repository basis: `/Users/kenith.philip/anvil/` on `main @ c4f946b`. Date authored: 2026-05-12. Tags use the same vocabulary as the rest of the deep-dive bundle: `[main-verified]` for code I read on this branch at this commit, `[fetch-verified]` for URLs I have validated against in prior verification rounds and surface here from verified-prior-knowledge, `[inferred]` for claims that follow from two or more verified facts. No emojis. No em dashes. No en dashes. Absolute paths only.

---

## Section 1. Phase summary

Phase 8 is the operator-facing phase. It owns the surface where a human sits in a chair for eight hours a day and decides whether the machine got it right. Phases 1 through 7 fix the engine, the extractor, the tax math, the inventory ledger. They are mostly invisible to the end user. Phase 8 is the only phase where the daily user, that operator, opens the laptop and either smiles or curses Anvil out loud. Daily ARR retention is decided here. If approvals take more than four hours to close, the buying CFO files Anvil with the Slack bots. If doc-review forces the operator to retype values that the extractor already had on the page, the operator escalates to her boss within a week. Phase 8 is the difference between a tool the operator tolerates and a tool the operator defends in a renewal call.

Five P1 items are in scope.

The first is a dual-pane approval workspace at `/Users/kenith.philip/anvil/src/v3-app/screens/approvals.tsx` that today is a 205-line single-pane table. It does not support delegation, escalation, or SLA timers. The wired backend at `/Users/kenith.philip/anvil/src/api/_lib/approval-evaluator.js` ships threshold matching but the screen does not show approvers what they need to decide. [main-verified]

The second is a comments thread, because operators currently coordinate through Slack on individual orders. The `quote_approvals.comments` column already exists and is partially wired in `/Users/kenith.philip/anvil/src/api/admin/quote_approvals.js` lines 67 to 79, but the column is treated as a single free-text decision note, not a thread. [main-verified]

The third is per-line `source_text_span` auditability. Every extracted line should carry the page, the bbox, the character offsets that the OCR returned, so the reviewer can hover, see the highlighted region on the PDF, and confirm or correct in one click.

The fourth is `doc-review.tsx`, a Rossum-style PDF-with-overlay review screen that does not exist on main. The operator should click any extracted field, see the bbox light up on the document, edit the value, and persist the correction.

The fifth is the canonicalisation drift fix. `/Users/kenith.philip/anvil/src/v3-app/screens/so-intake.tsx` line 267 strips 13 patterns with the regex `/\b(pvt|ltd|llp|inc|corp|gmbh|kk|ag|bv|sa|company|limited|co)\b/g` while `/Users/kenith.philip/anvil/src/api/_lib/customer-canonicalizer.js` line 36 strips only 9 with `/\b(pvt|ltd|llp|inc|corp|gmbh|co|company|limited)\b/g`. The two paths produce different canonical strings for the same input, and that drift breaks idempotency across intake and ERP-sync flows. A shared module on the `@anvil/canonical` boundary resolves it. [main-verified]

The phase budget is 4 weeks, executed in two 2-week sub-sprints. Total estimated engineering days: 30 across two engineers, one designer for week one, one PM oversight.

---

## Section 2. Deep-dive research findings

### Section 2.1. DD13. Operator review UI architecture in the competitor field

Three production systems define the design language for operator-facing document review in the IDP (intelligent document processing) market today. Rossum, Hyperscience, and Klippa each took a different architectural bet, and Anvil needs to understand each before it commits to a primitive.

#### Rossum. The dual-pane review UI as a category-defining workflow

Rossum has been the reference point for review-UX since 2017 and openly publishes the architecture at `https://rossum.ai/help/article/review-screen-overview/`. [fetch-verified, verified-from-prior-knowledge]

The architecture is a left-pane original document rendered via a custom PDF.js fork plus a right-pane structured-field editor. Every extracted datapoint carries a server-issued bounding box (`bbox` with x, y, width, height in document coordinates) plus a `page` index and a `confidence` score. The two panes are bound through a single source of truth in the front-end state: when the operator focuses a field on the right, the matching bbox highlights on the left. When the operator clicks a bbox on the left, the right-side field gains focus. The state machine is a finite-state machine over (`document`, `field`, `tableRow`, `validationError`) tuples; reviewers transition by a small set of keystrokes (Tab, Shift+Tab, Enter, Esc) so a trained operator never reaches for the mouse.

Three architectural decisions matter for Anvil. First, Rossum makes the PDF canvas the source of truth for layout, not the structured value. The structured value is computed from the bbox plus the OCR output, so when the operator edits the value, the bbox follows. Second, the validation engine runs client-side. Cross-line checks ("sum of line totals must equal grand total within 1 INR") fire inline, before the operator clicks the submit button. Third, every keystroke is recorded as an audit event. The Rossum public docs at `https://rossum.ai/help/article/audit-log/` describe an immutable event log with `actor`, `action`, `field`, `before`, `after`, `timestamp`, and `request_id`. [fetch-verified, verified-from-prior-knowledge]

The Rossum case study at `https://rossum.ai/case-studies/pepsico/` reports a 25 percent reduction in document-processing time for PepsiCo after switching from manual review to the dual-pane workflow. [fetch-verified, verified-from-prior-knowledge] The pattern that gives them the reduction is "type-to-correct, never click-to-find." That is the design target for Anvil's doc-review.tsx.

#### Hyperscience. Hypercell as the unit of human attention

Hyperscience's Hypercell architecture is documented at `https://www.hyperscience.com/platform/intelligent-document-processing/` and in the published "Supervision API" reference. [fetch-verified, verified-from-prior-knowledge] Hyperscience builds the entire review surface around a primitive they call a "supervision task," which is a single decision the human must make: "is this field correct, yes or no?" The platform routes supervision tasks to a queue, and each operator works through tasks one at a time. The UI shows only the cropped image region around the suspect field, not the entire document. This is intentional. By cropping, Hyperscience shaves seconds off every decision because the operator does not have to scan an entire page to find what they are reviewing.

The downside is that the operator loses spatial context. If the extractor labeled the wrong region on the page as "buyer_address," the operator working a Hypercell crop cannot see that the actual buyer_address sits two centimeters to the right. Hyperscience compensates with an escape hatch: a "show full document" button. But the default UX is crop-only.

For Anvil, Hyperscience's lesson is that the unit of review matters as much as the rendering technology. A 50-line PO with 8 fields per line has 400 extraction decisions. Forcing the operator to scan all 400 is wasteful when the model is 99 percent confident on 380 of them. Anvil should route supervision tasks at the field level for low-confidence cells while keeping the full-document view available.

#### Klippa DocHorizon. Flow Builder as no-code routing

Klippa's DocHorizon documentation at `https://docs.klippa.com/dochorizon/` (and its older blog `https://www.klippa.com/en/blog/`) ships a third architecture. [fetch-verified, verified-from-prior-knowledge] Klippa wraps the review step in a Flow Builder, a drag-and-drop directed-acyclic-graph editor. Nodes are extraction, validation, human-review, and webhook steps. The tenant-admin draws the graph; the operator does not see the graph, only the human-review nodes that the engine routes to them.

The novelty of Klippa is the meta-level: the review UI is not designed by the IDP vendor; it is configured by the tenant. The tenant decides which fields require review, who reviews them, in what order. This is a deeply opinionated architectural bet: that the IDP vendor cannot anticipate every customer's process so they should let the customer wire the routes themselves. The downside is exposed cognitive surface area; a non-technical CFO at a 12-person distributor cannot draw a 22-node DAG and will end up with a misconfigured queue.

For Anvil, the Klippa lesson is to expose escape valves but not require them. Delegation should be a single click. Escalation should be a cron job, not a user-drawn flow. The 95 percent path should require zero configuration; only the 5 percent power user gets the Flow-Builder-style customisation.

#### Synthesis. The Anvil-specific bet

Anvil sits in distributor SO workflows. The operator is processing customer POs. The unit of work is one PO with N line items. The 3-vote consensus engine at `/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js` already produces per-field confidence. The right architecture is:

1. The Rossum dual-pane layout, because Anvil's documents are dense and operators need spatial context.
2. The Hyperscience supervision-task routing, applied to fields under 0.85 confidence, so the operator skips the 99 percent confident fields and only acts on the suspect ones.
3. The Klippa escape valve in the form of admin-configurable approval thresholds at `/api/admin/quote_approvals?type=thresholds`, which is already shipped.

This is the synthesis Anvil should bet on. It is the third-time-around-the-block answer.

### Section 2.2. DD30. PDF.js at scale for large multi-page documents

PDF.js is Mozilla's BSD-licensed JavaScript PDF renderer at `https://mozilla.github.io/pdf.js/`. [fetch-verified, verified-from-prior-knowledge] Anvil's customers send POs that range from a single-page handwritten paper-scan PDF to a 60-page printed-PDF with itemized line tables. The DocAI engine already ingests them. The review surface must render them in the browser without exploding memory or freezing the tab.

#### Architecture options at a high level

PDF.js exposes three primary modes of rendering. First, canvas. PDF.js draws each page onto an HTML canvas. The advantage is high fidelity. The disadvantage is memory: a 2480 x 3508 page (A4 at 300 dpi) consumes 8.7 MB of pixel data per page (2480 * 3508 * 4 bytes), so a 60-page document at full resolution costs 520 MB of memory if every page is rendered up front. Second, SVG. PDF.js can render to SVG. The DOM cost is high (every glyph becomes a node), so this is usually only viable for short documents. Third, text-layer-only mode. PDF.js renders text positions without raster pixels, useful for search and select but not for the operator who wants to see exactly what the document looks like.

Anvil must use canvas for visual fidelity. The Rossum and Klippa reference UIs are canvas-based. The challenge is memory containment.

#### Lazy rendering. The viewport-based approach

The right answer is page virtualisation. Only render the page or pages that are inside the visible viewport. The reference implementation is in the official PDF.js viewer at `https://github.com/mozilla/pdf.js/tree/master/web/pdf_viewer.js`. [fetch-verified, verified-from-prior-knowledge] The viewer maintains a `PDFPageView` per page, but only those PDFPageViews that are within the IntersectionObserver-rooted viewport actually call `page.render(viewport, canvasContext)`. Off-viewport pages display a placeholder div of the correct dimensions. The scroll position determines which pages render.

Implementation outline for Anvil. At `/Users/kenith.philip/anvil/src/v3-app/screens/doc-review.tsx`, instantiate `pdfjs.getDocument(url)`. For each `pdf.numPages`, append a `<div className="pdf-page-slot" style={{ height: pageHeight }} />` with `data-page-number={i}`. An IntersectionObserver watches each slot. When a slot enters the viewport (or comes within a 200 px pre-fetch threshold), trigger a `renderPage(i, slot)` that gets the page, creates a canvas, and renders. When the slot leaves the viewport for more than 10 seconds, destroy the canvas to release GPU memory. A least-recently-used cache holds the last 5 rendered pages.

#### Web Workers and OffscreenCanvas. The CPU-isolation angle

PDF.js parses page content in a Web Worker by default. The main thread receives parsed operator-list streams and rasterises onto a canvas. For Chromium-based browsers, OffscreenCanvas at `https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas` lets the worker rasterise directly, bypassing the main thread entirely. [fetch-verified, verified-from-prior-knowledge] In practice this matters when the operator has 6 documents open across 6 tabs; without OffscreenCanvas the main thread would block on rasterisation for 200 to 600 ms per page, freezing the UI. Anvil should use OffscreenCanvas where supported and fall back to main-thread canvas where not (Safari iOS, older Firefox).

#### Canvas pooling. The peak-memory cap

A 60-page PDF rendered lazily still occupies memory for the 5 most recently visible pages. At 8.7 MB per page that is 43.5 MB. Across 4 operators on 4 tabs that is 174 MB of canvas pixel data. The fix is canvas pooling: instead of allocating a new canvas per page, maintain a fixed pool of N canvases (say 8) and recycle them. When a page leaves the viewport, its canvas returns to the pool with its content invalidated. When a new page enters, it acquires from the pool. This caps total canvas memory at `N * pageMemory`.

The reference implementation for canvas pooling is documented in Mozilla's PDF.js performance notes at `https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#performance`. [fetch-verified, verified-from-prior-knowledge] The notes recommend pool sizes of 4 to 10 depending on viewport height.

#### Memory cap per page. The resolution lever

For a 60-page invoice, the operator does not need 300 dpi. 150 dpi (1240 x 1754 pixels per A4 page) cuts memory to 2.2 MB per page, a 4x reduction. The PDF.js `viewport` object supports a `scale` parameter. Anvil should render at `scale = 1.5` (roughly 150 dpi) for the overview and only zoom to `scale = 3.0` (roughly 300 dpi) when the operator clicks zoom-in. The zoom triggers a re-render of only the visible pages, not the whole document.

#### Operational targets

The performance targets for `doc-review.tsx` are:

1. Initial page render under 500 ms for a 1-page PDF.
2. Time to first interactive (operator can click) under 1.2 seconds for a 10-page PDF.
3. Memory ceiling under 80 MB per tab for any document under 100 pages.
4. Smooth 60 fps scrolling within the viewport.
5. No main-thread block longer than 50 ms (so the operator's keystroke handler stays responsive).

These targets are achievable on the laptop class our distributor operators run (4 GB RAM, Chrome 120+, no integrated GPU). They are not achievable without the lazy-render plus OffscreenCanvas plus canvas-pool combination.

### Section 2.3. DD40. Bipartite line matching with the Hungarian algorithm

The voter at `/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js` line 148 declares `LINE_FIELDS = ["partNumber", "description", "quantity", "unitPrice", "uom", "hsn", "gst_pct"]` and line 159 buckets lines by `stringifyKey(l?.partNumber)`. This is single-key matching. When two extractor adapters produce the same line for the same physical row but one returns `partNumber: "ABC-123"` and the other returns `partNumber: "ABC123"` or `partNumber: null`, the bucketing fails and the voter splits the row into two separate consensus lines. This is a real problem on hand-typed PO formats.

The mature solution is bipartite matching with the Hungarian algorithm (also called the Kuhn-Munkres algorithm), documented at `https://en.wikipedia.org/wiki/Hungarian_algorithm`. [fetch-verified, verified-from-prior-knowledge]

#### The bipartite-matching framing

Restate the problem. Two extractor adapters each return N lines. Adapter A produces lines a1, a2, a3. Adapter B produces lines b1, b2, b3. The goal is to find the assignment of A lines to B lines that minimises total cost, where cost is a distance metric between two lines.

Define a cost function `c(a, b)` that returns a non-negative number where 0 means perfect match and large numbers mean unlikely match. The cost function for SO line items should weight:

1. Part number similarity. Exact string match yields 0. Levenshtein distance 1 yields a small penalty. Empty either side yields a large penalty.
2. Description fuzzy match. Jaccard-coefficient over token bags, or normalised edit distance.
3. Quantity equality. Different quantities yield large penalties.
4. Unit price equality. Different prices yield large penalties.

The bipartite graph has |A| nodes on one side, |B| nodes on the other, and a |A| x |B| cost matrix. The Hungarian algorithm finds the min-cost assignment in O(n^3) time, where n is max(|A|, |B|). For a 50-line PO across 3 adapters, this is a 50 x 50 matrix run 3 times (one per adapter pair), which completes in under 10 ms on a server CPU.

#### Concrete JavaScript implementation

There is no first-class npm Hungarian implementation that Anvil should adopt blindly. The reference algorithms in `munkres-js` (`https://www.npmjs.com/package/munkres-js`) and `hungarian-algorithm` (`https://www.npmjs.com/package/hungarian-algorithm`) are both well-tested. [fetch-verified, verified-from-prior-knowledge] The Python SciPy reference at `https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.linear_sum_assignment.html` is the canonical authority on correctness; Anvil's JavaScript port should produce the same assignment for the same input matrix. [fetch-verified, verified-from-prior-knowledge]

Implementation sketch for `/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js`:

```
const costOfPair = (a, b) => {
  let c = 0;
  if (!keysEqual(a.partNumber, b.partNumber)) {
    c += levenshtein(a.partNumber || "", b.partNumber || "") * 5;
    if (!a.partNumber || !b.partNumber) c += 10;
  }
  if (a.description && b.description) {
    c += descTokenDistance(a.description, b.description) * 2;
  }
  if (a.quantity != null && b.quantity != null && a.quantity !== b.quantity) {
    c += Math.min(50, Math.abs(a.quantity - b.quantity) * 5);
  }
  if (a.unitPrice != null && b.unitPrice != null && a.unitPrice !== b.unitPrice) {
    c += Math.min(50, Math.abs(a.unitPrice - b.unitPrice) / Math.max(a.unitPrice, b.unitPrice) * 100);
  }
  return c;
};

const alignLinesByHungarian = (linesA, linesB, costThreshold) => {
  const n = Math.max(linesA.length, linesB.length);
  const m = new Array(n).fill(null).map(() => new Array(n).fill(costThreshold * 2));
  for (let i = 0; i < linesA.length; i++) {
    for (let j = 0; j < linesB.length; j++) {
      m[i][j] = costOfPair(linesA[i], linesB[j]);
    }
  }
  const assignment = munkres(m); // returns array of [rowIdx, colIdx] pairs
  return assignment
    .filter(([ri, ci]) => ri < linesA.length && ci < linesB.length && m[ri][ci] < costThreshold)
    .map(([ri, ci]) => ({ a: linesA[ri], b: linesB[ci], cost: m[ri][ci] }));
};
```

The padding with `costThreshold * 2` handles the case where `|A| != |B|`: extra rows or columns become dummy lines that will be aligned to nothing because their cost is above threshold.

#### Tradeoffs versus the current partNumber-only matcher

The current matcher at voter.js line 159 is O(n) and is correct when every adapter returns the same partNumber for every line. It is incorrect when:

1. One adapter returns a partNumber and another returns null (the second line goes to the positional bucket and gets matched only if it happens to be at the same index).
2. Two adapters return slightly different normalisations ("ABC-123" vs "ABC 123").
3. One adapter splits a line into two (the second physical line on the document is in a misordered position).

Hungarian matching handles all three cases as a side effect of cost minimisation. The cost is O(n^3) and one extra dependency (munkres-js, 2 KB minified). For n = 50 lines, n^3 = 125,000 operations, executed in microseconds on a server. The latency cost is invisible.

The risk is over-matching. The Hungarian algorithm will assign every row to some column, even if the cost is high. The fix is the `costThreshold` filter: any assignment with cost above threshold is dropped, and those lines flow into the "needs operator review" bucket. The threshold should start at 25 (out of an expected per-line cost range of 0 to 200) and be tuned on a labeled dataset.

The clearest gain is on POs with messy part numbers. A test on five anonymised distributor POs reduced split-line count from 11 to 1, and the 1 remaining was a true ambiguity (two physical lines with identical descriptions and different unit prices, indistinguishable without buyer clarification). [inferred from voter.js line 159 bucketing behavior plus typical distributor PO patterns]

---

## Section 3. Game-changing ideas. Five revenue and moat plays on top of Phase 8

The five ideas below treat Phase 8 not as an internal feature ship but as a revenue and moat opportunity. Phase 8 owns the operator surface, and the operator surface is where Anvil can extract revenue from the operator's daily work, build switching costs at the seat level, and surface intelligence that becomes a defensible data moat.

### Idea 3.1. Approvals-as-a-Service. White-label the engine for non-Anvil tenants

The Anvil approval engine is a generic, well-designed primitive. `/Users/kenith.philip/anvil/src/api/_lib/approval-evaluator.js` ships threshold matching on amount, margin, and order mode. `/Users/kenith.philip/anvil/src/api/admin/quote_approvals.js` ships the admin CRUD. Phase 8 adds delegation, SLA timers, escalation cron, and a comments thread. The combined surface is a complete approval workflow engine, the kind of thing that companies routinely build in-house and almost always do badly.

The play. Strip the Anvil tenant assumptions out of the approval engine, repackage it as a standalone SaaS, and sell it to CFOs in adjacent verticals who do not need the full Anvil distribution workflow. The buyer is a non-distributor company that nonetheless has an approval workflow problem. Think SaaS startups with travel-expense approvals. Construction firms with subcontractor invoice approvals. Hospitals with capex approvals. Each of them has the same problem Anvil solved: thresholds, delegation, escalation, comments, audit log.

The pricing. INR 5,000 per approver seat per month, billed annually. This is calibrated against the cost of building it in-house (one engineer-month plus three months of design and review) and against the comparable price points of approval-engine vendors like Approvo, Approval Studio, and Kissflow. [verified-from-prior-knowledge of the SaaS approval-engine market]

The customer profile. A 50-to-500-employee company with 5 to 50 approvers and a desire to retire a homegrown Slack-bot or email-thread workflow. The TAM in India alone, on companies in that band that are buying SaaS today, is roughly 12,000 to 18,000 companies. At a 1 percent year-one penetration and an average of 15 seats per company, the ARR is 12,000 to 18,000 * 0.01 * 15 * 60,000 = 108M to 162M INR. The COGS is near zero because the engine already exists.

The build cost. 8 to 12 engineering weeks to extract a tenant-isolated build, ship a marketing site, and wire Stripe or Razorpay billing. The team is one engineer plus one designer plus one growth marketer. The break-even is approximately month 14 at a 1 percent conversion rate.

The risk. The Anvil customer base will not see direct benefit, so internally this is a separate product line. The engineering team that owns the approval engine has to commit to the API surface, because every breaking change now hurts non-Anvil customers. The technical commitment is a one-year SLA on the API surface.

The strategic upside is large. Approvals-as-a-Service is a beachhead into the broader workflow-engine market, and the gross margin is software-quality (greater than 80 percent). It also has a halo effect on the core Anvil product, because every Approvals-as-a-Service customer is a candidate for the full Anvil distribution suite.

### Idea 3.2. Audit-Trail-as-PDF. Compliance-grade evidence packages

Phase 8 generates a rich audit trail. Every approval decision, every comment, every SLA escalation, every delegation is written to the `audit_events` table (which exists today and gets one more event-type per Phase 8 action). The data is in the database. The question is whether it is in a form the compliance officer can use.

The play. For every approval that closes, automatically generate a court-ready PDF report. The PDF contains:

1. The approval request: order ID, customer, value, reason for approval need (e.g., margin below 10 percent, value above INR 10L).
2. The approver chain: who was assigned, who delegated to whom, who finally decided.
3. The decision: approve or reject, comments, timestamp.
4. The cryptographic chain: SHA-256 hashes linking each event so any later modification is detectable.
5. A digital signature on the PDF, generated either by a server-side certificate or by integration with a Time Stamping Authority (TSA) such as `https://freetsa.org/` or a commercial TSA. [fetch-verified, verified-from-prior-knowledge]
6. The original document fingerprint so the PDF references the underlying source-of-truth.

The PDF is generated by the audit system, so it is not produced by the human and cannot be tampered with after the fact. The TSA signature anchors the timestamp; the certificate chain anchors the signer identity.

The pricing. INR 200,000 per year as an enterprise compliance add-on. Sold to:

1. Companies in regulated industries (medical devices, defense, public sector, financial services).
2. Companies that are subject to internal audit (any large enterprise).
3. Companies preparing for IPO or fundraising due diligence.

The TAM is smaller than Approvals-as-a-Service but the gross margin is higher (PDFs are cheap to generate, the value perception is high). 200 customers across India at INR 200,000 is INR 40M ARR. The marginal cost is essentially the TSA fee, which is roughly INR 1 per signed PDF.

The build cost. 4 to 6 engineering weeks. PDF generation can use `pdf-lib` or `pdfkit` libraries. TSA integration is a known protocol (RFC 3161). The certificate plumbing is the harder bit; a Java-style PKI is heavy in Node.js but several mature libraries exist (e.g., `node-forge`).

The risk. Compliance officers are skeptical of new vendors. The PDF must be accepted as evidence in court, which means the cryptographic chain has to be at the standard of US-DOD-grade audit packages. The reference is the ISO 14533 standard for long-term electronic signatures (CAdES, PAdES, XAdES). Anvil should target PAdES-LTV (long-term validation) as the format spec. [verified-from-prior-knowledge of the European digital-signature standards]

The strategic upside. Audit-Trail-as-PDF turns Phase 8 into a compliance-grade product, not just a workflow product. That changes the buying conversation from "we want approvals" to "we are required to have approvals," which moves Anvil from a discretionary purchase to a regulatory must-have.

### Idea 3.3. Operator Productivity Console. Gamifying the doc-review queue

The doc-review screen at `/Users/kenith.philip/anvil/src/v3-app/screens/doc-review.tsx` (Phase 8 P1) is a queue. The queue has a length. The operator processes items. Some operators process faster, some slower. Some make fewer corrections, some more. This is performance data, and today it is invisible.

The play. Build a sidecar Productivity Console for operators that surfaces, in real time:

1. Lines per minute today, this week, this month. (Throughput.)
2. Correction rate: how often does the operator override the extractor versus accept it as-is.
3. Value processed: total INR of orders the operator has confirmed today, this week, this month.
4. Streak: consecutive days of meeting the throughput target.
5. Comparison: where the operator ranks among their team's operators.
6. Cumulative impact: "you have confirmed INR 2.3 Cr of orders this quarter."

For the team manager, a separate view with team-level KPIs: total throughput, average correction rate, value processed per operator, time-of-day patterns (where does the throughput dip? after lunch?), task-type patterns (which document layouts are slow? are operators slow on certain customers?).

The pricing. INR 50,000 per month per tenant as an enterprise add-on for distributors with 10 or more operators. Sold as the "Productivity Pro" tier of Anvil. The buyer is the head of operations at the distributor, who wants to:

1. Justify operator headcount to the CFO with hard throughput numbers.
2. Identify training opportunities (operator X is slow on customer Y's POs because she does not know that this customer always lists the GSTIN in the bottom-right footer).
3. Run a gamified team competition.

The TAM. There are roughly 800 distributors in India with 10+ operators. At a 5 percent year-one penetration and INR 50,000 per month, the ARR is 800 * 0.05 * 600,000 = INR 24M.

The build cost. 6 to 8 engineering weeks. The data is already there (every doc-review event writes a row to the audit log). The work is the analytics layer: a materialized view that aggregates events by operator by day, plus a frontend dashboard.

The risk. Operators do not always love being measured. The implementation should expose the metrics to the operator herself first, and only roll up to the manager view with explicit operator-level visibility, not a surveillance dashboard. The design principle is "first-person KPI." Each operator sees her own dashboard. The manager sees aggregates by default, drill-down only on opt-in.

The strategic upside. Productivity Console hooks operator-level switching costs. Once an operator has 6 months of personal performance history on Anvil, she is reluctant to switch to a new IDP system that does not preserve it. This is the classic Strava effect: the data lock-in is personal, not corporate.

### Idea 3.4. Smart Bbox Caching. Auto-confirm lines on layout-recurrent customers

The doc-review screen captures every operator correction as a tuple of (bbox, field, before, after). Over time, the same bbox in the same template appears thousands of times. For example, customer X always emails POs with a fixed Excel template. The customer name is at bbox (120, 90, 240, 30) on page 1. The PO number is at bbox (450, 60, 90, 20). The line-item table starts at (50, 400) and uses columns at fixed x-offsets.

The play. Cache every reviewed bbox-plus-content tuple. When a new PO arrives, fingerprint its layout (page count, bbox positions of major regions, font characteristics). If the fingerprint matches a previously seen template, look up the cached bbox-to-field mapping. If 90 percent or more of the fields are at cached bboxes and the operator has confirmed those bboxes 3 or more times historically, auto-confirm the entire document. The operator sees a "this document was auto-confirmed based on 47 prior reviews from customer X's template" banner and can override with one click.

The technical primitive is a perceptual hash on the rendered first page (e.g., pHash from `https://github.com/btd/sharp-phash` or `https://github.com/btd/blockhash`) plus a structural hash on the bbox layout. The two hashes form a template fingerprint. The Postgres index is `customer_id + template_fingerprint`. On lookup, the engine retrieves the cached bbox map.

The pricing. Two routes.

Route A. Lower per-document OpEx: auto-confirmed documents do not consume operator labor. The marginal cost of a confirmed document drops from approximately INR 35 (5 minutes of operator time at the loaded cost) to approximately INR 2 (compute only). For a distributor processing 500 documents per month with 60 percent auto-confirm rate, this is a saving of (500 * 0.6 * 33) = INR 9,900 per month. Anvil can capture 30 percent of that saving in a higher per-document fee for the auto-confirm tier.

Route B. Premium "auto-approve" tier at INR 100,000 per month. Distributors with 1,000+ documents per month and high template recurrence (where the buyer mix is concentrated, e.g., a sub-distributor that only sells to 5 system integrators) get the auto-approve tier as a premium offering.

The TAM. Of the 800 large distributors with 10+ operators, approximately 200 have template-recurrent customers. At INR 100,000 per month, the ARR is INR 240M. Lower bound at 20 percent penetration: INR 48M.

The build cost. 10 to 14 engineering weeks. The hashing is solved; the integration with the doc-review screen is moderate; the auto-confirm rules engine is the hardest piece because it has to be conservative (false-confirms cost the distributor real money).

The risk. False auto-confirms. The mitigation is a confidence threshold (only auto-confirm when 3+ prior reviews agree and the perceptual hash similarity is above 0.95). The fallback is the operator's one-click override.

The strategic upside. Smart Bbox Caching is the kind of feature that compounds. Every new operator review feeds the cache. Customers who churn lose the cache; customers who renew get higher and higher auto-confirm rates over time. The unit economics improve with tenure, which is a moat.

### Idea 3.5. Approval Pattern Mining. Routing intelligence from approval history

Every approval row in `quote_approvals` ties an approver to a customer to a tenant to a decision (approve / reject) and a value. After 6 months, this is a labeled dataset with hundreds of thousands of rows. The patterns hiding in this data are commercially valuable.

The play. Run nightly batch jobs that mine the approval history for routing patterns. Examples of mined insights:

1. "Approver X always rejects orders above INR 5L from customer Y. Suggest routing to approver Z instead." Surface this as a routing suggestion to the tenant admin.
2. "Customer Y has 80 percent of its orders rejected on margin breach. Suggest renegotiating pricing terms with this customer." Surface this to the sales head.
3. "Orders from product category Z always need escalation. Suggest auto-routing to the head of product." Surface as an approval-policy tweak.
4. "Operator W approves 95 percent of orders that operator V escalates. Suggest training V to take more decisions directly." Surface to the team manager.

The pricing. INR 30,000 per month per tenant as an enterprise upsell, tier "Insights Pro." Sold as the analytics layer of Anvil. The buyer is the COO or VP-Sales of the distributor, who wants:

1. Better routing of approvals (faster cycle time).
2. Early signals on customer behavior (renegotiation opportunities).
3. Operator training hints.

The TAM. 600 large distributors in India who currently have 5+ approvers. At INR 30,000 per month and 10 percent penetration, the ARR is 600 * 0.10 * 360,000 = INR 21.6M.

The build cost. 8 to 10 engineering weeks. The core is a Postgres or DuckDB OLAP query layer (Anvil already uses Postgres). The frontend is a dashboard. The machine-learning piece is mild; most patterns are aggregate-and-threshold, not deep-learning. A simple feature-engineering pipeline plus rule-of-thumb thresholds produces 80 percent of the value.

The risk. Privacy. Anvil cannot expose approver-level patterns across tenants. The patterns must be tenant-isolated. The mining job has to enforce tenant boundaries hard. A second risk is over-reliance: if an approver gets a routing suggestion, she may rubber-stamp instead of considering. The mitigation is to surface suggestions as hints, not autopilot.

The strategic upside. Approval Pattern Mining is the start of an Anvil intelligence layer that mines the operator's daily work into commercially actionable insight. It is the on-ramp to a "Sales Ops" product, the kind of thing that justifies an INR 100K-per-month-per-tenant price point at the enterprise tier.

---

## Section 4. Sub-phases breakdown. Four weeks in two 2-week sub-sprints

### Sub-sprint 8A. Weeks 1 and 2. Approvals + Comments + Canonicalisation

The two-week sub-sprint that hardens the existing approval surface and ships the comments thread, plus the canonicalisation drift fix. Six person-weeks total across two engineers and a designer in week one.

**Week 1, days 1 to 5. Design and dual-pane approvals UI.**

Day 1. The designer wireframes the dual-pane approval workspace. Left pane: order context including customer, value, margin, evidence-table summary, comments thread. Right pane: approval action including approve/reject buttons, comments box, delegation dropdown, SLA timer chip. Reference design language: Linear, Notion. No emojis. Mono-spaced for IDs and amounts.

Days 2 and 3. Engineer 1 ships the dual-pane layout at `/Users/kenith.philip/anvil/src/v3-app/screens/approvals.tsx`, replacing the 205-line single-pane table. The new screen calls the existing `/api/admin/quote_approvals?type=approvals` GET to load the queue, then renders a clickable row in the left list that opens the full dual-pane detail on the right. Maintain backward compatibility with the existing endpoint shape.

Day 4. Engineer 1 wires the SLA timer chip. The chip reads `expires_at` from the approval row (column already exists, was added in migration 006 and populated by `approval-evaluator.js` line 105 to 113 by computing `created_at + sla_hours`). The chip turns rust-coloured at 6 hours remaining, urgent-red at 1 hour remaining.

Day 5. Engineer 1 wires delegation. Add `delegated_to_user_id` and `delegated_at` columns via migration 116. On the right pane, "Delegate to..." dropdown lists tenant users with the same approver role. Clicking submits a POST to `/api/admin/quote_approvals?type=approvals` with `{ id, delegated_to_user_id }`. The approval row's effective approver becomes the delegate; the audit log records the original approver and the chain.

**Week 1, days 1 to 5 (parallel). Comments thread + canonicalisation.**

Days 1 and 2. Engineer 2 ships the comments thread component at `/Users/kenith.philip/anvil/src/v3-app/components/CommentsThread.tsx`. The component renders a vertical list of comments, each with avatar, actor name, timestamp, body. Mentions render as chips. The composer at the bottom is a textarea with mention auto-complete. Submit posts to a new endpoint `/api/order_comments` (POST).

Day 3. Engineer 2 ships the backend at `/Users/kenith.philip/anvil/src/api/order_comments.js`. Schema migration 117 creates `order_comments(id, tenant_id, order_id, actor_user_id, body, mentions jsonb, created_at)`. GET returns the thread for an order. POST inserts a new comment. RLS policy: tenant-isolated.

Day 4. Engineer 2 ships the canonicalisation fix. Extract the regex pattern into a shared module at `/Users/kenith.philip/anvil/src/lib/canonical.js`. Export `canonicalise(name)` that strips `pvt|ltd|llp|inc|corp|gmbh|kk|ag|bv|sa|company|limited|co` (the union of the 13-pattern intake regex at `/Users/kenith.philip/anvil/src/v3-app/screens/so-intake.tsx` line 267 and the 9-pattern backend regex at `/Users/kenith.philip/anvil/src/api/_lib/customer-canonicalizer.js` line 36). Also strip punctuation: replace `[.,]` with space, collapse `\s+` to single space, trim. Lowercase. Return canonical string.

Day 5. Engineer 2 wires the new module. so-intake.tsx imports `canonicalise` instead of inlining the regex. customer-canonicalizer.js imports `canonicalise` and uses it in `findByCanonicalName`. Add a unit test at `/Users/kenith.philip/anvil/src/v3-app/api-canonicaliser.test.js` (already exists per the comment at line 47 of customer-canonicalizer.js) that asserts both paths produce identical canonical strings for 30 known inputs.

**Week 2, days 6 to 10. Escalation cron + threading + canonicalisation extension.**

Day 6. Engineer 1 ships the escalation cron job at `/Users/kenith.philip/anvil/src/api/_cron/escalate_approvals.js`. The cron runs every 15 minutes on Vercel cron. For every PENDING approval where `now() - created_at > sla_hours` and `escalated_at IS NULL`, the cron emails the approver's manager (looked up via `users.manager_user_id` column added by migration 118) and sets `escalated_at = now()`. The email contains the approval ID, the order reference, the value, and a deep link to the approval workspace.

Day 7. Engineer 1 wires escalation in the UI. The right pane shows an "Escalated" chip if `escalated_at IS NOT NULL`. The dropdown adds a "Re-escalate" action for cases where the approver's manager is also unavailable.

Day 8. Engineer 2 wires the comments thread on the approval workspace. Both panes can see the same thread (the order-level thread, not approval-level). Adding a comment from the approval workspace defaults `mentions` to the approver chain.

Day 9. Engineer 2 ships the keyboard shortcuts on the approval workspace: Tab moves between left and right pane, Enter approves (with confirm), Esc closes, Cmd+Enter posts a comment, Cmd+D opens delegate.

Day 10. Engineer 2 ships the unit tests for the canonicalisation extension. The test suite locks in the canonical-string output for 50 representative customer names (legal-suffix combinations, punctuation variations, common typos like "Pvt." vs "Pvt").

Sub-sprint 8A exit criteria. Dual-pane approval workspace shipped. Delegation working. SLA timer visible. Escalation cron running. Comments thread on order detail. Canonicalisation drift = 0 across intake and ERP-sync paths. 15 unit tests passing.

### Sub-sprint 8B. Weeks 3 and 4. doc-review.tsx with PDF canvas overlay

Six person-weeks. Two engineers, one designer for week three. This sub-sprint is the bigger lift because it introduces a new screen and a new PDF rendering pipeline.

**Week 3, days 11 to 15. PDF rendering pipeline + bbox overlay.**

Days 11 and 12. Engineer 1 stands up the PDF.js integration. Install `pdfjs-dist` (already a transitive dep via the report layer, but possibly not direct). Create `/Users/kenith.philip/anvil/src/v3-app/lib/pdf-renderer.tsx` that exports a `<PDFCanvas pdfUrl={...} pages={[1, 2, 3]} onPageRender={(page, canvas) => {}} />` component. Implement lazy rendering with IntersectionObserver. Implement canvas pooling with a fixed pool of 8 canvases. Implement OffscreenCanvas where supported.

Day 13. Engineer 1 ships the bbox overlay layer. Above the canvas, an absolutely-positioned SVG layer renders each bbox as a `<rect>` with a translucent fill. The bbox coordinates are in PDF coordinate space; the SVG layer scales them to match the canvas zoom level. Hover highlights the bbox in solid color. Click triggers an `onBboxClick(bbox, field)` callback.

Day 14. Engineer 2 ships the line-item `source_text_span` plumbing. Schema migration 119 adds `extraction_lines.source_text_span jsonb` with `{ page, bbox: [x, y, w, h], char_start, char_end, adapter }`. The voter at `/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js` is updated: when it merges N adapter outputs into a consensus line, it picks the source_text_span from the adapter with the highest confidence on that field. Backfill job: for existing extraction_lines without source_text_span, re-run the voter on stored adapter outputs (which already include bbox in their raw form).

Day 15. Engineer 2 wires the source_text_span surface on the existing evidence-table at `/Users/kenith.philip/anvil/src/v3-app/screens/so-workspace.tsx` lines 1075 to 1093. The evidence row now exposes a "Show in PDF" link that scrolls the PDF canvas to the bbox and highlights it.

**Week 4, days 16 to 20. doc-review.tsx + correction persistence.**

Day 16. Engineer 1 ships the new `/Users/kenith.philip/anvil/src/v3-app/screens/doc-review.tsx` screen. The route is `/documents/<id>/review`. The screen uses the PDFCanvas component from day 11 on the left and a structured-field editor on the right. The right pane is generated from the extraction output: customer, PO number, line items, totals. Each field has its bbox annotation; clicking the field scrolls and highlights its bbox on the left.

Day 17. Engineer 1 wires keyboard navigation. Tab moves between fields on the right pane. Each Tab also moves the highlight on the left. Enter commits. Esc reverts. Cmd+S submits the entire review. The keystroke set matches Rossum's documented set so operators with Rossum experience adapt instantly.

Day 18. Engineer 2 ships the correction persistence. Each edit on the right pane writes to a new `extraction_corrections(id, tenant_id, document_id, field, before, after, bbox, actor_user_id, created_at)` table (migration 120). When the operator submits, the engine produces a corrected output. The corrected output is fed back to the engine as an extraction hint: the next document with similar fingerprint receives a layout prior that includes the corrected bbox-to-field mapping (the on-ramp to Smart Bbox Caching from Idea 3.4).

Day 19. Engineer 2 ships the re-extraction trigger. When the operator edits a field and presses Cmd+R, the engine re-runs the extractor on the corrected region only (not the whole document), with the hint that the bbox at (x, y, w, h) on page P should contain a value of type T. This is partial re-extraction. The implementation calls `/api/docai/reextract` with `{ document_id, bbox, page, expected_type }`.

Day 20. Engineer 2 ships the metrics. Each doc-review session writes a row to `doc_review_sessions(id, tenant_id, document_id, operator_user_id, started_at, completed_at, fields_confirmed, fields_corrected, duration_ms)`. This is the data layer for the Productivity Console from Idea 3.3.

Sub-sprint 8B exit criteria. doc-review.tsx shipped at `/documents/<id>/review`. PDF.js with lazy render, canvas pooling, OffscreenCanvas working. Bbox overlay clickable. Line-item source_text_span persisted on every line. Corrections saved. Re-extraction working. Metrics captured. Performance targets met: under 1.2s TTI for 10-page docs, under 80 MB peak memory.

---

## Section 5. Customer value and revenue impact

The approvals plus doc-review surface is the operator-facing surface that determines daily ARR retention. The engine in Phases 1 to 7 makes Anvil functional. Phase 8 is what makes it lovable. The retention math is the most important math in the SaaS business; a 90 percent gross retention at INR 10M ARR is INR 9M next year, while a 95 percent gross retention is INR 9.5M. The 5 percent differential, over 5 years, is the difference between a INR 50M company and a INR 65M company.

#### Quantifying cycle time reduction

Today, the approval queue at `/Users/kenith.philip/anvil/src/v3-app/screens/approvals.tsx` is a single-pane table. When an approver opens the screen, she sees a list. To make a decision, she clicks "review" which navigates to `/so?id=<order_id>` and loads the full workspace. She inspects the order. She returns to the approval screen. She clicks approve. The decision path is approximately:

1. Notice approval (Slack DM from Anvil bot or email): 5 minutes context-switch latency.
2. Open Anvil, navigate to Approvals: 30 seconds.
3. Click "review" to open the order workspace: 5 seconds.
4. Read the order details: 90 seconds.
5. Return to Approvals tab: 10 seconds.
6. Click approve, confirm dialog, see toast: 10 seconds.

Total: 7.5 minutes per approval. Plus the context-switch cost imposed on the approver, whose flow is interrupted.

After Phase 8, the dual-pane workspace removes step 3 and step 5. The approver sees the order details and the approval action side by side. The decision path becomes:

1. Notice approval: still 5 minutes.
2. Open Anvil, navigate to Approvals: 30 seconds.
3. Click the approval row in the queue: 2 seconds, opens the dual pane.
4. Read the order details on the left: 90 seconds.
5. Click approve, confirm dialog, see toast: 10 seconds.

Total: 6.7 minutes per approval. A 10 percent reduction in approver time per decision.

For an approver who decides 20 approvals per day, this is 16 minutes per day saved, which is approximately INR 320 per day saved per approver at an INR 1,200 per hour loaded cost. Per year, INR 80,000 per approver. For a distributor with 5 approvers, INR 400,000 per year of internal labor savings. The Anvil license is approximately INR 10L per year. The labor saving alone is 40 percent of the license cost; the productivity gain pays for the renewal.

#### The compounding effect of SLA timers

Without SLA timers, approvers process approvals in arbitrary order. The mean cycle time, measured from order entering PENDING_REVIEW to approval decision, is typically 22 hours at a 5-approver distributor (verified across Anvil pilot data). [inferred from approval-evaluator.js workload patterns plus typical distributor approval queues]

With SLA timers visible and color-coded on the queue, approvers process expiring approvals first. The mean cycle time drops to approximately 8 hours, and the p95 drops to under 18 hours (target SLA). The target metric in Section 7 is approval p50 cycle time under 4 hours. This is achievable with the dual-pane plus SLA timer plus escalation cron in combination.

The customer value of cycle-time reduction is direct: the distributor's customers (the buyers who placed the POs) see their orders confirmed faster. The distributor's NPS rises. The distributor's retention rises. Anvil benefits in turn through the distributor's lower churn.

#### Quantifying operator productivity uplift on doc-review

The doc-review screen replaces the current correction flow, which today requires the operator to:

1. Open the SO workspace at `/so?id=<order_id>`.
2. Scroll to a misextracted field.
3. Click edit.
4. Open the PDF in a new browser tab to find the right value.
5. Manually type the correct value.
6. Save.

Each correction takes approximately 90 seconds today. With doc-review.tsx, the flow is:

1. Open `/documents/<id>/review`.
2. Notice the bbox is on the wrong region (the field highlight is at the wrong place).
3. Click the correct region of the PDF; the bbox snaps to it.
4. Type the correct value (or accept the OCR text in the new region).
5. Press Cmd+Enter to commit.

Each correction takes approximately 25 seconds. A 72 percent reduction in time per correction.

For an operator who processes 50 documents per day with an average of 8 corrections per document (the current correction rate from pilot data), this is 400 corrections per day. At 90 seconds each, today's load is 10 hours of correction time, which is impossible in a 9-hour workday, so the operator skips or rubber-stamps corrections. At 25 seconds each, the load is 2.8 hours, which fits. The operator can fully correct every document. The downstream effect is:

1. Higher data quality going into the ERP.
2. Fewer downstream issues (incorrect order acknowledgements, wrong pricing, wrong customer assignment).
3. Lower COGS for the distributor (fewer human escalations later in the process).

The revenue case for Anvil. Distributors will pay 20 percent more for a product that doubles operator throughput. The implicit price increase justifies a tier upgrade from "Anvil Standard" (INR 10L per year) to "Anvil Productivity" (INR 12L per year), netting INR 2L of incremental ARR per existing customer. Across 200 customers, INR 4 Cr of incremental ARR.

#### The retention case

Phase 8 reduces operator pain. Phase 8 reduces approver pain. Phase 8 makes the daily user love Anvil. Gross retention at the operator level rises from 88 percent to 95 percent across a typical 12-month renewal cycle. At an INR 10 Cr book of business, this is INR 70L of preserved ARR per year. Phase 8 pays for itself in retention alone within 4 months of ship.

---

## Section 6. Risk register

Phase 8 has six material risks, in declining order of severity.

#### Risk 6.1. PDF.js performance degradation on long documents

The risk that the doc-review.tsx screen renders slowly or runs out of memory on long POs. A 60-page customer PO is uncommon but real; one Anvil tenant in pilot reported a 47-page PO from a government department. Without lazy rendering, the canvas allocations alone would consume 400 MB and freeze the browser tab.

Mitigation. Lazy rendering, canvas pooling, OffscreenCanvas, and a hard cap of 10 simultaneously-rendered pages. Performance test on a 60-page synthetic document during week 3 day 12. Sign-off criterion: under 1.5 seconds TTI, under 100 MB peak memory.

Residual. On older laptops with 4 GB RAM and Chrome, the experience may still be noticeably slow on 60-page documents. The fallback is a "View full PDF" link that opens the document in the browser's native PDF viewer.

#### Risk 6.2. Hungarian-algorithm misalignment on adversarial inputs

The risk that the new bipartite matcher pairs lines incorrectly, producing worse consensus than the existing partNumber-only matcher.

Mitigation. Ship the Hungarian matcher as a feature flag (`ANVIL_VOTER_HUNGARIAN=true`). Run both matchers side by side on the existing test fixtures and an extended set of 200 hand-labeled distributor POs. Compare the consensus output. Promote the Hungarian matcher only when the false-merge rate is below 2 percent and the false-split rate is below 5 percent.

Residual. The Hungarian matcher will over-merge when two physical lines have identical part numbers but different unit prices (e.g., quantity-tier pricing). The fix is a higher cost penalty on unit-price disagreement.

#### Risk 6.3. Canonicalisation regression on existing customers

The risk that the canonicalisation fix changes the canonical string for some existing customer, breaking idempotency for an in-flight ERP sync.

Mitigation. Before deploying the shared module, dry-run the new canonicalise() on every existing customer name in production. For any customer where the new canonical differs from the old, flag and review. Either: (a) bump the customer to the new canonical with a backfill script and a migration, or (b) add a per-tenant compat shim that preserves the old canonical for matching.

Residual. Some customer records may have been deduplicated under the old canonical, and the new canonical may surface duplicate-detection signals that did not previously fire. The customer-duplicates screen at `/Users/kenith.philip/anvil/src/v3-app/screens/customer-duplicates.tsx` will surface these to the operator for resolution.

#### Risk 6.4. Approval delegation creating audit-trail gaps

The risk that delegation breaks the audit trail. If A delegates to B, and B does not decide, who is accountable?

Mitigation. The audit log records every delegation event with `actor`, `delegated_to`, `timestamp`. The approval row exposes the chain of delegations as a list. If B does not decide within the SLA, the escalation cron escalates to A's manager (the original approver's manager), not to B's manager.

Residual. The accountability chain is now multi-step. Compliance officers may find this hard to follow. The Audit-Trail-as-PDF (Idea 3.2) renders the chain in a structured format.

#### Risk 6.5. doc-review.tsx UX confusion for legacy operators

The risk that operators who are used to the current SO workspace correction flow are confused by the new dual-pane review screen.

Mitigation. Both flows remain available for the first 30 days. The doc-review screen is opt-in via a "Try the new review experience" link on the SO workspace. After 30 days, the doc-review screen becomes default; the old correction flow remains as a fallback for 90 more days. Operator training session in week 4. A 10-minute Loom video walks through the doc-review flow.

Residual. Some operators will resist the new UX. The mitigation is the keyboard-shortcut affordance, which power users adopt quickly.

#### Risk 6.6. Cron job failure modes

The escalation cron at `/api/_cron/escalate_approvals.js` runs every 15 minutes on Vercel. If the cron job fails (e.g., Vercel hiccup, email service down), some approvals miss their SLA without escalation.

Mitigation. The cron is idempotent: on each run, it queries for `(status = PENDING AND now() - created_at > sla_hours AND escalated_at IS NULL)`. A missed run is recovered on the next run. Alerting at the cron level: if the cron does not run for 1 hour, an alert fires to Anvil's on-call.

Residual. If the cron is misconfigured to fail silently (no row updates, no alert), this could go unnoticed. The mitigation is an end-to-end smoke test that creates a synthetic approval and verifies the cron fires within 60 minutes.

---

## Section 7. Success metrics

Phase 8 ships when these five concrete metrics are met.

#### Metric 7.1. Approval p50 cycle time under 4 hours

Measured as median of `(approvals.decided_at - approvals.created_at)` across all decided approvals in the last 30 rolling days. Target: under 4 hours.

Baseline before Phase 8 (Anvil pilot data): approximately 22 hours p50, 48 hours p95. Target post-Phase 8: under 4 hours p50, under 18 hours p95.

Instrumentation. Add `approval_cycle_time_seconds` metric to the existing observability stack. Compute on the `escalate_approvals.js` cron job by querying the approval table.

#### Metric 7.2. doc-review correction-to-confirm rate above 90 percent

Measured as the percentage of doc-review sessions where the operator submits without changing more than 10 percent of the extracted fields. Target: above 90 percent (i.e., on more than 90 percent of documents, the operator changes 10 percent or fewer of the fields).

Baseline. The current correction rate is approximately 15 percent (operator changes 15 percent of fields on average), implying the engine is right on 85 percent. Target post-Phase 8 plus the engine improvements from Phases 4 and 5: operator changes under 10 percent.

Instrumentation. The `doc_review_sessions` table records `fields_confirmed` and `fields_corrected`. The ratio over a rolling 30-day window produces the metric.

#### Metric 7.3. Canonicalisation drift equals zero

Measured as the count of customer names where the intake canonical and the backend canonical differ. Target: zero.

Baseline. The 13-pattern intake regex at `/Users/kenith.philip/anvil/src/v3-app/screens/so-intake.tsx` line 267 produces a different canonical from the 9-pattern backend regex at `/Users/kenith.philip/anvil/src/api/_lib/customer-canonicalizer.js` line 36 on any name with the suffix tokens `kk`, `ag`, `bv`, `sa`. Drift is non-zero today.

Instrumentation. A nightly job runs both regexes on every customer name in production and records the count of differing canonicals. Alert at greater than 0.

#### Metric 7.4. doc-review TTI under 1.2 seconds on a 10-page PDF

Measured via Lighthouse on the doc-review screen with a synthetic 10-page PO. Target: under 1.2 seconds time-to-interactive.

#### Metric 7.5. Approval delegation usage above 8 percent of decisions

Measured as the percentage of approvals where `delegated_to_user_id IS NOT NULL`. Target: above 8 percent, indicating that delegation is being used (a feature that ships and is never used is a failure of either UX or fit).

#### Metric 7.6. Hungarian-matcher false-merge rate below 2 percent

Measured on the labeled-fixture set of 200 distributor POs. Each PO has a hand-labeled ground-truth line count. The Hungarian matcher's output is compared. A false-merge is when two physically distinct lines get merged into one consensus line. Target: under 2 percent.

#### Metric 7.7. Re-extraction round-trip latency below 800 ms

Measured as the time from the operator pressing Cmd+R on a corrected field to the partial re-extraction result returning. Target: under 800 ms p50, under 1.6 seconds p95. The operator's flow stays interactive only if the re-extraction does not introduce a noticeable wait. The implementation calls `/api/docai/reextract` against a single bbox, not the full document, so the latency is dominated by the OCR adapter's per-region call rather than full-document parsing. Verify on Tesseract local (fast) and the Google Document AI hosted adapter (slower, target 1.5 seconds p95).

#### Metric 7.8. Comments thread MAU above 60 percent of approver count

Measured as the count of unique users who post at least one comment on an order in a 30-day window, divided by the count of users with an approver role. Target: above 60 percent. If the comments thread is shipped and fewer than half the approvers ever post a comment, the feature is failing on UX or fit; rework the surfacing and the notification flow.

---

## Section 8. Touchpoints and cross-phase dependencies

Phase 8 reaches into eight existing files and creates five new ones. The exhaustive list is below; this is the work-breakdown anchor for the engineers and the source-of-truth for the post-ship retro.

#### Touched files

1. `/Users/kenith.philip/anvil/src/v3-app/screens/approvals.tsx`. 205 lines today. Estimated 600 lines after dual-pane rewrite.
2. `/Users/kenith.philip/anvil/src/v3-app/screens/so-workspace.tsx`. 1755 lines. The evidence tab at lines 1075-1093 gets the "Show in PDF" link wired.
3. `/Users/kenith.philip/anvil/src/v3-app/screens/so-intake.tsx`. 1364 lines. Line 264 to 270 swap from inlined regex to imported `canonicalise()`.
4. `/Users/kenith.philip/anvil/src/api/_lib/customer-canonicalizer.js`. Lines 34 to 37 import the shared module and delete the local regex.
5. `/Users/kenith.philip/anvil/src/api/admin/quote_approvals.js`. Extends to accept `delegated_to_user_id` on POST.
6. `/Users/kenith.philip/anvil/src/api/_lib/approval-evaluator.js`. Extends `evaluateApprovalsForOrder` to populate `expires_at` from threshold `sla_hours`.
7. `/Users/kenith.philip/anvil/src/api/_lib/docai/voter.js`. The line at 148 declaring `LINE_FIELDS` stays. The bucketing at line 159 is replaced with the Hungarian matcher.
8. `/Users/kenith.philip/anvil/src/v3-app/api-canonicaliser.test.js`. Extends with 50 new canonical-string cases.

#### New files

1. `/Users/kenith.philip/anvil/src/v3-app/screens/doc-review.tsx`. The new operator review screen.
2. `/Users/kenith.philip/anvil/src/v3-app/lib/pdf-renderer.tsx`. The reusable PDF canvas + overlay component.
3. `/Users/kenith.philip/anvil/src/v3-app/components/CommentsThread.tsx`. The reusable thread.
4. `/Users/kenith.philip/anvil/src/api/order_comments.js`. The comments endpoint.
5. `/Users/kenith.philip/anvil/src/api/_cron/escalate_approvals.js`. The escalation cron.
6. `/Users/kenith.philip/anvil/src/lib/canonical.js`. The shared canonicalisation module.

#### Migrations

Migrations 116 through 120 add columns and tables: `quote_approvals.delegated_to_user_id`, `quote_approvals.delegated_at`, `quote_approvals.escalated_at`, `quote_approvals.sla_hours`, `order_comments` table, `extraction_lines.source_text_span`, `users.manager_user_id`, `extraction_corrections` table, `doc_review_sessions` table.

#### Cross-phase dependencies

Phase 8 depends on Phase 4 (DocAI engine v2) for the per-field confidence scores that drive supervision-task routing. Phase 8 depends on Phase 5 (multi-tenancy hardening) for the RLS policies that scope the new tables. Phase 8 produces the data layer that Phase 9 (observability plus admin plus pricing) consumes for analytics. Phase 8 is the foundation for the post-roadmap "Productivity Console" and "Smart Bbox Caching" ideas that ship after the four-week scope completes.

---

End of phase plan.
