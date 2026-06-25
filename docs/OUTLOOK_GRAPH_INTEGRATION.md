# Outlook / Email Integration — Design (PARKED)

Status: **Parked.** Build only after the lead → opportunity → quote → PO
core flow is complete. This doc captures the plan so it can be resumed cold.

Decision (2026-06-25): use **Microsoft Graph** (real Outlook/M365 mailbox,
bidirectional). Mailbox model kept **flexible** — the connector supports both
a shared mailbox (application permissions) and per-user delegated mailboxes;
ship the shared-mailbox path first.

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

1. **Graph API client** (`src/api/_lib/graph-client.js`, new): mint bearer
   token for both flows (app client-credentials AND delegated refresh-token);
   `getMessage`, `listAttachments`, `getAttachment`, `sendMail`,
   `createSubscription`, `renewSubscription`.
2. **OAuth + subscription lifecycle**: admin connects a mailbox; Graph
   change-notification subscriptions expire ~3 days and must be auto-renewed.
3. **Outbound via Graph SendMail**: send quotes/acks/replies *from* the
   Outlook mailbox (threading, sent-items, deliverability) instead of SendGrid.

## Connection model (flexible, multi-mailbox)

New table `email_connections` (RLS, tenant-scoped) — generalises the current
single-mailbox `tenant_settings.graph_*` columns:

- `id`, `tenant_id`
- `kind` — `graph_app` | `graph_delegated`
- `mailbox` / `upn`, `display_name`
- encrypted creds — app: client_id/secret; delegated: refresh_token
- `subscription_id`, `subscription_expires_at`, `scopes[]`
- `active`, `connected_by`, `created_at`

This lets a tenant run one shared mailbox now and add per-user delegated
mailboxes later without a schema change. Encrypt via `ANVIL_SECRETS_KEY`
(reuse the `inbound-chat.js` AES-256-GCM pattern).

## Phased build (each = one shippable PR + gates + migration)

- **Phase 1 — Connector core (inbound read).** `graph-client.js`,
  `email_connections` migration, finish `handleGraph()` to fetch message +
  attachments into the existing pipeline, admin Email-connect UI (register /
  test / subscription health). → POs received in Outlook become draft orders.
- **Phase 2 — Subscription lifecycle.** Cron to create/renew subscriptions
  before expiry + handle lifecycle notifications (reuse existing cron infra).
- **Phase 3 — Send from the mailbox.** Add `graph` provider to the
  communications send cascade; switch quote-share transport to Graph SendMail.
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

## Azure prerequisites (Phase 1)

App registration in the customer's M365 tenant with `Mail.Read` + `Mail.Send`
(application permissions, scoped to the chosen mailbox via an Application
Access Policy) + admin consent. Document the exact steps in the connect screen.
