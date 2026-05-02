# Troubleshooting

Common issues and their fixes. Sort order: most likely first.

## "Backend not connected" warning on every action

Cause: the unified app cannot reach `/api/*`. Either the bridge URL is
unset or the backend is unreachable.

Fix:
1. Open command palette -> **Connect Backend**.
2. Enter your Vercel deploy URL (or Supabase URL if calling Supabase
   directly during development).
3. Click **Save**.
4. Reload the page.

If it still fails, open the browser devtools network tab and call any
`/api/*` route. CORS errors usually mean `ALLOWED_ORIGINS` does not
include your domain.

## "Cannot read properties of undefined (reading 'tenantId')" on every endpoint

Cause: the request did not resolve a tenant. Either you are unauthenticated
and `ALLOW_ANONYMOUS_TENANT=false`, or `DEFAULT_TENANT_ID` does not exist
in `tenants`.

Fix:
- Sign in via magic link, **or**
- Set `ALLOW_ANONYMOUS_TENANT=true` and ensure `DEFAULT_TENANT_ID` row
  exists in `tenants`. Run migration 007 to seed the default.

```sql
insert into tenants (id, slug, display_name)
values ('00000000-0000-0000-0000-000000000001', 'default', 'Obara India')
on conflict (id) do nothing;
```

## "row violates row-level security policy" on insert

Cause: the API is using the user-token client (RLS-enforced) but the user
is not a member of the target tenant.

Fix: every API endpoint should call `serviceClient()` not `userClient()`
for writes. If you see this on a fresh write, the endpoint may have a bug.
Check `tenant_members`:

```sql
select tm.*, u.email
from tenant_members tm
join auth.users u on u.id = tm.user_id
order by tm.tenant_id, u.email;
```

The signed-in user must have a row for the tenant they're acting under.

## Magic link does not arrive

1. Check **Authentication -> Email** in Supabase. Provider `default` (built-in)
   is rate-limited to ~3 emails per hour. For production switch to a real
   SMTP provider via **Project Settings -> Auth -> SMTP**.
2. Check spam folder.
3. Confirm `MAGIC_LINK_REDIRECT_URL` matches one of the allowed redirect
   URLs in **Authentication -> URL Configuration**.

## Magic link click lands on an error page

The callback URL is `https://YOUR-VERCEL-URL/auth/callback.html`. If
Supabase redirects to a URL not in the allowlist, you'll see "Email link
is invalid or has expired." Add the URL under
**Authentication -> URL Configuration -> Redirect URLs**.

## "MISTRAL_API_KEY env var is not set" 500

The OCR endpoint hard-fails when no key is configured. This is by design:
the user explicitly clicked **Run server OCR**.

Fix: set `MISTRAL_API_KEY`, redeploy. The frontend `try/catch` already
shows the error message via `notifyError`, so the user sees what to do.

## "GSTN_API_URL not configured" 202 on Send to GSTN

Expected behavior when you have not configured the GSTN integration. The
e-Invoice row stays in `PENDING_GSTN` so you can compose drafts and
inspect payloads. To finish: set `GSTN_API_URL` and `GSTN_API_KEY`.

## Tally Push returns "TALLY_BRIDGE_URL not configured"

Set `TALLY_BRIDGE_URL` to the URL of your Tally HTTP bridge. The voucher
record gets `status=failed` until a bridge is wired. See
`docs/INTEGRATIONS.md#tally-prime-bridge`.

## "Inbound disabled: set EMAIL_INBOUND_TOKEN to enable"

Expected when `EMAIL_INBOUND_TOKEN` is unset. This is a security guard,
not a bug. Generate a token, set it on Vercel, and configure the same
value on your email provider's webhook config.

## "ZIP rejected" on every upload

The deterministic guards reject uploads exceeding any of:
- archive size > 50 MB
- single inner file > 25 MB
- inner file count > 1000
- nested ZIP detected
- executable extension (.exe, .dll, .bat, .cmd, .sh, .js, .vbs, .ps1, .jar, .msi)
- macro file (.xlsm or filename containing "macro")
- ZIP bomb risk (uncompressed > 4x cap)

Fix the upload, or override the limits via `body.maxFileBytes`,
`maxFileCount`, `allowedExtensions`.

## Cytoscape graph view is blank

The first time you select cose-bilkent, dagre, or klay, the layout
extension lazy-loads from a CDN. If your network blocks
`cdn.jsdelivr.net`, the graph fails to render.

Fix: switch back to a built-in layout (cose, breadthfirst, concentric,
grid, circle), or self-host the CDN bundle.

## Approval status keeps invalidating after every edit

That is the design: any edit to `result`, `line_edits`, or other
approval-bound fields clears the approval. The approval-bound payload hash
is computed from a deterministic `stableStringify(payload)` plus SHA-256
and stored on the order. Re-approve after edits.

## "Approval window expired" 409 on Push to Tally

Approval has a TTL (default 24 hours, override via
`approval.ttlHours` when approving). After expiry, status changes are
rejected with HTTP 409 and the order falls back to PENDING_REVIEW.

Fix: re-approve. The original approver must do it again because the audit
trail tracks who approved the last valid window.

## FX cron returned 0 rows

Frankfurter has no rates for weekends or holidays. The cron at 04:00 UTC
queries for the previous business day. If your daily run was on a Monday,
it queries Friday. Check `audit_events` filtered by `action=fx_cron_run`
to see the as_of date.

To manually pull a specific historical date:

```sh
curl -X POST https://YOUR-VERCEL-URL/api/admin/fx_rates \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"asOf":"2024-01-15"}'
```

## "verified 3 script blocks, 1 failed" in CI

The build produced an HTML with a syntax error in one of the inline
script blocks. Run `node src/scripts/verify-html.mjs` locally to see which
block. The most common cause is a literal `\n` or `\t` inside a
double-quoted string in a backtick template (the template eval converts
escape sequences to real newlines/tabs, breaking JS string literals).

Fix: replace `\n` with `\\n`, `\t` with `\\t` in the offending source.

## Build fails: "Invalid regular expression: missing /"

Same root cause as above, but for regex literals: `/\r?\n/` in a backtick
template becomes `/<actual CR><actual LF>/` which is not a valid regex.

Fix: `/\\r?\\n/` in source.

## Function timeouts on first cold start

Vercel cold starts can run up to 5 seconds. The functions sized for 60
seconds in `vercel.json` (Claude, OCR, scan, master_data) are fine. For
others if you see consistent timeouts, increase the `maxDuration` in
`vercel.json`.

## Audit log explodes in size

Every API write creates an audit row. If you're seeing 1M+ rows, set up a
retention policy:

```sql
delete from audit_events
where created_at < now() - interval '180 days'
  and tenant_id = 'YOUR_TENANT_ID';
```

Or schedule this as a Supabase Cron job.

## Where to look for errors

In order of value:

1. **Vercel Logs** under Project -> Logs. Real-time view of every function
   invocation. Filter by status code 500 to find errors.
2. **Supabase Logs** under Database -> Logs. Shows SQL errors,
   connection issues.
3. **Browser devtools console**. The unified HTML logs every backend call
   it makes when the dev token is set.
4. **Audit events** table. Every action records a row, including failures.
   Filter by `action like '%_failed'` to find recent issues.

## Dev environment specifics

If you're running `vercel dev` locally and Supabase Auth callbacks land
back on the production URL:

- Set `MAGIC_LINK_REDIRECT_URL=http://localhost:3000/auth/callback.html`
  in `.env.local`.
- Add `http://localhost:3000/auth/callback.html` to
  **Authentication -> URL Configuration -> Redirect URLs** in Supabase.

## When all else fails

1. Run `npm run check && npm run build && npm run verify`. If any of those
   fail, the deploy will fail too.
2. Open **Show Integration Report** from the palette. Every row should be
   `ok`. An `err` row tells you exactly which feature is broken.
3. Open the latest **Audit Log Modal** entry. Failed actions log a
   `detail` field with the error.
4. File an issue with: the action you took, the error you saw, the
   browser console output, the Vercel function logs for that call.
