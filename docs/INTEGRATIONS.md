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
   - Accepts `POST /push` with our voucher payload as JSON.
   - Translates to Tally XML and POSTs to `http://tally-host:9000`.
   - Returns Tally's response and a `body` field with the raw XML so we
     can extract the voucher id.
   - Validates a bearer token if `TALLY_BRIDGE_TOKEN` is set.
2. Set `TALLY_BRIDGE_URL` and `TALLY_BRIDGE_TOKEN` in Vercel.

Smoke test: approve an order, click **Push to Tally**. The order's
`tally_status` should flip to `exported` and a row should appear in
`tally_voucher_records` with the `tally_voucher_id` populated. Without the
bridge, the row gets `failed` status with the error string.

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

What it does: actually sends customer ack emails, missing-doc requests,
delivery-conflict drafts.

Setup:
1. Pick a transactional email service (SendGrid, Resend, Postmark, AWS SES).
2. Build a small relay that accepts `POST /send` with
   `{ id, to, subject, body }` and posts to your provider's SDK or API.
3. Set `COMMS_PROVIDER_URL` to that relay.

Without the env var, **Send** marks the row `sent` in `communications` so
the timeline view stays useful, but no email goes out. This is intentional
for dev environments.

Smoke test: from a customer ack draft click **Send**. Inbox should receive
the email; the draft row's `status` should flip to `sent` with
`sent_at` populated.

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
