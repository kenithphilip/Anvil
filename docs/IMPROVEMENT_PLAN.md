# Anvil Improvement Plan

Source of truth for Anvil's product and engineering roadmap from this point
forward. Replaces the older `docs/GAP_ANALYSIS.md` and `docs/ROADMAP.md`
as the authoritative tracker. The legacy `docs/DEFERRED_ROADMAP.md` covers
items that need product or program decisions before code; this doc covers
items where the path is code.

## 0. Source material

This plan synthesises three inputs:

1. The strategic gap analysis at `~/Downloads/Anvil Gaps Analysis.md` (the
   competitor-mapped 18-month roadmap). Phase numbering in this plan tracks
   that doc's Phase 1 to 6 sequence where it makes sense.
2. The internal `docs/GAP_ANALYSIS.md` (the original Now/Next/Later block
   list).
3. What has actually shipped in `main` to date (commits referenced inline
   below).

When the strategic doc and the internal doc disagree, the strategic doc wins.

## 1. How to read this plan

Status legend used throughout:

- `[done]` shipped to `main`. Commit hash inline.
- `[partial]` partially shipped. What's missing is described.
- `[open]` not started. Technical strategy described.
- `[deferred]` requires a product or program decision before code. See
  `docs/DEFERRED_ROADMAP.md`.

Every phase below has the same shape:

- **Goal**. One sentence.
- **Items**. Atomic deliverables that can be grouped into a single
  commit or PR family.
- **Technical strategy**. High-level architecture, files to add or
  change, dependencies on prior work.
- **Exit criteria**. Concrete things that must be true to mark the
  phase complete.

When an item ships, replace its `[open]` tag with `[done]` plus the
commit hash. When direction changes, append to this file. Do not start
a new file unless the doc grows past three screens of phases.

## 2. Status snapshot

### What's done

The Now block from the original gap doc plus most of the strategic doc's
Phase 1 and 2 are in `main`. Concretely, the following are live:

| Capability                             | Commit       | Source-doc reference                              |
|----------------------------------------|--------------|---------------------------------------------------|
| Brand cleanup (Obara to Anvil)         | (Phase 1.1)  | Gap doc item 6                                    |
| SendGrid outbound email provider       | (Phase 1.2)  | Gap doc item 7                                    |
| Quote PDF + share link                 | (Phase 1.3)  | Strategic doc Phase 1                             |
| Invoices module (non-India)            | (Phase 2.1)  | Strategic doc Phase 2                             |
| Stripe Connect platform fees           | (Phase 2.2)  | Strategic doc Phase 2                             |
| AR loop / dunning agent v1             | `d93d8a0`    | Strategic doc Phase 2 (autonomous follow-up)      |
| WhatsApp outbound provider             | (Now block)  | Gap doc item 7                                    |
| Outcome meter and audit verbs          | (Now block)  | Internal                                          |
| Mobile PWA shell                       | `81e2208`    | Strategic doc Phase 3 partial                     |
| NetSuite connector v1                  | `c2ef068`    | Strategic doc Phase 1 ERP                         |
| NetSuite v2 (enc creds, cursor sync)   | `1b7036e`    | Strategic doc Phase 1 hardening                   |
| Tally v2 (multi-company, retry, reverse) | `ef3a9ac`  | Strategic doc Phase 4 partial                     |
| SAP S/4HANA + D365 + Acumatica         | `6a119ed`    | Strategic doc Phase 3 / 4 ERP coverage            |
| Razorpay sibling for India             | `4db2bbf`    | Strategic doc Phase 4 (India deferral disagreement) |
| Web Push + service worker              | `4db2bbf`    | Strategic doc Phase 3 mobile                      |
| Customer portal v1 + pay-now           | `4db2bbf`    | Strategic doc Phase 4 customer portal             |
| DocuSign e-signature                   | `e03503e`    | Strategic doc Phase 2                             |
| EDI X12 + EDIFACT translation          | `e03503e`    | Synthesized gap list, EDI                         |
| RLHF feedback + reward rollups         | `e03503e`    | Strategic doc Phase 4 (Mercura parity)            |
| ERP-query chat (internal Claude tools) | `e03503e`    | Strategic doc Phase 5 (MCP partial)               |

### What's partial

These are shipped but narrower than the strategic doc calls for:

- **Document AI**: single LLM call against Mistral or Claude. Strategic
  doc Phase 1 calls for layout-aware ingestion (Reducto, Unstructured,
  Azure Document Intelligence) plus per-customer correction loop plus
  multi-tab Excel tenders plus handwritten and faxed POs. This is the
  doc's #1 technical risk callout.
- **Customer portal**: v1 ships read-only quotes / orders / invoices
  plus pay-now. Strategic doc calls for v2 with reorder, full quote
  acceptance flow, and invoice download.
- **Win/loss tracking**: we have the `lost_reasons` taxonomy (Admin
  CRUD) but no Soff-style analytics surface (lost-reason trending,
  rep-level efficiency, response-time SLA, customer buying-pattern
  analytics).
- **ERP-query chat**: built as an internal Claude-tool-use loop. The
  strategic doc calls for an MCP server (Hermes-style) so authorized
  external AI assistants (Claude, ChatGPT, Copilot) can query Anvil's
  data plane.
- **ERP coverage**: 5 ERPs live (NetSuite, SAP, D365, Acumatica, Tally).
  Strategic doc calls for 10+ including Epicor Prophet 21 (the wedge
  ERP for the recommended ICP), Epicor Eclipse, Infor SX.e, Sage X3,
  JobBoss, Plex, IFS, JD Edwards, Oracle EBS, proALPHA, Ramco.
- **Inbound channels**: outbound email + WhatsApp shipped. No inbound
  email connector, no inbound WhatsApp / Teams / Slack / Aliyun.
- **Voice**: nothing on the inbound or outbound side.

### What's open

Everything else from the strategic doc. Detailed in Phases 3 to 7
below.

## 3. Phasing principles

The strategic doc's 6-phase shape is preserved. Within each strategic
phase, items have been clubbed by shared infrastructure so a single
commit family lands them together with no rework:

- All ERP connectors share `_lib/erp-runner.js` plus `_lib/secrets.js`
  plus the per-ERP `<prefix>_sync_runs`, `<prefix>_retry_queue`,
  `<prefix>_sync_state` schema. New ERPs land as one migration plus
  one `_lib/<erp>-client.js` plus 7 endpoints.
- All inbound-channel connectors share thread-state, dedup, and the
  intake hand-off. Email and chat channels reuse the same thread state.
- Catalog intelligence (synonym, alternative-part, private-label) all
  extend `item_master` + the quoting engine. Bundle in one phase.
- Voice features (inbound calls, outside-sales voice notes, multi-
  language) share the Vapi or Retell adapter. Bundle in one phase.
- Compliance work is mostly programs not features; the code-side
  controls cluster around audit log export, access reviews, and
  evidence collection. Bundle separately from feature work.

## 4. Phase 3: ICP wedge (Tier 1, COMPLETE)

**Goal.** Ship enough to win the recommended ICP (US mid-market industrial
distributors in fasteners, PVF, electrical wholesale, HVAC supply,
$20M to $300M revenue) per the strategic doc's Phase 1 plus the
extraction-quality risk callout.

**Status.** All five sub-items shipped. Commit references inline.

### 3.1 Distributor ERP connectors `[done]` (this commit family)

Add Epicor Prophet 21, Epicor Eclipse, Infor SX.e using the existing
`erp-runner.js` framework.

**Technical strategy.**

- Each ERP gets a migration (`027_prophet21.sql`, `028_eclipse.sql`,
  `029_sxe.sql`) following the shape of `017_sap_connector.sql`:
  encrypted-credential columns on `tenant_settings`, `<prefix>_sync_state`,
  `<prefix>_sync_runs`, `<prefix>_retry_queue`, plus per-entity mirror
  tables.
- Each ERP gets a `_lib/<erp>-client.js`. Auth differs per ERP:
  - **Prophet 21**: REST API at `/api/v2/odata/`, auth via Basic
    or token-issuance against `/api/v2/Common/Token`. Sessions
    cached like the Acumatica cookie pattern.
  - **Eclipse**: SOAP via Solar Eclipse web services. Wrap the
    XML envelope in a JSON facade so the rest of the connector
    looks identical to the OData ones.
  - **Infor SX.e**: REST via Infor ION API gateway, OAuth2
    client_credentials (reuse `_lib/oauth2.js`).
- Each ERP gets the standard 7 endpoints under `src/api/<erp>/`:
  `connect.js`, `health.js`, `sync.js`, `push.js`, `retry.js`,
  `diagnostics.js`, `field_map.js`. Same shape as the SAP / D365
  / Acumatica files (lift and adapt).
- Entity coverage per ERP:
  - **Prophet 21**: Customer, Item, SalesOrder, PurchaseOrder,
    Branch, Currency, InventoryQuantity, plus reverse-sync of SO
    status. Cursor on `lastModifiedDate`.
  - **Eclipse**: Customer, Product, SalesOrder, PurchaseOrder,
    Branch, plus reverse-sync. Eclipse uses `LastChangedDateTime`.
  - **Infor SX.e**: ARPCustomer, ICSWStockMaster, OEEHHdr (sales
    orders), POEHHdr (purchase orders), Warehouse, Currency.
    Cursor on `LastModifiedDate`.
- Cron entries: every 30 minutes for sync, every 5 minutes for retry
  drain, identical to existing ERPs.
- Client surface: `ObaraBackend.prophet21`, `ObaraBackend.eclipse`,
  `ObaraBackend.sxe` via the `erpFactory` in `anvil-client.js`.
- Admin UI: extend the Admin Center with three new tabs reusing the
  NetSuite / SAP tab pattern (sync table, retry banner, diagnostics
  panel, field-map editor, recent runs log).

**Exit criteria.**

- All three ERPs probe ok against a sandbox account.
- Each connector pushes a Sales Order end-to-end on a sandbox.
- Retry queue drains a 5xx pushback successfully.
- Migrations 027-029 apply idempotently.
- Audit clean. Tests for each `_lib/<erp>-client.js` round-trip
  encryption.

### 3.2 Inbound email connector `[done]` (commit on `main`)

Catch RFQs and POs landing in customer inboxes and feed them into the
existing intake.

**Technical strategy.**

- Migration `030_inbound_email.sql`: `inbound_emails` table (id,
  tenant_id, message_id, in_reply_to, thread_id, from_address,
  to_addresses, subject, body_text, body_html, raw_mime,
  attachments_jsonb, received_at, status: received | parsed |
  linked | duplicate | failed). Plus `inbound_email_threads` table
  for thread-state aggregation.
- Two adapters under `_lib/inbound-email/`:
  - `postmark.js`: webhook receiver for Postmark Inbound. Verifies
    HMAC over body using `POSTMARK_INBOUND_SECRET`. Parses MIME,
    persists, dedups by `Message-ID`. Tenant resolution via the
    inbound address pattern (e.g. `<tenant_slug>@inbound.anvil.app`).
  - `microsoft_graph.js`: subscription receiver. Per-tenant
    Microsoft Graph subscription on the customer's mailbox folder;
    callback validates the `clientState` token and pulls the
    message via Graph API.
- Endpoint `/api/inbound/email/webhook` dispatches by header to
  the right adapter.
- Endpoint `/api/inbound/email/parse` (cron, every minute): picks
  `status=received` rows, runs the existing intake extraction on
  the body plus attachments, links to a `Quote` or new draft, flips
  to `linked`.
- Endpoint `/api/inbound/email/threads`: read-only listing for the
  Inbox screen.
- Inbox screen extension: new `inbound` tab showing threads with
  the matched RFQ or PO, dedup hint when a `Message-ID` matches an
  existing thread, "open in intake" action.
- Dedup rules:
  - exact `Message-ID` match: drop with `status=duplicate`.
  - Same `from_address` plus same subject within 24h: link to
    same thread, surface a banner.
  - CC'd recipients: collapse into one canonical thread per
    `In-Reply-To` chain.

**Exit criteria.**

- Postmark webhook test passes.
- Graph subscription round-trips on a test mailbox.
- A duplicate message is correctly flagged.
- Intake auto-extracts on inbound and produces a draft quote.

### 3.3 Document AI v2 (layout-aware extraction) `[done]` (commit on `main`)

Replace the single LLM call with a layered ingestion pipeline that
hits the doc's #1 technical risk: extraction quality at scale.

**Technical strategy.**

- New service `_lib/docai/` with adapter modules:
  - `reducto.js`: HTTP client for Reducto (`POST /parse`).
  - `azure_di.js`: HTTP client for Azure Document Intelligence
    (`POST /formrecognizer/documentModels/prebuilt-document:analyze`).
  - `unstructured.js`: HTTP client for Unstructured.io as a
    fallback for messy faxed scans.
  - `excel.js`: in-process multi-tab Excel parser using SheetJS
    plus a heuristic header detector for thousand-line tenders.
- Migration `031_docai_extraction.sql`: `extraction_runs` table
  (id, tenant_id, source: pdf | xlsx | scan | email_attachment,
  source_id, adapter_used, started_at, finished_at, raw_extract
  jsonb, normalized_extract jsonb, confidence_overall, error,
  status: running | ok | low_confidence | failed). Plus
  `extraction_corrections` table that captures every operator
  correction back to the system: original field, corrected value,
  user_id, applied_at.
- Endpoint `/api/docai/extract` accepts a document reference and
  returns the normalized extract plus per-field confidence. Routes
  by source-type:
  - PDFs go to Reducto first, fall back to Azure DI, fall back to
    the existing Mistral / Claude single-call.
  - Multi-tab Excel goes to the in-process parser plus an LLM
    pass to map columns to the canonical line-item schema.
  - Scanned faxes and handwritten POs go to Azure DI handwriting
    model plus a Claude clean-up pass.
- Endpoint `/api/docai/correction` records an operator correction
  and queues a fine-tuning sample (writes to `rlhf_feedback` with
  surface=`intake` so the existing RLHF aggregator picks it up).
- Per-customer correction loop:
  - When `extraction_corrections` accumulates more than 50 rows
    for a given (tenant_id, customer_id, field), the system
    promotes those rows into a per-customer prompt example
    bundle (`tenant_settings.docai_prompt_overrides` jsonb).
  - Subsequent extractions for that customer prepend the
    examples to the LLM context. This is RAG-style few-shot,
    not real fine-tuning. Real fine-tuning is Phase 6 work.
- UI: extend the existing intake screen to show the adapter used,
  per-field confidence chips, and a per-correction history panel.

**Exit criteria.**

- Reducto adapter and Azure DI adapter probe ok.
- Multi-tab Excel: a 1500-row test tender extracts in under 30s and
  produces a structured line-item list.
- A corrected extraction writes back to `extraction_corrections`
  and shows up in the next extraction's context.
- 90% accuracy on a held-out PDF corpus from one design partner.

### 3.4 MCP server (external AI surface) `[done]` (commit on `main`)

Expose Anvil's data plane via the Anthropic Model Context Protocol
so external AI assistants (Claude desktop, ChatGPT plugins, Copilot)
can read Anvil data with per-tenant scoping.

**Technical strategy.**

- New endpoint `/api/mcp/server` that speaks the MCP wire protocol
  over Server-Sent Events. Auth: per-tenant API token created in
  the Admin Center.
- Migration `032_mcp_tokens.sql`: `mcp_tokens` table (id, tenant_id,
  user_id, token_hash, scopes text[], expires_at, last_used_at,
  use_count). Token issuance writes the hash, returns the plaintext
  token once.
- The MCP tool surface mirrors the existing `_lib/erp-chat-tools.js`
  list. We refactor that file to export a single `ToolRegistry`
  consumed by both the internal ERP chat and the MCP server. Same
  9 tools: `search_orders`, `search_invoices`, `search_customers`,
  `search_netsuite_open_orders`, `search_sap_sales_orders`,
  `search_d365_sales_orders`, `search_acu_sales_orders`,
  `search_inventory`, `open_invoices_aging`. Plus 2 new tools to
  make the MCP server materially useful: `get_quote_status` and
  `summarize_open_pipeline`.
- Per-tool RBAC: token scopes (`read.orders`, `read.invoices`, etc.)
  gate which tools are callable.
- Audit: every MCP tool call writes an `audit_events` row plus an
  `mcp_call_log` row.
- Admin Center MCP tab: token CRUD, last-used timestamp, usage chart,
  revocation.

**Exit criteria.**

- Claude desktop config (`mcp_servers` block) can connect using a
  generated token.
- A `search_orders` call returns scoped data.
- Token scopes are enforced (a token without `read.invoices` cannot
  call `search_invoices`).
- Audit events fire on every call.

### 3.5 Customer-tier RFQ priority and dedup `[done]` (folded into 3.2 commit)

Soff-style routing: high-tier customers' RFQs jump the queue, dup
RFQs across CC'd recipients collapse to one.

**Technical strategy.**

- Extend `customers` table: add `tier` text column with values
  `strategic | preferred | standard`. Migration `033_customer_tier.sql`.
- Extend the inbound-email parse step (3.2) and the existing
  `intake` flow:
  - Compute a priority score from tier plus value plus customer
    history.
  - Surface a sorted Inbox screen with banded sections
    (Strategic, Preferred, Standard).
- Dedup rules in inbound-email parse (3.2) extended:
  - Hash subject plus first 200 chars of body plus from-domain.
  - If a hash matches a row from the last 7 days, mark
    `status=duplicate` and link to the canonical thread.
- Settings tab in Admin Center for customer-tier CRUD.

**Exit criteria.**

- Customers screen shows tier chip.
- Inbox screen sorts by priority.
- A duplicate-CC scenario produces only one canonical thread.

## 5. Phase 4: Cash close, sourcing, and analytics

**Goal.** Finish the QTC loop's analytics surface and ship the
buy-side and customer-portal v2. This corresponds to the strategic
doc's Phase 4 plus the Soff-parity items from Phase 5.

### 4.1 Outbound supplier RFQ orchestration (Lumari module) `[open]`

BOM in, multi-vendor emails out, normalized comparison matrix, PO
tracking with acknowledgement and ship-date monitoring.

**Technical strategy.**

- Migration `034_supplier_rfq.sql`:
  - `supplier_rfqs` (id, tenant_id, source_order_id, status: draft
    | sent | quoting | awarded | closed, due_at, notes).
  - `supplier_rfq_lines` (rfq_id, line_no, item_id, quantity,
    spec, target_price).
  - `supplier_rfq_invitations` (rfq_id, vendor_id, sent_at,
    response_received_at, response_status: pending | quoted |
    declined | expired, notes).
  - `supplier_quotes` (id, invitation_id, line_no, unit_price,
    lead_time_days, currency, validity_days, raw jsonb).
- Endpoints:
  - `/api/supplier_rfq` (CRUD).
  - `/api/supplier_rfq/send`: drafts emails per vendor (uses the
    SendGrid path), records invitations.
  - `/api/supplier_rfq/parse_response`: accepts a vendor reply
    (parsed via Document AI v2 from 3.3), creates a
    `supplier_quotes` row.
  - `/api/supplier_rfq/matrix`: returns a comparison matrix
    keyed by line, showing each vendor's price, lead time,
    delta to target.
- Reuse `agents` v1 to run a follow-up loop on overdue
  invitations. Reuse the Tally / NetSuite vendor mirrors when
  picking vendors.

**Exit criteria.**

- An RFQ with 5 vendors round-trips end to end.
- Comparison matrix renders a numerical delta against the target
  price.
- Follow-up agent fires after 3 days of silence.

### 4.2 Order-confirmation reconciliation (Comena unique) `[open]`

Compare a vendor order confirmation against the issued PO.

**Technical strategy.**

- New endpoint `/api/orders/reconcile`: takes a vendor confirmation
  document (PDF or email), runs Document AI v2 (3.3), diffs against
  the original order line items, returns a structured discrepancy
  report (price, qty, lead time, terms).
- New `order_reconciliations` table records each diff for audit
  trail.
- SO Workspace tab: "Confirmation" tab showing the diff with red
  highlights for mismatches.

**Exit criteria.**

- A mismatched lead-time confirmation surfaces a banner on the SO
  Workspace.
- Operator can accept or reject the confirmation; rejection sends
  a clarifying email back via the SendGrid path.

### 4.3 Customer portal v2 `[open]`

Full self-service: reorder, invoice download, full quote acceptance
flow, order status with line-item detail.

**Technical strategy.**

- Extend `portal_tokens.scopes` with `reorder`, `download_invoice`,
  `accept_quote`.
- New endpoints:
  - `/api/portal/reorder` (token-scoped POST): given a past order
    id, creates a new draft order with the same line items.
  - `/api/portal/invoice_pdf` (token-scoped GET): generates a
    fresh signed URL for the invoice PDF (reuse
    `/api/_lib/pdf-renderer.js`).
  - `/api/portal/accept_quote` (token-scoped POST): records
    customer acceptance, audits `quote_accepted`, advances the
    order state machine.
- A standalone customer-facing route `/portal/<token>` that
  renders a Vue or Vite-built read-only app served from the same
  origin. Out of the v3-app shell so customers don't see Anvil
  internal chrome.

**Exit criteria.**

- A customer can reorder a past order without leaving the portal.
- A customer can accept a quote, signed PDF lands in storage, and
  the SO Workspace flips to APPROVED.
- A customer can download an invoice PDF.

### 4.4 Win/loss dashboard (Soff parity) `[open]`

Lost-reason trending, rep-level efficiency, response-time SLA,
customer buying-pattern analytics.

**Technical strategy.**

- New view in Postgres: `v_winloss_daily` aggregates orders by
  status (won, lost, expired) bucketed by created_at day, joined
  to `lost_reasons` and `auth.users` for rep attribution.
- New endpoint `/api/analytics/winloss`: returns the rolled-up
  metrics filtered by date range, rep, customer-tier, vertical.
- New screen `screens/winloss.tsx`: stacked bar of won-vs-lost,
  pie of lost-reasons, table of rep response-time medians, table
  of top-customer win-rates.
- Cron `/api/analytics/refresh` (daily at 02:00) materialises
  rollups into `analytics_winloss_daily` for fast reads.

**Exit criteria.**

- Dashboard shows a 30-day win-rate trend.
- Lost-reason pie reflects the `lost_reasons` admin CRUD.
- Rep efficiency table sorts by median response time.

### 4.5 Auto-print travelers (Smartbase unique) `[open]`

After a successful PO push to ERP, generate a traveler PDF and
optionally route to a network printer.

**Technical strategy.**

- Reuse `_lib/pdf-renderer.js` to generate a traveler PDF from the
  pushed sales order plus item-master data.
- New endpoint `/api/orders/traveler` (POST): renders the PDF,
  uploads to Supabase storage, returns the signed URL.
- Optional printer relay: the same Tally bridge pattern. A small
  on-prem agent at the customer's site (out of code scope; document
  the contract) polls a print queue endpoint and ships PDFs to a
  CUPS / IPP printer.
- Schema: `print_jobs` (id, tenant_id, order_id, pdf_url,
  printer_id, status, sent_at, error). Migration `035_travelers.sql`.
- Wire into the ERP push success handlers (NetSuite, SAP, D365,
  Acumatica, Tally, Prophet 21, Eclipse, SX.e): when push status
  flips to `exported`, optionally enqueue a `print_jobs` row if
  the tenant has `auto_print_travelers=true`.

**Exit criteria.**

- A push to NetSuite generates a traveler PDF in storage.
- The print-jobs queue surfaces in Admin Center.

### 4.6 Catalog intelligence `[open]`

Synonym and typo-tolerant semantic catalog search, alternative-part
suggestion, private-label upsell.

**Technical strategy.**

- Migration `036_catalog_intel.sql`:
  - `catalog_synonyms` (item_id, synonym text, source: manual |
    learned). Tenant-scoped.
  - `catalog_alternatives` (item_id, alternative_item_id,
    relation: equivalent | upgrade | downsell, margin_delta).
  - `private_label_items` (item_id, label_brand, margin_bps).
- New endpoint `/api/catalog/search`: takes a free-text query,
  runs `pg_trgm` similarity against `item_master.description` and
  `catalog_synonyms.synonym`, returns top N items plus their
  alternatives and any private-label upgrade.
- Quoting engine extension: when an extracted line resolves to an
  item with private-label alternative, surface the alternative as
  a suggestion in the quote builder. Operator one-click swap.
- Synonym learning: when an operator selects a non-default match
  during intake, record the mapping into `catalog_synonyms` with
  `source=learned`.

**Exit criteria.**

- A typo'd query ("benring 1.5" for "bearing 1.5") returns the
  right item.
- An item with a private-label equivalent surfaces an upsell chip.
- Operator selection writes back to synonyms.

### 4.7 Knowledge-base assistant for inside-sales reps `[open]`

Avent / Axal parity. Reps ask "what was Acme's last price on
SKU-1234?" and get an answer grounded in ERP, CRM, catalog, and
past quotes.

**Technical strategy.**

- New endpoint `/api/kb/ask` (POST): wraps the ERP-query chat
  (3.4 will refactor `_lib/erp-chat-tools.js` into a registry
  consumed by both this and the MCP server).
- Tool surface for the KB assistant additionally includes:
  `customer_history`, `last_purchase_price`, `quote_template_for`.
- New screen `screens/kb-chat.tsx` mounted in the v3-app shell
  alongside the existing tools. Chat UI styled like the existing
  ERP-query-chat but scoped to inside-sales context.

**Exit criteria.**

- A rep can ask for a customer's last-12-month purchase history
  and get an answer with citations.
- A rep can ask "what's our usual margin on Acme orders" and get
  a grounded numerical answer.

## 6. Phase 5: Voice, multi-channel inbound, GAEB, remaining ERPs

**Goal.** Reach Mercura / Avent / Axal feature parity on voice and
multi-channel ingestion. Cover the long tail of ERPs needed for
enterprise deals. This corresponds to the strategic doc's Phase 3
voice items plus Phase 6 remaining-ERP items, clubbed because they
share infrastructure.

### 5.1 Voice agent (Vapi or Retell adapter) `[open]`

Inbound calls handled by an AI agent that authenticates the
customer, places orders, checks delivery times, generates quotes,
and hands off to a human when needed.

**Technical strategy.**

- Buy not build: Vapi or Retell. Both expose webhook callbacks for
  call events and a structured-output endpoint for transcripts.
- Migration `037_voice.sql`: `voice_calls` (id, tenant_id, provider,
  external_id, direction, started_at, ended_at, duration_s,
  customer_id, transcript jsonb, summary, action_extracted jsonb,
  status: in_progress | completed | failed). Plus
  `voice_call_actions` (call_id, action: place_order | quote_request
  | check_delivery | escalate, payload jsonb, completed: bool).
- Endpoints:
  - `/api/voice/webhook`: receives provider events (call started,
    call ended, transcript ready). Verifies HMAC signature.
  - `/api/voice/configure`: per-tenant config of provider, phone
    number, voice persona, system prompt template.
  - `/api/voice/handoff`: triggered when the agent escalates;
    forwards the call to a human number plus posts a summary
    notification.
- The action extractor reuses Claude with a tool-use loop similar
  to the ERP-query chat: tools include `verify_customer`,
  `place_sales_order`, `check_delivery_status`, `generate_quote`.
- Customer authentication: name plus phone plus customer-id
  challenge-response. Soft fail to human handoff on three misses.

**Exit criteria.**

- A test call to a configured Vapi number is recorded in
  `voice_calls`.
- The agent successfully places an order via the existing intake
  flow.
- Escalation correctly forwards to a human number.

### 5.2 Inbound WhatsApp / Slack / Teams ingestion `[open]`

Korso parity for international and async channels.

**Technical strategy.**

- Reuse the inbound thread-state shape from 3.2 (rename
  `inbound_emails` to `inbound_messages` if needed). Migration
  `038_inbound_chat.sql` adds `channel` enum (`email`, `whatsapp`,
  `slack`, `teams`, `wechat`) plus per-channel adapter config.
- Adapters under `_lib/inbound/`:
  - `whatsapp.js`: Twilio WhatsApp webhook, body parsing,
    media-attachment handling.
  - `slack.js`: Slack Events API; per-tenant install handled via
    OAuth flow.
  - `teams.js`: Microsoft Bot Framework callback.
- Each adapter normalises into `inbound_messages` with the same
  `linked` -> `intake-extracted` lifecycle as email.
- Outbound replies on the same channel: extend
  `_lib/communications/send.js` to accept `channel=whatsapp|slack|
  teams` so the dunning agent and follow-up loops can reply in-
  channel.

**Exit criteria.**

- An inbound WhatsApp message produces a draft quote.
- A Slack DM in a connected workspace creates an intake row.
- A Teams chat triggers a quote.

### 5.3 GAEB tender format parser `[open]`

German construction-tender XML standard. Mercura's moat.

**Technical strategy.**

- New module `_lib/docai/gaeb.js`: parses GAEB X81 / X83 / X84 / X86
  XML (DA XML schema). Maps onto the canonical line-item structure
  via a deterministic XSL-style transform plus a Claude pass for
  free-text positions.
- Wire into the Document AI v2 router (3.3): GAEB files route to
  `gaeb.js` directly with no LLM fallback.
- Output the same canonical schema so the rest of the pipeline (
  intake, quoting, supplier RFQ) is unchanged.

**Exit criteria.**

- A reference GAEB X83 file produces structured positions.
- A GAEB X86 award file links back to the originating X83.

### 5.4 Remaining ERP connectors `[open]`

Sage X3, JobBoss, Plex (Rockwell), IFS, JD Edwards, Oracle EBS,
Oracle Fusion, proALPHA (DACH), Ramco (India). All ship using the
existing `erp-runner.js` framework.

**Technical strategy.**

- Same pattern as 3.1: per-ERP migration, `_lib/<erp>-client.js`,
  7 endpoints, 30m sync plus 5m retry crons, Admin tab.
- Auth varies:
  - **Sage X3**: SOAP plus REST mix; OAuth2 client_credentials.
  - **JobBoss**: ODBC (legacy) plus REST in newer versions; if
    REST not available, document an SFTP file-drop adapter.
  - **Plex**: REST plus Web Services; API-key auth.
  - **IFS**: OData v4; OAuth2 (reuse `_lib/oauth2.js`).
  - **JDE**: AIS REST; token auth.
  - **Oracle EBS / Fusion**: REST plus SOAP; OAuth2 with
    instance-specific token endpoint.
  - **proALPHA**: REST; Basic auth with rotating creds.
  - **Ramco**: REST; OAuth2.
- Group by sprint: Sage X3 + JobBoss + Plex first (mid-market
  industrial), then IFS + Oracle Fusion (enterprise), then
  Oracle EBS + JDE (legacy enterprise), then proALPHA + Ramco
  (regional).

**Exit criteria.**

- All 9 ERPs probe ok against sandbox.
- Each pushes a Sales Order successfully.
- Total live ERPs: 14 (5 already shipped plus 3 from Phase 3.1
  plus 9 here, minus any duplicates).

### 5.5 PLM connectors (Windchill, Arena) `[open]`

Lumari parity. Pulls BOM and engineering change orders.

**Technical strategy.**

- Migration `046_plm.sql`: `plm_systems` (tenant_id, system: windchill
  | arena, base_url, encrypted creds), `plm_boms` (id, tenant_id,
  source_system, external_id, part_number, revision, structure jsonb,
  synced_at), `plm_changes` (id, tenant_id, source_system, eco_id,
  status, affected_parts text[], effective_date).
- `_lib/windchill-client.js`: REST API auth via Basic; OData-style
  filters; entity coverage = WTPart, WTPartUsageLink, ChangeNotice.
- `_lib/arena-client.js`: REST API; key auth; entity coverage =
  Item, BOM, Change.
- Endpoints `/api/plm/<system>/sync`, `/api/plm/<system>/connect`,
  `/api/plm/<system>/health` follow the ERP shape but no push
  (PLM is read-only for now).
- Wire BOM data into the supplier-RFQ module (4.1) so a BOM-out
  RFQ pulls structure from the PLM.

**Exit criteria.**

- Windchill BOM sync produces structured rows.
- Arena ECO surfaces in an Admin Center notifications panel.

### 5.6 In-network back-to-back sourcing `[open]`

Avent unique. When a SKU is out of stock at Tenant A, Anvil checks
Tenant B's inventory mirror and proposes a back-to-back deal.

**Technical strategy.**

- New endpoint `/api/sourcing/network`: given a SKU and quantity,
  queries the inventory mirrors of every tenant with `network_share=
  true` setting, returns matches with margin estimate.
- Tenant opt-in only. Privacy: only stock levels and approximate
  lead time are shared, never customer or pricing data.
- New `network_listings` table for any tenant who explicitly
  publishes available stock to the network.
- UI: inside the SO Workspace, when an item is short, surface a
  "source from network" panel.

**Exit criteria.**

- Tenant A short on SKU-X sees Tenant B's available stock.
- Opt-out tenants are correctly excluded from search results.

## 7. Phase 6: Compliance, vertical depth, advanced AI

**Goal.** Enterprise readiness plus the long-tail competitor parity
items. Corresponds to the strategic doc's Phase 5 plus Phase 6.

### 7.1 SOC 2 Type I `[open]`

This is mostly a program, not a feature. Code-side requirements:

- `/api/audit/export`: time-bounded JSONL dump of `audit_events`,
  signed and downloadable by admins.
- `/api/admin/access_review`: monthly snapshot of every member's
  role per tenant.
- Vercel deploy hook to a `deploys` table for the change log.
- A `security` directory with policy docs (already partial).
- Drata or Vanta integration for evidence collection (vendor pick).

### 7.2 SOC 2 Type II `[open]`

Continuation of 7.1 with the 3-month observation window. No
additional code unless 7.1 controls drift; the audit itself is a
program activity.

### 7.3 ITAR / GovCloud / CMMC L2 / on-prem option `[open]`

- Deploy a parallel stack on AWS GovCloud (us-gov-east-1).
- Per-tenant `data_residency` field on `tenants` table.
- US-person-only access controls on the GovCloud tier.
- On-prem packaging: Docker Compose plus self-hosted Supabase plus
  Postgres. Supply chain: container scanning, SBOM, signed images.
- CUI / ITAR / Export-Controlled marking auto-detection on uploaded
  drawings: extend Document AI v2 (3.3) with a classifier model
  that scans for the 15 standard markings (CUI, ITAR, EAR, NOFORN,
  REL TO, etc.) and tags the document at ingestion. Block downstream
  flow until acknowledgement.

### 7.4 Vertical templates `[open]`

Fastener, PVF, electrical, HVAC, paper converting (Arzana parity).

**Technical strategy.**

- One JSON config per vertical at `src/v3-app/verticals/<id>.json`
  containing: approval thresholds, lead-time defaults, lost-reason
  taxonomy, contract types, item-master examples, quote-template,
  vertical-specific KPIs.
- Endpoint `/api/admin/install_vertical_pack` loads a pack into the
  current tenant's seed tables.
- Per-vertical screen overlays: `verticals/<id>/screens/` for any
  components conditionally rendered when `tenant_settings.vertical=<id>`.
- Paper-converting pack ships first as a proof of the model
  (basis-weight conversion, FSC chain of custody, roll assignment),
  then fastener and PVF, then electrical and HVAC.

### 7.5 Per-customer fine-tuned extraction models `[open]`

Beyond the prompt-overrides loop in 3.3, do real fine-tuning when
correction-volume justifies it.

**Technical strategy.**

- Reuse the RLHF dataset export (`/api/rlhf/dataset`) to feed a
  TRL or Axolotl pipeline.
- Out-of-process: a separate worker (Modal or a long-running EC2)
  consumes the dataset, fine-tunes a small model (Llama 3.1 8B or
  similar), pushes to a hosted inference endpoint.
- New endpoint `/api/docai/route` chooses between the prompt-
  overrides path (small N) and the fine-tuned model (large N)
  per-customer.

### 7.6 Agent evaluation and benchmarking infrastructure `[open]`

Raven pattern, transferable.

**Technical strategy.**

- New module `_lib/agent-eval/`: a harness that replays historical
  agent runs against the current model, scores outputs against
  ground truth from operator corrections, tracks regression.
- Cron `/api/agents/eval` (weekly): runs the harness on a held-out
  set, writes `agent_eval_runs` results.
- Admin Center surface showing model drift over time.

### 7.7 Outside-sales voice-note to CRM `[open]`

Axal parity. Rep records a voice note, Anvil transcribes, extracts
action items (new opp, follow-up, contact update), writes to CRM.

**Technical strategy.**

- Reuse the voice infrastructure from 5.1.
- New endpoint `/api/voice/note`: accepts an audio upload,
  transcribes, runs Claude with a tool surface that includes
  `create_opportunity`, `update_contact`, `schedule_followup`.
- Mobile shell action: large mic button on the Home screen.

### 7.8 Outbound prospecting agent `[open]`

Arzana parity, deferred until trust is established.

**Technical strategy.**

- Multi-source lead scoring (Apollo or LinkedIn Sales Navigator
  via API, ZoomInfo, internal contact database).
- Sequenced outbound emails through the existing SendGrid path,
  with a kill-switch for unsubscribes.
- Per-tenant approval gate before any email actually sends, so the
  feature can ship without anyone fearing accidental cold-spam.

### 7.9 AP 3-way match plus deductions / short-pay flagging `[open]`

Arzana plus Axal parity.

**Technical strategy.**

- Reuse the invoice-matching pattern from existing AR work.
- New `ap_invoices` table mirroring vendor invoices.
- Reconciler that joins (po, goods receipt, ap_invoice) and
  flags discrepancies. Threshold-based auto-approve when within
  tolerance.
- Deductions: when a customer pays less than invoice grand_total,
  flag and route to a finance review queue.

## 8. Phase 7: continuous

These are not phase-bounded. They run forever once started.

- Telemetry and performance: Sentry plus PostHog plus
  `/api/health` is already wired. Tighten as needed.
- RLHF dataset growth: every operator correction feeds the model
  improvement loop.
- Deferred items in `docs/DEFERRED_ROADMAP.md` (voice AI scope
  decision, vertical-pack scope, native iOS, SOC 2 program kickoff)
  resolve to phases above when product or program decisions land.

## 9. Year-2 strategic decision

The strategic doc's open question: do we pick custom-fab CNC
quoting (compete with Paperless Parts) or buyer-side direct
procurement (compete with Lumari) as the second wedge?

The strategic doc leans toward buyer-side procurement because
Lumari has a 2-person GTM team and Paperless Parts has 200+
employees plus decade-deep CAD IP. Defer the decision to month 12
with real customer-conversation data.

If buyer-side wins: Phase 4.1 (supplier-RFQ orchestration) and
Phase 5.5 (PLM connectors) are the platform. Build out
procurement-specific surfaces on top.

If custom-fab wins: partner with Toolpath or CADExchanger for the
geometry kernel rather than building OpenCascade in-house. Add a
DFM rule engine, a CAM-time estimator, and ITAR posture
acceleration.

## 10. Risks (carried forward from the strategic doc)

- **Codebase reality versus assumed reality**: the strategic doc
  was built on structural inference about Anvil's stack. The actual
  stack (Vite plus React plus Vercel serverless plus Supabase
  Postgres) is materially closer to ready than the doc assumed.
  This makes Phase 3 cheaper than the doc estimates.
- **Competitive risk: Arzana**. Broad surface, NYT validation,
  ITAR posture, named customers, forward-deployed model. Defense:
  ship the cash loop and SOC 2 Type II faster than they pivot
  off bespoke services.
- **Technical risk: extraction quality at scale**. Phase 3.3
  exists specifically to address this. Buy Reducto or Azure DI,
  invest in the per-customer correction loop.
- **Compliance risk: SOC 2 Type II observation window**. Cannot
  be compressed below 3 months. Start the audit window when
  Phase 3 is wrapping so it lands during Phase 5.

## 11. How to use this doc

When you start work on an item:

1. Find the item in the relevant phase.
2. Confirm dependencies (prior phase items that must be `[done]`).
3. Implement following the technical strategy as the high-level
   sketch, with freedom to deviate when reality demands.
4. Land the work as one or more commits.
5. Edit this file: change `[open]` to `[done]` plus the commit
   hash. Update the status snapshot in section 2 if a partial
   becomes complete.
6. If the work uncovers a new item that should be tracked, add a
   subsection under the appropriate phase. Do not create a new
   roadmap doc.

When direction changes (a new gap analysis lands, a customer demand
shifts priorities, a competitor ships something material):

1. Update section 2 (status snapshot) and section 10 (risks).
2. Re-order phases if needed; do not delete items unless they're
   superseded. Mark them `[deprecated]` with a one-line reason.
3. Note the change in a "Change log" appendix at the bottom of this
   file.

## 12. Change log

- Initial version: created from the strategic gap analysis at
  `~/Downloads/Anvil Gaps Analysis.md` and the snapshot of `main`
  through commit `e03503e`. Phases 1 and 2 mapped to already-shipped
  work. Phases 3 to 7 mapped to open work, grouped by shared
  infrastructure rather than by strategic-doc month boundary.
- Phase 3 complete: every Phase 3 sub-item shipped in a four-commit
  family on `main`. ICP wedge is in:
  - 3.4 MCP server: external AI surface, 9-tool registry shared
    with internal ERP chat, scope-gated tokens, JSON-RPC 2.0 wire
    protocol, per-call audit log.
  - 3.2 + 3.5 inbound email + customer-tier priority + dedup:
    Postmark + Microsoft Graph adapters, thread-state, dup-hash
    7-day window, customer-tier weighted priority scoring,
    auto-RFQ detection.
  - 3.3 Document AI v2: 5-adapter layered pipeline (Reducto +
    Azure DI + Unstructured + multi-tab Excel + Claude fallback),
    extraction_runs audit, per-customer correction loop with
    automatic prompt-overrides rebuild at 50-correction threshold.
  - 3.1 Distributor ERP connectors: Epicor Prophet 21 (token auth,
    OData v2), Epicor Eclipse (Basic auth, JSON-first with SOAP
    fallback), Infor SX.e (OAuth2 via ION, M3 REST). Each with
    7 endpoints + 30m sync + 5m retry crons. Total live ERPs
    now 8 (NetSuite, Tally, SAP, D365, Acumatica, P21, Eclipse,
    SX.e).
