# Operations Runbook

The on-call playbook for keeping Anvil healthy in production.

## Daily

### 04:00 UTC: FX rate cron

Endpoint: `GET /api/fx/cron`. Refreshes FX rates for every tenant from
`FX_PROVIDER_URL` (default Frankfurter) for the previous business day.

Verify:
```sql
select count(*), max(fetched_at) from fx_rates
where as_of = current_date - interval '1 day';
```

Expected: at least 30 rows (5 base currencies x 6 targets x active tenants).

If it failed: check Vercel logs for the cron run. Re-run manually:
```sh
curl -X GET 'https://YOUR-URL/api/fx/cron?as_of=2026-01-15' \
  -H "Authorization: Bearer $CRON_SECRET"
```

### 05:00 UTC: AMC visit auto-generation

Endpoint: `GET /api/service/amc_cron`. Scans every tenant for `SCHEDULED`
AMC rows due within 7 days; creates `service_visits` and flips AMC rows
to `VISIT_CREATED`.

Verify:
```sql
select tenant_id, count(*) from amc_schedules
where status = 'VISIT_CREATED' and generated_at > now() - interval '24 hours'
group by tenant_id;
```

Re-run manually:
```sh
curl -X GET 'https://YOUR-URL/api/service/amc_cron' \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Weekly

### Audit log retention

If `audit_events` is approaching 1M rows, archive entries older than 6
months:

```sql
-- Run during low traffic; consider COPY to S3 first if you want a copy
delete from audit_events where created_at < now() - interval '180 days';
```

### Eval suite run

Run the configured golden eval suite to detect prompt regression:

1. Open **Eval Dashboard** from the palette.
2. Cases tab -> click **Run** on a few representative cases.
3. Compare pass rate and field heatmap to last week.

If pass rate dropped >5%, check `model_routing_log` to confirm models did
not change unexpectedly. Anthropic occasionally retires older model
identifiers; pin a known-good version in `ANTHROPIC_MODEL_DEFAULT`.

### Supplier scorecard review

```sql
select supplier, country, on_time_pct, price_accuracy_pct, total_acks
from supplier_scorecards
where total_acks > 5
order by on_time_pct asc
limit 10;
```

Suppliers with `on_time_pct < 70%` should trigger a procurement review.

## Monthly

### Database backup verification

Supabase auto-backs up daily on paid plans. Verify by attempting a
restore to a branch project:

1. **Project Settings -> Database -> Backups**.
2. Click the most recent backup -> **Restore to a new project**.
3. Confirm migrations apply cleanly on the restored DB.
4. Delete the restored project.

### Secret rotation

Rotate quarterly at minimum:

- `ANTHROPIC_API_KEY`
- `MISTRAL_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (rotate via Supabase Project Settings)
- `CRON_SECRET`
- `EMAIL_INBOUND_TOKEN`
- `TALLY_BRIDGE_TOKEN`
- `GSTN_API_KEY` (if using a GSP)

Update each in Vercel env vars, redeploy.

## Incident response

### Symptom: every API call returns 401

Cause: usually a change in Supabase JWT secret or an expired session.

Steps:
1. Check Supabase **Auth -> Logs** for spikes in failed token verifications.
2. Confirm `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Vercel match what
   Supabase shows under **Project Settings -> API**.
3. If keys rotated recently, redeploy Vercel.

### Symptom: every API call returns 500 with "Anthropic key not configured"

Cause: `ANTHROPIC_API_KEY` is unset, expired, or revoked.

Steps:
1. Check the Anthropic console for key status.
2. If revoked/expired, generate new key, set in Vercel, redeploy.
3. If config issue, verify Production scope is set on the env var.

### Symptom: Tally exports stuck in `failed`

Cause: bridge unreachable, network outage, or Tally Prime not running.

Steps:
1. Curl the bridge directly: `curl -I $TALLY_BRIDGE_URL/health`.
2. If unreachable, check that Tally Prime is running on the target host.
3. Inspect the most recent failure:
   ```sql
   select * from tally_voucher_records
   where status='failed'
   order by created_at desc limit 5;
   ```
4. Re-push from the order overview UI once the bridge is back.

### Symptom: e-Invoice all in `REJECTED`

Cause: GSTN sandbox or GSP rejected the payload. Common reasons:
- Invalid HSN code
- Mismatched GSTIN format
- IGST/CGST/SGST split inconsistent with state codes
- IRN duplicate (re-using an invoice number that was already generated)

Steps:
1. Open one rejected row in **e-Invoice modal**, expand **Response**.
2. The GSTN response includes error codes; cross-reference with
   https://einv-apisandbox.nic.in/static/error_codes.html.
3. Fix the underlying data (HSN on item_master, GSTIN on customer_locations,
   etc.) and compose a new invoice with a fresh number.

### Symptom: PII appears in audit_events.detail

Cause: a redaction rule is missing or `bypassFirewall` was used.

Steps:
1. Open **Security Center -> Redaction rules** and add the missing pattern.
2. Look at recent calls in `model_routing_log` and `audit_events`:
   ```sql
   select created_at, detail from audit_events
   where action = 'anthropic_call' and detail ilike '%PAN%'
   order by created_at desc limit 20;
   ```
3. If existing rows leaked PII, sanitize them:
   ```sql
   update audit_events
   set detail = regexp_replace(detail, '[A-Z]{5}[0-9]{4}[A-Z]', '[REDACTED-PAN]', 'g')
   where detail ~ '[A-Z]{5}[0-9]{4}[A-Z]';
   ```

## Capacity planning

### Vercel functions

Free tier: 100 GB bandwidth, 100 GB-hours of compute, 1M function
invocations per month. Anvil's heavy users are:
- `/api/claude/messages`: 1024MB, ~10s avg = ~3000 calls/month within
  free tier, or upgrade to Pro for 1000 GB-hours.
- `/api/documents/ocr`: 1024MB, up to 60s. Mistral OCR is slow on big
  PDFs. If you OCR every uploaded PDF, plan for Pro plan.

### Supabase

Free tier: 500 MB database, 1 GB file storage, 50,000 monthly active
users. Anvil's heavy storage:
- `audit_events`: ~1 KB per row x N writes per day.
- `documents` storage bucket: customer PO PDFs are ~100 KB to 5 MB each.
- `model_routing_log`: ~500 bytes per Claude call.

A typical tenant doing 50 orders/day x 6 documents/order = 300 uploads/day
+ 200 audit rows = ~30 MB/month. Free tier handles ~15 tenants comfortably.

### Anthropic

Watch the **Cost Analytics Deep -> Breakdown** tab weekly. If
`costPerSuccess` rises sharply, something is calling Sonnet when Haiku
would do. Check `model_routing_log` for fallback frequency.

## Recovery procedures

### A migration failed mid-apply

Migrations are idempotent (`create table if not exists`, `drop policy if
exists`) so re-running is safe. Find the line that failed via the SQL
editor error message; fix the cause; re-run from the top of the file.

If a CREATE TYPE failed because the type already exists, that's fine.
PostgreSQL will skip it on re-run only if the migration uses `do $$ ...
exception when duplicate_object then null end $$`. None of the supplied
migrations use this pattern; they all use `create type if not exists`
which Postgres does NOT support natively, so we use plain `create type`.

If you re-run a migration that does `create type order_mode as enum (...)`
and the type exists, you'll get an error. Edit the migration locally to
add `if not exists` or wrap in a `do $$ ... exception ... end $$` block,
then re-run. Better: only run migrations once, in order.

### A user got the wrong role

```sql
update tenant_members set role = 'sales_engineer'
where tenant_id = 'YOUR_TENANT_ID'
  and user_id = (select id from auth.users where email = 'user@example.com');
```

### Need to delete an order and everything attached

Cascading deletes are wired:
```sql
delete from orders where id = '<order-uuid>';
```
Removes: source_pos, source_po_events, evidence, validation_findings,
order_documents, communications, order_amendments, order_schedule_lines,
quote_approvals, einvoices (FK is `set null`).

Documents in storage do NOT cascade (intentional: same doc may attach to
multiple orders). Clean up via the storage UI if needed.

### Rolling back to a prior deploy

In Vercel: **Deployments -> click an older one -> Promote to Production**.
The DB is unaffected; if a recent migration broke things, use the
backup-restore approach.

## Communication

When an incident affects users:

1. **Status page** (set this up before launch). A static page on a
   different host that the team updates manually.
2. **Slack/email** to the affected tenants.
3. **Audit log entry**: every operator action during incident response
   should leave a row in `audit_events` so the post-mortem has data.

## Post-incident

For every Sev 1 or Sev 2:

1. Write a one-page post-mortem in `docs/postmortems/YYYY-MM-DD.md`.
2. Cover: timeline, root cause, contributing factors, what worked, what
   didn't, action items with owners and dates.
3. File the action items as separate issues. Track them on the next
   weekly review.
