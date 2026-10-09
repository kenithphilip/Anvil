# Cron jobs

Anvil's scheduled work runs through two endpoints:

1. **`/api/cron/daily`**, scheduled by **Vercel cron** at 02:30 UTC. The
   Hobby plan accepts only daily cron expressions, so this is the only
   Vercel-side schedule.
2. **`/api/cron/tick`**, meant to run every 5 minutes, scheduled by an
   **external** caller. Hobby's once-per-day limit means a `*/5 * * * *`
   expression in `vercel.json` fails the deployment with "Hobby accounts
   are limited to daily cron jobs." The repository ships a GitHub Actions
   caller (`.github/workflows/cron-tick.yml`); the alternatives are below.

**What tick runs is gated.** `CRON_TICK_HANDLERS` (a Vercel environment
variable) is an allow-list of tick's handler names. Unset, tick runs ONLY
`extraction/jobs`. Most tick handlers have never run in production, so their
queues hold months of backlog, and several of them act on it: they send
queued customer email, place calls, bill metered usage and create draft
orders. Widen the list one handler at a time, after the cleanup the
[inventory](#handler-inventory) names for it.

If a deployment is later upgraded to Pro, the `/api/cron/tick` entry can be
re-added to `vercel.json` (see the end of this file). Until then, do NOT add
a sub-daily cron entry to `vercel.json`: it will break the build.

A heartbeat-staleness sweep runs at the end of every `/api/cron/daily`
invocation. It reads `cron_health.last_run_at` per worker via
`src/api/_lib/heartbeat-check.js` and logs `[heartbeat-check]` warnings for
any worker past its expected age. The same sweep is exposed by
`/api/_healthz` (F9) for external uptime monitors: the endpoint returns 503
when any cron is stale or the DB probe fails, so a stalled tick pages the
on-call within 60 seconds of the next monitor poll.

`CRON_EXPECTED_MAX_AGE_MS` in `_lib/heartbeat-check.js` is the single source
of truth for staleness bounds. Edit the per-worker key (not the `default`)
if a worker's cadence changes intentionally; never bump `default` to silence
a noisy alert.

Both endpoints are multiplexers that fan out to every per-handler cron path
internally. See `src/api/cron/tick.js` and `src/api/cron/daily.js`.

## Turning the tick on (owner, one time)

These steps are for the project owner. They need GitHub, Vercel and
database access, and nothing in the repository does them for you.

1. **Check whether something already calls tick.** In the Supabase SQL
   editor:

   ```sql
   select worker, last_run_at, last_status, metadata
   from cron_health
   where worker = 'cron/tick';
   ```

   - **No row, or a row weeks old:** nothing calls tick. Go on to step 2.
   - **A row from the last few minutes:** an earlier external trigger (for
     example cron-job.org) is live, so every tick handler is already
     running. Deploying the allow-list narrows that trigger to
     `extraction/jobs` unless you set `CRON_TICK_HANDLERS=all` in Vercel
     first. Pick one trigger: two of them double every call.

2. **Review and cancel stale extraction jobs** (SQL step 0 below). The
   default handler, `extraction/jobs`, works through the queue oldest first
   and writes each finished job's lines into its order, whatever state that
   order is in now.

3. **Add two repository secrets** in GitHub (Settings > Secrets and
   variables > Actions > New repository secret). Use secrets, not
   variables: variables are readable by anyone who can read the repository.
   - `CRON_SECRET`: the same value as `CRON_SECRET` in the Vercel project.
   - `ANVIL_BASE_URL`: the production origin, for example
     `https://anvil-flame.vercel.app` (no path, no trailing slash needed).

4. **Run the workflow once by hand.** Actions > cron-tick > Run workflow.
   The log shows HTTP 200, `"gate": {"mode": "default", ...}`,
   `"ran": ["extraction/jobs"]` and every other handler under
   `skipped_by_gate`. Then confirm the heartbeat landed:

   ```sql
   select worker, last_run_at, last_status
   from cron_health
   where worker in ('cron/tick', 'extraction/jobs');
   ```

   A 401 in the log means the GitHub secret does not match Vercel's
   `CRON_SECRET`, or Vercel has none. From then on the schedule calls tick
   every 5 minutes.

5. **Later, widen `CRON_TICK_HANDLERS` in Vercel** (Settings > Environment
   Variables, Production), one group at a time, after the cleanup the
   inventory names for it. Vercel applies an environment change on the next
   deployment, so redeploy after each change. A suggested order:
   1. `extraction/jobs,push/send,logistics/monitor,eval/agent_eval,eval/rescore`
   2. the sync and retry handlers of each ERP that is actually connected,
      after reviewing its retry queue
   3. the inbound email chain (`inbound/email/parse`,
      `inbound/email/persist_attachments`, `inbound/email/draft_orders`)
      after archiving the old inbound email
   4. `agents/handle_replies` and `agents/run`, after the agents/run
      cleanup below AND the reaper follow-up
   5. `prospecting/run` after reviewing the active campaigns, and
      `drift-meter` after the billing owner reviews the meter rows
   6. `voice/process_actions`, `inbound/process_messages` and
      `inbound/auto_ocr` only after their follow-up fixes

## `CRON_TICK_HANDLERS`

| Value | What tick runs |
| --- | --- |
| unset or blank | `extraction/jobs` only |
| `all` | every handler, on its cadence (the behaviour before the allow-list) |
| `none` | nothing (an off switch that leaves the scheduler alone) |
| `a,b,c` | exactly those handlers, each on its own cadence |

Names are tick's handler names (the first column of the inventory) and are
matched without regard to case. A custom list replaces the default, so
include `extraction/jobs` if you still want it. A name that is not
registered is reported under `gate.unknown` in the response and ignored; a
list of only unknown names runs nothing. `none` wins over everything, and
`all` wins over names listed beside it.

The variable is read on every call. The response names every registered
handler exactly once:

```json
{
  "ran_at": "...",
  "minute": 30,
  "ran_syncs": true,
  "ran_agents": false,
  "ran_agent_eval": false,
  "gate": { "mode": "list", "handlers": ["extraction/jobs", "tally/sync"], "unknown": [] },
  "ran": ["extraction/jobs", "tally/sync"],
  "skipped_by_gate": ["push/send", "..."],
  "not_due": [],
  "total": 2,
  "ok": 2,
  "failed": 0,
  "duration_ms": 4837,
  "results": [
    { "name": "extraction/jobs", "ok": true, "status": 200, "duration_ms": 312, "body_preview": "..." },
    { "name": "tally/sync", "ok": true, "status": 200, "duration_ms": 802, "body_preview": "..." }
  ]
}
```

`ran_syncs`, `ran_agents` and `ran_agent_eval` say which cadences were due
that minute; whether their handlers ran depends on the gate too, so read
`ran`. `not_due` lists handlers the gate allowed whose cadence did not match.
A handler the gate skipped writes no `cron_health` heartbeat.

## What runs in each tick

### `/api/cron/tick` (every 5 min, external)

Cadence, from the UTC minute of the call:

- **Every call (28):** `push/send`, `extraction/jobs`, `prospecting/run`,
  `inbound/email/parse`, `inbound/email/persist_attachments`,
  `inbound/email/draft_orders`, `voice/process_actions`,
  `inbound/process_messages`, `inbound/auto_ocr`, `agents/handle_replies`,
  `logistics/monitor`, and the 17 ERP retry drains (`netsuite`, `tally`,
  `sap`, `d365`, `acumatica`, `p21`, `eclipse`, `sxe`, `sage_x3`, `ifs`,
  `oracle_fusion`, `ramco`, `jde`, `plex`, `jobboss`, `oracle_ebs`,
  `proalpha`, each as `<erp>/retry`).
- **Minute % 30 == 0 (19):** the 17 ERP syncs (`<erp>/sync`, same list),
  `tally/reconcile` and `plm/sync`.
- **Minute == 0 (2):** `agents/run`, `drift-meter`.
- **Minute == 5 (2):** `eval/agent_eval`, `eval/rescore`.

Groups run one after another in that order; the handlers inside a group run
in parallel. cron-mux gives each handler a budget (20 s by default, 15 to
30 s for the ERP and logistics prefixes). A handler that overruns is
reported as `timed_out` but keeps running in the background until the
function exits, so its writes can land after the response.

**Exact-minute cadences need a punctual scheduler.** The 30-minute, hourly
and minute-5 groups run only when a call lands on exactly that UTC minute.
pg_cron and cron-job.org fire on the minute. GitHub Actions often starts a
scheduled run several minutes late, so with it those groups run only now
and then. Use pg_cron before relying on any of them.

`tally/reconcile` (Phase F.6) runs immediately after `tally/sync` in the
same group so the mirror table is fresh. It walks tenants with the drift
add-on and exported vouchers in the last 7 days, calls
`driftCheck({ scope: 'tenant_recent' })` per tenant (cap of 50 vouchers per
tenant per tick), persists findings, and optionally auto-remediates.

### `/api/cron/daily` (02:30 UTC, Vercel)

Fanned out in parallel by `runCronGroup` (`Promise.allSettled` with a
per-handler timeout: independent, not time-sensitive, and one slow handler
neither blocks nor starves the rest):

- analytics/refresh (win/loss rollups)
- fx/cron (FX rates)
- service/amc_cron (AMC contract reminders)
- rlhf/aggregate (RLHF reward rollups)
- quotes/expire
- billing/recurring
- eway_bills/expire
- catalog/embed (embedding indexer)
- drift-report (self-skips except on the 1st of the month)
- eval/quality_alert (DPMO breach to admin bell)
- docai/extraction_reaper (runs stranded at `status='running'`)
- logistics/monitor_daily, a **backstop**, see below
- eval/replay, only when `EVAL_REPLAY_ENABLED` is set

`CRON_TICK_HANDLERS` does not affect the daily group.

#### Why the logistics monitor is registered twice

`logistics-monitor-tick` is in tick's every-call group *and* in the daily
group. The tick group runs only if an external trigger is configured and
live, and the allow-list includes `logistics/monitor`; Hobby tier forbids a
sub-daily `vercel.json` schedule, so the daily path is the only cadence
Vercel itself guarantees. The handler is idempotent (the detector dedups per
(tenant, kind, object) and notifications track `detail.notified`), so the
second path costs a no-op, and no tenant runs it at all unless
`logistics_monitor_enabled` is on.

It is registered under **`logistics/monitor_daily`**, not tick's
`logistics/monitor`. Each name is a row in `cron_health`: reusing the 5-min
row would refresh it once a day against a 10-minute staleness bound (stale
about 23h50m out of every 24h, pinning `/api/_healthz` at 503) and would
also mask a dead external trigger by making the 5-min row look freshly
written. `logistics/monitor` keeps the 10-minute bound precisely so it still
reports whether that trigger is alive.

## Handler inventory

Verified against the code at the commit that added the allow-list. "Enable
now" still means after step 2 above for `extraction/jobs`.

| Handler | What it does | External side effects | DB writes | Existing gates | Backlog risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| `extraction/jobs` | Advances queued large-PDF extractions, up to 3 jobs per call, oldest first, one step each | LLM provider calls (cost) | `extraction_jobs`, `extraction_runs`, events, audit; on merge it overwrites the order's `result.salesOrder.lineItems` or ingests a quote | Per-tenant DocAI daily limits; job leases | Every job queued since background extraction shipped is still queued. The merge (`cron/extraction_jobs.js:777-795`) does not check the order's status | **Enable now** (the default), after SQL step 0 |
| `push/send` | Sends the 50 oldest queued web-push notifications to staff browsers | Web push to internal users (needs VAPID keys, otherwise the row is marked failed) | `push_notifications`, `push_subscriptions.is_active` | Only producer is the admin `POST /api/push/send` | Low. Quirk: a subscription whose channel is not `web` is skipped but the row is still marked sent (`push/send.js:47,58-63`) | **Enable now** |
| `logistics/monitor` | Delay/SLA detection, breach marking, bell, queued alert email | Bell; queued email rows (no recipient, so the agents/run reaper marks them failed) | `logistics_exceptions` and related, `communications` | `tenant_settings.logistics_monitor_enabled` (off by default); already runs daily | None new: the daily backstop already runs the same code | **Enable now** |
| `eval/agent_eval` | Scores recent `agent_runs` against `rlhf_feedback` | None (no LLM call) | One `agent_eval_runs` row per tenant with agent runs in the last 7 days | Only tenants with recent agent runs | None. Its header says weekly; it runs hourly | **Enable now** |
| `eval/rescore` | Re-scores the golden corpus from stored extractions | None (deterministic, no LLM) | An attested `eval_runs` row and its `eval_case_results` per scored suite | No-op unless `EVAL_GOLDEN_TENANT_ID` is set | None | **Enable now** |
| `<erp>/retry` (17) | Replays queued sales-order pushes into the tenant's ERP | Creates sales orders or vouchers in the customer's ERP | `<erp>_retry_queue`, `orders.result.external_systems` | Pending row due, and that ERP's credentials configured | No age limit (`_lib/erp-runner.js:82-87`; `netsuite` and `tally` have their own runners). A push the clerk has since keyed by hand becomes a duplicate | **Enable after** reviewing that ERP's pending rows (SQL step 5) |
| `<erp>/sync` (17), `plm/sync` | Pulls ERP or PLM state into mirror tables and order export status | ERP reads only (JDE's POST is a BROWSE) | Mirror tables, `orders.result.external_systems`; `tally/sync` also writes `tally_payment_receipts` and `invoices` | That system's credentials configured; Tally needs a `bridge_url` | First run has no watermark, so it pulls full history. `tally/sync` adds each pulled receipt to `invoices.paid_amount` even when the receipt was already stored (`tally/sync.js:153-165`) | **Enable after** a connector is live; `tally/sync` after the receipt fix (follow-up) |
| `tally/reconcile` | Drift check of recent Tally vouchers; optional auto-fix re-enqueues a voucher to `tally_retry_queue` | Indirect: a re-enqueued voucher is pushed by `tally/retry` | Findings, voucher rollups, `tally_drift_billing_meter` (billing input) | `tally_drift_addon_enabled` and exported vouchers in the last 7 days | Meter rows feed `drift-meter` billing | **Keep off** until the drift-meter decision |
| `inbound/email/parse` | Classifies the 25 oldest `received` inbound emails, matches the customer, routes to `linked`, `parsed` or `archived` | One LLM classifier call per email (cost) | `inbound_emails`, `inbound_email_threads` | None | Every email received since the webhook went live; `linked` ones become draft orders, intents drive `agents/handle_replies` | **Enable after** SQL step 4, together with the next two |
| `inbound/email/persist_attachments` | Uploads inline base64 attachments to storage and creates `documents` rows | None outside Supabase | `inbound_emails.attachments`, `documents`, storage | None | Starves: it reads the 80 oldest emails of any status, then filters (`persist_attachments.js:54-57`), so once 80 older emails have no inline bytes it never sees a newer one | **Enable after** SQL step 4; fix the starvation for it to be useful |
| `inbound/email/draft_orders` | Turns `linked` inbound emails into DRAFT orders and links their documents | None | `orders` (DRAFT), `order_documents`, `audit_events`, `inbound_emails`, threads | None | Every `linked` email becomes a draft | **Enable after** SQL step 4 |
| `agents/handle_replies` | Applies classified replies to agent goals (payment ack pauses dunning 14 days; delivery query and complaint raise events) | None | `agent_goals`, `agent_steps`, `processing_events`, `inbound_emails` | None | Inserts `agent_steps` with an undefined `tenant_id` (`agents/handle_replies.js:41,74`), which fails silently; a stale payment ack pauses dunning for 14 days | **Keep off** until the tenant_id fix; then enable with `agents/run` |
| `agents/run` | Advances active agent goals, then reaps queued `communications` for each touched tenant | Sends email to customers (quotes, invoices, dunning), mints pay-link tokens, places voice calls (`voice_followup`) | `agent_goals`, `agent_steps`, `communications`, pay-link tokens | Goal `status='active'` and `next_run_at` due | The reaper (`agents/run.js:276-314`) sends the 100 oldest queued rows per touched tenant with no age, kind or channel filter. `quotes/send.js:447-466` and `invoices/send.js:148-165` queue the customer email and never send it, so months of quote and invoice email would go out on the first run. Every sent quote arms two goals (`quotes/send.js:44-86`); `quote_accept` escalates every 72 h forever, even for declined or expired quotes | **Keep off** until SQL steps 1 to 3 AND the reaper follow-up |
| `drift-meter` | Reports unreported `tally_drift_billing_meter` rows to Stripe meters or Razorpay add-ons | **Bills customers** (real money) | `tally_drift_billing_meter` stamps | Tenant has a Stripe or Razorpay subscription; trial and enterprise plans are stamped without billing | Every meter row since the drift add-on shipped, including rows from manual reconcile runs. Rows with no provider are never stamped and stay in the 200-oldest window (`cron/drift-meter.js:30-35,136-138`). The Stripe path falls back to `stripe_account_id` as the customer id (`cron/drift-meter.js:61,90-95`) | **Keep off** until the billing owner reviews the unreported rows (SQL step 6) |
| `prospecting/run` | Sends cold marketing email to approved targets of active campaigns | Marketing email to prospects | `prospecting_targets`, `communications` (marketing) | Campaign `active`, send window, daily cap (default 100 per campaign), suppressions, marketing sender configured | Every approved target, however old the approval. The send window is compared in UTC although it is described as campaign-local (`prospecting/run.js:32-43`) | **Keep off** until the active campaigns and approved targets are reviewed |
| `voice/process_actions` | Turns open voice-call actions into DRAFT orders and other actions | None found | `orders` (DRAFT), `voice_call_actions` | None; its manual drain covers ALL tenants (`voice/process_actions.js:150`) | Every open action since voice shipped becomes a draft | **Keep off** until SQL step 3b and the drain fix |
| `inbound/process_messages` | Turns `arrived` chat messages into DRAFT orders or status events | None | `orders` (DRAFT), `inbound_messages`, events | None | The PO regex (`_lib/chat-intent.js:79`) has no word boundary, so "support" and "report" become orders | **Keep off** until the regex fix and SQL step 3a |
| `inbound/auto_ocr` | Runs extraction on inbound documents linked to orders | LLM provider calls (cost) | `extraction_runs` | None | Starves: it filters after a fixed 20-row oldest-first fetch (`inbound/auto_ocr.js:55-57,104`) | **Keep off** until the starvation fix |

## Cleanup SQL (owner reviews; nothing runs it)

These are suggestions for the project owner. Run each review query first,
read the result, and adjust the intervals before running an update. They
are written against the current migrations; check the column names against
the live schema before running them.

**Step 0: extraction jobs (before turning on the default).**

```sql
-- Review: every non-terminal job, oldest first, with its order's status now.
select j.id, j.tenant_id, j.order_id, o.status as order_status,
       j.status, j.attempts, j.created_at
from extraction_jobs j
left join orders o on o.id = j.order_id
where j.status in ('queued', 'profiling', 'chunking', 'extracting', 'merging')
order by j.created_at;

-- Cancel the stale ones.
update extraction_jobs
set status = 'cancelled',
    last_error = 'cancelled before the cron tick was enabled: stale',
    completed_at = now(),
    lease_until = null
where status in ('queued', 'profiling', 'chunking', 'extracting', 'merging')
  and created_at < now() - interval '1 day';
```

**Step 1: queued communications (before `agents/run`).**

```sql
-- Review by document_type and age.
select coalesce(document_type, '(none)') as document_type, channel,
       count(*) as queued,
       count(*) filter (where to_addr is null) as no_recipient,
       count(*) filter (where created_at < now() - interval '2 days') as older_than_2_days,
       min(created_at) as oldest,
       max(created_at) as newest
from communications
where status = 'queued'
group by 1, 2
order by queued desc;

-- Archive the stale ones.
update communications
set status = 'archived',
    metadata = coalesce(metadata, '{}'::jsonb)
      || jsonb_build_object('archived_reason', 'stale queue before agents/run was enabled',
                            'archived_at', now()),
    updated_at = now()
where status = 'queued'
  and created_at < now() - interval '2 days';
```

**Step 2: agent goals (before `agents/run`).**

```sql
-- Review.
select goal_type, count(*) as active,
       count(*) filter (where due_at < now()) as past_due,
       count(*) filter (where due_at is null) as no_due_date,
       min(created_at) as oldest
from agent_goals
where status = 'active'
group by goal_type
order by active desc;

-- Cancel active goals whose due_at has passed.
update agent_goals
set status = 'cancelled',
    last_error = 'cancelled before agents/run was enabled: past due_at',
    updated_at = now()
where status = 'active'
  and due_at is not null
  and due_at < now();

-- Cancel quote goals whose quote is no longer open.
update agent_goals g
set status = 'cancelled',
    last_error = 'cancelled before agents/run was enabled: quote no longer SENT',
    updated_at = now()
from quotes q
where g.status = 'active'
  and g.object_type = 'quote'
  and g.object_id = q.id
  and q.status <> 'SENT';
```

**Step 3: old chat messages and voice actions.**

```sql
-- 3a. Review, then resolve, chat messages that never got a consumer.
select channel, count(*), min(received_at), max(received_at)
from inbound_messages
where status = 'arrived'
group by channel;

update inbound_messages
set status = 'resolved',
    processed_at = now(),
    error = 'bulk-resolved before the cron tick was enabled'
where status = 'arrived'
  and received_at < now() - interval '2 days';

-- 3b. Review, then close, open voice-call actions.
select action, count(*), min(created_at), max(created_at)
from voice_call_actions
where completed = false
group by action;

update voice_call_actions
set completed = true,
    completed_at = now(),
    error = 'bulk-closed before the cron tick was enabled'
where completed = false
  and created_at < now() - interval '2 days';
```

**Step 4: old inbound email (before the email chain).**

```sql
select status, count(*), min(received_at), max(received_at)
from inbound_emails
where status in ('received', 'linked')
group by status;

update inbound_emails
set status = 'archived',
    error = 'archived before the cron tick was enabled'
where status in ('received', 'linked')
  and received_at < now() - interval '7 days';
```

**Step 5: an ERP retry queue (before that ERP's `retry` handler).** Shown
for Tally; every connector has the same `<erp>_retry_queue` shape.

```sql
select count(*), min(created_at), max(created_at)
from tally_retry_queue
where status = 'pending';

update tally_retry_queue
set status = 'gave_up',
    last_error = 'gave up before the cron tick was enabled: stale',
    updated_at = now()
where status = 'pending'
  and created_at < now() - interval '2 days';
```

**Step 6: drift-meter rows (review only; the billing owner decides).**

```sql
select tenant_id, count(*) as rows, sum(vouchers_reconciled) as vouchers,
       min(created_at) as oldest
from tally_drift_billing_meter
where reported_to_stripe_at is null
  and reported_to_razorpay_at is null
group by tenant_id;
```

## Follow-ups before widening the allow-list

- **agents/run reaper:** add an age limit and a `document_type` allow-list
  to `reapQueuedCommsForTenant` (`agents/run.js:276-314`), so a queued row
  from months ago is never sent.
- **All-tenant manual drains:** these manual (user-triggered) paths drain
  every tenant, not the caller's: `voice/process_actions.js:150`,
  `agents/handle_replies.js:181`, `inbound/email/parse.js:148`,
  `inbound/email/persist_attachments.js:128`, `cron/tally-reconcile.js:90`.
- **Chat PO regex:** add word boundaries to the PO pattern in
  `_lib/chat-intent.js:79`.
- **Starving drains:** `inbound/auto_ocr.js:55-57,104` and
  `inbound/email/persist_attachments.js:54-57` filter after a fixed
  oldest-first fetch; move the filter into the query.
- **handle_replies tenant_id:** set `tenant_id` on the `agent_steps`
  inserts (`agents/handle_replies.js:41,74`).
- **tally/sync receipts:** apply a receipt to `invoices.paid_amount` only
  when it is first inserted (`tally/sync.js:153-165`).
- **drift-meter:** stop treating `stripe_account_id` as a Stripe customer id
  (`cron/drift-meter.js:61`), and stop unbillable rows from holding the
  200-row window.
- **extraction/jobs:** skip the order write-back when the order has moved
  past the state the job was queued in.
- **Exact-minute cadences:** switch the 30-minute, hourly and minute-5
  checks to "has it run in this window" (for example from `cron_health`),
  so a late call still runs them.
- **Fail-open cron endpoints:** these skip auth entirely when `CRON_SECRET`
  is unset (`if (CRON_SECRET) { ... }`), unlike tick:
  `cron/conformal-calibration-weekly.js:140`,
  `cron/inventory-exceptions-tick.js:26`,
  `cron/inventory-planning-weekly.js:779`,
  `cron/inventory-positions.js:20`,
  `cron/logistics-monitor-tick.js:28`.

## Schedulers

### Option A: GitHub Actions (in the repository)

`.github/workflows/cron-tick.yml` calls `GET /api/cron/tick` every 5
minutes, and on demand from the Actions tab. It needs the two repository
secrets from step 3 above; with either unset, each run exits 0 with a notice
and calls nothing. The repository is public, so its Actions logs are
public: the workflow prints handler names, status codes, counts and
durations only, never a response body or a secret.

Caveats: GitHub runs schedules best-effort, so a run can start minutes late
or be dropped under load (see the exact-minute note above), and it disables
a public repository's schedules after 60 days with no repository activity.
A gap of more than 10 minutes between calls also marks `cron/tick` stale,
so `/api/_healthz` can flip to 503 now and then on this scheduler.

### Option B: Supabase pg_cron + pg_net

Fires on the minute and keeps the secret in the database's Vault. Enable
the `pg_cron` and `pg_net` extensions (Database > Extensions), then in the
SQL editor:

```sql
-- One time. Paste the real values here, not into a file in the repository.
select vault.create_secret('<the CRON_SECRET value from Vercel>', 'anvil_cron_secret');
select vault.create_secret('https://<your-production-host>', 'anvil_base_url');

select cron.schedule(
  'anvil-tick',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets
            where name = 'anvil_base_url') || '/api/cron/tick',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'anvil_cron_secret')),
    timeout_milliseconds := 60000
  );
  $$
);

-- Watch it.
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'anvil-tick')
order by start_time desc
limit 10;

select status_code, left(content::text, 200), created
from net._http_response
order by created desc
limit 10;

-- Stop it.
select cron.unschedule('anvil-tick');
```

Use this OR the GitHub workflow, not both. To stop the GitHub workflow,
disable it in the Actions tab or delete the two repository secrets.

### Option C: cron-job.org (free)

1. Sign up at <https://cron-job.org>.
2. Create one job:
   - **Title**: `Anvil tick`
   - **URL**: `https://anvil-flame.vercel.app/api/cron/tick` (or your
     production URL)
   - **Schedule**: every 5 minutes (`*/5 * * * *`)
   - **Method**: GET
   - **Advanced > HTTP headers**:
     - `Authorization: Bearer <your-CRON_SECRET-value>`
   - **Advanced > Notifications**: enable on failure
   - **Advanced > Save responses**: enable for the last 30 runs
3. Save and verify: cron-job.org will invoke once and the dashboard will
   show a 200 response within 30 seconds.

### Option D: Upstash QStash ($10/month flat for 1M messages)

Better SLA than cron-job.org. Use if you ever miss a tick that costs real
money. Setup: <https://upstash.com/docs/qstash>.

## Rotating CRON_SECRET

When you rotate the secret in Vercel env vars:

1. Update the caller: the `CRON_SECRET` repository secret for the GitHub
   workflow, the `anvil_cron_secret` Vault secret for pg_cron
   (`vault.update_secret`), or the header in cron-job.org.
2. Vercel redeploys automatically with the new env var.
3. Briefly during the cutover, both old and new secrets should be accepted.
   Anvil's handler does a strict equality check today, so plan a
   maintenance minute. If higher availability is needed, extend
   `cron-mux.js` to accept either of two secrets read from `CRON_SECRET`
   and `CRON_SECRET_PREVIOUS`.

## Why we don't run the tick on Vercel

Vercel Hobby restricts crons to **once per day**:

> Hobby accounts are limited to daily cron jobs. This cron
> expression would run more than once per day.

(Source: <https://vercel.com/docs/cron-jobs/usage-and-pricing>.)

For the every-5-min queues we'd need Vercel Pro ($20/user/month). An
external caller is cheaper and behaves the same.

## Switching to Vercel Pro later

If we move to Pro, we can fold `/api/cron/tick` back into `vercel.json` and
retire the external caller. The endpoint code stays unchanged, and
`CRON_TICK_HANDLERS` keeps gating what it runs.

```jsonc
"crons": [
  { "path": "/api/cron/tick",  "schedule": "*/5 * * * *" },
  { "path": "/api/cron/daily", "schedule": "30 2 * * *" }
]
```

That's the only change required.

## Monitoring

The `/api/cron/tick` response includes the per-handler `results` array
shown above. Scan it for `"ok":false` to find broken sub-handlers; the
GitHub workflow raises a warning annotation naming them. cron-mux records a
handler that answers with a status of 400 or more as failed, whether it
answered through `res.status()` or by setting `res.statusCode` before
`res.end()`.

`cron_health` holds one row per worker (`cron/tick` plus each handler that
ran), and `/api/_healthz` reports stale rows. The per-handler audit tables
(`netsuite_sync_runs`, etc.) also show Vercel-side state for every sync and
retry attempt. Use those for deeper diagnostics.
