-- 066_cron_health.sql
--
-- Audit P5.1 (May 2026). The 5-minute /api/cron/tick is not in
-- vercel.json. The deployment design at docs/CRONS.md uses
-- cron-job.org as the external trigger because Hobby tier limits
-- Vercel cron to once per day. That's a reasonable choice, but
-- /api/health doesn't probe last-tick freshness, so a silent
-- external-cron failure (account expired, billing lapse,
-- hostname change) is invisible. All sub-daily ops, the
-- autonomous agents, all 17 ERP retry queues, the inbound email
-- parser, the new Phase 2 queue consumers, all collapse silently
-- if the external cron lapses.
--
-- Schema: one row per worker name, updated on every successful
-- run. /api/health joins this table and surfaces freshness so
-- on-call sees a stale-cron alarm immediately.

create table if not exists cron_health (
  worker text primary key,                              -- e.g. 'cron/tick', 'cron/daily', 'inbound/email/parse'
  last_run_at timestamptz not null default now(),
  last_status text,                                     -- 'ok' | 'partial' | 'error'
  last_duration_ms integer,
  consecutive_failures integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,          -- worker-specific stats (rows processed, etc.)
  updated_at timestamptz not null default now()
);

create index if not exists cron_health_last_run_idx
  on cron_health (last_run_at desc);

-- /api/health probes age via NOW() - last_run_at. We don't store
-- a separate "expected cadence" column today; the probe encodes
-- the cadences (5 min for tick, 24 h for daily, etc.).
