# Email accountability: setup, operation and acceptance

This document is for the person who deploys and runs the module. The design
and the decisions are in `EMAIL_ACCOUNTABILITY_SCOPE.md` (PR #634). This
document covers the result of the build, EA-1 to EA-8.

## 1. What the module does

1. A user connects their Outlook or Gmail mailbox. Anvil asks for read-only
   access.
2. The 5-minute tick reads new Inbox and Sent mail from a checkpoint. It never
   reads the full history.
3. Fixed rules, with no AI and no paid service, find business-critical mail. They
   make an owned action with a priority, a due time and the reasons. The reasons
   keep facts apart from inferences.
4. The action links to the customer, the contact, the sales order and the
   opportunity, but only when the match is reliable.
5. Sent mail is checked against the open actions. A reply or a forward
   completes an action only when the mail headers prove the link and the action's
   requirement is met. All other mail goes to a person.
6. Reminders and escalation run from a policy you can set. The ledger sends each
   notice once.
7. Everyone works in one screen, Email Actions, and a card on Home.

## 2. Architecture

```
tick (5 min, external trigger)
  email/sync    _lib/mail/sync.js       per mailbox: lease, token, budget,
                _lib/mail/outlook.js    folder pages, checkpoint after each
                _lib/mail/gmail.js      page, health and alerts
                  onPage -> _lib/email-accountability/engine.js
                    inbound:  rules.js -> link.js -> store.js (work_items +
                              email_actions, one transaction)
                    outbound: verify.js -> store.js (evidence, state)
  email/sweep   _lib/email-accountability/escalation.js (policy.js, ledger)
daily
  email/sweep_daily   the sweep backstop
  email/purge         retention.js: clear old previews
```

- **Adapters.** One module per provider, with the same interface
  (`_lib/mail/adapters.js`). The engine never sees a provider format.
- **Actions.** An action is a `work_items` row (the owner, due time, priority
  and state) plus an `email_actions` row (the email identity, the rules and the
  business outcome). `store.js` is the only module that knows this split.
- **Action state and business outcome are two fields.** A verified reply
  performs the action. It moves the business outcome to "awaiting external",
  never to "resolved". A person sets "resolved".

## 3. Files and modules

| Area | Files |
|---|---|
| Mail adapters and sync | `src/api/_lib/mail/provider.js`, `adapters.js`, `outlook.js`, `gmail.js`, `connections.js`, `sync.js` |
| Engine | `src/api/_lib/email-accountability/rules.js`, `business-time.js`, `link.js`, `store.js`, `engine.js`, `verify.js`, `policy.js`, `escalation.js`, `access.js`, `retention.js`, `onboarding.js` |
| API | `src/api/email/connections.js`, `connect_callback.js`, `google_app.js`, `sync.js`, `sweep.js`, `purge.js`, `policy.js`, `health.js`, `check.js`; `src/api/email_actions/index.js`, `[id].js`, `evidence.js`, `verify.js`; `src/api/email_rules/index.js` |
| Changed shared code | `_lib/graph-client.js` (scopes as an argument, purpose-bound OAuth state), `_lib/auth.js` (4 server actions), `_lib/notifications.js` (`notify()` of #624), `_lib/heartbeat-check.js`, `cron/tick.js`, `cron/daily.js`, `router.js` |
| UI | `src/v3-app/screens/email-actions.tsx`, `screens/home.tsx` (card), `routes.ts`, `lib/nav.ts`, `lib/rbac.ts`, `src/client/anvil-client.js` (`emailActions`) |
| Tests | 12 files, `src/v3-app/api-mail-*.test.js`, `api-email-*.test.js`, `screens/email-actions.test.tsx`, `screens/home-email-actions.test.tsx`; shared stand-ins in `test-email-ensure.js` and `test-memory-supabase.ts` |

## 4. Migrations

Apply them by hand, in this order. Reload the PostgREST cache after each one
(`notify pgrst, 'reload schema';`). Each file has VERIFY queries.

| Order | File | Content |
|---|---|---|
| 1 | `253_notification_recipient.sql` (#624) | `admin_notifications.recipient_user_id`. `notify()` needs it |
| 2 | `252_work_items.sql` | `work_items` (the WM-5 subset) |
| 3 | `267_mailbox_connections.sql` | `mailbox_connections`; `tenant_settings.email_accountability_enabled`, `google_oauth_*` |
| 4 | `268_email_actions.sql` | `email_actions`, `email_rules`, `email_action_ensure()`; `tenant_settings.email_actions_mode` (default `observe`), `email_content_retention_days` |
| 5 | `269_email_action_evidence.sql` | `email_action_evidence` |
| 6 | `270_email_action_notices.sql` | `email_action_notices`; `tenant_settings.email_policy` |

Every new table has RLS on and no policy for tenant users. Only the service
role reads them, and the API applies the visibility rule. The function
`email_action_ensure` runs for the service role only.

## 5. Provider setup

### 5.1 Microsoft (Outlook, Microsoft 365)

Anvil reuses the tenant's existing app registration (`graph_tenant_id`,
`graph_client_id`, the encrypted secret; Admin > Communications). Do these steps
once for each customer tenant, in the Entra admin center:

1. Open App registrations, then the app that `graph_client_id` names.
2. In Authentication, add a Web redirect URI:
   `{PUBLIC_APP_URL}/api/email/connect/callback`.
3. In API permissions, add these **delegated** Microsoft Graph permissions:
   `offline_access`, `User.Read`, `Mail.Read`.
4. If the tenant blocks user consent, click "Grant admin consent".

`Mail.ReadBasic` is not enough: it hides `bodyPreview` and the extended
properties that hold In-Reply-To and References on Sent Items. Anvil asks for
no send, write or delete permission. The tenant's send connection keeps its own
permissions and is not changed.

### 5.2 Google (Gmail, Google Workspace)

Each customer registers an **Internal** app in its own Workspace (decision
ED-3). Google requires no verification and no security assessment for an
Internal app.

1. In the Google Cloud console of the customer's Workspace, create a project.
2. Enable the Gmail API.
3. On the OAuth consent screen, set the user type to **Internal**.
4. Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
5. In Credentials, create an OAuth client of type Web application. Add the
   redirect URI `{PUBLIC_APP_URL}/api/email/connect/callback`.
6. An Anvil admin stores the client with
   `PUT /api/email/google_app { client_id, client_secret }`. The secret is
   stored encrypted.

Every Gmail read scope is "restricted". The narrower `gmail.metadata` scope has
the same review burden and cannot do a bounded first sync, so the module uses
`gmail.readonly`. It reads `format=metadata` only and never reads a body.
Consumer `@gmail.com` accounts are not supported (section 10).

## 6. Environment variables

No new variable. The module uses these existing ones (no values here):

| Variable | Use |
|---|---|
| `PUBLIC_APP_URL` | The OAuth redirect URI and the return to the app |
| `ANVIL_SECRETS_KEY` | Encrypts the tokens and the Google client secret (secrets v2, #619) |
| `CRON_SECRET` | Authenticates `/api/email/sync`, `/sweep` and `/purge` |
| `CRON_TICK_HANDLERS` | Only with #566: add `email/sync,email/sweep` |

## 7. Dependencies and cost

**Runtime dependencies: no new package.** All provider calls use `fetch`
(Node 22) through `_lib/safe-fetch.js`.

| Dependency | Status | Recurring cost |
|---|---|---|
| Anvil API, Supabase Postgres, Vercel, React app | existing | existing hosting, out of scope |
| Vercel daily cron | existing | none |
| 5-minute tick trigger: cron-job.org, GitHub Actions (#566) or pg_cron | existing endpoint; a trigger must call it | none (free options) |
| Microsoft Graph mail API | existing integration, new endpoints | none: mail reads are not metered |
| Microsoft Entra ID OAuth | existing | none |
| Gmail API | new endpoints | none inside Google's quota |
| Google OAuth 2.0, Internal app | new, per customer | none |
| Bell notifications (`admin_notifications`, `notify()`) | existing (#624) | none |
| PGlite (WASM Postgres), used only to check migrations during the build | outside the repo, not a dependency | none |

**Statement:** this module adds no paid API, no paid service and no new
mandatory recurring third-party cost. It uses no LLM. The existing hosting, the
mailbox subscriptions (Microsoft 365, Google Workspace) and their licences are
out of scope and do not change.

These are prohibited, and the module does not use any of them: Power Automate,
Zapier, Make, n8n, OpenAI, Anthropic or other model APIs, email-classification
APIs, Pub/Sub, Graph webhooks, Gmail push, a new queue, Redis, a database, or a
logging or monitoring service.

## 8. Quotas and cost safeguards

| Safeguard | Default | Where |
|---|---|---|
| Daily request budget per mailbox; every request counts, retries too | 1,500 | `mailbox_connections.daily_request_budget` (admin: `PATCH /api/email/connections`) |
| At the budget: no request, pause until 00:00 UTC, one admin alert | | `_lib/mail/sync.js` |
| A provider quota (Gmail `dailyLimitExceeded`): pause until 00:00 UTC, alert | | `gmail.js`, `sync.js` |
| Throttling (429, 503, Gmail `rateLimitExceeded`): at most 2 retries, a wait inside the run of 5 s at most, then a pause for `Retry-After` (1 to 60 min) | | `provider.js` |
| First sync and recovery are bounded: 72 h lookback, at most 7 days after an outage | | `sync.js`, Graph `$filter`, Gmail `after:` |
| Per run: 8 mailboxes, 3 pages a folder, 50 messages a page (Gmail 20), one request at a time a mailbox, a deadline | | `email/sync.js`, `sync.js` |
| Failures: backoff of 2, 4, 8 and 16 poll intervals; an alert at 3; a pause at 10 until a person resumes | | `sync.js` |
| Notices: a cap for each sweep (25), up to 3 attempts | policy | `escalation.js` |
| No paid fallback exists in the code path | | |

Provider limits for comparison: Graph allows 10,000 requests in 10 minutes and
4 concurrent requests per app per mailbox. Gmail counts quota units per method
(`history.list` 2, `messages.get` 5) per user and per project. The default
budget is far below both.

## 9. Deployment and mailbox onboarding

1. Merge in this order: #619, #624, #635, #636, #637, #638, #639, #640, #641,
   then this PR. Each PR in the stack has its own deploy notes.
2. Apply the migrations of section 4.
3. Make sure that a trigger calls `/api/cron/tick` every 5 minutes. Check that
   `cron_health` has a recent `cron/tick` row.
4. Do the provider setup of section 5 for the customer.
5. Turn the module on for the tenant:
   `update tenant_settings set email_accountability_enabled = true where tenant_id = '<id>';`.
   The tenant starts in `observe` mode, so no action is made yet.
6. Each user opens Email Actions > Mailboxes and clicks Outlook or Gmail.
7. On each mailbox, click **check replies**. The check reads the newest 10
   sent messages and reports one of these verdicts:
   - `headers_ok`: replies verify by header.
   - `index_only` (Outlook): replies verify by the conversation index.
   - `headers_missing`: replies stay ambiguous and go to a person.
   - `no_replies_in_sample`: send a reply from the mailbox, then check again.
8. Let the sync run in observe mode for a few days. Read the health card
   (admins): "Last sync would make N actions, verify M". If the numbers look
   right, switch the tenant to create mode:
   `update tenant_settings set email_actions_mode = 'create' where tenant_id = '<id>';`.
9. Optional: set the policy (`PUT /api/email/policy`), for example for a
   Saturday work day: `{ "business_hours": { "weekend": ["Sun"] } }`. Add rules in
   Email Actions > Rules.

## 10. Known limits

1. **Outlook reply headers.** The Sent Items copy has no internet headers.
   The module reads In-Reply-To and References from the MAPI properties
   `0x1042` and `0x1039`, which no test has seen on a live mailbox. The
   onboarding check (step 7) shows whether they are there. Without them, the
   conversation index still links a reply in the same branch. Otherwise the
   result is ambiguous and goes to a person.
2. **Forwards.** Many clients send a forward with no In-Reply-To. A forward
   verifies only through References or the conversation index, and only when
   every target address received it. A forward with no target set is always
   ambiguous. A target is an address, not a role.
3. **Mail Anvil cannot see:** a reply from a mailbox that is not connected, a
   phone call, a chat message. Use the manual path: a claim with a note, which
   another user with `email.verify` confirms.
4. **The subject or the wording never links.** Two messages in the same
   conversation with no header or index link always give an ambiguous result.
5. **Delay.** A reply appears after the poll interval plus the tick delay.
   GitHub Actions runs schedules late and sometimes skips them.
6. **Throughput.** About 8 mailboxes per tick. A tenant with more mailboxes
   needs a larger handler budget or more frequent ticks.
7. **Consumer Gmail** (`@gmail.com`) is not supported. An External app in
   Testing gets refresh tokens that expire after 7 days. A published External
   app needs Google verification and a yearly security assessment, which costs
   money.
8. **Language.** The default phrases are English. Other languages need keyword
   rules.
9. **Body.** The rules read the subject and the first 255 characters only.
10. **Calendar.** There are no holidays yet. The weekend and the hours are a
    policy setting.
11. **People.** Anvil has no leave model and no manager hierarchy. "Owner
    unavailable" means that the owner is no longer an approved member, and
    escalation goes to roles.
12. **Notices** are in-app only, with no email and no push.
13. **Tests mock the providers.** A connector is proven only after the
    onboarding check on a real mailbox.

## 11. Acceptance checklist

Run: `NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/v3-app/api-mail-* src/v3-app/api-email-* src/v3-app/screens/email-actions.test.tsx src/v3-app/screens/home-email-actions.test.tsx`
(12 files, 212 tests, all pass on the EA-8 branch).

| # | Requirement | Where it is tested |
|---|---|---|
| 1 | A critical email creates exactly one action | `api-email-engine.test.js` "[1] ..." |
| 2 | An irrelevant email creates no task | `api-email-engine.test.js` "[2] ...", `api-email-rules.test.js` "what makes no action" |
| 3 | Duplicate sync events create no duplicates | `api-email-engine.test.js` "[3] ..."; the SQL function on PGlite (EA-3 PR) |
| 4 | Correct customer or sales order link when a reliable match exists | `api-email-engine.test.js` "[4] ..." |
| 5 | An Outlook reply is detected and verified | `api-email-verify-flow.test.js` "[5] ..." (end to end through the Graph adapter), `api-email-verify.test.js` |
| 6 | A Gmail reply is detected and verified | `api-email-verify-flow.test.js` "[6] ...", `api-email-verify.test.js` |
| 7 | Forwards match when the evidence is enough | `api-email-verify-flow.test.js` "[7] ...", `api-email-verify.test.js` |
| 8 | Ambiguous matches stay awaiting verification | `api-email-verify-flow.test.js` "[8] ...", `api-email-verify.test.js` |
| 9 | Reading an email does not complete an action | `api-email-engine.test.js` "[9] ..."; `isRead` is never selected (`api-mail-outlook-sync.test.js`) |
| 10 | An overdue item escalates per policy | `api-email-escalation.test.js` "[10] ..." |
| 11 | A sent acknowledgement does not resolve the issue | `api-email-verify-flow.test.js` "[11] ..." |
| 12 | Repeated scheduler runs do not duplicate reminders | `api-email-escalation.test.js` "[12] ..." |
| 13 | Sync recovers after an outage or an invalid checkpoint | `api-mail-outlook-sync.test.js`, `api-mail-gmail-sync.test.js` "recovery [13]" |
| 14 | Token expiry and revoked access are handled safely | `api-mail-outlook-sync.test.js`, `api-mail-gmail-sync.test.js` "tokens [14]" |
| 15 | Users cannot reach another user's restricted actions | `api-email-actions-api.test.js` "[15] ...", `api-email-connections.test.js` |
| 16 | Throttling does not cause excessive retries | `api-mail-outlook-sync.test.js` "throttling [16]", `api-mail-gmail-sync.test.js` |
| 17 | The cost-safety threshold stops further uncontrolled requests | `api-mail-outlook-sync.test.js` "[17]", `api-email-ops.test.js` "[17] ... end to end" |
| 18 | Existing task and sales order behaviour is unaffected | `api-email-engine.test.js` "[18] ..."; the full suite passes in each PR |

Every PR of the stack lists its mutation check: each rule was broken on
purpose, and a test failed.
