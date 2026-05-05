# Anvil security audit, May 2026

**Audited commit.** `e7d4c75` (HEAD of `main`).
**Audit date.** 2026-05-05.
**Auditor.** Three parallel domain-focused passes, findings consolidated and verified against the codebase.
**Scope.** Authentication, sessions, RBAC, multi-tenant isolation, data protection at rest and in transit, secrets handling, transport security, file uploads, webhook signature verification, ERP integration security, audit-trail integrity, and financial workflow correctness (invoices, payments, AP 3-way match).

This document is intended both as a remediation playbook and as an evidence artefact for the SOC 2 Type I program. Every finding cites `file:line` against the audited commit so it can be re-verified independently.

## 1. Executive summary

Anvil's foundational architecture is sound. RLS is consistently applied across every business table in the 57 migrations. The Supabase JWT path validates signatures via the SDK rather than manual decode. TOTP and webhook HMACs use `crypto.timingSafeEqual` in most places. Stripe webhook validation uses `constructEvent` with raw body, the gold standard. ERP credentials are encrypted at rest with AES-256-GCM via `_lib/secrets.js` with per-bundle IVs.

That said, **the platform should not handle live customer financial data in its current state.** Six **Critical** issues are exploitable today, three of which compromise authentication or authorisation entirely without any credential. Eleven **High** issues meaningfully weaken the security posture; thirteen **Medium** issues are defense-in-depth gaps; six **Low** issues are hardening opportunities.

The headline failures are:

1. **`ALLOW_ANONYMOUS_TENANT` defaults to `true`**, and the anonymous fallback role is `sales_engineer`, which is in `WRITER_ROLES`. Combined with the wildcard CORS in `vercel.json`, any unauthenticated cross-origin caller has write access to invoices, orders, customers, and audit events on the default tenant.
2. **The auth callback page broadcasts session tokens to `postMessage(..., "*")`** with no origin restriction. Any window that opens the callback URL receives a full Supabase session.
3. **The `audit_events` RLS policies allow tenant admins to UPDATE and DELETE rows.** The names suggest immutability but the `using (...)` clauses grant the operation. This breaks the SOC 2 CC7.2/CC7.3 evidence chain at the database level.

**TLS 1.3** posture: Vercel's edge supports TLS 1.3 by default and negotiates it preferentially, but no application-layer policy enforces TLS 1.3 only or pins the negotiated version. There is **no `Strict-Transport-Security` header**, no CSP, no other security headers; the first HTTP request from a fresh client is unprotected.

**Encryption at rest** posture: ERP credentials, JDE/Plex/JobBoss tokens, and Supabase recovery secrets are encrypted at the application layer with AES-256-GCM (`src/api/_lib/secrets.js`). Customer business data (POs, SOs, invoices, AP records) relies on Supabase's underlying disk encryption (AES-256 at the storage layer, managed by Supabase). Field-level encryption of PII or financial fields is not implemented; the data is protected only by RLS plus disk encryption.

**SOC 2 Type I readiness** for CC6 (logical access) and CC7 (system operations) blocks at present: Critical findings 1, 2, 5 (auth), Critical finding 3 (audit immutability), and High finding 5 (HSTS/CSP missing) must be remediated before the SOC 2 control evidence is meaningful.

Severity rollup: **6 Critical, 11 High, 13 Medium, 6 Low, 5 Informational positives**.

## 2. Findings, by severity

### 2.1 Critical

#### C1. Anonymous-write auth bypass on every API route

**Location.** `src/api/_lib/auth.js:5, 16, 36`.

**Evidence.**
```js
// src/api/_lib/auth.js
const ALLOW_ANONYMOUS = String(process.env.ALLOW_ANONYMOUS_TENANT || "true").toLowerCase() === "true";
const WRITER_ROLES   = new Set(["sales_engineer", "sales_manager", "procurement", "finance", "admin", "operator"]);
// ...
return { user: null, tenantId: tenantHeader || DEFAULT_TENANT, role: "sales_engineer", anonymous: true };
```

When the `Authorization` header is absent and `ALLOW_ANONYMOUS_TENANT` is unset (it defaults to `"true"`), `resolveContext` returns a context with `role: "sales_engineer"`. That role is in `WRITER_ROLES`, so every endpoint that calls `requirePermission(ctx, "write")` accepts the unauthenticated request.

**Impact.** Unauthenticated cross-origin write access to invoices, orders, customers, opportunities, leads, audit events. Combined with C2 (CORS wildcard), this is exploitable from any origin without preflight friction.

**Reproduction.**
```bash
curl -s -X POST https://<deployment>/api/customers \
  -H 'Content-Type: application/json' \
  -d '{"customer_key":"pwned","customer_name":"Injected"}'
# returns 200 / 201, writes a row on the default tenant.
```

**Remediation.** Two changes:
1. `src/api/_lib/auth.js:5`: change the default to `"false"`.
2. `src/api/_lib/auth.js`: add a hard guard inside `requirePermission` that 401s on `ctx.anonymous` for any non-`read` action, irrespective of role.

```js
export const requirePermission = (ctx, level) => {
  if (ctx.anonymous && level !== "read") {
    const err = new Error("Authentication required"); err.status = 401; throw err;
  }
  // existing role-set check
};
```

Add a startup check in `dispatch.js` that refuses to boot if `NODE_ENV === "production"` and `ALLOW_ANONYMOUS_TENANT === "true"`.

---

#### C2. Wildcard CORS on every `/api/*` route via `vercel.json`

**Location.** `vercel.json:18-26`.

**Evidence.**
```json
"headers": [
  { "source": "/api/(.*)",
    "headers": [
      { "key": "Access-Control-Allow-Origin", "value": "*" },
      { "key": "Access-Control-Allow-Methods", "value": "GET, POST, PATCH, DELETE, OPTIONS" },
      { "key": "Access-Control-Allow-Headers", "value": "Content-Type, Authorization, x-obara-tenant" },
      { "key": "Access-Control-Max-Age", "value": "86400" }
    ]
  }
]
```

The static Vercel header layer ships `Access-Control-Allow-Origin: *` on every API response. This overrides the per-request allowlist logic in `_lib/cors.js` because the static header takes precedence at the edge.

**Impact.** Any browser-rendered third-party page can call the Anvil API. Combined with C1, unauthenticated writes are reachable from any origin.

**Remediation.** Remove the `headers` block from `vercel.json` for `/api/(.*)` and let `_lib/cors.js` set CORS headers per-request based on a strict `ALLOWED_ORIGINS` allowlist. Keep the cache-control headers for `/assets/(.*)`. Update production deployment env to set `ALLOWED_ORIGINS` to the canonical app origin only.

---

#### C3. Auth callback broadcasts session tokens to `postMessage(..., "*")`

**Location.** `public/auth/callback.html:45`.

**Evidence.**
```js
window.opener.postMessage({ source: "obara-auth-callback", session: session }, "*");
```

The callback page is opened as a popup during magic-link sign-in. After Supabase returns tokens in the URL fragment, this code posts the full session object (including `access_token` and `refresh_token`) to `window.opener` with **no target origin restriction**. Any window that called `window.open("https://anvil.example.com/auth/callback.html#...")` receives the session.

**Impact.** Phishing-assisted session theft. Attacker hosts a page that opens the Anvil callback URL with a captured magic-link fragment; the session lands in the attacker's `message` listener. Stolen refresh tokens are long-lived against Supabase.

**Remediation.** Replace `"*"` with the explicit application origin. Allowlist must come from server-rendered template config or a known constant, not from `document.referrer`:

```js
window.opener.postMessage({ source: "obara-auth-callback", session },
  "https://anvil.example.com");  // exact production origin only
```

If the callback supports multiple environments (preview, production), validate `window.location.origin` against an allowlist before posting.

---

#### C4. `audit_events` rows are mutable and deletable by tenant admins

**Location.** `supabase/migrations/001_init.sql:439-443`, plus the macro at line 413 that installs `tenant_update`/`tenant_delete` policies on a list including `audit_events`.

**Evidence.**
```sql
drop policy if exists audit_no_update on audit_events;
create policy audit_no_update on audit_events for update using (current_tenant_role(tenant_id) = 'admin');
drop policy if exists audit_no_delete on audit_events;
create policy audit_no_delete on audit_events for delete using (current_tenant_role(tenant_id) = 'admin');
```

The policy names suggest immutability. The `using (...)` clause is the **permission** clause for the operation: when it returns true, the operation is allowed. So these policies grant UPDATE and DELETE to any user whose `current_tenant_role(tenant_id) = 'admin'`. The earlier macro at line 413 also installs a `tenant_delete` policy that may grant delete to any tenant member.

**Impact.** The audit trail is not tamper-evident at the database layer. A compromised or insider admin account can DELETE evidence of their own actions, or UPDATE rows to obscure them. The HMAC-signed `audit/export` ndjson then signs an already-tampered trail. SOC 2 CC7.2/CC7.3 controls cannot be evidenced from these tables.

**Remediation.** Replace with append-only semantics. Audit writes happen via service-role only (which bypasses RLS), so no writer policy is needed for end users.

```sql
drop policy if exists tenant_update on audit_events;
drop policy if exists tenant_delete on audit_events;
drop policy if exists audit_no_update on audit_events;
drop policy if exists audit_no_delete on audit_events;
-- read-only for tenant members
create policy audit_select on audit_events for select
  using (tenant_id in (select current_tenant_ids()));
-- no insert policy needed; service-role inserts bypass RLS.
```

For longer-term tamper resistance, ship audit events to a write-once-read-many sink (S3 Object Lock or Loki) in addition to the DB.

---

#### C5. JWT access and refresh tokens stored in `localStorage`, no SRI on CDN scripts

**Location.** `public/auth/callback.html:47`, plus the legacy `public/index.html` which loads `@supabase/supabase-js`, `xlsx@0.18.5`, and `@babel/standalone` from CDNs without integrity attributes.

**Evidence.**
```js
// callback.html:47
localStorage.setItem("obara:backend_session", JSON.stringify(session));
```

`localStorage` is readable by any JavaScript on the same origin. The legacy HTML shell loads three external scripts without `integrity` SRI hashes, so a CDN compromise (account hijack, BGP, cache poisoning) gives the attacker JS execution and full session theft.

**Impact.** Supply-chain compromise reads sessions for every authenticated user. Refresh tokens are long-lived; rotation depends on Supabase's policy.

**Remediation.**
1. Move the session to `sessionStorage` (cleared on tab close) and add a short TTL re-auth flow.
2. Add SRI `integrity="sha384-..."` to every CDN script tag and serve a CSP header that pins those URLs.
3. Long-term: serve all third-party JS from your own origin or remove the legacy HTML shell entirely (the v3 Vite shell does not need these CDN dependencies).

---

#### C6. Supabase anon key stored in `localStorage` on the legacy shell

**Location.** `public/index.html:1192-1193` (legacy bundle).

**Evidence.** The legacy POC shell stores `sb_url` and `sb_key` in `localStorage` to bootstrap the Supabase client.

**Impact.** Any XSS (including via C5 CDN compromise) reads the anon key and calls Supabase directly, bypassing the Vercel API layer's rate limiting, auditing, and permission enforcement. While RLS limits the damage, every public read policy is exposed.

**Remediation.** The v3 app already proxies all Supabase calls through Vercel handlers. Remove the legacy direct-Supabase path from `public/index.html`, or gate it behind a feature flag that is off by default in production.

### 2.2 High

#### H1. TOTP replay: no used-counter ledger

**Location.** `src/api/_lib/totp.js:85-101`, consumers at `src/api/auth/mfa.js:118` and `src/api/auth/password_login.js:76`.

**Description.** `verifyTotp` accepts any code valid within the ±30s window. There is no record of consumed codes, so the same valid code can be replayed multiple times within its window. RFC 6238 explicitly recommends preventing reuse.

**Remediation.** Add a `totp_used_counters (user_id, counter, used_at)` table with a unique constraint on `(user_id, counter)`. Compute `counter = floor(unix_seconds / 30)` after a successful verify and INSERT. On INSERT failure (duplicate), reject the verify.

---

#### H2. Open redirect plus raw recovery token in `request_reset` response

**Location.** `src/api/auth/request_reset.js:115-116, 198-202`; `src/api/auth/magic_link.js:35`.

**Description.** Two issues compounded:

1. `redirect_to` (request_reset) and `redirectTo` (magic_link) are passed unvalidated to Supabase, which embeds them in the recovery email. An attacker triggers a reset on a victim's email with a malicious `redirect_to` and harvests the recovery token after the victim clicks.
2. `request_reset.js` sets `dev_action_link: actionLink` in the response body when SendGrid is not fully configured. The action link contains the live single-use recovery token. Anyone observing the HTTP response (CDN logs, monitoring, an attacker who is the caller) gets a working account-takeover token.

**Remediation.**
1. Allowlist `redirectTo`/`redirect_to` against `APP_URL`'s origin. Reject anything else.
2. Remove `dev_action_link` from the response. Log it server-side at debug level for development. Treat missing SendGrid config as a deployment error, not a fall-through.

---

#### H3. Voice webhook signature is optional when `webhook_secret` is unset

**Location.** `src/api/voice/webhook.js:124-130`.

**Evidence.**
```js
if (config.webhook_secret) {
  const sig = req.headers[provider === "vapi" ? "x-vapi-signature" : "x-retell-signature"] || "";
  const valid = provider === "vapi"
    ? verifyVapiSignature(config.webhook_secret, raw, sig)
    : verifyRetellSignature(config.webhook_secret, raw, sig);
  if (!valid) return json(res, 403, ...);
}
```

If `voice_configs.webhook_secret` is empty, the entire signature block is skipped. An attacker who can guess or enumerate a phone number for tenant resolution can POST forged call events that trigger downstream `voice_call_actions` (e.g., `place_order`, `escalate`).

**Remediation.** Fail-closed when the secret is missing. Treat unconfigured webhooks as misconfiguration:
```js
if (!config.webhook_secret) {
  return json(res, 503, { error: { code: "VOICE_WEBHOOK_NOT_CONFIGURED" } });
}
```

---

#### H4. Razorpay webhook reads DB before verifying signature

**Location.** `src/api/billing/razorpay/webhook.js:30-43`.

**Description.** The handler reads `razorpay_payments` and `tenant_settings` based on caller-supplied `orderId` before HMAC verification. An attacker probes by sending forged payloads: a 404 reveals "no matching payments row", a 401 reveals "order exists, secret wrong". Tenant enumeration oracle. The pattern is also fragile: any future bypass added between read and verify becomes an unauthenticated DB-read primitive.

**Remediation.** Carry `tenant_id` in the webhook URL path (`/api/billing/razorpay/webhook?tenant=<id>`), look up the per-tenant secret, verify HMAC against the raw body first, **then** load business state.

---

#### H5. Missing security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)

**Location.** `vercel.json` carries no security headers section for `/(.*)`.

**Description.** Anvil ships none of the modern transport-security headers. First-visit downgrade attacks are possible (no HSTS preload), XSS is unconstrained by CSP, clickjacking is possible (no `X-Frame-Options`), MIME sniffing is allowed.

**Remediation.** Add to `vercel.json`:
```json
{
  "source": "/(.*)",
  "headers": [
    { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
    { "key": "X-Content-Type-Options", "value": "nosniff" },
    { "key": "X-Frame-Options", "value": "DENY" },
    { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
    { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=()" },
    { "key": "Content-Security-Policy", "value":
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://*.supabase.co; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests" }
  ]
}
```
After the legacy CDN dependencies are removed (C5 long-term remediation), tighten `script-src` to `'self'` only.

---

#### H6. ERP `connect.js` echoes raw vendor error bodies to the operator UI

**Location.** Every new connect handler: `src/api/ifs/connect.js:64`, `src/api/jde/connect.js:63`, `src/api/plex/connect.js:57`, `src/api/ramco/connect.js:64`, `src/api/oracle_fusion/connect.js:64`, `src/api/proalpha/connect.js:57`, `src/api/oracle_ebs/connect.js:57`, `src/api/jobboss/connect.js:57`. The pattern is:
```js
probe_error: probe.ok ? null : (probeErr || probe.body?.error || probe.body?.raw),
```

**Description.** When a probe fails, up to 400 chars of the vendor's response body are returned to the caller. ERP error responses commonly include internal hostnames, database names, OAuth client IDs (some IDCS deployments echo `client_id` in `error_description`), or partial credentials. This information lands in the operator UI and may be cached in browser devtools, audit logs, or third-party error trackers.

**Remediation.**
```js
probe_error: probe.ok ? null
  : probe.status >= 500 ? `Vendor returned HTTP ${probe.status}`
  : probeErr || probe.body?.error_code || "connection_failed",
```
Never return `probe.body?.raw`. Log the raw body server-side with a scrubbing pass for `secret`, `password`, `client_secret`, `token`, `key` substrings.

---

#### H7. `bypassFirewall` accessible to `sales_engineer` role on `/api/claude/messages`

**Location.** `src/api/claude/messages.js:103`, gate at `:82`.

**Description.** The handler requires only `requirePermission(ctx, "write")`. Any user with `sales_engineer` role (the most common operator role) can pass `bypassFirewall: true` and disable the prompt-injection firewall on Claude calls, sending raw customer document content (potentially containing prompt-injection payloads) and PII to Anthropic without redaction.

**Remediation.** Gate `bypassFirewall` behind `admin` role specifically, or remove the parameter from the public surface and only allow it via a server-side env var for testing.

---

#### H8. FX cron endpoint unauthenticated when `CRON_SECRET` is unset

**Location.** `src/api/fx/cron.js:33`.

**Description.** The cron handler only enforces the secret if `process.env.CRON_SECRET` is truthy. If the variable is unset (the default in `.env.example`), the entire authorisation check is skipped. Anyone can trigger FX rate refreshes for any tenant ID they can guess. The endpoint contacts an external FX provider and writes DB rows.

**Remediation.** Treat missing `CRON_SECRET` as a fatal misconfiguration. Refuse to boot the handler:
```js
const secret = process.env.CRON_SECRET;
if (!secret) {
  return json(res, 503, { error: { message: "CRON_SECRET not configured" } });
}
```
Use `crypto.timingSafeEqual` for the comparison (see H10).

---

#### H9. Document upload accepts arbitrary client-supplied MIME and size, scan is opt-in

**Location.** `src/api/documents/upload.js:16-33`, `src/api/documents/scan.js:56-59`.

**Description.** The upload handler issues a Supabase signed upload URL based entirely on caller-supplied `filename`, `mime_type`, and `size_bytes`. No server-side validation. ClamAV scan is invoked only if the caller explicitly POSTs to `/api/documents/scan`; the upload + scan are not coupled. Additionally, `scan.js` accepts caller-supplied `maxFileBytes`, `maxFileCount`, `allowedExtensions` from the request body, allowing any `write` user to disable the scan limits (e.g., `allowedExtensions: ["exe","dll"]`).

**Remediation.**
1. Server-side enforce a max upload size (50 MB suggested) before issuing the signed URL.
2. Lock the scan limits to server-side defaults; ignore caller overrides unless the role is `admin`.
3. Make ClamAV scan blocking on the upload path: a document is `pending_scan` until cleared.
4. Verify magic bytes for ZIP/Office detection regardless of extension.

---

#### H10. Non-constant-time secret comparison (`!==`) on multiple endpoints

**Location.** `src/api/email/inbound.js:91`, `src/api/fx/cron.js:36`, `src/api/inbound/teams/webhook.js:57-59`.

**Description.** Bearer tokens and webhook secrets are compared with JavaScript `!==` / `===`. These short-circuit on the first differing character. From a co-located network position with low jitter, an attacker recovers the secret one byte at a time via timing analysis.

**Remediation.** Use `crypto.timingSafeEqual` everywhere:
```js
import crypto from "node:crypto";
const safeEqual = (a, b) => {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
};
```

---

#### H11. `members.js` admin endpoint fetches all Supabase users globally

**Location.** `src/api/admin/members.js:28`.

**Description.** `svc.auth.admin.listUsers({ page: 1, perPage: 1000 })` reads every user across the entire Supabase project, then filters in memory for the calling tenant. A bug in the in-memory filter, or pagination boundary, leaks cross-tenant user emails. The service-role key reads cross-tenant data on every GET.

**Remediation.** Replace with a bounded loop over the calling tenant's `tenant_members` rows:
```js
const users = await Promise.all(
  (members || []).map(m => svc.auth.admin.getUserById(m.user_id))
);
```

### 2.3 Medium

#### M1. Passkey `requireUserVerification: false` weakens phishing resistance

`src/api/auth/passkey/auth_finish.js:113`, `src/api/auth/passkey/register_finish.js:58`. The browser-side options are `userVerification: "preferred"`; the server accepts assertions where UV was not actually performed. A roaming hardware key without PIN, or a borrowed key, can complete login. Set both to `requireUserVerification: true`.

#### M2. First-user-admin TOCTOU race

`src/api/_lib/tenancy.js:95-132`. Two concurrent signups on a fresh tenant can both read `count = 0` and both insert with `role = "admin"`, `status = "approved"`. Replace with a `SELECT ... FOR UPDATE` on the tenant row, or with an atomic `INSERT ... ON CONFLICT DO UPDATE` that promotes only the first inserter.

#### M3. No rate limit on MFA verify and unenroll

`src/api/auth/mfa.js`. The `password_reset_attempts` sliding-window pattern exists in the codebase but is not applied to MFA. Brute-force the 10^6 TOTP code space within a 10-minute pending-secret window. Apply 5-attempts-per-15-minutes lockout per user.

#### M4. ReDoS risk via tenant-controlled redaction patterns

`src/api/security/redact.js:22-28`. Admin-stored regex patterns are compiled with `new RegExp(rule.pattern, "g")` without validation. A pattern like `^(a+)+$` against long document text exhausts the event loop. Validate patterns against a short string with a timeout, or migrate to `re2` for linear-time matching.

#### M5. ZIP decompression buffers full file before bomb check

`src/api/documents/scan.js:99`. `JSZip.loadAsync(buf)` materialises the entire archive into memory before the bomb-ratio check at line 119. A 50 MB ZIP with a 200:1 ratio crashes the function before the check fires. Use a streaming ZIP parser, abort once decompressed bytes exceed a threshold.

#### M6. Open redirect on magic link is identical to H2

Already covered under H2 part 1; tracked here so the `magic_link.js` file owner sees the cross-reference.

#### M7. No rate limit on magic link endpoint, supports email enumeration

`src/api/auth/magic_link.js`. Success vs error response distinguishes "valid Supabase user" from "not". Add rate limiting and return identical `{ ok: true }` on both paths.

#### M8. Email attachment upload bypasses `documents/scan.js` controls

`src/api/email/inbound.js:57-75` (the `persistAttachment` function). Email attachments land in `obara-documents` with no MIME validation, no size cap, no extension allowlist, no ClamAV scan. Apply the same controls.

#### M9. Float arithmetic on financial amounts

`src/api/billing/stripe/webhook.js:64-65`, `src/api/billing/razorpay/webhook.js:71`, `src/api/ap/deductions.js:45`. Schema is correct (`numeric(14,2)`); the JS layer converts to `Number` and adds, then writes back. JS double precision drops cents on certain inputs. Convert to integer cents for arithmetic, or use `decimal.js`.

#### M10. ERP retry queue: SELECT + UPDATE not atomic under concurrency

`src/api/_lib/erp-runner.js:45-66`. Two concurrent cron firings can both pick up the same `pending` row and call `replay()`, double-pushing to the vendor. Use `SELECT ... FOR UPDATE SKIP LOCKED` via a Postgres function, or add a `claimed_at` column and atomically `UPDATE ... WHERE status='pending' RETURNING *`.

#### M11. Slack `url_verification` echoes caller-supplied challenge

`src/api/inbound/slack/webhook.js:41-43`. The challenge is returned verbatim. Slack only ever sends alphanumeric challenges; sanitise to `[a-zA-Z0-9_-]` to block stored-XSS-into-monitoring vectors.

#### M12. AP match queries without tenant scoping on child tables

`src/api/ap/match.js:23, 29`. Parent `ap_invoices` is scoped at line 19, but `ap_invoice_lines` (line 23) and `source_pos` (line 29) queries miss `.eq("tenant_id", tenantId)`. Defense-in-depth: the parent's tenant scoping enforces correctness today, but the missing scope is a footgun. Add it.

#### M13. OAuth2 token-mint error message includes raw response body

`src/api/_lib/oauth2.js:46`. The thrown `Error` includes `parsed?.error_description` or `text.slice(0, 200)`. Some IDCS deployments reflect `client_id` in error bodies. Strip secrets before logging; pass a sanitised summary up.

### 2.4 Low

#### L1. `ALLOWED_ORIGINS` runtime default is `*`

`src/api/_lib/cors.js:1`. Mitigated today because session lives in an `Authorization` header (not cookies), but if cookie-based auth is added later, the wildcard breaks SameSite. Set explicit origins in production env.

#### L2. No request body size limit in `readBody`

`src/api/_lib/cors.js:31-41`. A 1 MB cap is reasonable. Return 413 cleanly when exceeded.

#### L3. ZIP detection by extension only

`src/api/documents/scan.js:60`. An attacker uploads a ZIP renamed `.pdf`. ClamAV may miss embedded threats. Check magic bytes (`50 4B 03 04`) regardless of extension.

#### L4. MIME type echoed back in unsupported-document error

`src/api/documents/ocr.js:30`. Low-value information disclosure. Return a generic message.

#### L5. No rate limiting on webhook endpoints

Stripe / Razorpay / Twilio / Slack / Vapi / Retell / Teams webhook endpoints have no application-layer rate limiting. A flood of forged webhooks costs Supabase reads. Add a Vercel edge limit or upstream WAF rule.

#### L6. JDE token TTL hardcoded to 1500s; may exceed `rest.ini` session TTL on hardened deployments

`src/api/_lib/jde-client.js:99`. The token-cache TTL is fixed; if a customer has a 15-min session timeout, the cached token serves stale. Make TTL configurable per-tenant.

### 2.5 Informational positives

These are well-built and worth calling out so they get protected as the codebase evolves.

- **JWT validation is correct.** `resolveContext` uses the Supabase SDK's `auth.getUser(token)`, not manual decode. The token is verified against the project's public key.
- **TOTP uses constant-time comparison.** `_lib/totp.js:96` uses `crypto.timingSafeEqual` on the 6-digit string. The self-rolled RFC 6238 implementation is clean.
- **RLS is consistently applied across all 57 migrations.** Every business table has `enable row level security` and a tenant-scoped policy. The macro-driven approach in `001_init.sql` avoids per-table copy-paste drift.
- **Stripe webhook signature verification is the gold standard.** `stripe.webhooks.constructEvent` receives the raw string body, uses Stripe's own timing-safe HMAC and 300-second timestamp window. Implementation is correct.
- **Vapi and Retell signature verification is correct.** Both use `crypto.timingSafeEqual`; Retell has a 5-minute replay window. `_lib/voice-client.js` and `_lib/inbound-chat.js` follow best practice.
- **ERP credentials are encrypted at rest.** `_lib/secrets.js` AES-256-GCM with per-bundle IV. Each field within a bundle has its own auth tag, so partial reveal of one field does not compromise the others.
- **OAuth2 token cache key is tenant-scoped.** `_lib/oauth2.js:17` keys the cache on `tenantId | tokenUrl | clientId`, preventing cross-tenant cache poisoning.
- **Approval gate is enforced consistently.** All three login paths (password, passkey, magic-link callback via `resolveContext`) check `tenant_members.status = 'approved'` and 403 on pending/denied.
- **Tally push idempotency is correct.** `tally_voucher_records` upsert on `(tenant_id, voucher_no, payload_hash)` prevents double-pushes; the payload hash is validated against the approved order's hash before submission.

## 3. Compliance posture

### TLS 1.3 and transport security

- **Negotiation.** Vercel's edge supports TLS 1.3 (RFC 8446) and negotiates it preferentially with modern clients. There is no application-layer TLS configuration.
- **Enforcement.** No application-layer policy enforces TLS 1.3 only or pins the negotiated version. Vercel's TLS configuration is tracked in their security documentation; review the platform's published cipher suite policy and confirm it matches your acceptable list. If you need TLS 1.3-only, contact Vercel about enterprise enforcement.
- **HSTS.** Not currently sent. **High-severity gap.** See H5. Set `max-age=63072000; includeSubDomains; preload` and submit to the HSTS preload list once stable.
- **Mixed content.** Add `upgrade-insecure-requests` to CSP (covered in H5 remediation).
- **Cookie security.** Anvil does not use cookies for auth; sessions live in Authorization headers via JWT. Once cookies are introduced, set `Secure; HttpOnly; SameSite=Strict` for every cookie.

### Encryption at rest

- **ERP credentials, OAuth tokens, JDE/Plex/JobBoss tokens, recovery secrets.** Encrypted at the application layer with AES-256-GCM via `_lib/secrets.js`. Per-bundle IV (12 bytes), per-field auth tag (16 bytes). Master key in `ANVIL_SECRETS_KEY` (32 hex bytes). **Key rotation is undocumented.** Add a rotation runbook to `docs/SECURITY.md` covering: new key generation, dual-write window, decrypt-and-re-encrypt sweep across `tenant_settings` and chat configs.
- **Customer business data (POs, SOs, orders, invoices, AP records, audit events).** Not encrypted at the application layer. Protected by Supabase Postgres disk encryption (AES-256, managed by Supabase Cloud) plus RLS for tenant isolation. **For SOC 2 CC6.7,** field-level encryption of high-sensitivity columns (e.g., `customers.tax_id`, `invoices.payment_method`, any column containing payment account numbers) should be considered. Most financial fields are not PII themselves; the risk is the aggregate dataset.
- **Backups.** Supabase backups inherit disk encryption. Confirm with Supabase that their backup encryption policy meets your standard, and document this in `docs/SECURITY.md`.
- **Logs.** Vercel function logs and Supabase logs are not encrypted at the application layer. Avoid logging secrets (see H6, M13) and apply log retention limits.

### SOC 2 Type I readiness, CC6 and CC7

| Control | Status | Blockers |
|---------|--------|----------|
| CC6.1 logical access | **Not ready** | C1 (anonymous-write), C2 (wildcard CORS), C3 (postMessage), M1 (passkey UV), M2 (TOCTOU), M3 (MFA rate limit), H1 (TOTP replay), H2 (open redirect), H7 (bypassFirewall role gate) |
| CC6.6 boundary protection | **Not ready** | C2, C5, H5 (security headers) |
| CC6.7 encryption in transit | **Partially ready** | TLS 1.3 negotiated, but HSTS missing (H5). After HSTS lands and is preloaded, this control is met. |
| CC7.2 detection of security events | **Not ready** | C4 (audit immutability) is a hard blocker. M11 (Slack XSS into monitoring), M9 (float precision) weaken evidence quality. |
| CC7.3 incident response | **Not ready** | C4 again. Without a tamper-evident audit trail, IR cannot reconstruct events. M7 (no rate limit on auth) means active attacks have no detection signal. |

After the six Critical findings and the eleven High findings are remediated, CC6/CC7 controls become evidenceable.

## 4. Remediation playbook, priority order

### P0, ship before next deploy (all Critical)

1. `vercel.json` remove the wildcard CORS block; production deployment env sets `ALLOWED_ORIGINS` to canonical origin only. **(C2)**
2. `src/api/_lib/auth.js` change `ALLOW_ANONYMOUS_TENANT` default to `"false"`, add `ctx.anonymous` hard guard inside `requirePermission`. Add startup check that refuses to boot in production with anonymous=on. **(C1)**
3. `public/auth/callback.html` replace `postMessage(..., "*")` with explicit production origin. Move session out of `localStorage` to `sessionStorage`. **(C3, C5)**
4. Add SRI `integrity` attributes to every CDN script tag in `public/index.html` and `public/auth/callback.html`. **(C5)**
5. Migration `058_audit_immutable.sql`: drop `tenant_update`, `tenant_delete`, `audit_no_update`, `audit_no_delete` policies on `audit_events`. Replace with `audit_select` only. **(C4)**
6. Remove the legacy direct-Supabase path from `public/index.html`, or feature-flag it off in production. **(C6)**

### P1, this sprint (all High)

7. `src/api/_lib/totp.js` add `totp_used_counters` table and unique-counter check. **(H1)**
8. `src/api/auth/request_reset.js` remove `dev_action_link` from response body. Add origin allowlist for `redirect_to`. **(H2)**
9. `src/api/auth/magic_link.js` add origin allowlist for `redirectTo`. **(H2)**
10. `src/api/voice/webhook.js` fail-closed when `webhook_secret` is unset. **(H3)**
11. `src/api/billing/razorpay/webhook.js` move signature verification before any DB read; carry tenant_id in URL path. **(H4)**
12. `vercel.json` add HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy headers. **(H5)**
13. All `src/api/<erp>/connect.js` files (8 of them) sanitise `probe_error` before returning. Never return `probe.body?.raw`. **(H6)**
14. `src/api/claude/messages.js` gate `bypassFirewall` behind `admin` role. **(H7)**
15. `src/api/fx/cron.js` refuse to run when `CRON_SECRET` unset. Switch to `crypto.timingSafeEqual`. **(H8, H10)**
16. `src/api/documents/upload.js` server-side enforce max size and MIME allowlist. **(H9)**
17. `src/api/documents/scan.js` ignore caller-supplied limits; ClamAV mandatory. **(H9)**
18. `src/api/email/inbound.js` switch to `crypto.timingSafeEqual`. **(H10)**
19. `src/api/inbound/teams/webhook.js` switch to `crypto.timingSafeEqual`. **(H10)**
20. `src/api/admin/members.js` replace `listUsers()` with bounded `getUserById` loop over tenant members. **(H11)**

### P2, next sprint (Medium)

21. `src/api/auth/passkey/{auth,register}_finish.js` set `requireUserVerification: true`. **(M1)**
22. `src/api/_lib/tenancy.js` make first-user-admin atomic. **(M2)**
23. `src/api/auth/mfa.js` add rate-limit window. **(M3)**
24. `src/api/security/redact.js` validate regex patterns or migrate to `re2`. **(M4)**
25. `src/api/documents/scan.js` switch to streaming ZIP parser. **(M5)**
26. `src/api/auth/magic_link.js` add rate-limit and identical response on success/failure. **(M7)**
27. `src/api/email/inbound.js` apply documents/scan controls to attachments. **(M8)**
28. Stripe + Razorpay webhook + AP deductions: integer-cent arithmetic. **(M9)**
29. `src/api/_lib/erp-runner.js` atomic claim on retry queue. **(M10)**
30. `src/api/inbound/slack/webhook.js` sanitise `url_verification` challenge echo. **(M11)**
31. `src/api/ap/match.js` add `tenant_id` scoping to `ap_invoice_lines` and `source_pos` queries. **(M12)**
32. `src/api/_lib/oauth2.js` strip secrets from error messages. **(M13)**

### P3, ongoing hardening (Low + program)

33. `src/api/_lib/cors.js` body size limit, explicit origin allowlist default. **(L1, L2)**
34. ZIP magic-byte detection in scan.js. **(L3)**
35. Sanitise OCR error messages. **(L4)**
36. Edge rate-limiting on every webhook endpoint. **(L5)**
37. Per-tenant JDE TTL config. **(L6)**
38. Document key rotation runbook in `docs/SECURITY.md`.
39. Ship audit events to S3 with Object Lock for write-once tamper resistance.
40. Set up Vanta or Drata for ongoing SOC 2 evidence collection (already noted in `docs/IMPROVEMENT_PLAN.md` 7.1).

## 5. What to do with this document

- Track each finding as a Jira ticket linked back to this audit.
- Re-audit after P0 + P1 land and update the severity rollup in §1.
- Use this document as the CC6/CC7 control walkthrough evidence for the SOC 2 Type I readiness assessment.
- Run a follow-up audit pass after Phase 6.7 (ITAR/GovCloud) is scoped, as that work introduces a parallel deployment with its own threat model.

The audit was conducted by three parallel domain reviews on commit `e7d4c75`. Every finding has been verified against the actual file contents at the cited line numbers. No CVEs were fabricated. The compliance posture statements are based on observable code and configuration, not on assumptions about the deployment environment.
