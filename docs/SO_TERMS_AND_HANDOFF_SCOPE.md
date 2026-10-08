# SO terms check, Mode B register and order-processing handoff

Design document. Docs only. Nothing in this file is built yet, except where a row says "in progress" or "exists".

| | |
|---|---|
| Status | Design. Awaiting owner decisions (section 11). |
| Verified against | `origin/main` at `05ba982d` on 2026-10-08. The gap analysis was taken at `ee69526b`. The one commit between them (#565, the DocAI circuit breaker) does not touch any file this design depends on. |
| Line numbers | Exact on `05ba982d`. They drift. Search for the symbol if a line has moved. |
| Migrations | 250 (terms) and 251 (handoff). See section 9. |
| PRs | Nine design PRs, in merge order, in section 10. Seven fix PRs from the same plan are in progress now (section 2.7). |

---

## 1. Goal, Mode B and non-goals

### 1.1 Goal

The first customer asked for three things.

1. **A qualitative check of terms.** Today SO processing compares quantity and price against the quote. It does not compare the terms. Anvil must flag each place where the PO's terms or wording differ from the quote's terms. It must show the PO wording and the quote wording side by side. The sales engineer decides per flag: accept, request an amendment, or reject the term. Anvil records and audits the decision.
2. **Mode B.** Anvil is the repository of every sales order received and analysed. The rest of the process stays in the ERP (Tally). Integration stays minimal in the short term.
3. **A one-click handoff.** After the SO is logged, the sales engineer emails the order processing team the inputs for the ERP. Anvil prefills that email and sends it with one click. The inputs are:
   - the material required date;
   - the contact name;
   - the contact phone;
   - the shipment mode. Imported spares go by ocean or air. Locally manufactured or procured spares go by road, hand carry by the customer, or hand carry by our engineer.

### 1.2 Mode B definition

Mode B is a tenant setting (`tenant_settings.so_processing_mode = 'B'`, migration `221_so_processing_mode.sql`). In this document Mode B means the following.

| Anvil does | The ERP (Tally) does |
|---|---|
| Receives every PO, from every channel. | Sales order voucher entry. |
| Extracts the PO and matches the lines to the quote. | Stock and reservation. |
| Checks the terms and records the engineer's decisions. | Procurement orders. |
| Sends the handoff email to the order processing team. | Dispatch, e-way bill, invoice. |
| Keeps a copy of the ERP sales order (uploaded PDF) and scores it against the PO. | Payment follow-up. |

The only integration in the short term is the handoff email out and the ERP sales order PDF back in. No Tally bridge is needed for Mode B.

### 1.3 Non-goals

- No Tally push in Mode B. Anvil never posts a voucher for a Mode B tenant.
- No automatic decision. The LLM never accepts, rejects or suggests a decision. Nothing is auto-accepted.
- No email to the customer without an explicit click on a preview.
- No change to the quantity and price reconcile. It exists and stays as it is, apart from the fixes in progress.
- No contract lifecycle management, redlining or legal advice. Anvil shows the difference. A person decides.
- No edit of the PO or of the quote. Decisions are recorded beside them.
- No new queue and no new cron. Every email in this design is sent in the request.
- No work-order entity, no dispatch planning and no invoicing in Mode B. Those stay in Tally.

---

## 2. What exists today

### 2.1 Verdict per requirement

| # | Requirement | Exists | Missing |
|---|---|---|---|
| 1 | Terms check with a recorded decision | Two header checks: payment terms and incoterm. Both show "PO x vs quote y" lines in the Reconcile banner. | Every other clause. A PO-side terms extraction. A quote-side clause model. Any decision. Any audit of a decision. |
| 2 | Mode B repository | The tenant switch. It refuses the Tally push. The orders list shows every order. The three-way PO / Anvil / ERP report exists. | A register with analysis, terms, handoff and ERP status. A screen to upload the ERP SO. Server-side analysis for orders that do not come through the intake screen. Mode B in `tally/retry.js`. (Several of these are in progress, see 2.7.) |
| 3 | One-click handoff email | A working direct-send pattern. Most input fields exist somewhere. The SO PDF already prints contact, phone, due dates and an origin marker. | An internal recipient setting. Role-to-address resolution. A handoff endpoint, screen, template and status. A PO delivery date and contact name in the two main PO extractors. A shipment mode per origin group. "Hand carry by our engineer". |

### 2.2 Terms checks today

| Check | Where | What it does | Problem |
|---|---|---|---|
| Payment terms | `comparePaymentTerms` at `src/api/_lib/quote-reconcile.js:86`, called at `src/api/orders/reconcile_quotes.js:131-147` | Compares day counts, else normalized text. Flag `payment_terms_mismatch`. | Ignores the basis (invoice, GRN, dispatch) and the advance percentage. Compares against the primary quote only. The PO side may be the customer master (2.4). |
| Incoterm | `parseIncoterm` at `quote-reconcile.js:111`, `compareIncoterms` at `:123`, called at `reconcile_quotes.js:148-175` | Compares the rule code, then the place. | False mismatch. The quote select at `reconcile_quotes.js:61-63` reads `terms` only, so the quote side falls back to the payment-terms text. The PO side is the operator's Header value, not PO text. **Fix in progress (PR 1).** |
| Display | `src/v3-app/screens/so-workspace.tsx:2267-2288` | Warning lines "PO 'x' vs quote 'y'". | No decision, no audit, no evidence link. |
| Three-way payment terms | `src/api/_lib/three-way-report.js:136-146` | PO vs Anvil vs ERP on the day count. | Nothing writes Anvil's side, so it is always empty. A terms decision would give it a value. |

No code compares warranty, LD, price basis, freight, insurance, taxes, validity, inspection, cancellation or jurisdiction.

### 2.3 PO side: what the extractors read

| Path | Terms it reads | Evidence |
|---|---|---|
| Claude PO tool | `customer.payment_terms` only, verbatim | prompt `src/api/_lib/docai/claude.js:164`, schema `:1374` |
| Gemini `PO_SCHEMA` | `customer.payment_terms` only, verbatim | prompt `src/api/_lib/docai/gemini.js:65, 76`, schema `:256, 277` |
| LlamaParse | Line `delivery_date` only | `src/api/_lib/docai/llamaparse.js:356, 561-564` |
| `po-header-text.js` | No terms | reads number, date, vendor code, currency, buyer name, total |

- No PO schema has a slot for incoterm, lead time, warranty, LD, price basis, freight, insurance, taxes, validity, inspection, cancellation or jurisdiction.
- No PO schema has a contact person name. `email` and `phone` are the printed contact.
- `delivery_date` is a canonical line field (`src/api/_lib/docai/line-schema.js:45`). Only LlamaParse fills it. The Claude prompt treats "Delivery date :..." in a description cell as boilerplate (`claude.js:177`). This is a fifth instance of the claude/gemini drift pattern.

### 2.4 PO side: where the full text is, and where it is lost

- **Large POs skip T&C pages.** At 25 pages or more (`PROFILER_PAGE_THRESHOLD`, `src/api/_lib/docai/run.js:954`, env-overridable), the TOC profiler labels pages (`toc-profiler.js:41-45`, enum at `:88`) and only `line_item_pages` reach the extractor (`run.js:955-986`). Per-page labels are not stored.
- **The full text is cached.** `extraction_text_layer.body_text` (migration `089_extraction_text_layer.sql:38`) and `extraction_ocr_layer.body_text` (`091:23-31`) hold the whole document. They are written for every PDF (`run.js:174-209`, `:219-259`).
- **Two limits.** `body_text` is capped at 200 KB (`text_layer.js:60`). Pages are joined with a blank line and no page marker (`text_layer.js:242`). So page attribution needs the geometry blocks, not `body_text` alone.
- **Geometry for evidence.** `run.js:1392-1418` builds per-page text blocks (OCR layer, else the PDF text layer) and stamps line evidence. `buildBlockIndex` is at `src/api/_lib/docai/bbox-evidence.js:83`. The UI reads `bbox_norm` (`so-workspace.tsx:329`).
- **Provenance trap.** With `grounding_verify_enabled` on and no payment terms on the PO, grounding copies the customer master value into `customer.payment_terms` (`grounding.js:125-128`, applied at `run.js:1262-1298`). The only trace is a run event. The reconciler then labels the master value "PO".
- **Operator values.** `orders.incoterm_code`, `delivery_terms`, `dispatch_mode` and `committed_delivery_date` are typed on the Header tab (columns from `106:353-357` and `207`). The reconciler's "PO incoterm" is the operator's value.

### 2.5 Quote side

| Source | What it holds | Gap |
|---|---|---|
| Anvil quote (`quotes`, migration 068) | `terms` (free text), `notes`, `validity_days`, `expires_at` (`068:57-69`) | No incoterm column. No snapshot. |
| Our typed clauses (`document_templates`, `106:37-43`) | `payment_terms_clause`, `delivery_terms_clause`, `warranty_clause`, `penalty_clause`, `cancellation_clause`, `force_majeure_clause`, `other_conditions` | Read at render time only (`quotes/pdf.js:108-113`, template lookup `:204-214`). An edit after sending changes the record. |
| What the customer actually receives | The quote PDF renderer `QuoteDoc` takes `notes` only (`src/api/_lib/pdf-renderer.js:147-164`). It drops every clause field. `quotes/send.js:245-268` passes no `quotes.terms` and no template clauses. The email body carries validity only (`quotes/send.js:304-324`). | **New finding.** An Anvil-sent quote carries no payment, delivery, warranty or LD terms that the customer can see. A snapshot proves what Anvil held, not what the customer read, until the PDF prints the clauses. |
| Customer terms packs (`106:412-435`) | The CUSTOMER's standard T&C as clauses, with `is_blocking` and unused `acknowledged_at/by` | Useful as a baseline for that customer. It is not our offer. |
| Uploaded external quote | `QUOTE_TOOL` reads `validity`, `payment_terms`, `delivery_terms`, `incoterm`, `notes` (`claude.js:794-814`). `notes` excludes warranty, cancellation and jurisdiction (`:684-686`). | `quoteHeadFromExtract` keeps only `terms` and `notes` (`src/api/_lib/quote-ingest.js:170-182`). It drops `incoterm`, `delivery_terms` and `validity`. |
| Opportunity quotes (`203`) | An uploaded PDF per revision, with `document_id` | No terms. The reconciler does not read them. |

### 2.6 Handoff inputs today

| Input | Sources that exist | Gap |
|---|---|---|
| Material required date | Line `delivery_date` (LlamaParse only). `order_schedule_lines.scheduled_date` (manual). `orders.committed_delivery_date` (manual). | Claude and Gemini read no PO delivery date. |
| Contact name | `orders.delivery_point_contact_id` to `customer_contacts.name` (`065:31-39`). The SO PDF prints it (`src/api/orders/so_pdf.js:109`). | The PO extractors read no person name. |
| Contact phone | `customer_contacts.phone`, or the PO's printed `customer.phone`. SO PDF `:110`. | The PO phone may be a switchboard. |
| Shipment mode | `orders.dispatch_mode`, one value per order (options at `SOWorkspaceOrderPanels.tsx:202-207`: Ocean, Air, Road, Rail, Courier, Self Pickup). The SO PDF prints it, default "By Road" (`so_pdf.js:106`). | One mode per order. No "hand carry by our engineer". A mixed order needs two modes. |
| Origin per line | Item master `source_country` (`item-mapper.js:425`). Quote line `source_country` (`quote-reconcile.js:275`). Part-string markers via `classifyOrigin` (`src/api/_lib/pending-so/part-origin.js:137`). Source PO prefix. | No per-order grouping. The marker letters map to countries through a hardcoded table for one tenant's convention. |

**Direct send exists.** `src/api/comms/dispatch_register.js` builds content, inserts a `communications` row through `commsRow()` (`:98`), calls `sendCommunication` in the same request when `send:true` (`:102`) and records audit (`:104`). It needs only `write` (`:48`). Do NOT use `/api/communications/send`: it requires `approve` (`src/api/communications/send.js:21`), and approvers are `sales_manager`, `finance` and `admin` only (`src/api/_lib/auth.js:40`).

**Honest status exists.** `sendCommunication` leaves a row `queued` when no provider is configured (`src/api/_lib/comms-send.js:191-196`). The caller must say "not sent".

**No internal recipient exists.** `tenant_settings` has customer-facing and seller addresses only. `comms-routing.js` resolves customer contacts only (`resolveForCustomer` at `:134`).

### 2.7 Work in progress and waiting

These PRs from the same plan are being built now by other agents. This design depends on them and does not repeat them.

| Plan PR | Change | Status | Why this design needs it |
|---|---|---|---|
| 1 | The incoterm check compares parsed codes only. No false mismatch against payment-terms text. | In progress | The terms comparator (PR 12) reuses `compareIncoterms`. |
| 2 | Invoice "send now" works. Today `invoices.tsx:160` passes `{ id }` into `send(id)` (`anvil-client.js:1510`), so the server 404s, and `:167` says "Comms reaper will retry". | In progress | Same trap the handoff must avoid. |
| 3 | `orders.payment_terms` is read by three readers and created by no migration. | Waiting for a live-DB check | A payment-terms decision writes Anvil's side of the three-way report there. |
| 4 | The Excel and the SO PDF print the same rate on a reconciled line. | In progress | Both are handoff attachments. |
| 5 | `tally/retry.js` refuses in Mode B. The Tally tab states the mode. | In progress | Mode B must never post a voucher. |
| 6 | Upload the ERP sales order from the "PO vs ERP" tab. Wires `attachSalesOrder` (`anvil-client.js:855`). | In progress | The register's last stage, "ERP SO attached". |
| 7 | SO register view and `/api/orders/register`. | In progress | PRs 13 and 16 add its terms and handoff columns. |
| 8 | Reconcile server-side when lines land (background job, inbound channels). | In progress | The terms check runs at the end of that reconcile. |

---

## 3. The terms model

### 3.1 Clause taxonomy

Each clause has a key, a structured value where one exists, a comparison method and a default severity. The owner tunes the list and the severities (decision 1). The list and severities are data (section 5.3), not code.

| Key | Structured value | Compared by |
|---|---|---|
| `incoterm` | `{ code, place }`, for example `{ "FCA", "<city>" }` | Rule |
| `payment_terms` | `{ days, basis, advance_pct, instrument }`. `basis`: `invoice`, `delivery`, `grn`, `dispatch`, `bl`, `other`. `instrument`: `tt`, `lc`, `pdc`, `other`. | Rule |
| `delivery_lead_time` | `{ min_days, max_days, from, fixed_date }`. `from`: `order`, `drawing_approval`, `advance`, `other`. | Rule |
| `price_basis` | `{ basis, place }`. `basis`: `ex_works`, `for_destination`, `for_dispatch`, `door_delivery`. | Rule |
| `freight_insurance` | `{ freight, insurance, packing }`. Each `buyer`, `seller`, `included`, `extra`, or a percentage. | Rule |
| `taxes` | `{ gst: extra / inclusive, rate_pct }` | Rule |
| `validity` | `{ days, expires_at }` against the PO date | Rule |
| `warranty` | `{ months, from, scope }`. `from`: `dispatch`, `delivery`, `installation`, `commissioning`. | Rule for months and start; LLM for scope wording |
| `ld_penalty` | `{ rate_pct, per: day / week, cap_pct, excluded }` | Rule for numbers; LLM for wording |
| `inspection_acceptance` | `{ stage, by, rejection_rights, deemed_acceptance_days }` | LLM |
| `cancellation` | `{ buyer_may_cancel, notice_days, compensation }` | LLM |
| `jurisdiction` | `{ courts_place, governing_law, arbitration }` | LLM |
| `one_sided` | `{ subtype }`: `unlimited_liability`, `consequential_damages`, `indemnity`, `back_to_back_payment`, `set_off`, `bank_guarantee`, `retention`, `ip_assignment`, `audit_right`, `other` | LLM |

### 3.2 One clause record

Every clause, on every side, has the same shape. Call it a `TermClause`.

```json
{
  "clause": "payment_terms",
  "side": "po",
  "value": { "days": 60, "basis": "grn", "advance_pct": 0, "instrument": "tt" },
  "text": "Payment: 60 days from the date of GRN",
  "provenance": "po_text",
  "document_id": "<uuid>",
  "page": 7,
  "span": { "start": 18240, "end": 18278 },
  "bbox_norm": [0.08, 0.41, 0.62, 0.44],
  "verified": true,
  "confidence": 0.92,
  "method": "llm:terms_pass@v1",
  "text_hash": "<sha256 of the normalized text>"
}
```

| Field | Meaning |
|---|---|
| `value` | The structured value. Null when the clause is wording only. A deterministic normalizer derives it from `text` where one exists. The LLM's value is only a hint. |
| `text` | The source wording, verbatim. |
| `page`, `span`, `bbox_norm` | Where the wording is. `span` is a character range in the text the pass read. `bbox_norm` is for the hover highlight. |
| `verified` | The wording was found in the source text (section 4.3). Unverified clauses are dropped, so a stored clause is always `true`. The field stays for the record. |
| `confidence` | 0 to 1. Lowered when the normalizer and the LLM disagree on the value. |
| `provenance` | Where the clause came from. See 3.3. |

### 3.3 Provenance

| `provenance` | Side | Meaning | Shown as |
|---|---|---|---|
| `po_text` | PO | Extracted from the PO document, verified. | "PO, page 7" |
| `operator_entry` | PO | Typed on the Header tab. | "Entered by <user>" |
| `customer_master` | Baseline | Defaulted from `customers.default_payment_terms` / `default_incoterms` (`001:61-62`). | "Customer master default" |
| `customer_terms_pack` | Baseline | A clause of the customer's own T&C pack. | "Customer T&C pack <name> v<n>" |
| `quote_snapshot` | Quote | Our quote's clauses as frozen at send. | "Quote <no> as sent on <date>" |
| `quote_template_live` | Quote | Our template read today, for a quote sent before snapshots existed. | "Quote <no>, template as of today (not as sent)" |
| `quote_document` | Quote | Extracted from an uploaded quote PDF, verified. | "Uploaded quote <no>, page 2" |

**Rule.** A `customer_master` value is never labelled "from PO". Today that happens (2.4). Two changes stop it:

1. The grounding fill records a field-level marker, `normalized._provenance["customer.payment_terms"] = "customer_master"`, beside the value it fills.
2. The terms model never reads `customer.payment_terms` as PO text. The PO side comes from the terms pass over the document text. A master value appears only as a labelled baseline row.

### 3.4 The quote side

**Anvil quotes: snapshot at send.** `quotes/send.js` writes `quotes.terms_snapshot` (migration 250) after it renders the PDF. The snapshot holds:

- the clauses from `quotes.terms`, `validity_days` / `expires_at`, and the `document_templates` clause columns, parsed by the same normalizers;
- the template id and its `updated_at`;
- the customer terms pack id and version, if one was attached;
- per clause, `printed_on_pdf: true / false`.

Today `printed_on_pdf` is false for every clause, because the renderer prints none (2.5). Decision 12 covers whether the quote PDF should start printing them. Until then, the Terms tab says "on file, not printed on the quote PDF" beside each quote clause. That is the honest statement.

A quote sent before PR 10b has no snapshot. Its clauses come from the live template, labelled `quote_template_live`.

**Uploaded quotes: keep what we already read.** `quoteHeadFromExtract` (`quote-ingest.js:170-182`) keeps `incoterm`, `delivery_terms` and `validity` in new `quotes` columns (`incoterm`, `delivery_terms`, `validity_text`). When the terms check is on, the terms pass (section 4) also runs on the quote document, and its clauses go into `quotes.terms_snapshot` with provenance `quote_document`. Both writes are guarded by `ingest_source IS NOT NULL` (migration 188), so an ingest never overwrites a hand-authored quote's snapshot.

**Opportunity quotes.** They have a `document_id` (`203`). The terms check may read them as a labelled baseline when the order's customer has a `sent` or `accepted` revision. This is a design default, not a numbered decision.

**Which quote is the baseline.** Each quote that priced a line in the reconcile (`quotes_used`). The primary quote shows first. This is a design default.

---

## 4. Extraction

### 4.1 One module

New file `src/api/_lib/docai/terms-pass.js`. It exports:

- `TERMS_RULE`: one prompt string;
- `TERMS_TOOL`: one tool schema;
- `segmentTerms(text)`: a deterministic segmenter;
- `verifyQuote(sourceText, quote)`: the verbatim check;
- `runTermsPass({ svc, ctx, documentId, kind })`: one call per document.

It follows the `toc-profiler.js` pattern: own prompt, own tool, one call. Neither `claude.js` nor `gemini.js` grows a terms branch. That removes the drift risk at its root. If the pass ever runs on both providers (for example a Gemini fallback), both requests are built from the same `TERMS_RULE` and `TERMS_TOOL`. A conformance test asserts it. The repo already uses this pattern: `LINE_REQUISITION_RULE` is exported once (`claude.js:54`) and imported by `gemini.js:20`.

**Every adapter path gets the same pass.** The pass does not read adapter output. It reads the cached text of the document:

| Document | Text it reads |
|---|---|
| Digital PDF (any adapter: Claude, Gemini, LlamaParse, Azure DI) | `extraction_text_layer.body_text`, plus the geometry blocks for page and bbox |
| Scanned PDF | `extraction_ocr_layer.body_text` and its raw pages |
| Office or Excel PO | the office text the pipeline already derives |
| PO in an email body | the email body text |
| Image only, no OCR | Nothing. The check records `po_terms_status = 'not_read'`. |

So LlamaParse and the text-layer path need no special handling. They are covered because the pass is downstream of the cache, not inside an adapter.

**Where it runs.** Not in the `run.js` hot path. It runs inside the terms check (section 5), after the server-side reconcile (plan PR 8, in progress). Reasons:

- no added latency on extraction, which already has a tight time budget;
- it works for orders created before the feature, and for every inbound channel;
- a re-run costs one call, without re-extracting the lines.

The result is cached on `order_term_checks.po_clauses` keyed by the document's text hash and the prompt version. A re-check with the same text and version reuses it.

### 4.2 Full T&C, including POs of 25 pages or more

- The pass ignores the profiler's `keepPages`. It reads the whole cached text.
- **Segmenter first.** A deterministic segmenter cuts the text into candidate spans by heading and keyword: "Terms and Conditions", "Payment", "Delivery", "Dispatch", "Warranty", "Guarantee", "Penalty", "LD", "Liquidated", "Inspection", "Acceptance", "Rejection", "Cancellation", "Termination", "Jurisdiction", "Arbitration", "Governing law", "Freight", "Insurance", "Packing", "Taxes", "GST", "Price basis", "Ex-works", "FOR", "Indemnity", "Liability", "Set-off", "Retention", "Bank guarantee". Only those spans go to the LLM. This bounds cost and the hallucination surface.
- **No heading found.** The segmenter sends the pages with two or more keyword hits, then the last three pages, up to a token cap. It records `segmenter: "fallback"` so the miss is visible.
- **The 200 KB cap.** When `body_text` hit the cap (`text_layer.js:60`), the pass reads per-page text from the geometry blocks instead, so T&C at the end of a very large PO are not cut.
- **Page attribution.** `body_text` has no page markers (`text_layer.js:242`). The pass locates each verified quote in the per-page geometry to get its page.

### 4.3 The verbatim check

Every clause the LLM returns must cite a `quote`: wording copied from its input.

1. Normalize both strings: whitespace, case, curly quotes, dash variants, soft hyphens and line-break hyphenation.
2. The normalized quote must be a substring of the normalized source span it was given.
3. If it is not, the clause is **dropped**. It never reaches a flag.
4. The pass records a run event with the count of dropped clauses per document. That count is the hallucination rate, and the golden set tracks it.

An LLM-proposed `value` is re-derived by the deterministic normalizer from the verified `text` where a normalizer exists. When the two disagree, the normalizer wins and `confidence` drops.

### 4.4 Hover-evidence highlight

- For each verified clause, `buildBlockIndex` (`bbox-evidence.js:83`) and the same token scoring used for lines find the page and the box.
- The clause stores `page` and `bbox_norm`. The Terms tab reuses the existing overlay that reads `bbox_norm` (`so-workspace.tsx:329`).
- When the order exists, the check also writes `evidence` rows with `field_path = 'terms.<clause>'`. `evidence.order_id` is NOT NULL (`001_init.sql:213`), so quote-side locations live in the clause record only.

### 4.5 Rollout controls

| Control | Where | Default |
|---|---|---|
| Tenant flag `terms_check_mode`: `off`, `shadow`, `on` | `tenant_settings` (migration 250) | `off` |
| Prompt version `terms_pass@v1` | registered in `src/api/_lib/docai/prompt-versions.js` (`resolvePromptVersion` at `:181`, `PROMPT_NAME_BY_KIND` at `:246`) | v1 |
| Prompt A/B canary | the existing master switch `tenant_settings.docai_prompt_variants` (`218_docai_prompt_variants.sql:42`) | off |
| Golden profile `po_terms` | `src/api/eval/kind-profiles.js` | added with PR 11 |

`shadow` runs the pass and stores flags, but the Terms tab hides them from engineers. Admins see them with a "shadow" label. This measures precision on real POs before anyone acts on a flag.

### 4.6 Delivery date and contact name (plan PR 17)

These two handoff inputs come from the PO header and lines, not from the T&C. So they belong in the PO adapters. This is the only PR that edits both adapter prompts.

- One shared rule string, exported once and imported by both adapters, as `LINE_REQUISITION_RULE` is today.
- New slots in both schemas: `customer.contact_name`, `customer.delivery_date`, `lines[].delivery_date`.
- The Claude prompt stops discarding "Delivery date :..." from description cells (`claude.js:177`). It moves the date into `lines[].delivery_date`.
- A conformance test asserts that both prompts contain the identical rule and both schemas have the three slots.
- `prompt_version` is bumped for both. The change ships behind the A/B canary.

---

## 5. Comparison

### 5.1 Method

1. **Rule first.** Every clause with a structured value is compared by code only. The comparators extend the existing ones in `quote-reconcile.js` (`comparePaymentTerms` gains basis and advance; `compareIncoterms` keeps the PR 1 fix). A side with no parseable value yields `unknown`. It is never string-compared against unrelated text.
2. **LLM only for wording.** Warranty scope, LD wording, inspection, cancellation, jurisdiction and one-sided clauses go to an LLM judge. It receives the two verified texts, each with an id (`P1`, `Q1`). It returns:
   ```json
   { "deviates": "yes | no | unclear", "direction": "against_us | for_us | neutral",
     "rationale": "...", "cites": ["P1", "Q1"], "po_phrase": "...", "quote_phrase": "..." }
   ```
   `po_phrase` and `quote_phrase` must pass the verbatim check against `P1` and `Q1`. If they fail, or the judge cites neither text, the result is `unclear`. The schema has no decision field. The judge cannot see or set a decision. Results are cached by the two text hashes and the prompt version.
3. **"No deviation" from the LLM is not a pass.** When the judge says `no` on a clause that the policy rates `high` or `critical`, the row stays visible at `info` with "LLM judged equivalent". A person can still see it.

### 5.2 Outcomes and the severity matrix

| Outcome | Meaning |
|---|---|
| `match` | Both sides state it and agree. No flag. Listed, collapsed, in the Terms tab. |
| `deviates` | Both sides state it and differ. `direction` says whom it hurts. |
| `po_only` | The PO imposes it. The quote is silent. This is a flag, not a pass. |
| `quote_only` | The quote states it. The PO is silent. |
| `unknown` | One side has text that could not be parsed or judged. |
| `not_read` | The PO terms were not read (image only, or text extraction failed). Never shown as "no deviations". |

Default severity per clause and outcome. Levels: `info`, `warn`, `high`, `critical`.

| Clause | Deviates, against us | Deviates, for us or neutral | PO only | Unknown |
|---|---|---|---|---|
| `incoterm` | high (the code moves cost or risk to us); warn (place only) | info | warn | warn |
| `payment_terms` | high (more days, less advance, later basis) | info | warn | warn |
| `delivery_lead_time` | high (the PO needs it sooner than quoted) | info | warn | warn |
| `price_basis` | high | info | warn | warn |
| `freight_insurance` | warn | info | warn | warn |
| `taxes` | high ("inclusive of all taxes" against "GST extra") | info | warn | warn |
| `validity` | warn (PO dated after the quote expired) | info | not applicable | info |
| `warranty` | high (longer or wider) | info | warn | warn |
| `ld_penalty` | critical (uncapped, or the quote excluded LD); high otherwise | info | critical if uncapped, else high | high |
| `inspection_acceptance` | warn | info | warn | info |
| `cancellation` | high (buyer may cancel without compensation) | info | high | warn |
| `jurisdiction` | warn | info | warn | info |
| `one_sided` | not applicable | not applicable | critical: `unlimited_liability`, `consequential_damages`. high: `indemnity`, `back_to_back_payment`, `set_off`, `bank_guarantee`, `retention`, `ip_assignment`. warn: `audit_right`, `other`. | warn |

`quote_only` is `info` for every clause. `not_read` is one order-level `high` row: "PO terms not read".

### 5.3 Tenant policy as data

`tenant_settings.terms_policy jsonb` (migration 250). Code ships `DEFAULT_TERMS_POLICY`, which is the table above. The tenant value overrides it key by key. A JSON schema in code validates it on save.

```json
{
  "version": 3,
  "decide_at_or_above": "warn",
  "clauses": {
    "ld_penalty": {
      "enabled": true,
      "severity": { "deviates_against": "critical", "deviates_for": "info", "po_only": "high", "unknown": "high" },
      "accept_requires": "order.terms_accept_high"
    },
    "jurisdiction": { "enabled": false }
  }
}
```

- `decide_at_or_above`: flags at this severity or higher need a decision. Below it they are display only.
- `accept_requires` may only tighten the default RBAC (section 6.2). It can never loosen it.
- Each check stores the policy `version` it used, so an audit can show which rules applied.
- Admin edits the policy on a new Admin tab. The editor shows the default beside each override.

### 5.4 When the check runs, and re-runs

| Trigger | Who |
|---|---|
| End of the server-side reconcile (plan PR 8) | System |
| "Re-check terms" in the Terms tab | Engineer (`write`) |
| A quote is attached or re-ingested | System |

Each run writes one `order_term_checks` row. New flags supersede the old ones (`superseded_at`). A decision carries forward to the new flag only when the clause key and the `text_hash` of the PO text and the quote text are unchanged. Otherwise the flag reopens and the old decision stays in the history.

---

## 6. The decision workflow

### 6.1 The decision

| Decision | Meaning | Effect |
|---|---|---|
| `accept` | We accept the PO's term. | The flag closes. An accepted payment term becomes Anvil's value in the three-way report (needs plan PR 3). |
| `request_amendment` | We ask the customer to amend the PO. | The flag stays open as "amendment requested". It feeds the optional amendment email (6.4). It is listed in the handoff email. |
| `reject_term` | We do not accept this term. | The flag closes as rejected. It is listed in the handoff email as "rejected, customer to be told". |
| `not_a_deviation` | The flag is wrong. | The flag closes. This counts toward precision. It is a design addition beyond the owner's three values, because without it a false flag must be "accepted", which hides the error. |

- A reason is required for every decision. Minimum length is enforced on the server.
- Decisions are append-only (`order_term_decisions`). A changed mind is a new row. The latest row per flag is the current decision.
- The decision never changes the order lines, the PO document or the quote.

### 6.2 RBAC

Two new fine-grained actions, registered in BOTH `SERVER_ACTIONS` (`src/api/_lib/auth.js:213`) and `ACTIONS` (`src/v3-app/lib/rbac.ts:111`).

| Action | Default roles | Gate |
|---|---|---|
| `order.terms_decide` | `sales_engineer`, `sales_manager`, `admin` | Any decision on a flag below high. `request_amendment` and `reject_term` at any severity. |
| `order.terms_accept_high` | `sales_manager`, `admin` | `accept` or `not_a_deviation` on a `high` or `critical` flag. Decision 2 may change this. |

Both are checked after `requirePermission(ctx, "write")`.

**A trap to test against.** `hasAction` returns true for an action that is not registered (`auth.js:254-256`). A typo in the action name would silently allow every role. The parity test must assert that each new action exists in both tables with the same roles, as `src/v3-app/api-customer-owner.test.js` does for `customer.assign_owner`.

### 6.3 Audit

- `recordAudit(ctx, { action: "order_term_decided", objectType: "order", objectId, detail: { flag_id, clause, severity, decision } })` (`src/api/_lib/audit.js:74`).
- `recordEvent(ctx, { eventType: "term_decided", ... })` (`audit.js:139`), so the decision shows on the order timeline.
- The audit `detail` holds no clause wording, no reason text and no contact data. Those live in the decision row, behind RLS.

### 6.4 Optional amendment email to the customer

- Off by default (`tenant_settings.terms_amendment_email_enabled`). Decision 9.
- "Draft amendment request" collects every open `request_amendment` decision on the order into one draft.
- Recipient: the customer's purchase contact through `resolveForCustomer(svc, tenantId, customerId, "po_amendment_request")` (`comms-routing.js:134`).
- Body: per clause, the PO wording, our quote wording and the change we ask for. Real newlines, not the literal backslash-n that `communications/draft.js:12-33` templates contain today.
- Preview first. Sent only on an explicit "Send" click.
- **Direct send only.** Insert the row through `commsRow()` and call `sendCommunication` in the same request, as `comms/dispatch_register.js:98-104` does. Never leave it queued (section 12.3).
- Gate: `write` plus `order.terms_decide`.

### 6.5 Does an undecided critical flag block the handoff?

This is decision 3. The suggested default is yes for `critical`, no for the rest. When it blocks, the handoff preview lists the flag as a blocker and the send returns 409 `TERMS_UNDECIDED`. The block lives in the handoff endpoint. It does not use `rule_findings`, because `resolveFinding` is approve-gated and binary (`src/api/_lib/blocking-findings.js:23-82`), so it cannot hold three decisions.

### 6.6 The Terms tab

A new tab in the SO workspace, after "Quotes" (tab list at `so-workspace.tsx:1897-1915`).

| Column | Content |
|---|---|
| Clause | The clause name and a severity chip. |
| PO wording | The verified text, its provenance label and a page link. Hover highlights it on the PO. |
| Quote wording | The text, the quote number and its provenance label ("as sent", "template as of today", "uploaded quote, page 2", "on file, not printed"). |
| Baseline | The customer pack or master value, when one exists, labelled. |
| Why flagged | The rule result, or the LLM rationale with both cited phrases. The method is shown: "rule" or "LLM". |
| Decision | Four buttons and a required reason. The current decision and its history. |

The tab header shows the check status: "Terms read from 31 pages, 14 clauses, 3 flags to decide", or "PO terms not read: image only". It never shows "no deviations" when the PO was not read.

---

## 7. The Mode B register and lifecycle

### 7.1 Lifecycle

The stage is derived on read. It is not a new `order_status` value. That keeps it out of the approval state machine and away from approval invalidation.

| Stage | True when | Moved by |
|---|---|---|
| Received | The order row exists with its PO document. | Intake and every inbound channel. |
| Analysed | `result.quoteReconciliation` exists (plan PR 8 makes this server-side), and a terms check exists or the terms check is `off`. | System. |
| Terms decided | No open flag at or above `decide_at_or_above`. | The engineer (and the manager for high and critical). |
| Handed off | `orders.handoff_status = 'sent'`. | The engineer, one click. |
| ERP SO attached | An `order_documents` row with role `sales_order` exists (migration 222). | The order processing team or the engineer uploads the Tally SO PDF (plan PR 6). |

Side states shown beside the stage:

- "Terms not read" (the PO text could not be read);
- "Handoff failed" or "Not sent: no mail provider";
- "Changed since handoff": the order's lines hash differs from the one stored in `handoff_payload`. This matters because `cron/extraction_jobs.js:778-795` writes merged lines into `orders.result` whatever the order's status;
- "No ERP SO after N days".

### 7.2 The register

The register view and `/api/orders/register` are plan PR 7, in progress. It ships with the columns that exist (received, PO, customer, lines, value, quote match, ERP SO, status). This design adds two columns and two filters.

| Added by | Column | Filter |
|---|---|---|
| PR 13 | Terms: open critical and high, decided, not read | "Open terms" |
| PR 16 | Handoff: not sent, sent at and by, failed, not configured, changed since handoff | "Not handed off" |

Each PR ships its own column, so no PR leaves a column with no data.

### 7.3 What stays outside Anvil

| Stays in Tally or with people | Why |
|---|---|
| Sales order voucher entry | Mode B. Plan PR 5 makes sure no retry posts one. |
| Stock, reservation, procurement orders | The ERP owns them. |
| Dispatch, e-way bill, invoice | The ERP owns them. The handoff only passes the shipment mode. |
| Payment follow-up | The ERP and finance own it. |
| Talking to the customer about an amendment | The engineer, unless decision 9 turns on the amendment email. |

### 7.4 Approval in Mode B

Engineers cannot approve (`auth.js:40`). In Mode B an order usually stops at DRAFT or PENDING_REVIEW. Decision 10 sets whether the handoff needs approval first. The suggested default is no: the handoff is allowed before approval, gated by the blockers in 8.6.

---

## 8. The handoff

### 8.1 Recipient settings

New `tenant_settings` columns (migration 251). An admin edits them on an Admin tab.

| Column | Meaning |
|---|---|
| `order_handoff_enabled` | Default false. The button is hidden until an admin turns it on. |
| `order_handoff_to text[]` | The order processing team. Each entry is an address or a role token. |
| `order_handoff_cc text[]` | CC. Same format. |
| `order_handoff_sender` | `graph` (the tenant's shared Outlook mailbox, `graph_mailbox`, migrations 028 and 194) or `mailer` (Brevo, Resend or SendGrid through `_lib/mailer.js`). |
| `order_handoff_template jsonb` | Subject format, whether prices are included, which attachments. Decision 5. |

**Role-to-address resolution.** New `src/api/_lib/internal-recipients.js`, `resolveInternalRecipients(svc, tenantId, purpose)`.

- A literal entry is validated as an email address.
- A role token such as `role:operator` expands to the email addresses of the tenant's active members with that role.
- The sending engineer is added to CC and set as reply-to (decision 4).
- The resolver returns the list and the reason for each address. The preview shows both.
- This resolver can later fix the logistics alerts that are queued with no recipient (`_lib/logistics/notifications.js:190-201`). That fix is out of scope here.

**Reply-to on Graph.** The Graph branch of `sendCommunication` does not pass `reply_to` (`comms-send.js:155-168`). The mailer branch does (`:177`). PR 16 passes it on the Graph branch too.

### 8.2 One click in the SO workspace

- A "Send to order processing" button in the SO workspace header. It shows only when `order_handoff_enabled` is true.
- It opens a modal with:
  - the prefilled fields, each with its source label;
  - one shipment-mode select per origin group;
  - the To and CC lines, with the reason for each address;
  - the subject and a body preview;
  - the attachments list;
  - the blockers, if any.
- One click on "Send" sends it.
- After the send, the button becomes a status chip: "Sent 10:42 by <user>", "Failed: <reason>", or "Not sent: no mail provider".
- "Send again" needs a confirm. It makes a new `communications` row. All sends stay in the audit.

### 8.3 Prefill

A pure, tested library: `src/api/_lib/order-handoff.js`.

**Material required date.** Candidates, each labelled with its source:

| # | Source | Exists today |
|---|---|---|
| a | PO delivery date: header `customer.delivery_date` or line `delivery_date` | LlamaParse lines only. Both main adapters after plan PR 17. |
| b | Earliest `order_schedule_lines.scheduled_date` | Yes (manual) |
| c | `orders.committed_delivery_date` | Yes (manual) |
| d | A deterministic "Delivery date : <date>" parse of `raw_description` | The text exists. The parse is new. |

Decision 8 sets whether the field means the PO date (a, d) or the committed date (c). The suggested default is the PO date, with the committed date shown beside it when they differ. When line dates differ, the email lists them per line. A blank is a required field. It never defaults to today.

**Contact name and phone.** In this order:

1. The `delivery_point_contact_id` contact (name, phone).
2. The PO buyer block: `customer.contact_name` (after plan PR 17) and the printed `customer.phone`.
3. The customer's primary contact (`customer_contacts.is_primary`, `065:39`).

The source is shown. A blank is required. The engineer may pick another contact of the same customer.

**Origin group per line.** Each line gets `import`, `local` or `unknown` from four signals. Decision 6 sets the precedence. The suggested default:

1. An explicit part-string marker through `classifyOrigin` (`part-origin.js:137`).
2. The matched source PO prefix (exists only after procurement).
3. The quote line `source_country` (`quote-reconcile.js:275`).
4. The item master `source_country` (`item-mapper.js:425`). Weakest, because BOM origin defaults to India in places, so `O-INDIA` there is weak evidence.

When two signals disagree, the line goes to `unknown` with both shown. `unknown` forms its own group and the engineer must pick. Origin never defaults silently.

**Shipment mode per group.** Decision 7 sets the vocabulary and defaults. The suggested default:

| Group | Allowed modes | Default |
|---|---|---|
| `import` | `ocean`, `air` | `ocean` |
| `local` | `road`, `hand_carry_customer`, `hand_carry_engineer` | `road` |
| `unknown` | all five | none (required) |

### 8.4 `dispatch_mode` becomes per origin group

- New `orders.dispatch_plan jsonb` (migration 251): `[{ group, country, mode, line_nos }]`.
- `orders.dispatch_mode` stays. It is written only when the plan has one group, with the label the SO PDF prints (`so_pdf.js:106`).
- For a mixed order, the SO PDF prints "As per dispatch plan" instead of the default "By Road", and the line table shows the mode per line.
- The Header tab select (`SOWorkspaceOrderPanels.tsx:202-207`) gains "By Hand Carry (customer)" and "By Hand Carry (our engineer)". The existing "Self Pickup" maps to `hand_carry_customer`.
- These are dedicated columns, written by the handoff endpoint. They are not in `orders.result`, so they do not reset approval (only `result`, `line_edits` and `rule_findings` do, `src/api/orders/[id].js:204-214`).

### 8.5 The email

Suggested template (decision 5). Placeholders only.

```
Subject: SO entry: PO <po_number> / <customer> / <n> lines

Order processing team,

Please enter this sales order in Tally.

PO:          <po_number> dated <po_date>
Customer:    <customer name>
Anvil order: <PUBLIC_APP_URL>/#/so?id=<order id>

Inputs for the ERP
  Material required date: <date>   (source: PO delivery date)
  Contact:                <name>, <phone>   (source: delivery contact)
  Shipment mode:
    Imported lines (3): By Ocean
    Local lines (2):    By Road

Lines
  #  Part        Customer part  Qty  UOM  Due         Origin   Mode
  1  <part>      <cust part>    4    NOS  <date>      Import   Ocean
  ...

Terms decisions
  Payment terms: PO "<wording>" vs quote "<wording>": accepted by <user>
  LD / penalty:  PO "<wording>", quote silent: amendment requested
  Open flags: none

Attached: SO PDF, original PO.

Sent from Anvil by <engineer>. Reply to this email to reach them.
```

- No prices by default (decision 5).
- The link uses `PUBLIC_APP_URL`, as `quotes/send.js` and `invoices/send.js` do.
- **Attachments** (decision 5): the SO PDF and the original PO by default, the Excel optional.
  - The SO PDF is rendered with `renderSalesOrder` (`src/api/_lib/pdf-renderer.js:479`). Its data builder `buildSalesOrderData` is private to `orders/so_pdf.js:59`. PR 16 moves the builder and its loader into `src/api/_lib/so-document.js`, so the endpoint and the handoff produce the same PDF.
  - The Excel uses `buildSalesOrderAoa` (`orders/export.js:40`).
  - Plan PR 4 (rate parity) must land first, so the two attachments agree.
  - The original PO is attached by `{ document_id }`. The 15 MB cap of `comms-attachments.js` applies.

### 8.6 The endpoint

`/api/orders/handoff`

**`GET ?order_id=`** returns the prefill, origin groups, allowed modes, recipients with reasons, subject, body, attachments and blockers. Blockers:

- a required field is blank;
- an `unknown` origin group has no mode;
- an undecided critical flag, if decision 3 says so;
- `order_handoff_enabled` is false, or no recipient resolves;
- no mail provider is configured (Graph not connected and no mailer key).

**`POST { order_id, fields, send: true }`**

1. `requirePermission(ctx, "write")`, then `requireAction(ctx, "order.handoff")`.
2. Validate. Recompute blockers on the server. Refuse with 409 and the blocker list.
3. Idempotency: a second POST with the same payload hash within 10 minutes returns the first result. "Send again" passes `resend: true`.
4. Write the chosen fields to dedicated columns: `dispatch_plan`, `dispatch_mode` (one group only), `handoff_payload` (date, contact, groups, lines hash, terms summary).
5. Insert a `communications` row through `commsRow()` (`src/api/_lib/comms-row.js:24-29`): `document_type: "order_handoff"`, `object_type: "order"`, `order_id`, internal `to_addr`, `cc_addrs`, `reply_to`.
6. Call `sendCommunication(svc, ctx, id)` in the same request.
7. Map the result:

   | `sendCommunication` status | `orders.handoff_status` | Shown | Row afterwards |
   |---|---|---|---|
   | `sent` | `sent` | "Sent" | `sent` |
   | `failed` | `failed` | "Failed: <reason>" | `failed` |
   | `queued` (no provider) | `not_configured` | "Not sent: no mail provider is configured" | set to `failed` with `metadata.error = "no_provider_at_send"`, so no reaper can send a stale handoff later |

8. Set `handoff_sent_at`, `handoff_sent_by`, `handoff_comm_id`.
9. `recordAudit(ctx, { action: "order_handoff_sent", objectType: "order", objectId, detail: { comm_id, status, groups } })` and `recordEvent`. No phone number or contact name in `detail`.
10. Return the true status.

**Permission.** New `order.handoff` in `SERVER_ACTIONS` and `rbac.ts` `ACTIONS`, with a parity test. Default roles: `sales_engineer`, `sales_manager`, `operator`, `admin`. Sales engineers cannot use `/api/communications/send`, which needs `approve`. So the handoff never routes through it.

**Metrics.** `order_handoff` is not in `CUSTOMER_COMMS_TYPES` (`src/api/_lib/metrics/catalog.js:108`). It stays out of customer communication metrics.

---

## 9. Data model and migrations

### 9.1 Registry

| Range | Owner |
|---|---|
| 228-231 | Accounts and assets |
| 232-242 | Tally integration |
| 243-247 | Support desk |
| 248 | Gemini fallback (on main) |
| 249 | Security views |
| **250** | **This design: terms** |
| **251** | **This design: handoff** |
| 252+ | The work layer |

Both migrations are additive and idempotent (`create table if not exists`, `add column if not exists`). Merged is not applied: the owner applies them by hand.

### 9.2 Migration 250 `order_terms`

| Object | Columns |
|---|---|
| `order_term_checks` (new) | `id`, `tenant_id`, `order_id`, `trigger` (`reconcile`, `manual`, `quote_attached`), `po_document_id`, `po_text_source` (`text_layer`, `ocr_layer`, `office`, `email_body`, `none`), `po_terms_status` (`read`, `partial`, `not_read`), `po_clauses jsonb` (array of `TermClause`), `segmenter` (`headings`, `fallback`), `dropped_unverified int`, `quote_ids uuid[]`, `policy_version int`, `prompt_version text`, `model text`, `created_by`, `created_at`, `superseded_at` |
| `order_term_flags` (new) | `id`, `tenant_id`, `order_id`, `check_id`, `clause`, `outcome` (`deviates`, `po_only`, `quote_only`, `unknown`, `not_read`), `direction` (`against_us`, `for_us`, `neutral`), `severity` check (`info`, `warn`, `high`, `critical`), `method` (`rule`, `llm`), `po jsonb`, `quote jsonb` (adds `quote_id`), `baseline jsonb`, `rationale text`, `text_hash text`, `created_at`, `superseded_at` |
| `order_term_decisions` (new, append-only) | `id`, `tenant_id`, `order_id`, `flag_id`, `decision` check (`accept`, `request_amendment`, `reject_term`, `not_a_deviation`), `reason text not null`, `decided_by`, `decided_role`, `decided_at`, `carried_from uuid` (the decision it carried forward from). RLS grants insert and select only. No update, no delete. |
| `quotes` | add `incoterm text`, `delivery_terms text`, `validity_text text`, `terms_snapshot jsonb`, `terms_snapshot_at timestamptz` |
| `tenant_settings` | add `terms_check_mode text default 'off'` check (`off`, `shadow`, `on`), `terms_policy jsonb`, `terms_amendment_email_enabled boolean default false` |

RLS on the three new tables uses `current_tenant_ids()`. All three are added to `src/scripts/audit-rls-coverage.mjs`. Indexes: `(tenant_id, order_id)` on each, and `(flag_id, decided_at desc)` on decisions.

### 9.3 Migration 251 `order_handoff`

| Object | Columns |
|---|---|
| `tenant_settings` | add `order_handoff_enabled boolean default false`, `order_handoff_to text[]`, `order_handoff_cc text[]`, `order_handoff_sender text` check (`graph`, `mailer`), `order_handoff_template jsonb` |
| `orders` | add `handoff_status text` check (`sent`, `failed`, `not_configured`); null means not sent. Add `handoff_sent_at timestamptz`, `handoff_sent_by uuid`, `handoff_comm_id uuid references communications(id) on delete set null`, `handoff_payload jsonb`, `dispatch_plan jsonb` |

### 9.4 Readers on a database without the migration

- A nullable attribute (for example `quotes.incoterm`) may degrade on 42703: the reader omits it.
- A discriminator must not degrade silently. `handoff_status` and `terms_check_mode` decide behaviour. On 42703 the endpoint returns 503 with `code: "migration_251_not_applied"` (or 250), as `admin/so_processing_mode.js:91-94` does. It never pretends the order was not handed off.

No new column on `orders.result`. No PO text in `tenant_settings`.

---

## 10. Phased PRs in merge order

Plan PRs 1 to 8 are the first wave (section 2.7). The PRs below are plan PRs 9 to 17, refined. Each PR ships its caller. DF means decision-free.

| # | PR | Needs | Migration | Depends on |
|---|---|---|---|---|
| 9 | **feat(terms): clause taxonomy and pure normalizers.** `src/api/_lib/terms/taxonomy.js`, `normalize.js` (payment, incoterm, lead time, price basis, freight, taxes, validity, warranty months, LD numbers), `DEFAULT_TERMS_POLICY`. `comparePaymentTerms` adopts basis and advance. Grounding records `_provenance` for the payment terms it fills. | DF. Ships the default policy as data. Decision 1 tunes it later without code. | none | 1 |
| 10a | **feat(terms): migration 250, and uploaded quotes keep their terms.** `quoteHeadFromExtract` keeps `incoterm`, `delivery_terms`, `validity_text`. The reconciler selects them. | DF | 250 | 9 |
| 10b | **feat(quotes): snapshot our quote terms at send.** `quotes/send.js` writes `terms_snapshot` with `printed_on_pdf`. | Decision 12 | uses 250 | 10a |
| 11 | **feat(docai): the terms pass.** One module, one rule, one tool. Full cached text, segmenter, verbatim check, page and bbox. Prompt version `terms_pass@v1`. Golden profile `po_terms`. Mode `off` by default. | Decision 11 | uses 250 | 10a |
| 12 | **feat(terms): rule comparator, flags and the check endpoint.** `POST /api/orders/terms_check`, `GET /api/orders/terms`. Runs at the end of the server-side reconcile. Rule comparisons only. Severity from the policy. `not_read` row. | DF (defaults); decision 1 tunes | uses 250 | 1, 8, 11 |
| 12b | **feat(terms): LLM wording judge.** Both texts cited, verbatim-checked, cached, no decision field. | Decision 11 | none | 12 |
| 13 | **feat(so-workspace): the Terms tab and decisions.** Side by side, provenance labels, hover highlight, four decisions with a required reason, history. `POST /api/orders/terms_decide`. `order.terms_decide` and `order.terms_accept_high` in `auth.js` and `rbac.ts` with a parity test. Audit and timeline event. Register "Terms" column and filter. Accepted payment terms feed the three-way report. | Decision 2 | none | 7, 12; plan PR 3 for the three-way write |
| 14 | **feat(comms): amendment request email.** Draft from open `request_amendment` decisions. Preview, explicit send, direct send. | Decision 9 | none | 13 |
| 15 | **feat(settings): migration 251, handoff settings and recipients.** Admin tab. `resolveInternalRecipients` with role tokens. | DF code. The addresses are decision 4, entered as data. | 251 | none |
| 16 | **feat(handoff): one-click send to order processing.** `order-handoff.js` prefill, `/api/orders/handoff` GET and POST, the modal, `dispatch_plan`, hand carry modes, `so-document.js` builder, `order.handoff` action with a parity test, reply-to on Graph, honest status, register "Handoff" column and filter. | Decisions 3, 5, 6, 7, 8, 10 | uses 251 | 4, 7, 13 (for the terms summary), 15 |
| 17 | **feat(docai): PO delivery date and contact name in both adapters.** One shared rule string, three schema slots, conformance test, `prompt_version` bump, A/B canary. | DF (canary) | none | 16 reads the result; can merge before or after it |

Decision-free and ready to start once the first wave lands: 9, 10a, 15, 17. PR 12 is decision-free itself, but it reads the clauses that PR 11 produces, so it waits for decision 11.

---

## 11. Owner decisions

| # | Decision | Suggested default | Blocks |
|---|---|---|---|
| 1 | The clause list and the severity of each outcome. | The tables in 3.1 and 5.2. Flags at `warn` and above need a decision. | Nothing. Ships as data and can change later. |
| 2 | Who may accept a `high` or `critical` flag. | Engineer for `info` and `warn`. Sales manager or admin to accept `high` or `critical`. Engineers may request an amendment or reject at any level. | PR 13 |
| 3 | Does an undecided `critical` flag block the handoff? | Yes for `critical`. No for the rest. | PR 16 |
| 4 | The order processing team address or addresses, the CC list and the sending mailbox. | One shared team address. The engineer in CC and reply-to. Send from the shared Outlook mailbox when Graph is connected, else the mailer. | Go-live of PR 16 (data, not code) |
| 5 | The email template and the attachments. | Subject `SO entry: PO <no> / <customer> / <n> lines`. No prices. Attach the SO PDF and the original PO. | PR 16 |
| 6 | The origin precedence: part-string markers, source PO, quote line, item master. | Markers, then source PO, then quote line, then item master. Disagreement or no signal asks the engineer. | PR 16 |
| 7 | The shipment modes per origin group, and the defaults. | Import: ocean or air, default ocean. Local: road, hand carry by the customer, hand carry by our engineer, default road. Per origin group, not per order. | PR 16 |
| 8 | Material required date: the PO delivery date or our committed date? Per order or per line? | The PO date, with the committed date shown when it differs. Per order, with per-line dates listed when they differ. | PR 16 |
| 9 | Does Anvil email the customer for an amendment, or does the engineer do it from Outlook? | Anvil drafts, the engineer previews and clicks send. Off until the owner turns it on. | PR 14 |
| 10 | In Mode B, is the handoff before or after approval? | Before approval. Gated by the blockers in 8.6. Engineers cannot approve today. | PR 16 |
| 11 | Which LLM reads the T&C, and may T&C text be sent to that provider? | One provider (Claude, as quotes and the profiler use today), behind the tenant flag. Gemini only as a fallback built from the same rule. | PRs 11 and 12b |
| 12 | Snapshot our quote terms at send? And should the quote PDF start printing the clauses? | Yes to the snapshot. The PDF question is separate: until it prints them, the Terms tab says "on file, not printed". | PR 10b |

**Defaults taken without a numbered decision.** The owner may override any of them.

| Default | Where |
|---|---|
| Every quote that priced a line is a baseline; the primary shows first. | 3.4 |
| A clause that fails the verbatim check is dropped, not shown. | 4.3 |
| A fourth decision value, `not_a_deviation`. | 6.1 |
| `shadow` mode before `on`. | 4.5 |
| Opportunity quotes with a document are a labelled baseline. | 3.4 |

---

## 12. Risks

### 12.1 The drift pattern

Claude and Gemini adapters have drifted five times, including the delivery date found in this review (`claude.js:177` strips it; Gemini has no slot). Mitigation:

- the terms pass lives in one module and reads cached text, so no adapter changes for terms;
- only PR 17 touches both adapter prompts, from one shared rule string, with a conformance test;
- grep both adapters before believing either.

### 12.2 Hallucinated clauses

An LLM can invent a clause or a stricter wording. Mitigation:

- the LLM sees segmented clause text only;
- every clause must cite wording that exists in the document, or it is dropped (4.3);
- structured values are re-derived by code from the verified wording;
- the judge must cite both texts, and its phrases are checked too;
- the LLM never sets or suggests a decision; nothing is auto-accepted;
- `not_a_deviation` decisions and the `po_terms` golden set measure precision;
- `shadow` mode runs before engineers see flags.

A related risk is a **silent "no deviation"**. A scanned PO with no text, or a T&C page that is an image, must show "PO terms not read", never "no deviations".

### 12.3 The queued-email trap

The queue is not a delivery path today.

- `vercel.json:12-15` schedules only `/api/cron/daily`. Nothing in the repo schedules `/api/cron/tick`.
- Open PR #566 adds a tick scheduler behind an allow-list (`CRON_TICK_HANDLERS`) that defaults to `extraction/jobs` only. It recommends keeping `agents/run` off.
- `agents/run` is unsafe to turn on. Its reaper sends the 100 oldest queued rows per touched tenant with no age, kind or channel filter (`src/api/agents/run.js:276-314`). It only reaps tenants with a due agent goal (`:356-365`). Turning it on would send months-old quote emails that the UI already called "sent" (`QuoteDetailDrawer.tsx:406`).

So: the handoff and the amendment email send in the request. A `queued` result is reported as "not sent" and the row is marked failed, so it can never go out later, stale.

### 12.4 PII in emails

- The handoff carries a contact name and phone. Recipients are internal and set by an admin.
- Without Graph, the email goes through a third-party mail provider (Brevo, Resend or SendGrid).
- Attaching the original PO sends the buyer's whole document (decision 5).
- No phone number or contact name in audit `detail`. No clause wording in logs. Run events hold counts and ids only.
- The repo is public. Fixtures for the `po_terms` golden set must be synthetic. No real customer T&C goes into the repo.

### 12.5 Mode B and Tally retry

`tally/push.js:82-96` is the only reader of `so_processing_mode` (409 `SO_PROCESSING_MODE_B`). `tally/retry.js` drains `tally_retry_queue` with no mode check, so a row queued before a switch to Mode B could still post a voucher. Plan PR 5 fixes this and is in progress. PR #566 also keeps every `<erp>/retry` handler off by default. Nothing in this design adds an ERP write.

### 12.6 The invoice send bug

`invoices.tsx:160` calls `communications.send({ id })` against `send(id)` (`anvil-client.js:1510`), so the body is `{ id: { id } }`, the server returns 404, and `:167` tells the user the reaper will retry. Plan PR 2 fixes this and is in progress. The handoff avoids both halves of that bug: it does not call `/api/communications/send` (which needs `approve`), and it never promises a retry.

### 12.7 Other risks

| Risk | Mitigation |
|---|---|
| Provenance confusion: a master or operator value shown as PO wording. | Provenance on every clause (3.3). Grounding records `_provenance`. |
| Profiler page skipping and the 200 KB text cap. | The terms pass reads the full cached text, and per-page geometry when the cap was hit (4.2). |
| Quote template edits after sending. | Snapshot at send (PR 10b). Older quotes are labelled "template as of today". |
| The customer never saw our clauses (the quote PDF prints none). | `printed_on_pdf` per clause and the "on file, not printed" label. Decision 12. |
| Approval invalidation. | Terms and handoff data live in their own tables and columns, never in `orders.result`. |
| Lines rewritten after handoff by a late background extraction. | `handoff_payload` keeps a lines hash. The register shows "Changed since handoff". |
| An unregistered action allows every role. | Parity tests assert each new action in both tables (6.2). |
| Unapplied migrations. | Nullable attributes degrade. Discriminators return 503 (9.4). |
| Cost. | One terms-pass call per PO and per uploaded quote, bounded by the segmenter, cached by text hash. One judge call per wording clause, cached. Off by default per tenant. |
| The origin marker map is one tenant's convention, hardcoded. | Fine for the first customer. A second tenant needs it as tenant data. Noted, not built here. |

---

## Appendix A. Side defects found while re-verifying

New in this review. Each is outside the PRs above unless a PR says so.

| # | Defect | Evidence | Handled by |
|---|---|---|---|
| A1 | The quote PDF prints no terms. `QuoteDoc` takes `notes` only and drops every clause field that `quotes/pdf.js` passes. | `pdf-renderer.js:147-164`; `quotes/pdf.js:108-113` | Decision 12 |
| A2 | `quotes/send.js` passes neither `quotes.terms` nor the template clauses to the renderer. The email body carries validity only. | `quotes/send.js:245-268`, `:304-324` | Decision 12 |
| A3 | The Graph send path drops `reply_to`. | `comms-send.js:155-168` | PR 16 |
| A4 | `buildSalesOrderData` is private to the SO PDF endpoint, so any second caller would build its own copy. | `orders/so_pdf.js:59` | PR 16 |
| A5 | `hasAction` allows any action that is not registered. | `auth.js:254-256` | Parity tests in PRs 13 and 16 |
| A6 | `body_text` is capped at 200 KB and has no page markers. | `text_layer.js:60`, `:242` | PR 11 reads geometry |

The gap analysis lists fourteen more:

- covered by the first wave: the incoterm false mismatch, invoice send, `orders.payment_terms`, rate parity, Mode B retry, the missing ERP SO upload;
- covered by PRs 9 to 17: dropped quote fields (10a), the missing PO delivery date (17), the empty three-way Anvil side (13), the grounding provenance gap (9);
- not covered here: quote email queued while the UI says "sent" (`quotes/send.js:447-455`, `QuoteDetailDrawer.tsx:406`), literal backslash-n in the order email templates (`communications/draft.js:15`), unused `customer_terms_clauses.acknowledged_at/by`, and logistics alerts queued with no recipient (`_lib/logistics/notifications.js:190-201`). A PENDING entry will list them.
