# Email accountability: plan for Phase 1

Status: plan for review. No code yet. Verified on main `931eb143` (2026-10-22).

This module finds business-critical email, makes an owned action for it, checks
that the action was done, and escalates when it is late. It works for Outlook
and Gmail through one adapter interface. It adds no paid API service and no
recurring third-party cost.

## 0. Summary

- **What exists.** Anvil has a tenant Outlook connection, a reply join for the
  mail it sends, a customer matcher, encrypted credential storage, a 5-minute
  cron multiplexer, an audit table and a bell. It has no Gmail code, no mailbox
  polling, no task table and no per-user notice on main.
- **What this adds.** Per-user mailbox connections, a poll of Inbox and Sent
  with checkpoints, deterministic rules (no LLM), an action register, a
  reply and forward verifier with evidence, reminders and escalation, four
  views, and cost limits per mailbox.
- **Where actions live.** No task table exists. The work layer design
  (`WORK_MANAGEMENT_SCOPE.md` section 4.2) defines `work_items` as the home for
  human work, and `SO_EXECUTION_COHESION.md` defers it "until work that fits no
  stage hold and no exception" appears. Email actions are that work. This plan
  builds the `work_items` table as designed (a subset of WM-5) and puts the
  email fields in one extension table. Decision ED-1.
- **New tables:** 6 (`work_items`, `mailbox_connections`, `email_actions`,
  `email_rules`, `email_action_evidence`, `email_action_notices`). No new npm
  package. No new service.
- **Cost.** Graph mail reads are not metered. The Gmail API has no charge
  inside its quota. Gmail read scopes are "restricted", so an app for external
  users needs Google verification and a yearly security assessment (CASA), which
  costs money. This plan avoids that cost: each customer registers an
  **Internal** Google app in its own Workspace, which Google exempts. Decision
  ED-3.
- **Blockers outside this module.** The 5-minute tick has no scheduler on main
  (only `/api/cron/daily` runs on Vercel Hobby). Polling needs cron-job.org,
  open PR #566 or pg_cron. Token storage uses the secrets v2 format of open PR
  #619. Per-user reminders use `notify()` of open PR #624.
- **Nine PRs** after this one, in five phases (section 9). Ten owner decisions
  (section 10). All have a default.

## 1. Scope

In scope:

1. Outlook (Microsoft Graph) and Gmail connectors behind one interface.
2. User mailboxes first. The schema accepts a shared mailbox later.
3. Incremental poll of Inbox and Sent on the existing tick.
4. Rules that you can configure, with stored reasons. Facts and inferences are
   kept apart.
5. An action register with owner, due time, priority, state and business
   outcome, linked to customer, contact, sales order and opportunity.
6. Reply and forward verification from provider metadata, with evidence and a
   manual path.
7. Reminders and escalation with a policy you can configure, and no duplicate
   notices.
8. Dashboard, action detail, my queue, manager view.
9. Cost limits, health and admin alerts per mailbox.

Not in scope:

- Any LLM call. The existing `email-classifier.js` (an LLM) is not used.
- Writing synced mail into `inbound_emails`. The tick runs the LLM classifier
  (`inbound/email/parse.js`) and draft-order creation (`draft_orders.js`) on
  that table. A synced message must never reach them.
- Send, delete or modify scopes. Anvil does not send, move or flag mail for this
  module (ED-8).
- Graph webhooks, Gmail push and Pub/Sub.
- Automatic approval, order change or external reply.
- Mail archives. Anvil stores IDs and short metadata only (section 6.9).

## 2. What exists today, and what this plan reuses

| Need | Exists | Where | Use |
|---|---|---|---|
| Graph OAuth (auth code, state HMAC, lazy refresh) | Yes, one mailbox per tenant | `_lib/graph-client.js:106-212` | Reuse `signState`/`verifyState` and the token refresh pattern. Reuse the tenant's app registration (`graph_tenant_id`, `graph_client_id`, `graph_client_secret_enc`, migration 028). Per-user tokens are new |
| Graph message fetch with In-Reply-To and References | Yes | `graph-client.js:283-308` | Pattern only. Delta and Sent Items are new |
| Reply join for mail Anvil sent | Yes | `_lib/graph-reply.js:30-66` | Not changed. It covers `communications` rows |
| Credential encryption | Yes | `_lib/secrets.js`; v2 format in PR #619 | `encryptField(plain)` v2, one value per column |
| Customer and contact match | Yes, with a defect | `_lib/inbound-email.js:164-235`, `_lib/email-canonical.js` | Use the exact steps only. The domain steps match free-mail domains (section 11) |
| Assignee check, display names | Yes | `_lib/assignee.js:15,38` | Reuse |
| Role to addresses | Yes | `_lib/internal-recipients.js:127` | Reuse for forward targets and email notices |
| Business days | Yes, days only | `_lib/datemath.js:42` | Reuse. Hours are new |
| Date parse | Yes | `_lib/parse-date.js:69` | Reuse for stated deadlines |
| Cron fan-out, budgets, heartbeats | Yes | `_lib/cron-mux.js`, `cron/tick.js`, `cron/daily.js`, `cron_health` | Add `email/sync` and `email/sweep` to tick, plus a daily backstop |
| Claim and checkpoint patterns | Yes | `erp-runner.js:49-57` (claim), `049` `*_sync_state` (high-water mark) | Copy the pattern. No shared job table exists |
| Rule defaults with tenant overlay | Yes | `_lib/logistics/monitor.js:32-64` (`DEFAULT_MONITOR_RULES`, `mergeRules`) | Copy for the policy |
| Notice idempotency | Partial | `logistics/notifications.js:74` stamps `detail.notified` | A ledger table instead (section 6.8) |
| Bell, per person | Open PR #624 (`notify()`, migration 253) | `_lib/notifications.js` | Reuse. Admin alerts use `notifyAdmins` today |
| Audit | Yes | `_lib/audit.js:74` `recordAudit`, `audit_events` (append-only) | Every state change, override, reminder and escalation |
| Server action gate | Yes | `_lib/auth.js:213` `SERVER_ACTIONS`, `requireAction`; `rbac.ts` ACTIONS | New actions in both, with a parity test |
| Nav and screens | Yes | `routes.ts`, `lib/nav.ts`, `rbac.ts` MATRIX; templates `screens/email.tsx`, `screens/inventory-exceptions.tsx` | One new nav id |
| Task table | **No** | Designed only: `WORK_MANAGEMENT_SCOPE.md:355-420` | Build the subset (ED-1) |
| Gmail | **No** | none | New adapter |
| Mailbox poll | **No** | Inbound is push only (Postmark, Graph webhook) | New |
| User manager or department | **No** | No column or table in any migration | Escalate to roles (ED-9) |
| Tenant timezone | **No** | none | Stored on each action, tenant default in policy |

## 3. Dependency map

No new npm package. All HTTP goes through `fetch` (Node 22) with
`_lib/safe-fetch.js` timeouts.

| Dependency | New or existing | Cost | Limits that matter |
|---|---|---|---|
| Node API, Supabase Postgres, Vercel function, React app | Existing | Existing hosting | One function, `maxDuration: 60` |
| Vercel cron `/api/cron/daily` | Existing | Existing | Daily only on Hobby |
| 5-minute tick trigger | Existing endpoint, **no scheduler on main** | cron-job.org free, GitHub Actions (PR #566) free for a public repo, or pg_cron in the existing Supabase | Late or dropped runs on GitHub Actions |
| Microsoft Graph mail API | Existing integration, new endpoints | Not metered | 10,000 requests in 10 minutes and 4 concurrent requests, per app per mailbox |
| Microsoft Entra ID OAuth | Existing | Free | Admin consent if the tenant blocks user consent |
| Gmail API | New | No charge inside quota | Per-method units (`history.list` 2, `messages.get` 5); per-user and per-project per-minute limits on Google's quota page |
| Google OAuth 2.0 | New | Free for an Internal app | Restricted scopes; External apps need verification and CASA (ED-3) |
| `ANVIL_SECRETS_KEY`, `CRON_SECRET`, `PUBLIC_APP_URL` | Existing env | none | none |

Prohibited items, checked: no Power Automate, Zapier, Make or n8n; no LLM or
classification API; no Pub/Sub, webhook or push; no new queue, Redis,
database, logging or monitoring service; no second task system.

## 4. Flow

```
tick (every 5 min, external trigger)
  email/sync: claim up to N due mailboxes (lease)
    for each mailbox:
      token: refresh if expiring; invalid_grant -> reauth_required, alert admin
      budget: stop if today's requests >= budget; pause; alert admin once
      Inbox changes (delta / history) -> normalise
        rules -> irrelevant: nothing stored
              -> relevant: ensure action (idempotent) + link customer/contact/SO
              -> ambiguous critical: action in awaiting_review
              -> follow-up on an open action: update activity, no new action
      if Inbox completed: Sent changes -> normalise
        verifier -> evidence rows -> action state
      save checkpoints only after a page is processed
  email/sweep: reminders, overdue, escalation (ledger, no duplicates)
daily: email/sweep backstop, content retention purge
```

Rule: if the Inbox step fails, the Sent step does not run in that cycle. A reply
is then never read before the action it answers exists.

## 5. Provider adapter interface

`src/api/_lib/mail/` holds one module per provider. The engine sees only this
shape.

```
adapter = {
  provider: 'outlook' | 'gmail',
  authorizeUrl({ settings, state, redirectUri }) -> string
  exchangeCode({ settings, code, redirectUri }) -> { accessToken, refreshToken, expiresAt, scopes }
  refresh({ settings, refreshToken }) -> { accessToken, refreshToken?, expiresAt }
  whoAmI(token) -> { address, displayName, providerUserId }
  listChanges(token, checkpoint, { folder: 'inbox' | 'sent', sinceIso, maxPages, pageSize, budget })
    -> { messages: NormalisedMessage[], nextCheckpoint, complete, requests }
  webLink(message) -> string
}

NormalisedMessage = {
  provider, providerId, internetMessageId, conversationId, conversationIndex?,
  inReplyTo, references[], direction: 'in' | 'out',
  from, to[], cc[], subject, preview, hasAttachments,
  sentAt, receivedAt, autoSubmitted, listUnsubscribe, precedence, webLink
}
```

Errors are typed, so the runner handles them the same way for both providers:

| Error | Outlook signal | Gmail signal | Runner action |
|---|---|---|---|
| `MailAuthError` | `invalid_grant`, 401 after refresh | `invalid_grant`, 401 after refresh | `status = reauth_required`, admin and owner alert, no retry |
| `MailThrottleError` | 429, 503 with `Retry-After` | 429, 403 `rateLimitExceeded` | Up to 2 retries inside the handler budget, then `paused_until` |
| `MailCheckpointError` | 410, `syncStateNotFound` | 404 on `history.list` | Clear that folder's checkpoint; restart with the bounded lookback |
| `MailQuotaError` | not expected | 403 `dailyLimitExceeded`, `quotaExceeded` | Pause until the next UTC day, admin alert |

The `isRead` state is never selected. Reading a message cannot change anything.

### 5.1 Outlook connector

- Delegated OAuth on the tenant's existing app registration. Scopes:
  `offline_access User.Read Mail.Read`. `Mail.ReadBasic` is the least privilege
  for delta, but it excludes `bodyPreview` and extended properties, and the
  verifier needs both. The tenant send connection keeps its own scopes and is
  not touched.
- `GET /me/mailFolders('inbox')/messages/delta` and
  `GET /me/mailFolders('sentitems')/messages/delta`, with
  `Prefer: IdType="ImmutableId", odata.maxpagesize=50`.
- The first call has `$filter=receivedDateTime ge {now - lookback}`. Graph puts
  the filter into the delta token, so later rounds stay bounded. No full
  history read.
- `$select`: id, internetMessageId, conversationId, conversationIndex, from,
  toRecipients, ccRecipients, subject, bodyPreview, hasAttachments,
  sentDateTime, receivedDateTime, webLink.
- In-Reply-To and References: the Sent Items copy has no
  `internetMessageHeaders`, because the transport adds headers after the copy is
  saved. The connector reads the MAPI properties `String 0x1042`
  (PidTagInReplyToId) and `String 0x1039` (PidTagInternetReferences) through
  `$expand=singleValueExtendedProperties`. Auto-Submitted and List-Unsubscribe
  come from named internet-header properties the same way.
  **Not verified on a live mailbox.** The onboarding check in EA-8 confirms
  them. Without them the verifier uses `conversationIndex` (section 6.6).
- `@removed` entries are ignored. Anvil keeps no mailbox copy.

### 5.2 Gmail connector

- OAuth on a per-tenant Google client (ED-3). Scopes:
  `openid email https://www.googleapis.com/auth/gmail.readonly`.
  `gmail.metadata` is narrower, but it is also restricted, it cannot use `q`
  for a bounded first sync, and it may not return the snippet. Both scopes have
  the same review burden, so the narrower one gives no cost benefit. The
  connector requests `format=metadata` only and never reads a full body.
- First sync: `users/me/profile` gives the `historyId` checkpoint. Then
  `messages.list?q=newer_than:{N}d (in:inbox OR in:sent)&maxResults=50`.
- Later: `users/me/history?startHistoryId=…&historyTypes=messageAdded`, then
  `messages.get?format=metadata` with `metadataHeaders` Message-ID,
  In-Reply-To, References, From, To, Cc, Subject, Date, Auto-Submitted,
  List-Unsubscribe and Precedence. Labels INBOX and SENT give the direction.
- One `historyId` checkpoint covers both folders.
- shortcut: no multipart batch endpoint; calls run one at a time with a cap per
  run. Upgrade when a mailbox passes the cap on most runs.
- Web link: `https://mail.google.com/mail/?authuser={address}#all/{id}`.
  Best effort; Google does not document this URL.

## 6. Engine

### 6.1 Sync runner and cost safety

- `src/api/email/sync.js` in the tick ALWAYS group, with its own heartbeat. It
  runs only for tenants with `tenant_settings.email_accountability_enabled`
  (default false).
- It claims a mailbox with a conditional update on `sync_lease_until` (the
  `erp-runner` pattern). One run per mailbox at a time. One request at a time
  per mailbox.
- Per run: at most N mailboxes (default 8), at most 3 pages per folder, 50
  messages per page. The 20 s tick budget and the 60 s function limit set N.
- Limits per mailbox, all columns you can change:

| Setting | Default | Hard limit | At the limit |
|---|---|---|---|
| `daily_request_budget` | 1,500 requests | none | Stop, `pause_reason = budget` until 00:00 UTC, one admin alert |
| `poll_interval_minutes` | 5 | at least 5 | Not due, skipped |
| `initial_lookback_hours` | 72 | 168 | Also used after a checkpoint reset |
| Retries per request | 2 | 2 | Stop the run, `paused_until = now + Retry-After` (1 to 60 min) |
| `consecutive_failures` | alert at 3 | pause at 10 | Admin and owner alert; resume by an admin |

- 1,500 requests a day is 15 % of one 10-minute Graph window, and about 7,500
  Gmail units a day. The default cannot reach a provider limit.
- Counters per mailbox: `requests_today`, `quota_errors`, `last_success_at`,
  `checkpoint`, `consecutive_failures`, `last_error`, and `pending_reconcile`
  (open actions with ambiguous evidence). The admin card shows them.
- No paid fallback exists in the code path. A limit pauses the mailbox and
  alerts the admin. It never switches service.
- Admin alerts use `notifyAdmins` with a `dedupKey` per mailbox per day, so
  they work before PR #624.

### 6.2 Classification rules

`_lib/email-accountability/classify.js` is a pure function:

```
classify(message, context) -> {
  relevant, priority: 'critical' | 'high' | 'normal' | 'informational',
  review: boolean,
  actions: [{ type, description, dueAt?, dueBasis, requirement, forwardTo? }],
  reasons: [{ kind: 'fact' | 'inferred', code, text }]
}
context = { tenantDomains, match: { customer, contact, reliable }, orderRefs,
            rules (tenant and user), openActionsInThread, policy }
```

- **Excluded first:** List-Unsubscribe or `Precedence: bulk`, Auto-Submitted,
  "Automatic reply" or "Out of office" subjects, no-reply senders, internal
  senders (tenant domains), and admin exclusion rules.
- **Facts:** the sender is a known contact of a customer; the subject or
  preview names a PO number that matches an order; a date is stated ("by
  25 Oct", "within 3 days", parsed with `parse-date.js`); a phrase is present.
- **Inferred:** priority from the phrase class and the customer tier; a due time
  from policy when no date is stated.
- **Default phrase pack, in code, overlaid by `email_rules`:**

| Phrase class (examples) | Action type | Priority |
|---|---|---|
| payment overdue, outstanding, remittance | confirm_payment | high |
| order confirmation, confirm the order, PO acknowledgement | reply | high |
| approval required, please approve | obtain_approval | high |
| document pending, send the certificate, invoice copy | provide_documents | high |
| deadline, by end of day, urgent | reply | high, critical with a known customer |
| shipment delay, not received, short shipment | investigate | high |
| escalation, legal notice, penalty, cancel the order | investigate | critical |

- **Create an action only when:** priority is critical or high; or priority is
  normal, the sender is a known customer contact, and a request for action is
  present. Informational never.
- **Review instead of guess:** a critical phrase from an unknown sender, or a
  critical phrase with no action type, gives an action in `awaiting_review`.
- **Follow-ups:** a message whose In-Reply-To, References or conversation hits
  an open action of the same type updates that action's activity time and may
  raise its priority. It does not make a second action.
- **Corrections:** a user can change type or priority (with a reason), dismiss
  an action as not actionable, and save the correction as a rule for
  themselves. Admins save rules for the tenant. Rule kinds: trusted_sender,
  keyword, customer, exclusion, deadline.
- Phrases are English. Other languages need admin keywords (section 8).

### 6.3 Customer, contact and order link

- **Linked (fact):** exact contact email (`findContactByEmail`, canonical hash),
  or exact `customers.contact_email`.
- **Linked (fact):** a domain that is not a free-mail domain and that only one
  customer uses.
- **Suggested only (inferred reason, no link):** any other domain match.
- **Order:** a PO number token in the subject or preview that equals
  `orders.po_number` for the linked customer, or for the tenant when it is
  unique. **Opportunity:** the linked order's `opportunity_id` only.
- The shared `matchInboundToCustomer` is not changed. Its domain steps feed
  dunning today (section 11).

### 6.4 Action register

An email action is one `work_items` row (owner, due time, priority, state) and
one `email_actions` row (the email identity and the email rules).

| Field from the request | Column |
|---|---|
| Provider, mailbox | `email_actions.provider`, `connection_id` |
| Message ID, immutable ID | `provider_message_id` (immutable on Outlook) |
| Internet Message-ID, conversation or thread ID | `internet_message_id`, `conversation_id`, `conversation_index`, `thread_refs` |
| Sender, recipients, subject, received time, link | `from_address`, `from_name`, `to_addresses`, `cc_addresses`, `subject`, `received_at`, `web_link` |
| Customer, contact, sales order, opportunity | `work_items.account_id`, `email_actions.customer_contact_id`, `work_items.order_id`, `work_items.opportunity_id` |
| Action type, description | `email_actions.action_type`; `work_items.title`, `detail` |
| Priority, reason | `work_items.priority` (1 critical to 4 informational); `email_actions.reasons` |
| Owner, backup owner | `work_items.assignee_user_id` or `assignee_role`; `email_actions.backup_user_id` |
| Due date, time, timezone | `work_items.due_at`, `due_source`, `due_basis`; `email_actions.due_timezone` |
| Consequence of a miss | `email_actions.consequence` |
| Action state, business outcome | `work_items.status`; `email_actions.business_status` |
| Evidence | `email_action_evidence` rows |
| Escalation history | `email_action_notices` rows and `audit_events` |
| Last sync, last activity | `email_actions.last_synced_at`, `last_activity_at` |

- **Idempotency.** `email_actions.message_key` is a generated column:
  `internet_message_id`, or `provider:provider_message_id` when it is missing.
  `unique (tenant_id, message_key, action_type)` holds for life, not only while
  open. A replayed page or a reset checkpoint cannot make a second action.
- **One action across mailboxes.** When two connected users receive the same
  message, the tenant gets one action. The owner is the user in To before the
  user in Cc. Other mailboxes go into `seen_connection_ids`, and a reply from
  any of them counts.
- **Transaction.** `email_action_ensure(...)`, a SQL function in the migration,
  inserts both rows in one transaction and returns the existing ids on
  conflict. Only the service role can execute it.
- **Owner.** User mailbox: its owner. Backup: the customer's
  `owner_user_id` when it is another person, else the policy backup role.
  `resolveAssignee` checks every person.

### 6.5 States

Action state (`work_items.status`, with its `status_category`):

| State | Category | Meaning |
|---|---|---|
| `detected` | todo | Made, no owner yet |
| `awaiting_review` | todo | A person must confirm or dismiss the classification |
| `pending` | todo | Owned, not started |
| `in_progress` | in_progress | The owner started it |
| `awaiting_verification` | in_progress | Evidence is ambiguous, or a manual claim waits for a checker |
| `performed` | done | Verified evidence, or an audited override |
| `cancelled` | cancelled | Dismissed with a reason |

`Overdue` and `Escalated` are flags, not states (ED-5): overdue is
`due_at < now()` on an open item; escalated is `escalation_level > 0`. A stored
"overdue" state would hide whether the work was started, and it would need a
reopen rule. The views show both flags as states and filter on them.

Business outcome (`email_actions.business_status`): `not_assessed`,
`awaiting_internal`, `awaiting_external`, `in_progress`, `resolved`, `closed`.
The verifier never sets `resolved` or `closed`. A verified reply moves
`awaiting_internal` to `awaiting_external`. A person sets `resolved`. Example: a
reply that acknowledges a delayed shipment makes the reply action `performed`;
the shipment issue stays `awaiting_external` until a person resolves it.

There is no `is_read` or `is_handled` column.

### 6.6 Reply and forward verification

`_lib/email-accountability/verify.js` is a pure function:
`matchOutgoing(sentMessage, openActions) -> [{ actionId, method, status, confidence, reasons }]`.

Correlation the CRM saves when it starts tracking an action: the mailbox, the
immutable provider ID, `internet_message_id`, `conversation_id`,
`conversation_index`, the References chain, the original sender, the required
recipients and `forward_to`.

| Method | Test | Result |
|---|---|---|
| `header_reply` | `inReplyTo` equals the action's `internet_message_id`, or `references` contains it | Structural link |
| `conversation_index` (Outlook) | The sent `conversationIndex` starts with the action's value and is 5 bytes longer (a direct child) | Structural link |
| `conversation_only` | Same conversation or thread ID, no structural link | Always `ambiguous` |

Subject text and body similarity are never a match.

After a structural link, the requirement for the action type decides:

| Requirement (policy, per type) | Default for | Verified when | Else |
|---|---|---|---|
| `reply_to_sender` | reply | Sent from a mailbox that saw the message, after `received_at`, with the original sender (or the required recipient) in To or Cc | `ambiguous`, with the reason |
| `reply_with_attachment` | provide_documents | As above, and `hasAttachments` | `ambiguous` |
| `forward_to_target` | forward | Recipients include every `forward_to` address (a role resolves through `resolveInternalRecipients`) | `ambiguous`. A forward with no target set is always `ambiguous` |
| `manual` | confirm_payment, obtain_approval, investigate | Never by mail alone. The mail is stored as evidence | `awaiting_verification` |

- `verified` moves the action to `performed`. `ambiguous` moves it to
  `awaiting_verification`. Nothing completes on a read, on a sent message
  alone, or on a click without evidence.
- Evidence row: outgoing message ID, sent time, sender mailbox, recipients,
  method, status, confidence, reasons. A unique key on the action and the
  outgoing message makes a replay harmless.
- **Manual path (ED-4).** The owner records evidence with a note (for example
  "confirmed by phone"); the action goes to `awaiting_verification`. A user
  with `email.verify` confirms or rejects with a reason. Both steps write
  `audit_events`. A confirmed manual claim has method `manual_override`, and the
  views mark it.
- **CRM actions in v1:** open the original in Outlook or Gmail (`web_link`),
  record evidence, verify. "Start a reply" opens the original; the user replies
  in their client, and the sync detects the reply. A CRM-created draft needs a
  write scope (ED-8).

### 6.7 Reminders and escalation

- `DEFAULT_EMAIL_POLICY` in code, overlaid by `tenant_settings.email_policy`
  (jsonb), the `mergeRules` pattern. Keys: priority, action type, mailbox.

| Priority | Due when no date is stated | No acknowledgement | Due soon | Overdue | Repeated |
|---|---|---|---|---|---|
| critical | 4 business hours | owner again after 60 min | at 50 % of the time | owner, backup, role `sales_manager` | every 24 h, after the 2nd to role `admin` |
| high | 1 business day | owner again after 4 h | 2 h before | owner, backup | after 24 h to `sales_manager` |
| normal | 2 business days | none | 4 h before | owner | none |

- Critical: one notice to the owner when the action is made.
- Owner unavailable: Anvil has no leave model. When the owner is no longer an
  approved member, notices go to the backup, then to the policy role.
- `email/sweep` runs on every tick, with a backstop in `cron/daily`.
- **No duplicate notices.** Each notice first inserts into
  `email_action_notices` with `unique (email_action_id, notice_key)`. Only an
  insert that succeeds sends. The key holds the kind, the level, the recipient,
  `due_at` and `reopen_count`. A new owner, a new due time or a reopen gives a
  new key; a repeated run gives the same key.
- At most 25 notices per run per tenant; above 10 in a run, one digest per
  recipient (the logistics pattern).
- Channel: the bell through `notify()` (PR #624). Email through `sendEmail`
  only if the policy turns it on (default off).
- Every notice and every escalation writes `audit_events`.

### 6.8 Permissions

| Server action | Roles | Use |
|---|---|---|
| `email.connect` | every writer role | Connect or disconnect your own mailbox |
| `email.view_all` | sales_manager, admin | All actions of the tenant; manager view |
| `email.reassign` | sales_manager, admin | Reassign another person's action |
| `email.verify` | sales_manager, admin | Confirm or reject manual evidence |
| `email.rules` | admin | Tenant rules, policy, mailbox limits |

- A user sees an action when they are its owner, its backup, or the owner of a
  mailbox that saw it, or they hold `email.view_all`. The list query applies
  this filter. The detail endpoint answers 404 for anyone else.
- Viewer has no access: the rows carry email subjects and senders.
- Tokens never reach the browser. The status endpoint returns the address,
  state and counters only.
- Each new action is in `auth.js` `SERVER_ACTIONS` and `rbac.ts` ACTIONS, with
  a parity test. New tests set roles with `installRbac` (PR #633).

### 6.9 Retention

- Stored per action: IDs, addresses, subject, a preview of at most 255
  characters, times, link. No body, no attachment.
- `tenant_settings.email_content_retention_days` (default 30). The daily sweep
  clears `preview` on older actions and stamps `content_purged_at`.
- Disconnect deletes the tokens at once. Actions stay; they are business
  records.

### 6.10 Views

One nav id, `email_actions`, in the Comms group. Built from `primitives.tsx`,
with `screens/email.tsx` and `screens/inventory-exceptions.tsx` as templates.

- **Dashboard** (default): critical open, high priority, overdue, awaiting
  verification, awaiting external response, recently performed, escalated.
- **Action detail** (`?id=`): email reference and link, classification with
  facts and inferences apart, requested action, customer and sales order,
  owner and due time, evidence, audit and notice history, state and
  reassignment controls.
- **My queue** (`?sub=mine`), and a card on Home next to the existing My Queue.
- **Manager** (`?sub=manager`, needs `email.view_all`): unassigned critical,
  overdue by owner, escalation history, workload and completion.
- Filters: mailbox, owner, priority, customer, sales order, due range, state.
- Admin: a Mailboxes card (connect, disconnect, health, usage, pause and
  resume), rules, policy.

## 7. Data model

All migrations are additive and idempotent, applied by hand, with RLS on and
`tenant_id in (select current_tenant_ids())` policies. The API writes through
the service role with an explicit tenant filter. New tables go into
`audit-rls-coverage.mjs` DEFAULT_TABLES.

| No. | Content | PR |
|---|---|---|
| 252 | `work_items`: the columns of `WORK_MANAGEMENT_SCOPE.md` 4.2, without `item_key`, the template columns and `custom`. Same names and types, so WM-5 adds the rest with `add column if not exists`. Links, events, watchers, counters and the auto flag move to WM-5's own migration (next free number then) | EA-3 |
| 267 | `mailbox_connections` (provider, kind, owner, address, scopes, `access_token_enc`, `refresh_token_enc`, `token_expires_at`, status, `checkpoint` jsonb per folder, lease, health and budget columns; unique `(tenant_id, provider, lower(address))`). `tenant_settings`: `google_oauth_client_id`, `google_oauth_client_secret_enc`, `email_accountability_enabled` (default false) | EA-1 (#635) |
| 268 | `email_actions` (section 6.4, `message_key` generated, unique for life), `email_rules`, function `email_action_ensure`; `tenant_settings.email_content_retention_days` | EA-3 |
| 269 | `email_action_evidence` (unique per action and outgoing message) | EA-5 |
| 270 | `email_action_notices` (unique per action and notice key); `tenant_settings.email_policy` jsonb | EA-6 |

Registry update: 252 is now the `work_items` table only. 267 to 270 are this
module. The next free number is 271. C-20 of `SO_EXECUTION_COHESION.md` said
it might use 267 for a staff phone column; it takes 271 or later.

## 8. Known limits

1. **Outlook reply headers.** Sent Items copies have no internet headers. The
   plan reads MAPI properties 0x1042 and 0x1039. Not proven on a live mailbox;
   EA-8 adds an onboarding check. If they are missing, `conversation_index`
   still links a direct reply or forward. Otherwise the result is ambiguous and
   goes to manual review.
2. **Forwards.** Many clients set no In-Reply-To on a forward. Forward
   verification then needs `conversation_index` (Outlook) or References
   (Gmail), plus the target recipients. Without a target, a forward is always
   ambiguous.
3. **Mail Anvil cannot see:** a reply from a mailbox that is not connected, a
   phone call, a chat message. These need the manual path.
4. **Delay.** A reply shows up after the poll interval plus the tick delay.
   GitHub Actions schedules run late and sometimes not at all.
5. **Throughput.** About 8 mailboxes per tick inside the 20 s budget. A tenant
   with more mailboxes needs a larger budget or more ticks.
6. **Consumer Gmail** (`@gmail.com`) is not supported. An External app in
   Testing gets refresh tokens that expire after 7 days, and a published one
   needs verification and CASA.
7. **Language.** The phrase pack is English. Other languages need admin
   keywords.
8. **No leave model and no manager hierarchy.** "Owner unavailable" means the
   owner is no longer an approved member. Escalation goes to roles.
9. **Body.** Rules read the subject and the first 255 characters only. A
   request deeper in a long message is missed (ED-10).
10. **Tests mock the providers.** No test uses live credentials. A connector is
    proven only after the onboarding check on a real mailbox.

## 9. PR plan

Each PR has Summary, Deploy notes, Tests and Not covered, and reports real gate
results. Numbers in brackets are the tests of the request.

| PR | Phase | Title | Migration | Tests | Needs |
|---|---|---|---|---|---|
| EA-0 | 1 | This plan | none | none | none |
| EA-1 | 2 | Mailbox connections, Outlook connect and delta sync (counts only, no actions) | 267 | [13] outage and invalid checkpoint, [14] expired and revoked token, [16] throttling, [17] budget stop | #619 |
| EA-2 | 2 | Gmail connect and history sync | none | [13], [14], [16], [17] for Gmail | EA-1 |
| EA-3 | 3 | Rules, links and actions | 252, 268 | [1] one action, [2] no action, [3] no duplicates, [4] reliable link, [9] read is not done, [18] orders and tasks unchanged | EA-1 |
| EA-4 | 3 | Action and rules API, server actions | none | [15] access, RBAC parity | EA-3, #633 |
| EA-5 | 4 | Reply and forward verification, evidence, manual path | 269 | [5] Outlook reply, [6] Gmail reply, [7] forward, [8] ambiguous, [11] acknowledgement does not resolve | EA-3, EA-2 for [6] |
| EA-6 | 5 | Policy, reminders and escalation | 270 | [10] overdue escalates, [12] no duplicate reminders | EA-3, #624 |
| EA-7 | 5 | Dashboard, detail, my queue, manager view, admin cards | none | screen tests | EA-4, EA-6 |
| EA-8 | 6 | Cost and health view, retention purge, onboarding check, setup and deployment docs, acceptance checklist | none | [17] end to end, retention | all |

EA-2 can move after EA-5 if Outlook is the only first deployment (ED-2). Test
[6] then waits for EA-2.

## 10. Owner decisions

| ID | Question | Default | Alternative |
|---|---|---|---|
| ED-1 | Where do email actions live? | `work_items` subset (migration 252) plus `email_actions`. It is the designed home, and email is the trigger the cohesion plan named | One `email_actions` table with its own owner, due time and state; fold into `work_items` later |
| ED-2 | Which connector first? | Outlook first; Gmail right after (EA-2) | Gmail in the same phase, or later |
| ED-3 | Which Google app model? | Each customer registers an Internal app in its own Workspace. No verification, no CASA, no cost | One Anvil-wide External app: Google verification plus a yearly CASA assessment (a recurring cost that needs separate approval) |
| ED-4 | Who confirms manual evidence? | Maker and checker: the owner records it, `email.verify` confirms | The owner verifies alone with a mandatory reason |
| ED-5 | Overdue and Escalated | Derived flags, shown as states | Stored states |
| ED-6 | Order of open PRs | Merge #619 before EA-1 and #624 before EA-6 | Stack the EA PRs on them |
| ED-7 | Shared mailbox in v1? | User mailboxes only; schema is ready for shared | Add the tenant's shared mailbox in EA-1 |
| ED-8 | CRM-made reply drafts? | Off. No write scope | Graph `createReply` (`Mail.ReadWrite`) and Gmail `drafts.create` (`gmail.compose`) for an exact ID match |
| ED-9 | Department and process policies | Policy per priority, action type and mailbox; escalate to roles | Add a department model first (new work) |
| ED-10 | Message body | Preview only (255 characters), never the full body | Fetch the full body for messages from known customers, not stored |

## 11. Found while reading, not fixed here

1. `matchInboundToCustomer` (`_lib/inbound-email.js:198-230`) links on any
   domain, `gmail.com` too, and takes one row with `limit(1)` when many
   customers share a domain. Its `ilike` patterns do not escape `_` or `%`, so
   `_` in an address matches any character. Dunning and inbound triage use it
   today.
2. The Graph webhook path stores the mutable REST ID as `message_id` and drops
   `internetMessageId` and `conversationId` (`inbound/email/webhook.js:182`).
3. `mailer.js` keeps no provider message ID for Brevo, Resend or SendGrid
   sends, so only Graph sends can join a reply.
4. `communications.provider_message_id` has no index; `attributeReply` filters
   on it.
5. `inbound/email/configure.js:51` stores the Graph `clientState` in plaintext.
