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
