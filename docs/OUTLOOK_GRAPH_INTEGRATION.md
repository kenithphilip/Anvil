# Outlook / Gmail / Email Integration — Design (PARKED)

Status: **Parked.** Build only after the lead → opportunity → quote → PO
core flow is complete. This doc captures the plan so it can be resumed cold.

Decision (2026-06-25): use **Microsoft Graph** (real Outlook/M365 mailbox,
bidirectional). Mailbox model kept **flexible** — the connector supports both
a shared mailbox (application permissions) and per-user delegated mailboxes;
ship the shared-mailbox path first.

Update (2026-06-27): make the connector **multi-provider**. Add **Gmail /
Google Workspace** as a first-class second provider via the **Gmail API**
(OAuth2 + Pub/Sub push), and a generic **IMAP** fallback for any other mailbox.
The existing pipeline is provider-agnostic, so each provider is just a new
"fetch + send" adapter behind the same `email_connections` row.

## Provider choice — Gmail API vs IMAP/POP (read before building)

The instinct is "IMAP is universal, just use it everywhere." On a serverless
(Vercel) + webhook architecture that is the **wrong** default. Honest trade-off:

| | Graph (Outlook) | **Gmail API** | Generic IMAP | POP |
|---|---|---|---|---|
| Push (no polling) | Yes (subscriptions) | **Yes (Pub/Sub `watch`)** | No — must poll (IDLE needs a long-lived socket serverless can't hold) | No |
| Send from mailbox | Yes (SendMail) | **Yes (`messages.send`)** | No — needs separate SMTP | No |
| Threads / labels / folders | Yes | **Yes** | Partial (no labels) | **No** — flat download only |
| Auth | OAuth2 | OAuth2 | OAuth2 (XOAUTH2) **still required** for Gmail + M365 — basic auth is deprecated | same |
| Fits Anvil's webhook+cron model | Yes | **Yes** | Awkward (long TCP connection; better as a cron poll worker) | N/A |

**Conclusions:**
- **Gmail → use the Gmail API, not IMAP.** It mirrors the Graph design exactly
  (webhook-driven inbound + API send), so it reuses the same plumbing and stays
  serverless-friendly.
- **IMAP does not save the integration work for the big two.** Google and
  Microsoft both deprecated basic-auth IMAP, so you *still* do per-provider
  OAuth — and you *lose* push and native send. Keep IMAP only as a **generic
  fallback** for tenants on neither M365 nor Workspace (a legacy/host mailbox),
  implemented as a **cron poll + SMTP send**, accepting it is lower-fidelity.
- **POP — do not use.** Download-only, no server-side state, no threading or
  labels, no shared-mailbox semantics. Useless for an ops mailbox.

## Why this is mostly an "finish + wire" job, not greenfield

~80% of the plumbing already exists and is provider-agnostic:

| Capability | Status | Location |
|---|---|---|
| Inbound email → dedup → thread → draft order | Built (Postmark live; Graph stubbed) | `src/api/inbound/email/webhook.js`, `draft_orders.js` |
| Attachment download → ClamAV scan → storage → link to order | Built | `src/api/inbound/email/_lib/persist-attachments.js` |
| Contact matching (email → customer_contacts) | Built | `src/api/_lib/email-canonical.js` |
| Email triage inbox (promote / attach / reply) | Built | `src/v3-app/screens/email.tsx` |
| Outbound send cascade (SendGrid + webhook + chat) | Built | `src/api/communications/send.js` |
| Quote share (PDF + 30-day portal token + accept/decline + nudge agents) | Built | `src/api/quotes/send.js` |
| E-sign / sign-off (DocuSign envelopes + webhook) | Built | `src/api/esign/*` |
| Encrypted per-tenant credential storage (AES-256-GCM) | Built | `inbound_chat_configs` pattern, `_lib/inbound-chat.js` |

The Graph handler in `webhook.js` (`handleGraph`) already validates the
subscription handshake and stores a stub row, but **never calls back to fetch
the message body/attachments**. That callback + outbound SendMail + the
subscription lifecycle are the real gaps.

## Gaps to close

1. **Provider clients** behind one small interface
   (`getMessage`, `listAttachments`, `getAttachment`, `sendMail`,
   `startWatch`/`createSubscription`, `renewWatch`/`renewSubscription`):
   - `src/api/_lib/graph-client.js` (new): app client-credentials AND delegated
     refresh-token; Graph endpoints.
   - `src/api/_lib/gmail-client.js` (new): OAuth2 refresh-token; `users.messages.get`,
     `attachments.get`, `messages.send`, `users.watch` (Pub/Sub) / `stop`.
   - (optional, later) `src/api/_lib/imap-client.js`: IMAP fetch + SMTP send for
     the generic fallback; driven by a cron poll, not a webhook.
2. **OAuth + push lifecycle**: admin connects a mailbox. Graph subscriptions
   expire ~3 days; Gmail `watch` expires ~7 days — both must be auto-renewed.
3. **Outbound from the mailbox**: send quotes/acks/replies *from* the connected
   mailbox (threading, sent-items, deliverability) via Graph SendMail / Gmail
   `messages.send` instead of SendGrid.

## Connection model (flexible, multi-mailbox)

New table `email_connections` (RLS, tenant-scoped) — generalises the current
single-mailbox `tenant_settings.graph_*` columns:

- `id`, `tenant_id`
- `provider` — `graph` | `gmail` | `imap`
- `kind` — `graph_app` | `graph_delegated` | `gmail_oauth` | `imap_basic`
- `mailbox` / `upn`, `display_name`
- encrypted creds — graph app: client_id/secret; graph/gmail delegated:
  refresh_token; imap: host/port + username/password + smtp_host/port
- push state — `subscription_id` (Graph) / `watch_history_id` + `pubsub_topic`
  (Gmail), `subscription_expires_at`, `scopes[]`
- `active`, `connected_by`, `created_at`

This lets a tenant run one shared Outlook mailbox now and add Gmail, per-user
delegated, or a generic IMAP mailbox later without a schema change. Encrypt via
`ANVIL_SECRETS_KEY` (reuse the `inbound-chat.js` AES-256-GCM pattern).

## Phased build (each = one shippable PR + gates + migration)

- **Phase 1 — Connector core (inbound read).** `graph-client.js`,
  `email_connections` migration, finish `handleGraph()` to fetch message +
  attachments into the existing pipeline, admin Email-connect UI (register /
  test / subscription health). → POs received in Outlook become draft orders.
- **Phase 1b — Gmail provider.** `gmail-client.js` + a `handleGmail()` webhook
  branch (Pub/Sub push → `messages.get` → same pipeline) + Gmail option in the
  connect UI. Reuses everything from Phase 1; only the fetch adapter is new.
- **Phase 2 — Push lifecycle.** Cron to create/renew Graph subscriptions
  (~3 day) and Gmail `watch` (~7 day) before expiry + handle lifecycle
  notifications (reuse existing cron infra).
- **Phase 3 — Send from the mailbox.** Add `graph` and `gmail` providers to the
  communications send cascade; switch quote-share transport to the connected
  mailbox's native send (Graph SendMail / Gmail `messages.send`).
- **Phase 4 — PO acknowledgement + flagging/issue raising.** Auto-reply ack
  in-thread on order confirm (template + SendMail); a "flag / raise issue"
  action from triage/order that drafts a templated query email and tracks an
  open `communications` thread until resolved.
- **Phase 5 — Sign-off.** DocuSign (legal) + portal accept-token (lightweight)
  already cover this; add an email sign-off request only if wanted.

## Flow mapping (what the user asked for)

- **PO receipt** → Graph inbound → attachment OCR (DocAI already wired) →
  DRAFT order. Mostly exists; needs the Graph fetch.
- **PO acknowledgement** → templated in-thread reply via Graph SendMail on
  order confirm. New: one template + the SendMail call.
- **PO flagging / issue raising** → flag action → templated query email +
  tracked open communications thread until resolved. New.
- **Quote sharing** → already sends PDF + portal link; swap transport to Graph
  so it threads from the mailbox. Exists; transport switch.
- **Sign-off** → DocuSign e-sign + portal accept-token already capture this.

## Cost posture (keep it lean)

Hard requirement: the integration must be cheap to run. The architecture
already favours this — the levers, biggest first:

1. **Push, never poll.** Graph subscriptions and Gmail `watch` mean a function
   runs *only when a real email arrives*. IMAP polling runs on a fixed cron
   whether or not mail came (e.g. 1-min polling = ~1,440 idle invocations per
   mailbox per day). This is the single biggest cost reason to prefer the
   native APIs and treat IMAP as a last resort (and if used, poll every
   10-15 min, not every minute).
2. **The provider APIs are free.** Microsoft Graph and the Gmail API carry no
   per-call charge (Gmail's daily quota is effectively unreachable at our
   volume). Google **Pub/Sub** push notifications are bytes each and sit inside
   the free tier — effectively $0.
3. **Native send *replaces* a paid service.** Sending quotes/acks via Graph
   SendMail / Gmail `messages.send` removes those messages from SendGrid, so
   outbound is a cost *reduction*, not an addition.
4. **Attachment OCR/LLM is the only real variable cost** — and it is the
   existing DocAI pipeline, not new spend. Keep it lean: dedup before
   processing (already built), only OCR attachments that look like POs, and
   lean on the DocAI **template-skip fast path** (parked item) so repeat
   customers extract without an LLM call.
5. **Fetch deltas, not mailboxes.** On a Gmail notification, use the
   `historyId` + `history.list` to pull only changed message IDs; on Graph,
   subscribe to a specific folder. Never full-resync a mailbox.
6. **Filter at the source.** A server-side Gmail filter/label or a Graph
   subscription scoped to a dedicated POs folder cuts notifications (and
   invocations) to only relevant mail.

Net: at expected volume the marginal infra cost is ~storage + the DocAI calls
we would pay anyway; the connector itself is near-zero. Renewal crons (Graph
~3 day, Gmail ~7 day) are one tiny invocation per mailbox per cycle.

## Provider prerequisites

**Outlook / M365 (Phase 1)** — App registration in the customer's M365 tenant
with `Mail.Read` + `Mail.Send` (application permissions, scoped to the chosen
mailbox via an Application Access Policy) + admin consent.

**Gmail / Google Workspace (Phase 1b)** — A Google Cloud project with the
Gmail API enabled, an OAuth client (consent screen), scopes
`gmail.readonly` + `gmail.send` (or `gmail.modify`), and a **Pub/Sub topic**
for `users.watch` push (grant `gmail-api-push@system.gserviceaccount.com`
Publisher on the topic). For a true shared/ops mailbox across the org, use a
Workspace service account with domain-wide delegation; otherwise per-user
OAuth consent. Document the exact steps in the connect screen.

**Generic IMAP (optional, later)** — Host/port + credentials and SMTP host/port
for send; no push, so it runs on a cron poll. Note basic-auth IMAP is
deprecated for Gmail/M365, so this path is for other providers only.
