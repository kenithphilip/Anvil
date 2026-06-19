# External Integrations

Anvil hooks into eight external services. Each is independent: missing
ones degrade gracefully so the rest of the app keeps working. This doc is
a per-service runbook covering account setup, env vars, and a smoke test.

## Anthropic Claude

What it does: every call to `/api/claude/messages` proxies a Messages API
request. The endpoint applies a redaction firewall, picks a model tier
(Haiku preflight, Sonnet generation, Opus reasoning), parses
`<confidence>X</confidence>` blocks from the model output for the
multimodal fallback, and logs to `model_routing_log`.

Setup:
1. Create a key at https://console.anthropic.com.
2. Set `ANTHROPIC_API_KEY` in Vercel.
3. Optional: override the default models with
   `ANTHROPIC_MODEL_DEFAULT` and `ANTHROPIC_MODEL_PREFLIGHT`.

Smoke test: open the app, intake a sample PO, confirm the SO Agent shows
token usage and a model name in the API Cost Card.

## Supabase

Database, auth, storage, RLS. See `docs/SETUP.md` step 2 for the full
project setup.

Smoke test: in **SQL Editor** run `select count(*) from item_master;`. If
it returns at least 35, migrations are applied correctly.

## Mistral OCR

What it does: server-side OCR with bbox coordinates. The frontend Tesseract
pipeline still works without this; Mistral upgrades quality and gives us
field-to-region citations for the evidence viewer.

Setup:
1. Create a key at https://console.mistral.ai.
2. Set `MISTRAL_API_KEY`.
3. Optional: override the model with `MISTRAL_OCR_MODEL` (default
   `mistral-ocr-latest`).

Smoke test: upload a scanned PDF order, click **Run server OCR + bboxes**.
The Evidence Viewer should highlight bboxes on the rendered PDF page.

## Frankfurter (FX rates)

What it does: free, no-key FX rates source. Used by the daily cron and the
manual refresh button under Admin Center → FX rates.

Setup: nothing required. Optionally override with `FX_PROVIDER_URL` if you
need stricter SLAs (any provider that mirrors Frankfurter's URL grammar
works).

Smoke test: from Admin Center → FX rates click **Refresh now** with `as of`
set to a recent business day. Should return at least 30 rows for the
default 6 currencies.

## ClamAV

What it does: real malware scan of uploaded files. Without it, Anvil
applies deterministic guards (size, count, nesting, executable extension,
macro hint, ZIP bomb).

Setup options:

**Option A: ClamAV REST proxy in your VPC.** Run a container that exposes
`POST /scan` with the contract:

```
Request:  { filename, sha256, content_b64 }
Response: { infected: bool, virus?: string }
```

A reference implementation is `lokori/clamav-rest` from Docker Hub. Set
`CLAMAV_URL` to its base (e.g., `http://clamav:8080`) and optionally
`CLAMAV_TOKEN` for bearer auth.

**Option B: Cloudmersive Virus Scan API.** Their REST shape matches; set
`CLAMAV_URL=https://api.cloudmersive.com/virus/scan/file` and
`CLAMAV_TOKEN` to the api-key value (the proxy must read that header).

**Option C (off):** leave both env vars unset. Deterministic guards still
apply.

Smoke test: upload a known-bad EICAR test file (the standardized antivirus
test string). The Document scan modal should flag it as `MALWARE_DETECTED`.
With ClamAV off, the file uploads but the modal will not flag malware,
only structural issues.

## Tally Prime bridge

What it does: real export of approved sales orders to Tally Prime running
on a Windows machine. Tally exposes an HTTP listener on port 9000 by
default. We do not talk to it directly, we talk to a small bridge service
on the same network because Tally's listener is not authenticated.

Setup:
1. On a machine that can reach Tally, run a bridge that:
   - Listens on a public-or-VPN URL.
   - Accepts `POST` with `Content-Type: text/xml` at the URL root (the
     value you set `TALLY_BRIDGE_URL` to). The body is a fully-formed
     Tally ENVELOPE document, ready to forward.
   - Forwards the bytes to `http://tally-host:9000` and returns Tally's
     raw XML response back to us in the response body. We slice the
     first 10000 bytes and store it on
     `tally_voucher_records.validation` so we can extract `<VOUCHERID>`
     and surface the round-trip in the UI.
   - Validates a bearer token if `TALLY_BRIDGE_TOKEN` is set.
2. Set `TALLY_BRIDGE_URL` and `TALLY_BRIDGE_TOKEN` in Vercel.

Smoke test: approve an order, click **Push to Tally**. The order's
`tally_status` should flip to `exported` and a row should appear in
`tally_voucher_records` with the `tally_voucher_id` populated. Without
the bridge, the API returns `409 BRIDGE_NOT_CONFIGURED` and the UI
disables the push button with a "Tally bridge not configured" banner;
no failed rows accumulate.

The idempotency key is `(customer_gstin, po_number, payload_hash)`. Network
retries that re-push the same approved payload are safe.

## GSTN (Indian GST e-Invoice)

What it does: generates IRN + signed QR for B2B invoices over INR 5 lakh
(threshold may change; it's currently a regulatory minimum).

Sandbox: https://einv-apisandbox.nic.in
Production: typically routed through a GSP (GST Suvidha Provider) like
ClearTax, IRIS, Cygnet, or Taxilla.

Setup:
1. Get sandbox or GSP credentials.
2. Set `GSTN_API_URL` to the base (sandbox or GSP-specific).
3. Set `GSTN_API_KEY` to the value GSP requires in `client_id`.
4. Add `seller_gstin` field on Customer Locations for the entity issuing
   the invoice (default seeded value is Obara India's
   `27AAACO8335K1Z5`).

Smoke test: approve an order, open e-Invoice modal, **Compose draft**,
then **Send to GSTN**. On success the row flips to `GENERATED` with `irn`,
`ack_no`, and `qr_code_b64` populated. Without `GSTN_API_URL` the row stays
in `PENDING_GSTN` and the modal shows "GSTN not configured".

Cancellation window: 24 hours from `ack_date`. After that the **Cancel**
button returns 422 since GSTN refuses cancellations beyond the window.

## Outbound email (communications.send)

What it does: sends customer ack emails, missing-doc requests, AR
dunning, agent-driven follow-ups, delivery-conflict drafts.

Provider abstraction (resolved on every send in this order):

1. **SendGrid** if `SENDGRID_API_KEY` and `SENDGRID_FROM_EMAIL` are
   both set. Uses the v3 mail/send REST API directly, no SDK
   dependency.
2. **Generic webhook** if `COMMS_PROVIDER_URL` is set. Useful for
   self-hosted relays or alternative providers (Resend, Postmark,
   AWS SES wrappers, etc.). The webhook receives
   `POST { to, subject, body, from }` and is expected to return
   2xx on success.
3. **Manual** if neither is configured. The communications row is
   still flipped to `sent` so the timeline stays useful in dev, but
   no email is sent.

### SendGrid setup

1. Create an API key with **Mail Send** scope in SendGrid.
2. Verify a sender (single sender or domain authentication).
3. In Vercel set:
   - `SENDGRID_API_KEY` = your API key
   - `SENDGRID_FROM_EMAIL` = the verified sender address
   - `SENDGRID_FROM_NAME` (optional) = display name on outbound
     mail (default `Anvil`)

The send endpoint logs the provider name + HTTP status code to the
communications row's `metadata.provider` and `metadata.provider_status`,
so failed sends are visible from the activity timeline.

Smoke test: from a customer ack draft click **Send**. Inbox should
receive the email; the draft row's `status` flips to `sent` with
`sent_at` populated and `metadata.provider = "sendgrid"`.

## Inbound email (email.inbound)

What it does: receives forwarded customer POs, classifies subject and
attachments, persists as DRAFT orders bundled by thread.

Setup:
1. In your transactional email provider, configure inbound parse to POST
   to `https://YOUR-VERCEL-URL/api/email/inbound?token=YOUR_EMAIL_INBOUND_TOKEN`.
   Most providers post `multipart/form-data` with `from`, `to`, `subject`,
   `text`, `attachments` fields. The endpoint accepts that shape directly.
2. Set `EMAIL_INBOUND_TOKEN` in Vercel and use the same value in the
   provider's webhook config.
3. Optional: provide an `x-obara-tenant` header in the provider's request
   so different inboxes route to different tenants (the endpoint never
   trusts `body.tenant_id`).

Without `EMAIL_INBOUND_TOKEN` set, the endpoint refuses every call (503
"Inbound disabled"). This is by design; setting it implicitly is a
multi-tenant security risk.

Smoke test: forward a real customer PO email to the configured address.
Within seconds the **Email Triage** modal should show a new DRAFT inbound.
Promoting it should create an order with status `DRAFT` and the
attachments visible.

## Where each integration is exercised in code

| Integration | File | Function |
| --- | --- | --- |
| Anthropic | `api/claude/messages.js` | proxy with redaction firewall and fallback |
| Mistral OCR | `api/_lib/mistral.js` | called from `api/documents/ocr.js` |
| Frankfurter | `api/fx/cron.js`, `api/admin/fx_rates.js` | base + targets fetch |
| ClamAV | `api/documents/scan.js` | `scanWithClamAV` runs on each file |
| Tally bridge | `api/tally/push.js` | POST with bearer token |
| GSTN | `api/einvoice/index.js` | `send_to_gstn` action |
| Outbound email | `api/communications/send.js` | conditional POST when env set |
| Inbound email | `api/email/inbound.js` | webhook receiver |

## Failure modes

Every integration logs a row to `audit_events` on call. If something goes
wrong, the audit log is the first place to look (Admin Center → Audit
Log Modal, or `select * from audit_events order by created_at desc limit 20`
in the SQL editor). The action codes you'll see:

- `tally_push_failed`, `tally_push_succeeded`
- `einvoice_rejected`, `einvoice_generated`
- `email_attachment_failed`, `email_intake`
- `fx_cron_run`, `fx_manual_refresh`
- `amc_visit_auto_created`
- `anthropic_call` (every Claude call)
- `document_scan` (every scan, with status `clean | warn | rejected`)

If an integration silently fails to fire (e.g., the Tally button does
nothing), check that the env var is set and that the Vercel function logs
show the call attempt.

## WhatsApp Business

What it does: ingests inbound WhatsApp messages and sends outbound
ones. Useful for the India + SE Asia + Latam distributor ICP where
RFQs and PO updates routinely arrive via WhatsApp instead of email.

Inbound flow mirrors `api/email/inbound.js`: provider POSTs to
`/api/whatsapp/inbound`, we classify intent, persist media to the
documents table, attempt to bundle into an existing DRAFT order from
the same sender within 7 days, and audit the event. Outbound flow
abstracts over Twilio first then Meta Cloud API.

### Inbound

1. Pick a provider:
   - **Twilio Sandbox** for dev (free, sender phone whitelist).
   - **Twilio production** with a registered WhatsApp Business sender.
   - **Meta WhatsApp Cloud API** (different envelope shape).
2. Set `WHATSAPP_INBOUND_TOKEN` to a long random string in Vercel.
3. Configure the provider's webhook to POST
   `https://your-deploy.vercel.app/api/whatsapp/inbound?token=<value>`
   with `Content-Type: application/x-www-form-urlencoded` (Twilio) or
   `application/json` (Meta).
4. Optional: pass `x-obara-tenant: <uuid>` so messages are attributed
   to a specific tenant. Defaults to `DEFAULT_TENANT_ID`.

The endpoint refuses calls with a missing or wrong token (403) and
refuses entirely if `WHATSAPP_INBOUND_TOKEN` is unset (503).

### Outbound

Pick one provider and set both halves:

**Twilio** (preferred):
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM` (e.g. `whatsapp:+14155238886`)

**Meta Cloud API**:
- `META_WHATSAPP_TOKEN`
- `META_WHATSAPP_PHONE_ID`

Without any provider configured, `/api/whatsapp/send` records the row
as `manual` so the timeline view stays useful. Mirrors the email
comms.send pattern.

Smoke test:

1. Send a WhatsApp from your phone to your Twilio Sandbox number with
   "Need quote for SRTC-K12464 qty 50".
2. Check the Anvil Inbox: a DRAFT order should appear with
   `preflight_payload.source = "whatsapp_inbound"` and
   `intent = "quote_request"`.
3. From the order workspace, send an outbound. Provider response code
   is stored on the communications row's `meta`.

## Autonomous agent runner

What it does: runs the autonomous follow-up agent on an hourly cron,
walking active goals (`agent_goals` table) and taking the next
appropriate action.

Setup:
1. Set `CRON_SECRET` to a long random string in Vercel. The cron
   request is authenticated via `Authorization: Bearer <CRON_SECRET>`;
   without the secret, `/api/agents/run` returns 401 to anyone
   including the cron itself.
2. Confirm the cron entry exists in `vercel.json`:
   ```
   { "path": "/api/agents/run", "schedule": "0 * * * *" }
   ```
3. Operators arm goals from Quality > Agents in the app.

Smoke test:

1. From an order's workspace, copy the order id.
2. Quality > Agents > Arm a new goal. Pick "Drive a quote to
   acceptance". Paste the order id. Set deadline 14 days.
3. Within an hour the runner ticks; expand the goal to see the step
   timeline ("thought / action / result").
4. Mark the order APPROVED. The next tick flips the goal to
   `completed` and emits `agent_goal_completed` in the audit log,
   which the Billing tab counts as one `agent_action` outcome.

## Stripe Connect (payments)

What it does: Anvil is the platform; each tenant has its own Stripe
Connect Express account; customers pay the tenant directly via
Stripe Checkout. Anvil takes an optional platform fee (default 0%,
per-tenant configurable in basis points on
`tenant_settings.stripe_platform_fee_bps`).

### Setup (platform-side, one-time)

1. Create a Stripe account.
2. In the Stripe Dashboard > Connect, enable Express accounts.
3. Set in Vercel:
   - `STRIPE_SECRET_KEY` (the platform secret, not the tenant's)
   - `STRIPE_WEBHOOK_SECRET` (created in step 5)
   - `PUBLIC_APP_URL` (e.g. `https://anvil.example.com`) — used as
     the return URL for the onboarding redirect.
4. Optional: set `STRIPE_PLATFORM_FEE_BPS` for the default platform
   fee on new tenants. Default `0` (no fee). Per-tenant overrides
   live on `tenant_settings.stripe_platform_fee_bps`.
5. Create a webhook endpoint pointing at
   `https://<your-deploy>/api/billing/stripe/webhook` listening to:
   `checkout.session.completed`, `payment_intent.succeeded`,
   `charge.refunded`. Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.

### Setup (per-tenant, in-app)

1. Sign in as admin, open Admin Center > Billing.
2. Click "Connect Stripe". A new tab opens to Stripe's hosted
   onboarding (identity + bank account).
3. Return to Anvil; the Stripe section now shows
   `charges enabled` and `payouts enabled` once Stripe is satisfied.

### Smoke test

1. Issue an invoice from any order. Status `draft`.
2. Click `send`; the customer-facing link includes a "Pay now" URL
   pointing to Stripe Checkout.
3. Pay with Stripe's test card `4242 4242 4242 4242` on a future
   expiry. The webhook fires `payment_intent.succeeded`, the
   invoice flips to `paid`, a `payment_records` row lands, and the
   audit log emits both `invoice_paid` and `payment_received`. Both
   verbs map to the `payment_collected` outcome on the Billing meter
   ($1.00 each on the public price card).

Refunds: refund the payment in Stripe; the `charge.refunded` event
flips the invoice back to `partial` (or `void` on full refund) and
records `invoice_refunded` in the audit log.

### Razorpay (India)

Sibling integration. Same shape (onboarding, checkout, webhook,
payment_records). Schema is provider-agnostic except for the
`stripe_*` columns on `tenant_settings`, which would gain
`razorpay_*` siblings. Not implemented in this round; tracked as
Phase 2.4.

## NetSuite (ERP)

What it does: per-tenant ERP read sync (customers, items, sales
orders) + sales-order push from Anvil to NetSuite. Each tenant has
their own NetSuite account; credentials live on tenant_settings.

### Setup (per-tenant)

1. In NetSuite: Setup > Company > Enable Features > SuiteCloud.
   Enable: REST Web Services, Token-Based Authentication.
2. Setup > Integration > Manage Integrations > New. Note the
   consumer key + consumer secret. State: Enabled. Auth: TBA.
3. Setup > Users/Roles > Access Tokens > New. Pick the integration
   record from step 2 and a user with the right role. Note the
   token id + token secret.
4. In Anvil: Admin Center > NetSuite. Paste account id (e.g.
   `1234567` for production or `1234567_SB1` for sandbox), consumer
   key/secret, token id/secret. Click Save and probe.
5. Anvil runs a SuiteQL probe to confirm the credentials. On
   success a green `connected` chip appears and the cron starts
   syncing customers/items/sales_orders every 30 minutes.

### Smoke test

1. Wait for the next cron tick (or trigger manually with
   `Authorization: Bearer $CRON_SECRET` against
   `/api/netsuite/sync`). The Admin Center > NetSuite tab shows
   per-entity row counts + last sync timestamp.
2. Open any approved order; the workspace gains an "ERP push"
   button (in addition to the existing Tally push). Clicking it
   POSTs the order via the Record API; on success the order's
   `result.external_systems.netsuite.id` is filled and the audit
   log shows `netsuite_push`.

### Authentication notes

- TBA (token-based) is the most-supported NetSuite integration
  pattern and works for both production and sandbox.
- OAuth 2.0 is also supported but requires a per-user redirect
  flow we don't yet have UI for.
- All five fields (account_id, consumer_key, consumer_secret,
  token_id, token_secret) are required.
- The credentials are stored on tenant_settings as plain text;
  Supabase RLS prevents non-admin reads. Encryption at rest is a
  follow-up.

### Limits

- v1 syncs up to 5000 rows per entity per cron tick. v2 should
  checkpoint a cursor + resume.
- Push currently uses the Record API with a flat payload; complex
  features (bundle assemblies, drop-ship, multiple locations) need
  schema work in `buildSalesOrderPayload`.
- No automatic reconciliation between NetSuite open orders and
  the local Anvil orders table; the mirror in
  `netsuite_open_orders` is read-only.

## Sage X3 (Sage Enterprise Management) — Phase 5.4a

REST + SData over HTTPS, OAuth2 client_credentials. Mirrors the
shape of the older ERPs (NetSuite v2, P21, SX.e).

### Setup (per-tenant)

1. In your Sage X3 OAuth provider (typically Keycloak or AzureAD
   federated), register Anvil as a confidential client with the
   `openid` scope. Copy the client_id and client_secret.
2. In **Admin Center → Sage X3**, fill in:
   - Base URL: e.g. `https://x3.example.com`
   - Token URL: e.g. `https://idp.example.com/auth/realms/x3/protocol/openid-connect/token`
   - Solution: usually `X3`
   - Folder / company code: e.g. `SEED`
   - Locale: e.g. `ENG`
   - Client ID and Client Secret
3. Click **Save & probe**. The endpoint runs a single CUSTOMER
   `$top=1` to validate.
4. Once probed ok, the cron muxer pulls customers, items, and
   sales orders every 30 minutes; failed pushes land in
   `sagex3_retry_queue` with exponential backoff.

### Setup notes

- Push targets the SOH (Sales Order Header) endpoint with the
  canonical Anvil-to-Sage field map. Customise the field map via
  `tenant_settings.sagex3_field_map` (jsonb).
- The retry queue surfaces "gave up" rows in the admin
  notification bell with a deep-link to the Sage X3 tab.

## PLM connectors (Windchill, Arena) — Phase 5.5

Read-only mirror: BOMs (Bill of Materials) and ECOs (Engineering
Change Orders / Notices). Used by the supplier-RFQ module to pull
the latest part structure when sourcing.

### Windchill setup (per-tenant)

1. Provision a Windchill REST user with read access to ProdMgmt and
   ChangeMgmt entities.
2. **Admin Center → PLM**, choose `windchill`, fill in base URL +
   username + password.
3. Click **Save & probe**. The endpoint hits the OData v1 metadata
   document.

### Arena setup (per-tenant)

1. Generate an API key in Arena's admin console.
2. **Admin Center → PLM**, choose `arena`, fill in base URL +
   API key.
3. Click **Save & probe**. The endpoint hits `/v1/me`.

### Sync

Every 30 minutes the cron mux pulls BOMs (only for parts that have
at least one usage link, to keep the table from filling with leaf
items) and changes. Manual triggers from the Admin tab also work.

### Limits

- Counter-based replay protection comes from PLM tags only on
  Arena. Windchill counter-tracking is not yet wired.
- Arena BOM expansion is rate-limited (per-item GET) so we cap
  at 50 parts per sync tick.

## Multi-channel inbound (WhatsApp, Slack, Teams) — Phase 5.2

Inbound messages from chat channels are normalised into the
`inbound_messages` table and run the same intake pipeline as
inbound email.

### WhatsApp via Twilio

1. In Twilio Console, configure a WhatsApp-enabled phone number.
2. Set the inbound webhook to
   `https://YOUR-VERCEL-URL/api/inbound/whatsapp/webhook`.
3. **Admin Center → Chat channels**, choose `whatsapp`, paste
   Account SID, Auth Token, From number (E.164, with or without
   the `whatsapp:` prefix).
4. Save. The webhook validates the X-Twilio-Signature against the
   stored auth_token; mismatched requests get 403 and don't touch
   the inbox.

### Slack

1. Create a Slack app, enable Events API + Bot Token scopes (`chat:write`,
   `im:history`, `app_mentions:read`, `files:read`).
2. Subscribe to events at
   `https://YOUR-VERCEL-URL/api/inbound/slack/webhook`. Slack will
   POST a `url_verification` challenge first; the endpoint echoes it.
3. **Admin Center → Chat channels**, choose `slack`, paste Bot
   Token, Signing Secret, and the workspace `team_id`.
4. The webhook verifies `X-Slack-Signature` (v0 scheme) with a
   5-minute replay window. Bot messages are ignored to prevent
   loops.

### Microsoft Teams

1. Register a Bot Framework bot in Azure AD, capture the app id +
   tenant id.
2. Set the messaging endpoint to
   `https://YOUR-VERCEL-URL/api/inbound/teams/webhook`.
3. **Admin Center → Chat channels**, choose `teams`, paste the
   Bot app id, Azure tenant id, and a webhook secret you choose.
4. The webhook accepts a shared-secret header
   `X-Anvil-Teams-Secret` matching what you typed. Production
   deployments should layer JWT verification on top, see the
   inline notes in `_lib/inbound-chat.js`.

### Outbound on the same channels

`POST /api/communications/send` with a `channel` field of
`whatsapp`, `slack`, or `teams` routes through the corresponding
provider via the saved chat-channel credentials. Email channel
keeps using SendGrid.

## Voice agent (Vapi or Retell) — Phase 5.1

AI agent answering inbound calls. Configures + verifies via
provider-issued webhook secrets.

### Setup (per-tenant)

1. In Vapi (or Retell), create an assistant + a phone number.
   Note the assistant id, the leased phone number, the webhook
   signing secret, and the API key.
2. Point the provider's webhook at
   `https://YOUR-VERCEL-URL/api/voice/webhook?provider=vapi` (or
   `?provider=retell`).
3. **Admin Center → Voice**, fill provider, display name,
   E.164 phone number, assistant id, API key, webhook secret,
   handoff phone number, voice persona, system prompt.

### Lifecycle

- `call_started` / `status-update` -> insert `voice_calls` row.
- `transcript` chunks -> append to the row's `transcript` jsonb.
- `call_ended` / `end-of-call-report` -> finalise + persist
  summary + enqueue any `voice_call_actions` the agent emitted
  (place_order, quote_request, check_delivery, escalate).
- Agent runner picks up pending actions on the next cron tick and
  drives them through the existing intake / quote endpoints.

### Handoff to a human

`POST /api/voice/handoff { call_id, to_number? }` forwards an
in-progress call to the configured `handoff_phone_number` (or an
explicit override). The voice_calls row flips to status=`escalated`.

## Document AI v2 (Phase 5.3 GAEB included)

The dispatcher at `_lib/docai/index.js` tries each adapter in
order from `tenant_settings.docai_provider_order`, falling through
on failure or low confidence. Each adapter implements
`isConfigured(settings)` and `extract({ url, bytes, filename, mime,
settings, customerId, hints })`.

### Adapters

- **GAEB**: deterministic XML parser for the German construction-
  tender format (X81 / X83 / X84 / X86). No env. Routes
  automatically when the file extension or first 4 KB of bytes
  match. Falls back to the LLM order on parse failure.
- **Reducto**: layout-aware extraction. `REDUCTO_API_KEY`.
- **Azure Document Intelligence**: `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY`.
- **Unstructured.io**: `UNSTRUCTURED_API_KEY`, `UNSTRUCTURED_API_URL`.
- **Excel**: in-process SheetJS, no env.
- **Claude**: fallback for unstructured PDFs. Uses the project's
  Anthropic key.

### Setup

For each adapter you want active, set the env vars and add the
adapter's id to `docai_provider_order` in `tenant_settings`.
GAEB is always-on once the migration is applied.

## In-network back-to-back sourcing — Phase 5.6

Tenants can opt in to share approximate stock with the Anvil
network. When tenant A is short on a SKU, the SO Workspace can
search peer tenants who have published the same SKU.

### Opt-in (per-tenant)

1. **Admin Center → Settings**, set `network_share=true`.
2. Optionally set `network_display_name`, `network_min_lead_days`,
   `network_contact_email`. Anvil never reveals the listing
   tenant's id; peers see a per-asker pseudonymous hash.
3. Publish stock via **Admin Center → Network listings** (CRUD on
   `network_listings`). Each listing has SKU, available qty
   (rounded), lead time, currency, transfer unit price, notes.

### Search + handoff

`/api/sourcing/network/search?sku=&qty=&order_id=` returns
matching peer listings. `POST /api/sourcing/network/handoff
{ query_id, listing_id }` drafts a communications row to the
listing tenant's `network_contact_email`, marks the query as
resolved, and writes audit on both sides. The asker never sees
the peer's tenant id.

## Outbound email recap

Anvil can send mail via four paths; first-configured wins:

1. Per-tenant chat channel (whatsapp / slack / teams) when the
   communications row's `channel` field is set to one of those.
2. SendGrid v3 mail/send when `SENDGRID_API_KEY` and
   `SENDGRID_FROM_EMAIL` are set.
3. Generic webhook at `COMMS_PROVIDER_URL` (with optional
   `COMMS_PROVIDER_TOKEN` bearer).
4. "Manual" mode (no provider) marks the row sent so dev
   environments still flow.

Password-reset email and access-request notifications go through
the same `_lib/communications/send.js` dispatcher.



## Phase 5.4b ERP connectors

Eight connectors added in Phase 5.4b, organised into three auth
clusters that share infrastructure with previously shipped ERPs.
Every ERP follows the same shape: per-tenant settings encrypted via
`_lib/secrets.js`, sync entities customer / item / sales_order
through `_lib/erp-runner.js`, retry queue with exponential backoff
(1m / 5m / 15m / 60m / 4h / 12h), reverse sync that flips local
order rows to ERP_PUSHED on confirmation.

### Cluster A — OAuth2 client_credentials

Reuses `_lib/oauth2.js` token cache. Operators register Anvil as an
OAuth client in the vendor's identity service and supply client_id,
client_secret, token URL.

**IFS Cloud** (`/api/ifs/*`)

- Auth: OAuth2 via IFS IAM (Identity and Access Manager).
- Surface: OData v4 projection API at
  `<base_url>/main/ifsapplications/projection/v1/<projection>/<entity>`.
- Default projection: `CustomerOrder.svc`. Sales orders are written
  to `CustomerOrders` with `SalesOrderLines` collection. Headers
  `IFS-Company` (optional) and `If-Match: *` for ETag bypass on
  updates.
- Configure in Admin Center → IFS Cloud. Required: base_url,
  token_url, client_id, client_secret.

**Oracle Fusion Cloud ERP** (`/api/oracle_fusion/*`)

- Auth: OAuth2 via OCI IDCS (or Identity Domain). The OAuth client
  must be registered as a Fusion Apps user in the Security Console;
  username must match client_id exactly.
- Surface: REST at `/fscmRestApi/resources/<api_version>/<resource>`.
- Sales orders go through `salesOrdersForOrderHub`; per-call POST
  limit is 500 records. Pagination: `limit` + `offset` + `hasMore`.
- Configure in Admin Center → Oracle Fusion. Required: base_url,
  token_url (typically `https://idcs-<id>.identity.oraclecloud.com/oauth2/v1/token`),
  client_id, client_secret. Optional: business_unit, api_version
  (defaults to `11.13.18.05`).

**Ramco ERP** (`/api/ramco/*`)

- Auth: OAuth2 via the Ramco developer portal
  (developer.ramco.com).
- Surface: REST tenant-scoped at `<base_url>/<org_unit>/api/v1/<resource>`.
- Sales orders go to `Sales/SalesOrder`. Pagination: pageSize +
  pageNumber. Both XML and JSON response shapes are accepted; we
  default to JSON.
- Configure in Admin Center → Ramco. Required: base_url, token_url,
  client_id, client_secret. Optional: org_unit, company.

### Cluster B — Token-pair flow

Each ERP issues a session token via a token endpoint (basic-auth or
API-key as the request credential). Tokens are cached per
(tenant_id, token_url, identity) via `_lib/token-cache.js` with a
default 30-min TTL and 30s refresh slack.

**JD Edwards EnterpriseOne** (`/api/jde/*`)

- Auth: AIS Server REST. POST to `/jderest/v3/tokenrequest` with
  username + password (Tools 9.2.4+ also supports JWT). Response
  carries an AIS token used as `jde-AIS-Auth-Token` on every
  subsequent call.
- Required token-mint headers: `jde-AIS-Auth-Environment`,
  `jde-AIS-Auth-Role`, `jde-AIS-Auth-Device`. They pin the session
  to a specific JDE login context.
- Surface: dataservice at `/jderest/v3/dataservice` (entity reads
  via F0101, F4101, F4201) and orchestrator at
  `/jderest/v3/orchestrator/<name>` (sales-order push). Default
  push orchestrator is `JDE_ORCH_55_AddSalesOrder`; override via
  `jde_field_map.orchestrator`.
- Configure in Admin Center → JD Edwards. Required: base_url,
  environment, role, username, password. Optional: device (defaults
  to "Anvil").

**Plex Smart Manufacturing Platform** (`/api/plex/*`)

- Auth: API key issued from the Plex Staff Panel; sent as Basic
  auth (username = API key, password = empty) plus
  `X-Plex-Customer-Id` and optional `X-Plex-PCN` headers.
- Surface: REST at `https://api.plex.com/<scope>/v1/...`. Sales
  orders go to `/scm/v1/sales-orders`. Pagination: `pageSize` +
  `page`.
- Configure in Admin Center → Plex. Required: base_url, customer_id,
  api_key. Optional: pcn (plant control number).

**JobBoss² (ECi)** (`/api/jobboss/*`)

- Auth: bearer token issued via the ECi customer portal.
- Surface: REST at `<base_url>/api/v1/<resource>`. Sales orders go
  to `quotes` by default (a JobBoss "quote" is the typical entry
  point in a job-shop workflow); override via
  `jobboss_field_map.resource` for direct job creation.
- Multi-company: optional `X-JobBoss-Company` header.
- SFTP fallback: where REST is not enabled (older on-prem
  deployments), the same migration provides
  `jobboss_sftp_*` columns. The flat-file adapter is out of scope
  for v1 but the schema is in place.
- Configure in Admin Center → JobBoss. Required: base_url, token.
  Optional: company.

### Cluster C — HTTP Basic auth

Both speak HTTP Basic auth over HTTPS. No token cache; credentials
encrypted at rest and replayed on every call.

**Oracle E-Business Suite** (`/api/oracle_ebs/*`)

- Auth: HTTP Basic over HTTPS. Plus `RestResponsibility` and
  `RestOrgId` headers to pin the session to a specific Oracle EBS
  responsibility (e.g. "Order Management Super User") and operating
  unit.
- Surface: Integrated SOA Gateway REST services at
  `<base_url>/webservices/rest/<service>/<method>`. Services are
  generated from the Integration Repository against PL/SQL APIs.
- Sales orders push through `OE_ORDER_PUB.Process_Order`; the
  default REST path is `oe_order_pub-1/process_order/`. Failures
  can return HTTP 200 with `OutputParameters.X_RETURN_STATUS != 'S'`,
  which we treat as a logical failure.
- Configure in Admin Center → Oracle EBS. Required: base_url,
  username, password. Optional: responsibility, org_id.

**proALPHA** (`/api/proalpha/*`)

- Auth: HTTP Basic via the BC-REST-API module. Some deployments
  add an OAuth2 layer in front; we default to Basic since it is
  the lowest common denominator across supported versions.
- Surface: REST at `<base_url>/api/v1/<resource>`. Sales orders go
  to `salesOrder`. Pagination: `limit` + `offset`.
- Multi-company: optional `X-Proalpha-Company` header.
- Configure in Admin Center → proALPHA. Required: base_url, username,
  password. Optional: company.

### Operations notes

- All eight ERPs picked up by the cron mux at `api/cron/tick.js`:
  30-minute syncs (customer / item / sales_order) plus 5-minute retry
  drains. Cron secret is per-deploy (`CRON_SECRET`).
- Failed pushes land in `<erp>_retry_queue` with exponential backoff
  and admin notification on give-up via `_lib/notifications.js`.
- Reverse sync runs alongside the forward sync: every order tagged
  `result.external_systems.<erp>.external_id` is re-checked at each
  sync tick and the local row's status is patched with the ERP-side
  state.
- Health endpoints (`/api/<erp>/health`) return configured /
  probe_ok / sync_state / retry_pending for the calling tenant.
  Wired into the Admin Center status panels.

### Field-map + diagnostics parity

Every connector listed above (IFS, Oracle Fusion, Ramco, JDE, Plex,
JobBoss, Oracle EBS, proALPHA, Sage X3) now exposes the same two
control-surface endpoints the seven older connectors already ship,
so the field map is no longer write-only-from-push:

- `GET /api/<erp>/field_map` (permission `read`) returns the tenant's
  current `<erp>_field_map` override (`{ field_map: {...} }`).
- `PUT /api/<erp>/field_map` (permission `admin`) validates and
  persists the map on `tenant_settings.<erp>_field_map` (jsonb), then
  writes an audit row. Body: `{ field_map: { <anvilField>: <erpField> } }`.
  Max 50 entries; keys and values must be non-empty strings.
- `GET /api/<erp>/diagnostics` (permission `read`) probes the live
  ERP for connectivity + config completeness and returns
  `{ configured, base_url, probes: [{ entity, ok, status, latency_ms,
  rows_returned, error }], summary, ran_at }` — the same shape as
  `sap/diagnostics`. Read-only; no side effects.

The field-map handler is factored into `_lib/connector-fieldmap.js`
and the probe loop into `_lib/connector-diagnostics.js`, so each
connector file only declares its settings column and probe list.

### Config / schema drift

`GET /api/<erp>/diagnostics?drift=1` (permission `admin`) additionally
diffs the tenant's `<erp>_field_map` against the connector's live
sales-order schema and returns a `drift` block:

```
"drift": {
  "available": true,
  "entity": "sales_order",
  "live_field_count": 42,
  "findings": [
    { "finding_kind": "mapped_field_absent", "severity": "error",
      "field": "<anvilField>", "expected": { "target": "<erpField>" },
      "actual": { "present": false } }
  ]
}
```

A finding means the tenant maps an Anvil field to an ERP target that
no longer exists in the live schema, so the push silently writes to a
dead field. The detector is the connector-agnostic
`_lib/connector-drift.js` (`detectDrift(expectedMap, liveSchema)`),
which mirrors the finding shape of Tally's reconciler
(`_lib/tally-reconciler.js`) without altering Tally's separate
voucher-reconciliation behavior. It returns no findings when the map
is empty or the schema is unreadable, so an unreachable ERP never
raises a false alarm. Connectors whose sales-order surface is
write-only or returns a non-flat shape (JDE dataservice, Oracle EBS
`Process_Order`) report `drift.available: false` rather than diffing
against the wrong entity. The plain `diagnostics` call (no `?drift=1`)
is unchanged and stays `read`.
