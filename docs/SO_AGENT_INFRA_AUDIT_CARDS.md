# Sales order agent infrastructure: audit cards

Evidence file for `docs/SO_AGENT_INFRA_AUDIT.md`. Base `origin/main` at
`931eb143`. Docs only.

These are the five layer reports, as the layer auditors wrote them, one per
layer (L1 to L5). The lead re-read every high claim in code, and a verifier
re-read every high defect, conflict and signal verdict (audit section 9).
Where this file and the audit document differ, the audit document wins. Each
report has the Q1 to Q18 card for every mechanism, the layer questions, the
open PR overlay, the O-2 rows, new mechanisms, defects with their failure
scenario and fix, and target model notes. The owner queries are in Appendix A
of the audit document, not here.


---

# L1. Clock and drains: audit findings (M-1 to M-11)

Base: `origin/main` at `931eb143`. All `path:line` refer to that commit. Paths
without a prefix are under `src/api/`. `NNN:line` is a migration in
`supabase/migrations/`. Read only. No database, no handler run.

**Labels.** [V] Verified: read in code. [I] Inferred: follows from verified
facts, steps given. [NC] Not confirmed. "Live" needs the owner queries in
section 6. No live fact is claimed here.

## 0. The eight L1 questions, in one line each

1. **Does anything call `/api/cron/tick`?** Nothing in the repo does [V]:
   `vercel.json:12-17` schedules only `/api/cron/daily`; `.github/workflows`
   holds `ci.yml`, `injection-bench.yml`, `seed-apply.yml`, none calls tick;
   no migration uses `pg_cron`. An external trigger may exist
   (`docs/CRONS.md:8-14`). Live: NC, owner query 1.
2. **Which handlers run where?** 51 in tick, 13 in daily (14 with
   `EVAL_REPLAY_ENABLED`), 1 handler on both paths, 5 routable-only. See
   section 2.
3. **How many queue shapes?** 11 drain shapes on main, 13 with #635 and #640.
   See section 3.
4. **Do the maps cover every heartbeat?** No. Two maps disagree, and most
   rows fall to a 10-minute default. See H-3 in section 7.
5. **Heartbeat writes per run?** Two for every fanned-out handler, three for
   the logistics monitor. One failure usually counts twice. See section 5.
6. **Late trigger?** The 30-minute, hourly and minute-5 groups need the call
   to land on the exact minute (`cron/tick.js:143-149`). A late call skips
   them [V]. A trigger that is always offset never runs them [I].
7. **Do budgets fit 60 s?** The ALWAYS group fits (parallel, 30 s bound).
   Minute 0 does not: 30 + 30 + 20 = 80 s of group bounds run one after
   another. See section 4.
8. **Which drains act on an old backlog?** See section 2, column "Backlog
   risk", and section 11.

---

## 1. Cards

```text
M-1  Vercel cron                                   layer: L1
status on main: wired
live: not confirmed (owner query 1, row cron/daily)
Q1  job: Vercel calls GET /api/cron/daily once a day at 02:30 UTC.
    vercel.json:12-17 [V]; docs/CRONS.md:5-7. The Hobby limit is the stated
    reason for one schedule (docs/CRONS.md:8-19).
Q3  trigger: schedule "30 2 * * *"                 vercel.json:14-15 [V]
    All /api paths rewrite to api/dispatch.js (vercel.json:40), which has
    maxDuration 60 (vercel.json:7-11) [V].
Q4  unit of work: none
Q5  claim: none         Q6  retry: none in repo     Q7  dedup: none
Q8  tenant: n/a         Q9  authority: Bearer CRON_SECRET; daily refuses
                            without it (cron/daily.js:62-65) [V]
Q10 outside effects: none itself (see M-3)
Q11 order writes: none
Q12 failure goes to: Vercel dashboard; cron/daily heartbeat 'error'
    (cron/daily.js:136) [V]
Q13 trail: cron_health row cron/daily (cron/daily.js:102-106) [V]
Q14 health: cron/daily bound 30 h in both maps (_lib/heartbeat-check.js:20;
    health.js:101) [V]
Q15 config: CRON_SECRET; vercel.json
Q16 tests: v3-app/api-cron-logistics-daily.test.js:80-95 asserts one daily
    cron [V]
Q17 overlaps: M-2 (tick needs a second trigger the repo lacks)
Q18 owner plan: #566 (GitHub Actions trigger for tick only); O-5 scheduler
notes / defects: none new. No tick caller anywhere in repo [V].
```

```text
M-2  Tick multiplexer (ALWAYS, 30-min, hourly, minute-5)   layer: L1
status on main: wired, not scheduled
live: not confirmed (owner query 1, row cron/tick). Code does not prove
    "no": an external trigger is documented (docs/CRONS.md:8-14).
Q1  job: fan out to 51 handlers in four groups every call
    (cron/tick.js:1-19, :87-132, :151-217) [V]
Q3  trigger: GET + Bearer CRON_SECRET (cron/tick.js:138-141). Gates:
    syncs at minute % 30 == 0 (:144), agents at minute 0 (:145), eval at
    minute 5 (:149). Groups run ONE AFTER ANOTHER: ALWAYS (:190), syncs
    (:194), hourly (:199), minute-5 (:213). Inside a group, handlers run in
    parallel (_lib/cron-mux.js:192-194) [V].
Q4  unit of work: none
Q5  claim: none. Two overlapping calls run every drain twice [I: no lock in
    cron/tick.js]
Q6  retry: none. A handler timeout abandons, it does not cancel
    (_lib/cron-mux.js:107-112) [V]
Q7  dedup: none           Q8  tenant: each handler walks all tenants
Q9  authority: CRON_SECRET; handlers get a mock cron request
    (_lib/cron-mux.js:24-34) [V]
Q10 outside effects: through handlers (section 2)
Q11 order writes: through handlers: extraction/jobs (cron/extraction_jobs.js:
    808-810), draft order inserts (inbound/email/draft_orders.js:75;
    voice/process_actions.js:54; inbound/process_messages.js:58), Tally retry
    status (tally/retry.js:96-100). None passes a gate [V].
Q12 failure goes to: per-handler cron_health row; HTTP 200 with a failed
    count (cron/tick.js:246-257); a throw gives 500 and a cron/tick 'error'
    heartbeat (:258-261) [V]
Q13 trail: cron_health only. No audit row for the tick.
Q14 health: cron/tick 10 min in both maps (_lib/heartbeat-check.js:19;
    health.js:100) [V]
Q15 config: CRON_SECRET only. No per-handler switch on main.
Q16 tests: no test drives cron/tick.js. api-cron-mux.test.js:21-37 covers
    shouldRunOnMinute only [V].
Q17 overlaps: M-3 (second fan-out, same runtime), M-1
Q18 owner plan: #566 (registry, allow-list, scheduler); O-3 constraint 4
notes / defects: the comment at cron/tick.js:164-177 says persist_attachments
    runs "BEFORE" draft_orders; the group is parallel (L1-D15). The header at
    :17 says Vercel injects the secret; Vercel never calls tick (L1-D24).
    Exact-minute gates (L1-D09). Minute 0 over budget (L1-D08).
```

```text
M-3  Daily multiplexer                              layer: L1
status on main: wired
live: not confirmed (owner query 1, row cron/daily)
Q1  job: fan out to 13 handlers, 14 with EVAL_REPLAY_ENABLED
    (cron/daily.js:67-97), then a staleness sweep (:121-122) [V]
Q3  trigger: M-1, once a day
Q4  unit of work: none
Q5  claim: none           Q6  retry: none           Q7  dedup: none
Q8  tenant: handlers walk all tenants
Q9  authority: CRON_SECRET (cron/daily.js:62-65) [V]
Q10 outside effects: section 2 (FX fetch, email queued by drift-report,
    bells, LLM in eval/replay)
Q11 order writes: none directly
Q12 failure goes to: cron_health rows; the sweep only logs
    (_lib/heartbeat-check.js:98-110) [V]
Q13 trail: cron_health
Q14 health: cron/daily 30 h; every sub-handler row 10 min default except
    logistics/monitor_daily 30 h (_lib/heartbeat-check.js:47) [V]
Q15 config: CRON_SECRET; EVAL_REPLAY_ENABLED (cron/daily.js:94-96)
Q16 tests: api-cron-logistics-daily.test.js:27-48, :97-99;
    api-forecast-snapshot-cron.test.js [V]
Q17 overlaps: M-2 (the logistics monitor runs on both)
Q18 owner plan: #534 (planner), #623 (stale-tick bell), #640
    (email/sweep_daily), #642 (email/purge)
notes / defects: catalog/embed is registered as GET and runs its status
    branch, not its cron branch (L1-D10). Header cron/daily.js:3-7 names four
    handlers; there are 13 (L1-D24).
```

```text
M-4  Fan-out runtime (mock request, per-handler budget, parallel group)  layer: L1
status on main: wired
live: as M-2 and M-3
Q1  job: run a handler in process with a mock req/res, a timeout and an
    inline heartbeat (_lib/cron-mux.js:1-15, :123-189); group runner
    (:192-199); minute helper (:203-207) [V]
Q3  trigger: cron/tick.js and cron/daily.js
Q4  unit of work: one handler call
Q5  claim: n/a
Q6  retry: none. Budget by name prefix (:75-105), default 20 s (:98),
    Promise.race (:142-145). The loser keeps running (:107-112) [V]
Q7  dedup: n/a            Q8  tenant: n/a
Q9  authority: mock req carries CRON_SECRET (:24-34) [V]
Q10 outside effects: none itself
Q11 order writes: none
Q12 failure goes to: result {ok, status, error, timed_out} (:146-170). The
    mock res ignores "res.statusCode = n" (:39-62), so agents/run.js:375-377
    and cron/extraction_jobs.js:925-926, :979-981 report 200 [V] (L1-D05)
Q13 trail: inline heartbeat, fire and forget (:177-187) [V]
Q14 health: n/a
Q15 config: VITEST turns the inline heartbeat off (:177); per-entry
    timeoutMs (cron/daily.js:95)
Q16 tests: api-cron-mux.test.js (17 tests). Not covered: statusCode
    assignment, the inline heartbeat, group wall time [V]
Q17 overlaps: none
Q18 owner plan: #566 (statusCode accessor)
notes / defects: L1-D05, L1-D18
```

```text
M-5  Heartbeats                                    layer: L1
status on main: wired
live: not confirmed (owner query 1)
Q1  job: one row per worker name: last run, status, duration, consecutive
    failures (066:1-26; _lib/cron-mux.js:209-243) [V]
Q3  trigger: inline per handler (_lib/cron-mux.js:178), result loop
    (cron/tick.js:238-244; cron/daily.js:107-113), parent rows
    (cron/tick.js:229, :260; cron/daily.js:102, :136), self writes
    (cron/logistics-monitor-tick.js:60-71; cron/inventory-positions.js:48-55;
    cron/inventory-exceptions-tick.js:54-61;
    cron/inventory-planning-weekly.js:805-812;
    cron/conformal-calibration-weekly.js:166-173) [V]
Q4  unit of work: cron_health (066:18-26), PK worker (066:19). last_status is
    free text; 066:21 documents ok|partial|error, writers also use 'timeout'
    (_lib/cron-mux.js:179), 'partial_failure' and 'failed'
    (cron/logistics-monitor-tick.js:61, :68) [V]
Q5  claim: upsert on worker (_lib/cron-mux.js:238). Failure path reads then
    writes consecutive_failures (:233-237), not atomic [V]
Q6  retry: none           Q7  dedup: PK              Q8  tenant: none (global)
Q9  authority: service client (_lib/cron-mux.js:222)
Q10 outside effects: none  Q11 order writes: none
Q12 failure goes to: console.warn, swallowed (:239-242)
Q13 trail: it is the trail
Q14 health: read by M-6
Q15 config: VITEST (:177)
Q16 tests: names only (api-cron-logistics-daily.test.js:37-41); no test of
    write counts
Q17 overlaps: M-49 (per-mechanism logs)
Q18 owner plan: O-3 constraint 4
notes / defects: H-4 confirmed (section 5, L1-D18)
```

```text
M-6  Staleness checks (two maps, public probe, daily sweep)  layer: L1
status on main: wired; the sweep only logs
live: not confirmed (owner query 1)
Q1  job: mark each cron_health row stale against a bound; serve
    /api/health (footer), /api/_healthz (external monitor), daily sweep [V]
Q3  trigger: GET /api/health (health.js:151-186); GET /api/_healthz
    (healthz.js:58-94, 5 s cache); daily sweep (cron/daily.js:121-122)
Q4  unit of work: cron_health rows
Q5-Q7: n/a                Q8  tenant: none
Q9  authority: none needed; both probes are unauthenticated
Q10 outside effects: none
Q11 order writes: none
Q12 failure goes to: health.js always answers 200 (health.js:185);
    _healthz answers 503 when any row is stale (healthz.js:74-75); the
    sweep logs a console.warn (_lib/heartbeat-check.js:98-110). No bell.
Q13 trail: none
Q14 health: maps _lib/heartbeat-check.js:18-50 (12 named keys plus
    default) and health.js:99-109 (4 named keys plus default) [V]
Q15 config: none
Q16 tests: api-heartbeat-check.test.js (8 tests);
    api-cron-logistics-daily.test.js:50-78
Q17 overlaps: the two maps (Duplicate and Divergent)
Q18 owner plan: #623 (stale-tick bell); O-3 constraint 4
notes / defects: a missing row is never stale (_lib/heartbeat-check.js:
    63-88; health.js:116-140), so a tick that never ran reads healthy
    (L1-D06). /api/_healthz is 503 most of the day (L1-D07).
```

```text
M-7  Crons with a route and no schedule            layer: L1
status on main: routable
live: not confirmed (owner query 1, rows inventory-positions,
    inventory-planning-weekly, inventory-exceptions-tick,
    conformal-calibration-weekly). No caller and no schedule in the repo [V].
Q1  job: inventory positions, weekly planning, inventory exceptions,
    conformal calibration (router.js:738-741); plus customer health score
    batch (router.js:1003; customers/health_score.js:224-228), new in the
    audit [V]
Q3  trigger: HTTP only. Headers claim otherwise: inventory-positions.js:7
    ("Vercel cron / cron-job.org"), customers/health_score.js:21-22
    ("invoked from /api/cron/daily") [V]
Q4  unit of work: inventory tables; customers.ai_health_* (071)
Q5  claim: none           Q6  retry: none            Q7  dedup: per handler
Q8  tenant: inventory crons loop tenants with inventory_planning_enabled
    (cron/inventory-positions.js:31-34; 085:55) [V]
Q9  authority: fail-open when CRON_SECRET is unset
    (cron/inventory-positions.js:20; cron/inventory-exceptions-tick.js:26;
    cron/inventory-planning-weekly.js:779;
    cron/conformal-calibration-weekly.js:140) [V] (L1-D23)
Q10 outside effects: inventory alerts (bell, queued email, voice row);
    health_score calls an LLM per customer (customers/health_score.js:30)
Q11 order writes: none
Q12 failure goes to: self heartbeats, default 10 min bound
Q13 trail: self heartbeats
Q14 health: four self-heartbeat names, none in either map, so 10 min [V]
Q15 config: inventory_planning_enabled (085:55)
Q16 tests: api-inventory-replan-tenant-scope.test.js (references the
    heartbeat; not read)
Q17 overlaps: M-45 (inventory notices)
Q18 owner plan: #534 schedules the planner only
notes / defects: L1-D23, L1-D25
```

```text
M-8  Generic status-flip drain (drainQueue)        layer: L1
status on main: wired, not scheduled
live: not confirmed (owner query 1 rows voice/process_actions,
    inbound/process_messages, inbound/email/draft_orders; query 2 backlog)
Q1  job: one loop for three producer queues (_lib/queue-runner.js:1-39) [V]
Q3  trigger: tick ALWAYS (cron/tick.js:177-179); manual 'approve' drain on
    each route
Q4  unit of work: inbound_emails status linked -> archived | failed
    (028:62-63; inbound/email/draft_orders.js:65, :73, :116);
    voice_call_actions completed false -> true (041:102;
    voice/process_actions.js:103-117); inbound_messages arrived -> linked |
    resolved | intake-extracted | failed (039:33-34;
    inbound/process_messages.js:69-132) [V]
Q5  claim: none. Select (_lib/queue-runner.js:66-75), process, then patch by
    id (:86, :108) with no status condition. Overlap creates duplicate DRAFT
    orders [I] (L1-D12)
Q6  retry: one try. Failure flips to 'failed', or completed=true with
    error (:96-108). No attempts, backoff or age limit [V]
Q7  dedup: draft_orders skips a row with linked_order_id (draft_orders.js:
    72-74); inbound_messages unique (tenant, channel, external_id) (039:39);
    voice none [V]
Q8  tenant: tenantId option (_lib/queue-runner.js:54-57, :67). Cron omits
    it. Manual: draft_orders (:142) and process_messages (:177) pass it;
    voice does not (voice/process_actions.js:150) [V] (L1-D01)
Q9  authority: service client; cron or 'approve'
Q10 outside effects: none
Q11 order writes: inserts DRAFT orders with no gate (draft_orders.js:75;
    voice/process_actions.js:54-69; inbound/process_messages.js:58) [V]
Q12 failure goes to: the row's error column; nobody is told
Q13 trail: audit_events direct inserts (draft_orders.js:78-84;
    voice/process_actions.js:119-125); actor not recorded
Q14 health: the caller's tick name, default 10 min
Q15 config: none
Q16 tests: none for queue-runner; api-inbound-chat-complaint.test.js covers
    one chat branch (not read in full)
Q17 overlaps: M-25 to M-28 (L3), M-20, M-21 (L2); parse, handle_replies,
    push loops do the same job without the helper
Q18 owner plan: none; O-3 constraint 5
notes / defects: L1-D01, L1-D12, L1-D26
```

```text
M-9  Shared ERP retry and sync runtime (15 connectors)   layer: L1
status on main: wired, not scheduled
live: not confirmed (owner query 1 rows <erp>/retry, <erp>/sync; query 2)
Q1  job: claim, replay, back off and give up for 15 retry queues; sync-run
    bookkeeping (_lib/erp-runner.js:1-18, :59-165, :240-283) [V]
Q3  trigger: each <erp>/retry.js cron branch, e.g. sap/retry.js:55-71, from
    tick ALWAYS (cron/tick.js:90-104); manual 'admin' (sap/retry.js:72-85)
Q4  unit of work: <erp>_retry_queue status pending | processing |
    succeeded | gave_up (e.g. 017:60; check widened by 059:100-129); writers
    _lib/erp-runner.js:50-54, :105-110, :115-120, :135-140, :146-151 [V]
Q5  claim: conditional UPDATE pending -> processing with claimed_at and
    claimed_by (_lib/erp-runner.js:49-57); stuck reset after 15 min, per
    tenant (:73-80) [V]
Q6  retry: max_attempts default 5 (:114); BACKOFF_MIN [1,5,15,60,240,720]
    indexed by the next attempt, so the first wait is 5 min (:23, :134);
    4xx gives up at once (:143-161); no age limit (:82-87) [V]
Q7  dedup: the claim stops a double replay of one row; nothing dedups two
    rows for one order [I: enqueue side not read]
Q8  tenant: selects filter tenant_id (:78, :83); the claim is by id after a
    tenant-filtered select (:54) [V]
Q9  authority: service client; cron or 'admin'
Q10 outside effects: ERP POST per row (sap/retry.js:16-20) [V]
Q11 order writes: orders.result.external_systems.<erp> on success
    (sap/retry.js:26-37), no gate [V]
Q12 failure goes to: admin bell on give-up (_lib/erp-runner.js:123-131,
    :152-160) [V]
Q13 trail: queue row columns; recordAudit only on the manual path
    (sap/retry.js:39-41) [V]
Q14 health: <erp>/retry default 10 min; <erp>/sync 75 min for 6 names only
    (_lib/heartbeat-check.js:24-29) [V]
Q15 config: per-ERP credentials on tenant_settings (sap/retry.js:61-64)
Q16 tests: none for drainRetryQueue or claimRow; requireApprovedOrder is
    imported by api-blocking-findings.test.js [V]
Q17 overlaps: M-10 (two private copies)
Q18 owner plan: none; O-3 constraint 5 (best base for the contract)
notes / defects: Acumatica uses prefix "acu" (acumatica/retry.js:57) but
    059:77-81 lists "acumatica", so acu_retry_queue (019:55-69) has no claim
    columns and no 'processing' value; every claim fails and nothing drains
    (L1-D04). Stuck reset runs only for tenants with a due pending row
    (sap/retry.js:56-57) (L1-D19). Backoff index (L1-D20).
```

```text
M-10 Tally and NetSuite retry queues (own copies)  layer: L1
status on main: wired, not scheduled
live: not confirmed (owner query 1 rows tally/retry, netsuite/retry; query 2)
Q1  job: replay failed Tally voucher and NetSuite SO pushes
    (tally/retry.js:1-16; netsuite/retry.js:1-15) [V]
Q3  trigger: tick ALWAYS (cron/tick.js:88-89); manual 'admin'
    (tally/retry.js:162-169; netsuite/retry.js:179-188)
Q4  unit of work: tally_retry_queue pending | succeeded | gave_up (016:110),
    widened with 'processing' (059:100-129); netsuite_retry_queue (015:77)
Q5  claim: none. Select then replay (tally/retry.js:124-136;
    netsuite/retry.js:136-148). 059:84-88 added claimed_at and claimed_by to
    both tables; nothing reads them [V] (D-3, L1-D13)
Q6  retry: own backoff copies (tally/retry.js:26, :35-48;
    netsuite/retry.js:25, :88-101); max_attempts 5 (016:106); a
    non-recoverable status gives up at once (tally/retry.js:112-114;
    netsuite/retry.js:81-84); no age limit [V]
Q7  dedup: none at drain time
Q8  tenant: selects filter tenant (tally/retry.js:125; netsuite/retry.js:
    137); the Tally order update is by id only (tally/retry.js:96-100) [V]
Q9  authority: Mode B gate per tenant (tally/retry.js:121-123); 'admin' for
    the manual path. NetSuite has no Mode B check [V]
Q10 outside effects: Tally bridge push (tally/retry.js:73); NetSuite REST
    POST (netsuite/retry.js:34-38) [V]
Q11 order writes: Tally success sets orders.status EXPORTED_TO_TALLY and
    tally_status (tally/retry.js:96-100), no transition rule, no approval
    re-check. NetSuite writes result.external_systems.netsuite on success and
    give-up (netsuite/retry.js:53-69, :111-127) [V]
Q12 failure goes to: nobody. No notifyAdmins in either file [V] (D-2)
Q13 trail: recordAudit on the manual path only (tally/retry.js:102-109;
    netsuite/retry.js:71-78) [V]
Q14 health: tally/retry, netsuite/retry default 10 min
Q15 config: Tally company bridge settings; so_processing_mode (221:27)
Q16 tests: api-tally-mode-b.test.js:113-150 (manual path, Mode B);
    api-so-processing-mode.test.js. None for NetSuite, none for overlap.
Q17 overlaps: M-9 (Divergent); M-35, M-36 (other Tally push paths, L3)
Q18 owner plan: #631 (guard), #632 (reconciler re-queue); O-3 constraint 5
notes / defects: L1-D13, L1-D14
```

```text
M-11 Background extraction jobs and the run reaper   layer: L1
status on main: jobs wired, not scheduled; reaper wired (daily)
live: not confirmed (owner query 1 rows extraction/jobs,
    docai/extraction_reaper; query 2 extraction_jobs)
Q1  job: advance one large-PDF extraction step per tick, then write lines
    into the order (cron/extraction_jobs.js:1-27, :782-824, :923-983); the
    reaper fails extraction_runs stuck at 'running' (cron/extraction_reaper.js
    :1-14; _lib/docai/reap-stale-runs.js:21-49) [V]
Q3  trigger: tick ALWAYS (cron/tick.js:159); route /cron/extraction_jobs,
    cron only (router.js:737; cron/extraction_jobs.js:924-927). Reaper:
    daily (cron/daily.js:84) and on read (orders/pipeline_state.js:90) [V]
Q4  unit of work: extraction_jobs queued | profiling | chunking | extracting
    | merging | completed | failed | cancelled (117:51-52); extraction_runs
    running | ok | low_confidence | failed (029:35) [V]
Q5  claim: lease by conditional UPDATE where lease_until is null or past
    (cron/extraction_jobs.js:142-155); TTL 30 s (:114), renewed per step
    (:312, :411, :426, :566); picks the oldest 3 (:117, :128-138) [V]
Q6  retry: chunk attempts max 3 (:115, :533-534); the job fails on a thrown
    step (:950-963) or when all chunks fail (:654-664). Job attempts are
    counted (:145) and never capped. No backoff, no age limit. Reaper bound
    5 min (reap-stale-runs.js:19, :28-41) [V] (L1-D11)
Q7  dedup: one in-flight job per order (202:17-19) [V]
Q8  tenant: the pick is tenant-agnostic (cron/extraction_jobs.js:125-138);
    the order read and write filter tenant (:785, :810) [V]
Q9  authority: service client; CRON_SECRET only
Q10 outside effects: LLM calls through dispatchExtract with tenant settings
    (:35, :63-76) [V]
Q11 order writes: overwrites result.salesOrder.lineItems and payload_hash,
    may clear approval (:787-810). No status check, no transition rule, no
    write gate [V]
Q12 failure goes to: job status 'failed'; processing_events
    docai_extract_failed (:663, :820, :960); audit row for all-chunks-failed
    (:664). No bell [V]
Q13 trail: processing_events per step (:157-170)
Q14 health: extraction/jobs default 10 min; a 500 reads as ok (L1-D05).
    docai/extraction_reaper default 10 min, stale 23 h 50 min a day [V]
Q15 config: DOCAI_MAX_ROW_WINDOWS (:240); tenant docai settings
Q16 tests: api-extraction-jobs-{continuation,density,kind,settings}.test.js;
    api-docai-run-deadline.test.js:88-137 (reaper). None for lease contention
    or job attempts [V]
Q17 overlaps: M-30 auto_ocr (also extracts, other documents)
Q18 owner plan: #566 (default handler), #625 (writeback guard), C-2
notes / defects: L1-D05, L1-D11
```

---

## 2. Tick and daily handler table

"hc" is the bound in `_lib/heartbeat-check.js` (used by `/api/_healthz` and
the daily sweep). "h" is the bound in `health.js` (footer). "def" is the
10-minute default (`_lib/heartbeat-check.js:49`; `health.js:108`). Budget is
from `_lib/cron-mux.js:75-105`. Effects marked "per #566" were not re-read.

| Handler | Group | hc | h | Self heartbeat | Budget | External side effects | Backlog risk |
|---|---|---|---|---|---|---|---|
| push/send | ALWAYS | def | def | no | 20 s | Web push to staff (push/send.js:48-50) | Low. Only producer is the manual POST (push/send.js:85-93). One try, then 'failed' (:58-63) |
| extraction/jobs | ALWAYS | def | def | no | 20 s | LLM spend (cron/extraction_jobs.js:35); writes order lines (:808-810) | Every non-terminal job, oldest first (:128-135). Overwrites lines whatever the order status |
| prospecting/run | ALWAYS | def | def | no | 20 s | Marketing email (per #566, M-23) | Every active campaign (prospecting/run.js:138-145) |
| inbound/email/parse | ALWAYS | def | def | no | 20 s | LLM classifier per email (inbound/email/parse.js:65) | Every 'received' email, 25 per call (:119-124) |
| inbound/email/persist_attachments | ALWAYS | def | def | no | 20 s | Storage upload and scan (inbound/email/_lib/persist-attachments.js:52-160) | Starves after 80 rows (persist_attachments.js:51-57). No attempt cap |
| inbound/email/draft_orders | ALWAYS | def | def | no | 20 s | Inserts DRAFT orders (draft_orders.js:75) | Every 'linked' email becomes an order |
| voice/process_actions | ALWAYS | def | def | no | 20 s | Inserts DRAFT orders (voice/process_actions.js:54-69) | Every open action. Manual drain crosses tenants (:150) |
| inbound/process_messages | ALWAYS | def | def | no | 20 s | Inserts DRAFT orders (inbound/process_messages.js:58) | Every 'arrived' message. PO regex over-matches (_lib/chat-intent.js:79) |
| inbound/auto_ocr | ALWAYS | def | def | no | 20 s | LLM extraction (inbound/auto_ocr.js:133-147) | Starves after 20 documents (:43-62, :104) |
| agents/handle_replies | ALWAYS | def | def | no | 20 s | Pauses AR goals 14 days (agents/handle_replies.js:67-90) | Every unhandled actionable email. agent_steps row has no tenant_id (:41, :75) |
| logistics/monitor | ALWAYS | def | def | yes: logistics-monitor-tick, hc 30 h (_lib/heartbeat-check.js:48), h def | 30 s | Bell and queued email (cron/logistics-monitor-tick.js:47-49) | Flag off by default (206:93). Same code runs daily |
| netsuite, tally, sap, d365, acumatica, p21, eclipse, sxe, sage_x3, ifs, oracle_fusion, ramco, jde, plex, jobboss, oracle_ebs, proalpha /retry (17) | ALWAYS | def | def | no | 15 to 30 s (tally 30, sap/ifs/jde/oracle_ebs 25, p21/eclipse/sxe/sage_x3 15, rest 20) | ERP writes (sap/retry.js:16-20; tally/retry.js:73; netsuite/retry.js:34-38). Tally sets order status (tally/retry.js:96-100) | No age limit (_lib/erp-runner.js:82-87; tally/retry.js:124-129). Stale pushes create duplicate SOs. Acumatica never drains (L1-D04) |
| tally, netsuite, sap, d365, acumatica, p21 /sync (6) | 30-min | 75 min (:24-29) | def | no | 20 to 30 s | ERP reads. tally/sync adds a receipt to invoices.paid_amount with no applied check (tally/sync.js:151-166) | First run pulls history |
| eclipse, sxe, sage_x3, ifs, oracle_fusion, ramco, jde, plex, jobboss, oracle_ebs, proalpha /sync (11) | 30-min | def | def | no | 15 to 25 s | ERP reads | Rows read stale 20 of every 30 min |
| tally/reconcile | 30-min | def | def | no | 30 s | Auto-fix re-queues vouchers (per #566, M-36) | Manual drain crosses tenants (cron/tally-reconcile.js:88-90) |
| plm/sync | 30-min | def | def | no | 20 s | PLM reads | n/a |
| agents/run | hourly | 2 h (:21) | 2 h (health.js:106) | no | 20 s | Customer email through the reaper (agents/run.js:276-314); bell on escalation (:120-127); calls (per plan M-12) | Sends up to 100 oldest queued rows per touched tenant, no age limit (:277-283) |
| drift-meter | hourly | def | def | no | 20 s | Stripe or Razorpay billing (cron/drift-meter.js:88-99) | Every unreported meter row (:29-35) |
| eval/agent_eval | minute-5 | 2 h (:22) | 2 h | no | 20 s | None found (per #566) | Low |
| eval/rescore | minute-5 | def | def | no | 20 s | None without EVAL_GOLDEN_TENANT_ID (cron/tick.js:208-210) | Low |
| cron/tick (parent) | every call | 10 min | 10 min | n/a | n/a | none | n/a |
| analytics/refresh | daily | def | def | no | 20 s | DB only | Low |
| fx/cron | daily | def | def | no | 20 s | External FX fetch (fx/cron.js, safeFetch) | Low |
| service/amc_cron | daily | def | def | no | 20 s | Creates service_visits (service/amc_cron.js:74-90) | Due AMC rows |
| rlhf/aggregate | daily | def | def | no | 20 s | DB only | Low |
| quotes/expire | daily | def | def | no | 20 s | Updates quote status (quotes/expire.js:37) | Low |
| billing/recurring | daily | def | def | no | 20 s | Creates invoices (billing/recurring_cron.js:84) | Due schedules |
| eway_bills/expire | daily | def | def | no | 20 s | DB only | Low |
| catalog/embed | daily | def | def | no | 20 s | None today: GET runs the status branch (catalog/embed.js:122-124) | Never runs (L1-D10) |
| forecast/snapshot | daily | def | def | no | 20 s | DB only (POST, cron/daily.js:76) | Low |
| drift-report | daily | def | def | no | 20 s | Queues email (cron/drift-report.js:111-122); only M-42 drains queued email | Monthly |
| eval/quality_alert | daily | def | def | no | 20 s | Admin bell (notifyAdmins in cron/eval_quality_alert.js) | Low |
| docai/extraction_reaper | daily | def | def | no | 20 s | Fails stuck runs (_lib/docai/reap-stale-runs.js:31-41) | Low |
| logistics/monitor_daily | daily | 30 h (:47) | def | yes: logistics-monitor-tick | 30 s | As logistics/monitor | As above |
| eval/replay (only with EVAL_REPLAY_ENABLED) | daily | def | def | no | 55 s (cron/daily.js:95) | LLM spend, bell (eval/replay.js) | Cost-bounded by case cap |
| cron/daily (parent) | daily | 30 h | 30 h | n/a | n/a | none | n/a |

**Counts.** Tick: 11 + 17 ALWAYS, 19 at 30 minutes, 2 hourly, 2 at minute 5:
51. This matches #566's count. #566's table rows match the code that I read.
Its line references drift by a few lines at this base: for example it cites
the order writeback as `cron/extraction_jobs.js:777-795`; at `931eb143` the
read is :785 and the write is :808-810.

**Routable-only crons (5).** `/cron/inventory-positions` (router.js:738),
`/cron/inventory-planning-weekly` (:739), `/cron/inventory-exceptions-tick`
(:740), `/cron/conformal-calibration-weekly` (:741), and
`/customers/health_score` cron branch (router.js:1003;
customers/health_score.js:224-228). The last is new in the audit.

**Double-registered handlers.** One on main: the logistics monitor, as
`logistics/monitor` in tick (cron/tick.js:187) and `logistics/monitor_daily`
in daily (cron/daily.js:91). Detection is safe to repeat (unique open
fingerprint, 206:80-81). Notices use read-then-stamp
(_lib/logistics/notifications.js:100-153), so a tick at 02:30 and the daily
run at 02:30 can both notify [I] (L1-D28). Open PRs add `email/sweep` plus
`email/sweep_daily` (#640) and put the planner into daily (#534). Every
scheduled drain also has its own manual route (section 10, N-2).

---

## 3. Queue contract table

| Shape | Table | Claim | Lease or stuck reset | Attempts cap | Backoff | Give-up status | Age limit | Reaper | Heartbeat | Tenant fairness | Notice on give-up |
|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) drainQueue | inbound_emails (028:62), voice_call_actions (041:102), inbound_messages (039:33) | none (_lib/queue-runner.js:66-86) | none | 1 (:96-108) | none | 'failed' or completed=true with error (:99-107) | none | none | caller name | none: global oldest, limit 25 (:73) | none |
| (b) erp-runner | 15 <erp>_retry_queue | conditional UPDATE to 'processing' (_lib/erp-runner.js:49-57) | 15 min reset, per tenant (:73-80) | max_attempts, default 5 (:114) | 5, 15, 60, 240 min in practice (:23, :134) | 'gave_up' (:115, :147) | none (:82-87) | the reset | <erp>/retry | per tenant 50, tenants serial (sap/retry.js:60-69) | admin bell (:123-131, :152-160) |
| (c) Tally copy | tally_retry_queue (016:96) | none (tally/retry.js:124-136) | none; 059 columns unused | 5 (016:106; tally/retry.js:37) | own copy (:26, :40) | 'gave_up', voucher 'failed' (:50-62) | none | none | tally/retry | per tenant 50, serial (:149-158) | none (D-2) |
| (d) NetSuite copy | netsuite_retry_queue (015:77) | none (netsuite/retry.js:136-148) | none | 5 (:90) | own copy (:25, :93) | 'gave_up', order result gave_up (:103-127) | none | none | netsuite/retry | per tenant 50, serial (:170-174) | none |
| (e) extraction_jobs lease | extraction_jobs (117:34) | conditional UPDATE on lease_until (cron/extraction_jobs.js:142-155) | 30 s lease (:114) | chunk 3 (:115); job none (:145) | next tick | 'failed' (:954-959) | none | lease expiry; reaper covers extraction_runs only | extraction/jobs | none: global oldest 3 (:117, :128-135) | processing_events plus audit (:663-664); no bell |
| (f) agent_goals schedule | agent_goals (011:27) | none (agents/run.js:330-336) | none | none; a thrown dispatch keeps next_run_at (:350-356) | cooldown_hours, default 24 (:66); noop sleep (:70-71) | handler give_up -> 'failed' (:59) | due_at, read by some handlers (agents/_handlers/ar_collect.js:190) | none | agents/run | none: global oldest, limit 50 (:329-336) | escalate -> bell (:120-127) |
| (g) comms reaper | communications (005:22; status 189:101-103) | none (agents/run.js:277-307) | none | none | next hourly run | 'failed' only for no recipient (:295-303) | none | none | none of its own | only tenants with a due goal (:361-366); 100 each | none |
| (h) parse loop | inbound_emails | none (inbound/email/parse.js:119-128) | none | 1 (:110-115) | none | 'failed' | none | none | inbound/email/parse | none: global 25 | none |
| (i) handle_replies loop | inbound_emails marker agent_reply_handled_at (070:10-12) | none (agents/handle_replies.js:127-146) | none | 1: an error is marked handled (:140-146) | none | agent_reply_action 'error' | none | none | agents/handle_replies | none: global 50 (:31) | none |
| (j) push loop | push_notifications (021:37) | none (push/send.js:20-23) | none | 1 (:58-63) | none | 'failed' | none | none | push/send | none: global 50 | none |
| (k) window scan | inbound_emails attachments JSON (persist); documents (auto_ocr) | none | none | none: bytes kept for retry (persist-attachments.js:187-191); auto_ocr counts a failed run as done (auto_ocr.js:73) | next tick | none | none | none | caller name | persist: round robin (persist_attachments.js:58-76); auto_ocr: none | none |
| (l) detect-and-notify scan | logistics_exceptions (206:50), inventory_exceptions (085:356) | none | none | n/a | n/a | status open -> resolved by detector | n/a | n/a | logistics-monitor-tick, inventory-exceptions-tick | per enabled tenant, serial | bell and email per row |
| (m) ERP sync cursor | <erp>_sync_state, <erp>_sync_runs | none | none | n/a | next 30 min | sync_state 'error' (_lib/erp-runner.js:276-282) | n/a | none | <erp>/sync | per tenant | none |
| (n) run reaper | extraction_runs (029:20) | n/a | 5 min bound (reap-stale-runs.js:19) | n/a | n/a | 'failed', 'timed_out' (:33-36) | n/a | is the reaper | docai/extraction_reaper | all tenants | none |
| open PR: email/sync (#635) | mailbox connections (267) | conditional lease on sync_lease_until (#635 email/sync.js:+52-55) | lease | consecutive_failures; 'reauth_required' on auth | interval x 2^min(failures,4) (#635 _lib/mail/sync.js:+77) | 'reauth_required' or paused | n/a | lease expiry | email/sync | per connection by next_sync_at | alert at a failure threshold (#635 sync.js "failing") |
| open PR: email/sweep (#640) | email_action_notices (270) | insert as claim, unique key, 23505 skips (#640 escalation.js:+115-118) | none for 'claimed' | 3 | next sweep | 'failed' after 3 | n/a | none | email/sweep, email/sweep_daily | per enabled tenant | the notice is the output |

**Count.** On main, shapes (a) to (k) are 11 queue drains with their own
claim and retry rules, plus 2 scan shapes and 1 reaper. With #635 and #640:
13 drains. H-7 said "at least six"; the real number is larger.

---

## 4. Budget check

Budgets: `_lib/cron-mux.js:75-98`. Function limit: 60 s
(`vercel.json:7-11`, every /api path goes through dispatch, `vercel.json:40`).

| Group | Handlers | Sum of budgets | Wall bound (max, parallel) |
|---|---|---|---|
| ALWAYS | 28 | 580 s (10 x 20 + logistics 30; retries 350) | 30 s (tally/retry, logistics/monitor) |
| 30-min | 19 | 400 s | 30 s (tally/sync, tally/reconcile) |
| hourly | 2 | 40 s | 20 s (agents/run and drift-meter use the default) |
| minute-5 | 2 | 40 s | 20 s |
| daily | 13 (+1) | 270 s (+55 s) | 30 s, or 55 s with eval/replay |

Groups run one after another (cron/tick.js:190, :194, :199, :213) [V].
So the worst minutes are:

- **Minute 0:** 30 + 30 + 20 = 80 s of group bounds, then 1 + 49 sequential
  heartbeat upserts (cron/tick.js:229, :238-244), each one or two round
  trips. Over 60 s when the long handlers use their budget [I]. Vercel then
  kills the function: the hourly group may not start, and the `cron/tick`
  row and loop rows are not written (L1-D08).
- **Minute 30:** 30 + 30 = 60 s plus the heartbeat loop. Over 60 s in the
  same case [I].
- **Minute 5:** 30 + 20 = 50 s plus the loop. Fits with little room [I].
- **Other minutes:** 30 s plus 28 loop writes. Fits.
- **Daily:** 30 s plus 14 loop writes plus the probe. With eval/replay,
  55 s plus the tail, close to the limit [I]. #534 adds a 40 s planner.

A timeout does not stop the handler (_lib/cron-mux.js:107-112). Abandoned
work keeps running beside the next group until the function returns [V].
Pool pressure from 28 parallel handlers is not confirmed.

---

## 5. Heartbeat writes per handler run

| Case | Writes for its own name | Other rows | Evidence |
|---|---|---|---|
| Tick or daily handler, no self write | 2: inline (not awaited) and result loop | none | _lib/cron-mux.js:177-187; cron/tick.js:238-244; cron/daily.js:107-113 [V] |
| logistics/monitor (tick) | 2 | +1 logistics-monitor-tick | + cron/logistics-monitor-tick.js:60-71 [V] |
| logistics/monitor_daily | 2 | +1 logistics-monitor-tick | same [V] |
| cron/tick, cron/daily | 1 (or 1 in the catch) | none | cron/tick.js:229, :260; cron/daily.js:102, :136 [V] |
| Routable inventory crons | 1 self write | none | section 1, M-5 Q3 [V] |

**Does one failure count once?** Usually no. Each failing write reads
`consecutive_failures`, adds 1 and upserts (_lib/cron-mux.js:233-238). The
inline write is fire and forget (:178, `.catch` only), and the loop write
runs after all groups end (cron/tick.js:238). If the inline write lands
first, the loop reads N+1 and writes N+2: one failure counts twice. If both
read before either writes, it counts once [I]. For the ALWAYS group the
inline write has the whole run to land, so "twice" is the normal case [I].
The loop write also replaces the inline status 'timeout' with 'error' and
drops `budget_ms` and `timed_out` from metadata (cron/tick.js:239-243) [V].
Status 'partial' counts as a failure (_lib/cron-mux.js:223), so a tick with
one failed handler raises `cron/tick` failures too [V]. Tests cannot see any
of this: the inline write is off under VITEST (:177) [V].

---

## 6. Owner SQL script

Moved to Appendix A of `docs/SO_AGENT_INFRA_AUDIT.md`.

---

## 7. Signal verdicts

**H-1. Partly.** Repo side confirmed [V]: `vercel.json:12-17` schedules only
daily; no workflow and no `pg_cron` calls tick; `docs/CRONS.md:8-14` relies
on a hand-made cron-job.org job. Live side not confirmed: owner query 1a/1b.
Two more facts make H-1 hard to see: a tick that never ran has no row, and
a missing row reads healthy in both probes (_lib/heartbeat-check.js:63-88;
health.js:116-140) (L1-D06). If H-1 holds, every ALWAYS, 30-minute and
hourly handler is "wired, not scheduled".

**H-2. Confirmed, and wider.** Routable-only: five, not four. The fifth is
`/customers/health_score` (router.js:1003), whose header falsely says daily
calls it (customers/health_score.js:21-22). Double-registered on main: one
handler, the logistics monitor (cron/tick.js:187; cron/daily.js:91). The
double path is safe for detection (206:80-81) and can double-notify when
both run at 02:30 [I] (L1-D28). Open PRs add `email/sweep` on both paths
(#640).

**H-3. Confirmed.** `health.js:99-109` has 4 named keys and a default.
`_lib/heartbeat-check.js:18-50` has 12 named keys and a default. With a
live tick, these rows fall to the 10-minute default although they run less
often: 11 of 17 ERP syncs, `tally/reconcile`, `plm/sync`, `drift-meter`,
`eval/rescore`, and all 12 daily rows other than `logistics/monitor_daily`
[V]. `/api/_healthz` answers 503 when any row is stale (healthz.js:74-75),
so it is 503 for all but about 10 minutes a day after the daily run [I].
`health.js` adds the logistics daily rows and the 6 syncs to the stale set
too, but it always answers 200 (health.js:185).

**H-4. Confirmed.** Two writes per handler run, three for the logistics
monitor (section 5). One failure usually adds 2 to `consecutive_failures`
[I, from _lib/cron-mux.js:178, :233-238 and cron/tick.js:238].

**H-7. Confirmed, and wider.** 11 queue shapes on main (section 3, rows a to
k), 13 with #635 and #640. Only shape (b) has a claim, a stuck reset,
backoff, a cap and a notice. Shape (e) has a lease and a chunk cap.

**D-3. Confirmed.** `tally/retry.js:124-136` selects, then replays, with no
conditional update. 059:77-95 gave `tally_retry_queue` the claim columns and
059:100-129 allowed 'processing'; no code uses them [V]. The same holds for
NetSuite (netsuite/retry.js:136-148) [V]. Overlap needs a manual drain
beside the cron, or two triggers (#566 warns "Keep one trigger"). #631 does
not add a claim.

---

## 8. Open PR overlay

**#566 (tick scheduler).** M-2: handlers move into a `TICK_HANDLERS`
registry with a cadence each; `CRON_TICK_HANDLERS` unset runs only
`extraction/jobs`. Groups still run one after another by cadence (#566
tick.js, `for (const cadence of CADENCE_ORDER)` then `await runGroup`), and
the exact-minute rule stays (`isTickHandlerDue`), so L1-D08 and L1-D09
stay. GitHub schedules start late, so the 30-minute, hourly and minute-5
groups will seldom run (#566 body says so). M-4: the `statusCode` accessor
fixes L1-D05. M-5: the double write stays; a gated handler writes no
heartbeat, so a row from an earlier trigger goes stale on the 10-minute
default and holds `/api/_healthz` at 503 [I]. M-6: no map change. M-11:
becomes the one live drain once the owner adds the secrets. Conflict with
#623: with the default allow-list the tick is fresh, so the stale-tick bell
stays quiet, while every other drain still waits. Conflict with #635 and
#640: both edit the old `alwaysGroup` array that #566 replaces; the names
must move into `TICK_HANDLERS`.

**#534 (planner clock).** M-3 gains `inventory/planning_weekly` on one UTC
weekday, budget 40 s. M-6 gains two 8-day bounds in
`_lib/heartbeat-check.js` only; `health.js` unchanged. M-7 loses one
routable-only entry (the route stays). Daily wall bound rises from 30 s to
40 s, or stays 55 s with replay.

**#623 (heartbeat and bellStaleTick parts).** M-6: the daily sweep calls
`bellStaleTick`, which rings each tenant's admin bell once a day when
`cron/tick` is stale, or has no row while `cron/daily` has one. This fixes
L1-D06 for the bell only; `/api/_healthz` and `health.js` still read a
missing row as fresh. The loop calls `notifyAdmins` once per tenant, up to
1000, after the fan-out and inside the 60 s limit [I: tail cost not
measured].

**#625 (extraction_jobs).** M-11: each step update adds
`.eq("status", job.status)`, so a cancelled job is not advanced. The
writeback writes lines only to a DRAFT order; other statuses get a
`LINES_CHANGED` blocker, and the write is a compare-and-set on
`orders.updated_at`. Q11 changes from "no check" to "status check and CAS".
No job attempts cap (L1-D11 stays). No heartbeat change.

**#631 (tally/retry part).** M-10: a skip guard before the push (order
missing, cancelled, unapproved, or hash changed), stored as `gave_up` with
`skipped::`; the order update gains a tenant filter. No claim (D-3 stays),
no bell (D-2 stays). Skips and real give-ups share one status.

**#635 (email/sync registration).** M-2 ALWAYS gains `email/sync` (default
20 s, default 10-minute bound). It brings shape "lease plus next_sync_at
plus failure backoff" (#635 email/sync.js:+52-55; _lib/mail/sync.js:+77),
the best-designed drain in the repo. Base branch is #619, not main.

**#640 (email/sweep registration).** M-2 ALWAYS gains `email/sweep`; M-3
gains `email/sweep_daily`; `_lib/heartbeat-check.js` gains a 30 h bound for
the daily row, `health.js` does not. A second double-registered handler. New
shape "insert as claim" on `email_action_notices` (270). Defect in the PR: a
notice left at 'claimed' after a crash is skipped for ever, because the
sweep retries only 'failed' rows (#640 _lib/email-accountability/
escalation.js:+109) and nothing reaps 'claimed'.

---

## 9. O-2 rows

| M | Schedule | Claim and lease | Retry and give up | Dedup | Decide (policy) | Act on an order | Send outside | Notify a person | Track human work | Escalate | Record the trail | Report health |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M-1 | vercel.json:12-17 daily | | | | | | | | | | | cron/daily row |
| M-2 | cron/tick.js:143-149 exact minute, groups in sequence :190-217 | | | | minute gates :144-149 | via handlers | via handlers | | | | | cron/tick.js:229-244 |
| M-3 | cron/daily.js:67-97 | | | | EVAL_REPLAY_ENABLED :94-96 | | via handlers | sweep logs only, heartbeat-check.js:98-110 | | | | cron/daily.js:102-122 |
| M-4 | parallel group cron-mux.js:192-194 | | timeout, no cancel :107-145 | | budget by prefix :75-105 | | | | | | | inline write :177-187 |
| M-5 | | upsert on PK 066:19 | | PK worker | | | | | | | cron_health 066:18-26 | cron-mux.js:220-243 |
| M-6 | | | | | two maps heartbeat-check.js:18-50, health.js:99-109 | | | console only :98-110 | | none on main | | healthz.js:72-75; health.js:185 |
| M-7 | none, router.js:738-741 | | | | tenant flag 085:55 | | inventory notices | inventory bell | | | self heartbeats | default bound |
| M-8 | tick ALWAYS cron/tick.js:177-179 | none queue-runner.js:66-86 | 1 try :96-108 | draft_orders.js:72-74 | | DRAFT inserts draft_orders.js:75 | | | | | audit insert draft_orders.js:78-84 | caller row |
| M-9 | tick ALWAYS cron/tick.js:90-104 | claim erp-runner.js:49-57; reset :73-80 | cap :114, backoff :23/:134, gave_up :115 | claim per row | isRecoverable :168-169 | result.external_systems sap/retry.js:26-37 | ERP POST sap/retry.js:16-20 | bell :123-131 | | | queue row; audit manual only sap/retry.js:39-41 | <erp>/retry |
| M-10 | tick ALWAYS cron/tick.js:88-89 | none tally/retry.js:124-136 | own copy :26/:35-63 | | Mode B gate :121-123 | status EXPORTED_TO_TALLY :96-100; netsuite result :53-69 | tally/retry.js:73; netsuite/retry.js:34 | none | | | audit manual only :102-109 | tally/retry, netsuite/retry |
| M-11 | tick ALWAYS cron/tick.js:159; reaper daily :84 | lease extraction_jobs.js:142-155 | chunk cap :115/:534; fail :954-959; reaper reap-stale-runs.js:31-41 | 202:17-19 | kind gate :768-782 | lines, hash, approval :787-810 | LLM :35 | | review queue (M-31, L3) | | processing_events :157-170, audit :664 | extraction/jobs (500 masked) |

**Classes in this layer.** Schedule: M-1 and M-2 are Divergent (two
triggers, one in repo). Claim: M-9 and M-11 claim; M-8 and M-10 do not:
Divergent. Retry: M-9 and M-10 are Duplicate logic with Divergent notice
rules. Report health: M-6 holds two maps, Duplicate and Divergent. Double
fire: logistics monitor (M-2 and M-3). Dead: M-7 (no schedule),
catalog/embed in M-3 (L1-D10), the Acumatica queue in M-9 (L1-D04). Gap:
escalate (no L1 mechanism tells a person that the clock stopped, on main).

---

## 10. New mechanisms in this layer (not in section 4)

| Id | Mechanism | Evidence | Note |
|---|---|---|---|
| N-1 | Customer health score batch cron | router.js:1003; customers/health_score.js:224-228 | New in the audit. Routable only; LLM per customer; header claims a daily caller that does not exist |
| N-2 | Manual drain endpoints, a second trigger for every drain | e.g. inbound/email/parse.js:146-148; voice/process_actions.js:148-150; tally/retry.js:162-169; cron/tally-reconcile.js:88-90 | New in the audit. 'approve' or 'admin' runs the same drain; five of them ignore the tenant (L1-D01) |
| N-3 | Reap on read | orders/pipeline_state.js:90 | New in the audit. A second trigger for the M-11 reaper, tenant-scoped |
| N-4 | Window-scan drain shape | inbound/email/persist_attachments.js:51-76; inbound/auto_ocr.js:43-62 | New in the audit as a shape. Both starve (L1-D02, L1-D03) |
| N-5 | Detect-and-notify scan as a drain | cron/logistics-monitor-tick.js:39-58; cron/inventory-exceptions-tick.js:37-53 | Listed as M-44 and M-45 in L4; new here as an L1 shape with self heartbeats |
| N-6 | Abandon-not-cancel timeout | _lib/cron-mux.js:107-121 | Part of M-4, not named in the plan; abandoned work races the next group |
| N-7 | Self heartbeats under other names | section 1, M-5 Q3 | Part of M-5; five names, four in no map |

---

## 11. Defects found, not fixed

| Id | Where | Failure scenario | Severity | Suggested fix |
|---|---|---|---|---|
| L1-D01 | voice/process_actions.js:150; agents/handle_replies.js:181; inbound/email/parse.js:148; inbound/email/persist_attachments.js:128; cron/tally-reconcile.js:88-90 | One tenant's approver runs a drain over every tenant: other tenants' orders created, LLM spend charged, Tally auto-fixes re-queued. Extends D-1 from 2 to 5 | high | Pass ctx.tenantId into each drain; drainQueue already takes tenantId (_lib/queue-runner.js:54-57) |
| L1-D02 | inbound/email/persist_attachments.js:51-57 | The drain reads the oldest 80 emails of any state. After 80 rows exist, new inline attachments are never persisted, so draft orders get no PO document and auto_ocr gets nothing. Bytes stay inline for ever | high (once the tick runs) | Select only rows that still carry bytes, in SQL (an RPC or a has_inline_bytes column) |
| L1-D03 | inbound/auto_ocr.js:43-62, :104 | The drain reads the oldest 20 clean order-linked documents of any source; extracted ones stay in the window and are skipped. After 20, no new document is OCR'd | high (once the tick runs) | Anti-join extraction_runs in SQL, or mark documents when OCR is attempted |
| L1-D04 | acumatica/retry.js:57; 059:77-81; 019:55-69; _lib/erp-runner.js:49-56 | Prefix "acu" is not in 059's list, so acu_retry_queue has no claimed_at and no 'processing'. Every claim errors, returns null, reads "already_claimed". No replay, no give-up, no bell | medium | Migration 271: add the columns and the check to acu_retry_queue; make claimRow report r.error |
| L1-D05 | _lib/cron-mux.js:39-62; agents/run.js:375-377; cron/extraction_jobs.js:925-926, :979-981 | A Node-style 500 is recorded as 200, so cron_health says ok for a crashed agents/run or extraction/jobs | medium | Merge #566's statusCode accessor |
| L1-D06 | _lib/heartbeat-check.js:63-88; health.js:116-140 | A worker that never ran has no row and reads fresh, so a dead tick (H-1) is invisible to /api/_healthz | medium | Check expected names from one registry; a missing expected row is stale |
| L1-D07 | health.js:99-109; _lib/heartbeat-check.js:18-50 | Most rows fall to the 10-minute default; /api/_healthz is 503 nearly all day; on-call learns to ignore it | medium | One map, bound derived from each handler's cadence |
| L1-D08 | cron/tick.js:190-217; vercel.json:9 | Minute 0 group bounds sum to 80 s; Vercel kills the call; agents/run may not run; tick heartbeats lost | medium | Run due handlers in one parallel group, or give the hourly group its own call |
| L1-D09 | cron/tick.js:143-149; _lib/cron-mux.js:203-207 | A late or offset trigger skips the 30-minute, hourly and minute-5 groups, maybe for ever | medium | Run a handler when its last run is older than its cadence (cron_health.last_run_at) |
| L1-D10 | cron/daily.js:75; catalog/embed.js:122-124, :142-143 | The daily entry has no method, so GET runs the user status branch, fails auth, and the embed indexer never runs | medium | Add method: "POST" to the daily entry |
| L1-D11 | cron/extraction_jobs.js:145 | Job attempts rise each lease and nothing reads them. A step that kills the function repeats every tick with LLM spend | medium | Fail the job above N attempts and emit a notice |
| L1-D12 | _lib/queue-runner.js:66-86 | A manual drain beside the cron, or two triggers, both pick the same rows: duplicate DRAFT orders from email, chat and voice | medium | Claim by conditional UPDATE before processFn |
| L1-D13 | tally/retry.js:124-136; netsuite/retry.js:136-148 | Overlapping drains replay one row twice: a duplicate voucher or SO (D-3) | medium | Move both onto drainRetryQueue; keep the Mode B gate as a pre-check |
| L1-D14 | tally/retry.js:50-63; netsuite/retry.js:103-129 | A push that gives up tells nobody (D-2) | medium | Same bell as _lib/erp-runner.js:123-131 (comes with L1-D13) |
| L1-D15 | inbound/email/draft_orders.js:91-117; cron/tick.js:164-177 | draft_orders links only attachments that already have a document_id, then archives the email. An attachment persisted later is never linked to the order. The tick comment claims an order the parallel group does not give | medium | Persist worker links documents when the email already has linked_order_id |
| L1-D16 | _lib/inventory/notifications.js:138-147; 041:57-79 | The voice alert insert uses status 'queued' and columns voice_calls lacks, and omits NOT NULL columns. The insert fails, the error is not read, and voice_at is stamped as if a call was placed. Refines D-4 (L4 owns) | medium | Use the voice outbound path, or check the insert error before stamping |
| L1-D17 | tally/sync.js:151-166 | Each pulled receipt adds its amount to invoices.paid_amount with no "already applied" check; a re-pulled receipt counts twice [I on re-pull] (L3 owns) | medium | Apply the delta only when the receipt row is new |
| L1-D18 | _lib/cron-mux.js:177-187; cron/tick.js:238-244; cron/daily.js:107-113 | Two writes per run: one failure counts twice; 'timeout' becomes 'error' and budget metadata is lost | low | Write once, in runCronHandler; drop the loop |
| L1-D19 | sap/retry.js:56-57 (all 15 peers); _lib/erp-runner.js:73-80 | A stuck 'processing' row is reset only when its tenant also has a due pending row | low | Reset stuck rows for all tenants at drain start |
| L1-D20 | _lib/erp-runner.js:134; tally/retry.js:40; netsuite/retry.js:93 | The documented 1-minute first retry never happens; 720 min is unreachable with 5 attempts | low | Index BACKOFF_MIN by attempt - 1; align the comments |
| L1-D21 | agents/run.js:350-356 | A goal whose dispatch throws keeps next_run_at and re-runs every hour for ever, with no count and no notice | low | Count failures, back off, give up with a notice |
| L1-D22 | push/send.js:29, :88 | The subscription_id path has no tenant filter; an approver who knows another tenant's id can push to it | low | Add .eq("tenant_id", n.tenant_id) |
| L1-D23 | cron/logistics-monitor-tick.js:28-35; four inventory crons (M-7 Q9) | With CRON_SECRET unset, the routes run for anyone | low | Refuse when unset, as fx/cron and service/amc_cron do |
| L1-D24 | cron/tick.js:17, :164-177; cron/daily.js:3-7; inbound/email/parse.js:3; customers/health_score.js:21-22; agents/run.js:7-11 | Comments claim schedules and orderings the code does not have; readers trust them | low | Correct them when the registry lands |
| L1-D25 | cron/inventory-positions.js:48-55 and peers | One manual call leaves a row on the 10-minute default; it stays stale and holds /api/_healthz at 503 | low | Registry bounds, or no heartbeat for unscheduled routes |
| L1-D26 | _lib/queue-runner.js:96-108; agents/handle_replies.js:140-146 | A transient DB error is terminal: the action or reply is closed and never retried | low | Retry with a cap before give-up |
| L1-D27 | agents/handle_replies.js:41, :75 | The goal select omits tenant_id, so the agent_steps insert has none and its error is not read (L2 owns) | low | Select tenant_id; check the insert |
| L1-D28 | cron/tick.js:187; cron/daily.js:91; _lib/logistics/notifications.js:100-153 | At 02:30 UTC the tick and daily can run the monitor at once and both send the same notice [I] | low | Stamp notices with a conditional update, or drop the daily backstop once the tick is live |

**Totals:** 3 high, 14 medium, 11 low (28).

---

## 12. Target model notes

| M | Verdict | Reason |
|---|---|---|
| M-1 | keep | The only native trigger; daily backstop stays |
| M-2 | adapt onto the registry | #566 registry plus "due since last run" in place of exact minutes |
| M-3 | merge into the registry | Same runtime; daily is one more cadence |
| M-4 | keep, fix | statusCode accessor (#566); one heartbeat write; due handlers in one parallel group with a total budget |
| M-5 | keep | Table is fine; one writer per run |
| M-6 | merge | One map built from registry cadence; `health.js` imports it; a missing expected row is stale; #623 bell |
| M-7 | decide per handler | Register with a cadence or retire the route; N-1 the same |
| M-8 | adapt onto the queue contract | Needs claim, cap and tenant scope |
| M-9 | keep as the contract's base | Only shape with claim, reset, cap, backoff and notice |
| M-10 | merge into M-9 | Two copies of the same loop, missing claim and notice |
| M-11 | adapt | Keep the lease; add a job attempts cap and a give-up notice from the contract |

**One scheduler registry.** File `src/api/_lib/cron-registry.js`. One entry
per handler: `name`, `fn`, `path`, `method`, `cadence` (`5m`, `30m`, `60m`,
`60m@5`, `daily`, `weekly@<dow>`), `budgetMs`, `maxAgeMs` (derived:
cadence x 2 plus grace), `defaultOn` (the #566 allow-list), `effects`
(`llm`, `email`, `erp_write`, `billing`, `order_write`), `owner`. `tick.js`
and `daily.js` read it. A handler runs when `now - last_run_at >= cadence`
(read from `cron_health`), not on an exact minute. `heartbeat-check.js`
takes bounds from it and treats a missing expected row as stale. `health.js`
drops its own map. Routable-only crons either get an entry or lose the
route. Start: lift #566's `TICK_HANDLERS` into the file, add the daily
entries, then point the staleness check at it.

**One queue contract.** File `src/api/_lib/queue-contract.js`, generalised
from `drainRetryQueue` (_lib/erp-runner.js:64-165). Config: `table`,
`pick` (status filter and order), `claim` (status `processing` with
`claimed_at`, `claimed_by`, or a lease column with TTL), `stuckAfterMs`
(global reset), `attemptsCol`, `maxAttempts`, `backoffMin[]`,
`nextAttemptCol`, `giveUpStatus`, `maxAgeMs` (park rows older than this,
do not replay them), `perTenantLimit`, `globalLimit`, `tenantId` (required
for manual calls), `heartbeatName`, `onGiveUp` (notice kind through the one
notice helper), and `process(row)`. Each table keeps its own columns; the
retry queues already have them except `acu_retry_queue` (271). Move first:
(1) `tally/retry` and `netsuite/retry` onto it (fixes D-2, D-3, L1-D13,
L1-D14); (2) the Acumatica columns (L1-D04); (3) `drainQueue` callers with a
claim and tenant scope (L1-D01, L1-D12); (4) parse, handle_replies and push
onto the same path; (5) the two window scans with SQL picks (L1-D02,
L1-D03); (6) the extraction job attempts cap (L1-D11). Agent goals and the
mail reaper move last, after L2 and L4 settle the send rail (#623). #635's
lease and backoff shape fits this contract and can adopt it as written.

---

Not checked: the enqueue side of each queue (L3), `tally/reconcile`,
`prospecting/run` and `eval/*` internals, and the six handlers marked "per
#566". No live fact is claimed; every "live" cell waits for section 6.

---

# L2. Actors (M-12 to M-24): audit findings

- **Base.** `origin/main` at `931eb143`. The checkout adds only `docs/SO_AGENT_INFRA_AUDIT_PLAN.md`. All `path:line` references are to files under `src/api/` unless the path says otherwise. `NNN:line` is `supabase/migrations/NNN_*.sql`.
- **Labels.** *Verified*: read in code. *Inferred*: follows from verified facts; the steps are written. *Not confirmed*: neither. A claim with no label is Verified.
- **Live.** No live database was read. "Live: no" appears only when code alone proves the path cannot run. Every other live answer is "not confirmed (owner query n)", with n from plan section 6.4.
- **Clock fact used by every card.** `vercel.json:12-17` schedules only `/api/cron/daily`. Nothing in the repo calls `/api/cron/tick`. The hourly group runs only when a tick lands on minute 0 exactly (`cron/tick.js:145`, `_lib/cron-mux.js:203-207`). So every actor that runs only from the tick is "wired, not scheduled".
- **Defect ids.** `L2-Dn` points to section 12.

---

## 1. Cards

```
M-12  Autonomous goal runner                                layer: L2
status on main: wired, not scheduled
live: not confirmed (query 1: cron_health row "agents/run"; query 2: agent_goals by status; query 6: agent_steps per day)
Q1  job: walk active goals whose next_run_at is due, ask the goal-type handler for one step,
    execute it, write a step row, then reap queued communications for each touched tenant.
    agents/run.js:1-15, :316-373. Asked for by migration 011 and audit P6/P8 (_handlers/index.js:20-43).
Q3  trigger: tick hourly group, minute % 60 == 0 only     cron/tick.js:145, :198-205; _lib/cron-mux.js:203-207
    auth is CRON_SECRET only; there is no manual path    agents/run.js:323-326
Q4  unit of work: agent_goals row, status active|paused|completed|cancelled|failed   011:27-78, 011:46-48
    writers: completed / failed on mark_complete / give_up (agents/run.js:58-59); cancelled by
    agents/goals.js:121-138 and quotes/send.js:47-53; any status by agents/goals.js:95-100;
    next_run_at by agents/run.js:65-72 and agents/handle_replies.js:69-73
Q5  claim: none. Select, then act (agents/run.js:330-348). No lease column in 011.
    Two overlapping runs dispatch the same goal twice (Inferred from the missing claim).
Q6  retry: no backoff, no attempt cap, no age limit. A thrown handler error writes last_error and
    leaves next_run_at unchanged, so the goal runs again on the next run (agents/run.js:350-356).
    A step with result "error" still advances by the cooldown (agents/run.js:65-66).
    Several handlers escalate past due_at instead of give_up (quote_accept.js:95-101, ar_collect.js:190-196).
Q7  dedup: arming only, partial unique index (082:45-47). The send itself has no key:
    each send_email inserts a new communications row (agents/run.js:153-165).
Q8  tenant: service client. The goal select crosses tenants by design (agents/run.js:330-336).
    Handlers filter the primary read on goal.tenant_id (e.g. quote_accept.js:37, ar_collect.js:46).
    Some secondary reads use an FK id only (expiring_quote_nudge.js:70, :74; price_increase_announcement.js:58). Low risk.
    The reaper filters on tenant (agents/run.js:280).
Q9  authority: CRON_SECRET. No person confirms any step. Arming needs "write" (agents/goals.js:58),
    no server action. No autonomy setting is read (section 4). Voice calls pass
    checkOutboundCompliance (agents/run.js:195-206), which needs voice_configs.outbound_enabled
    (_lib/voice-compliance.js:240).
Q10 outside effects: email to customers, suppliers and finance through the reaper and
    sendCommunication (agents/run.js:307); outbound voice call (agents/run.js:207); LLM call in the
    dunning drafter (ar_collect.js:235, _lib/dunning-drafter.js:115); legacy portal pay-link tokens
    minted per dunning step (ar_collect.js:260).
Q11 order writes: none. Handlers only select orders (failed_push_recovery.js:19, missing_doc.js:19,
    quote_accept.js:56). Gate checks: not applicable.
Q12 failure goes to: agent_steps result (agents/run.js:47), agent_goals.last_error (:73, :352).
    Escalation goes to processing_events plus one broadcast bell row (:108-127).
    The agents screen reads goals and steps (agents/goals.js:28-55).
Q13 trail: agent_steps with no actor column (agents/run.js:29-46); direct audit_events insert with
    no actor (:88-94); processing_events (:108). Cost columns are always null: executeAction never
    returns model_used or tokens (:42-45, :98-265).
Q14 health: cron_health "agents/run", written by the tick loop from the HTTP status (cron/tick.js:238-244).
    Bound 2 h in both maps (_lib/heartbeat-check.js:20, health.js:106). Per-goal errors do not move it.
Q15 config: CRON_SECRET; goal.config.cooldown_hours and escalate_roles (agents/run.js:66, :117).
    No tenant switch and no env kill switch on main. #566 adds CRON_TICK_HANDLERS.
Q16 tests: api-agent-handlers.test.js (handler decisions on a mocked client; it cannot see missing
    columns); api-agents-reaper-mailer.test.js (3 tests, reaper only). No test of the loop, overlap or error path.
Q17 overlaps: M-42 (reaper inside it), M-14 (writes goals), M-16 (second executor), M-44/M-45 (other escalators), M-41.
Q18 owner plan: #566 (scheduler, allow-list default off, reaper age limit as a follow-up); #623 (quote send direct).
notes / defects: L2-D9, L2-D10, L2-D11, L2-D12, L2-D13, L2-D19, L2-D22.
```

```
M-13  Goal types and arming                                 layer: L2
status on main: wired
live: not confirmed (query 2: agent_goals grouped by goal_type and status)
Q1  job: 16 handlers decide one step per goal type (_handlers/index.js:45-62). Goals are armed by hand
    (agents/goals.js:57-87) or on quote send (quotes/send.js:44-93, :481-486).
    Asked for by 011 (3 types), 078 (15), 080:161-190 (voice_followup); quote arming "Audit P10 follow-up" (quotes/send.js:476-480).
Q3  trigger: POST /api/agents/goals from the agents screen, which offers 3 types only (v3-app/screens/agents.tsx:14-31, :104-124);
    quotes/send.js on every quote send.
Q4  unit of work: agent_goals; goal_type CHECK of 16 (080:161-190); object_type is free text (011:40),
    but agents/goals.js:19 allows only order|einvoice|invoice|quote.
Q5  claim: cancel then insert (quotes/send.js:47-79); a race ends on the unique index.
Q6  retry: none. An arming failure writes audit "quote_goal_arm_failed" only (quotes/send.js:487-497).
Q7  dedup: partial unique (tenant_id, object_type, object_id, goal_type) where active|paused   082:45-47;
    a 23505 is treated as success (quotes/send.js:87-89).
Q8  tenant: from ctx (agents/goals.js:70; quotes/send.js:59). object_id is not checked against the
    tenant (agents/goals.js:66-73); handlers re-filter by tenant, so a foreign id ends in give_up.
Q9  authority: "write" for manual arming and for PATCH of config, cooldown and escalate_roles
    (agents/goals.js:58, :91, :103). Quote send needs approve + quotes.approve (quotes/send.js:158, :161).
Q10 outside effects: none at arming. The armed quote goal sends at the first run (L2-D9).
Q11 order writes: none.
Q12 failure goes to: audit only (quotes/send.js:491-496).
Q13 trail: audit "agent_goal_armed" with the person as actor (agents/goals.js:81-86).
Q14 health: none.
Q15 config: QUOTE_NUDGE_DAYS 14, cooldown 72 h (quotes/send.js:34-35). No tenant switch.
Q16 tests: api-quote-send-arm.test.js (4 tests).
Q17 overlaps: M-12.
Q18 owner plan: #623 (arm only after a provider accepted the quote email).
notes / defects: L2-D9, L2-D23. Section 7 lists arming per goal type.
```

```
M-14  Reply handler for classified inbound mail             layer: L2
status on main: wired, not scheduled (cron); routable manual drain
live: not confirmed (query 1: cron_health "agents/handle_replies"; query 2: inbound_emails by agent_reply_action)
Q1  job: consume payment_acknowledge, delivery_query and complaint intents; pause the matching AR
    goal 14 days or write an operator event. agents/handle_replies.js:1-23. Audit P6.8.
Q3  trigger: tick ALWAYS group (cron/tick.js:184); manual GET/POST with "approve" (agents/handle_replies.js:179-181).
    No screen calls the manual path.
Q4  unit of work: inbound_emails row with classified_intent in the actionable set and
    agent_reply_handled_at null (agents/handle_replies.js:127-132).
Q5  claim: none. The handled_at stamp is written after the work (:143-146).
Q6  retry: none. An error is stored as agent_reply_action "error" and the row is marked handled (:137-146).
Q7  dedup: agent_reply_handled_at is null (:130).
Q8  tenant: drainOnce has no tenant filter (:126-132). The manual path drains every tenant (:181). D-1.
Q9  authority: CRON_SECRET or "approve"; no confirm per row.
Q10 outside effects: none.
Q11 order writes: none. It writes agent_goals.next_run_at (:69-73).
Q12 failure goes to: inbound_emails.agent_reply_action only.
Q13 trail: audit_events direct insert, no actor (:147-153); agent_steps insert with an undefined
    tenant_id, which fails silently (:41, :74-83; L2-D20).
Q14 health: cron_health "agents/handle_replies" from the tick loop; falls to the 10-minute default bound.
Q15 config: CRON_SECRET only.
Q16 tests: none found.
Q17 overlaps: M-26 (writes the intent), M-12 (owns the goal), M-21 complaint path (same event type).
Q18 owner plan: #566 follow-ups (tenant filter, tenant_id on steps).
notes / defects: L2-D1, L2-D20.
```

```
M-15  erp_chat tool loop and the shared tool registry      layer: L2
status on main: wired (screen)
live: not confirmed (no query in 6.4 covers erp_chat_messages; add "rows per day in erp_chat_messages")
Q1  job: an LLM tool loop over the registry in _lib/erp-chat-tools.js; answers questions; write tools only propose.
    erp_chat/send.js:1-8, :148-217.
Q3  trigger: Ask Anvil screen (v3-app/screens/ask-anvil.tsx; v3-app/components/AskAnvil.tsx).
Q4  unit of work: erp_chat_sessions / erp_chat_messages (026).
Q5  claim: none needed (request scoped).
Q6  retry: up to 5 loops (erp_chat/send.js:25, :148); callAnthropic retries inside.
Q7  dedup: none.
Q8  tenant: tool queries filter tenant (registry). The session id from the body is not checked:
    history is read by session_id only (:85-108) and the session update has no tenant filter (:231). L2-D14.
Q9  authority: "read" (:59). With no persona, all 27 tools are offered, including the 4 write tools (:121).
Q10 outside effects: LLM cost (:151-161). No send.
Q11 order writes: none. post_tally_voucher only proposes (_lib/erp-chat-tools.js:711-727).
Q12 failure goes to: the HTTP response.
Q13 trail: erp_chat_messages for each turn (:97, :204, :220); audit "erp_chat_query" (:232-237).
Q14 health: none.
Q15 config: ANTHROPIC_MODEL_DEFAULT (:24).
Q16 tests: api-erp-chat-orders, -persona, -so-tools, -status-count, -diagnostics.
Q17 overlaps: kb/ask (new N-1) and M-18 use the same registry.
Q18 owner plan: GENAI_FOR_MANUFACTURING.md section 8.
notes / defects: L2-D14.
```

```
M-16  Propose and confirm                                   layer: L2
status on main: wired
live: not confirmed (query 2: action_proposals by status and action)
Q1  job: a write tool stores an action with a preview and a single-use token; the same person
    confirms; the server then executes. _lib/action-proposals.js:1-10; copilot/confirm.js:1-10.
Q3  trigger: Ask Anvil confirm and cancel (v3-app/screens/ask-anvil.tsx:217, :312, :329).
Q4  unit of work: action_proposals, status proposed|consumed|cancelled|expired   149:12-27.
    "expired" has no writer; expiry is a read-time filter (_lib/action-proposals.js:54).
Q5  claim: atomic update proposed -> consumed, same tenant, same proposer, unexpired (:49-57).
Q6  retry: none. A failed execution stays consumed; the user proposes again (copilot/confirm.js:120-142).
Q7  dedup: confirm_token unique (149:20).
Q8  tenant: every query filters tenant (:51, :63, :80, :86).
Q9  authority: "approve" (copilot/confirm.js:105) AND the confirmer must be the proposer (_lib/action-proposals.js:55).
    This is self-confirmation, not a second person. A read-only user can propose but never confirm.
Q10 outside effects: email / WhatsApp / Slack through sendCommunication (copilot/confirm.js:60); Teams reports success
    with nothing sent (_lib/comms-send.js:80-81); a Tally queue row that tally/retry later posts (copilot/confirm.js:87).
Q11 order writes: indirect. post_tally_voucher enqueues (_lib/tally-enqueue.js:39-52); on success the drain sets
    orders.status EXPORTED_TO_TALLY with no tenant filter and no transition check (tally/retry.js:96-100).
    Checks at enqueue: approval.payloadHash present only (_lib/tally-enqueue.js:27-29). L2-D7, L2-D18.
Q12 failure goes to: the HTTP 502 response, action_proposals.result, audit "copilot_action_failed" (copilot/confirm.js:132-141).
Q13 trail: audit with the person as actor (:42, :79, :89, :125); action_proposals.created_by.
Q14 health: none.
Q15 config: TTL 15 minutes (_lib/action-proposals.js:15).
Q16 tests: api-action-proposals.test.js (7), api-copilot-confirm-endpoint.test.js (10).
Q17 overlaps: M-12 (second executor), M-35 manual push (same voucher), M-41.
Q18 owner plan: #623 (report unsent mail on confirm); ANVIL_MCP_SO_TOOLS_DESIGN.md phase 2 (not built).
notes / defects: L2-D7, L2-D18, L2-D24.
```

```
M-17  Ask Anvil personas                                    layer: L2
status on main: flag off
live: no. so_agent_enabled defaults false (210:21) and no API writes it (only _lib/agent-personas.js reads it).
    Owner query 4 shows any tenant set by SQL.
Q1  job: a named prompt plus a read-only scope list for erp_chat. _lib/agent-personas.js:1-24, :32-64.
Q3  trigger: erp_chat/send.js with body.persona (:76-82); list at agent/personas.js (read, :29).
Q4  unit of work: none (config in code).
Q5-Q7: not applicable.
Q8  tenant: flag read per tenant (erp_chat/send.js:77-78).
Q9  authority: "read"; scopes READ_SCOPES exclude every write.* scope and also read.analytics and read.suppliers
    (_lib/agent-personas.js:27-30). Unknown or disabled persona is a 403 (erp_chat/send.js:79-81).
Q10 outside effects: LLM cost through erp_chat.
Q11 order writes: none.
Q12-Q14: through erp_chat.
Q15 config: tenant_settings.so_agent_enabled (210:21).
Q16 tests: api-agent-personas.test.js, api-erp-chat-persona.test.js.
Q17 overlaps: M-15.
Q18 owner plan: none named.
notes / defects: none.
```

```
M-18  MCP server                                            layer: L2
status on main: wired
live: not confirmed (query 6: mcp_call_log per day)
Q1  job: JSON-RPC over HTTP; tools/list and tools/call over the same registry, gated by token scopes.
    _lib/mcp.js:1-20, :87-151.
Q3  trigger: an external MCP client with a bearer token (mcp/server.js:22-53).
Q4  unit of work: mcp_tokens (027:13-27), mcp_call_log (027:41-55).
Q5-Q7: not applicable. use_count update is a read then write (_lib/mcp.js:57-69).
Q8  tenant: token.tenant_id passed to every tool (_lib/mcp.js:116).
Q9  authority: token scopes (_lib/erp-chat-tools.js:788-793); write.* is opt-in at issue (mcp/tokens.js:34-51, admin).
    Proposals bind to token.user_id, the issuing admin (_lib/mcp.js:116). The token is not re-checked
    against tenant membership (_lib/mcp.js:43-54). L2-D26.
Q10 outside effects: none in Anvil (the client pays its own LLM).
Q11 order writes: none (propose only).
Q12 failure goes to: JSON-RPC error and mcp_call_log status error|denied (_lib/mcp.js:120-130).
Q13 trail: mcp_call_log per call with token id, args, IP (:72-83).
Q14 health: mcp/usage.js (read).
Q15 config: token scopes; default read scopes (_lib/erp-chat-tools.js:780).
Q16 tests: api-mcp.test.js (9).
Q17 overlaps: M-15, kb/ask.
Q18 owner plan: ANVIL_MCP_SO_TOOLS_DESIGN.md. Phase 1 tools exist (_lib/erp-chat-tools.js:442, :464, :476).
    Phase 2 tools (apply_line_mapping, set_order_customer, run_extraction, send_for_review, push_to_tally) do not exist;
    only post_tally_voucher is close to push_to_tally.
notes / defects: L2-D26.
```

```
M-19  Operator actions                                      layer: L2
status on main: flag off
live: no. operator_actions_enabled defaults false (150:12); no API writes it; no screen calls the routes
    (router.js:1099-1102 only). Owner query 4.
Q1  job: a governed checklist for steps done in a system with no API: create, start, attach evidence, reconcile.
    operator_actions/index.js:1-7; OPERATOR_ACTIONS_DESIGN.md sections 3 and 8.
Q3  trigger: HTTP only.
Q4  unit of work: operator_actions, status proposed|in_progress|evidence_captured|reconciled|abandoned   150:14-35.
    Transitions in _lib/operator-actions.js:7-28.
Q5  claim: none; the state machine refuses illegal moves (operator_actions/reconcile.js:53-54).
Q6  retry: none.
Q7  dedup: none.
Q8  tenant: every query filters tenant (operator_actions/reconcile.js:38, :51, :65, :71).
    object_id is "validated in code" per 150:21, but POST does not validate it (operator_actions/index.js:60-72).
Q9  authority: write; approve when the contract mutates a record (operator_actions/reconcile.js:30, :48); flag (:33).
Q10 outside effects: none.
Q11 order writes: orders.status = contract.set.value (operator_actions/reconcile.js:71). Passes requireApprovedOrder
    (approval hash present, caller hash if sent, no unresolved blocker: _lib/erp-runner.js:193-235).
    Does not pass ALLOWED_TRANSITIONS (orders/[id].js:67-78), the role gate (_lib/order-write-gate.js:49-60),
    approval expiry or the approval_actions allowlist (orders/[id].js:190-195), and does not clear approval on a move to DRAFT. L2-D17.
Q12 failure goes to: the HTTP response.
Q13 trail: audit and processing_events with the person (operator_actions/reconcile.js:73, :86).
Q14 health: none.
Q15 config: tenant_settings.operator_actions_enabled (150:12).
Q16 tests: api-operator-actions.test.js, api-operator-actions-endpoint.test.js (7).
Q17 overlaps: M-37 Mode B "keyed in ERP" step (#611 keeps it human), M-33.
Q18 owner plan: OPERATOR_ACTIONS_DESIGN.md (CUA driver seam, section 7, stub only).
notes / defects: L2-D17.
```

```
M-20  Voice intake and outbound                             layer: L2
status on main: webhook wired; action drain wired, not scheduled; outbound wired (person) and inside M-12 (agent)
live: not confirmed (query 2: voice_calls and voice_call_actions by status; query 1: cron_health "voice/process_actions")
Q1  job: the provider webhook stores calls and enqueues extracted actions; a drain turns place_order and
    quote_request into DRAFT orders and the rest into events. voice/webhook.js:1-13; voice/process_actions.js:1-30.
Q3  trigger: provider webhook with signature (voice/webhook.js:180-184); tick ALWAYS (cron/tick.js:178);
    manual drain with "approve" (voice/process_actions.js:148-150); outbound by a person (voice/outbound.js:52)
    or by the voice_followup goal (agents/run.js:169-263).
Q4  unit of work: voice_call_actions, completed boolean   041:95-106. voice_calls unique (tenant, provider, external_id) 041:78.
Q5  claim: none; status-flip drain (_lib/queue-runner.js:66-75).
Q6  retry: none. A failure sets completed = true and stores the error (_lib/queue-runner.js:99-104).
Q7  dedup: none on actions. finaliseCall runs for every end event, and Retell sends both call_ended and
    call_analyzed (voice/webhook.js:190, :202-204, :93-101). Inferred: duplicate DRAFT orders. L2-D15.
Q8  tenant: the webhook resolves the tenant from the called number (voice/webhook.js:29-48). The drain has
    no tenant filter, and the manual path drains every tenant (voice/process_actions.js:99-106, :150). D-1.
    customer_id comes from the LLM payload with no tenant check (voice/process_actions.js:56).
Q9  authority: provider signature; CRON_SECRET or "approve"; no confirm per action.
Q10 outside effects: voice provider calls and cost (voice/outbound.js:101; agents/run.js:207).
Q11 order writes: INSERT orders status DRAFT (voice/process_actions.js:54-69). No transition rule (create), no role
    gate, no blocker projection, no payload_hash, no dedup. blocker_summary text only (:66-68).
Q12 failure goes to: voice_call_actions.error; enqueue failure writes processing_events (voice/webhook.js:103-116).
Q13 trail: audit_events direct, no actor (voice/process_actions.js:119-125); processing_events (:41-49).
Q14 health: cron_health "voice/process_actions" on the 10-minute default.
Q15 config: voice_configs (041), outbound_enabled default false (080:39).
Q16 tests: api-voice-compliance.test.js, api-voice-dnd.test.js. No drain test.
Q17 overlaps: M-21, M-22, M-28, M-32 (order creators); M-12 voice_followup.
Q18 owner plan: #566 (keep off until drain fix).
notes / defects: L2-D2, L2-D15.
```

```
M-21  Chat intake (Slack, Teams, WhatsApp)                  layer: L2
status on main: webhooks wired; drain wired, not scheduled
live: not confirmed (query 2: inbound_messages by status; query 1: cron_health "inbound/process_messages")
Q1  job: webhooks persist inbound_messages; a drain classifies by keyword and creates DRAFT orders or events.
    inbound/process_messages.js:1-25.
Q3  trigger: signed webhooks (inbound/slack/webhook.js:86; inbound/whatsapp/webhook.js:83; Teams shared secret,
    inbound/teams/webhook.js:4-12); tick ALWAYS (cron/tick.js:179); manual with "approve" scoped to the caller's tenant (:175-177).
Q4  unit of work: inbound_messages, status arrived|linked|intake-extracted|resolved|failed   039:32-34.
Q5  claim: none; status flip.
Q6  retry: none; failure sets status failed (_lib/queue-runner.js:105-106).
Q7  dedup: unique (tenant_id, channel, external_id)   039:39. One order per message, no bundling.
Q8  tenant: from the matched channel config; manual drain passes ctx.tenantId (:177).
Q9  authority: provider signature; CRON_SECRET or approve.
Q10 outside effects: none.
Q11 order writes: INSERT orders DRAFT (:58). Same gaps as M-20. The PO regex has no word boundary
    (_lib/chat-intent.js:79), so "report" or "support" becomes an order. L2-D16.
Q12 failure goes to: inbound_messages.status failed and error.
Q13 trail: audit_events direct, no actor (:60-66); processing_events (:78, :110).
Q14 health: 10-minute default.
Q15 config: inbound_chat_configs (039).
Q16 tests: api-inbound-chat-complaint.test.js (15).
Q17 overlaps: M-22 (same classifier, other dedup), M-20, M-28.
Q18 owner plan: #566 (regex fix before enable).
notes / defects: L2-D16.
```

```
M-22  Legacy WhatsApp intake                                layer: L2
status on main: wired
live: not confirmed (WHATSAPP_INBOUND_TOKEN must be set, whatsapp/inbound.js:168-170; owner to count orders
    where preflight_payload->>'source' = 'whatsapp_inbound')
Q1  job: a token-gated webhook that classifies a message and creates or bundles a DRAFT order at once.
    whatsapp/inbound.js:1-27.
Q3  trigger: provider webhook, inline (route router.js:1162).
Q4  unit of work: orders row (DRAFT) and documents.
Q5  claim: none.  Q6 retry: none; a throw returns 500 to the provider (:297-301).
Q7  dedup: bundle into a DRAFT order from the same sender in 7 days (:232-248). No message-id key.
Q8  tenant: from the request header x-anvil-tenant or a second legacy tenant header, else a default id (:37, :179).
    One global token for all tenants (:38, :171-175). A token holder can write into any tenant. L2-D8.
Q9  authority: shared secret only.
Q10 outside effects: media fetch from the provider (safeFetch).
Q11 order writes: INSERT orders DRAFT (:252-263). No gate. It then updates documents.order_id and
    documents.role, columns that do not exist (001:94-107), and ignores the error (:269-272). L2-D21.
Q12 failure goes to: HTTP 500.
Q13 trail: recordAudit / recordEvent with user id null (:197, :276-288).
Q14 health: none.
Q15 config: WHATSAPP_INBOUND_TOKEN, DEFAULT_TENANT_ID, TWILIO_AUTH_TOKEN (:37-39).
Q16 tests: none found for this file.
Q17 overlaps: M-21 (the current WhatsApp path), M-29 (same legacy pattern for email).
Q18 owner plan: none.
notes / defects: L2-D8, L2-D16, L2-D21.
```

```
M-23  Prospecting dispatch                                  layer: L2
status on main: wired, not scheduled
live: not confirmed (query 1: cron_health "prospecting/run"; owner: prospecting_targets by status)
Q1  job: send cold marketing email to approved targets of active campaigns, inside a send window and a daily cap.
    prospecting/run.js:1-13, :45-118.
Q3  trigger: tick ALWAYS (cron/tick.js:162); manual POST with "admin" scoped to the caller's tenant (:148-154).
Q4  unit of work: prospecting_targets, status approved -> sent|error|unsubscribed (:61-65, :75, :94, :111-114).
Q5  claim: none. Select approved, send, then update (:61-114). Overlapping runs can send twice (Inferred).
Q6  retry: none; "error" is terminal; no_provider leaves the row approved (:88-92).
Q7  dedup: status filter; suppression list (:71-77; _lib/marketing-send.js:68-74).
Q8  tenant: per tenant (:120-126); suppression query includes global rows by design (:72).
Q9  authority: a person approves targets in a batch (prospecting/targets.js:29, admin); no confirm per message.
Q10 outside effects: SendGrid marketing email (_lib/marketing-send.js:113-121).
Q11 order writes: none.
Q12 failure goes to: prospecting_targets.status error; communications row failed (:97-110).
Q13 trail: communications row; audit on manual run only (:155-160).
Q14 health: 10-minute default.
Q15 config: SENDGRID key and MARKETING_FROM; campaign window and cap (UTC, :32-43).
Q16 tests: api-marketing-path.test.js (16).
Q17 overlaps: marketing/send.js (new N-5), M-41.
Q18 owner plan: #566 (keep off until campaigns reviewed).
notes / defects: L2-D25.
```

```
M-24  Dispatch register auto-send                           layer: L2
status on main: flag off
live: no. dispatch_register_auto_send_enabled defaults false (205:12); no API writes it. Owner query 4.
Q1  job: after a person records despatch lines, send the dispatch register to the customer once per order.
    _lib/dispatch-register-send.js:1-20, :76-152.
Q3  trigger: inline in comms/dispatch_lines.js:61 after POST (write, :43).
Q4  unit of work: communications row document_type dispatch_register (:108-130).
Q5  claim: none. Q6 retry: none; a later despatch POST tries again when no sent row exists.
Q7  dedup: skip when a sent register exists for the order (:99-102). Two parallel posts can both send (Inferred).
Q8  tenant: ctx tenant on every query.
Q9  authority: the person's "write" on dispatch lines plus the tenant flag (:86); recipients must resolve (:104-106).
Q10 outside effects: customer email through sendCommunication (:133).
Q11 order writes: none.
Q12 failure goes to: audit "dispatch_register_auto_send_failed" only (:141-150).
Q13 trail: audit with the person as actor (:134-139).
Q14 health: none.
Q15 config: tenant flag; mailer or Graph configured (:89).
Q16 tests: api-dispatch-register-autosend.test.js (8).
Q17 overlaps: comms/dispatch_register.js (manual send), M-41.
Q18 owner plan: none.
notes / defects: none new.
```

---

## 2. Actor capability matrix

Columns: **Ord** create order; **St** change order status; **Ln** change order lines; **Ap** change approval; **Em** send email; **WA** send WhatsApp; **Vo** place voice call; **ERP** queue ERP push; **LLM** LLM cost; **Cf** a person confirms each action; **Perm** permission or server action checked; **Ten** tenant scoping. "no" means no code path; evidence is given for every yes.

| Actor | Ord | St | Ln | Ap | Em | WA | Vo | ERP | LLM | Cf | Perm | Ten |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| goal quote_accept_within_14d | no | no | no | no | yes, customer (quote_accept.js:141-153) | no | no | no | no | no | cron; arm: approve + quotes.approve on quote send (quotes/send.js:158-161) or write (agents/goals.js:58) | goal.tenant_id (quote_accept.js:37) |
| goal ar_collect_by_due_plus_7 | no | no | no | no | yes, customer (ar_collect.js:265-281) | no | no | no | yes (ar_collect.js:235; dunning-drafter.js:115) | no | cron; arm write | ar_collect.js:46, :54 |
| goal missing_doc_followup | no | no | no | no | yes in code (missing_doc.js:72); Inferred never reached (L2-D12) | no | no | no | no | no | cron; arm write | missing_doc.js:22 |
| goal expiring_quote_nudge | no | no | no | no | yes, customer (expiring_quote_nudge.js:98-109) | no | no | no | no | no | cron; armed on quote send | expiring_quote_nudge.js:29 |
| goal failed_push_recovery | no | no | no | no | no (escalate only, failed_push_recovery.js:49-59) | no | no | no | no | no | cron; arm write | failed_push_recovery.js:21 |
| goal paid_partial_followup | no | no | no | no | yes (paid_partial_followup.js:82) | no | no | no | no | no | cron; arm write | :16 |
| goal supplier_ack_followup | no | no | no | no | yes, supplier (supplier_ack_followup.js:56) | no | no | no | no | no | cron; arm by raw API only | :20 |
| goal delivery_eta_check | no | no | no | no | yes, supplier (delivery_eta_check.js:68) | no | no | no | no | no | cron; raw API only | :24 |
| goal service_visit_schedule | no | no | no | no | yes (service_visit_schedule.js:84) | no | no | no | no | no | cron; raw API only | :21 |
| goal amc_renewal_chase | no | no | no | no | yes (amc_renewal_chase.js:82) | no | no | no | no | no | cron; raw API only | :22 |
| goal credit_review_request | no | no | no | no | yes, internal finance (credit_review_request.js:123) | no | no | no | no | no | cron; raw API only | :16, :51 |
| goal onboarding_followup | no | no | no | no | yes (onboarding_followup.js:48) | no | no | no | no | no | cron; raw API only | :13 |
| goal price_increase_announcement | no | no | no | no | yes in code (:84); Inferred never reached (L2-D11) | no | no | no | no | no | cron; raw API only | :39 |
| goal replenishment_suggestion | no | no | no | no | yes in code (:81); Inferred never reached (L2-D11) | no | no | no | no | no | cron; raw API only | :27, :37 |
| goal obsolete_product_warning | no | no | no | no | yes in code (:79); Inferred never reached (L2-D11) | no | no | no | no | no | cron; raw API only | :31 |
| goal voice_followup | no | no | no | no | no | no | yes (voice_followup.js:123; agents/run.js:207) | no | no | no | cron + outbound compliance (agents/run.js:195) | :30 |
| queued mail reaper (in M-12) | no | no | no | no | yes, any queued row of the tenant (agents/run.js:276-314) | yes if the row channel is whatsapp (_lib/comms-send.js:43-61) | no | no | no | no | cron | agents/run.js:280 |
| handle_replies (M-14) | no | no | no | no | no | no | no | no | no | no | cron or approve (handle_replies.js:168-180) | none on drain (:126-132) |
| copilot confirm create_lead | no | no | no | no | no | no | no | no | no | yes (copilot/confirm.js:105, :117) | approve + same proposer (action-proposals.js:55) | ctx (confirm.js:29) |
| copilot confirm draft_and_send_comms | no | no | no | no | yes (confirm.js:60) | yes (channel whatsapp) | no | no | no | yes | approve + proposer | ctx |
| copilot confirm acknowledge_inventory_exception | no | no | no | no | no | no | no | no | no | yes | approve + proposer | confirm.js:75 |
| copilot confirm post_tally_voucher | no | yes, indirect via drain (tally/retry.js:96-100) | no | no | no | no | no | yes (tally-enqueue.js:39-52) | no | yes | approve + proposer; enqueue checks approval hash only (tally-enqueue.js:27) | tally-enqueue.js:23; drain update has no tenant filter |
| erp_chat write tools (4) | no | no | no | no | no | no | no | no (propose) | yes (erp_chat/send.js:151) | yes (propose only) | read (send.js:59) | ctx |
| kb/ask write tools (4, new N-1) | no | no | no | no | no | no | no | no (propose) | yes (kb/ask.js:61) | yes | read (kb/ask.js:40) | ctx |
| MCP write tools (4) | no | no | no | no | no | no | no | no (propose) | no | yes | token write.* scope (erp-chat-tools.js:788-793) | token.tenant_id (mcp.js:116) |
| SO persona (M-17) | no | no | no | no | no | no | no | no | yes via erp_chat | n/a (read only) | read + flag | ctx |
| operator action, note | no | no | no | no | no | no | no | no | no | yes (person drives) | write + flag (reconcile.js:30, :33) | ctx |
| operator action, status reconcile | no | yes (reconcile.js:71) | no | no | no | no | no | no | no | yes | approve (reconcile.js:48) + requireApprovedOrder (:68) | ctx |
| voice webhook | no | no | no | no | no | no | no | no | provider-side | no | provider signature (webhook.js:180-184) | number to config (webhook.js:29-48) |
| voice process_actions | yes DRAFT (process_actions.js:54) | no | no | no | no | no | no | no | no | no | cron or approve (:148-149) | none on drain (:99-106) |
| voice outbound (person) | no | no | no | no | no | no | yes (outbound.js:101) | no | no | yes (a person clicks) | approve (outbound.js:52) + compliance (:69) | ctx |
| chat intake drain | yes DRAFT (process_messages.js:58) | no | no | no | no | no | no | no | no | no | cron or approve | manual = caller tenant (:177) |
| legacy WhatsApp | yes DRAFT (whatsapp/inbound.js:252) | no | no | no | no | no | no | no | no | no | one global token (:171-175) | header-chosen (:179) |
| prospecting | no | no | no | no | yes, marketing (prospecting/run.js:87) | no | no | no | no | no (batch approval of targets) | cron or admin (:148-149) | per tenant (:120-126) |
| dispatch auto-send | no | no | no | no | yes, customer (dispatch-register-send.js:133) | no | no | no | no | no | write on dispatch lines + flag (:86) | ctx |
| quote send arming (side effect) | no | no | no | no | no (queues quote email, quotes/send.js:447-465) | no | no | no | no | yes for the quote; no for the goals it arms | approve + quotes.approve | ctx |
| supplier RFQ send (new N-3) | no | no | no | no | yes, queued for the reaper (supplier_rfq/send.js:94-100) | no | no | no | no | yes | approve (:43) | ctx |
| sourcing handoff (new N-4) | no | no | no | no | yes, queued, to another tenant's contact (sourcing/network/handoff.js:78-90) | no | no | no | no | yes | write (:29) | row owned by the listing tenant (:79) |
| marketing send (new N-5) | no | no | no | no | yes, marketing (marketing/send.js:57) | no | no | no | no | yes | admin (:35) | ctx |
| traveler auto-print (new N-6) | no | no | no | no | no | no | no | no (print job) | no | no | runs inside netsuite/push.js:187 | tenant arg |

Totals. Actors that can create an order without a person: 3 (voice drain, chat drain, legacy WhatsApp). Actors that can change order status: 2 (operator status reconcile; copilot Tally enqueue through the drain). No actor changes order lines or approval. Actors that send email with no per-action confirm: 14 goal types (4 of them never reach the send: L2-D11, L2-D12), the reaper, prospecting, dispatch auto-send.

---

## 3. Tool registry inventory

### 3.1 Tools in `_lib/erp-chat-tools.js` (27)

Surfaces: **EC** erp_chat with no persona (all tools, erp_chat/send.js:121); **SO** the so persona (READ_SCOPES, _lib/agent-personas.js:27-30); **MCP** per token scope (_lib/mcp.js:107, :116); **KB** kb/ask (all tools, kb/ask.js:45).

| Line | Tool | R/W | Scope | EC | SO | MCP | KB |
|---|---|---|---|---|---|---|---|
| 74 | search_orders | R | read.orders | yes | yes | if scope | yes |
| 97 | search_invoices | R | read.invoices | yes | yes | if scope | yes |
| 118 | search_customers | R | read.customers | yes | yes | if scope | yes |
| 131 | search_netsuite_open_orders | R | read.orders | yes | yes | if scope | yes |
| 144 | search_sap_sales_orders | R | read.orders | yes | yes | if scope | yes |
| 157 | search_d365_sales_orders | R | read.orders | yes | yes | if scope | yes |
| 170 | search_acu_sales_orders | R | read.orders | yes | yes | if scope | yes |
| 183 | search_inventory | R | read.inventory | yes | yes | if scope | yes |
| 207 | open_invoices_aging | R | read.invoices | yes | yes | if scope | yes |
| 231 | get_quote_status | R | read.orders | yes | yes | if scope | yes |
| 280 | summarize_open_pipeline | R | read.pipeline | yes | yes | if scope | yes |
| 323 | customer_history | R | read.customers | yes | yes | if scope | yes |
| 362 | last_purchase_price | R | read.orders | yes | yes | if scope | yes |
| 406 | catalog_lookup | R | read.misc | yes | yes | if scope | yes |
| 442 | verify_customer_gstin | R | read.customers | yes | yes | if scope | yes |
| 464 | resolve_item | R | read.inventory | yes | yes | if scope | yes |
| 476 | lookup_customer_parts | R | read.customers | yes | yes | if scope | yes |
| 513 | list_metrics | R | read.analytics | yes | no | if scope | yes |
| 519 | query_metric | R | read.analytics | yes | no | if scope | yes |
| 540 | search_opportunities | R | read.pipeline | yes | yes | if scope | yes |
| 564 | read_inventory_exceptions | R | read.inventory | yes | yes | if scope | yes |
| 589 | supplier_scorecard | R | read.suppliers | yes | no | if scope | yes |
| 609 | list_demand_forecast | R | read.inventory | yes | yes | if scope | yes |
| 637 | create_lead | W (propose) | write.leads | yes | no | only with write.leads | yes |
| 672 | acknowledge_inventory_exception | W (propose) | write.inventory | yes | no | only with write.inventory | yes |
| 700 | post_tally_voucher | W (propose) | write.erp | yes | no | only with write.erp | yes |
| 729 | draft_and_send_comms | W (propose) | write.comms | yes | no | only with write.comms | yes |

MCP default grant is the read scopes (_lib/erp-chat-tools.js:780; mcp/tokens.js:38-44). The 027 column default lists only 5 read scopes (027:20), which the issuer overrides.

### 3.2 Executor branches in `copilot/confirm.js` executeAction

| Line | Action | Effect |
|---|---|---|
| 26-44 | create_lead | INSERT leads, approval_status PENDING; audit |
| 46-67 | draft_and_send_comms | INSERT communications draft; sendCommunication |
| 69-81 | acknowledge_inventory_exception | UPDATE inventory_exceptions open -> acknowledged; audit |
| 83-91 | post_tally_voucher | enqueueTallyVoucher (INSERT tally_retry_queue pending); audit |
| 93 | anything else | throws "Unsupported action" |

### 3.3 Verdict

- Every write tool goes through `createProposal`: **Verified** (_lib/erp-chat-tools.js:663, :696, :725, :753). No write tool executes on first call.
- The 4 tools map 1 to 1 onto the 4 executor branches. No goal-arming tool exists, although GENAI_FOR_MANUFACTURING.md section 8 plans one behind an autonomy setting.
- The registry has **3 tool loops** that share it (erp_chat/send.js, kb/ask.js, _lib/mcp.js) and **2 executors** that share nothing: copilot/confirm.js:22 and agents/run.js:98. The goal handlers (_handlers/index.js:45) are a third, separate decision registry.
- erp_chat with no persona and kb/ask offer write tools to "read" users. Their proposals can never be confirmed (approve plus same proposer). Harmless, but it is noise.

---

## 4. Trust models

| Id | Model | Actors | Evidence |
|---|---|---|---|
| T1 | Act directly after a standing arm. A person or a quote send arms a goal once; the machine then sends repeatedly | M-12 goal types, the reaper | agents/run.js:98-265, :276-314; arming agents/goals.js:57-87, quotes/send.js:481 |
| T2 | Act directly on an inbound event, no person | M-14, M-20 drain, M-21 drain, M-22 | handle_replies.js:117-124; voice/process_actions.js:79-97; inbound/process_messages.js:138-144; whatsapp/inbound.js:250-266 |
| T3 | Propose, then the same person confirms with approve | erp_chat, kb/ask, MCP write tools; M-16 | _lib/action-proposals.js:20-75; copilot/confirm.js:105-117 |
| T4 | Human only, governed checklist, flag-gated | M-19 | operator_actions/*.js; flag 150:12 |
| T5 | Flag-gated auto-send after a person's write | M-24 | _lib/dispatch-register-send.js:86 |
| T6 | Batch pre-approval, then the machine sends | M-23 | prospecting/run.js:61-65; prospecting/targets.js:29 |

Plan H-5 names two models. There are six.

**Autonomy setting readers.**

| Setting | Read sites | Reader is an actor? |
|---|---|---|
| `DEFAULT_AGENT_POLICY` (_lib/order-exceptions.js:225-240) | `buildOrderExceptions` default (:1142); `agentPolicyFor` default (:280) | No. orders/exceptions.js:103 passes no tenant policy. The result labels rows for display (v3-app/components/OrderExceptionsCard.tsx:44) |
| `agentPolicyFor` (:280-289) | order-exceptions.js:1104 only | No. It sets `row.agent_policy`; nothing acts on the label |
| `resolveAgentPolicy` (:247-262) | order-exceptions.js:1142, only when an agentPolicy is passed; no caller passes one | No reader |
| `resolveWorkflowConfig` (_lib/order-next-step.js:60-66) | `nextStep` (:90); its only caller is a screen with the constant default (v3-app/screens/so-workspace.tsx:2071-2077) | No |
| `so_controls` (#611 R-M2, migration 266) | not on main | No reader |
| tenant_settings flags read by actors | so_agent_enabled (erp_chat/send.js:77-78), operator_actions_enabled (operator_actions/reconcile.js:33), dispatch_register_auto_send_enabled (_lib/dispatch-register-send.js:86), so_processing_mode (tally/push.js:88, tally/retry.js:121), voice outbound_enabled (_lib/voice-compliance.js:240) | Yes, but each is a per-mechanism on/off switch, not an autonomy level |

**Verdict.** No shared autonomy setting exists. No actor reads `DEFAULT_AGENT_POLICY`, `agentPolicyFor` or `resolveWorkflowConfig`. The goal runner reads no tenant setting at all (agents/run.js:330-336), so a tenant cannot stop it except by cancelling each goal.

---

## 5. Gate check

Gates: **TR** ALLOWED_TRANSITIONS (orders/[id].js:67-78, enforced :176-185); **RG** role gate (_lib/order-write-gate.js:49-60, called orders/[id].js:144); **AE** approval evaluator (orders/[id].js:432, on a move to PENDING_REVIEW); **BF** blocking findings (orders/[id].js:245; _lib/erp-runner.js:223; tally/push.js:144); **PH** payload_hash stamp or check (orders/[id].js:218, :290-295); **DD** dedup.

| Write | Actor | TR | RG | AE | BF | PH | DD | Other checks |
|---|---|---|---|---|---|---|---|---|
| INSERT DRAFT (voice/process_actions.js:54) | voice drain | n/a (create) | no | no | no projection | none | no | none |
| INSERT DRAFT (inbound/process_messages.js:58) | chat drain | n/a | no | no | no | none | message unique (039:39) only | none |
| INSERT DRAFT (whatsapp/inbound.js:252) | legacy WhatsApp | n/a | no | no | no | none | sender bundle 7 days (:232-248) | shared token |
| UPDATE status (operator_actions/reconcile.js:71) | operator status reconcile | **no** | **no** | no | yes (requireApprovedOrder) | caller hash if sent (_lib/erp-runner.js:205-218) | n/a | approve; evidence state (:53) |
| UPDATE status EXPORTED_TO_TALLY (tally/retry.js:96-100) after copilot enqueue | copilot post_tally_voucher | **no** | **no** | no | **no** (enqueue skips it) | approval hash present only (_lib/tally-enqueue.js:27-30) | **no** voucher record (L2-D7) | Mode B only at the drain (tally/retry.js:121) |
| Same write by a person | tally/push.js:225-228 | no | no | no | yes (:144-147) | yes (:138-141) | yes, voucher record (:185-194) | Mode B (:88), quote_variance (:124-136) |
| Person PATCH (orders/[id].js:297) | person | yes | yes | yes | yes on approve | yes | n/a | approve perm, expiry, allowlist (:190-195), STALE_APPROVAL (:218), clears approval on edit (:265-268) |
| Person POST (orders/index.js:187) | person | **no**: any status accepted (:35) | **no**: write only (:127) | no | projected from extraction run (:171-186) | **client-supplied** (:59) | no | client-supplied approval (:58). L2-D6 |

**Findings.**

1. Only `orders/[id].js` imports the role gate and the approval evaluator (orders/[id].js:5, :10). Plan H-5 says `admin/quote_approvals.js`, `_lib/order-margin.js` and `_lib/auth.js` import them. They only name them in comments (admin/quote_approvals.js:122; _lib/order-margin.js:5; _lib/auth.js:275, :286). Correction for O-1.
2. No actor write passes ALLOWED_TRANSITIONS or the role gate.
3. The copilot Tally path is weaker than the manual Tally push on four checks (blocker, quote_variance, idempotency record, Mode B at enqueue). It is also weaker than the 15 other ERP pushes, which call requireApprovedOrder.
4. The person POST path is weaker than every actor path in one way: it accepts a final status and an approval blob from the client. A finance or procurement role with "write" can create a pushable APPROVED order (Inferred: the push gates then pass because approval.payloadHash is present and payload_hash falls back to it, tally/push.js:110, :138).
5. No create path, person or actor, applies a dedup rule on PO number or document fingerprint (orders/index.js stores doc_fingerprint at :48 and never reads it).

---

## 6. Escalation paths

| Actor | How it tells a person | Evidence | Who can see it |
|---|---|---|---|
| Goal runner, escalate step | processing_events "agent_escalation" + ONE broadcast bell row, 5-minute dedup | agents/run.js:108-127; _lib/notifications.js:48-87 | admin and operator bell. `escalate_roles` only decides whether a row is written; `owner_user_id` is never used (agents/run.js:117-127) |
| Goal runner, step error or skip | agent_steps result; agent_goals.last_error | agents/run.js:47, :73 | agents screen only |
| Goal runner, thrown error | last_error only; no step, no advance | agents/run.js:350-356 | agents screen |
| Goal runner, call placed but row lost | processing_events "voice_call_persist_failed" | agents/run.js:239-253 | no screen found |
| handle_replies | processing_events info or warn; errors in agent_reply_action | handle_replies.js:94-114, :143-146 | no screen reads these event types (only agents.tsx text names "agent_escalation") |
| voice drain | processing_events; failure in voice_call_actions.error | voice/process_actions.js:41-49; _lib/queue-runner.js:99-104 | none found |
| voice webhook | processing_events "voice_action_enqueue_failed" | voice/webhook.js:103-116 | none found |
| chat drain | processing_events; failure in inbound_messages.error | inbound/process_messages.js:78-90, :110-118 | none found |
| legacy WhatsApp | processing_events complaint; HTTP 500 on failure | whatsapp/inbound.js:207-213, :297-301 | none found |
| copilot confirm | HTTP 502, proposal result, audit | copilot/confirm.js:132-141 | the person in the session |
| Tally drain for a copilot enqueue that gives up | status columns only | tally/retry.js:112-115 (D-2) | nobody |
| prospecting | target status "error" | prospecting/run.js:111-114 | campaign screen |
| dispatch auto-send | audit only | _lib/dispatch-register-send.js:141-150 | nobody |
| quote goal arming | audit only | quotes/send.js:491-496 | nobody |
| operator actions | HTTP response | operator_actions/reconcile.js | the person |
| #640 email sweep (open PR) | notify() per person and per role, with a claim ledger | #640 `_lib/email-accountability/escalation.js` (diff lines 214-280) | the named person |

**Verdict.** Not the same channel. Only the goal runner reaches the bell. Every intake actor writes processing_events that no screen reads, so a complaint or a delivery question reaches nobody (Inferred from the grep: the event types appear in v3-app only as text in agents.tsx:312). Once #640 merges, email escalation uses per-person `notify()`, while goal escalation stays on the broadcast `notifyAdmins`.

---

## 7. Goal arming

**Insert paths into agent_goals** (all of src and supabase): `agents/goals.js:79` (POST, write); `quotes/send.js:79` (armQuoteAgentGoals). Seed files only: `supabase/seed/350_recent_modules.sql:570`, `:585`; `supabase/seed/400_logs_and_analytics.sql:313`. No trigger or SQL function inserts goals. Voice webhook does not arm voice_followup, although 080:161-167 says the runtime does.

| Goal type | Automatic arming | Manual arming path | Notes |
|---|---|---|---|
| quote_accept_within_14d | yes, on quote send, object_type quote (quotes/send.js:57-67) | screen, as object_type order (agents.tsx:14-20) | first run sends at once (L2-D9) |
| expiring_quote_nudge | yes, on quote send (quotes/send.js:68-77) | raw API | |
| ar_collect_by_due_plus_7 | no | screen (agents.tsx:22-26) | |
| missing_doc_followup | no | screen (agents.tsx:28-31) | Inferred dead (L2-D12) |
| failed_push_recovery | no | raw API | escalation only; no producer arms it (H-9) |
| paid_partial_followup | no | raw API | |
| supplier_ack_followup | no | raw API with a mislabeled object_type (agents/goals.js:19) | handler reads source_pos |
| delivery_eta_check | no | raw API, mislabeled | source_pos |
| service_visit_schedule | no | raw API, mislabeled | amc_schedules |
| amc_renewal_chase | no | raw API, mislabeled | contracts |
| credit_review_request | no | raw API, mislabeled | customers |
| onboarding_followup | no | raw API, mislabeled | customers |
| price_increase_announcement | no | raw API | Inferred dead (L2-D11) |
| replenishment_suggestion | no | raw API, mislabeled | customers; Inferred dead (L2-D11) |
| obsolete_product_warning | no | raw API | Inferred dead (L2-D11) |
| voice_followup | no | raw API, mislabeled | voice_calls |

Two of 16 are armed automatically. Three are on the screen. Eleven need a raw API call, and nine of those need an object_type that does not match the table the handler reads.

---

## 8. Signal verdicts

- **H-5 Confirmed, wider than stated.** Six trust models, not two (section 4). No actor write passes ALLOWED_TRANSITIONS or the role gate (section 5). `DEFAULT_AGENT_POLICY` is display only. Two corrections: only orders/[id].js imports the gate and evaluator; the voice call is placed at agents/run.js:207 (the plan cites :221, the row insert).
- **H-8 Confirmed.** The only drain of queued communications is `reapQueuedCommsForTenant` (agents/run.js:276-314), called only for tenants with a goal due at that run (:361-366), only from the hourly group (cron/tick.js:198-205). Producers that queue and do not send: quotes/send.js:447-465, supplier_rfq/send.js:94-100, sourcing/network/handoff.js:78-90, agents/run.js:153-165, _lib/comms-send.js:196 (no provider configured), and the logistics and inventory notices (_lib/logistics/notifications.js:192-199; _lib/inventory/notifications.js:113-140), which the reaper fails for no recipient (agents/run.js:295-303). Producers that send at once: invoices/send.js, comms/service_report.js, comms/payment_statement.js, comms/dispatch_register.js, _lib/dispatch-register-send.js, copilot/confirm.js. A quote send arms goals due now (011:57), so it triggers its own reap; a supplier RFQ in a tenant with no goals never leaves (Inferred).
- **H-10 Confirmed.** agents/handle_replies.js:126-132 and :179-181; voice/process_actions.js:99-106 and :148-150. drainQueue already has a `tenantId` option for this (_lib/queue-runner.js:54-57, :67); process_messages uses it (:177); voice does not.
- **D-1 Confirmed, and 7 more user paths cross tenants.** Each runs with a service client and no tenant filter after a tenant user passes a permission check:

| Path | Permission | What crosses tenants |
|---|---|---|
| agents/handle_replies.js:179-181 | approve | pauses other tenants' AR goals; writes their events; returns their email and goal ids |
| voice/process_actions.js:148-150 | approve | creates DRAFT orders in other tenants |
| inbound/email/parse.js:146-148 (drain :119-129) | approve | LLM classification of every tenant's mail; returns their email ids, customer ids, intents |
| inbound/email/persist_attachments.js:126-128 (drain :38-57) | approve | uploads other tenants' attachments |
| quotes/expire.js:73-75 (drain :25-57) | approve | expires other tenants' quotes; returns their quote numbers |
| cron/tally-reconcile.js:88-90 (drain :20-61) | approve | runs drift checks and optional auto-fix re-enqueue for every enabled tenant |
| cron/drift-meter.js:152-156 (drain :28-140) | admin | reports every tenant's meter rows to Stripe or Razorpay (real billing) |
| cron/drift-report.js:266-270 (drain :206-250) | admin | emails every enabled tenant's monthly report (month dedup at :231-238) |
| eval/replay.js:373; eval/rescore.js:168 | write | the caller chooses `body.tenant_id`; replay reads that tenant's documents, spends its provider key and notifies its admins (eval/replay.js:300) |

#566 lists the first 5 plus tally-reconcile. quotes/expire, drift-meter, drift-report and the eval tenant override are new in this audit.

---

## 9. Open PR overlay

| PR | Change to L2 cards | Evidence |
|---|---|---|
| #566 | Adds a GitHub Actions trigger every 5 minutes and the `CRON_TICK_HANDLERS` allow-list. Unset, only `extraction/jobs` runs. So M-12, M-14, the M-20 and M-21 drains, M-23 and the Tally drain behind copilot confirms become "live: no" until the owner widens the list. The hourly group still needs minute 0 exactly, and GitHub starts late, so agents/run can skip hours even when allowed. No change to any actor's code | #566 diff: `.github/workflows/cron-tick.yml`, `docs/CRONS.md` (handler table, follow-ups) |
| #623 | Quote send sends at once and arms goals only after a provider accepted the email. M-13 arming moves after the send; quote email no longer depends on the reaper (H-8 narrows). The quote_accept first-run follow-up (L2-D9) remains: rows still carry no next_run_at. Copilot draft_and_send_comms marks an unsent row failed, so the reaper cannot send it later. Teams false success fixed | #623 diff: quotes/send.js, copilot/confirm.js, _lib/comms-send.js |
| #624 | Adds `notify()` (a row per person, every role, phone). It does **not** change agents/run.js: goal escalation stays on broadcast `notifyAdmins` | #624 file list: only _lib/notifications.js, admin/notifications.js, shells, migration 253 |
| #637 | Adds an actor: email rules that turn inbound mail into owned email actions on `work_items` (252, 268). Reads orders for linking only (diff line 353). No order write, no outbound send found | #637 diff |
| #640 | Adds an actor: `email/sweep` in tick and daily, reminders and escalation through `notify()` with a claim ledger (270) and a per-run cap. It is the first actor with a claim, a cap and per-person escalation. It sets a second escalation shape beside the goal runner's | #640 diff lines 214-294, 941-973 |

---

## 10. O-2 rows

| Mech | Schedule | Claim and lease | Retry and give up | Dedup | Decide (policy) | Act on an order | Send outside | Notify a person | Track human work | Escalate | Record the trail | Report health |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M-12 | tick hourly, minute 0 (tick.js:198-205) | none (run.js:330-336) | none; thrown error never advances (run.js:350-356) | arm only (082:45) | handler per type (_handlers/index.js:45) | | email via reaper (run.js:307); voice (run.js:207) | bell on escalate (run.js:120) | owner_user_id, due_at (011:52, :69), unused | escalate step (run.js:102-130) | agent_steps (run.js:47); audit (:88) | cron_health 2 h (heartbeat-check.js:20) |
| M-13 | quote send inline (quotes/send.js:481) | cancel then insert (:47-79) | none | 082:45; 23505 (:87) | QUOTE_GOAL_TYPES (:36) | | | | owner_user_id (goals.js:77) | | audit (goals.js:81) | |
| M-14 | tick ALWAYS (tick.js:184) | none | none; error marked handled (:143-146) | handled_at null (:130) | intent switch (:117-124) | | | | | processing_events (:105-114) | audit (:147) | 10-min default |
| M-15 | screen | | 5 loops (send.js:25) | | LLM tool choice (send.js:151) | propose only | | | | | erp_chat_messages (:97, :204, :220) | |
| M-16 | screen | atomic consume (action-proposals.js:49-57) | none (confirm.js:120) | token unique (149:20) | person confirms (confirm.js:105) | via Tally queue (tally-enqueue.js:39) | email, chat (confirm.js:60) | | proposal created_by, expires_at (149:15, :23) | | audit (confirm.js:125) | |
| M-17 | screen + flag (agent-personas.js:80) | | | | read scopes (:27-30) | | | | | | via M-15 | |
| M-18 | external client | | | | token scopes (erp-chat-tools.js:788) | propose only | | | | | mcp_call_log (mcp.js:72) | mcp/usage.js |
| M-19 | person | state machine (operator-actions.js:19-28) | | | contract (:43-64) | status (reconcile.js:71) | | | operator_actions (150:14-35) | | audit, event (reconcile.js:73, :86) | |
| M-20 | webhook; tick ALWAYS (tick.js:178) | flag flip, no lease (queue-runner.js:66-75) | none; completed on fail (:99-104) | calls only (041:78) | action switch (process_actions.js:79) | DRAFT insert (:54) | voice (outbound.js:101) | | | processing_events (:89-91) | audit (:119) | 10-min default |
| M-21 | webhooks; tick ALWAYS (tick.js:179) | status flip | none; status failed (queue-runner.js:105) | 039:39 | keyword (chat-intent.js:73-81) | DRAFT insert (:58) | | | | processing_events (:110) | audit (:60) | 10-min default |
| M-22 | webhook inline | | none (HTTP 500) | sender bundle (:232-248) | keyword | DRAFT insert (:252) | | | | processing_events (:207) | audit, event (:276-288) | |
| M-23 | tick ALWAYS (tick.js:162) | none | none; error terminal (:111-114) | status + suppression (:71-77) | window, cap (:45-59) | | marketing email (:87) | | | | communications (:97) | 10-min default |
| M-24 | inline (comms/dispatch_lines.js:61) | | none | once per order (:99-102) | flag, recipients (:86, :104-106) | | email (:133) | | | | audit (:134) | |

Column classes for O-2. **Claim**: only M-16 (and #640) claim; M-12, M-14, M-20, M-21, M-23 do not (Divergent, Double fire risk once scheduled). **Escalate**: M-12 bell; M-14, M-20, M-21, M-22 processing_events only (Divergent; a Gap for intake, since nobody reads it). **Decide**: four separate policies, none shared (Divergent). **Track human work**: agent_goals owner, action_proposals, operator_actions, and #637 work_items (Divergent; H-6). **Act on an order**: 5 writers, none through the gate (Gap).

---

## 11. New mechanisms in L2 (new in the audit)

| Id | Mechanism | Entry | What it does | Notes |
|---|---|---|---|---|
| N-1 | kb/ask tool loop | kb/ask.js:34-110 | Second LLM tool loop over the full registry, write tools included; "read"; up to 4 loops | No persona filter (:45); no session record |
| N-2 | Dunning drafter | _lib/dunning-drafter.js:115; ar_collect.js:232-251 | LLM-drafted customer email inside a goal | Cost not on agent_steps |
| N-3 | Supplier RFQ send | supplier_rfq/send.js:43, :94-100 | Vendor emails queued; leave only through the reaper | H-8 |
| N-4 | Sourcing network handoff | sourcing/network/handoff.js:29, :78-90 | Queued email to another tenant's contact, row owned by that tenant | Cross-tenant by design; reaper |
| N-5 | Marketing send | marketing/send.js:35, :57 | Admin sends consented marketing | Shares _lib/marketing-send.js with M-23 |
| N-6 | Traveler auto-print | orders/traveler.js:65-80; netsuite/push.js:187 | Print job after a NetSuite push, flag travelers_auto_print | Only NetSuite calls it |
| N-7 | Quote expiry cron | quotes/expire.js:25-57; cron/daily.js:72 | Flips quotes to EXPIRED daily | Ends quote goals; cross-tenant manual path |
| N-8 | AMC visit cron | service/amc_cron.js:74; cron/daily.js:70 | Creates service_visits daily | Outside SO |
| N-9 | Recurring invoice cron | billing/recurring_cron.js:84; cron/daily.js:73 | Creates invoices daily | Outside SO; writes money records with no person |
| N-10 | Eval replay and rescore | eval/replay.js:104, :300; eval/rescore.js:45 | LLM replay of goldens; bell rows | Caller-chosen tenant (section 8) |
| N-11 | Email rules engine (#637) and email sweep (#640) | open PRs | Owned work items; reminders and escalation | Section 9 |
| N-12 | Pay-link minting by an agent | ar_collect.js:260; _lib/pay-link.js | A legacy portal token per dunning step | Ties M-12 to the portal-token debt |

---

## 12. Defects found, not fixed

| Id | Where | Failure scenario | Sev | Fix in one line |
|---|---|---|---|---|
| L2-D1 | agents/handle_replies.js:126-132, :179-181 | One tenant's approver pauses other tenants' dunning goals and sees their ids (D-1) | high | Pass ctx.tenantId into drainOnce and filter the select |
| L2-D2 | voice/process_actions.js:99-106, :148-150 | One tenant's approver creates DRAFT orders in every tenant (D-1) | high | Pass `tenantId: ctx.tenantId` to drainQueue, as process_messages does |
| L2-D3 | cron/drift-meter.js:152-156 | A tenant admin triggers billing submission for every tenant | high | Make the route cron-only, or scope drainOnce to ctx.tenantId |
| L2-D4 | inbound/email/parse.js:146-148; persist_attachments.js:126-128; quotes/expire.js:73-75; cron/tally-reconcile.js:88-90; cron/drift-report.js:266-270 | Manual triggers act on every tenant and return other tenants' ids, intents or quote numbers | medium | Add a tenant argument to each drain and pass ctx.tenantId on the manual path |
| L2-D5 | eval/replay.js:373; eval/rescore.js:168 | A "write" user picks any tenant_id; replay reads its documents, spends its key, writes its bell | medium | Allow body.tenant_id only for a platform role, else use ctx.tenantId |
| L2-D6 | orders/index.js:35, :58, :59, :127 | A write-role user creates an order already APPROVED with a client approval blob; push gates pass (Inferred) | high | Force status DRAFT, drop approval and payload_hash from the POST body, call the role gate |
| L2-D7 | _lib/tally-enqueue.js:27-52; tally/retry.js:85 | Copilot confirm pushes a voucher past an unresolved blocker or quote_variance line; no voucher record is written, so a later manual push creates a second voucher | high | Call the same guard as tally/push.js (requireApprovedOrder + variance + voucher-record idempotency) and write the voucher record at enqueue |
| L2-D8 | whatsapp/inbound.js:37-38, :171-179 | Anyone with the one global token writes DRAFT orders and documents into any tenant by header | high | Resolve the tenant from a per-tenant secret, or retire the route for inbound/whatsapp/webhook.js |
| L2-D9 | quotes/send.js:57-67; 011:57; quote_accept.js:103-112 | The first hourly run after a quote send emails "Following up on quote X", often in the same reap as the quote | medium | Set next_run_at = sent_at + cooldown when arming |
| L2-D10 | quote_accept.js:31, :88 | A DECLINED, EXPIRED or CANCELLED quote keeps getting follow-ups, then escalations every 72 h | medium | Treat every non-SENT quote status as terminal, as expiring_quote_nudge.js:39 does |
| L2-D11 | price_increase_announcement.js:37-42; obsolete_product_warning.js:29-34; replenishment_suggestion.js:35-42; agents/run.js:52-74 | They select orders.line_items, which does not exist (001:134-163); Inferred: each run errors and noops forever. If fixed, notified_customer_ids is never written, so one customer is emailed every cycle | medium | Read result.salesOrder.lineItems and let the runner persist action_payload.advance_notified |
| L2-D12 | missing_doc.js:19-27 | Embeds documents(id, role), but role lives on order_documents (001:168-172); Inferred: each run errors and noops | medium | Read order_documents(role) |
| L2-D13 | agents/run.js:330-356 | Overlapping runs send twice; a thrown handler error re-runs every hour with no notice | medium | Claim goals with a conditional UPDATE of next_run_at; advance on error and count failures |
| L2-D14 | erp_chat/send.js:85-108, :231 | A known session id from another tenant feeds its history to the model and receives this tenant's messages | medium | Load the session with tenant_id and user_id before use |
| L2-D15 | voice/webhook.js:93-101, :190, :202-204; 041:95-106 | Two end events, or a provider retry, enqueue the same actions twice; Inferred duplicate DRAFT orders | medium | Finalise once (status guard) and add a unique key on (call_id, action, payload hash) |
| L2-D16 | _lib/chat-intent.js:79 | "report" or "support" becomes a DRAFT order (also in #566 follow-ups) | medium | Add word boundaries |
| L2-D17 | operator_actions/reconcile.js:68-71; _lib/operator-actions.js:33-36 | A reconcile sets any status on an approved order with no transition rule, no action gate, no approval reset | medium | Route the status write through the orders/[id].js gate |
| L2-D18 | tally/retry.js:96-100 | The success update has no tenant filter and no transition check; a copilot row can flip a CANCELLED order to EXPORTED_TO_TALLY | medium | Filter tenant and refuse statuses outside ALLOWED_TRANSITIONS |
| L2-D19 | ar_collect.js:190 vs :197; quote_accept.js:95; missing_doc.js:36; agents/run.js:60-66 | Past due_at, a goal escalates every cooldown forever and never gives up; the owner is never notified | medium | Escalate once, then give_up or pause; notify owner_user_id |
| L2-D20 | agents/handle_replies.js:41, :74-83, :143-146 | The pause step row has tenant_id undefined and fails silently; errors are never retried | low | Select tenant_id; leave errored rows unhandled with an attempt count |
| L2-D21 | whatsapp/inbound.js:269-272 | Media never links to the order (columns do not exist); error ignored | low | Insert order_documents rows |
| L2-D22 | agents/run.js:42-45 | agent_steps cost columns are always null, so agent LLM cost is invisible per goal | low | Return model and tokens from the handler step and pass them through |
| L2-D23 | agents/goals.js:19; v3-app/screens/agents.tsx:14-31, :300-313 | 9 goal types need a mislabeled object_type; the screen says "hourly Vercel cron" and "flips to failed" at due_at, both false | low | Add object types per handler and correct the screen text |
| L2-D24 | copilot/proposals.js:19-25; _lib/action-proposals.js:84-94 | Any read user sees every confirm_token; any approver can cancel another user's proposal | low | Return tokens only to the proposer; check created_by on cancel |
| L2-D25 | _lib/marketing-send.js:96; prospecting/run.js:84-87 | Cold prospecting email says "you opted in" | low | Use a footer that matches the legal basis |
| L2-D26 | _lib/mcp.js:43-54 | A token stays valid after its issuer leaves the tenant | low | Check tenant membership of token.user_id on lookup |
| L2-D27 | _lib/notifications.js:63-87; agents/run.js:117-127 | escalate_roles such as finance still produce one row that only admin and operator see | low | Move goal escalation to notify() once #624 merges |

Counts: high 6 (L2-D1, D2, D3, D6, D7, D8). Medium 13 (D4, D5, D9 to D19). Low 8 (D20 to D27). Total 27.

---

## 13. Target model notes

### 13.1 Per mechanism

| Mech | Verdict | Reason |
|---|---|---|
| M-12 | adapt onto shared primitives | Keep the handler idea. Move claim, retry, escalation and the send onto the shared queue contract, action gate and notify() |
| M-13 | adapt | Arming should be one helper that sets next_run_at and object types per handler, used by quote send and the screen |
| M-14 | merge into M-12 or the #637 rules engine | It is a reply rule; the email rules engine owns inbound-mail reactions |
| M-15 | keep | One loop over the one registry is right |
| M-16 | keep, adapt | It is the closest thing to an action gate; generalise its executor into the shared gate |
| M-17 | keep | Pure configuration over M-15 |
| M-18 | keep | Thin adapter over the registry |
| M-19 | keep behind its flag, adapt its status write onto the gate | The governed checklist fits Mode B "keyed in ERP"; its order write must not bypass the gate |
| M-20 | adapt | Intake should create orders through one intake helper with dedup and the gate |
| M-21 | adapt, merge with M-20 and M-28 | Same intake shape; one order-from-message helper |
| M-22 | retire | Superseded by M-21's signed WhatsApp webhook; it holds a cross-tenant hole |
| M-23 | keep, adapt the claim | Separate legal basis; needs a claim before scheduling |
| M-24 | keep, move onto the gate | A per-tenant opt-in send is a clear autonomy case for the map |

### 13.2 One action gate

- **Where.** `_lib/action-gate.js`, one function `runAction(svc, actor, action, args)`. Actor = `{ kind: person | agent_goal | copilot | mcp | intake | operator, tenantId, userId?, goalId? }`.
- **What it checks, in order.** (1) Tenant: every read and write carries actor.tenantId. (2) Autonomy: look up the action in the autonomy map; refuse, propose or run. (3) Permission and server action: the same `requireAction` the person path uses. (4) Order state: for any order write, ALLOWED_TRANSITIONS, the role gate, approval expiry and allowlist, blocking findings and the payload_hash check, by calling the logic now inline in orders/[id].js. (5) ERP push: requireApprovedOrder plus Tally variance and voucher idempotency. (6) Dedup: an idempotency key per action. (7) Trail: one audit row with the actor kind.
- **Who moves first.** The copilot executor (copilot/confirm.js:22), because it already has a single switch; then operator status reconcile (reconcile.js:71); then the three intake order creators; then the goal runner's send_email and place_outbound_call.
- **What stays human.** Approve an order, accept terms flags of high severity, cancel an order, Mode B "keyed in ERP", any money deviation above the tolerance. These map to "human only" and the gate refuses an actor.

### 13.3 One autonomy map

- **Where.** One tenant_settings jsonb (the `so_controls` shape from #611 R-M2, migration 266, or the next free number from 271), read through `resolveAgentPolicy` widened to cover actions, not only exception rows.
- **Shape.** `{ action: shadow | propose | apply | human_only }` per action key (send_customer_email, place_call, create_draft_order, push_erp, set_order_status, arm_goal), with the current `DEFAULT_AGENT_POLICY` keys kept for exception rows.
- **Defaults.** Today's behaviour, so no actor changes on deploy: goal sends "apply", intake drafts "apply", copilot writes "propose", order status "human_only".
- **Reader.** Only the action gate reads it. The goal runner, intake drains and copilot never read settings themselves.
- **First use.** A per-tenant kill switch for goal sends (set "propose" or "human_only"), which does not exist today.

---

Not checked: live data (no queries run); the content of screens beyond the grep hits named; the extraction-job writeback (L1/L3); NetSuite and 15 other ERP pushes beyond their guard call. Inferred runtime errors (L2-D11, L2-D12, L2-D15) need one owner query or a test against a real schema to move to Verified.

---

# L3. SO record path: audit layer report (M-25 to M-37)

- **Base.** `931eb143` (origin/main). Every `path:line` is at that commit. `src/api/` is left out of paths. Migrations are `NNN:line`.
- **Scope.** Plan `docs/SO_AGENT_INFRA_AUDIT_PLAN.md` section 4.3, questions Q1 to Q18 and the L3 questions in 5.2.
- **Labels.** *Verified*: read in code. *Inferred*: follows from verified facts; the steps are given. *Not confirmed*: neither. Wired is not live.
- **Live facts.** No database was read. Every "live" cell names the owner query (plan 6.4) that settles it. Section 12 adds three queries that the owner should run with 6.4.
- **Names.** No customer, person, part or tenant names.

---

## 1. Cards

### M-25 Inbound email webhook and dedup  (L3)

```
status on main: wired
live: not confirmed (owner query 2: inbound_emails by provider and status; query 4: Postmark or Graph configured)
Q1  job: take a Postmark or Graph inbound mail, resolve the tenant, write one inbound_emails row; drop repeats.
    Asked for by Phase 3.3 (inbound-email.js:1-13).
Q3  trigger: provider webhook. POST /inbound/email/webhook  router.js:759; handler inbound/email/webhook.js:208
Q4  unit of work: inbound_emails row (028:38-66), status 'received' (inbound-email.js:71, webhook.js:191)
    or 'duplicate' (inbound-email.js:105). Threads in inbound_email_threads (028:15-27).
Q5  claim: none. Check-then-insert on message_id (inbound-email.js:84-91); the unique index
    028:69-70 stops a second row, the second insert errors and the error is not read (inbound-email.js:134).
Q6  retry: none in Anvil. The provider retries. Graph writes a stub on a fetch failure (webhook.js:177-192)
    but a retry cannot complete it: the message id returns the old row (inbound-email.js:90). Defect L3-D22.
Q7  dedup: (tenant_id, message_id) unique 028:69; sha256(from domain, subject, body first 200) in 7 days
    (inbound-email.js:26-33, :93-109). Attachments are not in the hash (L3-D23).
Q8  tenant: Postmark by inbound address (webhook.js:75-85), HMAC fail-closed (webhook.js:97-102);
    Graph by subscription id (webhook.js:154-157), clientState gates the fetch only (webhook.js:166-175).
Q9  authority: provider signature or clientState. No user. No order write.
Q10 outside: Graph message fetch with the tenant's mailbox token (webhook.js:172-173).
Q11 order writes: none.
Q12 failure goes to: HTTP status to the provider. No row, no notice.
Q13 trail: audit_events insert, actor_id null (webhook.js:246-253).
Q14 health: none. No heartbeat; webhooks are not in either staleness map.
Q15 config: tenant_settings.postmark_inbound_address, postmark_inbound_secret, graph_subscription_id,
    graph_client_state (not confirmed: migration line not checked for each).
Q16 tests: api-inbound-email.test.js, api-inbound-email-attachments.test.js, api-inbound-email-threads-intent.test.js.
    Not covered: Graph stub completion; dup_hash false positive.
Q17 overlaps: M-29 (legacy inbound email, no shared dedup), M-21/M-22 (chat and WhatsApp intake).
Q18 owner plan: R-F6 (one intake front door); EA-1, EA-2 (#635, #636) add mailbox sync beside it.
notes: route is wired, but every later step (M-26 to M-30) runs only from the tick (H-1).
```

### M-26 Inbound email classifier  (L3)

```
status on main: wired, not scheduled (tick only)
live: not confirmed (owner query 1: cron_health 'inbound/email/parse'; query 2)
Q1  job: match the sender to a customer, score priority, classify intent, route the row.
Q3  trigger: tick ALWAYS group (tick.js:163); manual POST/GET with 'approve' (inbound/email/parse.js:146-148)
Q4  unit: inbound_emails 'received' -> 'parsed' | 'linked' | 'archived' (parse.js:87-95, :103) or 'failed' (:111-114).
    'linked' means "draft an order next", not "linked to an order".
Q5  claim: none. Select 25 'received' rows (parse.js:120-124), update by id (:103). Two overlapping drains
    classify the same row twice (LLM cost twice).
Q6  retry: none. 'failed' is terminal (parse.js:111-114). No attempts column.
Q7  dedup: the status filter only.
Q8  tenant: the drain has no tenant filter (parse.js:120-124). The manual path runs that drain for every
    tenant and returns other tenants' row ids, customer ids and intents (parse.js:146-149). Defect L3-D3.
Q9  authority: cron secret; manual 'approve'. Acts directly; no confirm.
Q10 outside: LLM call (email-classifier.js:94).
Q11 order writes: none. It sets inbound_email_threads.customer_id (parse.js:97-101).
Q12 failure: inbound_emails.status 'failed' + error. Read by the inbox screen only (not confirmed which).
Q13 trail: none. No audit or event row for a classification.
Q14 health: cron_health 'inbound/email/parse', default 10 min bound (heartbeat-check.js:49).
Q15 config: LLM key; confidence floor 0.55 in code (parse.js:88).
Q16 tests: api-inbound-email-threads-intent.test.js (classification path). Not covered: the manual drain scope.
Q17 overlaps: M-14 handle_replies reads classified_intent; M-21 chat-intent classifier (separate rules).
Q18 owner plan: R-F6; EA-4 rules (#638) classify mailbox mail separately.
```

### M-27 Attachment persistence  (L3)

```
status on main: wired, not scheduled (tick only)
live: not confirmed (owner query 1: 'inbound/email/persist_attachments'; new query N-2 in section 12)
Q1  job: move inline base64 attachments into storage, scan with ClamAV, write documents rows.
Q3  trigger: tick ALWAYS (tick.js:176); manual with 'approve' (persist_attachments.js:126-128)
Q4  unit: inbound_emails.attachments[] items with content_b64 (no status column). documents.scan_status
    'pending' -> 'clean' | 'quarantined' (persist-attachments.js:130-144).
Q5  claim: none. Reads the 80 OLDEST inbound_emails rows with no filter (persist_attachments.js:51-54) and
    filters in JS (:57). Once those 80 hold no bytes, newer mail is never read. Defect L3-D6.
Q6  retry: a failed attachment keeps its bytes and retries every tick with no cap (persist-attachments.js:186-190).
Q7  dedup: (tenant, sha256, metadata.source + inbound_email_id) (persist-attachments.js:66-80).
Q8  tenant: no tenant filter; the manual path drains every tenant (persist_attachments.js:126-128). L3-D3.
Q9  authority: cron secret; manual 'approve'.
Q10 outside: storage upload; ClamAV (persist-attachments.js:133).
Q11 order writes: none. Documents are linked to the order only by M-28, which fails (L3-D7).
Q12 failure: last_error on the attachment item; processing_events 'inbound_av_scan_unresolved' (persist-attachments.js:145-157).
Q13 trail: recordAudit on the manual path only (persist_attachments.js:129-134).
Q14 health: cron_health name, default 10 min.
Q15 config: CLAMAV_URL. Without it scan_status stays 'pending' and M-30 never sees the document.
Q16 tests: api-inbound-email-attachments.test.js. Not covered: the 80-row window.
Q17 overlaps: M-29 and M-22 persist attachments inline with their own rules.
Q18 owner plan: R-F6 (front door); none for the queue shape.
```

### M-28 Draft orders from email  (L3)

```
status on main: wired, not scheduled (tick only)
live: not confirmed (owner query 1: 'inbound/email/draft_orders'; query 2)
Q1  job: create one DRAFT order per 'linked' inbound email and archive the email. Audit P2.2 (draft_orders.js:9-13).
Q3  trigger: tick ALWAYS (tick.js:177); manual 'approve', caller tenant only (draft_orders.js:140-142)
Q4  unit: inbound_emails 'linked' -> 'archived' with linked_order_id (draft_orders.js:113-120), or 'failed'
    (queue-runner.js:105-106). orders row status DRAFT (draft_orders.js:40).
Q5  claim: none. drainQueue selects then updates by id (queue-runner.js:66-86). Two overlapping drains each
    insert an order for the same email (Inferred: no conditional update, no unique key on the order).
Q6  retry: none; 'failed' is terminal. A patch failure after the insert leaves the row 'linked' and the next
    run inserts a second order (queue-runner.js:86-90; draft_orders.js:72-75).
Q7  dedup: linked_order_id on the email row only (draft_orders.js:72-74). No PO number, hash or fingerprint.
Q8  tenant: cron drains all; manual is tenant-scoped (draft_orders.js:60, :142).
Q9  authority: cron secret. Direct insert; no gate (H-5).
Q10 outside: none.
Q11 order writes: INSERT draft_orders.js:75. Passes no transition rule (initial DRAFT), no role gate, no
    map, no blockers, no reconcile. order_documents upsert carries tenant_id, a column the table does not
    have (001:169-174, 001:407-408); the error is not read (draft_orders.js:94-103). Defect L3-D7.
Q12 failure: inbound_emails.status 'failed' + error.
Q13 trail: audit_events insert, actor null (draft_orders.js:78-84).
Q14 health: cron_health name, default 10 min.
Q15 config: none.
Q16 tests: none found that import draft_orders.js.
Q17 overlaps: M-29, M-21, M-20, M-22, M-32 (eight creators, section 3).
Q18 owner plan: R-F6.
```

### M-29 Legacy inbound email  (L3)

```
status on main: wired (webhook)
live: not confirmed (env EMAIL_INBOUND_TOKEN; owner query 6: audit_events action 'email_intake')
Q1  job: parse a provider envelope, store attachments, create or reuse a DRAFT order.
Q3  trigger: POST /email/inbound (router.js:1030); handler email/inbound.js:118
Q4  unit: orders DRAFT (email/inbound.js:196-212); documents with scan_status 'pending' (:103-113).
Q5  claim: none.
Q6  retry: none.
Q7  dedup: reuses ANY DRAFT of the tenant from the last 7 days whose preflight threadId or subject contains
    the first 40 characters of the new thread key or subject (email/inbound.js:179-194). Different customers
    can merge into one DRAFT. Defect L3-D17. inbound_emails is never written, so M-25 dedup does not apply.
Q8  tenant: from header x-anvil-tenant or a second legacy tenant header, else DEFAULT_TENANT_ID (email/inbound.js:140).
    The one global token (:127-135) does not bind a tenant, so a token holder picks any tenant.
Q9  authority: global token (header or query string). No user.
Q10 outside: storage upload.
Q11 order writes: INSERT email/inbound.js:196. No gate, no map, no reconcile. order_documents insert (:225),
    error not read.
Q12 failure: 500 to the provider; audit rows for skipped attachments (:159-173).
Q13 trail: recordEvent + recordAudit with role 'system' (:228-240).
Q14 health: none.
Q15 config: EMAIL_INBOUND_TOKEN, DEFAULT_TENANT_ID.
Q16 tests: none found.
Q17 overlaps: M-25 to M-28 do the same job with different dedup and tenant rules.
Q18 owner plan: none. H-15 asks to retire it or route it through inbound_emails.
```

### M-30 Auto OCR of intake documents  (L3)

```
status on main: wired, not scheduled (tick only)
live: not confirmed (owner query 1: 'inbound/auto_ocr'; query 2 extraction_runs by status)
Q1  job: run the extraction pipeline on clean inbound documents linked to an order. Audit P2.5.
Q3  trigger: tick ALWAYS (tick.js:180); manual 'approve', tenant-scoped (auto_ocr.js:219-223)
Q4  unit: documents (scan_status 'clean', metadata.source in email_inbound/whatsapp_inbound) joined
    order_documents!inner (auto_ocr.js:44-62). Output: extraction_runs row (029:20-35).
Q5  claim: none. Reads the 20 oldest clean, linked documents of ANY source, then filters (auto_ocr.js:55-62);
    extracted documents are skipped after the read (:68-76, :104). The window never moves. Defect L3-D8.
Q6  retry: none. Any prior run, 'failed' included, stops a retry (auto_ocr.js:73).
Q7  dedup: extraction_runs by source_id (auto_ocr.js:68-76).
Q8  tenant: cron all; manual scoped (auto_ocr.js:54). Order read by id only (:109).
Q9  authority: cron secret. Writes no order.
Q10 outside: OCR and LLM providers via runExtractionPipeline (auto_ocr.js:133-147).
Q11 order writes: none by design (auto_ocr.js:13-17). The run is not attached to the order.
Q12 failure: extraction_runs status; extraction_review_queue (M-31) through run.js enqueueReview.
Q13 trail: audit_events insert, no actor (auto_ocr.js:152-163).
Q14 health: cron_health name, default 10 min.
Q15 config: provider keys; CLAMAV_URL upstream.
Q16 tests: none found.
Q17 overlaps: N-4 docai/extract (the person's path), M-11 background jobs.
Q18 owner plan: R-F6 ("inbound OCR does not update the order").
notes: email documents never reach this worker: M-28 fails to link them (L3-D7). WhatsApp documents never
reach it either: whatsapp/inbound.js:270-271 writes documents.order_id, a column that does not exist (001:94-107).
```

### M-31 Extraction review queue  (L3)

```
status on main: wired (screen)
live: not confirmed (owner query 3: extraction_review_queue open)
Q1  job: list and triage low-confidence or failed extraction runs. Wave 4.1.
Q3  trigger: screen; GET/POST /docai/review_queue (router.js:770; docai/review_queue.js:83)
Q4  unit: extraction_review_queue (123: table, status check open/in_review/resolved/archived).
    Writers: enqueueReview upsert (_lib/docai/review-queue.js:84-106), updateReviewStatus (:117-136).
Q5  claim: 'claim' sets in_review + assigned_to with no condition (review_queue.js:107-108); a second
    claim takes the row from the first person.
Q6  retry: n/a.
Q7  dedup: unique (tenant_id, extraction_run_id) (123). A re-upsert resets status to 'open' (review-queue.js:102-106).
Q8  tenant: every query filters tenant_id (review_queue.js:49, :73; review-queue.js:131-132).
Q9  authority: 'read' to list, 'write' to triage (review_queue.js:91, :98). Any status to any status.
Q10 outside: none.
Q11 order writes: none. A resolve does not touch the order or its findings.
Q12 failure: n/a.
Q13 trail: recordAudit 'docai_review_<action>' (review_queue.js:137-142).
Q14 health: none.
Q15 config: none.
Q16 tests: api-docai-review-queue.test.js, api-docai-review-queue-endpoint.test.js.
Q17 overlaps: M-34 exceptions (line_count_shortfall row), M-46 pull lists.
Q18 owner plan: none named; WM work items (H-6) would subsume.
notes: no writer of 'archived'. The background job (M-11) updates the run (extraction_jobs.js:848-883) but
never opens or resolves a review row.
```

### M-32 Other order creators  (L3)

```
status on main: wired (screens, portal)
live: orders/index.js not confirmed (owner query 6: audit 'create_order'); quotes/convert.js not confirmed
      (audit 'quote_convert'); portal/reorder.js NO: it inserts status "NEW" (portal/reorder.js:82), which is
      not an order_status value (001:117-122), so every call fails (Verified).
Q1  job: create an order from the intake screen, from a quote, or from a portal reorder.
Q3  trigger: POST /orders (router.js:1096; orders/index.js:126); POST /quotes/convert (router.js:955;
    quotes/convert.js:106); POST /portal/reorder (router.js:660; portal/reorder.js:33)
Q4  unit: orders row. Initial status: body.status, any enum value (orders/index.js:35); DRAFT (convert.js:166);
    "NEW", invalid (reorder.js:82).
Q5  claim: n/a. quote convert reads the quote status and updates it with no condition (convert.js:128, :192-197):
    a double click makes two orders (Inferred, L3-D28).
Q6  retry: none.
Q7  dedup: none on POST (doc_fingerprint stored, never checked: orders/index.js:48); quote status read on convert;
    none on reorder.
Q8  tenant: ctx.tenantId (index, convert); token row tenant (reorder.js:48-51, :80).
Q9  authority: POST needs only coarse 'write' and accepts status, approval and payload_hash from the body
    (orders/index.js:35, :58-59, :127). Convert needs 'approve' + quotes.approve (convert.js:112-116).
    Reorder needs a portal token with 'reorder' scope (reorder.js:12-21).
Q10 outside: none.
Q11 order writes: INSERT orders/index.js:187 (+ retry :201), convert.js:162, reorder.js:79. Only POST runs
    item mapping (orders/index.js:154-165), blocker projection (:171-186) and autoReconcileOrder (:251).
    Convert copies quote.payload_hash (convert.js:172) and runs none of them.
Q12 failure: HTTP error to the screen or portal.
Q13 trail: recordAudit + recordEvent (orders/index.js:210-211; convert.js:200-214); audit_events actor null (reorder.js:104-111).
Q14 health: none.
Q15 config: none.
Q16 tests: api-server-side-reconcile.test.js, api-server-anomaly-run.test.js, api-orders-approval-hash.test.js,
    api-order-opportunity-link.test.js. No test for portal reorder (the enum failure is untested).
Q17 overlaps: M-28, M-29, M-20, M-21, M-22 (section 3).
Q18 owner plan: R-F6; #631 makes POST always DRAFT with no approval and needs so.write.
```

### M-33 Order transitions and approval  (L3)

```
status on main: wired (PATCH from screens)
live: not confirmed (owner query 6: audit 'update_order', 'approve_order')
Q1  job: the one server path for a person's order edit, status move, approve, return and finding resolve.
Q3  trigger: PATCH /orders/:id (router.js:1192; orders/[id].js:138); quote_approvals via /admin/quote_approvals (router.js:914)
Q4  unit: orders.status (001:118-121), approval jsonb, approval_expires_at, approval_actions, payload_hash;
    quote_approvals.status PENDING/APPROVED/REJECTED/SKIPPED (006:628).
Q5  claim: none. Read then unconditional update (orders/[id].js:145, :297). A person's save can overwrite
    a background writeback and the reverse (Inferred).
Q6  retry: n/a.
Q7  dedup: n/a. Stale approval: payload hash compare (orders/[id].js:218-225).
Q8  tenant: every query filters tenant_id (orders/[id].js:145, :297).
Q9  authority: requirePermission 'write' (:139) + requireOrderPatchAction so.write / so.cancel
    (order-write-gate.js:49-60) + 'approve' for approve and resolve (:154, :212).
Q10 outside: none.
Q11 order writes: update :297 passes ALLOWED_TRANSITIONS (:67-85, :176-185), expiry (:190-192), approval
    allowlist (:193-195), identity rules (:202-207), hash + APPROVE_WITH_CHANGES + blocker on approve
    (:218-248), approval clear on edit (:264-269), hash restamp (:290-295). Not checked: content status
    (result is accepted on APPROVED, EXPORTED_TO_TALLY, CANCELLED); pending quote_approvals; send blockers;
    Mode B. Evaluator runs AFTER the write, best effort (:431-446).
Q12 failure: 409 with a code to the screen.
Q13 trail: recordAudit + recordEvent with ctx.user.id (:411-412); approved_by (:251).
Q14 health: none.
Q15 config: none read. TTL from body.approval.ttlHours, default 24 h (:252-253).
Q16 tests: api-order-status-actions.test.js, api-so-write-gate.test.js, api-approve-stale-hash.test.js,
    api-orders-approval-hash.test.js, api-blocking-findings.test.js.
Q17 overlaps: N-9 operator_actions/reconcile (writes status, own rules), tally push and retry (write status),
    reconciler (writes status), extraction writeback (writes result).
Q18 owner plan: R-F1, C-3 (#622), C-11 (#627), #631, C-9 (#626).
notes: approval jsonb is in APPROVE_INPUTS (orders/[id].js:22); a so.write PATCH with {approval} and no status
writes an approval nobody gave. #631 removes it. quote_approvals rows are never enforced (L3-D13).
```

### M-34 Exceptions, findings and the next step  (L3)

```
status on main: wired (computed on read; inline writes)
live: not confirmed (owner query 3: orders with unresolved blocking rule_findings)
Q1  job: one list of what needs a decision on an order; the agent policy; the next-step button.
Q3  trigger: GET /orders/exceptions (orders/exceptions.js:69); inline anomaly check after reconcile
    (order-reconcile.js:441-443); PATCH resolve_finding (orders/[id].js:153-165); /findings (findings/index.js:5)
Q4  unit: derived rows (order-exceptions.js:14-45), no table; orders.rule_findings jsonb (001:149);
    validation_findings (001:228); order_term_flags (250:92).
Q5  claim: anomaly check is compare-and-set on updated_at (order-anomaly-check.js:101-107).
Q6  retry: none; a failed or late check writes an event (order-anomaly-check.js:133-141).
Q7  dedup: anomaly check once per payload hash (order-anomaly-check.js:79-82).
Q8  tenant: all reads scoped (orders/exceptions.js:89-90; order-anomaly-check.js:63-64).
Q9  authority: policy is code only: DEFAULT_AGENT_POLICY (order-exceptions.js:225-240), agentPolicyFor (:280-289);
    resolveAgentPolicy has no caller with a tenant value.
Q10 outside: none.
Q11 order writes: anomaly check writes rule_findings (order-anomaly-check.js:101-104), skipped past review
    statuses (:68). findings/index.js writes validation_findings; no gate reads them (only GET include at
    orders/[id].js:112).
Q12 failure: processing_events on a failed check.
Q13 trail: events only.
Q14 health: none.
Q15 config: terms_check_mode default 'off' (250:203).
Q16 tests: api-order-exceptions.test.js, api-orders-exceptions.test.js, api-order-next-step.test.js,
    api-server-anomaly-run.test.js, api-blocking-findings.test.js.
Q17 overlaps: M-31, M-36 reconciliation findings, M-44/M-45 exception tables (section 7).
Q18 owner plan: R-F1 (c) #622; C-2 #625; R-U3.
notes: next step reads send blockers in the browser only (order-next-step.js:93, :109-112). findings/index.js
has no GET, but the anomaly screen GETs it (anomaly.tsx:46-48): always 405 (L3-D24).
```

### M-35 Tally push and enqueue  (L3)

```
status on main: wired (screen; copilot confirm)
live: not confirmed (owner query 2: tally_retry_queue; query 6: audit 'tally_push')
Q1  job: build and post a Tally voucher for an approved order, record it, queue a retry on a recoverable failure.
Q3  trigger: POST /tally/push (router.js:1152; tally/push.js:58); copilot confirm 'post_tally_voucher'
    (copilot/confirm.js:83-90) -> enqueueTallyVoucher (tally-enqueue.js:13)
Q4  unit: tally_voucher_records (001:288-302; 016:73-79) 'exported'|'failed'; tally_retry_queue 'pending' (016:96-113);
    orders.status + tally_status.
Q5  claim: none. Idempotency is select then post (push.js:185-196): two concurrent pushes both post (L3-D10).
Q6  retry: push enqueues one new row per recoverable failure (push.js:245-247); the enqueue makes a row due now
    with voucher_record_id null (tally-enqueue.js:39-52).
Q7  dedup: unique (tenant_id, voucher_no, payload_hash) on voucher records (001:302), read at push.js:186-194.
    The XML says ACTION="Create" (tally-build-voucher.js:335): Tally has no key; each post adds a voucher.
Q8  tenant: all reads scoped (push.js:107; tally-enqueue.js:23).
Q9  authority: 'approve' (push.js:64; confirm.js:105). Checks: Mode B (push.js:88-90), approval.payloadHash
    (:110-112), quote_variance lines (:124-136), body hash (:138-141), blocker (:144-147). Not checked:
    order status, approval expiry, approval_actions. The enqueue checks approval only (tally-enqueue.js:27-29):
    no Mode B, no blocker, no variance, no status.
Q10 outside: Tally bridge HTTP (push.js:196).
Q11 order writes: push.js:225-228 sets status EXPORTED_TO_TALLY or FAILED_TALLY_IMPORT from ANY status with
    no ALLOWED_TRANSITIONS check and no condition. A CANCELLED order keeps its approval (orders/[id].js:264-273
    clears only on edit or return), so it can be pushed and set to EXPORTED_TO_TALLY (L3-D9).
Q12 failure: 502 to the screen; voucher record 'failed'; no bell (D-2).
Q13 trail: recordAudit + recordEvent with ctx (push.js:230-243); the enqueue writes 'tally_voucher_enqueued' (confirm.js:89).
Q14 health: none for the push; tally/health.js reads the queue.
Q15 config: tally_companies.bridge_url; tenant_settings.so_processing_mode (221: default 'A').
Q16 tests: api-tally-mode-b.test.js, api-tally-variance-gate.test.js, api-tally-voucher-action.test.js,
    api-so-processing-mode.test.js. Not covered: concurrent push; push of a CANCELLED order; enqueue then push.
Q17 overlaps: M-36 retry drain and reconciler re-push; PATCH to EXPORTED_TO_TALLY by hand (section 4).
Q18 owner plan: C-4 (merged #612); #631; #632.
```

### M-36 Tally sync, retry drain, reconciler and drift meter  (L3)

```
status on main: wired, not scheduled (tick only)
live: not confirmed (owner query 1: 'tally/retry', 'tally/sync', 'tally/reconcile', 'drift-meter';
      query 4 with tally_drift_addon_enabled and tally_recon_auto_fix_enabled added). The reconciler's
      re-push auto-fix: NO. Its insert names columns tally_retry_queue lacks and omits three NOT NULL columns
      (tally-reconciler.js:222-228 vs 016:96-113), so it can never succeed (Verified).
Q1  job: drain tally_retry_queue; pull voucher state and receipts from the bridge; compare pushed vouchers
    with Tally state; meter and bill reconciled vouchers.
Q3  trigger: tick RETRIES in ALWAYS (tick.js:89); SYNCS every 30 min (tick.js:109, :113); drift-meter hourly
    (tick.js:204). Manual: retry 'admin' (retry.js:162-171), sync 'admin' (sync.js:226-227), reconcile
    'approve' (tally-reconcile.js:88-90), meter 'admin' (drift-meter.js:152-156).
Q4  unit: tally_retry_queue pending/succeeded/gave_up (016:110; 059 adds processing, never written for Tally);
    tally_voucher_state (016:163-176); tally_reconciliation_runs (095:33-52); findings (095:66-94);
    tally_drift_billing_meter (097).
Q5  claim: none. Retry selects then replays (retry.js:124-136); claimed_at from 059 is unused (D-3).
    cron-mux Promise.race does not stop a timed-out handler (cron-mux.js:142).
Q6  retry: backoff 1,5,15,60,240,720 min (retry.js:26, :40); gave_up at 5 (:37-38, :50-64); no age limit;
    no bell (D-2). Replay has no voucher-record or order-status check (retry.js:66-101): L3-D1.
Q7  dedup: none on replay. Meter: one report per provider (drift-meter.js header; 097 partial index).
Q8  tenant: retry updates by id only (retry.js:41-46, :51-62, :79-100); order update has no tenant filter (:97-100).
    Reconcile manual path runs every opted-in tenant (tally-reconcile.js:20-70, :88-90). Meter manual path
    drains every tenant (drift-meter.js:152-156). L3-D3.
Q9  authority: cron secret. Reconcile drift_check accepts autoFix from a 'write' body (tally/reconcile.js:66, :84-92).
Q10 outside: Tally bridge (retry.js:73; sync.js:56); Stripe and Razorpay metering (drift-meter.js).
Q11 order writes: retry success sets EXPORTED_TO_TALLY from any status (retry.js:96-101). Reconciler auto-fix
    sets FAILED_TALLY_IMPORT from any status (tally-reconciler.js:207-211). markStatus is conditional and
    refuses 'reconciled' outside Mode A (tally-reconciler.js:504-515). None pass ALLOWED_TRANSITIONS.
Q12 failure: queue status; reconciliation findings; console warnings. No notice.
Q13 trail: retry writes audit only on the manual path (retry.js:102-109); runs and findings tables;
    tally_sync_runs (sync.js:24-41).
Q14 health: 'tally/sync' 75 min in heartbeat-check.js:23 but 10 min in health.js:99-108; 'tally/reconcile' and
    'drift-meter' fall to the 10 min default although they run every 30 and 60 min (H-3).
Q15 config: tally_drift_addon_enabled default false (097:23); tally_recon_auto_fix_enabled default false (095:137);
    tally_recon_total_tolerance_pct 0.50 (095:136).
Q16 tests: api-tally-mode-b.test.js, api-tally-reconciler.test.js (compareOne only, fake state),
    tally-reconciler.markStatus.test.js, api-tally-drift-paid-sku.test.js. Not covered: the state select
    columns (L3-D2), replay after a later push (L3-D1).
Q17 overlaps: M-35; M-9 erp-runner (claim + bell); M-10 NetSuite copy.
Q18 owner plan: #631 (retry guard), #632 (re-queue), C-12 (bridge read-back).
notes: the reconciler selects voucher_no, line_count and party_gstin from tally_voucher_state, which has
none of them (016:163-176), and filters on voucher_no (tally-reconciler.js:325-330). The error is not read,
so every exported voucher reads as 'missing_in_tally' with severity 'error' on every run (L3-D2).
tally/sync.js:5-7 says it reflects state to orders.tally_status; it writes only voucher records (:76-83).
```

### M-37 Mode B setting and handoff settings  (L3)

```
status on main: wired; no handoff send on main
live: not confirmed (owner query 4: so_processing_mode, order_handoff_enabled)
Q1  job: store the tenant's SO processing mode; store handoff recipients and preview them.
Q3  trigger: admin screen; /admin/so_processing_mode (router.js:868), /admin/order_handoff_settings
    (router.js:869; admin/order_handoff_settings.js:103)
Q4  unit: tenant_settings.so_processing_mode 'A'|'B' default 'A' (221:27); order_handoff_* (251);
    orders.handoff_status sent/failed/not_configured (251:91-93): no writer on main.
Q5-Q7 n/a.
Q8  tenant: scoped to ctx.tenantId.
Q9  authority: 'admin' (order_handoff_settings.js:108).
Q10 outside: none (settings preview resolves member emails only).
Q11 order writes: none. isModeB (so-processing-mode.js:33-37) is read only by tally/push.js:88 and tally/retry.js:121.
Q12 failure: n/a. An unreadable mode reads as A (so-processing-mode.js:29-32).
Q13 trail: recordAudit on change (so_processing_mode.js:101-102; order_handoff_settings.js:185).
Q14 health: none.
Q15 config: the columns above.
Q16 tests: api-tally-mode-b.test.js, api-so-processing-mode.test.js, api-order-handoff-settings.test.js.
Q17 overlaps: none on main; #630 adds the send; #626 reads mode for the stage.
Q18 owner plan: R-F2, R-F3, C-8, C-9, C-18 (#626, #628, #630).
notes: so-processing-mode.js:1-11 says every ERP write path refuses in Mode B. Only the two Tally handlers do
(L3-D19).
```

---

## 2. State machines on the SO record path

| Machine | Values (migration) | Writers | Rule enforced where | Screen-only rules |
|---|---|---|---|---|
| orders.status | DRAFT, PENDING_REVIEW, APPROVED, BLOCKED, DUPLICATE, REUSED, EXPORTED_TO_TALLY, FAILED_TALLY_IMPORT, RECONCILED, CANCELLED (001:118-121) | PATCH orders/[id].js:297; POST orders/index.js:35 (any value); intake inserts DRAFT (draft_orders.js:40, email/inbound.js:198, process_messages.js:58, voice/process_actions.js:57, whatsapp/inbound.js:254, quotes/convert.js:166); portal/reorder.js:82 ("NEW", invalid); tally/push.js:225-228; tally/retry.js:97-100; tally-reconciler.js:207-211, :511-515; operator_actions/reconcile.js:71 | Server, PATCH only: ALLOWED_TRANSITIONS (orders/[id].js:67-85). markStatus is conditional (tally-reconciler.js:511-513). Push, retry, auto-fix, operator actions and POST: nowhere | order-status-actions.js:19-35 mirrors the table (tested against the handler). Send blockers: order-next-step.js:93, :109-112 (browser). Kanban targets: pipeline-kanban.tsx:61-68. Threshold close after approve: approvals.tsx:282-292 |
| orders.approval binding (approval, approval_expires_at, approval_actions, payload_hash) | approval and payload_hash (001:153-154); approval_expires_at, approval_actions (005:13-14) | PATCH approve (orders/[id].js:249-256), clear on edit (:264-269), clear on return (:272-273), stamp (:290-295); POST body (orders/index.js:58-59); writeback (extraction_jobs.js:803-809); reconcile (order-reconcile.js:349-362); convert copies the quote hash (convert.js:172) | Server: hash compare on approve (orders/[id].js:218-225); push compares approval.payloadHash only (push.js:110-112, :138-141) | Line edit only in DRAFT/PENDING_REVIEW/BLOCKED: #631 adds it in so-workspace.tsx only; server accepts result at any status |
| orders.tally_status | idle, pending, dry_run_ok, exported, imported, failed, reconciled (005:12) | push.js:226; retry.js:98; tally-reconciler.js:209, :507 | markStatus refuses 'reconciled' unless EXPORTED_TO_TALLY or RECONCILED (tally-reconciler.js:504-506). Nowhere else. No writer of pending or dry_run_ok | none |
| orders.handoff_status | sent, failed, not_configured (251:91-93) | none on main (#630 adds orders/handoff.js) | n/a | Register shows "not sent" |
| inbound_emails.status | received, parsed, linked, duplicate, failed, archived (028:62-63) | inbound-email.js:71, :105; webhook.js:191; parse.js:95-103, :111-114; draft_orders.js:116 via queue-runner.js:86; queue-runner.js:105 | The drains' select filters only | none found |
| inbound_email_threads.status | open, linked, closed, archived (028:24) | none: only linked_order_id (draft_orders.js:107-112) and customer_id (parse.js:97-101) are written | n/a: stays 'open' | none |
| inbound_messages.status | arrived, linked, intake-extracted, resolved, failed (039:33-34) | webhooks insert 'arrived'; process_messages.js handleOrderIntent 'linked', status request and other 'resolved', complaint 'intake-extracted'; queue-runner.js:105 'failed' | Select filter only; unique (tenant, channel, external_id) (039:39) | none |
| voice_call_actions.completed | boolean + error (041:95-106) | process_actions.js:113-118; queue-runner.js:99-104 (failure sets completed true) | none; a failure is terminal | none |
| extraction_jobs.status and chunk_status | queued, profiling, chunking, extracting, merging, completed, failed, cancelled (117:27-28); chunk pending, retry, done, failed (extraction_jobs.js:363, :392, :534) | enqueue orders/extraction_jobs.js:137; worker :306-314, :402-414, :425-427, :560-568, :643-645, :659-661, :722-724, :816-818, :888-895, :954-959; cancel extraction_jobs_id.js:45-56 | Lease (extraction_jobs.js:142-156); merge is CAS on 'merging' (:818, :895); one in-flight job per order (202:17). Stage moves are NOT conditional, so a cancel mid-step is overwritten (L3-D15) | none |
| extraction_runs.status | running, ok, low_confidence, failed (029:35) | run.js pipeline; writeback extraction_jobs.js:848-883; reaper reap-stale-runs.js:32-34 | none | none |
| extraction_review_queue.status | open, in_review, resolved, archived (123) | review-queue.js:84-106 (upsert resets to open), :117-136 | none: any to any | none; no writer of 'archived' |
| quote_approvals.status | PENDING, APPROVED, REJECTED, SKIPPED (006:628) | approval-evaluator.js:80-91; admin/quote_approvals.js:144-160 | none: any to any; approver_role not matched to the caller; order approve ignores it | approvals.tsx:282-292 closes rows after the order approve |
| tally_retry_queue.status | pending, succeeded, gave_up (016:110); + processing (059) | push.js:41-56; tally-enqueue.js:39-52; tally-reconciler.js:222-228 (always fails); retry.js:41-46, :50-56, :79-84 | none: no claim, 'processing' never written | none |
| <erp>_retry_queue.status (sample: erp-runner) | pending, processing, succeeded, gave_up (059) | erp-runner.js:49 claim, :104-160 | atomic claim + 15 min stuck reset (erp-runner.js:49-57; 059:84-92) | none |
| tally_voucher_records.status | pending, validated, dry_run_ok, exported, imported, failed (001:293) | push.js:206-222; retry.js:57-62, :86-94; sync.js:76-83; tally-reconciler.js:213-216, :518-521 | unique (tenant, voucher_no, payload_hash) (001:302) | none |
| tally_reconciliation_runs / findings | runs: running, ok, partial_failure, failed (095:47-48); findings: resolved_at (095:91) | tally-reconciler.js:271-278, :386-401, :525-541; findings insert :368; resolve tally/reconcile.js:202-205 ('approve') | none; each run inserts new findings, no dedup | none |
| order_term_flags | outcome and decisions (250:92-126) | _lib/terms/check.js:322-348; terms_decide.js | server for decide; send block is browser-only until #622 | critical terms row blocks 'send' in order-exceptions.js:959 (browser) |

---

## 3. Order creation paths

Eight paths, nine insert sites (H-11 Verified). No path checks payload_hash, PO number or doc fingerprint before it inserts.

| Insert | Trigger | Actor recorded | Initial status | Dedup rule | Map / blockers / reconcile / anomaly | Audit trail |
|---|---|---|---|---|---|---|
| orders/index.js:187 (+ :201 retry) | POST /orders, intake screen | ctx.user.id via recordAudit | body.status, any enum value (:35) | none (doc_fingerprint stored only, :48) | mapLinesToItemMaster (:154-165); withBlockers from the extraction run (:171-186); autoReconcileOrder (:251), which runs autoAnomalyCheck (order-reconcile.js:441-443) | recordAudit + recordEvent (:210-211) |
| quotes/convert.js:162 | POST /quotes/convert | ctx.user.id | DRAFT | quote status read, not conditional (:128, :192-197) | none; copies quote.payload_hash (:172) | recordAudit on quote, event on order (:200-214) |
| portal/reorder.js:79 | portal token | none (actor_id null) | "NEW" (invalid; insert fails) | none | none | audit_events (:104-111), never reached |
| inbound/email/draft_orders.js:75 | tick or manual drain | none (actor null) | DRAFT | inbound_emails.linked_order_id (:72-74) | none | audit_events (:78-84) |
| email/inbound.js:196 | legacy webhook, global token | role 'system' | DRAFT | reuse any DRAFT whose subject contains the new subject's first 40 chars, 7 days (:179-194) | none | recordEvent + recordAudit (:228-240) |
| inbound/process_messages.js:58 | tick or manual drain | none | DRAFT | inbound_messages status flip; external_id unique at ingest (039:39) | none | audit_events (process_messages.js:60) |
| voice/process_actions.js:54 | tick or manual drain | none | DRAFT (also for 'quote_request', :82) | voice_call_actions.completed | none | audit_events (:119-125) |
| whatsapp/inbound.js:252 | legacy webhook, global token | not confirmed | DRAFT | reuse a DRAFT whose preflight 'from' contains the sender's last 10 digits, 7 days (whatsapp/inbound.js:232-247) | none | audit + event after (not confirmed which lines) |

Only POST /orders runs the post-create steps. The workspace PATCH runs reconcile when it sends `result` (orders/[id].js:459), so an intake order gets reconciled only after a person extracts in the workspace.

---

## 4. Order write paths (updates and deletes)

Checks: T = ALLOWED_TRANSITIONS (orders/[id].js:67); R = role action gate (order-write-gate.js:57); E = approval evaluator; B = firstUnresolvedBlocker; H = payload hash restamp with approval clear; M = Mode B check. "Bypass" flags a write that skips a check that a person's write of the same field must pass.

| Write | Columns | T | R | E | B | H | M | Bypass |
|---|---|---|---|---|---|---|---|---|
| orders/[id].js:297 PATCH | any APPROVE_INPUTS column, status, approval | yes | yes | after write, best effort (:431-446) | approve only (:245) | yes (:264-295) | no | Reference path. Gaps: result at any status; approval from body (:22); status to EXPORTED_TO_TALLY, FAILED_TALLY_IMPORT, RECONCILED by hand with so.write and no push (:70-71) |
| orders/[id].js:161 resolve_finding | rule_findings | n/a | 'approve' (:154) | no | n/a | no | no | none |
| orders/[id].js:480 DELETE | row | no | 'admin' (:478) | no | no | no | no | Hard delete at any status cascades voucher records (001:290) and retry rows (016:100); the voucher idempotency record goes with it |
| orders/index.js:187 POST | all, incl. status, approval, payload_hash | no | coarse 'write' only | no | projects extraction blockers | no | no | YES: creates APPROVED or EXPORTED_TO_TALLY with a self-made approval and hash. #631 fixes |
| cron/extraction_jobs.js:808 writeback | result, preflight_payload, payload_hash, approval clear | no status check | system | no | no | yes (:803-809) | no | YES: replaces lines at any status, no CAS (L3-D14). #625 fixes |
| order-reconcile.js:354 reconcile | result, rule_findings, quote_id, quote_number, payload_hash, approval clear | auto: DRAFT/PENDING_REVIEW/BLOCKED only (order-reconcile.js:64, :413); manual reconcile_quotes.js:40: any status | so.write on manual (reconcile_quotes.js:32-34) | no | raises -MOD (order-reconcile.js:303-319) | yes | no | Manual path changes lines on any status, no CAS (guardConcurrent only on auto) |
| order-anomaly-check.js:101 | rule_findings, preflight_payload | review statuses only (:68) | system | no | keeps coded findings (:88) | no | no | none (CAS :105) |
| order-opportunity.js:108 | opportunity_id when null | n/a | caller's | no | no | no | no | none |
| tally/push.js:225 | status, tally_status | NO | 'approve' | no | yes (:144) | no | yes (:88) | YES: no status precondition; pushes and overwrites CANCELLED, DRAFT with approval jsonb (L3-D9) |
| tally/retry.js:97 | status, tally_status | NO | cron | no | no | no | yes, per tenant (:121) | YES: no tenant filter, no status check, no blocker (L3-D1, L3-D12). #631 adds cancel/approval/hash skip and tenant filter |
| tally-reconciler.js:207 auto-fix | status FAILED_TALLY_IMPORT, tally_status | NO | cron or 'write' + body autoFix | no | no | no | no | YES: any status to FAILED_TALLY_IMPORT (RECONCILED and CANCELLED included) |
| tally-reconciler.js:511 markStatus | tally_status, status | own map, conditional (:500-515) | 'approve' (tally/reconcile.js:34) | no | no | no | no | Mode B 'imported' is a hand-set end with no evidence (C-D4 accepts it as "unverified") |
| operator_actions/reconcile.js:71 | status = contract value | NO | 'write', 'approve' when it mutates (:30, :47) | no | via requireApprovedOrder (:68) | no | no | YES: any status value; flag off (operator_actions_enabled) |
| orders/attach_sales_order.js:179 | so_voucher_no | n/a | coarse 'write' (:67-68) | no | no | no | no | Header column with no so.write check; low |
| customers/merge.js:64 | customer_id | n/a | merge endpoint gate (not read) | no | no | no | no | Moves the customer of approved and exported orders; the approval stays though the hash covers customer id (payload-hash.js:57) |
| 16 ERP push/retry/sync files (sample sap/push.js:131, sap/retry.js:36, sap/sync.js:250) | result (external ids) | no | 'approve' on push | no | requireApprovedOrder (erp-runner.js:193-237) | no | NO | Retry and sync write result with no tenant filter (sap/retry.js:36). No Mode B read |

---

## 5. Voucher push paths

| Path | Entry | Idempotency check | Claim | Writes voucher record | Order status write |
|---|---|---|---|---|---|
| P1 Manual push | tally/push.js:58 | select (tenant, voucher_no, payload_hash) exported/imported (:185-194); select then post | none | upsert on the unique key (:206-222) | :225-228 unconditional |
| P2 Retry drain | tally/retry.js:118-138 via tick or 'admin' | NONE (:66-101) | none (059 claim columns unused) | only if voucher_record_id is set (:85-95) | :97-100 unconditional, no tenant filter |
| P3 Copilot enqueue | tally-enqueue.js:13 via confirm.js:83-90 | none; inserts a new pending row each confirm | n/a | no: voucher_record_id null (:43) | via P2 |
| P4 Reconciler re-push | tally-reconciler.js:222-228 | none | n/a | n/a | n/a |
| P5 PATCH by hand | orders/[id].js:70 | n/a, posts nothing | n/a | no | marks EXPORTED_TO_TALLY with no voucher |
| P6 Other ERPs | 16 x push + erp-runner drain | per connector; erp-runner claims rows (erp-runner.js:49) | yes | per connector | result only |

**Can one voucher be created twice?** Yes. Tally has no key: ACTION="Create" (tally-build-voucher.js:335), no REMOTEID.

1. **P1 then P2 (Verified, live wherever the tick runs).** A push gets a recoverable error (5xx, 429, timeout). Push writes record 'failed' and queue row R1 (push.js:204-247). A bridge timeout can happen after Tally has already imported the voucher (Inferred). The person clicks Push again. The idempotency read finds 'failed', not 'exported', so it posts: voucher V1. R1 is still pending. The next drain replays R1 with no check (retry.js:66-77): voucher V2. #631's skipReason checks only cancel, approval and hash (631.diff retry.js), so it does not stop this.
2. **P1 twice concurrently (Inferred).** Two tabs, or a double click, both pass the select at push.js:186 before either upsert at :206. Both post.
3. **P3 then P1 (Verified).** The copilot enqueue writes no voucher record. P2 posts it and marks no record (retry.js:85). A later P1 finds no exported record and posts again. P3 twice queues two rows; P2 posts both.
4. **Two overlapping P2 drains (D-3, Verified shape).** Both select the same pending rows (retry.js:124-131). Also a drain that cron-mux "times out" keeps running (Promise.race at cron-mux.js:142 does not cancel) while the next tick starts (Inferred).
5. **P4 (dead at base, live with #632).** At base the insert fails (columns 016:96-113) and the finding still says 're_pushed'. #632 routes it through enqueueTallyVoucher with one re-push per voucher record. Because the state read is broken (L3-D2), every exported voucher of the last 7 days reads as missing, so with auto-fix on, #632 re-pushes every one of them once. This is the top conflict in the layer.

Mode B: P1 and P2 refuse (push.js:88; retry.js:121). P3 queues in Mode B; the rows wait and post if the tenant later switches to A (Inferred; #631's hash check limits it to unchanged orders). P5 and P6 do not read the mode.

---

## 6. Mode B: what ends an order on main

- **Status.** A Mode B order stays APPROVED (cohesion 1.2 seam 1, re-verified: no Mode B writer moves it on). The next step is a disabled "enter the SO in Tally by hand" (order-next-step.js:120-122).
- **Records that exist.** `orders.so_voucher_no` from a Tally SO attach (attach_sales_order.js:179); an order_documents row with role 'sales_order' (attach_sales_order.js:144); `orders.tally_status = 'imported'` from markStatus (tally-reconciler.js:507). 'reconciled' is refused unless the order is EXPORTED_TO_TALLY (tally-reconciler.js:504-506), so in Mode B it cannot be set at all on main.
- **Mechanism.** Only a person with 'approve' who calls POST /tally/reconcile {mode:'mark', status:'imported'} writes an end marker (tally/reconcile.js:33-48). No evidence check. Nothing reads the bridge for Mode B orders (sync.js:76-83 updates only vouchers Anvil pushed).
- **handoff_status.** Columns exist (251:82-93). No writer on main.
- **#626 adds** `_lib/order-stage.js`, a pure stage ladder. Mode B: approved, handed_off (handoff_status 'sent' and payload hash unchanged), keyed_unverified (tally_status 'imported', no SO PDF), keyed (an attached sales_order document), verified (tally_status 'reconciled'). Mode A: keyed = EXPORTED_TO_TALLY, verified = RECONCILED. It writes nothing. It reads `handoff_payload.payload_hash`, which only #630 writes. Gap: 'verified' in Mode B needs tally_status 'reconciled', and no path on main or in #626 writes it for Mode B (C-12 is not built).
- **#630 adds** POST /orders/handoff: Mode B and order_handoff_enabled only; sends in the request through sendCommunication; writes handoff_status, handoff_sent_at, handoff_sent_by, handoff_comm_id, handoff_payload, dispatch_plan (630.diff orders/handoff.js). Blockers: status in CANCELLED/DUPLICATE/REUSED/BLOCKED, an undecided critical terms flag, recipients. It does not read rule_findings blockers, so an order with an unresolved line-count shortfall or -MOD finding can be handed to the clerk who keys it. In Mode B the handoff is the point of no return, as the push is in Mode A, but the two use different gates. Double send: a documented shortcut (no conditional claim).

---

## 7. Exceptions and blockers

| Source | Where | Stored? | Blocks on server? |
|---|---|---|---|
| Derived exception rows | order-exceptions.js (buildOrderExceptions), GET orders/exceptions.js:69 | no | no; rows with blocks 'send' are read in the browser only (order-next-step.js:93, :109-112) |
| rule_findings blockers (line_count_shortfall, -MOD) | blocking-findings.js:23-31; mod-parts.js:111-121 | orders.rule_findings | yes on approve (orders/[id].js:245) and every push (push.js:144; erp-runner.js:223-236). Not on send. Not on handoff (#630) |
| Anomaly rule findings | order-anomaly-check.js:59-110 | rule_findings (no code) | no |
| Client "Run validation" | so-workspace.tsx:1127-1173 | replaces rule_findings | drops coded findings except source 'extraction' (blocking-findings.js:62-68): L3-D4 |
| validation_findings | findings/index.js:11-42 | table 001:228 | no gate reads it |
| order_term_flags | _lib/terms/check.js | table 250:92 | no on main; critical row blocks 'send' in the browser (order-exceptions.js:959); off by default (250:203) |
| quote_approvals | approval-evaluator.js:56-94 | table 006:622 | no |
| Duplicates | duplicates/search.js:40 (manual score) | no | no; DUPLICATE is hand-set only |
| Tally reconciliation findings | tally-reconciler.js:368 | table 095:66 | no; auto-fix may move status |
| Fallback copies (-MOD verdict without a finding, shortfall on the run only) | order-exceptions.js:708, :885 | no | no |

**One blocker rule on the server for every move?** No. There is one predicate (`isUnresolvedBlocker`) for stored blockers, and it gates approve and push. Send has no server check. Handoff (#630) has its own terms-only check. The writes in section 4 marked "bypass" pass no blocker check. A writer with so.write can clear any blocker without 'approve': send rule_findings that carry the code with resolved:true; mergeBlockersForward sees the code and does not carry the prior one (blocking-findings.js:64-66; orders/[id].js:170). #622 keeps this hole (it widens carry-forward to all blockers but still trusts an incoming entry with the same code). L3-D5.

---

## 8. Signal verdicts

| Signal | Verdict | Evidence |
|---|---|---|
| H-9 (Tally part) | Confirmed | Tally give-up writes queue and record status only (tally/retry.js:50-64); push failure writes no notice (push.js has no notifyAdmins); erp-runner rings the bell (erp-runner.js:123-132) and even links tab 'tally', but Tally never runs through it. failed_push_recovery is armed by hand only (agents/_handlers/index.js:50; no other caller). #611 section 2 is wrong for Tally |
| H-11 | Confirmed | Eight paths, nine insert sites (section 3). No shared dedup. Writeback rewrites lines with no status check (extraction_jobs.js:785-810). order-write-gate.js is a role gate only (order-write-gate.js:49-60) |
| H-12 | Confirmed, with a correction | Live duplicate paths: P1 then P2, P1 twice, P3 then P1, overlapping P2 (section 5). The reconciler path cannot push at base (insert fails), but #632 revives it and L3-D2 makes it fire for every exported voucher. tally-enqueue.js does not check Mode B; the drain refuses (retry.js:121) |
| H-15 | Confirmed | Legacy route router.js:1030; global token (email/inbound.js:127-135); tenant from header (:140); regex intent (:25-32); DRAFT insert (:196); never writes inbound_emails. New: subject-substring reuse merges different customers' mail into one DRAFT (:179-194). Whether a provider still posts: not confirmed (env and owner query 6) |
| D-2 | Confirmed | tally/retry.js:50-64 and netsuite/retry.js have no notifyAdmins; erp-runner.js:123 does |
| D-3 | Confirmed | Select then replay (tally/retry.js:124-136); claimed_at (059:84-87) unused |
| D-7a PATCH accepts result on APPROVED | Confirmed | orders/[id].js has no status check for content keys (:141, :264-269). The approval clears and the status stays APPROVED. #631 adds a screen-only rule (so-workspace LINE_EDIT_STATUSES); the server still accepts |
| D-7b FAILED_TALLY_IMPORT has no move to DRAFT | Confirmed | orders/[id].js:72. Exit is CANCELLED, or APPROVED (re-approve with hash) then DRAFT |
| D-7c skipped retry stored as gave_up | Partly (not at base) | Base has no skip. #631 adds markSkipped, which writes status 'gave_up' with 'skipped::' (631.diff tally/retry.js), a documented shortcut; tally/health counts it as a give-up |
| D-7d reconciler update errors unchecked | Confirmed, wider | tally-reconciler.js:207-216, :222-228, :246-250, :345-350, :386-401 never read the error; the state read error is not read either (:319-330), which causes L3-D2 |

---

## 9. Open PR overlay

| PR | What changes in the cards | Residual or new conflict |
|---|---|---|
| #622 order move gate | M-33/M-34: PATCH refuses PENDING_REVIEW and APPROVED while a 'send' row is open (order-move-gate.js, 503 when inputs fail); mergeBlockersForward carries every unresolved blocker, so L3-D4 closes (C-3); shared reader order-exceptions-inputs.js | Gate covers PATCH only: push, retry, auto-fix, operator actions, POST, writeback and handoff stay outside. L3-D5 stays. Its branch context predates the removal of payload_hash from APPROVE_INPUTS (622.diff orders/[id].js hunk); git reports a clean merge, re-run its tests after rebase. Conflicts with #625 (below) |
| #625 writeback guard | M-11/M-33: writeback writes lines only on DRAFT, holds lines on later statuses as a blocking finding `lines_changed_after_review` (source 'extraction'), PENDING_REVIEW/APPROVED go to DRAFT; CAS on updated_at; every stage CAS; cancel refuses 'merging'. Closes L3-D14, L3-D15 | In-flight job row (blocks 'send') is read only in orders/exceptions.js. #622 moves input reading to order-exceptions-inputs.js; after both merge, the server gate does not see an in-flight job unless the read moves into the shared reader. L3-D16 (no job attempt cap) stays |
| #626 order stage | M-37/M-34: stage, holder_role, next_action on every order endpoint; Mode B end defined by records (section 6) | Writes nothing; 'verified' in Mode B has no writer. Stage reads handoff_payload that only #630 writes |
| #627 Mode B no TTL | M-33: no expiry in Mode B; ttlHours no longer from the body | tally/push.js still ignores expiry in Mode A (L3-D9) |
| #628 (server) lane readiness | M-37 Q14: GET /admin/lane_readiness reads flags, migrations, cron/tick and cron/daily last run, mail provider; exports probeCron from health.js | Read only. It does not use heartbeat-check.js's map, so it inherits health.js's 10 min bound for sub-handlers (H-3) |
| #629 (server) one money helper | M-33: approvals queue value_inr = orderValue() (grand total, else line sum) | approval-evaluator.js:31-34 still reads grandTotal or amount_inr (no such column): the queue shows a value while threshold matching sees 0 for a PO with no printed total (L3-D13 widens) |
| #630 handoff send | M-37: first writer of handoff_status; direct send through sendCommunication; draft row, never queued | No rule_findings blocker check before handoff (section 6); double send is a documented shortcut; terms check reads the same flags as #622 by a different function |
| #631 five defects | M-32: POST always DRAFT, no approval, so.write. M-33: approval removed from APPROVE_INPUTS. M-36: retry reads the order (tenant-scoped) and skips cancelled, unapproved or changed orders; tenant filter on the order update | Retry still has no voucher-record check and no claim (L3-D1, D-3). Skip stored as gave_up (D-7c). Server still accepts result on APPROVED |
| #632 reconciler re-queue | M-36: re-push goes through enqueueTallyVoucher, one per voucher record; refuses CANCELLED; failure is 're_push_failed' | HIGH RISK with L3-D2: every exported voucher reads as missing, so every one is re-pushed once when auto-fix is on. Fix L3-D2 first, or merge #632 with auto-fix forced off |

---

## 10. O-2 rows (mechanism by job)

| M | Schedule | Claim and lease | Retry and give up | Dedup | Decide (policy) | Act on an order | Send outside | Notify a person | Track human work | Escalate | Record the trail | Report health |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M-25 | webhook router.js:759 | | provider only | message_id 028:69; dup_hash inbound-email.js:93 | | | Graph fetch webhook.js:172 | | | | audit_events webhook.js:246 (actor null) | |
| M-26 | tick ALWAYS tick.js:163 | none (select) parse.js:120 | 'failed' terminal parse.js:111 | status filter | LLM email-classifier.js:94; regex parse.js:35 | | LLM | | | | none | cron_health default |
| M-27 | tick tick.js:176 | none; 80-row window persist_attachments.js:51 | forever, no cap persist-attachments.js:186 | sha256 persist-attachments.js:66 | ClamAV | | storage, ClamAV | event av_scan_unresolved persist-attachments.js:145 | | | audit manual only | cron_health default |
| M-28 | tick tick.js:177 | status flip queue-runner.js:66 | 'failed' terminal queue-runner.js:105 | linked_order_id draft_orders.js:72 | | INSERT DRAFT draft_orders.js:75 | | | | | audit_events draft_orders.js:78 | cron_health default |
| M-29 | webhook router.js:1030 | | | subject reuse email/inbound.js:179 | regex intent :25 | INSERT DRAFT :196 | storage | | | | event + audit :228 | |
| M-30 | tick tick.js:180 | none; fixed window auto_ocr.js:55 | none auto_ocr.js:73 | runs by source_id :68 | | none | OCR, LLM :133 | review queue via run.js | | | audit_events :152 | cron_health default |
| M-31 | screen | claim, unconditional review_queue.js:107 | | unique (tenant, run) 123 | person | | | | assigned_to, status | | recordAudit :137 | |
| M-32 | screen, portal | | | none; quote status convert.js:128 | | INSERT index.js:187, convert.js:162, reorder.js:79 | | | | | recordAudit index.js:210 | |
| M-33 | PATCH | none (no CAS) [id].js:297 | | hash compare :218 | T :67, R gate :144, blocker :245, evaluator :432 | UPDATE :297 | | none | quote_approvals rows (role only) approval-evaluator.js:80 | | recordAudit/Event :411 | |
| M-34 | read; inline after reconcile | anomaly CAS order-anomaly-check.js:105 | event on fail :133 | once per hash :79 | DEFAULT_AGENT_POLICY order-exceptions.js:225; nextStep order-next-step.js:89 | rule_findings order-anomaly-check.js:101 | | | none (no owner) | | events only | |
| M-35 | screen; copilot confirm | none push.js:185 | enqueue push.js:245 | voucher record 001:302 | approval, blocker, variance, Mode B push.js:88-147 | status push.js:225 | Tally bridge push.js:196 | none | | | recordAudit/Event push.js:230 | |
| M-36 | tick RETRIES tick.js:89; SYNCS :109-113; hourly :204 | none retry.js:124 | backoff retry.js:26; gave_up :50 | none on replay | tolerance, auto-fix flag tally-reconciler.js:263 | status retry.js:97; reconciler :207 | bridge; Stripe/Razorpay drift-meter.js | none | | | runs/findings 095; audit manual only retry.js:102 | cron_health tally/sync 75 min heartbeat-check.js:23 |
| M-37 | admin screen | | | | isModeB so-processing-mode.js:33 | | | | | | recordAudit so_processing_mode.js:102 | |

Classes for O-2 (to the synthesis): **Divergent**: dedup (columns "Dedup" in M-25, M-28, M-29, M-32), blocker rule (M-33 vs M-35 vs #630), retry (M-36 vs M-9). **Double fire**: P1/P2/P3 voucher paths. **Dead**: portal reorder, reconciler re-push, findings GET, handoff_status. **Gap**: "Notify a person" and "Escalate" are empty for every L3 mechanism; "Track human work" holds only role-level quote_approvals and the review queue claim.

---

## 11. New mechanisms (new in the audit)

| N | Mechanism | Entry | Writes | Note |
|---|---|---|---|---|
| N-1 | EDI inbound | edi/inbound.js:22-56 (router.js:747) | edi_envelopes only | Header says it links an 850 to an order; it does not. 'approve' |
| N-2 | ERP SO attach | orders/attach_sales_order.js:59 | so_voucher_no (:179), order_documents role sales_order (:144) | Coarse 'write' only; the only Mode B evidence writer |
| N-3 | Document OCR | documents/ocr.js:24 | ocr_runs, evidence | No order write |
| N-4 | DocAI sync extract | docai/extract.js:54 | extraction_runs, review queue | Page-1 shunt over 40 pages (:137-142); the client enqueues the job and writes lines by PATCH or POST |
| N-5 | Job enqueue and cancel | orders/extraction_jobs.js:137; extraction_jobs_id.js:45-56 | extraction_jobs | so.write; one in-flight per order (202:17) |
| N-6 | Manual quote reconcile | orders/reconcile_quotes.js:40 | result, rule_findings, payload_hash | Any status, no CAS |
| N-7 | Tally reconcile endpoint | tally/reconcile.js:33-110, :202 | markStatus; driftCheck; findings resolve | drift_check takes autoFix from a 'write' body |
| N-8 | Customer merge | customers/merge.js:54-64 | orders.customer_id | Any status; approval kept |
| N-9 | Operator action reconcile | operator_actions/reconcile.js:71 | orders.status | L2 M-19 but an L3 write; any status value |
| N-10 | Order delete | orders/[id].js:477-484 | delete | Cascades voucher records |
| N-11 | Server reconcile + anomaly trigger | order-reconcile.js:404-446; order-anomaly-check.js:115 | result, rule_findings | The only shared post-write step; called by POST, PATCH and the writeback |
| N-12 | ERP connector result writes | 16 x push/retry/sync (sample sap/*.js) | orders.result | One class; no Mode B |

---

## 12. Defects found, not fixed

High (8)

| ID | Where | Failure scenario | Fix in one line |
|---|---|---|---|
| L3-D1 | tally/retry.js:66-101; push.js:245-247; tally-build-voucher.js:335 | A push times out and queues R1; a person re-pushes and it succeeds; the drain replays R1 and Tally creates a second voucher. #631 does not stop it | Before replay, skip when a voucher record for (tenant, voucher_no, payload_hash) is exported or imported; claim rows with claimed_at |
| L3-D2 | tally-reconciler.js:325-330 vs 016:163-176 | The state select names voucher_no, line_count, party_gstin; the error is unread; every exported voucher becomes an 'error' finding each run; meter rows bill those runs (:409); with #632 and auto-fix, every voucher is re-pushed once | Select external_voucher_no etc., read the error, match on tally_voucher_id or external_voucher_no; hold #632 until fixed |
| L3-D3 | inbound/email/parse.js:119-129, :146-149; persist_attachments.js:51-54, :126-128; cron/tally-reconcile.js:20-70, :88-90; cron/drift-meter.js:152-156; (D-1) voice/process_actions.js:149-150 | One tenant's approver or admin runs another tenant's classification, storage, drift checks, auto-fix and billing, and reads their ids in the response | Pass ctx.tenantId into each drain, as draft_orders.js:142 and auto_ocr.js:223 already do |
| L3-D4 | so-workspace.tsx:1160-1163; blocking-findings.js:62-68; mod-parts.js:111-121 | "Run validation" replaces rule_findings; the -MOD blocker has no source and is dropped; reconcile re-raises it only on a hash change, so the order can then be approved | Fixed by open #622 (carry every unresolved blocker) |
| L3-D6 | inbound/email/persist_attachments.js:51-57 | After 80 inbound emails, the worker reads the same oldest 80 rows forever; new PO attachments never reach storage | Select only rows with pending bytes (flag or status), with an attempts cap |
| L3-D7 | inbound/email/draft_orders.js:94-103; 001:169-174 | The order_documents upsert names tenant_id, which the table lacks; the error is unread; email PO documents never link to the draft order, so auto OCR never sees them; the email is archived, so no later pass links them | Drop tenant_id, read the error, and link in persist_attachments when linked_order_id is set |
| L3-D30 | orders/index.js:35, :58-59, :127; orders/[id].js:22 | A coarse 'write' role creates an order as APPROVED or EXPORTED_TO_TALLY with its own approval and hash; a so.write PATCH writes an approval nobody gave | Fixed by open #631 |
| L3-D31 | orders/[id].js:70-71 | A so.write user moves APPROVED to EXPORTED_TO_TALLY (and on to RECONCILED) by PATCH, in Mode A or B, with no voucher: a hand-set ERP state | Remove ERP states from the PATCH table; only push, retry and markStatus write them |

Medium (12)

| ID | Where | Failure scenario | Fix in one line |
|---|---|---|---|
| L3-D5 | blocking-findings.js:64-66; orders/[id].js:170 | A so.write user sends {code, resolved:true} and clears a blocker that needs 'approve' to resolve; #622 keeps this | Carry the prior blocker unless the incoming entry is still unresolved; only resolve_finding sets resolved |
| L3-D8 | inbound/auto_ocr.js:43-62 | The 20 oldest clean, linked documents are read every tick; once all are extracted or ineligible, nothing new is OCR'd | Exclude extracted documents in the query (anti-join or a flag) |
| L3-D9 | tally/push.js:107-147, :225-228 | A CANCELLED order keeps its approval and can be pushed; push writes EXPORTED_TO_TALLY over CANCELLED; an expired approval or an approval_actions list without export_tally does not stop it | Require status APPROVED or FAILED_TALLY_IMPORT, unexpired approval, and a conditional status update |
| L3-D10 | tally/push.js:185-206 | Two concurrent pushes both pass the select and both post | Insert or claim the voucher record 'pending' first, on the unique key, then post |
| L3-D11 | _lib/tally-enqueue.js:13-56 | Copilot enqueue writes no voucher record and checks no Mode B, blocker or status; a later manual push posts again; queued Mode B rows post after a switch to A | Create the voucher record at enqueue and reuse push.js's checks |
| L3-D12 | tally/retry.js:96-109 | Retry success writes EXPORTED_TO_TALLY by id with no tenant filter or status condition, and leaves no audit row on the cron path | Tenant filter (in #631), conditional status, recordAudit with a system actor |
| L3-D13 | orders/[id].js:210-257; approvals.tsx:282-292; approval-evaluator.js:31-34 | Pending threshold rows never stop an approve; the screen closes them afterwards; a PO with no printed grand total never matches an amount threshold | Server approve refuses while a PENDING row for a role exists; evaluator uses orderValue() |
| L3-D14 | cron/extraction_jobs.js:785-810 | Background lines replace reviewed lines on any status, with no CAS | Fixed by open #625 |
| L3-D16 | cron/extraction_jobs.js:127-156 | A step killed by the platform leaves the lease to expire; the job retries every tick forever (attempts written at :145, never read) | Fail the job above a job-level attempts cap |
| L3-D17 | email/inbound.js:127-140, :179-194 | A global-token holder writes DRAFTs into any tenant by header; a new email joins any DRAFT whose subject contains its first 40 chars | Retire the route, or route it through inbound_emails with per-tenant auth |
| L3-D19 | so-processing-mode.js:1-11; 16 ERP push/retry files; tally-enqueue.js; orders/[id].js | A Mode B tenant on a non-Tally connector still gets pushes; the copilot queues; the PATCH marks exported | Read isModeB in requireApprovedOrder and erp-runner, and in the order write gate |
| L3-D23 | _lib/inbound-email.js:26-33, :93-109 | A second PO from the same domain with the same subject and opening text within 7 days is stored as 'duplicate' and never drafted (attachments not hashed) (Inferred) | Add attachment sha256 list to the hash, or skip dup_hash when attachments differ |

Low (11)

| ID | Where | Failure scenario | Fix in one line |
|---|---|---|---|
| L3-D15 | cron/extraction_jobs.js:306-314, :402-414, :425-427, :560-568 | A cancel during a step is overwritten back to chunking or extracting | Fixed by open #625 |
| L3-D18 | tally/reconcile.js:66, :84-92 | A 'write' user forces auto-fix on through the body, overriding the tenant setting | Read autoFix from settings only, or require 'approve' |
| L3-D20 | voice/process_actions.js:82 | A voice quote request becomes a sales order DRAFT | Route quote_request to an RFQ or quote draft |
| L3-D21 | portal/reorder.js:82; 001:117-122 | Every portal reorder fails: "NEW" is not an order_status value | Insert DRAFT and add a test |
| L3-D22 | _lib/inbound-email.js:84-91; inbound/email/webhook.js:148, :177-192 | A Graph stub never completes; every stub shares one dup_hash | On a message id hit with a stub, update the row with the fetched content |
| L3-D24 | findings/index.js:11-43; anomaly.tsx:46-48 | The anomaly screen GETs /api/findings and always gets 405 | Add a tenant-scoped GET or remove the call |
| L3-D25 | whatsapp/inbound.js:270-271; 001:94-107 | WhatsApp documents are linked through documents.order_id and role, columns that do not exist; never linked | Write order_documents |
| L3-D26 | tally/sync.js:5-7, :76-83; tally-reconciler.js:290-293 | Header claims orders.tally_status updates; none. An altered voucher becomes 'imported' and leaves the reconciler's 'exported' scan | Fix the header; keep status, record 'altered' in drift columns |
| L3-D27 | cron/tick.js:110-113; cron-mux.js:193 | Reconcile is said to run after sync, but the SYNCS group runs in parallel | Run tally/reconcile after the SYNCS group |
| L3-D28 | quotes/convert.js:128-132, :192-197 | A double click converts one quote into two orders | Make the quote update conditional on its prior status before the insert, or after with rollback |
| L3-D29 | orders/attach_sales_order.js:67-68 | Finance or procurement with coarse 'write' sets so_voucher_no | requireAction so.write |

Totals: 8 high, 12 medium, 11 low (31). L3-D4, L3-D14, L3-D15 and L3-D30 are fixed in open PRs (#622, #625, #631).

Owner queries to add to plan 6.4 (counts only):

- N-1: `tally_reconciliation_findings` grouped by finding_kind for the last 30 days (all 'missing_in_tally' confirms L3-D2 is live).
- N-2: count of `inbound_emails` rows whose attachments contain a `content_b64` key, and the total row count (over 80 confirms L3-D6 is live).
- N-3: count of `orders` with preflight_payload.source = 'inbound_email' that have zero order_documents rows (confirms L3-D7).
- Add `tally_drift_addon_enabled` and `tally_recon_auto_fix_enabled` to query 4.

---

## 13. Target model notes

| M | Verdict | Reason |
|---|---|---|
| M-25 | Keep, adapt onto the intake front door | Good signature and message-id dedup; becomes the email adapter of one intake |
| M-26 | Adapt onto the queue contract | Needs claim, attempts and tenant-scoped manual drain |
| M-27 | Adapt onto the queue contract | Needs a pending flag, a cap and a moving window; link documents here |
| M-28 | Merge into the intake front door | One creator with one dedup and the post-create steps |
| M-29 | Retire | Duplicates M-25 with weaker auth and a cross-customer merge rule |
| M-30 | Adapt (queue contract), then merge into the intake post-create step | OCR result should reach the order; fix the window |
| M-31 | Merge into the work item record (H-6 decision) | Only claim flow; needs owner, due time and link to the order |
| M-32 | Merge into the intake front door (POST, convert, reorder) | Same insert, same dedup, same post-create; reorder is broken anyway |
| M-33 | Keep as the core of ONE order write gate | It already holds the transition table, role gate, hash binding |
| M-34 | Keep the builder; move enforcement into the gate | One list exists; the server must read it for every move (#622 starts this) |
| M-35 | Adapt onto the gate and a voucher-claim primitive | Needs status, expiry and claim-first idempotency |
| M-36 | Adapt retry onto the shared queue contract (erp-runner shape); fix and gate the reconciler; keep sync | Tally keeps a private copy without claim or bell |
| M-37 | Keep; read Mode B inside the gate | One switch, read by every ERP-state write |

**ONE order write gate.**

- *Where.* Extend `_lib/order-write-gate.js` into `applyOrderWrite(svc, ctx, orderId, change, { actor })`. `orders/[id].js` already imports it.
- *What it checks, in order.* (1) Authority: a person's role action (today's `orderPatchAction`), or for an agent or system actor the `so_controls` autonomy map (R-M2, migration 266). (2) Status rule: ALLOWED_TRANSITIONS moved here from `orders/[id].js:67`, without ERP states for hand moves, plus a content rule (result and rule_findings writable only in DRAFT, PENDING_REVIEW, BLOCKED; later statuses hold lines as #625 does). (3) Blockers: `isUnresolvedBlocker` plus the #622 move rows, for send, approve, push and handoff alike. (4) Approval binding: `payloadHashAfterWrite` and `approvalClearedByContentChange`, expiry and approval_actions. (5) Mode B: refuse ERP-state moves and pushes. (6) Compare-and-set on `updated_at`. (7) One audit row and one event with the actor kind.
- *First writers to move.* The writes marked "bypass" in section 4 that touch status: `tally/push.js:225`, `tally/retry.js:97`, `tally-reconciler.js:207`, `operator_actions/reconcile.js:71`, then the writeback (#625 logic), then the POST initial row, then the handoff columns (#630). Each move is one PR that ships its caller.

**ONE intake front door.**

- *Where.* `_lib/order-intake.js` with `createOrderFromIntake(svc, ctx, { source, sourceRef, customerHint, documentIds, lines, actor })`.
- *Shared dedup.* A key ladder: (a) the source reference (email message id, chat external id, voice action id, quote id, portal reorder id), held in a unique (tenant_id, intake_source, intake_ref) index (needs a migration from 271); (b) a document sha256 already linked to an open order: link, do not create; (c) the same customer and PO number within N days: create as a duplicate candidate row in the exceptions list, never silently merge.
- *Same post-create steps.* Insert DRAFT with no approval; server customer match (R-F6); link documents in `order_documents`; `mapLinesToItemMaster`; project extraction blockers; `autoReconcileOrder` then `autoAnomalyCheck`; enqueue extraction for linked PO documents; one audit and event row; a notice to the owner (#624).
- *Callers.* M-28, M-29 (then retire), M-20, M-21, M-22, POST /orders, quotes/convert, portal reorder. The writes after creation go through the order write gate.

What I did not check: L2 handlers (handle_replies, WhatsApp, voice webhook) beyond their order inserts; the 15 non-Tally connectors one by one (SAP read as the sample); screen code beyond the rules named here. Every "live" cell needs the owner queries.

---

# L4. Attention and messages: audit cards M-38 to M-46

Auditor: L4. Base: `origin/main` at `931eb143`. All `path:line` references are at that commit. Paths under `src/api/` drop the prefix where the meaning is clear (`_lib/x.js` is `src/api/_lib/x.js`). Screens are under `src/v3-app/`. Migration references are `NNN:line`. Open PR references name the PR and the file in its diff.

Labels (plan 6.1): **[V]** verified in code. **[I]** inferred, with the steps written. **[NC]** not confirmed. "Wired" is not "live". No live query was run. Every "live" answer waits for the owner queries in plan 6.4.

Defects found here are numbered L4-D1 to L4-D28 (section 11). Seed defects D-2, D-4, D-5 and D-6 map to L4-D8, L4-D6, L4-D7 and L4-D28.

---

## 1. Cards

### M-38 Bell (`admin_notifications`)

```
M-38  Bell (admin_notifications)                                   layer: L4
status on main: wired
live: not confirmed (owner query 3).
      [I] Daily-path callers can write rows on the Vercel schedule:
      cron/eval_quality_alert.js:69 (daily.js:82), eval/replay.js:300 (daily.js:95).
      The SO callers run only from the tick: erp-runner.js:123, :152 (tick RETRIES),
      agents/run.js:120 (tick hourly, tick.js:194-199). See H-1.
Q1  job: show a notice in the desktop header for the tenant. _lib/notifications.js:1-17;
    table purpose 042:83-87. Plan: none named in the file.
Q3  trigger: inline helper notifyAdmins (_lib/notifications.js:34). 12 calls in 7 files:
    plm/sync.js:74, :172, :190; agents/run.js:120; _lib/erp-runner.js:123, :152;
    _lib/inventory/notifications.js:94; _lib/logistics/notifications.js:40, :175, :213;
    eval/replay.js:300; cron/eval_quality_alert.js:69. One direct insert:
    auth/signup.js:134. Read by a 30 s poll while the tab is visible:
    components/Shell.tsx:23, :106-118.
Q4  unit of work: one admin_notifications row (042:89-117). State: resolved
    false/true (042:112). Read state: read_by uuid[] (042:108).
    Writers: _lib/notifications.js:87 (create); admin/notifications.js:59-61 and
    :90-92 (read); :69-77 (resolve); admin/access_requests.js:46 (resolve).
Q5  claim: none.
Q6  retry: none. A failed insert is logged and dropped (_lib/notifications.js:90-93).
Q7  dedup: optional. Unresolved row with the same tenant, kind and
    link_params.dedup_key in the last 5 minutes (_lib/notifications.js:50-60).
    No unique index. No recipient in the key.
Q8  tenant: service client. Every query filters tenant_id (_lib/notifications.js:54,
    :67; admin/notifications.js:32, :55, :77, :86). The updates at
    admin/notifications.js:59-61 and :90-92 filter on id only, after a
    tenant-scoped read. RLS keys on a tenant_id JWT claim (042:128-140).
Q9  authority: GET needs "read" (admin/notifications.js:26). It returns every
    unresolved row of the tenant to every viewer role. POST needs "admin"
    (admin/notifications.js:43). The screen shows the bell to admin and
    operator only (Shell.tsx:96, :175, :600). The roles in notifyAdmins only
    decide whether to insert (_lib/notifications.js:65-71). They do not go on
    the row (:73-86).
Q10 outside effects: none.
Q11 order writes: none.
Q12 failure goes to: console.warn (_lib/notifications.js:91). Nobody sees it.
Q13 trail: the row itself (actor_user_id, resolved_by, resolved_at). No
    audit_events row on create, read or resolve.
Q14 health: none.
Q15 config: none. Default roles ['admin'] (_lib/notifications.js:36).
Q16 tests: api-notify-admins-dedup.test.js, api-eval-quality-alert.test.js,
    components/Shell.test.tsx. No test of admin/notifications.js on main.
Q17 overlaps: M-39 (per-user push), M-44 and M-45 (notified stamps), #624
    notify(), #640 ledger.
Q18 owner plan: C-17 (R-F5, WM-7) in #624 with migration 253; C-19 adds events.
notes / defects: L4-D11 (operator cannot mark read), L4-D17 (GET open to every
    role), L4-D18 (no row when the role has no member), L4-D24 (signup
    duplicates). MobileShell has no bell (components/MobileShell.tsx:12-18).
```

### M-39 Web push

```
M-39  Web push                                                     layer: L4
status on main: wired, not scheduled
live: no. [V] Code proves nobody can subscribe. subscribeToPush
      (lib/push.ts:37) has no caller in src/v3-app or src/client. The VAPID
      public key route that lib/push.ts:4 names does not exist in
      router.js:651-653 (only subscribe, unsubscribe, send). With no
      push_subscriptions row, every drained row fails "no active
      subscriptions" (push/send.js:40-43).
Q1  job: send a Web Push notice to a user's browser. push/send.js:1-9;
    021:1-5.
Q3  trigger: drain in tick ALWAYS (cron/tick.js:153). Manual POST to queue one
    (push/send.js:80-101). No screen calls AnvilBackend.push.send
    (src/client/anvil-client.js:432 is the only definition).
Q4  unit of work: push_notifications row (021:37-51). status queued, sent,
    failed, expired (021:46). Writers: push/send.js:85 (queued), :41
    (failed, no subs), :58-63 (sent or failed).
Q5  claim: none. Select of 50 queued rows, all tenants (push/send.js:20-23).
    Two overlapping drains send the same row twice. [I]
Q6  retry: none. failed is final. attempt_count is written (push/send.js:61)
    and never read.
Q7  dedup: none on notices. Subscriptions unique per tenant, user and
    endpoint (021:25-26).
Q8  tenant: drain reads all tenants (push/send.js:20). Subscription lookups
    filter tenant_id (:33, :37) except by subscription_id (:29). The manual
    POST accepts any subscription_id (:88). [I] low risk, ids are uuids.
Q9  authority: manual POST needs "approve" (push/send.js:82). Drain needs
    CRON_SECRET (:73-77).
Q10 outside effects: HTTPS POST to the browser push service
    (_lib/web-push.js:113-120). VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
    (_lib/web-push.js:18-22). Missing keys give skipped (:114-115).
Q11 order writes: none.
Q12 failure goes to: the row error column (push/send.js:41, :62). No reader.
Q13 trail: audit push_notification_queued on manual POST (push/send.js:95-100).
Q14 health: heartbeat "push/send" from the tick result loop (cron/tick.js:239-244),
    default 10-minute bound (_lib/heartbeat-check.js:49).
Q15 config: VAPID env vars only.
Q16 tests: none found for push/send.js or _lib/web-push.js.
Q17 overlaps: M-38 (the only working notice), #624 (bell on phone instead).
Q18 owner plan: C-20 (second channel, decision C-D16); none built.
notes / defects: L4-D20 (a row is marked sent when every subscription is
    non-web). Retire or finish; do not leave half.
```

### M-40 Communications record

```
M-40  Communications record                                        layer: L4
status on main: wired
live: not confirmed (owner queries 2 and 6).
Q1  job: one row per outbound or logged message, in one shape.
    _lib/comms-row.js:1-20; table 005:22; widened by 189:79-95.
Q3  trigger: inline. 19 insert sites: invoices/send.js:177, copilot/confirm.js:48,
    quotes/send.js:447, comms/service_report.js:131, comms/payment_statement.js:104,
    comms/dispatch_register.js:98, agents/run.js:165,
    _lib/dispatch-register-send.js:108, _lib/inventory/notifications.js:113,
    _lib/logistics/notifications.js:192, supplier_rfq/send.js:94,
    marketing/send.js:63, sourcing/network/handoff.js:78, whatsapp/send.js:94,
    communications/log.js:82, communications/missing_doc.js:49,
    communications/draft.js:57, cron/drift-report.js:112, prospecting/run.js:97.
Q4  unit of work: communications row. status draft, queued, sent, failed,
    replied, archived (_lib/comms-row.js:33-35; CHECK 005:34 widened 189:79-95).
    "manual" and "pending_send" map to queued (_lib/comms-row.js:50-53).
    Unknown status maps to queued (:94). channel defaults to "email" (:91).
Q5  claim: none (see M-42).
Q6  retry: none on the record.
Q7  dedup: none. No unique key. sendCommunication is idempotent on sent and
    replied (_lib/comms-send.js:110). Quote send has no guard against a
    second queued row on main. [V] quotes/send.js:447.
Q8  tenant: each writer sets tenant_id. sourcing/network/handoff.js:78-80 writes
    into another tenant (the listing owner) on purpose.
Q9  authority: per writer.
Q10 outside effects: none by itself.
Q11 order writes: none. order_id is a link (005:22 region; comms-row.js:24).
Q12 failure goes to: the row status and metadata.
Q13 trail: audit comm_send (_lib/comms-send.js:222-227); processing_events
    comm_sent or comm_send_failed when order_id is set (:228-233).
Q14 health: none.
Q15 config: none.
Q16 tests: api-comms-row-reconcile.test.js.
Q17 overlaps: M-41, M-42, rep touch log (section 10), EA email_actions (#637).
Q18 owner plan: #623 (honest status).
notes / defects: "queued" means two things (L4-D1). WhatsApp rows default to
    channel email (L4-D2). The Comms screen reads no communications row
    (screens/comms.tsx:84-95 calls /api/audit without auth, with action names
    nobody writes). The only working reader is the global drawer
    (components/ThreadDrawer.tsx:156; app.tsx:487).
```

### M-41 Send rails

```
M-41  Send rails                                                   layer: L4
status on main: wired
live: not confirmed (owner query 6 for rows by status; the provider env vars
      EMAIL_PROVIDER, BREVO_API_KEY, RESEND_API_KEY, SENDGRID_API_KEY,
      COMMS_PROVIDER_URL, TWILIO_*, META_WHATSAPP_* need an owner check
      outside 6.4).
Q1  job: send one message out of Anvil. Core: sendCommunication
    (_lib/comms-send.js:102-236). Section 4 lists every rail.
Q3  trigger: inline from screens and handlers; deferred through M-42.
Q4  unit of work: one communications row, or none (mailer direct, marketing
    skips).
Q5  claim: none. Two concurrent sends of one row both send. [I] No
    conditional update before the provider call (_lib/comms-send.js:107-187).
Q6  retry: none in the rail. failed is final (:196).
Q7  dedup: sent and replied rows return idempotent (:110).
Q8  tenant: row read filters tenant_id (:107); the final update filters id
    only (:219).
Q9  authority: per caller. communications/send.js, copilot confirm "approve"
    (copilot/confirm.js), whatsapp/send.js "write" (:69), voice/outbound.js
    "approve" (:52), marketing gates on consent and suppression
    (_lib/marketing-send.js:90-95).
Q10 outside effects: Graph (_lib/comms-send.js:161-170), Brevo, Resend,
    SendGrid (_lib/mailer.js:54-122), generic webhook (_lib/comms-send.js:87-100),
    Twilio WhatsApp and Slack (:37-78), Twilio or Meta direct
    (whatsapp/send.js:21-61), SendGrid marketing (_lib/marketing-send.js:101-127),
    voice provider (voice/outbound.js:101).
Q11 order writes: none. quotes/send.js:346-347 flips the quote to SENT before
    the queued email leaves.
Q12 failure goes to: row status failed and metadata.provider_error
    (_lib/comms-send.js:190-209). The caller's HTTP response. No notice.
Q13 trail: audit comm_send (:222); processing_events when order_id (:228).
    The reaper passes user null (agents/run.js:287), so the actor is empty.
Q14 health: emailConfigured() feeds /api/health (_lib/mailer.js:46-48).
Q15 config: env only (see live).
Q16 tests: api-mailer.test.js, api-graph-provider.test.js,
    api-agents-reaper-mailer.test.js, api-invoices-send.test.js,
    api-marketing-path.test.js, api-dispatch-register-autosend.test.js. No test
    of whatsapp/send.js on main.
Q17 overlaps: M-42, marketing, voice outbound, auth mail (section 4).
Q18 owner plan: C-5 (#623), C-18 (#630), C-20.
notes / defects: L4-D2, L4-D3, L4-D4, L4-D13, L4-D19, L4-D27.
```

### M-42 Queued mail reaper

```
M-42  Queued mail reaper                                           layer: L4
status on main: wired, not scheduled (H-1)
live: not confirmed (owner query 1: cron_health rows "cron/tick" and
      "agents/run"; owner query 2: communications by status).
Q1  job: send every queued communications row of a tenant through
    sendCommunication. agents/run.js:267-275.
Q3  trigger: only inside the agent runner, after the goal loop, only for
    tenants that had a due goal in this run (agents/run.js:358-366). The
    runner is in the tick hourly group (cron/tick.js:194-199). The goal read
    takes the first 50 due goals (agents/run.js:329-336).
Q4  unit of work: communications row with status queued (agents/run.js:277-283).
    Writers: :298-301 (failed, no recipient); sendCommunication (sent, failed,
    or stays queued).
Q5  claim: none. [I] Two overlapping runner calls send a row twice; the
    idempotence check (_lib/comms-send.js:110) reads before the send, not
    with a lock.
Q6  retry: every run while queued. No attempt count. No age limit
    (agents/run.js:311). Give-up: only "no recipient" (:295-303).
Q7  dedup: sendCommunication idempotence on sent and replied.
Q8  tenant: per-tenant query (agents/run.js:280).
Q9  authority: CRON_SECRET (agents/run.js:323-326). No person confirms.
Q10 outside effects: every M-41 provider.
Q11 order writes: none.
Q12 failure goes to: row status failed. No notice.
Q13 trail: comm_send audit with no actor; processing event when order_id.
Q14 health: no own row. Covered only by "agents/run" (2 h bound,
    _lib/heartbeat-check.js:20).
Q15 config: none. Marketing rows skipped (agents/run.js:294).
Q16 tests: api-agents-reaper-mailer.test.js.
Q17 overlaps: M-41 direct sends; push drain M-39 (a second queue drain).
Q18 owner plan: #623 removes the quote producer; none for the rest.
notes / defects: H-8 confirmed and extended (section 7). L4-D1 (rows meant
    for a human are sent), L4-D26 (no cap, 50-goal window).
```

Producers of queued rows on main (each waits for M-42):

| Producer | Row | Recipient set | What happens |
|---|---|---|---|
| agent send_email | agents/run.js:153-165 | handler payload | sent by M-42 |
| quote send | quotes/send.js:447-465 | quotes/send.js:129-150 | quote already SENT (:346-347); goals due at once (011 next_run_at default now(); quotes/send.js:57-77) |
| supplier RFQ | supplier_rfq/send.js:94-102 | vendor contact | RFQ already "sent" (:110) |
| sourcing handoff | sourcing/network/handoff.js:78-93 | peer contact | peer tenant only, when it has a due goal |
| manual dispatch register, payment statement, service report | comms/dispatch_register.js:86, comms/payment_statement.js:96, comms/service_report.js:122 | comms-routing | meant for a human (headers :9-10); M-42 sends it (L4-D1) |
| invoice send left over | invoices/send.js:177, :196 | customer contact | stays queued when no provider; later sent |
| copilot draft and send left over | copilot/confirm.js:48-60 | caller | stays queued when no provider; later sent |
| WhatsApp, no provider | whatsapp/send.js:89-112 | phone number | queued, channel email; M-42 emails a phone number (L4-D2) |
| logistics alert | _lib/logistics/notifications.js:192-202 | none | M-42 marks failed "no recipient" |
| inventory alert | _lib/inventory/notifications.js:113-123 | none | M-42 marks failed "no recipient" |
| drift report | cron/drift-report.js:112-122 (pending_send maps to queued) | broken read (L4-D21) | never written |

### M-43 Recipient resolvers

```
M-43  Recipient resolvers                                          layer: L4
status on main: wired (customer routing); built, one caller (internal)
live: not confirmed (inline; depends on callers).
Q1  job: turn a customer, a role or a user id into addresses or user ids.
    _lib/comms-routing.js:1-20; _lib/internal-recipients.js:1-21;
    _lib/assignee.js:1-14.
Q3  trigger: inline. Section 3 lists every resolver and caller.
Q4  unit of work: none (pure or read-only).
Q5  claim: n/a.   Q6 retry: n/a.   Q7 dedup: case-insensitive address dedup
    (_lib/comms-routing.js:27-40; _lib/internal-recipients.js:146-164).
Q8  tenant: every read filters tenant_id (_lib/comms-routing.js:121, :127;
    _lib/internal-recipients.js:91; _lib/assignee.js:19).
    resolveInternalRecipients throws without a tenant (:128-133).
Q9  authority: none (helpers).
Q10 outside effects: auth.admin.getUserById per member
    (_lib/internal-recipients.js:101).
Q11 order writes: none.
Q12 failure goes to: internal-recipients returns dropped[] with a reason
    (:143-145); comms-routing returns unresolved and fallback_used (:105-111);
    notifyAdmins returns notified 0 silently (_lib/notifications.js:71).
Q13 trail: none.
Q14 health: none.   Q15 config: comms_routing_rules; tenant_settings
    order_handoff_to and _cc (251:58-60).
Q16 tests: api-internal-recipients.test.js, api-comms-routing-attachments.test.js,
    api-marketing-path.test.js, api-dispatch-register-autosend.test.js.
    _lib/assignee.js: not confirmed (no test names the file).
Q17 overlaps: notifyAdmins role gate, logistics rolesFor, agent escalate_roles,
    drift report admin read, quote and invoice recipient pickers, #623
    alertRecipientsForRoles, #624 notify(), #630 handoff, #640 policy roles.
Q18 owner plan: none for one resolver. H-13.
notes / defects: L4-D18, L4-D21. Section 3 shows they disagree for one role.
```

### M-44 Logistics exceptions and notices

```
M-44  Logistics exceptions and notices                             layer: L4
status on main: flag off (logistics_monitor_enabled, 206:93-94 default false)
live: not confirmed (owner query 4 for the flag; owner query 3 for open rows).
Q1  job: detect delay and SLA exceptions on source POs, internal SOs and
    orders, and tell the rule's roles. cron/logistics-monitor-tick.js:1-15;
    _lib/logistics/notifications.js:1-7.
Q3  trigger: tick ALWAYS (cron/tick.js:186) and daily (cron/daily.js:91). Both
    on purpose (_lib/heartbeat-check.js:29-45). Gated per tenant
    (cron/logistics-monitor-tick.js:39-41).
Q4  unit of work: logistics_exceptions row (206:50-71). status open,
    acknowledged, resolved, suppressed (206:60-61). Writers:
    _lib/logistics/monitor.js (create, ratchet), :362-369 (auto-resolve);
    logistics/exceptions.js:54-56 (ack, resolve, suppress); notified stamps
    in detail (_lib/logistics/notifications.js:144-156, :235-238).
Q5  claim: none. Unique open fingerprint makes a racing insert lose
    (206:82-84).
Q6  retry: a row without bell_at or email_at stays in the query
    (_lib/logistics/notifications.js:94-111). 25 notices per run (:20).
Q7  dedup: unique open (tenant, rule_kind, fingerprint) (206:82-84); reads
    open, acknowledged and suppressed rows before insert (monitor.js:258-262).
    Bell dedupKey "exc:"+id, "breach:"+id, digest per day
    (_lib/logistics/notifications.js:47, :182, :220).
Q8  tenant: per-tenant loop; every query filters tenant_id
    (_lib/logistics/notifications.js:77, :97, :105, :149, :237).
Q9  authority: CRON_SECRET for the cron. Ack and resolve need "write"
    (logistics/exceptions.js:51).
Q10 outside effects: queued email with no recipient
    (_lib/logistics/notifications.js:192-202), sent only by M-42.
Q11 order writes: none. Orders are read only (monitor.js:211-213).
Q12 failure goes to: console.warn on stamp failure (:239-241). A bell that
    reached nobody is stamped as sent (L4-D5).
Q13 trail: audit on ack, resolve, suppress (logistics/exceptions.js:80).
    No trail on notify.
Q14 health: "logistics/monitor_daily" and "logistics-monitor-tick" 30 h;
    "logistics/monitor" 10 min (_lib/heartbeat-check.js:46-48).
Q15 config: logistics_monitor_enabled; logistics_monitor_rules.escalate_roles
    (default procurement and admin, _lib/logistics/notifications.js:82);
    LOGISTICS_MAX_NOTIFY_PER_RUN, LOGISTICS_DIGEST_THRESHOLD (:20-22).
Q16 tests: api-logistics-monitor.test.js, api-logistics-burst.test.js,
    api-cron-logistics-daily.test.js.
Q17 overlaps: M-45 (same shape, separate code), M-38, M-42, WM 4.11 (mirror
    into work items).
Q18 owner plan: #623 (recipients, email budget); C-8 lane readiness.
notes / defects: owner_user_id (206:59) has no writer. L4-D5, L4-D28 (D-6).
```

### M-45 Inventory exceptions and notices

```
M-45  Inventory exceptions and notices                             layer: L4
status on main: routable only
live: not confirmed (owner query 1: cron_health row "inventory-exceptions-tick";
      owner query 3: open inventory_exceptions). Route router.js:740; no
      schedule in vercel.json:12-17, cron/tick.js or cron/daily.js.
Q1  job: detect inventory exceptions per part and tell admins by bell, email
    and voice. _lib/inventory/exceptions-detector.js:1-17;
    _lib/inventory/notifications.js:1-14.
Q3  trigger: GET /api/cron/inventory-exceptions-tick
    (cron/inventory-exceptions-tick.js:44-45). The copilot can acknowledge
    (copilot/confirm.js:68-75).
Q4  unit of work: inventory_exceptions row (085:356-371). status open,
    acknowledged, resolved, suppressed (085:366-367). Writers: detector
    upsertException (exceptions-detector.js:39); inventory/exceptions.js:41-42;
    notified stamps (notifications.js:152).
Q5  claim: none. Read-then-insert, no unique index (exceptions-detector.js:28-39).
Q6  retry: re-reads every open row each run, no limit (notifications.js:72-75).
Q7  dedup: fingerprint includes today's date (exceptions-detector.js:66, :77,
    :87, :238), so the same problem opens a new row each day (D-5). Bell
    dedupKey is that fingerprint (notifications.js:101).
Q8  tenant: per-tenant; the stamp update filters id only (notifications.js:152).
Q9  authority: CRON_SECRET; ack and resolve per inventory/exceptions.js.
Q10 outside effects: queued email with no recipient (notifications.js:113-123);
    a voice_calls insert that cannot succeed (notifications.js:138-143;
    041:61-71) (D-4, L4-D6).
Q11 order writes: none.
Q12 failure goes to: nowhere. Insert errors are not read (:113, :138).
Q13 trail: none for notices.
Q14 health: "inventory-exceptions-tick" (cron/inventory-exceptions-tick.js:54, :61),
    default 10-minute bound (_lib/heartbeat-check.js:49).
Q15 config: tenant_settings inventory_voice_* (notifications.js:61-68).
Q16 tests: none found for notifications.js or exceptions-detector.js.
Q17 overlaps: M-44 (same shape), M-38, M-42, voice rail.
Q18 owner plan: #623 (recipients, email budget); #534 schedules the planner only.
notes / defects: L4-D6, L4-D7, L4-D15, L4-D28.
```

### M-46 Pull lists

```
M-46  Pull lists (approvals queue, order exceptions, Home, review queue)  layer: L4
status on main: wired (screens)
live: not confirmed (owner query 3 for open counts). Pull only: nothing
      pushes any of them to a person. [V]
Q1  job: list what waits, when a person opens the screen.
    admin/quote_approvals.js:1-6, :42-45; orders/exceptions.js:1-15;
    screens/home.tsx:60-84; docai/review_queue.js:1-23.
Q3  trigger: screen load. screens/approvals.tsx:263;
    screens/so-workspace.tsx:2851 (OrderExceptionsCard); screens/home.tsx:64;
    screens/extraction-review.tsx:85.
Q4  unit of work: approvals queue = orders with status PENDING_REVIEW plus open
    quote_approvals rows (admin/quote_approvals.js:166-200; quote_approvals
    006:622). Exceptions = computed list, no table (orders/exceptions.js:1-15).
    Home = newest 50 orders, first 8 not RECONCILED or CANCELLED
    (screens/home.tsx:64, :82-84). Review queue = extraction_review_queue row,
    status open, in_review, resolved, archived (123:28-60).
Q5  claim: review queue only: claim sets in_review and assigned_to
    (docai/review_queue.js:107-108). Others: none.
Q6  retry: n/a.
Q7  dedup: approvals evaluator skips a role that already has a PENDING row
    (_lib/approval-evaluator.js:69-79). Review queue unique per run (123:56).
Q8  tenant: each read filters ctx.tenantId (admin/quote_approvals.js:168,
    :180; orders/exceptions.js:8-9).
Q9  authority: all GETs need "read". Approvals queue has no role filter
    (admin/quote_approvals.js:165-172). The screen hides it from operator and
    procurement (lib/rbac.ts:41).
Q10 outside effects: none.
Q11 order writes: none from the lists. The approval itself is M-33.
Q12 failure goes to: the screen banner.
Q13 trail: review queue claim and resolve audit (docai/review_queue.js:137).
    Others: none.
Q14 health: none.   Q15 config: quote_approval_thresholds.
Q16 tests: api-quote-approvals-embed.test.js, api-orders-exceptions.test.js,
    api-order-exceptions.test.js, OrderExceptionsCard.test.tsx,
    home-queue.test.tsx, api-docai-review-queue-endpoint.test.js.
Q17 overlaps: nav badges and Kanban (section 10), #641 Home "My email actions".
Q18 owner plan: C-9/C-11 stage and worklist (#626, #629), R-U1, R-U4.
notes / defects: no owner, due time or escalation on any of them, except the
    review claim. Home "My queue" is not per user. The approvals badge and the
    intake badge both count PENDING_REVIEW (lib/telemetry.ts:84, :88).
```

---

## 2. Event by channel matrix

Columns: Bell = `admin_notifications`. Push = `push_notifications`. Comms = `communications` or an email out. PE = `processing_events`. AE = `audit_events`. Queue = an exception or queue row, or a status that a list reads. Goal = `agent_goals`. Screen = where a person sees it. A blank cell means no row.

### 2.1 On main

| Event | Bell | Push | Comms | PE | AE | Queue | Goal | Screen | Places to watch |
|---|---|---|---|---|---|---|---|---|---|
| 1. PO email arrives | | | | (legacy path only: email/inbound.js:228) | inbound_email_received (inbound/email/webhook.js:246); inbound_email_drafted (inbound/email/draft_orders.js:78) | inbound_emails row (_lib/inbound-email.js:107, :134); DRAFT order (inbound/email/draft_orders.js:75); review row if low confidence (_lib/docai/run.js:1694) | | screens/email.tsx:85-89; screens/intake.tsx:22; badge lib/telemetry.ts:84; screens/home.tsx:82 | 3 pull screens and 1 badge; 0 push |
| 2. Background extraction finishes or fails | | | | docai_chunk_done (cron/extraction_jobs.js:900); docai_extract_failed (:663, :726, :820, :960); docai_chunk_row_windows_incomplete (:646) | extraction_job_completed (:905); extraction_job_failed (:664); none on the paths at :646, :726, :820 and :960 | extraction_jobs status (:890, :644, :660, :723, :817, :955) | | components/BackgroundExtractionWatch.tsx (so-workspace.tsx:2651), only while that order is open, 30 min ceiling (:23-28); timeline so-workspace.tsx:491 | 1, and only while the order is open; 0 push |
| 3. Order enters PENDING_REVIEW | | | | order_updated (orders/[id].js:412) | update_order (:411); approval_thresholds_evaluated (:439) | quote_approvals PENDING if a threshold matches (_lib/approval-evaluator.js:91) | | screens/approvals.tsx:263; badge lib/telemetry.ts:88; screens/home.tsx:86; Kanban Validate (screens/pipeline-kanban.tsx:78) | 2 to 3 pull; the approver is not told |
| 4. Order approved | | | | manager_approved (orders/[id].js:412); golden harvest event (:385) | approve_order (:411) | status APPROVED | | screens/tally-push.tsx:32 (Mode A); screens/home.tsx:82; Kanban Approve | 2 pull; the submitter is not told |
| 5a. Tally push fails | | | | tally_failed (tally/push.js:237) | tally_push_failed (:230) | order FAILED_TALLY_IMPORT (:227); tally_voucher_records failed (:206); tally_retry_queue if recoverable (:42) | failed_push_recovery only if a person arms it (agents/goals.js:58); escalates after 24 h (agents/_handlers/failed_push_recovery.js:31-58; agents/run.js:108, :120) | HTTP 502 to the pusher (tally/push.js:249); Kanban Push (pipeline-kanban.tsx:83). Not on screens/tally-push.tsx (L4-D9) | 1 to 2 pull |
| 5b. Tally give-up | | | | | none (cron path passes no ctx: tally/retry.js:157, :102) | tally_retry_queue gave_up (tally/retry.js:51-56); voucher failed (:58-62) | | count banner on admin Tally tab (screens/admin.tsx:2477-2479, via tally/health.js:67) | 1, admin only; 0 push |
| 5c. SAP (erp-runner) push fails | | | | | sap_push_failed (sap/push.js:112, :132-137) | result.external_systems.sap (sap/push.js:131); sap_retry_queue if recoverable (:54, :138-141). Order status unchanged | goal cannot see it: watches FAILED_TALLY_IMPORT and BLOCKED only (failed_push_recovery.js:15, :31) | HTTP 502 to the pusher; screens/audit.tsx:122 | 1 (audit list); 0 push |
| 5d. SAP give-up or permanent fail on retry | sap_push_gave_up (erp-runner.js:123-131) or sap_push_permanent_fail (:152-160), broadcast, admin and operator | | | | | sap_retry_queue gave_up (:112-117, :145-150) | | Shell bell (components/Shell.tsx:600); deep link admin?tab=sap lands on Members (screens/admin.tsx:172-174) | 1 (desktop bell, admin and operator) |
| 6a. Mode B handoff sent | | | | | | | | none: no send on main; register placeholder (screens/so-register.tsx:302-303) | 0 |
| 6b. SO keyed in ERP (sales order attach) | | | | | order_sales_order_attached (orders/attach_sales_order.js:193-206) | orders.so_voucher_no (:179); order_documents (:143-145) | | screens/so-register.tsx:301 | 1 pull |

Count of push channels (bell or email to a person) per event on main: events 1, 2, 3, 4, 5a, 5b, 5c, 6: zero. Event 5d: one (the broadcast bell). [V]

### 2.2 If #623, #624 and #630 merge

| Event | What changes | Places to watch |
|---|---|---|
| 1 | #623 `bellStaleTick` (#623 `_lib/heartbeat-check.js`) writes one admin bell row per tenant per day when the tick is stale or never ran. This tells an admin that intake waits. No per-email notice | 3 pull and 1 badge; 1 daily admin bell when the tick is down |
| 2 | #623 `BackgroundExtractionWatch.tsx` shows when the worker last ran and says "late". Same single place | 1 |
| 3 | none. #624 adds `notify()` with no caller. C-19 adds "sent for approval" | 2 to 3 pull |
| 4 | none | 2 pull |
| 5a, 5b, 5c | none. The Tally give-up still writes no notice | as on main |
| 5d | #624 shows the broadcast row in `MobileShell` too, to admin and operator; any role can mark read | 1 bell, desktop and phone |
| 6a | #630 `orders/handoff.js`: communications row inserted as draft and sent in the request (sendCommunication); `orders.handoff_*` update; AE `order_handoff_sent` and `comm_send`; PE `order_handoff` and `comm_sent`. The email reaches the processing team's inbox. Screens: register Handoff column (#630 `so-register.tsx`), `OrderHandoffButton` in the workspace. No bell | engineer: 2 pull; clerk: their mailbox |
| 6b | none | 1 pull |

---

## 3. Recipient resolvers

| Resolver | Inputs | Output | Callers | Role semantics |
|---|---|---|---|---|
| notifyAdmins role gate (_lib/notifications.js:65-71) | tenant, roles (default admin) | one broadcast row, or none | 12 calls (M-38 Q3) | a role only decides whether to write; admin and operator see the row; a finance member never sees a "finance" notice |
| logistics rolesFor (_lib/logistics/notifications.js:76-82) | rule escalate_roles; default procurement, admin | roles for notifyAdmins | the logistics dispatcher | same as notifyAdmins |
| agent escalate_roles (agents/run.js:117-118) | goal.config.escalate_roles; default admin | roles for notifyAdmins | escalate action | ignores goal.owner_user_id (L4-D12) |
| resolveInternalRecipients (_lib/internal-recipients.js:127-201) | tenant, to and cc entries (addresses or role:x), engineer | to and cc rows (email, name, user_id, reasons), reply_to, dropped | admin/order_handoff_settings.js:67, :128 only | a role expands to approved members with an auth email (:87-107) |
| drift report admin read (cron/drift-report.js:167-178) | tenant | admin emails | the monthly drift report | reads a `users` table that no migration creates, so always empty (L4-D21) |
| comms-routing resolveRecipients and resolveForCustomer (_lib/comms-routing.js:49-137) | document type, customer contacts, routing rules, fallback | to, cc, bcc, fallback_used, unresolved | comms/dispatch_register.js:63, comms/payment_statement.js:78, comms/service_report.js:95, _lib/dispatch-register-send.js:104 | customer functions; rule, then function, then primary, then operator |
| quote recipient (quotes/send.js:129-150) | body.to, quote contact, customer.contact_email | one address | quotes/send.js:187 | ignores comms_routing_rules |
| invoice recipient (invoices/send.js:55) | customer.contact_email | one address | invoices/send.js | ignores comms_routing_rules |
| resolveAssignee (_lib/assignee.js:15-28) | tenant, user id | the id if approved member, else null | customers/owner.js:222, sales/opportunities.js:227, sales/leads.js:42, service/visits.js:51, :102, agents/_handlers/credit_review_request.js:37 | validates a person; no role expansion |
| #623 alertRecipientsForRoles (#623 `_lib/internal-recipients.js`) | tenant, roles | {to_addr, cc_addrs} or null | #623 logistics and inventory dispatchers | through resolveInternalRecipients; first address To, rest CC |
| #624 notify() (#624 `_lib/notifications.js`) | tenant, users, roles | one row per approved member | none in #624; #640 escalation | role expands to approved members; reads tenant_members itself, not through resolveInternalRecipients |
| #630 handoff (#630 `orders/handoff.js`) | tenant settings to and cc, engineer | to, cc, reply_to | handoff send | through resolveInternalRecipients; second To goes to CC |
| #640 policy roles, owner, backup (#640 `escalation.js`) | policy ladder, owner, backup, active members | users and roles for notify() | email/sweep | owner dropped when no longer approved |

**Do they agree for one role?** No. [V] Take `procurement`:

- Bell via notifyAdmins: a row only if one approved procurement member exists. Admin and operator see it. Procurement members do not.
- Email via resolveInternalRecipients (and #623): every approved procurement member with an auth email.
- #624 notify: one bell row for each approved procurement member, visible to that member.
- No role exists: notifyAdmins writes nothing (L4-D18); resolveInternalRecipients reports `no_active_members`; logistics stamps the bell as sent anyway (L4-D5).

Customer side: three pickers (comms-routing, quote, invoice) choose different addresses for one customer.

---

## 4. Send rails

| Rail | Entry | Delivers without the tick | No provider configured | Can "sent" be false | Attempt recorded |
|---|---|---|---|---|---|
| sendCommunication core | _lib/comms-send.js:106 | yes, when called inline | row `queued`, `configured:false`, audit "manual::sent" (:196, :226) | yes: Teams 202 with nothing sent (:80-81); chat rows with no config go out as email to a phone or channel id (:173-183) | communications row and metadata; audit comm_send; PE when order_id |
| Graph branch | :155-171 | yes | skipped when not connected; falls to mailer | not confirmed (sendViaGraph treats 202 as ok, _lib/graph-client.js:256) | same row |
| Mailer branch | :31-35, _lib/mailer.js:130 | yes | returns skipped, falls to webhook (:33) | no (provider HTTP status) | same row |
| Generic webhook | :87-100 | yes | skipped when COMMS_PROVIDER_URL unset | yes in effect: any 2xx counts, with to null when no recipient [I] | same row |
| Chat: Twilio WhatsApp, Slack | :37-78 | yes | null, falls through to email (L4-D3) | Slack: no (reads j.ok, :74) | same row |
| Chat: Teams | :80-81 | yes | always ok | yes (L4-D4) | row `sent` |
| Mailer direct | auth/request_reset.js:112; admin/access_requests.js:212 | yes | skipped not_configured (_lib/mailer.js:133) | no | none (no communications row) |
| WhatsApp endpoint | whatsapp/send.js:63 | yes | status "manual", stored queued with channel email; answers ok:true (:89-91, :122) | yes (L4-D2) | communications row; audit comm_send (:114-119) |
| Voice outbound | voice/outbound.js:52-176 | yes | 400 NO_VOICE_CONFIG (:59) | no: provider placement required; 502 on refusal (:118-124) | voice_calls row (:130); audit; PE when the insert fails (:151) |
| Agent call | agents/run.js:169-262 | no (hourly tick) | error "no_voice_config" in the step (:191-193) | no | voice_calls; agent_steps |
| Marketing send | _lib/marketing-send.js:90; marketing/send.js:56-80 | yes | skipped no_provider; no row (:101) | no | row only on a real attempt (marketing/send.js:63) |
| Prospecting dispatch | prospecting/run.js:86-111 | no (tick ALWAYS) | target stays approved (:87-91) | no | row sent or failed (:97) |
| Dispatch register auto-send | _lib/dispatch-register-send.js:75-146 | yes | skipped not_configured, no row (:87-88) | no; keeps only the first To (:117) | row; audit dispatch_register_auto_sent (:134) |
| Manual dispatch register, payment statement, service report | comms/dispatch_register.js:102, comms/payment_statement.js:108-111, comms/service_report.js:135 | only with send:true | row stays queued | no | row; then M-42 sends it without the promised confirm (L4-D1) |
| Invoice send | invoices/send.js:196 | yes | row stays queued; response says not sent (:79) | no | row; later M-42 send (L4-D13) |
| Copilot draft and send | copilot/confirm.js:46-66 | yes | row stays queued; response `configured:false` | Teams: yes | row; later M-42 send (L4-D13) |
| Quote send | quotes/send.js:447 | no: queued, waits for M-42 | row queued; quote already SENT | yes: "sent" status on the quote while nothing left | row; audit quote_send (:468-469) |
| Supplier RFQ send | supplier_rfq/send.js:94 | no: queued | queued | yes: RFQ status "sent" (:110) and invitation sent_at (:88) before any send | row |
| Sourcing network handoff | sourcing/network/handoff.js:78 | no: queued in the peer tenant | queued | yes: response says "notified" (:108) | row in the peer tenant |
| Drift report | cron/drift-report.js:105-125 | no | queued | never written (L4-D21) | none in practice |
| Push drain | push/send.js:19-67 | no (tick ALWAYS) | skipped "VAPID keys missing", row failed | yes: non-web subscriptions skipped and row marked sent (L4-D20) | push_notifications row |
| Agent send_email | agents/run.js:131-168 | no | queued for M-42 | n/a | row queued; agent_steps |

Count: one core (sendCommunication) with 6 provider branches, plus 6 rails that do not use it (mailer direct, WhatsApp endpoint, voice outbound, agent call, marketing, push). Five producers deliver only through the tick (quote, supplier RFQ, sourcing, agent mail, prospecting). [V]

---

## 5. Channel behaviour

| Channel | Dedup | Per-user read | Acknowledge | Resolve | Owner | Due time | Escalate | Who can see (roles) | Phone shell |
|---|---|---|---|---|---|---|---|---|---|
| Bell | 5-min kind and key window, optional (_lib/notifications.js:50-60) | read_by array (admin/notifications.js:89-92); admin only can POST (:43) | no (read only) | global flag, admin only (:68-79) | no | no | no | admin, operator in the screen (Shell.tsx:600); API GET to every viewer role (admin/notifications.js:26) | no bell (MobileShell.tsx:12-18) |
| Web push | no | target user (push/send.js:31-34) | no | no | user_id | no | no | nobody can subscribe | push.ts unused |
| Communications | idempotent on sent and replied (_lib/comms-send.js:110) | n/a | no | n/a | sent_by | no | no | ThreadDrawer per order (components/ThreadDrawer.tsx:156); Comms screen broken (screens/comms.tsx:84-95) | via the drawer [NC] |
| Logistics exceptions | unique open fingerprint (206:82-84) | no | yes (logistics/exceptions.js:54) | yes, plus auto-resolve (monitor.js:362-369) | column, no writer (206:59) | sla_target_at (206:64) | one breach bell (_lib/logistics/notifications.js:211-224) | list: read; act: write (logistics/exceptions.js:34, :51); screen delays (lib/rbac.ts:59) | via More (MobileShell.tsx:88-104) |
| Inventory exceptions | fingerprint with the date (exceptions-detector.js:66) | no | yes (inventory/exceptions.js:41) | yes (:42) | no (acknowledged_by only, 085:368) | no | no (voice branch dead) | screen lib/rbac.ts:89 | via More |
| quote_approvals queue | one PENDING per role (_lib/approval-evaluator.js:69-79) | no | no | decision POST writes quote_approvals only (admin/quote_approvals.js:135-160) | approver_role (a role) | no; the screen shows age | no | API: read, no role filter (admin/quote_approvals.js:165); screen hides from operator and procurement (lib/rbac.ts:41) | primary tab "Approve" (MobileShell.tsx:15) |
| Extraction review queue | unique per run (123:56) | no | claim (docai/review_queue.js:107-108) | yes (:111-121) | assigned_to | no | no | lib/rbac.ts:69 | via More |
| Derived order exceptions | computed | no | no | per finding (orders/[id].js:163) and terms decide | no | no | no | read (orders/exceptions.js:78) | via SOs tab, workspace card |
| Agent goals | one active goal per target (082:45) | no | no | status completed or cancelled; person pauses (screens/agents.tsx:137) | owner_user_id (011), unused by escalation | due_at (011) | escalate: PE and broadcast bell (agents/run.js:102-129) | screens/agents.tsx:71; lib/rbac.ts:74 | via More |
| Nav badges | n/a | no | no | no | no | no | no | tenant-wide counts (lib/telemetry.ts:83-107) | only inside More (MobileShell.tsx:101) |

Only one channel has an owner, a due time and an escalation on one row: logistics exceptions, and its owner column has no writer. [V]

---

## 6. Work items (H-6)

### 6.1 `work_items` as built in EA-3 (#637, migration 252) against WM 4.2

| WM 4.2 field or rule | #637 `252_work_items.sql` | Note |
|---|---|---|
| item_key, work_counters | absent | deferred to WM-5 (252 header) |
| type check (5 values) | same | |
| category, title, detail | same | |
| subject_type, subject_id NOT NULL | same | EA adds the value `email_action`, not in the WM list |
| account, opportunity, project, order ids | same, with FKs `on delete set null` | |
| parent_id | same | |
| status, status_category (todo, in_progress, blocked, done, cancelled) | same set | status is free text, no CHECK |
| blocked_reason, blocked_since, resolution | same | |
| assignee_user_id, assignee_role | same, with FK | |
| start_at, due_at, due_source set, due_basis | same | |
| priority smallint default 3, 1 to 4 | same | label drift: WM "1 urgent to 4 low"; EA "1 critical to 4 informational" (EA 6.4) |
| source set | same; NOT NULL default manual | WM is nullable |
| source_key unique while open | same | |
| template columns, custom | absent | deferred |
| unique header subject | same | |
| header_or_owned_state, blocked_has_reason CHECKs | same | |
| indexes | same set less project_id; adds account_id | |
| RLS | on; revoke from anon and authenticated; no tenant-user policy | the API applies visibility (#638 access.js) |

EA state set: `detected`, `awaiting_review`, `pending`, `in_progress`, `awaiting_verification`, `performed`, `cancelled`, mapped to status_category in code only (#637 `store.js` STATUS_CATEGORY). Transitions live in code (#638 `store.TRANSITIONS`). The engine sets `order_id` from a PO-number match and leaves it null when ambiguous (#637 `link.js`, `engine.js`).

### 6.2 Conflict with R-M6

R-M6: "an order work item points to a stage or an exception and never carries a second status."

Verdict: **Partly in conflict.** [V] and [I]:

1. The CHECK `work_items_header_or_owned_state` (#637 252) requires `status` and `status_category` on every item that is not an opportunity or project header. So an order item must store a status. That is allowed only if the status is the item's own work state and evidence closes it. Nothing in 252 or in the EA code enforces that for order items.
2. `subject_id uuid NOT NULL` cannot point at a derived exception or a derived stage. Exceptions have no table and no id (orders/exceptions.js:1-15). The stage is derived (#626). The only text slot is `source_key`, which is an idempotency key, not a pointer.
3. EA email items set `order_id` as ancestry. Their status is the email action's state, not the order's. That part does not conflict.
4. `email_actions.business_status` (`awaiting_internal` to `closed`, EA 6.5) is a second outcome field. For an email about an order it can say `resolved` while the order stage says otherwise.

### 6.3 What one table for email actions and order work needs

- Keep the 252 names (they are WM's).
- Add a pointer for derived objects, for example `subject_ref text` (exception code or stage key), checked in code.
- A status registry per `subject_type` in one module: `email_action` uses the EA states; `order` uses open, done, cancelled, and every order item names its closing evidence (WM 4.3 rule 3). No order item writes `orders.status`. The stage (#626) may read open items; items never feed the stage's value.
- One priority vocabulary.
- Visibility per subject type: email items private (#638); order items follow order read access.
- A notice ledger keyed by work item and notice key, not by `email_action_id`, so order notices (C-19) and email notices share it.

### 6.4 Three dedup rules for one bell table

| Mechanism | Key | Window | Scope | Retry |
|---|---|---|---|---|
| notifyAdmins (_lib/notifications.js:50-60) | tenant, kind, link_params.dedup_key, unresolved | 5 minutes | one broadcast row | none |
| #624 notify() (#624 `_lib/notifications.js` isDuplicate) | same key | 5 minutes | suppresses the whole fan-out, for every recipient | none |
| #640 ledger (270, `email_action_notices`) | unique (email_action_id, notice_key); key holds kind, level, owner, due time, reopen count | forever | per action | up to 3 on failure; a row stuck in `claimed` is never sent |

#640 calls notify() with no dedupKey, so its rows bypass the 5-minute rule. A C-19 order notice would use the 5-minute rule. One table then has three dedup rules. #640 also counts a notify() that reached nobody as sent (L4-D25).

---

## 7. Signal verdicts

| Signal | Verdict | Evidence |
|---|---|---|
| H-6 | **Confirmed.** Two designs claim `work_items`; EA-3 builds WM's subset with the same names. **Partly** in conflict with R-M6 | Section 6. #637 252 CHECK; subject_id uuid; status free text; business_status |
| H-8 | **Confirmed and wider.** The reaper is the only drain of queued rows, only for tenants with a due goal among the first 50, hourly, from the tick | agents/run.js:276-314, :329-336, :358-366; cron/tick.js:194-199. Eleven producers (M-42 table). Three of them are drafts meant for a human (L4-D1) |
| H-9 | **Confirmed.** Tally give-up writes status only; NetSuite the same; erp-runner give-up rings a broadcast bell; an erp-runner first-push permanent failure rings nothing; failed_push_recovery cannot see an erp-runner failure | tally/retry.js:51-63; netsuite/retry.js has no notice; erp-runner.js:123-131, :145-161; sap/push.js:115-149; failed_push_recovery.js:15, :31; no armer except a person (agents/goals.js:58). The #611 sentence "only a failed Mode A ERP push writes a bell row" is wrong two ways: Tally never rings, and agent escalation (agents/run.js:120) also rings |
| H-13 | **Confirmed.** 13 resolvers (8 on main, 5 in open PRs); they disagree for one role | Section 3 |
| H-14 | **Confirmed.** One core with 6 branches plus 6 separate rails. False "sent": Teams (_lib/comms-send.js:80-81); WhatsApp ok:true (whatsapp/send.js:122); audit "manual::sent" (_lib/comms-send.js:226); push non-web (push/send.js:47, :58-63); quote SENT with queued mail (quotes/send.js:346-347, :447); supplier RFQ "sent" (supplier_rfq/send.js:88, :110); sourcing "notified" (sourcing/network/handoff.js:108); inventory voice_at stamped on a failed insert (_lib/inventory/notifications.js:138-147) | Section 4 |
| D-4 | **Confirmed, worse.** The voice row cannot be written: voice_calls needs provider, external_id, direction (041:61-64) and allows no `queued` status (041:70-71); columns purpose and metadata do not exist. The insert error is not read, so voice_at is stamped and the daily cap counts calls that never existed. No reader of queued voice_calls exists | _lib/inventory/notifications.js:132-147 |
| D-5 | **Confirmed.** Date in four fingerprints; a new row, a new bell and a new email each day for one open problem; nothing auto-resolves | exceptions-detector.js:66, :77, :87, :238; notifications.js:92-126 |
| D-6 | **Confirmed on main.** Rows have no to_addr; the reaper marks them failed; email_at is stamped first, so they never retry. #623 fixes | _lib/logistics/notifications.js:192-206; _lib/inventory/notifications.js:113-126; agents/run.js:295-303 |

---

## 8. Open PR overlay

| PR | What changes in the L4 cards |
|---|---|
| #623 | M-38: new caller `bellStaleTick` (daily); the screen shows a refused mark-read. M-41: Teams fails `not_configured`; `failUnsentRow`; `lastError` returned; WhatsApp endpoint honest (channel whatsapp, failed). M-42: quote send becomes direct, so one producer leaves; copilot leftovers become failed. M-43: `alertRecipientsForRoles`. M-44, M-45: recipients, per-run and per-day email caps, the digest stands in for email. M-46: extraction watch shows the worker's last run; Comms list reads real rows. Fixes L4-D2 (endpoint), L4-D4, L4-D13 (copilot only), L4-D28. Leaves L4-D1, L4-D3 (WhatsApp and Slack in the core), L4-D13 (invoice) |
| #624 | M-38: migration 253 `recipient_user_id`; `notify()` writes one row per person; every role sees own rows; admin and operator see broadcast rows; bell in `MobileShell`; mark_read for every role; updates filter tenant_id. No caller of notify(). Fixes L4-D11, L4-D17. Leaves L4-D18, L4-D24 |
| #630 | M-41: a new direct caller (draft, then sendCommunication, then failed when queued). M-43: second caller of resolveInternalRecipients. Event 6a gets rows (section 2.2). Graph sends reply_to. No bell |
| #637 | New record for human work (`work_items` 252, `email_actions`, `email_rules` 268); `email/sync` producer. A new owned queue next to M-46. H-6 |
| #638 | Visibility rule and transitions for email items; four server actions. No change to M-38 to M-46 |
| #640 | A copy of #624. Ledger 270; `email/sweep` in tick ALWAYS and `email/sweep_daily` in daily; per-person reminders and escalation through notify(). Adds a third dedup rule (section 6.4). New defects L4-D14 (with #641) and L4-D25 |
| #641 | Email Actions screen; Home card "My email actions" beside "My queue": a second Home queue with a different scope (per user) from the first (not per user) |
| #642 | `email/purge` in daily; email health; heartbeat bounds for the email handlers. No L4 card change |

---

## 9. O-2 rows

| Mechanism | Schedule | Claim and lease | Retry and give up | Dedup | Decide (policy) | Act on an order | Send outside | Notify a person | Track human work | Escalate | Record the trail | Report health |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M-38 Bell | | | | 5-min key (_lib/notifications.js:50-60) | role gate (:65-71) | | | broadcast row (:87) | resolve flag (admin/notifications.js:68-79) | | the row | |
| M-39 Push | tick ALWAYS (cron/tick.js:153) | none (push/send.js:20-23) | none; failed final (:41, :58-63) | | | | web push (push/send.js:48) | per user (:31-34) | | | push_notifications; audit on queue (:95) | push/send row, 10 min |
| M-40 Communications | | | | idempotent sent (_lib/comms-send.js:110) | | link only | | | draft and queued as human-pending (_lib/comms-row.js:48-53) | | comm_send audit; PE (:222-233) | |
| M-41 Send rails | inline | none | none in rail | idempotent sent (:110) | provider order (:142-187) | quote SENT flip (quotes/send.js:346) | Graph, mailer, webhook, chat (:31-100; _lib/mailer.js:54-122) | | | | row status, audit (:198-227) | emailConfigured (_lib/mailer.js:48) |
| M-42 Reaper | inside agents/run, hourly (agents/run.js:358-366) | none (:277-283) | every run, no cap; give-up only "no recipient" (:295-311) | via M-41 | skip marketing (:294) | | via M-41 (:307) | | | | via M-41, actor null (:287) | agents/run, 2 h |
| M-43 Resolvers | | | | address dedup (_lib/internal-recipients.js:146-164) | who receives (section 3) | | | | | | | |
| M-44 Logistics | tick ALWAYS and daily (cron/tick.js:186; daily.js:91) | none; unique open row (206:82) | next run picks unstamped rows (_lib/logistics/notifications.js:94-111) | fingerprint (206:82); notified stamps | rules, severity (monitor.js:33-34) | | queued email (:192) | bell, digest, breach (:40, :175, :213) | ack, resolve, suppress (logistics/exceptions.js:54-56); SLA (206:64); owner unwritten (206:59) | breach bell once (:211-224) | ack audit (logistics/exceptions.js:80) | 30 h and 10 min rows (_lib/heartbeat-check.js:46-48) |
| M-45 Inventory | route only (router.js:740) | none | re-read all open (_lib/inventory/notifications.js:72-75) | fingerprint with date (exceptions-detector.js:66) | voice threshold (:37-39, :130) | | queued email (:113); dead voice (:138) | bell (:94) | ack, resolve (inventory/exceptions.js:41-42) | | | inventory-exceptions-tick, 10 min |
| M-46 Pull lists | screen load | review claim (docai/review_queue.js:107) | | per role (_lib/approval-evaluator.js:69-79); per run (123:56) | thresholds (_lib/approval-evaluator.js:56-92) | | | | approver_role; assigned_to | | review audit | |

Classes, column by column:

- **Notify a person: divergent.** Broadcast bell (M-38), per-user push (M-39, dead), per-exception bell with stamps (M-44, M-45), digest (M-44), agent broadcast. Pick one: per-person notify().
- **Send outside: divergent.** M-41 core vs WhatsApp endpoint vs marketing vs push; queued producers vs direct callers.
- **Dedup: divergent.** Four rules: 5-min window, unique open fingerprint, dated fingerprint, idempotent-on-sent.
- **Retry and give up: divergent.** M-42 retries forever; M-39 never retries; M-44 retries until stamped.
- **Schedule: double fire, by design.** M-44 in tick and daily.
- **Dead:** M-39 (no subscribe), M-45 voice branch, drift report send.
- **Gap:** escalate and due time for SO events. No SO event (1 to 6) has an owner, a due time or an escalation on main.

---

## 10. New mechanisms in the audit

| ID | Mechanism | Evidence | Attention channel? | Note |
|---|---|---|---|---|
| N-1 (new in the audit) | Nav count badges | lib/telemetry.ts:83-107, poll 30 s (:110, :240) | yes, counts only | tenant-wide; newest 200 orders; PENDING_REVIEW counted in two badges (:84, :88); phone shows them only inside More (MobileShell.tsx:101) |
| N-2 (new in the audit) | Home "My queue" | screens/home.tsx:64, :82-84 | yes, pull | not per user; first 8 of the newest 50; keeps approved Mode B orders |
| N-3 (new in the audit) | Orders Kanban | screens/pipeline-kanban.tsx:61-87; lib/rbac.ts:72 | yes, pull | the only list that shows FAILED_TALLY_IMPORT as its own column (:83); operator and procurement cannot open it |
| N-4 (new in the audit) | Background extraction watch | components/BackgroundExtractionWatch.tsx:23-28; so-workspace.tsx:2651 | yes, while open | the only signal for event 2 |
| N-5 (new in the audit) | ERP health banners in Admin | screens/admin.tsx:2477-2479; tally/health.js:67 | yes, pull, admin | the only place a Tally give-up shows |
| N-6 (new in the audit) | Thread drawer comms panel | components/ThreadDrawer.tsx:156; app.tsx:487 | yes, pull | the only working reader of communications rows |
| N-7 (new in the audit) | Comms screen | screens/comms.tsx:84-95 | broken | reads /api/audit with no auth and unused action names |
| N-8 (new in the audit) | Tally push screen "Failed" KPI | screens/tally-push.tsx:32-33, :52 | blind | L4-D9 |
| N-9 (new in the audit) | Manual customer drafts "queued for a human" | comms/dispatch_register.js:9-10, :86; comms/payment_statement.js:9-10, :96; comms/service_report.js:122 | a send rail by accident | L4-D1 |
| N-10 (new in the audit) | Copilot draft and send | copilot/confirm.js:46-66 | send rail | through sendCommunication |
| N-11 (new in the audit) | Drift report email | cron/drift-report.js:105-125, :167-178 | send rail with its own resolver | dead (L4-D21) |
| N-12 (new in the audit) | Signup direct bell insert | auth/signup.js:120-134 | bell writer outside the helper | L4-D24 |
| N-13 (new in the audit) | Rep touch log | _lib/rep-touch.js:1-14 | no | a communications row written as sent; a record, not a notice |
| N-14 (new in the audit) | print_jobs | orders/print_jobs.js:1-30 | no | an outbound device queue drained by an on-prem relay (PRINT_RELAY_SECRET) |
| N-15 (new in the audit) | AP deductions queue | ap/deductions.js; 054 | no | buy side; out of SO scope |
| N-16 (new in the audit) | Agents screen | screens/agents.tsx:71, :117, :137 | yes, pull | the only place goals and their escalations are listed |

---

## 11. Defects found, not fixed

| ID | Where | Failure scenario | Severity | Suggested fix |
|---|---|---|---|---|
| L4-D1 | comms/dispatch_register.js:86 (header :9-10); comms/payment_statement.js:96 (:9-10, :108-109); comms/service_report.js:122 (:9-10); reaper agents/run.js:276-312 | An engineer drafts a payment reminder to check it. The code says a human confirms. The row is `queued`. The next hourly run for this tenant (any armed quote goal is due at once) sends it to the customer, maybe to the operator fallback address. Needs the tick (H-1) | high | Insert `draft`; send only on send:true |
| L4-D2 | whatsapp/send.js:89-112, :122; _lib/comms-row.js:52, :91 | No WhatsApp provider. The row is stored `queued`, channel `email`, a phone number as the address, and the endpoint answers ok. The reaper later emails a phone number | medium | Set channel whatsapp and status failed (#623) |
| L4-D3 | _lib/comms-send.js:142-187 (line 173 runs for every channel) | A WhatsApp or Slack row with no chat config goes out through the email provider to a phone number or a channel id | medium | Return not_configured for chat channels when sendViaChat is null |
| L4-D4 | _lib/comms-send.js:80-81 | Teams send stores `sent` with nothing sent; Ask Anvil says done | medium | Fail not_configured (#623) |
| L4-D5 | _lib/logistics/notifications.js:173-186, :211-224; _lib/notifications.js:71, :90-93 | Rule roles have no approved member, or the insert fails. notifyAdmins returns notified 0 without throwing. bell_at or breach_bell_at is stamped. The exception never notifies. The digest path already checks this (:48) | medium | Stamp only when notified > 0 or deduped |
| L4-D6 (D-4) | _lib/inventory/notifications.js:132-147; 041:61-71 | The voice insert always fails (NOT NULL columns, status CHECK, missing columns). voice_at is stamped. The daily cap counts calls that never existed | medium | Remove the branch, or call voice/outbound with its compliance gate and read the error |
| L4-D7 (D-5) | _lib/inventory/exceptions-detector.js:66, :77, :87, :238 | One stockout opens a new row, a new bell and a new email every day; old rows stay open | medium | Drop the date from the fingerprint; auto-resolve when the condition clears |
| L4-D8 (D-2) | tally/retry.js:51-63; netsuite/retry.js (no notice) | A Tally push gives up after 5 tries. Nobody is told. Only an admin who opens the Tally tab sees a count | medium | Notice on give-up, as erp-runner.js:123, to the order owner when known |
| L4-D9 | screens/tally-push.tsx:32-33, :52; tally/push.js:227 | The screen fetches APPROVED and EXPORTED_TO_TALLY only, then looks for FAILED_TALLY_IMPORT inside them. A failed push never shows in "Failed" | medium | Also fetch status FAILED_TALLY_IMPORT |
| L4-D10 | sap/push.js:115-149 (same shape in the other erp-runner pushes [I]); agents/_handlers/failed_push_recovery.js:15, :31 | A first push that SAP rejects with a 4xx is not queued and rings nothing. The order status does not change, so the recovery goal marks complete at once | medium | Notice on a permanent first failure; a failed marker the goal and the stage read |
| L4-D11 | components/Shell.tsx:135, :171, :600; admin/notifications.js:43 | An operator sees the bell, clicks a row, the server answers 403, the client hides it. The unread count never falls | medium | Allow mark_read for viewers of the row (#624) |
| L4-D12 | agents/run.js:117-127; agents/_handlers/index.js:10; quotes/send.js:64-65, :74-75 | A quote goal escalates. Its owner (set at send) is not told; a broadcast goes to admin | medium | notify({users:[owner_user_id]}) after #624 |
| L4-D13 | invoices/send.js:177, :196; copilot/confirm.js:48-60; _lib/comms-send.js:196 | No provider: the person is told "not sent". The row stays queued. When a provider is set, the reaper sends it; a retry by the person sends a second copy | medium | failUnsentRow on every inline caller (#623 covers copilot and quote, not invoice) |
| L4-D14 | #640 escalation.js (`link_route: "email_actions"`); #641 routes.ts (`"email-actions"`); components/Shell.tsx:145-151 | Every email reminder bell row fails the route check and shows "no longer exists" | medium | Use "email-actions" in #640 |
| L4-D15 | _lib/inventory/notifications.js:92-104, :113-126; _lib/logistics/notifications.js:192-206 | An insert error is returned, not thrown. email_at (and the inventory bell_at) is stamped after a failed insert | low | Read `error` before stamping |
| L4-D16 | _lib/erp-runner.js:128, :157; screens/admin.tsx:172-174 | A SAP give-up bell links to admin?tab=sap. No such tab. The screen opens Members. Same for d365, acu, eclipse, p21, sxe, sagex3 | low | Map the prefix to a real tab or a retry list |
| L4-D17 | admin/notifications.js:26-35 | Any viewer role can call the API and read every unresolved tenant notice, including ERP errors | low | Apply the recipient rule on the server (#624) |
| L4-D18 | _lib/notifications.js:65-71 | A notice for a role with no approved member writes no row, though admin and operator would see one | low | Fall back to admin, or return a reason callers must handle |
| L4-D19 | _lib/comms-send.js:226 | No provider: audit says "manual::sent" while the row is queued | low | Write "manual::queued" |
| L4-D20 | push/send.js:46-63 | Every subscription is fcm or apns. The loop skips them and marks the row sent | low | Count web sends; fail on zero |
| L4-D21 | cron/drift-report.js:174-178, :112-122; _lib/comms-row.js:69, :86; _lib/comms-send.js:178 | The report reads a `users` table that no migration creates, so it never queues. If fixed, the HTML goes to metadata and the email carries only the placeholder line | low | resolveInternalRecipients role:admin; send html |
| L4-D22 | supplier_rfq/send.js:88, :107-110 | A failed comms insert gives both ok:false and ok:true for one vendor; the RFQ is "sent" before any email leaves | low | continue after the error; mark sent after a real send |
| L4-D23 | sourcing/network/handoff.js:78-93, :108 | The caller is told the peer "has been notified". The row is queued in the peer tenant and leaves only if the peer has a due goal | low | Send direct, or say "queued" |
| L4-D24 | auth/signup.js:120-134 | One identical broadcast row per admin; every admin sees N copies | low | One notifyAdmins call |
| L4-D25 | #640 escalation.js (`ok = !result?.error && !result?.skipped`) | notify() reaches nobody and returns notified 0. The ledger marks the notice sent, delivered 0, and never retries | low | Treat notified 0 as failed |
| L4-D26 | agents/run.js:311, :329-336, :361 | A queued row with no provider retries every hour forever. A tenant outside the first 50 due goals is not reaped | low | Attempt cap and own schedule for the reaper |
| L4-D27 | _lib/dispatch-register-send.js:117; comms/dispatch_register.js:80; comms/payment_statement.js:91; comms/service_report.js:116 | Only the first To address is kept; the other To recipients are dropped | low | Put the rest in CC, or add a To list |
| L4-D28 (D-6) | _lib/logistics/notifications.js:192-206; _lib/inventory/notifications.js:113-126 | Alert emails have no recipient; the reaper fails them; email_at is already stamped | medium | alertRecipientsForRoles (#623) |

Count: 1 high, 14 medium, 13 low.

---

## 12. Target model notes

### 12.1 Per mechanism

| Mechanism | Action | Reason |
|---|---|---|
| M-38 Bell | adapt onto notify() | keep the table; every writer goes through one per-person helper; notifyAdmins becomes a wrapper |
| M-39 Push | retire now, rebuild later as a notify() channel | dead; no subscribe path; C-20 decides the second channel |
| M-40 Communications | keep | it is the record; fix the meaning of `queued` (deferred send only) and `draft` (human) |
| M-41 Send rails | merge into sendCommunication | one rail that reports only provider-confirmed results; WhatsApp endpoint and chat branches move in; marketing keeps its gates but shares the mailer adapter |
| M-42 Reaper | adapt onto the queue contract | own schedule, claim, attempt cap, age limit; out of agents/run |
| M-43 Resolvers | merge | one staff resolver, one customer resolver |
| M-44 Logistics | adapt | keep detection; notices through notify(); owner written; a human-owned exception mirrors into a work item |
| M-45 Inventory | adapt | fix the fingerprint; remove the voice branch; same notice path as M-44 |
| M-46 Pull lists | keep, read from the stage | C-9/C-11 worklist; add owner and due through work items |

### 12.2 One notice helper

- **Where.** `notify()` in `src/api/_lib/notifications.js` (#624).
- **Shape.** `notify(svc, tenantId, payload, { users, roles, key })`. Roles expand through the staff resolver (12.4). One row per person. Optional email through the send rail (12.3) when policy says so.
- **Dedup.** One ledger, keyed by subject and notice key (and recipient), generalised from #640's 270 before it merges. Drop the 5-minute window.
- **First movers.** erp-runner give-up and the new Tally and NetSuite give-up (L4-D8); agent escalation to the goal owner (L4-D12); logistics and inventory dispatchers (L4-D5); C-19 SO events (submit, return, approve, handoff, extraction done).
- **Relation to #624 and EA-3.** #624 merges first. #640 uses the generalised ledger instead of an email-only one.

### 12.3 One send rail

- **Where.** `sendCommunication` in `src/api/_lib/comms-send.js`.
- **Rules.** A row starts `draft` (a person must act) or `queued` with a send time (a machine will send). The rail returns `sent` only when a provider accepted. Chat channels without config fail `not_configured`. No "manual" success.
- **First movers.** The three manual draft endpoints (L4-D1); WhatsApp endpoint (L4-D2); chat fall-through (L4-D3); invoice leftover (L4-D13); supplier RFQ and sourcing (direct). Auth mail may stay on the mailer directly; it has no business row.

### 12.4 One recipient resolver

- **Staff.** `resolveInternalRecipients` in `src/api/_lib/internal-recipients.js`. It already returns `user_id` and email per role member. notify(), alertRecipientsForRoles (#623), the handoff (#630), the drift report and the #640 policy roles call it. resolveAssignee stays as the check for one person.
- **Customer.** `resolveForCustomer` in `src/api/_lib/comms-routing.js`. Quote send and invoice send move onto it with document types `quote` and `invoice`.

### 12.5 One record for human work

- **Where.** `work_items` (252), adjusted before #637 merges (AD-5): a `subject_ref` pointer, one status registry per subject type, one priority vocabulary, closing evidence for every order item (section 6.3).
- **First movers.** Email actions (EA-3); agent goal escalation creates an owned item (WM 4.11, row 1); a logistics exception that needs a human owner; pending quote_approvals become approval items for their role.
- **Relation to R-M6.** An order item points at the stage or an exception through `subject_ref`. Its status is the work's state and evidence closes it. It never writes `orders.status`.

---

Not checked: live state (no owner queries run); the 14 erp-runner pushes other than SAP were not read one by one (L4-D10 for them is inferred); MobileShell behaviour on a device was not run; #635, #636 and #639 diffs were not read.

---

# L5 audit: trail, actor, tenant, auth, config

Auditor: L5 (read only). Audit base: `origin/main` at `931eb143`. The checkout
adds only `docs/SO_AGENT_INFRA_AUDIT_PLAN.md` on top. Every `path:line` is
under `src/api/` unless it starts with `src/`, `supabase/` or `docs/`.
`NNN:line` is a file in `supabase/migrations/`.

Labels (plan 6.1): **Verified** means read in code. **Inferred** means it
follows from verified facts, with the steps written. **Not confirmed** means
neither. No live database was read, so every "live" answer is "not
confirmed" until the owner runs the 6.4 queries.

Method. A small read-only script listed every `.from("t")` chain with no
`tenant_id` in the chain, for about 200 handler and helper files of M-1 to
M-46 (cron, agents, copilot, MCP, voice, inbound, WhatsApp, prospecting,
email, docai, orders, quotes, portal, tally, the 16 other ERP connectors,
notifications, push, comms, logistics, inventory). Each hit was read by hand.
Separately, every handler with both a `CRON_SECRET` branch and a
`resolveContext` branch was read for its user path.

---

## 1. Cards M-47 to M-49

```
M-47  Audit log (audit_events)                     layer: L5
status on main: wired
live: not confirmed (query 6 in 6.4)
Q1  job: an append-only row per business action, with actor uuid and role.
    Asked for by "Audit log (item 40)" in 001_init.sql:320; hardened by
    058 (append-only) and 063 (failure sentinel).
Q3  trigger: inline. 482 recordAudit/recordAudits call lines in 311 files
    (grep, tests excluded), plus 17 direct inserts in 14 files that skip the
    helper (for example agents/run.js:88, agents/handle_replies.js:147,
    inbound/email/draft_orders.js:78, inbound/process_messages.js:60,
    voice/process_actions.js:119, inbound/auto_ocr.js:152,
    inbound/email/webhook.js:246, portal/reorder.js:104).
Q4  unit of work: audit_events 001:323. No status column. Writer
    _lib/audit.js:74 (recordAudit), :105 (recordAudits). Columns actor uuid
    FK auth.users 001:326, actor_role enum 001:327.
Q5  claim: none (append only).   Q6  retry: none. A failed insert goes to
    audit_failures through recordSentinel (_lib/audit.js:39-57, :83-94).
    The 17 direct inserts have no sentinel and most do not check the error.
Q7  dedup: none. payload_hash column is optional (001:333).
Q8  tenant: tenant_id from ctx (_lib/audit.js:60). A call without
    ctx.tenantId is dropped with a console warning (:75-79). Readers filter
    on tenant (audit/index.js:15, audit/export.js:54). RLS: select only
    (058:37-38); no update or delete through a user JWT (058:28-31).
Q9  authority: service role writes. POST /api/audit lets any "write" role
    write any action with any before/after payload (audit/index.js:23-28).
Q10 outside effects: signed ndjson export (audit/export.js:23, :53-86).
    The export orders and filters on a column "ts" (audit/export.js:55-58)
    that audit_events does not have (001:323-338). Verified schema; the
    runtime failure is Inferred (PostgREST rejects an unknown column).
Q11 order writes: none. But three readers ACT on audit rows:
    billing/usage.js:62-68 (outcome billing by action), 
    _lib/metrics/catalog.js:174-177 (SO cycle metric, #620),
    cron/drift-report.js:231-236 (send-once key). So "display only" is
    false for M-47.
Q12 failure goes to: audit_failures 063:20. No code reads it (grep of
    src/api finds only the writer). The 063:38-39 comment promises a P0
    alert that does not exist.
Q13 trail: actor = ctx.user.id or null (_lib/audit.js:61). Cron, webhook,
    agent and portal rows all store null. See section 2.
Q14 health: none.                Q15 config: AUDIT_EXPORT_HMAC_SECRET for
    export only (audit/export.js:23).
Q16 tests: src/v3-app/api-actor-user-id.test.js (actor = ctx.user.id on
    named handlers). No test of recordSentinel, of the enum failure, or of
    audit/export.js against the real column set.
Q17 overlaps: M-48, M-49, communications (M-40), admin_notifications (M-38).
Q18 owner plan: O-3 constraint 8; none in an open PR.
notes / defects (to O-6): L-1, L-2, L-3, L-4, L-5, L-6, L-12 in section 10.
```

```
M-48  Processing events (processing_events)        layer: L5
status on main: wired
live: not confirmed (query 6)
Q1  job: a timeline row per pipeline step, keyed by case_id. 001:343.
Q3  trigger: inline. 38 recordEvent call lines in 29 files
    (_lib/audit.js:139), plus 10 direct inserts: agents/run.js:108, :239;
    agents/handle_replies.js:94, :106; voice/webhook.js:110;
    voice/process_actions.js:42; voice/outbound.js:151;
    inbound/process_messages.js:78, :110;
    inbound/email/_lib/persist-attachments.js:146. (Plan said about 13.)
Q4  unit of work: processing_events 001:343. No status. case_id text NOT
    NULL (001:346). No actor column at all (001:343-353).
Q5  claim: none.  Q6 retry: none; recordEvent uses the sentinel
    (_lib/audit.js:155-166); direct inserts do not.
Q7  dedup: none.
Q8  tenant: tenant_id from ctx or the row. Readers filter on tenant
    (events/index.js:16, orders/pipeline_state.js:161-166,
    orders/extraction_status.js:210-217).
Q9  authority: POST /api/events lets any writer add any event_type for any
    case_id in the tenant (events/index.js:20-32).
Q10 outside effects: none.
Q11 order writes: none. Readers are display only (Verified for the three
    readers above). extraction_status derives a progress summary.
Q12 failure goes to: audit_failures (recordEvent) or nowhere (direct).
    Three writers can break NOT NULL case_id: voice/outbound.js:152
    (case_id null), tally/reconcile.js:106 (scopeValue || null),
    admin/item_customer_parts.js:74 (null).
Q13 trail: no actor. case_id means an order id, an email id
    (handle_replies.js:95), a call id (process_actions.js:44), a chat
    message id (process_messages.js:79), a goal id (run.js:240) or a
    document id (pipeline_state.js:159). A timeline by order id sees only
    the order-keyed rows.
Q14 health: none.   Q15 config: none.
Q16 tests: 8 test files touch processing_events; none checks the case_id
    NOT NULL rule or the direct inserts.
Q17 overlaps: M-47 (same events written twice with different shapes, for
    example tally/push.js:230-243), agent_steps, communications.
Q18 owner plan: O-3 constraint 8; none.
notes / defects: L-3, L-4, L-13.
```

```
M-49  Per-mechanism logs                            layer: L5
status on main: wired
live: not confirmed (query 1 and 6)
Q1  job: each mechanism keeps its own run log.
    agent_steps 011:104 (writer agents/run.js:47, handle_replies.js:74);
    mcp_call_log 027:41 (writer _lib/mcp.js:72-83);
    erp_chat_messages 026:18 (writer erp_chat/send.js:97, :204, :220);
    <erp>_sync_runs (015:56, 016:187-200; writer _lib/erp-runner.js:26-38);
    tally_reconciliation_runs 095:33 (writer _lib/tally-reconciler.js:279,
    :526); cron_health 066:18 (writer _lib/cron-mux.js:220-240);
    model_routing_log 005:130 (writer _lib/anthropic.js:382, :415);
    action_proposals 149:12; operator_action_steps 150:39;
    communications 005:22 (+189).
Q3  trigger: the owning mechanism, inline.
Q4  unit of work: one row per step, call, message, run or heartbeat.
    cron_health is one row per worker (PK worker, 066:19).
Q5  claim: none. cron_health failure count is read then written
    (_lib/cron-mux.js:234-238): two writers can lose a count.
Q6  retry: none. agent_steps insert error is not checked (run.js:47).
Q7  dedup: cron_health by worker only. agent_steps has no unique
    (goal_id, step_no) (011:104-125), and the goal runner has no lease
    (run.js:331-336), so two overlapping runs can write the same step_no.
    Inferred.
Q8  tenant: all have tenant_id except cron_health (global, no RLS: no
    "enable row level security" for cron_health in any migration).
Q9  authority: service role.
Q10 outside effects: none.
Q11 order writes: none.
Q12 failure goes to: console only.
Q13 trail: section 2 table.
Q14 health: cron_health IS the health source (health.js:113,
    _lib/heartbeat-check.js:57). No log has a staleness check of its own.
Q15 config: none.
Q16 tests: src/v3-app/api-heartbeat-check.test.js,
    api-cron-logistics-daily.test.js (cron_health). No test for the others
    as a trail.
Q17 overlaps: M-47 and M-48 for every mechanism that writes both.
Q18 owner plan: none.
notes / defects: L-14, L-15, L-16, L-17.
```

---

## 2. Actor recording

How `recordAudit` records the actor. `auditRow` writes `actor =
ctx.user ? ctx.user.id : null` and `actor_role = ctx.role || null`
(`_lib/audit.js:59-62`). `actor` is a uuid FK to `auth.users` (001:326).
`actor_role` is the role enum (001:327; values 001:26-28 plus 116:30,
196:13-14, 198:10). There is no "agent" or "system" value and no actor-kind
column. **Verified.**

How cron paths record. Cron handlers build `{ tenantId }` or `{ tenantId,
user: null }` (for example `cron/extraction_jobs.js:664`, `:905`;
`agents/run.js:287`). The row gets `actor = null`, `actor_role = null`.
**Verified.**

Two cron and webhook shapes break the insert:

- `role: "system"` or `role: "service"` is not an enum value. The insert
  fails and the row goes only to `audit_failures`. In scope:
  `email/inbound.js:235` (M-29), `whatsapp/inbound.js:197` (M-22; both audit
  calls at :214 and :276), `cron/inventory-planning-weekly.js:757` (M-7).
  Out of scope, same defect: `eway_bills/expire.js:42`, `fx/cron.js:81`,
  `service/amc_cron.js:94`, `billing/recurring_cron.js:104`. **Verified**
  (enum list); the runtime failure is **Inferred** (Postgres rejects an
  invalid enum literal).
- `role: "admin"` with no user on a webhook: `email/inbound.js:159`, `:167`;
  `comms/graph_callback.js:72`. The row claims an admin did it. **Verified.**

| Log | Actor field(s) | Person | Agent | System / cron | Can a reader tell them apart? |
|---|---|---|---|---|---|
| audit_events (001:323) | `actor` uuid, `actor_role` enum | user id + role | null + null (run.js:88-93, object_type agent_goals) | null + null | No. Agent, cron, webhook and portal all store null. Only the action name or object_type hints. 6 direct inserts use wrong column names and are lost (L-2) |
| processing_events (001:343) | none | no | no | no | No. No actor column. Some rows put `severity` or `from` in `detail` |
| agent_steps (011:104) | none on the row; goal has `created_by`, `owner_user_id` (agents/goals.js:76-77) | n/a | implicit (every row is the agent) | n/a | Yes by table. The person who armed the goal is on agent_goals. Auto-armed goals store the quote owner as `created_by` (quotes/send.js:65-66), so a system arming looks like a person |
| mcp_call_log (027:41) | `token_id`, `ip`, `user_agent` | via mcp_tokens.user_id (027:15) | the external client is the caller | no | Partly. The token owner is not the live caller. A token keeps working after its owner leaves the tenant (L-15) |
| erp_chat_messages (026:18) | `role` user / assistant / tool (026:22); session `user_id` (026:11) | role=user | role=assistant/tool | no | Yes. But a message can sit in another tenant's session (T-9) |
| model_routing_log (005:130) | none (no user column) | no | no | no | No. `_lib/anthropic.js:244` says userId is recorded; the inserts at :382-394 and :415-427 do not record it (L-16) |
| `<erp>_sync_runs` (015:56, 016:200) | `triggered_by` text in ('cron','manual','retry') | 'manual' | no | 'cron' | Kind only. No user id for 'manual' (tally/sync.js:232, sap/sync.js:307, and the other 13) |
| tally_reconciliation_runs (095:33) | `trigger` text (095:36), `triggered_by` uuid (095:46) | uuid | no | trigger='cron', uuid null (cron/tally-reconcile.js:52-53) | Yes |
| cron_health (066:18) | `worker` name | no | no | yes | System only, by design |
| communications (005:22, 189:63) | `sent_by` uuid, `direction`, `metadata` | sent_by | sent_by null + metadata.agent_goal_id (agents/run.js:162-163) | sent_by null | Partly. The dispatch register auto-send records the person who saved despatch lines as `sent_by` (_lib/dispatch-register-send.js:123) for an automatic send (L-17) |
| action_proposals (149:12) | `created_by` (149:15) | proposer | the drafting surface is not stored | no | No source column: a reader cannot tell an Ask Anvil proposal from an MCP proposal (_lib/action-proposals.js:25-35; L-18) |
| operator_action_steps (150:39) | `done_by` (150:48); parent `driver` 'human' / 'cua' (150:27), `created_by` | yes | driver='cua' (future) | no | Yes, by design |
| admin_notifications (042:89) | `actor_user_id`, `actor_email` | only auth/signup.js:110-130 sets them | no | null | No. notifyAdmins passes `payload.actor_user_id` (_lib/notifications.js:82) but no SO caller sets it |

Gotcha check. `grep -an "ctx\.userId"` over `src/api` finds only comments
that warn about it (push/subscribe.js:19, push/unsubscribe.js:13,
docai/extract.js:190, docai/correction.js:70, source_pos/ack_accept.js:138).
No live `ctx.userId` read is left. **Verified.** `_lib/erp-chat-tools.js:663`,
`:696`, `:725`, `:753` read `ctx2?.userId`, but `ctx2` is the tool's own
`{ userId }` object (`:799`), so the actor is right. **Verified.**

Null actor on a user path. Handlers that run under a person but store null:

- `tally/retry.js:102-109` writes the audit row only when `ctx` is set. The
  manual path passes ctx (`:165-169`), so it is fine; the cron path stores
  nothing (L-7).
- `agents/handle_replies.js:147-153` and `voice/process_actions.js:119-125`
  write a null actor even on the manual drain, where an approver started the
  run (`:180`, `:149`). The drain's own `recordAudit(ctx)` row records the
  approver, but the per-row actions do not. **Verified.**
- `inbound/email/webhook.js:246-253` and `portal/reorder.js:104-111` insert
  `actor_id`, which is not a column (001:326 names it `actor`). The insert
  fails, so the row is lost, not just actor-less (L-2). **Verified** schema.

---

## 3. One timeline

Readers that build an order timeline:

| Reader | Sources | Filter | Shows actor? |
|---|---|---|---|
| `src/v3-app/components/ThreadDrawer.tsx:148-163` | audit_events by `object_id` (any object_type), processing_events by `case_id`, communications by `order_id` | `client/anvil-client.js:1059-1070`, `:1573-1581` | No (merge at :67-100 drops actor) |
| `src/v3-app/screens/so-workspace.tsx:445`, `:491`, `:606-655` (Activity tab) | audit_events by `object_id`, processing_events by `case_id`. No communications | same | No (`reason` only, :634) |
| `events/index.js:12-18` | processing_events by case_id | tenant | No column |
| `orders/pipeline_state.js:153-167` | processing_events by case_id = order or source document | tenant | No column |
| `orders/extraction_status.js:210-217` | processing_events, last 30 minutes | tenant | No |

No reader reads agent_steps, mcp_call_log, action_proposals,
tally_reconciliation_runs or findings, tally_retry_queue, admin_notifications,
or model_routing_log for an order. **Verified.**

For one order, which actors appear:

| Actor | Rows it writes for the order | On the timeline? | Evidence |
|---|---|---|---|
| Person editing the SO | audit object_type order, actor set; events case order | Yes, with no actor shown | orders/[id].js, tally/push.js:230-243 |
| Agent goal (escalate) | processing_events `agent_escalation`, case_id = goal.object_id | Yes (PR row) if the goal targets an order | agents/run.js:108-115 |
| Agent goal (any step) | audit `agent_action_taken`, object_type agent_goals, object_id goal id | No | agents/run.js:79-93 |
| Agent goal (send_email) | communications with object_type/object_id, no order_id; send audit object communication; event only when order_id is set | No | agents/run.js:151-163; communications/list.js:94; _lib/comms-send.js:222-233 |
| Copilot confirm, post_tally_voucher | audit `tally_voucher_enqueued`, object order, actor = confirming person, detail "copilot confirm" | Yes, but reads as a person action | copilot/confirm.js:89 |
| Copilot confirm, draft_and_send_comms | communications with order_id; `comm_sent` event case order | ThreadDrawer yes; SO Activity shows the event only | copilot/confirm.js:48-60; _lib/comms-send.js:228-233 |
| Copilot confirm (wrapper) | audit object action_proposal | No | copilot/confirm.js:125-130 |
| MCP | mcp_call_log only (reads); write tools create proposals that a person confirms through copilot/confirm.js | Reads: no. Writes: as copilot | _lib/mcp.js:110-142 |
| Voice intake (order created) | audit object voice_call_action; event case call_id | No row keyed to the new order | voice/process_actions.js:42-49, :54-75, :119-125 |
| Chat intake (Slack, Teams, WhatsApp v2) | audit `inbound_chat_drafted_order`, object order, actor null | Yes | inbound/process_messages.js:58-66 |
| Legacy WhatsApp | audit object order but role "service" (dropped); event `whatsapp_message` case order | Event yes; audit no | whatsapp/inbound.js:197, :276-288 |
| Legacy email | event `document_uploaded` case order; audit role "system" (dropped) | Event yes; audit no | email/inbound.js:228-240 |
| Email draft_orders | audit `inbound_email_drafted`, object order | Yes | inbound/email/draft_orders.js:78-84 |
| Background extraction job | events case order (`docai_*`); audit object extraction_job; the line rewrite and any approval clear have no order audit row | Events yes; line rewrite and approval clear no | cron/extraction_jobs.js:157-169, :664, :805-823, :905-910 |
| Tally retry (cron) | order status set to EXPORTED_TO_TALLY; no audit, no event | No | tally/retry.js:97-109 |
| Tally retry (manual) | audit `tally_push` object order | Yes | tally/retry.js:102-108 |
| Reconciler (cron) | tally_reconciliation_runs and findings only | No | cron/tally-reconcile.js:47-56; _lib/tally-reconciler.js:279, :368 |
| Reconciler (manual, scope order) | audit object tally_reconciliation_run; event case scopeValue | Event yes (scope order); fails for tenant scope | tally/reconcile.js:94-108 |
| Operator action reconcile | event `operator_action_reconciled` case order; audit object operator_action | Event yes | operator_actions/reconcile.js:72, :87 |
| Notices (bell) | admin_notifications object_type/object_id | No | _lib/notifications.js:76-87 |

Answer to L5 question 1: **No.** No single reader reads every event for an
order. At least seven actor paths leave nothing keyed to the order id.
**Verified** for each row above.

---

## 4. Tenant isolation sweep (most important)

Summary. 15 findings: the 2 known D-1 drains plus 13 new. 12 are in
M-1 to M-46 handlers, 1 is in eval (outside section 4), 1 is a by-design
global token, 1 is a missing RLS (Inferred). Every finding is cross-tenant,
so every finding is high, with the exploit cost noted.

### 4.1 Findings

| # | Mechanism | `path:line` | Query or input | Read / write across tenants | Label |
|---|---|---|---|---|---|
| T-1 (D-1) | M-14 | agents/handle_replies.js:181 calls `drainOnce` :126-132 | `inbound_emails` select by intent, no tenant | Write: pauses and acts on every tenant's goals and emails. Read: the response returns other tenants' email ids, intents, outcomes (:155-160) | Verified |
| T-2 (D-1) | M-20 | voice/process_actions.js:150 calls `drainOnce` :99-127 | `drainQueue` with no `tenantId` (queue-runner supports it: _lib/queue-runner.js:57, :67) | Write: creates DRAFT orders in other tenants (:54). Plan cited :152; at base it is :150 | Verified |
| T-3 (new) | M-26 | inbound/email/parse.js:148 calls `drain` :119-129 | `inbound_emails` where status='received', no tenant | Write: classifies and links other tenants' mail (:98-103), spends LLM cost on their keys (:65). Read: returns their email ids, customer_id, intent, confidence (:104-109). An approver of any tenant can call it | Verified |
| T-4 (new) | M-27 | inbound/email/persist_attachments.js:128 calls `drainOnce` :38-54 | `inbound_emails` select, no tenant | Write: persists other tenants' attachments. Read: returns their email ids and error text | Verified |
| T-5 (new) | M-36 | cron/tally-reconcile.js:90 calls `drainOnce` :20-60 | `tally_voucher_records` and `tenant_settings`, all tenants | Write: calls every add-on tenant's Tally bridge and runs their auto-fix if they enabled it. Read: returns per-tenant run results with tenant_id | Verified |
| T-6 (new) | M-36 | cron/drift-meter.js:156 (admin of any tenant, :152-155) calls `drainOnce` :28-140 | `tally_drift_billing_meter`, all tenants | Write: reports other tenants' usage to Stripe or Razorpay. Read: returns tenant ids and provider errors (:130, :142) | Verified |
| T-7 (new) | M-3 | cron/drift-report.js:270 (admin of any tenant, :266-269) calls `drainOnce` :206 | `tenant_settings`, `tenants`, `audit_events` for all enabled tenants | Write: on day 1, sends every enabled tenant's monthly report. Read of the response: Not confirmed | Verified action |
| T-8 (new) | M-2 (daily) | quotes/expire.js:75 (approver, :74) calls `drainOnce` :27-55 | `quotes` past `expires_at`, no tenant | Write: expires every tenant's due quotes. Same effect as the cron; low impact | Verified |
| T-9 (new) | M-15 | erp_chat/send.js:85 (`session_id` from body, never checked) | :97, :204, :220 insert into that session; :105-108 select messages by `session_id` only; :231 update by id | Read: the model receives the other tenant's whole chat history (tool results hold order and customer data) and can repeat it. Write: injects messages that the victim's next turn and `erp_chat/sessions.js:36` read. Needs the session uuid | Verified |
| T-10 (new) | M-11 | orders/extraction_jobs.js:126 (`storage_path` from body) and :125 (`document_id`, :124 `customer_id` fallback) | cron/extraction_jobs.js:179 downloads `job.storage_path` from the shared `documents` bucket with the service role, no tenant prefix check | Read: extracts another tenant's file into the caller's order (writes lines at :808). Needs the object path. (`document_id` is safe: :186-188 filter on tenant) | Verified |
| T-11 (new) | M-39 | push/send.js:88 (`subscription_id` from body) | drain :29 selects `push_subscriptions` by id only | Write: sends the caller's title and body to another tenant's device. Dormant while nobody subscribes (plan M-39). Needs the subscription uuid | Verified code; live Not confirmed |
| T-12 (new) | M-35 | _lib/tally-client.js:155-163 | env bridge fallback for any tenant with no tally_companies row | Write: a second tenant's voucher posts into the env tenant's Tally books. Only when `TALLY_BRIDGE_URL` is set. #619 binds it to one tenant | Verified code; live config Not confirmed |
| T-13 (new, outside sec. 4) | eval | eval/replay.js:373, eval/rescore.js:168 (writer role, :370, :165) | `tenant_id` from the body | Read: runs and scores another tenant's golden cases and returns per-case checks and costs (replay.js:246-256). LLM spend on that tenant's documents | Verified |
| T-14 (by design) | M-22, M-29 | whatsapp/inbound.js:166-178; email/inbound.js:125-140 | one global token; tenant from `x-anvil-tenant` header, else DEFAULT_TENANT_ID | Write: any holder of the token creates DRAFT orders and documents in any tenant. WhatsApp compares with `!==`, not timing-safe (:173), and accepts the token in the query string (:171) | Verified |
| T-15 (Inferred) | M-47, M-5 | audit_failures 063:20-31; cron_health 066:18 | no `enable row level security` for either table in any migration | Read: `audit_failures.raw_payload` holds every tenant's failed audit rows with before/after payloads. Steps: Supabase grants new public tables to anon and authenticated by default; with no RLS, PostgREST serves all rows to any request with the anon key. The app does not ship the anon key to browsers, which lowers the risk | Inferred |

### 4.2 Checked and safe on a user path

- ERP retry and sync user paths scope to `ctx.tenantId` (for example
  `_lib/erp-runner.js:78`, `:83`; `tally/retry.js:125`, `:165`;
  `sap/retry.js` user branch; `netsuite/sync.js` user branch). The by-id
  updates use ids from tenant-scoped rows. **Verified.**
- Manual drains that pass the tenant: `inbound/process_messages.js` (user
  path `drainOnce(svc, ctx.tenantId)`), `inbound/email/draft_orders.js`,
  `inbound/auto_ocr.js`, `prospecting/run.js` (`runForTenant`),
  `cron/extraction_reaper.js`, `cron/eval_quality_alert.js`. **Verified.**
- `erp_chat/sessions.js:29` checks the session tenant before :36.
  `inbound/email/threads.js:33-34` checks the thread before :39.
  `admin/notifications.js:83-87` checks before :90.
  `copilot/confirm.js` claims with tenant and proposer
  (`_lib/action-proposals.js:49-56`). `voice/handoff.js:28-31` checks the
  call. `_lib/erp-chat-tools.js:87`, `:110` add the tenant on the next line.
  **Verified.**
- Agent goal handlers load the goal object with `goal.tenant_id`
  (for example `agents/_handlers/expiring_quote_nudge.js:27-30`); the later
  `customers` reads by id use ids from those rows. Not a leak; it relies on
  FK consistency. **Verified.**
- Unvalidated cross-references that no reader follows across tenants:
  `findings/index.js:14-24` (`order_id`), `copilot/confirm.js:50`
  (`order_id`), `agents/goals.js:73` (`object_id`). Readers filter on tenant
  (for example `orders/[id].js:112`). Low; data hygiene only. **Verified.**

### 4.3 Cron-only paths that drain all tenants by design (fine)

`cron/tick.js`, `cron/daily.js`, `cron/extraction_jobs.js:130` (lease,
cron auth `:924`), `agents/run.js:331` (cron auth `:324`), the cron branches
of `tally/retry.js:149`, `netsuite/retry.js`, the 15 `<erp>/retry.js` and
`<erp>/sync.js` (`tenant_settings ... not(<erp>_base_url, is, null)`),
`tally/sync.js:211` (in the RLS allow-list), `cron/logistics-monitor-tick.js:39-41`,
`cron/inventory-*`, `push/send.js:20` (cron GET only), `prospecting/run.js`
cron branch, `voice/webhook.js:35` and `inbound/{slack,teams,whatsapp}/webhook.js`
(config scan, then a per-tenant signature check). **Verified.**

The real D-1 pattern is wider than D-1: a manual endpoint that reuses the
all-tenant cron body. If H-1 holds (the tick never ran), one approver's click
runs the first-run backlog for every tenant (T-1 to T-5). **Inferred.**

---

## 5. Auth inventory

Roles: read = 10 roles, write = 8, approve = sales_manager, finance, admin;
admin = admin (`_lib/auth.js:32-46`). `hasAction` lets admin through every
action (`_lib/auth.js:293-298`). `resolveContext` checks that the
`x-anvil-tenant` tenant is one of the caller's memberships
(`_lib/auth.js:147-158`). **Verified.**

| Mech | Entry | Auth | Flag |
|---|---|---|---|
| M-2 | cron/tick.js:139 | CRON_SECRET, fail closed | |
| M-3 | cron/daily.js:63 | CRON_SECRET, fail closed | |
| M-4/5 | _lib/cron-mux.js:28 | mock request carries CRON_SECRET | |
| M-6 | health.js, healthz.js | public, no auth | exposes worker names and integration flags (low) |
| M-7 | cron/inventory-positions.js:20, inventory-planning-weekly.js:779, inventory-exceptions-tick.js:26, conformal-calibration-weekly.js:140 | CRON_SECRET or `x-cron-secret`, **fail open when unset** | L-11 |
| M-8 | queue-runner callers | caller's auth | |
| M-9 | `<erp>/retry.js`, `<erp>/sync.js` | CRON_SECRET or resolveContext + admin | |
| M-10 | tally/retry.js:145, :162-163; netsuite/retry.js | CRON_SECRET or admin | |
| M-11 | cron/extraction_jobs.js:119-124, :924; orders/extraction_jobs.js | CRON_SECRET; enqueue write + `so.write` | T-10 |
| M-12 | agents/run.js:324 | CRON_SECRET only | acts with no per-action confirm |
| M-13 | agents/goals.js:29, :58, :91, :122 | read / write | any writer arms an emailing goal |
| M-14 | agents/handle_replies.js:169, :180 | CRON_SECRET or approve | T-1 |
| M-15 | erp_chat/send.js:58-59 | read | write tools only propose; T-9 |
| M-16 | copilot/confirm.js:104-105; copilot/proposals.js | approve + same proposer; read | |
| M-17 | agent/personas.js | read; flag `so_agent_enabled` (_lib/agent-personas.js:39) | |
| M-18 | mcp/server.js:32-38; mcp/tokens.js:34 | Bearer token hashed (_lib/mcp.js:43-54), scope per tool (_lib/erp-chat-tools.js:785-799); tokens minted by admin | L-15 |
| M-19 | operator_actions/*.js | write; approve when the contract mutates the SoR (reconcile.js:48); flag operator_actions_enabled | |
| M-20 | voice/webhook.js:172-184; process_actions.js:138, :149; outbound.js; handoff.js | per-tenant HMAC (fail closed); CRON_SECRET or approve; approve | T-2 |
| M-21 | inbound/slack/webhook.js:83-87; teams/webhook.js:59-66; whatsapp/webhook.js:80-85; process_messages.js:165 | per-tenant signature or secret, fail closed; CRON_SECRET or approve | |
| M-22 | whatsapp/inbound.js:166-178 | **one global token, tenant from header**, not timing-safe | T-14 |
| M-23 | prospecting/run.js:134 | CRON_SECRET or admin | |
| M-24 | _lib/dispatch-register-send.js:86 | inline under the despatch writer's ctx | flag |
| M-25 | inbound/email/webhook.js:45-60, :154-163 | Postmark HMAC per tenant; Graph clientState per tenant (fail closed fetch) | |
| M-26 | inbound/email/parse.js:136, :147 | CRON_SECRET or approve | T-3 |
| M-27 | persist_attachments.js | CRON_SECRET or approve | T-4 |
| M-28 | draft_orders.js | CRON_SECRET or approve (tenant scoped) | |
| M-29 | email/inbound.js:125-140 | **one global token (timing-safe), tenant from header** | T-14 |
| M-30 | inbound/auto_ocr.js | CRON_SECRET or approve (tenant scoped) | |
| M-31 | docai/review_queue.js | read / write | |
| M-32 | orders/index.js (write); quotes/convert.js (approve + `quotes.approve`); portal/reorder.js:12-20 (portal token with scope `reorder`) | | |
| M-33 | orders/[id].js (read / write / approve / admin + `_lib/order-write-gate.js:49-60`); admin/quote_approvals.js (read, admin, `cost.view`) | | return-for-fix by so.write (L-21) |
| M-34 | orders/exceptions.js (read); findings/index.js (write) | | |
| M-35 | tally/push.js (approve); copilot confirm path | | T-12 |
| M-36 | tally/sync.js:207 (CRON_SECRET or admin); cron/tally-reconcile.js:77, :89 (CRON_SECRET or approve); cron/drift-meter.js:150-155 (CRON_SECRET or admin); tally/reconcile.js (read / write / approve) | | T-5, T-6 |
| M-37 | admin/so_processing_mode.js, admin/order_handoff_settings.js | admin | |
| M-38 | admin/notifications.js:26, :43 | read to list, admin to mark or resolve | #624 changes |
| M-39 | push/send.js:74, :82; push/subscribe.js | CRON_SECRET (GET) or approve; read | T-11 |
| M-40/41 | communications/send.js (approve), draft.js (write), whatsapp/send.js (write) | | |
| M-42 | inside agents/run.js | CRON_SECRET | |
| M-43 | helpers | caller | |
| M-44 | cron/logistics-monitor-tick.js:28-35 (**fail open**); admin/logistics_monitor_rules.js (admin) | | L-11 |
| M-45 | cron/inventory-exceptions-tick.js:26 (**fail open**); inventory/exceptions.js (read / write) | | L-11 |
| M-46 | screens; admin/quote_approvals.js | read | |
| M-47 | audit/index.js (read GET, write POST); audit/export.js (admin + HMAC secret) | | L-5, L-6, L-20 |
| M-48 | events/index.js (read GET, write POST) | | L-5 |
| M-49 | mcp/usage.js (read), erp_chat/sessions.js (read), agents/goals.js GET (read) | | |

Global-token webhooks (asked for): `whatsapp/inbound.js` and
`email/inbound.js` both take the tenant from `x-anvil-tenant` (or
a second legacy tenant header), default `DEFAULT_TENANT_ID`. Both refuse when the token
env var is empty (`whatsapp/inbound.js:168-170`, `email/inbound.js:127-129`).
**Verified.**

---

## 6. Config and flag inventory

### 6.1 Environment variables

| Env var | Default | Read at | Effect | Changed by |
|---|---|---|---|---|
| CRON_SECRET | none | cron/tick.js:85, cron/daily.js:56, _lib/cron-mux.js:28, 28 files | Gate for every cron path. Empty: tick and daily refuse; 5 cron files fail open (L-11) | env only |
| EVAL_REPLAY_ENABLED | unset (off) | cron/daily.js:94 | adds eval/replay to daily | env only |
| EVAL_GOLDEN_TENANT_ID | unset | eval/replay.js:373, eval/rescore.js:168, docai/correction.js:147 | corpus tenant; wins over the caller's tenant | env only |
| DEFAULT_TENANT_ID | `0000...0001` | _lib/auth.js:4, email/inbound.js:20, whatsapp/inbound.js:37, _lib/tenancy.js:19 | webhook tenant fallback; auto-onboard tenant | env only |
| AUTO_ONBOARD_TENANT | "true" | _lib/tenancy.js:22 | new users join the default tenant (pending when REQUIRE_APPROVAL) | env only |
| REQUIRE_APPROVAL | "true" | _lib/tenancy.js:28 | | env only |
| ALLOW_ANONYMOUS_TENANT | "false" | _lib/auth.js:14-21 | forbidden in production | env only |
| EMAIL_INBOUND_TOKEN | "" (endpoint off) | email/inbound.js:21 | M-29 on/off | env only |
| WHATSAPP_INBOUND_TOKEN | "" (endpoint off) | whatsapp/inbound.js:38 | M-22 on/off | env only |
| TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_WHATSAPP_FROM | "" | whatsapp/inbound.js:39, :121; whatsapp/send.js:22-24 | media fetch, send | env only |
| META_WHATSAPP_TOKEN, META_WHATSAPP_PHONE_ID | unset | whatsapp/send.js:45-46 | send | env only |
| EMAIL_PROVIDER | auto-detect | _lib/mailer.js:33 | brevo / resend / sendgrid | env only |
| BREVO_API_KEY, RESEND_API_KEY, SENDGRID_API_KEY | unset | _lib/mailer.js:35-37, :69, :91, :117; _lib/comms-send.js:20 | mail rail on/off | env only |
| EMAIL_FROM / SENDGRID_FROM_EMAIL, *_FROM_NAME | unset | _lib/mailer.js:27-28; _lib/comms-send.js:21-22 | sender | env only |
| COMMS_PROVIDER_URL, COMMS_PROVIDER_TOKEN | unset | _lib/comms-send.js:18-19 | webhook send rail | env only |
| MARKETING_FROM_EMAIL / _NAME | unset | _lib/marketing-send.js:22-23 | M-23 sender | env only |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT | "" / mailto default | _lib/web-push.js:18-22 | M-39 on/off | env only |
| TALLY_BRIDGE_URL, TALLY_BRIDGE_TOKEN | unset | _lib/tally-client.js:155-162; tally/validate.js:68-74; tally/health.js:64 | env bridge for every tenant with no company row (T-12) | env only; #619 adds TALLY_BRIDGE_TENANT_ID |
| ANVIL_SECRETS_KEY | none | _lib/secrets.js:26-35; _lib/graph-client.js:107; _lib/marketing-send.js:32 | credential encryption | env only |
| AUDIT_EXPORT_HMAC_SECRET | "" (export refused) | audit/export.js:23 | M-47 export | env only |
| ANTHROPIC_API_KEY, ANTHROPIC_MODEL_* , ANTHROPIC_TIMEOUT_MS, *_RETRY_* | unset / code defaults | _lib/anthropic.js:125-127, :163-165, :250; erp_chat/send.js:24 | LLM for M-15, M-26, agents | env only |
| GEMINI_API_KEY and other docai provider keys | unset | docai/cost_status.js:340-349 (and adapters) | M-11, M-30 fallback when tenant keys are absent | env only |
| DOCAI_BACKGROUND_PAGE_THRESHOLD | 40 | docai/extract.js:43 | when a job is queued (M-11) | env only |
| DOCAI_MAX_ROW_WINDOWS | code default | cron/extraction_jobs.js:240 | | env only |
| LOGISTICS_MONITOR_LOOKBACK_DAYS, LOGISTICS_MAX_RAISE_PER_RUN, LOGISTICS_MAX_NOTIFY_PER_RUN, LOGISTICS_DIGEST_THRESHOLD | code defaults | _lib/logistics/scope.js:33, :85; _lib/logistics/notifications.js:20-22 | M-44 volume | env only |
| STRIPE_DRIFT_METER_NAME | code default | cron/drift-meter.js:25 | | env only |
| EVAL_QUALITY_ALERT_* | code defaults | cron/eval_quality_alert.js:29-32, :85 | | env only |
| PUBLIC_APP_URL, PORTAL_BASE_URL, APP_BASE_URL, GRAPH_REDIRECT_URI | unset | quotes/send.js:98; _lib/graph-client.js:51, :59 | links | env only |

### 6.2 tenant_settings columns

| Column | Default | Migration | Read at | Changed by |
|---|---|---|---|---|
| logistics_monitor_enabled | false | 206:93 | cron/logistics-monitor-tick.js:39-41 | Screen: LogisticsMonitorEditor via admin/logistics_monitor_rules.js (admin) |
| operator_actions_enabled | false | 150:12 | operator_actions/index.js:16-21, advance.js:31, evidence.js:28, reconcile.js:33 | SQL only (no writer found) |
| so_agent_enabled | false | 210:21 | _lib/agent-personas.js:39 | SQL only |
| so_processing_mode | 'A' | 221:27 | _lib/so-processing-mode.js:33-36; tally/retry.js:121 | Screen: SoProcessingModeEditor via admin/so_processing_mode.js (admin) |
| terms_check_mode | 'off' | 250:203 | _lib/terms/mode.js:33-38 | SQL only |
| terms_amendment_email_enabled | false | 250:222 | no reader on main | SQL only |
| dispatch_register_auto_send_enabled | false | 205:12 | _lib/dispatch-register-send.js:86 | SQL only |
| order_handoff_enabled (+ handoff columns) | false | 251:58 | admin/order_handoff_settings.js:141-172 (settings only; no send on main) | Screen: OrderHandoffSettingsEditor (admin) |
| tally_recon_auto_fix_enabled | false | 095:137 | _lib/tally-reconciler.js:559-565 | SQL only (tally/reconcile.js:183 reads it) |
| tally_drift_addon_enabled | false | 097:23 | cron/tally-reconcile.js:42; cron/drift-report.js:217 | API: tally/drift_addon.js (admin), client `enableDriftAddon` (src/client/anvil-client.js:1529) |
| inventory_planning_enabled | false | 085:55 | cron/inventory-exceptions-tick.js:39; inventory-positions.js:31-34; inventory-planning-weekly.js:258, :792; conformal-calibration-weekly.js:31 | SQL only |
| inventory_voice_severity_threshold | 'critical' | 085:66 | _lib/inventory/notifications.js:62-65 | SQL only |
| docai_provider_order | gemini first since 208:26-28 (was 029:84) | 029:84, 208:26 | _lib/docai/run.js:288 | Screen: docai settings (admin/docai_settings.js, admin/docai_provider_keys.js) |
| docai_prompt_variants | false | 218:42 | _lib/docai/run.js:427; cron/extraction_jobs.js:100 | Screen: admin/docai_settings.js:240-244 |
| docai_density_chunk_enabled | false | 223:27 | cron/extraction_jobs.js:341; _lib/docai/density-plan.js:38 | SQL only |
| docai_gemini_fallback_model | null | 248:27 | _lib/docai/gemini.js:765 | Screen: admin/docai_settings.js:217-220 |
| docai_fallback_confidence | 0.85 | 098:26 | _lib/docai/index.js:729 | Screen: admin/docai_settings.js:223-228 |
| graph_subscription_id, graph_client_state | null | 028:105, 195:17 | inbound/email/webhook.js:154-163 | Screen: Outlook connect (comms/graph.js) |
| postmark_inbound_address, postmark_inbound_secret | null | 028:99, 028:98 | inbound/email/webhook.js (Postmark branch) | Screen: inbound/email/configure.js (admin) |

No tenant setting switches M-47, M-48 or M-49. **Verified.**

---

## 7. Personal data and retention

Logs and records that hold personal data (**Verified** columns):

| Table | Personal data |
|---|---|
| inbound_emails 028:38 | from_address (:46), body_text (:51), body_html (:52) |
| inbound_messages 039:10 | sender_handle phone (:23), text_body (:26), raw_payload (:27) |
| voice_calls 041:57 | caller_phone_number (:65), transcript (:72) |
| communications 005:22, 189 | to_addr, cc, body |
| orders.preflight_payload | email text up to 8000 chars (email/inbound.js:206), WhatsApp text and phone (whatsapp/inbound.js:257-259), voice raw_payload (voice/process_actions.js:62) |
| audit_events 001:323 | before/after payloads hold whole rows, for example a lead with contact email and phone (copilot/confirm.js:42); detail strings with phone or email (whatsapp/inbound.js:218, email/inbound.js:239) |
| audit_failures 063:20 | raw_payload copies of the above, no RLS (T-15) |
| processing_events 001:343 | detail with sender phone or email (whatsapp/inbound.js:212, email/inbound.js:233) |
| agent_steps 011:104 | action_payload with email body and recipient, phone number (agents/run.js:35) |
| erp_chat_messages 026:18 | user prompts (content), tool_result rows with customer data |
| mcp_call_log 027:41 | args, ip, user_agent |
| model_routing_log 005:130 | no content; no prompts stored |
| admin_notifications 042:89 | actor_email, body text |

LLM prompts: no table stores a full prompt. erp_chat_messages stores the
user's question and tool results. **Verified** for the listed writers.

Retention on main: **none** for any table above. A search for age-based
deletes in `src/api` finds one, `cron/conformal-calibration-weekly.js:125`
(inventory calibration). No migration defines retention. audit_events
blocks delete through a user JWT (058:28-31), so a purge needs the service
role. **Verified.**

What #642 (EA-8, base branch `claude/email-ea7-ui`) adds: `email/purge` in
daily, cron only (`src/api/email/purge.js` in the PR). It clears
`email_actions.preview` and stamps `content_purged_at` after
`email_content_retention_days` (default 30) for tenants with
`email_accountability_enabled` (`_lib/email-accountability/retention.js` in
the PR). It touches no other table: not inbound_emails, communications,
audit_events, agent_steps or erp_chat_messages. Heartbeat bound 30 hours
(`heartbeat-check.js` in the PR). **Verified** from the PR diff.

---

## 8. Open PR overlay

| PR | What changes for L5 if it merges |
|---|---|
| #619 (secrets, env) | Only env change: `TALLY_BRIDGE_TENANT_ID` (default DEFAULT_TENANT_ID) binds the env Tally bridge to one tenant, and the bridge URL must be https. Fixes T-12. ANVIL_SECRETS_KEY use moves to per-value IV; a post-deploy re-encrypt per tenant is needed. No trail change. **Verified** from `docs/SETUP.md` and tally-client diff |
| #624 (notices) | Adds `admin_notifications.recipient_user_id` (migration 253, on delete cascade) and `notify()`, one row per person. `actor_user_id` and `actor_email` stay as before (`buildRow` in the PR); the PR does not make any SO caller set them. So the notice gets a recipient, not an actor kind. Reads become per person (`visible()` in admin/notifications.js). No timeline reads notices after the PR either. **Verified** from the diff |
| #642 (purge) | Section 7. The first and only retention purge, scoped to email_actions.preview |
| #633 (role) | UI role comes from `ctx.role` via `/api/auth/profile`; fails closed to viewer. No server gate and no trail change. `actor_role` already comes from the server. The PR names the return-for-fix drift (L-21) and leaves it for the owner. **Verified** from the PR body and the one server line |

---

## 9. O-2 rows for M-47 to M-49

| Mech | Schedule | Claim and lease | Retry and give up | Dedup | Decide (policy) | Act on an order | Send outside | Notify a person | Track human work | Escalate | Record the trail | Report health |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M-47 audit_events | none; inline in callers | none | none; sentinel to audit_failures (_lib/audit.js:39-57); direct inserts none | none (payload_hash optional, 001:333) | feeds billing (billing/usage.js:62), SO cycle metric (_lib/metrics/catalog.js:174), drift report send-once (cron/drift-report.js:231) | none | signed export (audit/export.js:53-86), broken on `ts` (L-6) | none | none | none | actor uuid + role, null for non-persons (_lib/audit.js:59-62) | none; audit_failures has no reader (L-1) |
| M-48 processing_events | none; inline | none | none; sentinel for recordEvent only (_lib/audit.js:155-166) | none | none (display: orders/extraction_status.js:211) | none | none | none | none | records `agent_escalation` (agents/run.js:108) | no actor column (001:343-353); case_id overloaded | none |
| M-49 own logs | per owner | none; cron_health read-then-write (_lib/cron-mux.js:234-238) | none; agent_steps error unchecked (agents/run.js:47) | cron_health PK worker (066:19); agent_steps none (011:104) | none | none | none | none | operator_action_steps done_by (150:48) | none | each table its own actor shape (section 2) | cron_health is the health source (health.js:113, _lib/heartbeat-check.js:57) |

Classes for the L5 columns. *Record the trail*: **Divergent** across
M-47, M-48, M-49, communications and admin_notifications (five actor shapes,
section 2). *Report health* for the trail itself: **Gap** (nothing watches
audit_failures). *Dedup*: **Gap** for M-47 and M-48.

---

## 10. Defects found, not fixed

Tenant findings T-1 to T-15 are in section 4 (all high). Other defects:

| # | `path:line` | Failure scenario | Sev | Suggested fix (one line) |
|---|---|---|---|---|
| L-1 | _lib/audit.js:39-57; 063:38-39 | audit rows fail into audit_failures and nobody sees it; the promised P0 alert does not exist | medium | Count audit_failures in /api/health and the daily sweep; bell on non-zero |
| L-2 | inbound/email/webhook.js:248, portal/reorder.js:106 (`actor_id`); out of scope auth/signup.js:110, billing/stripe/webhook.js:71 (`actor_user_id`), billing/razorpay/webhook.js:178 | insert names a column that does not exist (001:326 is `actor`); PostgREST rejects the row; every such audit row is lost | medium | Route all direct inserts through recordAudit; delete the wrong keys |
| L-3 | email/inbound.js:235; whatsapp/inbound.js:197; cron/inventory-planning-weekly.js:757 (+4 out of scope) | `actor_role` "system" or "service" is not an enum value; the row goes only to audit_failures; billing and timeline miss it | medium | Pass role null and add an actor_kind column (section 11) |
| L-4 | voice/outbound.js:152; tally/reconcile.js:106; admin/item_customer_parts.js:74 | case_id null breaks NOT NULL (001:346); the event is lost (outbound: an orphan placed call leaves no trail) | medium | Use the object id as case_id when there is no order |
| L-5 | audit/index.js:23-28; events/index.js:20-32 | any writer posts any action or event type, including billable actions (billing/usage.js:62-68), and the row looks like a server row | low | Restrict POST to a client-event allow-list with a `client.` prefix |
| L-6 | audit/export.js:55-58 | export orders and filters on `ts`; audit_events has `created_at`; the signed SOC 2 export errors | medium | Use created_at |
| L-7 | tally/retry.js:97-109 | cron retry sets EXPORTED_TO_TALLY with no audit and no event; invisible on timeline, unbilled (_lib/outcomes.js:28), missing from SO cycle metric | medium | Write the audit and event with a system ctx on the cron path |
| L-8 | cron/tally-reconcile.js:47-56 | cron drift checks write no audit row; the paid drift_check_run outcome (_lib/outcomes.js:32-39) is never billed for cron runs | medium | recordAudit tally_recon_run per tenant run |
| L-9 | cron/extraction_jobs.js:805-823 | the background job rewrites lines and may clear an approval with no order audit row | medium | recordAudit on the order with before/after approval |
| L-10 | voice/process_actions.js:54-75, :119-125 | a voice-created order has no row keyed to it; its origin is invisible | low | Add an order-keyed audit and event |
| L-11 | cron/logistics-monitor-tick.js:28; inventory-exceptions-tick.js:26; inventory-positions.js:20; inventory-planning-weekly.js:779; conformal-calibration-weekly.js:140 | when CRON_SECRET is unset, anyone can run these | low | Fail closed like tick.js:139 |
| L-12 | agents/run.js:88; handle_replies.js:147; draft_orders.js:78; process_messages.js:60; voice/process_actions.js:119; auto_ocr.js:152 (17 sites) | direct inserts skip the sentinel and ignore the error | low | Use recordAudit |
| L-13 | agents/run.js:151-163 | agent emails have no order_id, so the order timeline and comm_sent event miss them | low | Set order_id when object_type is order |
| L-14 | _lib/cron-mux.js:234-238 | two failing writers read the same count and both write count+1 | low | Increment in SQL (rpc or upsert expression) |
| L-15 | _lib/mcp.js:43-54 | a removed member's MCP token keeps reading tenant data | medium | Check the token owner's membership status on each call |
| L-16 | _lib/anthropic.js:244, :382-394, :415-427 | comment says userId is logged; it is not; LLM spend has no actor | low | Add user_id and actor_kind to model_routing_log |
| L-17 | _lib/dispatch-register-send.js:123 | an automatic send is recorded as sent by a person | low | sent_by null plus metadata.trigger |
| L-18 | 149:12-27; _lib/action-proposals.js:25-35 | a reader cannot tell an MCP proposal from an Ask Anvil one | low | Add a source column |
| L-19 | 063:20, 066:18 | no RLS on audit_failures or cron_health (T-15 for the read) | medium | Enable RLS with no policy (service role only) |
| L-20 | audit/index.js:13-21 | every read role gets before/after payloads; src/v3-app/lib/rbac.ts:78 hides audit from operator; cost fields in payloads skip `cost.view`. Inferred for cost fields | low | Require admin or redact payloads by role |
| L-21 | orders/[id].js:409; _lib/order-write-gate.js:42-44, :51 | an so.write role can return an order for fix and the row says "manager_requested_correction" | low | Owner decision in #633 (option A) |
| L-22 | whatsapp/inbound.js:171-173 | global token compared with `!==` and accepted in the query string | low | timingSafeEqual and header only |
| L-23 | all tables in section 7 | no retention or purge for any personal data on main | medium | Per-table retention settings and one daily purge (extend #642's pattern) |

---

## 11. Target model notes: one event log

Proposal (for O-3 constraint 8; the owner decides).

1. **Where it lives.** Keep `audit_events` as the one log. It already has
   append-only RLS (058), the tenant index (001:340-341), the export and the
   readers that act on it. Add, in one migration from 271 up:
   `actor_kind text not null default 'person' check (actor_kind in
   ('person','agent','system','webhook','portal','mcp'))`, `actor_ref text`
   (goal id, token id, worker name, provider), `case_id text` (the order id
   when there is one), `source text` (mechanism id, for example `M-12`).
   Keep `actor` for person rows only.
2. **processing_events becomes a view, later.** Step one: recordEvent also
   writes an audit row with `actor_kind` and `case_id`. Step two: a view
   `processing_events_v` over audit_events serves the old readers
   (events/index.js, pipeline_state.js, extraction_status.js). Step three:
   drop the direct inserts. Do not merge the two tables in one PR; the
   readers differ (case_id vs object_id).
3. **One writer.** `recordAudit(ctx, payload)` derives `actor_kind` from
   ctx: `ctx.user` gives person; a new `ctx.actor = { kind, ref }` gives the
   rest. Cron paths pass `{ kind: 'system', ref: worker }`. `actor_role`
   stays null for non-persons, which also fixes L-3.
4. **One reader.** `GET /api/orders/:id/timeline` reads audit_events where
   `case_id = order id OR object_id = order id`, plus communications by
   order_id, and returns `actor_kind` on every row. ThreadDrawer and the SO
   Activity tab both call it.
5. **Writers to move first** (largest timeline gap per line changed):
   (a) the 17 direct audit inserts (L-2, L-12) onto recordAudit;
   (b) the cron paths that change an order: tally/retry.js:97 (L-7),
   cron/extraction_jobs.js:808 (L-9), voice/process_actions.js:54 (L-10);
   (c) agents/run.js:88 and :108 with `actor_kind='agent'`, `actor_ref`
   goal id, `case_id` goal.object_id;
   (d) copilot/confirm.js:125 with `actor_kind='person'` and
   `source='M-16'` plus the proposal's surface (needs L-18).
6. **Health.** Add `audit_failures` count to /api/health and the daily
   sweep (L-1). Enable RLS on audit_failures (L-19).

What I skipped or did not check: live data (no queries); every one of the 51
tick handlers outside M-1 to M-46 (only those with a cron plus user branch);
the full response body of cron/drift-report.js (T-7 read side "not
confirmed"); whether Supabase default grants are in place on this project
(T-15 stays Inferred).
