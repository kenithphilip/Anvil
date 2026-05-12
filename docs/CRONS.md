# Cron jobs

Anvil's scheduled work runs in two places, with redundant
triggers so a single-vendor outage does not stall everything.

1. **Vercel cron** (primary) runs both `/api/cron/daily` (02:30 UTC)
   and `/api/cron/tick` (every 5 min, Phase 1 F4). Pro plan tier
   is required for the 5-minute cadence. Vercel injects
   `Authorization: Bearer ${CRON_SECRET}` automatically.
2. **External cron** (fallback) keeps `/api/cron/tick` on
   cron-job.org as a redundant trigger. The handler is idempotent
   so a double-fire is safe but wasteful; production may keep both
   for the first 14 days after a deploy, then disable the external
   job once the Vercel cron has 14 days of green data.

A heartbeat-staleness sweep runs at the end of every `/api/cron/daily`
invocation. It reads `cron_health.last_run_at` per worker via
`src/api/_lib/heartbeat-check.js` and logs `[heartbeat-check]`
warnings for any worker past its expected age. The same sweep is
exposed by `/api/_healthz` (F9) for external uptime monitors:
the endpoint returns 503 when any cron is stale or the DB probe
fails, so a stalled tick pages the on-call within 60 seconds of
the next monitor poll.

`CRON_EXPECTED_MAX_AGE_MS` in `_lib/heartbeat-check.js` is the
single source of truth for staleness bounds. Edit the per-worker
key (not the `default`) if a worker's cadence changes
intentionally; never bump `default` to silence a noisy alert.

Both endpoints are multiplexers that fan out to every per-handler
cron path internally. See `src/api/cron/tick.js` and
`src/api/cron/daily.js`.

## What runs in each tick

### `/api/cron/tick` (every 5 min, external)

ALWAYS:

- 8 ERP retry queues (parallel): NetSuite, Tally, SAP, D365,
  Acumatica, Prophet 21, Eclipse, SX.e
- Push notification queue drain
- Inbound email parse

WHEN minute % 30 === 0 (on the hour and half-hour):

- 8 ERP syncs (parallel) — including Tally state mirror.
- **Tally voucher reconciliation** (Phase F.6). Runs immediately
  after `tally/sync` so the mirror table is fresh. Walks tenants
  with exported vouchers in the last 7 days, calls
  `driftCheck({ scope: 'tenant_recent' })` per tenant (cap of 50
  vouchers per tenant per tick), persists findings, optionally
  auto-remediates. Endpoint: `/api/cron/tally-reconcile`. Audit
  `tally_recon_run` (or `tally_drift_detected` when findings
  surface).

WHEN minute === 0 (on the hour):

- Autonomous agent run

### `/api/cron/daily` (02:30 UTC, Vercel)

Sequenced (independent, not time-sensitive):

- analytics/refresh (win/loss rollups)
- fx/cron (FX rates)
- service/amc_cron (AMC contract reminders)
- rlhf/aggregate (RLHF reward rollups)

## Setting up the external cron

### Option A: cron-job.org (recommended, free)

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
3. Save and verify: cron-job.org will invoke once and the dashboard
   will show a 200 response within 30 seconds.

### Option B: GitHub Actions (free for private repos within free
minutes; up-to-60-min delay possible)

Create `.github/workflows/cron-tick.yml`:

```yaml
name: cron-tick
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch: {}
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsSL -X GET \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            https://anvil-flame.vercel.app/api/cron/tick
```

Add `CRON_SECRET` as a GitHub Actions repo secret.

**Caveat**: GitHub Actions schedules can be delayed up to 60 minutes
during platform load, which would break the every-5-min retry
semantics. Use cron-job.org if that matters.

### Option C: Upstash QStash ($10/month flat for 1M messages)

Better SLA than cron-job.org. Use if you ever miss a tick that costs
real money. Setup: <https://upstash.com/docs/qstash>.

## Rotating CRON_SECRET

When you rotate the secret in Vercel env vars:

1. Update `Authorization: Bearer <new-secret>` in cron-job.org's job
   config.
2. Vercel redeploys automatically with the new env var.
3. Briefly during the cutover, both old and new secrets should be
   accepted. Anvil's handler does a strict equality check today, so
   plan a maintenance minute. If higher availability is needed,
   extend `cron-mux.js` to accept either of two secrets read from
   `CRON_SECRET` and `CRON_SECRET_PREVIOUS`.

## Why we don't run the tick on Vercel

Vercel Hobby restricts crons to **once per day**:

> Hobby accounts are limited to daily cron jobs. This cron
> expression would run more than once per day.

(Source: <https://vercel.com/docs/cron-jobs/usage-and-pricing>.)

For the every-5-min retry queue + push + inbound email flows, we'd
need Vercel Pro ($20/user/month). External cron is cheaper and gives
us identical behaviour.

## Switching to Vercel Pro later

If we move to Pro, we can fold `/api/cron/tick` back into
`vercel.json` and retire the external cron. The endpoint code stays
unchanged.

```jsonc
"crons": [
  { "path": "/api/cron/tick",  "schedule": "*/5 * * * *" },
  { "path": "/api/cron/daily", "schedule": "30 2 * * *" }
]
```

That's the only change required.

## Monitoring

The `/api/cron/tick` response includes a per-handler results array:

```json
{
  "ran_at": "...",
  "minute": 30,
  "ran_syncs": true,
  "ran_agents": false,
  "total": 18,
  "ok": 17,
  "failed": 1,
  "duration_ms": 4837,
  "results": [
    { "name": "netsuite/retry", "ok": true, "status": 200, "duration_ms": 312, "body_preview": "..." },
    { "name": "p21/sync", "ok": false, "status": 502, "duration_ms": 8021, "error": "..." },
    ...
  ]
}
```

cron-job.org's "Save responses" feature captures this in their UI.
You can scan for `"ok":false` to find broken sub-handlers.

The per-handler audit tables (`netsuite_sync_runs`, etc.) also show
Vercel-side state for every sync and retry attempt. Use those for
deeper diagnostics.
