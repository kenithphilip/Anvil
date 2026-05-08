# Incident Response Playbook

> SOC 2 CC7.4 evidence. The playbook the on-call follows when a
> security or availability incident is reported. Reviewed
> annually; the most recent review is in the changelog footer.

This is the operational playbook. The detection-and-monitoring
side (alerts, dashboards, query packs) lives separately in the
SRE team's runbook; this doc covers what happens after an alert
fires or a customer reports a problem.

---

## Severities

We use four severity levels. Severity sets the response time and
the escalation path; it does not change the steps below.

- **SEV-1**: confirmed data loss, confirmed customer-data
  exfiltration, full-region outage, or any compromise of a
  service-role credential. Page the on-call immediately. Wake
  people up. Status page red.
- **SEV-2**: degraded service for one or more tenants (writes
  rejecting, ERPs not pushing, OCR failing for >50% of attempts),
  suspected (not confirmed) credential compromise, or any change
  to security controls (RLS, audit logging, encryption keys).
  Page on-call within 15 min.
- **SEV-3**: a single feature broken, an integration partner
  outage with a viable fallback, or a low-severity vulnerability
  report that needs investigation. Best-effort response within
  business hours.
- **SEV-4**: cosmetic, low-risk, or already-mitigated. File and
  schedule.

---

## When an alert fires (or a report comes in)

### 1. Triage (first 15 minutes)

- Acknowledge the page in the on-call rotation tool. The alert
  stops escalating once acknowledged.
- Open the incident channel `#inc-<yyyymmdd>-<short>` in Slack
  (template: `#inc-20260508-ocr-throughput`).
- Pin the Vercel deploy that introduced the suspected change. The
  `deploy_events` table (queryable via `GET /api/deploys`) is the
  authoritative production change log; correlate the alert
  timestamp against the most recent `state='ready'` row.
- Pin the Supabase region status page and Vercel status page. A
  control-plane outage at our cloud provider is an external
  cause.

### 2. Classify (next 15 minutes)

Before doing anything else, decide:

- Is this a **security** incident or an **availability**
  incident? Many incidents look like availability problems but
  turn out to be security (e.g. a misconfigured RLS policy
  silently dropping reads).
- What's the blast radius? Single tenant? Single region? All
  tenants?
- Is customer data exposed, possibly exposed, or definitely not?
  When in doubt, treat it as "possibly."

Set the severity. Update the incident channel topic.

### 3. Contain

For security incidents:

- If a service-role credential is suspected compromised, **rotate
  it immediately** before continuing investigation. The Supabase
  service-role JWT is regenerable from the dashboard. The
  per-tenant ERP credentials encrypted in `tenant_settings` are
  per-tenant; rotate the affected tenant first.
- If the issue is a leaked customer secret, page that customer
  the moment containment is confirmed.
- Lock the affected resource. For Postgres, this might mean
  `revoke insert on <table> from authenticated` for a few minutes
  while you assess.

For availability incidents:

- Roll back to the last `state='ready'` deploy if the failing one
  is the proximate cause. The Vercel rollback button takes <60s.
- Disable the affected feature with an env flag if rollback is
  risky.

### 4. Investigate

- Pull `audit_events` for the affected tenant and time window:
  `GET /api/audit/export?since=<iso>&until=<iso>` returns the
  HMAC-signed JSONL dump; verify the HMAC before reasoning on the
  data.
- Pull `agent_steps` if an autonomous agent is suspected:
  `select * from agent_steps where tenant_id = ? and run_at >= ?`.
- Pull deploy events: `GET /api/deploys?since=<iso>` shows what
  shipped to production around the alert.
- Capture every artifact (query results, screenshots, log lines)
  in the incident channel as you go. The post-mortem reads from
  this thread.

### 5. Remediate

- Ship the fix as a normal PR. Do not skip code review even when
  the fix is one line; pre-deploy review is a SOC 2 control
  (CC8.1).
- Verify the fix in preview. Verify again in production after
  deploy. Watch the deploy_events row flip to `state='ready'`.

### 6. Communicate

- Status page update at every state change (acknowledged,
  investigating, mitigated, resolved).
- Customer notice within 72 hours for any incident touching
  customer data (GDPR Article 33; DPDP equivalent).
- Internal post-incident note in `#inc-<id>` summarising what
  happened, who was affected, and the fix.

### 7. Post-mortem

Within five business days for SEV-1 and SEV-2:

- One-page write-up: timeline, root cause, contributing factors,
  fix, follow-ups.
- Blameless. We're after the system that allowed the incident,
  not the person who pushed the deploy.
- Track follow-up tickets to closure. Open them as Jira issues
  and link from the post-mortem.

---

## Roles and rotations

- **On-call**: weekly rotation, lead engineer + backup. Must have
  Vercel deploy permission, Supabase admin access, and incident
  channel-create permission.
- **Incident commander**: appointed at SEV-1 / SEV-2 declaration.
  Owns coordination; not necessarily the same person fixing the
  bug.
- **Communications lead**: at SEV-1, owns customer messaging +
  status page. Different person from the IC.

The on-call carries a hard-copy of this doc plus the contact
list (paging numbers, account managers' direct lines, vendor
support contacts) at all times during their shift.

---

## Drills

We run two table-top exercises per quarter against this playbook:

1. Simulated SEV-1: service-role credential leaked in a public
   GitHub Gist. Tests rotation speed and customer-comms speed.
2. Simulated SEV-2: a single tenant's RLS policy drops to
   `permissive false`. Tests detection (which alert fires?) and
   the audit-log forensic path.

Drill outcomes are logged in `docs/INCIDENT_DRILLS.md` (a
follow-up doc; one drill record per quarter).

---

## See also

- `docs/RUNBOOK.md`: day-to-day operational runbook (deploys,
  Supabase admin, restarting services).
- `docs/DESIGN_SYSTEM.md`: not directly relevant, but the
  changelog cross-references it.
- `docs/RBAC_AUDIT.md`: auto-generated audit of the RBAC matrix.
- `/api/deploys`: change log for production deploys.
- `/api/audit/export`: HMAC-signed audit log dump.
- `/api/admin/access_review`: monthly snapshot + acknowledgement.

---

## Changelog

| Date         | Reviewer | Notes                              |
|--------------|----------|------------------------------------|
| 2026-05-08   | (initial) | First version. SOC 2 CC7.4 evidence. |
