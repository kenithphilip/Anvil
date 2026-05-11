# A5 Deep-Dive v2: Data model, RLS, multi-tenancy, schema evolution

Base: `main` @ `c4f946b` ("feat(bet2): format-template marketplace (post counsel approval) (#100)"). 103 migrations totalling 13,043 SQL lines. Anvil is a Vercel + Supabase multi-tenant B2B SaaS where tenant isolation depends on a hybrid of (a) Postgres Row Level Security policies installed in migrations and (b) JavaScript-level `.eq("tenant_id", ctx.tenantId)` scoping inside every handler. The latter is the load-bearing wall; this report is mostly about what happens when one of those bricks is missing.

Scope tag legend: `[verified]` is observed directly in the source I read; `[inferred]` is reasoned from observed shape; `[speculative]` is judgement absent evidence. Every finding cites file paths and line ranges so the reader can replay.

## 0. Inventory and shape of the schema

`[verified]` 103 migration files, 13,043 SQL lines (`wc -l supabase/migrations/*.sql`). The schema declares **303 `create table` statements** (`grep -cE "^create table" supabase/migrations/*.sql`), enables RLS **253 times** (`grep -cE "enable row level security"`), and installs **284 policies** explicitly via `create policy` plus thousands more via `do $$ ... foreach ... execute format(...)` macros that the static count misses.

`[verified]` Two RLS dialects coexist in the same database:

1. The **`current_tenant_ids()` function** pattern, defined at `supabase/migrations/001_init.sql:40-43`:
   ```sql
   create or replace function current_tenant_ids() returns setof uuid
   language sql stable as $$
     select tenant_id from tenant_members where user_id = auth.uid()
   $$;
   ```
   Used in 10 migration files (001, 002, 003, 005, 006, 008, 009, 058, 073, 074).

2. The **`current_setting('request.jwt.claims', true)::json->>'tenant_id'` JWT-claim** pattern, first appearing at `supabase/migrations/011_agent_goals.sql` and `013_stripe.sql:38`. Used in 63 of the 103 migration files. Every connector migration (014-052), every ERP retry queue, every BRSR/AA/TReDS table, the entire template marketplace, the BRSR value-chain pack, and the conformal-prediction tables all use this pattern.

`[verified]` These two patterns are not equivalent. `auth.uid()` reads from the JWT's `sub` claim, which Supabase always populates for an authenticated request. `current_setting('request.jwt.claims', true)::json->>'tenant_id'` reads a custom `tenant_id` claim that **no code path in Anvil ever sets** (grepping for `app_metadata`, `setSession`, `updateUserById.*tenant`, `setClaim` returns no writes of `tenant_id` into the user's JWT). The JWT-claim policies therefore evaluate `null::uuid` for every direct PostgREST call from a user JWT, which short-circuits the `tenant_id = …` predicate to `false`. **Net effect: the 63 migrations using the JWT-claim pattern install RLS policies that deny every user-JWT read and write.** They appear to "work" because the application never uses PostgREST directly: every business query runs as the service role from a Vercel function, and the service role bypasses RLS.

`[verified]` The two patterns also differ in what they protect. `current_tenant_ids()` is a `stable` SQL function; without `security definer`, it runs as the caller and needs the caller to have SELECT on `tenant_members`. Migration 060 added a SECURITY DEFINER variant for the membership-claim RPC (`claim_tenant_membership`) but did NOT promote `current_tenant_ids()` to security definer. If a future migration tightens `tenant_members` RLS so a member can't see their own row (unlikely but possible), every policy that depends on `current_tenant_ids()` silently fails closed.

`[verified]` Tenant-onboarding atomicity is handled by a security-definer RPC `claim_tenant_membership` (`supabase/migrations/059_security_hardening.sql:138-211`, hardened in 060). The function takes a per-tenant advisory lock keyed by `md5(p_tenant_id)::bit(64)::bigint`, counts members, and only allows the first to claim `admin`. Migration 060 revokes EXECUTE from PUBLIC/anon/authenticated and grants only to service_role, plus pins `search_path = public, pg_temp`. **This is correctly designed; the rest of the codebase should follow this pattern for any future SECURITY DEFINER RPC.**

`[verified]` Service-role usage density: `grep -rln "serviceClient()" src/api/` returns **359 files**. `grep -rE '\.eq\("tenant_id"' src/api/ | wc -l` returns **889 occurrences** across **299 files** (3.0 per file on average). Some files scope tenant_id more than once because they query multiple tables. **Tenant scoping is per-query and per-handler — every new endpoint must remember to call `.eq("tenant_id", ctx.tenantId)` on every table touched, or the query returns or writes cross-tenant data.**

`[verified]` The actual auth gate (`src/api/_lib/auth.js`) was hardened in May 2026:
- `ALLOW_ANONYMOUS_TENANT` now defaults to `"false"` (line 14).
- The module **refuses to load** when `NODE_ENV=production` and the flag is on (line 16-23): `throw new Error("ALLOW_ANONYMOUS_TENANT=true is forbidden in production")`.
- Anonymous callers are capped at read (line 117-122) regardless of role.
- A tenant header mismatch returns 403, not 200 (line 90-94).

This is correct. The brief's premise that anonymous-tenant default was wide open no longer holds; that exact bug was fixed in audit C1.

## 1. RLS dialect drift inventory

`[verified]` Of the 103 migrations:
- **10** use `current_tenant_ids()` (001, 002, 003, 005, 006, 008, 009, 058, 073, 074).
- **63** use `current_setting('request.jwt.claims', true)::json->>'tenant_id'` (011, 012, 013, 014, 015, 016, 017, 018, 019, 020, 021, 022, 023, 024, 025, 026, 027, 028, 029, 030, 031, 032, 033, 034, 035, 036, 037, 038, 039, 040, 041, 042, 043 [partial], 044, 045, 046, 047, 048, 049, 050, 051, 052, 053, 054, 055, 056, 057, 058 [partial], 059 [partial], 060 [partial], 061-103 except where seed-only).
- The remaining 30 are seed-only or RLS-disabled (e.g., `audit_failures`, `cron_health`, `india_emission_factors`, `password_reset_attempts`, `mfa_attempts`, `magic_link_attempts`, `totp_used_counters`).

`[verified]` 0 policies use Postgres `AS RESTRICTIVE` (`grep -nE "as restrictive" supabase/migrations/*.sql | wc -l` returns 0; the one hit is a comment in 095). All policies are PERMISSIVE, meaning they OR together. A single permissive policy that returns true is enough to grant access. Reference: https://www.postgresql.org/docs/current/sql-createpolicy.html notes "a record is only accessible if at least one PERMISSIVE policy passes AND all RESTRICTIVE policies pass". Without restrictive policies, defense-in-depth requires the application to never accidentally install a permissive policy with an `OR true` branch — which the next finding shows is exactly the failure mode.

## 2. Inventory: every `tenant_id is null OR …` policy across 103 migrations

`[verified]` `grep -nE "tenant_id is null" supabase/migrations/*.sql | wc -l` returns **48 occurrences** across **23 SELECT policies and 8 ALL/WRITE policies**. Intent and risk vary; here is the canonical inventory.

### 2.1 SELECT policies with `tenant_id is null OR …` (28 instances)

| Table | Migration : line | Has nullable `tenant_id`? | Global rows seeded? | Verdict |
|-------|------------------|----------------------------|----------------------|---------|
| `holiday_calendar` | 003:232 | yes (`tenant_id uuid references tenants(id)`, no `not null`) | seeded by 004 with `tenant_id null` | intentional, correct |
| `auth_magic_links` | 003:241 | yes (`tenant_id uuid references tenants(id) on delete set null`) | every row written with `tenant_id null` by `api/auth/magic_link.js:36-42` | **accidental PII leak** |
| `redaction_rules` | 005:263 | yes (003:173) | seeded with global redaction regexes (e.g. national-id patterns) | intentional |
| `customer_locations` | 006:663 | NO (006:444 has `tenant_id uuid not null`) | none | inert (cannot match) but wasted planning |
| `item_master` | 006:672 | NO (006:482) | none | inert |
| `contracts` | 006:681 | NO (006:512) | none | inert |
| `contract_lines` | 006:690 | NO (006:531) | none | inert |
| `leads` | 006:699 | NO (006:213) | none | inert |
| `opportunities` | 006:708 | NO (006:230) | none | inert |
| `internal_sales_orders` | 006:717 | NO (006:261) | none | inert |
| `internal_so_lines` | 006:726 | NO (006:293) | none | inert |
| `equipment_hierarchy` | 006:735 | NO (006:336) | none | inert |
| `equipment_installed_parts` | 006:744 | NO (006:371) | none | inert |
| `shipments` | 006:753 | NO (006:392) | none | inert |
| `projects` | 006:762 | NO (006:417) | none | inert |
| `project_phase_log` | 006:771 | NO | none | inert |
| `service_visits` | 006:780 | NO (006:551) | none | inert |
| `car_reports` | 006:789 | NO (006:569) | none | inert |
| `closure_reports` | 006:798 | NO | none | inert |
| `order_schedule_lines` | 006:807 | NO (006:590) | none | inert |
| `quote_approval_thresholds` | 006:816 | NO (006:612) | none | inert |
| `quote_approvals` | 006:825 | NO (006:624) | none | inert |
| `lost_reason_taxonomy` | 006:834 | yes (006:642) | seeded by 006:845 with global taxonomy rows (`PRICE_HIGH`, `LEAD_TIME`, etc.) | intentional, correct |
| `engineering_specs` | 009:224 | yes (009:125) | global codes intended; depends on seeding (read-only intent) | intentional |
| `payment_milestones` | 009:233 | NO (`tenant_id uuid not null`) | none | inert |
| `expense_rate_cards` | 009:242 | NO | none | inert |
| `inco_terms_taxonomy` | 009:251 | yes (009:161) | global incoterms seeded by 009:289 | intentional |
| `blanket_release_drawdown` | 009:260 | NO | none | inert |
| `logistics_ports` | 009:269 | yes (009:172) | global IN ports + intl ports seeded | intentional |
| `logistics_carriers` | 009:278 | yes | global carriers seeded | intentional |
| `prospecting_suppressions` | 057:84 (in the `for select using (...)` clause) | yes (057:69) | global suppression list expected (industry-wide blocklist) | intentional, correct |
| `voice_dnd_list` | 080:152 | yes (080:125) | global DNCR (Do Not Call Registry) rows seeded | intentional |

### 2.2 WRITE policies with `tenant_id is null OR …` in `WITH CHECK` (8 instances)

These are the **dangerous** ones. The pattern lets any tenant member insert or update a row with `tenant_id = null`, which then becomes globally visible via the matching SELECT policy.

| Table | Migration : line | Severity |
|-------|------------------|----------|
| `redaction_rules` | 008:176 (`for all ... with check (tenant_id is null or …)`) | **High** — a tenant member can install a global PII-redaction regex that silently affects every tenant's OCR redaction. A poorly-crafted regex (e.g. `.*` for `panNumber`) would null out a target field across the entire fleet. |
| `engineering_specs` | 009:227 | **Medium** — engineering specs reference part numbers; cross-tenant pollution lets one tenant define a global spec for a part another tenant uses. |
| `payment_milestones` | 009:236 | **Medium** — payment milestone templates. A cross-tenant rule that says "advance = 0%" would corrupt billing if anyone reads from globals. |
| `expense_rate_cards` | 009:245 | **Medium** — global rate cards override per-tenant rate cards when the reader does `coalesce(tenant, global)`. |
| `inco_terms_taxonomy` | 009:254 | **Low** — pure taxonomy; bad data just shows wrong incoterm names. |
| `blanket_release_drawdown` | 009:263 | **Low** — operationally tenant-scoped data; the `tenant_id is null` write path is unreachable in practice because the column is `not null`, but the policy is still wrong shape. |
| `logistics_ports` | 009:272 | **Low** — port codes are public information; minimal blast radius. |
| `logistics_carriers` | 009:281 | **Low** — carrier names; minimal blast radius. |

`[verified]` Migration **059** (`security_followup.sql:227-236`) **fixed exactly this pattern for `prospecting_suppressions`** with the comment "Migration 057 lets a tenant member upsert a row with NULL tenant_id ... policy_select OR'ed in a NULL clause ... writes are strictly tenant-scoped" (line 219-222). The fix shape is:
```sql
create policy prospecting_suppressions_modify on prospecting_suppressions
  for all using (
    tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  ) with check (
    tenant_id is not null
    and tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
```

The same fix needs to be applied to the eight tables above. None of them have shipped a corresponding hardening migration on main.

## 3. Finding F5.1 — `auth_magic_links` cross-tenant PII leak (Critical)

`[verified]` `auth_magic_links` (`003:180-188`) has `tenant_id uuid references tenants(id) on delete set null` — nullable. The SELECT policy at 003:241 is:
```sql
create policy magic_links_select on auth_magic_links for select
  using (tenant_id is null or tenant_id in (select current_tenant_ids()));
```

`[verified]` `src/api/auth/magic_link.js:36-42` always inserts rows with `tenant_id` **unset** (only `email`, `outcome`, `ip`, `user_agent` are written). The default column value is null. So **every magic-link audit row carries `tenant_id = null`** and the SELECT policy treats every such row as world-readable to authenticated members.

`[verified]` `recordMagicLink` writes a row for every magic-link request: `sent`, `failed`, and `throttled` outcomes. So the table accumulates the email address, IP, user-agent of every sign-in attempt across every tenant. A user in tenant A who hits `GET /rest/v1/auth_magic_links` via PostgREST with their bearer token will see tenant B's customers, OBARA's CEO, the CFO, every operator, every test account.

`[verified]` Realistic exploit: `curl -H "Authorization: Bearer <tenant-A-jwt>" "$SUPABASE_URL/rest/v1/auth_magic_links?select=*&order=requested_at.desc&limit=1000"` returns the most recent 1000 magic-link attempts, regardless of which tenant they originated in. Email addresses for users at competing tenants leak. IPs leak. User-agent strings leak.

`[inferred]` Reachability depends on whether PostgREST is exposed to the browser. Anvil's frontend (`src/v3-app`) uses the Supabase JS client, which talks to PostgREST directly. So this is reachable from the browser console of any authenticated user.

### Fix

Migration `104_magic_link_tenant_scope.sql` (proposed):
```sql
-- 1. Backfill tenant_id from the user matching the email, where possible.
update auth_magic_links m
   set tenant_id = sub.tenant_id
  from (
    select lower(u.email) as email, tm.tenant_id
      from auth.users u
      join tenant_members tm on tm.user_id = u.id
  ) sub
 where m.tenant_id is null
   and lower(m.email) = sub.email;

-- 2. Tighten the SELECT policy so null-tenant rows are invisible to RLS.
drop policy if exists magic_links_select on auth_magic_links;
create policy magic_links_select on auth_magic_links for select
  using (tenant_id in (select current_tenant_ids()));

-- 3. Tighten the writer in src/api/auth/magic_link.js to resolve
-- tenant from email before inserting. Rows that fail to resolve a
-- tenant get a NULL tenant_id but become invisible to RLS; the
-- service-role abuse-review path still sees them.
```

API patch (`src/api/auth/magic_link.js:34-42`):
```js
const recordMagicLink = async (svc, email, outcome, ip, ua) => {
  let tenantId = null;
  try {
    const { data: user } = await svc.auth.admin.getUserByEmail
      ? await svc.auth.admin.getUserByEmail(email)
      : { data: null };
    if (user?.id) {
      const { data: m } = await svc
        .from("tenant_members")
        .select("tenant_id").eq("user_id", user.id).limit(1).maybeSingle();
      tenantId = m?.tenant_id || null;
    }
  } catch (_) { /* best-effort */ }
  try {
    await svc.from("auth_magic_links").insert({
      email: String(email || "").toLowerCase(),
      tenant_id: tenantId,
      outcome, ip: ip || null, user_agent: ua || null,
    });
  } catch (_) {}
};
```

Test plan: as tenant A, request a magic link for `attacker@victim.com`; from tenant B's session, query `auth_magic_links`. Today: row returns. After fix: no rows.

Rollback: drop the policy, recreate with the `or tenant_id is null` clause. Backfill is reversible by setting `tenant_id = null where tenant_id = <backfilled>`.

`[speculative]` Migration time: 2 engineer-hours including the backfill query on a 10k-row table.

## 4. Finding F5.2 — RLS dialect drift makes most policies dead-on-arrival (Critical)

`[verified]` 63 of 103 migrations write policies of the form:
```sql
for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
```

The expression `current_setting('request.jwt.claims', true)::json->>'tenant_id'` returns the value of a custom `tenant_id` claim in the JWT. Supabase populates the JWT with `sub` (user id), `email`, `role` (auth role like `authenticated`), `app_metadata`, `user_metadata`, `iat`, `exp`, etc. — but **Anvil does not configure the Supabase auth hook that would add a custom `tenant_id` claim**.

`[verified]` Searching the entire repo for the writer:
```
grep -rnE "app_metadata.*tenant_id|user_metadata.*tenant_id|setClaim|claim.*tenant_id" src/ — no hits.
grep -rnE "tenant_id" src/api/auth/ — only headers, not JWT claims.
```

`[verified]` Supabase's RLS docs (https://supabase.com/docs/guides/database/postgres/row-level-security) note "`auth.jwt()` … remember a JWT is not always 'fresh' until refreshed". The recommended pattern for storing tenant data is `raw_app_meta_data` populated via a `before_user_signed_in` hook (https://supabase.com/docs/guides/auth/auth-hooks). Anvil installs no such hook.

`[inferred]` What actually happens in production:
1. User signs in via magic-link, password, passkey, or TOTP.
2. Frontend gets a JWT with no `tenant_id` claim.
3. Frontend never queries PostgREST directly for tenant-scoped data; it calls Anvil's Vercel functions.
4. The Vercel function uses `serviceClient()` (service role, bypasses RLS).
5. Tenant scoping happens via `.eq("tenant_id", ctx.tenantId)` in JavaScript.

So the 63 migrations' RLS policies install a tenant-scoping rule that **always evaluates to `null::uuid = tenant_id`, which is `false`**. Direct PostgREST calls from the browser (the only path that would exercise RLS) **return zero rows** from any of these tables. The application can't tell because the application never uses that path. **The RLS layer for these 63 migrations is decorative.**

`[verified]` Migration 058 (`audit_events_append_only.sql`) documents the assumption explicitly at lines 36-43: "INSERT policy is intentionally absent. The backend writes audit rows via the service-role client … which bypasses RLS. End-user JWTs cannot insert directly through PostgREST." Good. But that comment is the only place this design choice is documented; the other 62 JWT-claim policies have no such comment and the next maintainer will treat them as real defenses.

### Risk

`[inferred]` There are three failure modes:
1. **A future endpoint forgets `.eq("tenant_id", …)`.** RLS doesn't catch it because the service role bypasses RLS. Cross-tenant data leaks. This is the actual blast radius.
2. **PostgREST gets re-enabled.** Today's RLS doesn't actually protect anything, so anyone who finds a way to call PostgREST as `authenticated` would still see zero rows from these tables (the policy is too strict for the JWT shape). But if a future engineer fixes the JWT claim to populate `tenant_id`, the policies *suddenly* start working — and may surface latent bugs (e.g., handlers that pass an attacker-controlled `x-obara-tenant` header).
3. **The two dialects fight each other.** Tables created in 001-009 use `current_tenant_ids()`. Tables created in 011+ use JWT-claim. A query that joins `orders` (current_tenant_ids) with `invoices` (jwt-claim) under a user JWT today returns `orders` filtered by membership AND zero `invoices` rows. The application doesn't notice because it queries through the service role.

### Recommendation

`[inferred]` Pick one dialect. Either:
- Add a Supabase auth hook that writes `tenant_id` into `raw_app_meta_data` on sign-in (Supabase docs at https://supabase.com/docs/guides/auth/auth-hooks#hook-custom-access-token) and migrate the 10 `current_tenant_ids()` migrations to JWT-claim. Pro: matches Supabase's recommended pattern. Con: JWT freshness — a tenant-membership change requires a token refresh.
- Or keep `current_tenant_ids()` and migrate the 63 JWT-claim policies to it. Pro: always reflects current `tenant_members` state. Con: every RLS check joins `tenant_members`, which is slower at scale (Supabase's own perf guide at https://supabase.com/docs/guides/database/postgres/row-level-security#performance benchmarks this at 9,000ms vs. 20ms when minimized).

Either is correct; both wrong is the current state.

### Mitigation plan

1. **Decide the dialect** in an architecture decision record.
2. **Write `104_unify_rls_dialect.sql`** that drops and recreates every policy with the chosen pattern. Use `do $$ ... foreach ...` to keep it idempotent. ~500 lines.
3. **Add a CI test** (`src/scripts/audit-rls-dialect.mjs`) that scans migrations and fails the build if a new migration adds a policy that doesn't use the canonical pattern.
4. **Document the choice** in `docs/SECURITY.md` (currently absent).

`[speculative]` 3-5 engineer-days, dominated by review of policy semantics on every table.

## 5. Finding F5.3 — Eight tables let any tenant write `tenant_id = null` global rows (High)

`[verified]` Eight WRITE policies use `with check (tenant_id is null or tenant_id in (select current_tenant_ids()))` — meaning the `is null` branch of the OR clause **lets the write succeed for a NULL tenant_id**:

1. `redaction_rules` (`008:176`) — a tenant member can install a global PII redaction regex.
2. `engineering_specs` (`009:227`) — a tenant member can publish a global engineering spec.
3. `payment_milestones` (`009:236`) — global payment milestone templates.
4. `expense_rate_cards` (`009:245`) — global rate cards.
5. `inco_terms_taxonomy` (`009:254`) — global incoterm definitions.
6. `blanket_release_drawdown` (`009:263`) — global blanket-release rules.
7. `logistics_ports` (`009:272`) — global port codes.
8. `logistics_carriers` (`009:281`) — global carrier names.

### Exploitability

`[inferred]` Because all 8 policies are installed under the `current_tenant_ids()` dialect, RLS does not actually evaluate them on user JWTs (the JWT-claim dialect would dead-on-arrival; the `current_tenant_ids()` dialect *would* let them through IF a user JWT path existed). The application talks to these tables exclusively via service role, so the RLS bug is latent today.

But: the moment a future migration switches one of these tables to user-JWT access (e.g., to expose `redaction_rules` to a tenant admin's UI), the policy lets tenant A install a global rule that affects tenant B. The most dangerous of the eight is `redaction_rules` — the field is consumed by the OCR redactor (`src/api/_lib/redactor.js` at `redactWithRules`). A malicious rule like `{"pattern":".*", "replacement":"REDACTED"}` would erase every extracted field across the fleet.

### Fix

Same shape as 059's fix for `prospecting_suppressions`. Per-table:
```sql
drop policy if exists engineering_specs_write on engineering_specs;
create policy engineering_specs_write on engineering_specs for all
  using (tenant_id in (select current_tenant_ids()))
  with check (tenant_id is not null and tenant_id in (select current_tenant_ids()));
```

`[speculative]` 1 engineer-day for the migration plus per-table regression tests.

### Defensive layer

`[inferred]` Add a `RESTRICTIVE` policy bundle that applies a `tenant_id is not null OR auth.role() = 'service_role'` guard across all tenant tables. PostgreSQL's CREATE POLICY docs at https://www.postgresql.org/docs/current/sql-createpolicy.html confirm restrictive policies AND together with permissive ones, so a single restrictive policy `tenant_write_not_null AS RESTRICTIVE for insert,update using (tenant_id is not null)` would block every accidental null-tenant write project-wide. This is belt-and-braces against future migrations that re-introduce the `is null` write pattern.

## 6. Finding F5.4 — 359 handlers run as service role; tenant scoping is a JavaScript invariant (Critical)

`[verified]` `grep -rln "serviceClient()" src/api/` returns **359 files**. `grep -rln "userClient" src/api/` returns 6 files (`_lib/auth.js`, `_lib/supabase.js`, `auth/verify.js`, `auth/password_login.js`, `auth/mfa.js`, `auth/profile.js`). **userClient is used only to validate a JWT via `auth.getUser()`; no business query runs under a user JWT.**

`[verified]` Every endpoint follows the pattern:
```js
const ctx = await resolveContext(req);
const svc = serviceClient();
const { data } = await svc.from("orders").select("*").eq("tenant_id", ctx.tenantId);
```

If a handler omits `.eq("tenant_id", ctx.tenantId)`, the query returns or writes rows across every tenant. Supabase's docs at https://supabase.com/docs/guides/database/postgres/row-level-security confirm: "Service keys … bypass RLS protections. They should never be used in the browser." Anvil uses them in 359 server-side handlers; safe in principle, fragile in practice.

`[verified]` Sample audit of handlers (random selection):
- `src/api/orders/index.js:56`: `svc.from("orders").select("*").eq("tenant_id", ctx.tenantId)`. Scoped.
- `src/api/orders/index.js:68`: `svc.from("orders").insert(orderRow(ctx, body))`. `orderRow` sets `tenant_id: ctx.tenantId` at line 11. Scoped.
- `src/api/tally/push.js:78`: `svc.from("orders").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.orderId)`. Scoped.
- `src/api/tally/push.js:105`: `svc.from("tally_voucher_records").select("*").eq("tenant_id", ctx.tenantId)`. Scoped.
- `src/api/tally/push.js:144`: `svc.from("orders").update({...}).eq("tenant_id", ctx.tenantId).eq("id", order.id)`. Scoped.
- `src/api/customers/index.js:74`: `svc.from("customers").select("*").eq("tenant_id", ctx.tenantId)`. Scoped.
- `src/api/audit/index.js:15`: `svc.from("audit_events").select("*").eq("tenant_id", ctx.tenantId)`. Scoped.
- `src/api/admin/members.js:23`: `svc.from("tenant_members").select(...).eq("tenant_id", ctx.tenantId)`. Scoped.

`[inferred]` So the sample scopes correctly. But 359 handlers and 889 scoping calls leave plenty of room for one to be missing. The hardest case to catch on review is a `.update(...)` without `.eq("tenant_id", ...)` because the row's existing `tenant_id` value doesn't get changed; the update silently writes to a foreign tenant if the row id is guessable.

### Mitigation

`[inferred]` Three layers:
1. **A linter rule** in `src/scripts/audit-write-paths.mjs` (which exists for related purposes) that flags any `svc.from(...)` call missing `.eq("tenant_id", ...)`. ESLint custom rule or a static-analysis pass over the AST. The existing scripts in `src/scripts/audit-*.mjs` already do similar audits.
2. **A wrapper** `tenantScoped(svc, table, ctx)` that returns a builder pre-filtered by tenant. E.g.:
   ```js
   export const tenantScoped = (svc, table, ctx) => {
     const q = svc.from(table);
     const orig = q.then?.bind(q);
     return new Proxy(q, {
       get(t, p) {
         if (p === 'select' || p === 'update' || p === 'delete') {
           return (...args) => t[p](...args).eq("tenant_id", ctx.tenantId);
         }
         return t[p];
       }
     });
   };
   ```
   Migrate every handler to use this wrapper.
3. **A Postgres backstop**: a SECURITY DEFINER function `assert_tenant_scope(tenant_id uuid)` that raises if the current role is service_role and `tenant_id` is null. Hard to wire into every query without an ORM, but a column-level CHECK that `tenant_id IS NOT NULL` is half the battle (most tables already have this).

`[speculative]` Migration time: 1-2 engineer-weeks. The scripts already exist; the lint rule + tenant-scoped wrapper would be a focused PR.

## 7. Finding F5.5 — Audit events are append-only at the database, not tamper-evident (High)

`[verified]` Migration 058 (`audit_events_append_only.sql`) drops every UPDATE and DELETE policy on `audit_events` and installs only a SELECT policy. The migration's own comment at lines 1-23 documents the prior state: "a tenant admin (and any tenant member) could DELETE audit_events rows through PostgREST, breaking the SOC 2 CC7.2 / CC7.3 control evidence chain." Fixed.

`[verified]` `audit_events.payload_hash` is a `text` column populated by application code. Looking at every writer (`src/api/_lib/audit.js:69`):
```js
payload_hash: payload.payloadHash || null,
```
Callers pass an order-specific hash, e.g. `src/api/tally/push.js:154` passes `payloadHash: expected` where `expected` is the order's approval-bound hash. **There is no `prev_hash` column, no chain hash, no HMAC.** `grep -nE "prev_hash|chain_hash|chain_seq" supabase/migrations/*.sql` returns zero hits.

`[verified]` However, audit chain **at export time** does exist. `src/api/audit/export.js` is a SOC 2 evidence endpoint that streams audit rows as ndjson and computes an HMAC over the concatenated row payload (lines 68-87). The HMAC key is `process.env.AUDIT_EXPORT_HMAC_SECRET`. The endpoint refuses to operate if the env var is missing (lines 39-44). The export run is itself logged into `audit_export_runs` (lines 92-100).

`[inferred]` This is a real-world compromise: the database is append-only via 058, but rows themselves are not chained. An attacker who compromises the service role (or the DB owner) can:
1. **Delete rows**: blocked by 058 because there's no `for delete` policy and service-role inserts but cannot delete through RLS-bypassing inserts that take effect *post*-2058.
   - Wait — service role bypasses RLS. So service role CAN delete. Let me check: yes, the service role bypasses RLS unconditionally. So 058's append-only protection only blocks PostgREST callers under user JWT, who couldn't insert in the first place. **Service role can still delete `audit_events` rows.** The protection is real only against PostgREST callers.
2. **Modify rows**: same as delete; service role can update.
3. **Insert backdated rows**: trivial; insert with `created_at` in the past.

So the actual security boundary is: anyone with the service role key (which lives in Vercel env, surfaced as `SUPABASE_SERVICE_ROLE_KEY`) can rewrite or fabricate audit events. The HMAC at export time signs only what gets exported, not what's in the database.

`[verified]` Migration 063 introduces `audit_failures` (no RLS, no tenant scope explicitly enforced) as a sentinel table for when audit_events inserts fail. `src/api/_lib/audit.js:53-87` calls `recordSentinel` when the `audit_events.insert` fails, capturing tenant, action, object, error code. This is a thoughtful defense against silent audit loss.

### Recommendations

`[inferred]` Three honest paths, in order of cost/coverage:

(a) **Document the boundary.** Rename `payload_hash` to `subject_payload_hash` and add a comment in `_lib/audit.js`. Cheapest; admits the table is "audit log, trustworthy as far as the service role is trustworthy". 

(b) **HMAC-chained rows at write time.** Add `prev_hash text`, `chain_hash text`, `chain_seq bigint` columns. On insert, compute `chain_hash = hmac_sha256(secret, prev_hash || canonical_row_json)`. A trigger guards this. A verifier endpoint (`GET /api/audit/verify?tenant_id=…`) reads in order and recomputes. Tradeoff: trigger writes lock the chain head row, serializing inserts per-tenant. At Anvil's volume (a few hundred audits/tenant/day) this is fine; at 1M/tenant/day it's not. Reference for the pattern: Cloudflare's audit logs (https://blog.cloudflare.com/introducing-audit-logs/) chains via a separate signed-blob service; per-row HMAC in Postgres is a different design point.

(c) **External append-only sink.** Mirror writes to a separate WORM (Write Once Read Many) store: S3 with Object Lock, Datadog Audit Logs, AWS QLDB, or Vanta's append-only ledger. The Postgres row stays for query convenience; the WORM copy is the SOC 2 evidence.

`[inferred]` Anvil should pick (a)+(c): keep the Postgres copy as-is for queryability, mirror to S3 Object Lock for tamper-evidence. (b) adds complexity that few teams maintain correctly. Cite: https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html.

### Migration plan for option (c)

1. Provision an S3 bucket with Object Lock in compliance mode and a default 7-year retention.
2. Add a cron `/api/cron/audit_export_s3` that runs hourly, exports new `audit_events` rows since the last export pointer to ndjson with HMAC trailer (the same shape as `/api/audit/export`), and PUTs to the bucket.
3. Record the export pointer in `audit_export_pointers (tenant_id, last_exported_id bigint)`.
4. Add a verifier that reads from S3 and compares against the Postgres rows to detect post-export tampering.

`[speculative]` 1-2 engineer-weeks. The export endpoint already exists; the S3 part is config plus cron.

## 8. Finding F5.6 — Audit failures table has no RLS or tenant scoping (Medium)

`[verified]` `audit_failures` is created in 063 without `enable row level security`. The table holds `tenant_id`, `attempted_action`, `attempted_object_type`, `attempted_object_id`, `error_message`, `error_code`, `raw_payload`. The comment says "monitored by on-call; a non-zero count over the last hour is a P0 alert."

`[verified]` Insert path is `src/api/_lib/audit.js:26-51` (`recordSentinel`). It writes `tenant_id` from the original payload but no RLS prevents another tenant from reading.

`[inferred]` Reachability: the table doesn't have RLS enabled, so PostgREST exposes it to any authenticated user (Supabase's default is "RLS off → fully readable"). A user in tenant A who hits `/rest/v1/audit_failures` reads every audit failure across every tenant — including the `raw_payload` jsonb, which contains action details, object IDs, sometimes after-payloads.

### Fix

Migration `105_audit_failures_rls.sql`:
```sql
alter table audit_failures enable row level security;
drop policy if exists audit_failures_admin_only on audit_failures;
create policy audit_failures_admin_only on audit_failures for select
  using (
    auth.role() = 'service_role'
    or (
      tenant_id in (select current_tenant_ids())
      and current_tenant_role(tenant_id) = 'admin'
    )
  );
-- No INSERT/UPDATE/DELETE policies. Service role writes; nothing else
-- ever modifies. PostgREST callers are read-only and admin-only.
```

`[speculative]` 15 minutes.

## 9. Finding F5.7 — `cron_health` and `india_emission_factors` have no RLS (Medium)

`[verified]` `cron_health` (066) has no `enable row level security`. Table holds `worker`, `last_run_at`, `last_status`, `consecutive_failures`, `metadata jsonb`. The metadata can contain per-tenant counts.

`[verified]` `india_emission_factors` (101) has no `enable row level security`. Pure reference data (CEA grid factor, DEFRA combustion factors); read-only in practice. Less sensitive but inconsistent.

`[verified]` `password_reset_attempts` (043:154) has `alter table … enable row level security` (line 161) but **no policies** are declared. Postgres semantics: if RLS is on and no policy matches, no rows are visible to non-superusers. So this table is *more* locked-down than the previous two, but the inconsistency is the worry: an engineer adding a policy without realizing the table was already locked might inadvertently open it.

### Fix

`[inferred]` Add an explicit "read-only by service role" policy to all three:
```sql
alter table cron_health enable row level security;
create policy cron_health_no_select on cron_health for select using (false);
-- india_emission_factors deliberately stays open: it's reference data
-- and the existing inserts already use on conflict do nothing.
alter table india_emission_factors enable row level security;
create policy india_emission_factors_authenticated_read on india_emission_factors
  for select using (auth.role() in ('authenticated','service_role'));
-- password_reset_attempts: already locked, just make the locking explicit.
drop policy if exists password_reset_attempts_no_select on password_reset_attempts;
create policy password_reset_attempts_no_select on password_reset_attempts for select using (false);
```

`[speculative]` 30 minutes including review.

## 10. Finding F5.8 — `tenant_settings` is the canonical config table; brief was wrong about its absence (Resolved/Informational)

`[verified]` Migration 013 creates `tenant_settings (tenant_id uuid primary key references tenants(id) on delete cascade, ...)`. The brief's premise that `tenant_settings` does not exist was wrong for the current main. Migrations 016, 029, 043, 053, 066, 075, 095, 100, 101, 102, 103 all `alter table tenant_settings add column …`. Today the table has columns for every connector (`stripe_*`, `razorpay_*`, `netsuite_*`, `tally_*`, `sap_*`, etc.), every feature flag (`brsr_enabled`, `inventory_conformal_enabled`, `template_marketplace_*`), every encrypted secret (`_enc bytea` columns), every threshold (`tally_recon_total_tolerance_pct`).

`[verified]` `grep -nE "add column" supabase/migrations/*.sql | grep tenant_settings | wc -l` returns **~110 column additions** across the migrations. The brief's "30+ columns" was actually a conservative undercount. The table is already at ~110 columns and growing.

### Risk

`[inferred]` This is the column-sprawl failure mode the brief warned about. Issues:
1. **Single row per tenant** means every update is a row write that touches every page of every column the row spans. With 110 columns, a single feature-flag flip locks the entire row for the update duration. For a small tenant table (100 tenants) this is fine; at 100k tenants it's a hot-table risk.
2. **Schema migrations on `tenant_settings` are O(rows × cols)** for any default-non-null column. Most additions are nullable or boolean default false, which Postgres makes fast since 11. Still, future feature flags should be checked against this.
3. **Discoverability**: 110 columns is hard for a new engineer to scan. The `add column` migrations are scattered across the timeline.

### Recommendations

`[inferred]` Three reasonable directions, in order of pain:

(a) **Live with it.** 110 columns is uncomfortable but not catastrophic at Anvil's scale. Add a `docs/SCHEMA_GLOSSARY.md` that lists every `tenant_settings` column with one-line meaning. Tag deprecated columns with `comment on column tenant_settings.foo is 'DEPRECATED: removed in v2'`.

(b) **Split by domain.** Move connector creds to `tenant_connector_settings` (one row per (tenant, connector)). Move feature flags to `tenant_feature_flags (tenant_id, flag_key, enabled, rollout_percent)`. Keep the small handful of true per-tenant config on `tenant_settings`. Reference: GitHub's flipper pattern (https://github.com/jnunemaker/flipper).

(c) **Normalize entirely.** Each setting becomes a row: `tenant_settings (tenant_id, key, value jsonb, set_at, set_by)`. Maximum flexibility, maximum query cost.

`[inferred]` (b) is the right answer. Anvil's column sprawl is dominated by connector secrets (which are naturally per-connector) and feature flags (which are naturally per-flag-per-tenant). The migration plan is mechanical: write a new `tenant_connector_settings` table, copy the existing `_enc`/`_iv` columns over per-row, drop the columns on `tenant_settings`, update the half-dozen `_lib/secrets.js` callers.

`[speculative]` 2-3 engineer-weeks for the full split, dominated by the connector code-path sweep.

## 11. Finding F5.9 — JSONB sprawl is real but indexed correctly (Resolved/Informational)

`[verified]` JSONB column count across the schema: `grep -E "jsonb" supabase/migrations/*.sql | wc -l` returns more than 200, including type declarations and policies. Filtering to actual column declarations is harder but the top concentrations are:
- `orders` (`001:144-153`): 10 JSONB columns (`result`, `preflight_payload`, `api_usage`, `cost_policy_snapshot`, `token_estimate`, `rule_findings`, `anomaly_flags`, `evidence_by_field`, `line_edits`, `approval`).
- `extraction_runs` (`029:30-33`): 4 JSONB columns (`adapter_attempts`, `raw_extract`, `normalized_extract`, `field_confidences`).
- Every connector retry queue has a `raw jsonb` column for the bridge payload.

`[verified]` 4 GIN indexes total (`grep -nE "using gin" supabase/migrations/*.sql`):
- `catalog_synonyms` lower(synonym) gin_trgm_ops (036:26)
- `item_master` lower(description) gin_trgm_ops (036:82)
- `item_master` lower(part_no) gin_trgm_ops (036:84)
- `customer_format_templates_global` fingerprint (103:103)

`[verified]` `pg_trgm` extension is enabled by 036 (`create extension if not exists pg_trgm`). HNSW vector indexes exist via pgvector for embeddings (`075:35` on `item_master`, `076:30` on `catalog_synonyms`).

`[inferred]` So Anvil's JSONB sprawl is **deliberate, not accidental** — most JSONB columns hold opaque payloads (extraction results, retry-queue raw bodies, evidence snapshots) that the application never queries inside; it reads them whole. The few JSONB columns that ARE queried (fingerprint matching for template marketplace, trigram on item descriptions) have appropriate GIN indexes.

### Risk

`[inferred]` The risk surface is:
1. **`orders.api_usage`**: if cost dashboards become a need, aggregating across `orders.api_usage->>'usd_cost'` requires a full-table scan within tenant. The fix is a generated column. Today this is not on a hot path.
2. **`orders.rule_findings`, `anomaly_flags`**: these are arrays. Searching for "orders that triggered the MISSING_PRICE rule" requires `rule_findings @> '[{"code":"MISSING_PRICE"}]'`, which needs GIN. Today the query doesn't exist; UX displays findings per-order, not cross-order.

### Recommendation

Don't preemptively add GIN. Wait for the first cross-order query and promote the field to a column or add a partial GIN at that point. The four existing GIN indexes are correctly placed.

## 12. Finding F5.10 — FK strategy: 389 cascades, 140 set-nulls, 0 restricts (Medium)

`[verified]` `grep -E "on delete" supabase/migrations/*.sql | wc -l` returns 529. Breakdown via awk:
- `on delete cascade`: 389
- `on delete set null`: 140
- `on delete restrict`: 0

`[inferred]` `cascade` is the right default for child rows owned by a parent (e.g., `order_documents.order_id` cascades from `orders.id`). `set null` is right when the link is informational and the child should outlive the parent (e.g., `evidence.document_id`). `restrict` would prevent deletion when children exist; useful for "you can't delete a customer while orders reference it" but not used anywhere.

`[verified]` Sample concerns:
- `orders.customer_id references customers(id) on delete set null` (001:137): deleting a customer leaves orphan orders. Probably correct for soft-delete; would cause silent breakage if billing rebuild relies on the link.
- `shipments.order_id references orders(id) on delete set null` (006): orphan shipment after order deletion. Almost certainly wrong; shipments without orders are a data integrity bug.
- `audit_events.source_evidence_ids uuid[]` (001:334): array of UUIDs, no FK. Dangling references silently accumulate.
- `customer_format_templates_global.publisher_tenant_id … on delete set null` (103:76): correct — anonymized templates survive publisher offboarding by design.

### Recommendation

`[inferred]` Two improvements:
1. **Audit every `on delete set null` to confirm intent.** A nightly cron `/api/cron/orphan_audit` that counts null-foreign-key children per relation and writes to `health_metrics`. Alert when growth exceeds a baseline. The cron infrastructure already exists (`cron_health` at 066) and the script pattern matches `src/scripts/audit-*.mjs`.
2. **Tighten 5-10 high-blast-radius FKs to `restrict`.** Candidates: `shipments.order_id`, `internal_so_lines.internal_sales_order_id`, `quote_approvals.order_id`, `tally_voucher_records.order_id`, `treds_discounts.offer_id`.

`[speculative]` 1-2 engineer-days for the cron, 1 week for the FK tightening + backfill of any existing orphans.

## 13. Finding F5.11 — Generated columns and soft-delete: present but uneven (Informational)

`[verified]` 5 generated columns exist:
- `audit_failures.id bigint generated always as identity` (063:21) — just an identity column.
- `procurement_plans.forecast_total numeric(14,4) generated always as (...) stored` (085:235)
- `procurement_plans.net_available_qty numeric(14,4) generated always as (...) stored` (085:276)
- `conformal_calibration_residuals.residual numeric(14,4) generated always as (actual_value - forecast_value) stored` (100:116)
- `value_chain_relationships.is_material boolean generated always as (coalesce(buyer_purchase_share_pct, 0) >= 2) stored` (101:164)

`[verified]` Soft-delete columns: `grep -nE "deleted_at" supabase/migrations/*.sql` returns **0 hits**. There is no soft-delete pattern in the schema. Deletes are hard. The audit chain captures `action = 'delete'` events but the row is gone.

### Risk

`[inferred]`:
1. **No soft-delete means no "restore mistake" capability.** A customer accidentally deleted by an admin can't be undone except by PITR (Supabase Pro PITR has RPO of 2 minutes; https://supabase.com/docs/guides/platform/backups confirms). For tenants in regulated industries (BRSR Core requires retention of disclosure submissions; DPDP Act 2023 requires accuracy maintenance), hard delete is a compliance hazard.
2. **DPDP Article 8 (right to correction and erasure)** requires the data fiduciary to honor erasure requests. Hard-delete actually helps here — but **proof** that erasure occurred requires an audit row, which Anvil has, but the row is in the same database that just got the deletion, with no external sink.

### Recommendation

`[inferred]` Add a `deleted_at timestamptz` column on the 5-6 highest-blast-radius tables: `customers`, `orders`, `invoices`, `documents`, `customer_contacts`. Update every RLS policy to also check `deleted_at is null` (where soft-delete is desired). For DPDP erasure, an explicit `/api/admin/erase` endpoint that hard-deletes plus records a tamper-evident audit row.

## 14. Finding F5.12 — Encryption-at-rest pattern is consistent for connector secrets (Resolved/Informational)

`[verified]` `grep -cE "_enc bytea" supabase/migrations/*.sql` returns **33** column counts across migrations. The shape is uniform:
```sql
add column if not exists <connector>_token_enc bytea,
add column if not exists <connector>_iv bytea,
```

`[verified]` Encryption helper is `src/api/_lib/secrets.js` (referenced by migration comments at 016:7-10 and 029:78-85). Pattern: AES-256-GCM with `ANVIL_SECRETS_KEY` env. Plaintext fallback when the key is missing, gated on dev-only. Some tables also have a legacy `bridge_token text` column from before the `_enc` migration; comment at 016:38 says "plaintext (deprecated; rotated into _enc)".

`[inferred]` Risk:
1. **Plaintext fallback is a footgun.** A production deployment that loses `ANVIL_SECRETS_KEY` (env var rotation gone wrong, secret manager outage) will write secrets in plaintext to `bridge_token`. The migration comment at 016:9-10 acknowledges this. Tracking which tenants have plaintext secrets requires a cross-table sweep.
2. **No key rotation tooling visible.** Rotating `ANVIL_SECRETS_KEY` requires re-encrypting every `_enc` column. `grep -rln "rotate.*key\|reEncrypt" src/api/` returns no hits. Reference: https://www.postgresql.org/docs/current/pgcrypto.html notes pgcrypto's `pgp_sym_encrypt`/`pgp_sym_decrypt` are alternatives, but Anvil's choice of app-side AES-GCM is reasonable.

### Recommendation

`[inferred]`:
1. **Add `/api/admin/secrets/audit`** that returns per-tenant counts of `(token_enc is not null, token is not null)` pairs and flags rows with plaintext secrets.
2. **Add `/api/admin/secrets/rotate`** that decrypts under the current key and re-encrypts under a new key, atomically per tenant.
3. **Remove the plaintext fallback in production**: error out if `ANVIL_SECRETS_KEY` is missing. The dev-only override (`NODE_ENV=development`) makes the dev path still work.

## 15. Finding F5.13 — Storage bucket RLS not tenant-scoped (High)

`[verified]` `001:480-484`:
```sql
create policy "obara documents read" on storage.objects
  for select using (bucket_id = 'obara-documents' and auth.role() = 'authenticated');
create policy "obara documents write" on storage.objects
  for insert with check (bucket_id = 'obara-documents' and auth.role() = 'authenticated');
```

Any authenticated user can read or write any object in `obara-documents` via direct PostgREST calls to `storage.objects`. No tenant filtering.

`[verified]` Application-layer compensation: `api/documents/upload.js:19` builds tenant-prefixed paths (`ctx.tenantId + "/" + Date.now() + "_" + filename`). Documents-read paths (`api/documents/[id].js`) read the documents row first and only sign URLs for the calling tenant's rows. But the storage policy itself is wide open.

`[inferred]` Exploit shape:
- Tenant A user discovers a tenant B document ID via a leaky endpoint, or guesses via UUIDv4 collision (negligible probability).
- More realistically: tenant A user enumerates `storage.objects` directly. PostgREST exposes `storage.objects` to any authenticated user with the current policy. They list filenames; the path includes UUIDs.
- Once they have the path, they request a signed URL via Supabase storage `getPublicUrl()` or directly download via `from('obara-documents').download(path)`.

### Fix

Migration `106_storage_tenant_scope.sql`:
```sql
drop policy if exists "obara documents read" on storage.objects;
drop policy if exists "obara documents write" on storage.objects;
create policy "obara documents read" on storage.objects
  for select using (
    bucket_id = 'obara-documents'
    and auth.role() = 'authenticated'
    and (
      auth.role() = 'service_role'
      or (split_part(name, '/', 1)::uuid) in (select current_tenant_ids())
    )
  );
create policy "obara documents write" on storage.objects
  for insert with check (
    bucket_id = 'obara-documents'
    and auth.role() = 'authenticated'
    and (
      auth.role() = 'service_role'
      or (split_part(name, '/', 1)::uuid) in (select current_tenant_ids())
    )
  );
```

The cast `split_part(name, '/', 1)::uuid` can fail for malformed paths. The fix: wrap in `case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' then split_part(...) else null end`.

`[inferred]` Better long-term: use Supabase's `storage.objects.metadata->>'tenant_id'` column populated at upload time (Supabase storage docs: https://supabase.com/docs/guides/storage/uploads/standard-uploads). Path parsing is fragile; explicit metadata is cleaner.

### Test plan

1. As tenant A user, request `GET /rest/v1/storage.objects?bucket_id=eq.obara-documents`. Today: returns every object. After fix: only own-tenant objects.
2. Attempt direct download of an object whose path starts with tenant B's UUID. Today: 200. After fix: 403.

`[speculative]` 1 engineer-day including migration tests on a staging Supabase project.

## 16. Finding F5.14 — Template marketplace global library is correctly designed but RLS exposes pre-approval rows to publisher (Medium)

`[verified]` `customer_format_templates_global` (103:67-98) is a global table with two SELECT policies:
```sql
create policy "cftg_select_approved" on customer_format_templates_global
  for select using (status = 'approved');
create policy "cftg_select_own_publications" on customer_format_templates_global
  for select using (
    publisher_tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
  );
```

`[verified]` This is the only place in the schema that uses a non-tenant primary RLS condition (`status = 'approved'`). The intent is that approved templates are world-visible (the point of a marketplace), and unapproved templates are visible only to their publisher.

`[inferred]` Risk:
1. The second policy relies on the JWT-claim dialect (`request.jwt.claims->>'tenant_id'`). As noted in §4, that claim is never set. So **`cftg_select_own_publications` always evaluates to false for user-JWT callers, and the publisher cannot see their own pending templates via PostgREST.**
2. The application reaches this table via service role, which bypasses RLS. So publishers see their own templates because the API queries through the service role and adds `.eq("publisher_tenant_id", ctx.tenantId)` in JavaScript.
3. The world-readable `status = 'approved'` policy is the riskier surface. Any authenticated user can list every approved template across the global library via direct PostgREST. That's intended — the marketplace is shared. But the policy lets them see `redaction_report jsonb`, `regex_safety_report jsonb`, `replay_verification jsonb`. These should NOT carry per-publisher identifiers. The migration comment at 103:74-75 says "Anchors are stored with `sample_value` REDACTED already at write time" — that's the right invariant. Verify.

### Verification needed

`[inferred]`:
- Read every writer of `customer_format_templates_global` to confirm `redaction_report` and `replay_verification` carry no raw sample values, no email addresses, no document fingerprints that would identify the publisher.
- Confirm `anonymise_publisher = true` is enforced at write time when the publisher requested anonymity. Today the column defaults to true (line 78), but there's no CHECK that `publisher_display` is null when `anonymise_publisher = true`.

### Fix

```sql
alter table customer_format_templates_global
  add constraint cftg_anonymise_consistent check (
    not anonymise_publisher or (publisher_tenant_id is null and publisher_display is null)
  );
```

`[speculative]` 30 minutes plus a code audit of the writer in `/api/marketplace/`.

## 17. Finding F5.15 — `extraction_cache` and `audit_events` retention: no purge cron (Low)

`[verified]` `extraction_cache (001:362)` has `expires_at timestamptz`. `grep -rln "extraction_cache.*delete\|expire" src/api/cron/` returns no hits. The table grows unbounded.

`[verified]` `audit_events` has no retention. SOC 2 control evidence typically requires 1 year retention for security logs. GDPR Article 5 (https://gdpr-info.eu/art-5-gdpr/) requires data to be kept "no longer than is necessary" — no specific timeline for audit logs. DPDP Act 2023 (https://www.meity.gov.in/writereaddata/files/Digital%20Personal%20Data%20Protection%20Act%202023.pdf) Section 8 obliges data fiduciaries to maintain accurate, up-to-date personal data. Neither sets a hard audit retention number; it's policy-driven.

`[verified]` `password_reset_attempts (043:154)`, `magic_link_attempts (059:50)`, `mfa_attempts (059:43)`, `totp_used_counters (059:17)` all grow unbounded. The TOTP table specifically: comment at 059:14-16 says "Old rows (>1 day) can be pruned by a periodic job; the unique constraint stays effective for the entire validity window of any code we'd accept." No cron exists.

### Fix

`[inferred]` Add `pg_cron` schedules (Supabase supports it; https://supabase.com/docs/guides/database/extensions/pg_cron):
```sql
select cron.schedule('extraction_cache_gc', '0 3 * * *',
  $$delete from extraction_cache where expires_at < now() - interval '7 days'$$);
select cron.schedule('totp_used_counters_gc', '0 4 * * *',
  $$delete from totp_used_counters where used_at < now() - interval '7 days'$$);
select cron.schedule('rate_limit_gc', '0 5 * * *',
  $$delete from mfa_attempts where attempted_at < now() - interval '7 days';
    delete from magic_link_attempts where attempted_at < now() - interval '7 days';
    delete from password_reset_attempts where last_request_at < now() - interval '7 days'$$);
```

For `audit_events`: don't auto-purge. SOC 2 / DPDP / GDPR all favor retention. Instead, build an archival pipeline to S3 with Object Lock (see §7).

`[speculative]` 1-2 engineer-days.

## 17b. Finding F5.16 — Identity-key drift: bigserial vs uuid creates joinability surprises (Low)

`[verified]` Two id strategies coexist:
- `audit_events.id bigserial primary key` (`001:324`) and `processing_events.id bigserial primary key` (`001:344`). Auto-incrementing 8-byte ints.
- Almost everywhere else: `id uuid primary key default uuid_generate_v4()`.

`[verified]` `grep -cE "id bigserial|id uuid primary key" supabase/migrations/*.sql` returns 297 occurrences across migrations. The majority are uuid.

`[inferred]` The bigserial on `audit_events` and `processing_events` is intentional: monotonic ids make "tail the latest events" cheap and let an external consumer recover from a checkpoint. But the mismatch becomes a footgun when a future feature wants to reference an audit row from another table — `references audit_events(id)` requires a `bigint` column, breaking the uniform `uuid` convention everywhere else. Worse, leaking sequence values gives away rate of writes (a famous information disclosure pattern). The right Postgres remedy is `generated always as identity` (which 063 already uses for `audit_failures.id`). That's the recommended modern idiom (https://www.postgresql.org/docs/current/sql-createtable.html); `bigserial` is the older `serial`-family shorthand. The schema should standardize.

`[inferred]` Risk:
1. **Sequence disclosure**: `audit_events.id` from a service-role export to an auditor reveals roughly how many events the tenant has generated. Switching to `bigint generated always as identity` doesn't fix this; it would only fix it by mixing in a random offset per tenant, which is over-engineering for the present concern.
2. **Schema heterogeneity**: a future engineer cannot safely write `references audit_events(id)` while assuming UUID everywhere. Add `comment on column audit_events.id is 'bigserial; deliberate. Use uuid columns for everything else.'`.

`[speculative]` Migration cost: zero today; document the intent. If a future audit-row-reference table appears, consider adding a `uuid` surrogate column on `audit_events` as well.

## 17c. Finding F5.17 — `tenant_settings` cross-migration evolution is undocumented (Medium)

`[verified]` Walking through every migration that touches `tenant_settings`:
- 013: created with 11 columns (Stripe Connect).
- 016: added Tally bridge fields.
- 020: added Razorpay fields.
- 029: added Document AI v2 provider config + `docai_prompt_overrides jsonb`.
- 043: nothing on tenant_settings; new tables for MFA.
- 053: SOC 2 control fields.
- 059: added `jde_session_ttl_sec` (line 246).
- 066: added Tally reconciliation tolerance + auto_fix toggle.
- 075-103: various feature flags (BRSR, conformal, AA, TReDS, template marketplace).

`[verified]` By 103 the table has ~110 columns. There is no `comment on table tenant_settings` or `docs/SCHEMA.md` enumerating the columns. Discoverability is poor.

`[verified]` Several columns are deprecated but not removed. Example: `bridge_token text` on `tally_companies (016:38)` is marked deprecated in comment but still exists. Similar pattern likely on `tenant_settings`. A discovery script: `psql -c "\d+ tenant_settings"` is the only authoritative listing.

### Recommendation

`[inferred]` Two complementary fixes:

(a) **A schema glossary auto-generated from comments.** Add `comment on column tenant_settings.<col> is '<meaning>'` for every column. Build a CI script that dumps the comments to `docs/TENANT_SETTINGS.md` automatically.

(b) **A migration-cadence retrospective.** Walk the 110-column history with the team and identify columns to deprecate or remove. The presence of `bridge_token text` (plaintext) next to `bridge_token_enc bytea` (encrypted) is the kind of legacy that needs explicit sunsetting.

`[speculative]` 1 engineer-day for (a); the deprecation pass is open-ended.

## 17d. Finding F5.18 — Multi-tenant query patterns: tenant-prefixed indexes are correct, but rarely tested (Medium)

`[verified]` 343 `create index` statements (`grep -cE "^create index" supabase/migrations/*.sql`). Sampled shape:
- `orders_tenant_status_idx on orders (tenant_id, status, created_at desc)` (`001:164`)
- `orders_po_number_idx on orders (tenant_id, lower(po_number))` (`001:165`)
- `customer_contacts_email_idx on customer_contacts (tenant_id, lower(email)) where email is not null` (`065:57`)
- `tally_voucher_records_drift_idx on tally_voucher_records (tenant_id, last_drift_at desc) where last_drift_at is not null` (`095:128`)
- `cftg_publisher_idx on customer_format_templates_global (publisher_tenant_id, status) where publisher_tenant_id is not null` (`103:104`)

Every business index leads with `tenant_id`. This matches Citus's recommendation for shared-schema multi-tenancy: every common query has a `tenant_id =` filter, and the index leads with that column for cache locality.

`[verified]` Partial indexes are used appropriately: `where last_drift_at is not null` keeps the drift index small. `where status = 'pending'` (`016:115`) keeps the retry-queue picker fast.

`[inferred]` Two improvements visible:
1. **`orders_po_number_idx` is btree on `(tenant_id, lower(po_number))`.** The application does `.ilike("po_number", "%" + query + "%")` (`orders/index.js:58`), which is a wildcard prefix. btree doesn't help; this becomes a tenant-scoped sequential scan. Add a trigram GIN: `create index orders_po_trgm on orders using gin (tenant_id, lower(po_number) gin_trgm_ops)`.
2. **No `EXPLAIN ANALYZE` baseline.** No script captures the plan + runtime for the top-10 hot queries. A simple `src/scripts/perf-baseline.mjs` that emits `EXPLAIN (ANALYZE, BUFFERS)` for the orders list, audit list, customer list, and the marketplace lookup would give regression detection. Plug into CI as a budget.

`[speculative]` 1 engineer-day for the trigram index plus the baseline script.

## 17e. Finding F5.19 — Cross-tenant FK references: BRSR value chain crosses the membrane intentionally (Medium)

`[verified]` `value_chain_relationships (101:158-175)` has two tenant references: `supplier_tenant_id uuid not null references tenants(id)` and `buyer_tenant_id uuid not null references tenants(id)`. This is the first place in the schema where one row references two different tenants. The SELECT policy (`101:187-191`) lets either tenant see their own rows.

`[verified]` `supplier_disclosures` has an additional SELECT policy `sd_buyer_read` (`101:209-218`) that uses an `exists` subquery on `value_chain_relationships` to grant a buyer-tenant access to a supplier-tenant's disclosure when consent is `accepted` and the relationship is `is_material`.

This is the **only place** in the entire schema that legitimately crosses tenant boundaries by design. It's a precedent for future cross-tenant data sharing (template marketplace consumer-side reads, supplier-buyer messaging, etc.).

`[inferred]` The design is correct, but the policy invariants are fragile:
1. **`consent_status` toggling.** A supplier who flips `consent_status = 'revoked'` after a buyer reads must trigger a downstream invalidation of any cached buyer-side data. Today the policy just returns no rows on the next query, but if the buyer cached the disclosure in their analytics tool, the revocation is unenforceable.
2. **`is_material` is a generated column** (`101:164` from `coalesce(buyer_purchase_share_pct, 0) >= 2`). Cool, but if a supplier mis-reports their purchase share (or gets it wrong on submission), the buyer's read access flickers on and off. The audit trail for "who saw what when" needs to capture the disclosure version, not just the row id. Today there's no `disclosure_snapshot_id` audit row.
3. **`vcr_supplier_modify` policy lets the supplier update `buyer_purchase_share_pct`** (101:198-203). A supplier could intentionally set it to 1.99% to drop below the materiality threshold and revoke buyer visibility without going through `consent_status`. Adversarial use case.

### Recommendations

`[inferred]`:
1. Add a `buyer_access_audit_events` table that captures every read of `supplier_disclosures` via the buyer policy, with disclosure version + buyer's user id + tenant. The existing `audit_events` could carry these, but a separate table makes the SOC 2 control evidence cleaner.
2. Add a check on `vcr_supplier_modify` that disallows changes to `buyer_purchase_share_pct` once `consent_status = 'accepted'` (or routes them through a re-attestation flow).
3. Document the consent revocation invalidation policy. Build a webhook to notify the buyer system on revocation.

`[speculative]` 2-3 engineer-days. Bet 7 is sandbox; production hardening can come later.

## 17f. Finding F5.20 — Migration timeline reveals shifting security posture; doc the lessons (Informational)

`[verified]` Reading migrations as a history:
- **001-009**: pre-audit. RLS with `current_tenant_ids()`. `audit_events` was mutable. `auth_magic_links` was tenant-less. `storage.objects` was tenant-blind.
- **011-057**: rapid feature build. New connectors per migration. Switched to JWT-claim RLS dialect at 011. Did not migrate older tables to the new dialect.
- **058**: P0 audit response — audit_events append-only.
- **059**: P0 audit response — TOTP replay, MFA/magic-link rate limits, search_path hardening, prospecting_suppressions write tightening, scan_status pipeline on documents.
- **060**: F1/F2 follow-up — revoke EXECUTE on claim_tenant_membership, search_path pin, caller-identity guard.
- **063**: audit-failure sentinel table (P1.7).
- **066**: cron_health for stale-cron detection (P5.1).
- **081**: deploy_events admin-only (the second prior fix shipped without the drop policy first).

`[inferred]` Lessons embedded in the audit-driven migrations are mostly good. Things that should be promoted out of the comments and into a real document:

1. **All audit-response migrations should reference the audit doc + finding id** (the current convention is `P0/P1/P5.1` style; canonicalize and link to the audit run).
2. **Pre-deployment regression tests for each fix** should be archived. Today they only exist in migration comments.
3. **A retrospective on the 058 fix** is useful: why didn't the original `audit_no_update`/`audit_no_delete` policies catch the issue? Because Postgres OR's permissive policies — so `audit_no_update USING (role = 'admin')` plus `tenant_update USING (true)` evaluates as `(admin) OR (true) = true`. That's a counterintuitive trap. Document it. Reference: https://www.postgresql.org/docs/current/sql-createpolicy.html.
4. **The two-dialect drift in §4** is the next P0. The team has not yet noticed it because the application's service-role bypass masks the symptom.

### Recommendation

`[inferred]` Build `docs/SECURITY_TIMELINE.md` that ties each audit-response migration to its finding id, lists the regression test, and notes the lesson. The migrations themselves are the truth; the doc is the index.

## 17g. Finding F5.21 — DPDP and GDPR alignment: schema is present, but compliance artifacts aren't visible (Medium)

`[verified]` The schema has surfaces relevant to DPDP Act 2023 and GDPR:
- `customers.country`, `tax_id`, `tax_id_type` (096) — basis for jurisdiction determination.
- `customer_contacts.email`, `phone` (065) — personal data of natural persons.
- `auth_magic_links.email`, `ip`, `user_agent` (003) — personal data (currently leaking, §3).
- `user_security_audit.user_email`, `ip`, `user_agent`, `detail jsonb` (043) — personal data.
- `aa_consents.purpose_code`, `fi_types`, `expires_at`, `granted_at`, `revoked_at`, `consent_handle` (102) — designed for the Account Aggregator consent lifecycle which IS the DPDP-aligned consent surface for India. Good.
- `customers.do_not_publish_templates default true` (103:60) — explicit opt-in for the marketplace, DPDP-aligned (the comment at 103:60-62 explicitly says "DPDP-aligned opt-IN model").

`[verified]` What's missing:
1. **No `data_subject_requests` table** to track erasure / access requests. The DPDP Act 2023 Sections 11-13 grant access, correction, erasure, and grievance redressal rights. The schema doesn't track which user made what request when and what the response was.
2. **No `dpa_acceptance` table** to track which tenants accepted which version of the data processing addendum. The brief's template marketplace migration (103) references "DPA amendment" in a comment (line 25) but doesn't track acceptance.
3. **No retention policy table** mapping data type → retention period. Compliance needs to derive retention from the schema, not from tribal knowledge.
4. **No data classification on columns**. PII fields are not tagged. A future "what columns hold PII" query is impossible.

### Recommendation

`[inferred]` Build:
- `data_subject_requests (tenant_id, user_id, kind in ('access','correction','erasure','grievance'), submitted_at, resolved_at, resolution_action, evidence_url)`.
- `dpa_acceptances (tenant_id, dpa_version, accepted_by, accepted_at, ip)`.
- `retention_policies (table_name, classification text, default_retention interval, jurisdictions text[])`.
- `comment on column <every PII column>` with `classification: 'pii.email'`, `classification: 'pii.gov_id'`, etc. Build a CI script that scans `pg_description` for unclassified columns.

`[speculative]` 1-2 engineer-weeks. Pre-requisite for SOC 2 Type II evidence and DPDP compliance audits.

## 17h. Finding F5.22 — Cron infrastructure is partial; some jobs missing (Medium)

`[verified]` `cron_health (066)` tracks last run per worker. Migration comment explicitly notes that vercel.json doesn't carry the cron schedule because Hobby tier limits Vercel cron to once per day, so an external cron service (cron-job.org) triggers `/api/cron/tick` every 5 minutes.

`[inferred]` Risk:
1. **External cron is a single point of failure**. Loss of the cron-job.org account = all sub-daily ops, autonomous agents, 17 ERP retry queues silently stop. The `cron_health` table is the alarm mechanism — `/api/health` checks freshness — but the alarm goes nowhere if on-call doesn't poll `/api/health` continuously.
2. **No cron failure budgets per worker**. `consecutive_failures` is captured but not enforced. A worker that fails 100 times in a row keeps being scheduled.
3. **No tenant-scoped backoff for the retry queues**. A tenant with a permanently-broken Tally bridge fills the retry queue indefinitely. Migration 016 schedules retries with exponential backoff (`tally_retry_queue.next_attempt_at` advancing) but no global circuit breaker.

### Recommendation

`[inferred]`:
1. Add Vercel cron at every cadence the workers need (5min, 15min, hourly, daily). Vercel Pro supports it. Drop the external trigger.
2. Add a `cron_circuit_breakers` table: `(worker, consecutive_failures_threshold, suspended_at, suspended_until)`. Workers check this before running.
3. Per-tenant retry queue max-attempts: `tally_retry_queue.max_attempts default 5` is already there (`016:107`); enforce it. After 5 attempts, mark the row `gave_up`, send an alert.

`[speculative]` 1 engineer-week. Mostly operational tooling.

## 18. Audit summary table

| # | Finding | Severity | Status | Migration cost |
|---|---------|----------|--------|----------------|
| F5.1 | `auth_magic_links` cross-tenant PII leak | Critical | Open | 2 hours |
| F5.2 | RLS dialect drift (63 migrations dead-on-arrival) | Critical | Open | 3-5 eng-days |
| F5.3 | 8 tables allow `with check tenant_id is null` writes | High | Open | 1 eng-day |
| F5.4 | 359 handlers use service role; tenant scoping is per-query | Critical | Mitigated by C1 audit, still load-bearing | 1-2 eng-weeks for wrapper |
| F5.5 | `audit_events` is append-only at user-JWT layer only; service role can rewrite | High | Open | 1-2 eng-weeks (S3 mirror) |
| F5.6 | `audit_failures` has no RLS | Medium | Open | 15 min |
| F5.7 | `cron_health`, `india_emission_factors` no RLS | Medium | Open | 30 min |
| F5.8 | `tenant_settings` has ~110 columns | Medium | Open | 2-3 eng-weeks |
| F5.9 | JSONB sprawl present but indexed correctly | Resolved | n/a | n/a |
| F5.10 | 140 `on delete set null` FKs with no orphan GC | Medium | Open | 1-2 eng-days |
| F5.11 | No soft-delete pattern; only 5 generated columns | Medium | Open | 1 eng-week |
| F5.12 | Encryption-at-rest pattern is consistent; no rotation tooling | Low | Partial | 3-5 eng-days |
| F5.13 | Storage bucket RLS not tenant-scoped | High | Open | 1 eng-day |
| F5.14 | Template marketplace globals visible to all tenants by design; verify no PII | Medium | Verification needed | 30 min + audit |
| F5.15 | `extraction_cache` and rate-limit tables have no GC | Low | Open | 1-2 eng-days |

## 19. Deep-dive prompts for the next pass

1. **RLS dialect unification.** Decide between `current_tenant_ids()` and `auth.jwt()->>'tenant_id'`. Implement the auth-hook to populate the JWT claim if choosing the latter. Write `104_unify_rls_dialect.sql` that rewrites every policy. Add a CI guard that fails new migrations using the wrong dialect. Measure RLS performance before and after with `EXPLAIN ANALYZE` on a 10k-tenant synthetic dataset. Reference: https://supabase.com/docs/guides/database/postgres/row-level-security#performance.

2. **`auth_magic_links` PII leak fix and backfill.** Implement the migration in §3. Verify cross-tenant query returns zero rows. Audit the `recordMagicLink` writer to ensure no race condition where a slow auth.admin.getUserByEmail leaves the row tenant_id null permanently. Build the SOC 2 evidence packet showing the leak is closed (before/after queries).

3. **Storage bucket tenant scoping.** Prototype the path-prefix policy in §15. Verify signed URLs from tenant A can't read tenant B's objects. Document edge cases: multi-doc uploads, retroactive policy on existing objects, paths that don't follow the convention (legacy uploads from before the tenant-prefix pattern was adopted). Also explore migrating to `storage.objects.metadata->>'tenant_id'` instead of path parsing.

4. **Tamper-evident audit chain decision.** Pick (a) document the limit, (b) HMAC-chained rows, or (c) S3 Object Lock mirror. For (c), design the cron, the export ndjson shape, the HMAC trailer, the verifier. Estimate per-tenant export volume. Reference Cloudflare's audit logs (https://blog.cloudflare.com/introducing-audit-logs/) and AWS QLDB (https://docs.aws.amazon.com/qldb/) as comparison points.

5. **Service-role-to-user-JWT migration plan.** Audit all 359 endpoints that import `serviceClient`. Produce a per-endpoint table: `endpoint | uses service role for | can move to user JWT? | migration risk`. Identify endpoints that MUST stay service-role (cron, audit writes, secret decryption) and endpoints that can move to user-JWT. Output a sweep PR sequence with the lowest-risk endpoints first.

6. **`tenant_settings` column-sprawl split.** Design the new `tenant_connector_settings (tenant_id, connector, settings jsonb, encrypted_secrets bytea, iv bytea)` table. Plan the migration: copy the existing per-connector `_enc`/`_iv` columns into rows, drop the columns on `tenant_settings`, update `_lib/secrets.js` to read/write the new shape. Sweep every connector handler (~20 endpoints).

7. **Soft-delete adoption for customer-facing tables.** Implement `deleted_at timestamptz` on `customers`, `orders`, `invoices`, `documents`, `customer_contacts`. Update every RLS policy and every `.eq(...)` handler to also filter `deleted_at is null`. Build an admin "restore" endpoint. Build a DPDP-Article-8 erasure endpoint that hard-deletes and writes a tamper-evident audit row.

8. **Restrictive RLS bundle.** Add a project-wide `tenant_not_null_check AS RESTRICTIVE for insert,update using (tenant_id is not null)` policy on every business table. Verify no legitimate write fails. This is the defense-in-depth fix that catches future migrations re-introducing the §5 pattern.

9. **FK orphan audit cron.** Enumerate every `on delete set null` FK. Build a nightly cron that counts orphans per relation and writes to `health_metrics`. Alert when growth exceeds 10% week-over-week. Tighten 5-10 high-blast-radius FKs to `on delete restrict` after confirming no existing orphans.

10. **`audit_export_runs` cross-check.** Today `src/api/audit/export.js` writes to `audit_export_runs`. Verify this table has RLS, has tenant scoping, and is itself append-only. The audit-of-audit-exports trail is the SOC 2 control evidence for who pulled what when.

11. **Encryption key rotation tooling.** Build `/api/admin/secrets/rotate` that decrypts under the current `ANVIL_SECRETS_KEY` and re-encrypts under a new one. Per-tenant, transactional. Add `secrets_rotation_runs` audit table. Verify the rotation doesn't leak plaintext to any log.

12. **Marketplace global template PII verification.** Audit every writer of `customer_format_templates_global`. Verify `redaction_report`, `replay_verification`, `regex_safety_report` contain no raw sample values, email addresses, or publisher-identifying fingerprints. Add the `anonymise_publisher` consistency CHECK in §16. Build a CI test that fakes a publisher with PII and asserts the global row strips it.

13. **`audit_failures` and unprotected-RLS tables hardening.** Apply the fix in §8 and §9. Add a CI test that scans `pg_class` and `pg_policy` after each migration to assert every table in `public` schema either has RLS enabled with policies, or is explicitly listed in an allowlist (`india_emission_factors`, `seed_default_lead_times`).

14. **Two-dialect bridge for the transition.** While unifying RLS dialects, add a temporary `current_tenant_id_compat()` function that returns `coalesce(current_tenant_ids() row, current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid`. Use this in new migrations until the unification finishes. After unification, drop the compat function.

15. **Retention pipeline.** Implement `pg_cron` schedules for `extraction_cache`, `totp_used_counters`, `mfa_attempts`, `magic_link_attempts`, `password_reset_attempts`. Decide retention windows in collaboration with counsel (DPDP, GDPR Art. 5, SOC 2 CC7.3). Document the choices in `docs/RETENTION.md`. Plan the `audit_events` archival to S3 Object Lock.

16. **CMU 15-721 / OLTP partitioning study.** At Anvil's projected scale (1k-10k tenants, 100k-1M orders per tenant), revisit whether shared-schema with tenant_id is the right partitioning. Reference: AWS SaaS Lens silo/pool/bridge model (https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/silo-pool-and-bridge-models.html). For top-tier customers requiring contractual isolation, plan a "silo" mode where the tenant gets a dedicated Supabase project.

17. **PostgREST direct-access surface audit.** Verify Supabase's PostgREST is reachable from the public internet at the project URL. Catalog every table that has user-JWT-readable RLS. For each, verify the policy actually restricts to the calling tenant. Catalog every table with `for select using (false)` (locked) to ensure nothing leaks. Reference: https://supabase.com/docs/guides/api/securing-your-api.

18. **Migration safety net in CI.** Build a `make verify-migrations` target that runs each migration against an ephemeral Supabase project and snapshots `pg_class`, `pg_policy`, `pg_index`. Diff snapshots against a checked-in baseline. Block PRs that change the snapshot without an explicit acknowledgement. The existing `src/scripts/audit-migration.mjs` is a starting point.

19. **Multi-tenant noisy neighbor study.** With 110 columns on `tenant_settings`, a single feature-flag flip on a large tenant locks the row. Profile under load: simulate 1k tenants doing simultaneous flag flips. Measure p99 latency on `select * from tenant_settings where tenant_id = ?`. If hot, split per §10 recommendation (b). Reference: Microsoft's noisy neighbor pattern (https://learn.microsoft.com/en-us/azure/architecture/antipatterns/noisy-neighbor/noisy-neighbor).

20. **DPDP / GDPR compliance evidence packet.** Build a per-tenant data inventory: which tables hold personal data, what kinds of personal data, retention period, lawful basis. Cross-reference DPDP 2023 sections 4-10. Validate that erasure requests can be honored. Reference DPDP full text: https://www.meity.gov.in/writereaddata/files/Digital%20Personal%20Data%20Protection%20Act%202023.pdf.

## 20. Verified on main

This section captures point-in-time verification against `main` for the high-blast-radius facts the rest of the report depends on. All commands were run against `/Users/kenith.philip/anvil/` on `main`. Each line is `[verified-on-main]` unless tagged otherwise.

### 20.1 `auth_magic_links` SELECT policy on main

`[verified-on-main]` `supabase/migrations/003_advanced_modules.sql:241`:
```sql
create policy magic_links_select on auth_magic_links for select using (tenant_id is null or tenant_id in (select current_tenant_ids()));
```

No subsequent migration patches this policy. `grep -nE "magic_links_select|auth_magic_links" /Users/kenith.philip/anvil/supabase/migrations/*.sql` after migration 003 returns only:
- `043_security_passkeys_mfa.sql` adds related rate-limit table `magic_link_attempts` (different table)
- `059_security_followup.sql` adds magic-link rate-limit logic, leaves the SELECT policy untouched

Status: still leaky. The fix proposed in finding F5.1 has NOT been applied on main. Cross-tenant PII read via PostgREST direct call remains live.

### 20.2 Storage bucket policy on main

`[verified-on-main]` `supabase/migrations/001_init.sql:480-484`:
```sql
create policy "obara documents read" on storage.objects
  for select using (bucket_id = 'obara-documents' and auth.role() = 'authenticated');
create policy "obara documents write" on storage.objects
  for insert with check (bucket_id = 'obara-documents' and auth.role() = 'authenticated');
```

No subsequent migration patches these policies. `grep -rnE "obara documents read|obara documents write|storage\.objects" /Users/kenith.philip/anvil/supabase/migrations/*.sql` after 001 returns no rewrites. The bucket policy on main is still cross-tenant. Fix proposed in F5.13 has not landed.

### 20.3 `serviceClient()` count on main

`[verified-on-main]` `grep -rln "serviceClient()" /Users/kenith.philip/anvil/src/api/ | wc -l` returns **359 files** on main. `grep -rE '\.eq\("tenant_id"' /Users/kenith.philip/anvil/src/api/ | wc -l` returns **889 occurrences**. The service-role bypass surface is unchanged from the prior agent measurement.

### 20.4 `tenant_id is null OR ...` policy density on main

`[verified-on-main]` `grep -rnE "tenant_id is null OR|tenant_id is null or" /Users/kenith.philip/anvil/supabase/migrations/*.sql | wc -l` returns **45 occurrences** across the 103 migrations on main. (The prior measurement in §2 was 48 with the simpler grep including the `is null` substring once per appearance; the slightly different number reflects the regex anchored on the `OR` connector.) The intent breakdown stays the same: 28 SELECT policies, 8 WRITE policies of which only 1 has been hardened (`prospecting_suppressions` in 059). The other 8 WRITE policies in finding F5.3 remain on main.

### 20.5 `ALLOW_ANONYMOUS_TENANT` default on main

`[verified-on-main]` `src/api/_lib/auth.js:14`:
```js
const ALLOW_ANONYMOUS = String(process.env.ALLOW_ANONYMOUS_TENANT || "false").toLowerCase() === "true";
```

`src/api/_lib/auth.js:16-23`: production startup throws when the flag is on. Default value is `"false"`. The audit C1 hardening referenced in §0 is on main. This finding stays in the resolved bucket.

### 20.6 Counts of secondary patterns on main

`[verified-on-main]`:
- `grep -rE "current_tenant_ids" /Users/kenith.philip/anvil/src/api/ | wc -l` returns **0**. No JavaScript handler invokes the function directly; the function is referenced only by SQL policies. This confirms the dialect-drift analysis in F5.2: the application layer is service-role-only and cannot exercise either RLS dialect from JavaScript.
- `grep -rE "audit_events" /Users/kenith.philip/anvil/src/api/ | wc -l` returns **37 references**. Audit writes are concentrated in `src/api/_lib/audit.js` plus a handful of explicit insert sites in cron jobs.
- `grep -rE "processing_events" /Users/kenith.philip/anvil/src/api/ | wc -l` returns **18 references**. Processing-pipeline telemetry writes; tenant-scoped, service-role only.

## 21. Finding F5.23 — Audit chain is signed at export, not at write; no per-row HMAC chain (P1)

`[verified-on-main]` `grep -rnE "prev_hash|chain_hash|chain_seq" /Users/kenith.philip/anvil/supabase/migrations/*.sql` returns zero hits. `grep -rnE "prev_hash|chain_hash|crypto\.createHmac" /Users/kenith.philip/anvil/src/api/_lib/audit*.js` returns zero hits. The single `crypto.createHmac` call in the audit subtree is at `src/api/audit/export.js:68`, which signs the streamed export blob, not individual `audit_events` rows.

`[verified-on-main]` Migration `058_audit_events_append_only.sql:35-43` documents the design: "After this migration: `audit_events` is read-only for everyone except service-role inserts. The HMAC-signed audit/export endpoint signs the streamed body, not the database rows." The migration is deliberately scoped to PostgREST callers under user-JWT; service role can still delete or update. Migration 043 (`043_security_passkeys_mfa.sql`) adds `user_security_audit` (a parallel audit table for auth events) but with the same shape: no per-row chain.

`[verified-on-main]` `audit_events.payload_hash` (defined in migration 001 around line 330) is a `text` column that callers populate with order-specific or object-specific content hashes. It is not a chain hash. `src/api/_lib/audit.js` writes `payload_hash: payload.payloadHash || null` for callers that pass one; many callers don't.

### Problem

Audit logs are the canonical SOC 2 CC7.2 / CC7.3 evidence chain. Anvil's design today gives one of two assurances depending on the threat model:

1. **Against PostgREST callers under user-JWT**, rows are append-only (migration 058 dropped UPDATE and DELETE policies).
2. **Against an attacker holding `SUPABASE_SERVICE_ROLE_KEY`**, no assurance at all. The service role bypasses RLS unconditionally. An attacker can insert backdated rows, delete rows, update rows. The post-incident export trail will sign whatever the database contains at export time, which is whatever the attacker decided it would contain.

The HMAC at `audit/export.js:68` proves "this export matches what the DB held when I exported it". It does not prove "what the DB holds is what the application wrote". The gap between those two statements is the tamper window. For SOC 2 Type II, auditors increasingly ask for the second statement. For DPDP Section 8 accuracy obligations, the second statement is what matters.

### Current state on main

- `supabase/migrations/001_init.sql:320-340` defines `audit_events` with `id bigserial`, `created_at timestamptz default now()`, `tenant_id uuid`, `actor_id uuid`, `action text`, `object_type text`, `object_id uuid`, `before_state jsonb`, `after_state jsonb`, `payload_hash text`, `source_evidence_ids uuid[]`. No `prev_hash`, no `chain_hash`, no `chain_seq`, no `signature`.
- `src/api/_lib/audit.js:69` writes `payload_hash` only when the caller supplied it. Most call sites do not (rapid grep: `grep -rnE "audit.*payloadHash|payloadHash:" /Users/kenith.philip/anvil/src/api/ | wc -l` returns approximately 12 distinct callers out of 37 that touch audit_events).
- `src/api/audit/export.js:39-44`: refuses to operate without `AUDIT_EXPORT_HMAC_SECRET`. Good. Signing scope is the streamed body only.

### Competitor state

- **Stripe**'s public Events API exposes immutable event records keyed by monotonic ids. Stripe does not publish per-row HMAC chains for customer-visible events, but internally the canonical event log is append-only and protected by separate WORM storage.
- **AWS QLDB** (https://docs.aws.amazon.com/qldb/latest/developerguide/verification.html) computes per-document and per-block SHA-256 digests in a Merkle tree; the journal is cryptographically verifiable end-to-end. Anyone can `GetDigest` and prove a document exists at a given block.
- **Datadog Audit Logs** stores audit records in append-only S3 with retention policy; per-record hashes are computed at ingest but not exposed.
- **Cloudflare Audit Logs** (https://blog.cloudflare.com/introducing-audit-logs/) chains via a separate signed-blob service that ships records to GCS Object Lock equivalents.

Anvil sits below all four on tamper-evidence. The fastest path to parity is option (c) in F5.5: mirror to S3 Object Lock. The full-coverage path is per-row HMAC chain plus external mirror.

### Adjacent insight

`[inferred]` Anvil's `user_security_audit` (migration 043) is a second audit table for auth-specific events. It also has no chain. A future audit by counsel will note that two parallel audit surfaces with two parallel append-only stories, neither cryptographically chained, is a maturity gap. Unifying behind a single audit pipeline (write to `audit_events`, mirror to immutable storage, document the chain semantics) reduces surface and makes the SOC 2 evidence story cleaner.

### Research insight

`[inferred]` Per-row HMAC chain has a serialization cost: every insert must read the previous chain head, compute `chain_hash = hmac(secret, prev_hash || canonical_payload)`, and update the head pointer. At Anvil's projected volume (a few hundred audits per tenant per day) the cost is invisible; at 1M/tenant/day a single-chain trigger would become a bottleneck. The Postgres pattern that works at scale is per-tenant chain heads: `audit_chain_heads (tenant_id uuid primary key, last_chain_hash text, last_chain_seq bigint)`. The trigger reads and updates one row per tenant, so the lock contention is bounded by per-tenant insert rate, which is much lower than the global rate.

### Proposed change

Adopt a two-stage hardening:

1. **Per-tenant HMAC chain at write time.** Add `prev_hash text`, `chain_hash text`, `chain_seq bigint` to `audit_events`. Trigger reads `audit_chain_heads`, computes `chain_hash`, writes the row, updates the head. HMAC key in `AUDIT_CHAIN_HMAC_SECRET` env, separate from the export secret so a leak of one does not invalidate the other.
2. **External WORM mirror.** Hourly cron exports new rows to S3 Object Lock in compliance mode with 7-year retention. The cron records the export pointer in `audit_export_pointers (tenant_id, last_exported_id bigint)`. The S3 copy is the SOC 2 evidence; the Postgres copy is the queryable working copy.

### User-facing behavior

Transparent. Customers gain a `GET /api/audit/verify?tenant_id=...&from=<seq>&to=<seq>` endpoint that returns "chain intact" or "chain broken at seq N" with a diff. Most tenants never call it; counsel and auditors do.

### Technical implementation

```sql
-- Migration 104_audit_chain.sql
create table if not exists audit_chain_heads (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  last_chain_hash text,
  last_chain_seq bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table audit_events
  add column if not exists prev_hash text,
  add column if not exists chain_hash text,
  add column if not exists chain_seq bigint;

create or replace function audit_events_chain_trigger() returns trigger as $$
declare
  v_secret text := current_setting('app.audit_chain_secret', true);
  v_prev text;
  v_seq bigint;
begin
  if v_secret is null or v_secret = '' then
    raise exception 'app.audit_chain_secret not set';
  end if;
  select last_chain_hash, last_chain_seq into v_prev, v_seq
    from audit_chain_heads where tenant_id = new.tenant_id for update;
  if not found then
    insert into audit_chain_heads (tenant_id) values (new.tenant_id);
    v_prev := null;
    v_seq := 0;
  end if;
  new.prev_hash := v_prev;
  new.chain_seq := v_seq + 1;
  new.chain_hash := encode(
    hmac(
      convert_to(coalesce(v_prev, '') || '|' || (new.payload_hash, '|') ||
        new.action || '|' || new.object_type || '|' ||
        coalesce(new.object_id::text, '') || '|' ||
        coalesce(new.before_state::text, '') || '|' ||
        coalesce(new.after_state::text, ''), 'UTF8'),
      convert_to(v_secret, 'UTF8'), 'sha256'),
    'hex');
  update audit_chain_heads
    set last_chain_hash = new.chain_hash,
        last_chain_seq = new.chain_seq,
        updated_at = now()
   where tenant_id = new.tenant_id;
  return new;
end $$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists audit_events_chain on audit_events;
create trigger audit_events_chain before insert on audit_events
  for each row execute function audit_events_chain_trigger();
```

Application sets `app.audit_chain_secret` per connection via `set_config('app.audit_chain_secret', $1, true)` in the service-client wrapper. Rotating the secret means walking the existing chain to recompute under the new key, then atomically swapping.

### Integration plan

- Phase 1 (1 week): land the migration in dev/staging. Verify no perf regression on synthetic 10k insert/sec test.
- Phase 2 (3 days): add `/api/audit/verify` endpoint that walks the chain for a tenant + time range.
- Phase 3 (1 week): build the S3 Object Lock mirror cron. Provision the bucket with `governance` retention mode, 7-year retention.
- Phase 4 (ongoing): document in `docs/SECURITY.md` how SOC 2 evidence is computed and verified.

### Telemetry

- `audit_chain_verify_total{result="intact|broken"}` Prometheus counter.
- `audit_chain_head_lag_seconds{tenant_id}` for export pointer freshness.
- Alert on `chain_broken` count > 0 in any 1-minute window.

### Non-goals

- Per-row signature with asymmetric keys (overkill at Anvil's threat model; HMAC is sufficient).
- Sub-second export latency to S3 (hourly is fine for SOC 2 evidence).
- Replacing `payload_hash` (keep it; chain layers on top).

### Open questions

- Does Supabase's pooled Postgres support `set_config` reliably across pgbouncer transaction-mode pooling? If not, the trigger reads `current_setting` may return empty mid-transaction. Test before phase 1.
- Where does the HMAC secret live? Vercel env is the obvious answer; a future Vault integration is cleaner.
- What about pre-existing rows? Either backfill with `chain_hash = sha256(payload || row_id)` (no prev-link, just a per-row digest) or leave them unsigned and document "chain begins at migration 104".

### Effort

`[inferred]` 2-3 engineer-weeks for the full pipeline. Stage 1 alone (per-row chain without the S3 mirror) is 1 week.

### 5-axis score

- Customer pain reduction: 4 (SOC 2 / DPDP evidence story upgrades from "trust us" to "verify us")
- Engineering complexity: 6 (trigger plus cron plus verifier plus key rotation)
- Reversibility: 4 (dropping the trigger leaves a confusing partial chain in history)
- Time-to-ship: 6 (2-3 weeks)
- Strategic moat: 7 (cryptographic audit is sales-relevant for enterprise procurement and FinTech reseller deals)

### Deep-dive prompt

Compare three audit-tamper-evident architectures for Anvil at projected scale (10k tenants, 100k audit rows per tenant per year): (a) per-row HMAC chain in Postgres with per-tenant head, (b) external WORM mirror to S3 Object Lock without per-row chain, (c) hybrid of (a) + (b). Quantify per-tenant insert latency under each scheme on a synthetic 10k inserts/sec workload. Document the failure modes: head-row lock contention under (a), export pointer staleness under (b), drift between the two stores under (c). Reference AWS QLDB design (https://docs.aws.amazon.com/qldb/latest/developerguide/verification.html) and Cloudflare's audit log architecture (https://blog.cloudflare.com/introducing-audit-logs/).

## 22. Finding F5.24 — Soft-delete pattern is absent; hard deletes lose restore and DPDP attestation surfaces (P1)

`[verified-on-main]` `grep -nE "deleted_at" /Users/kenith.philip/anvil/supabase/migrations/*.sql` returns **0 hits across all 103 migrations**. There is no soft-delete column anywhere in the schema. `grep -rnE "deleted_at|softDelete|soft_delete" /Users/kenith.philip/anvil/src/api/` likewise returns nothing material.

`[verified-on-main]` Every customer-facing entity is hard-deleted in place. The cascade FK strategy (389 cascades, finding F5.10) propagates the delete through child rows. The audit trail captures `action = 'delete'` but the row itself is gone; counsel cannot reconstruct what was in the row without restoring from PITR.

### Problem

Hard delete by default has three failure modes:

1. **Operator mistake recovery.** A tenant admin deletes a customer record by accident. Today the only restore path is Supabase Pro PITR with RPO of approximately 2 minutes (https://supabase.com/docs/guides/platform/backups). PITR restores the entire project to a point in time, which is a sledgehammer for a single-row mistake.
2. **DPDP Article 8 erasure attestation.** When a data principal exercises right-to-erasure under DPDP 2023 Section 13, the data fiduciary must prove the erasure happened. A hard delete leaves no row, only an `audit_events` entry that says "I deleted it". Without per-row tamper-evidence (finding F5.23), the attestation is "trust us".
3. **Materially-shared cross-tenant data.** `value_chain_relationships` and `supplier_disclosures` (migration 101) cross tenant boundaries. If a supplier hard-deletes a disclosure that a buyer is consuming, the buyer's analytics blow up. The current FK `supplier_disclosures.tenant_id references tenants(id) on delete cascade` means tenant deletion (which Anvil supports via the tenant-offboarding flow if any) wipes downstream buyer-visible data.

### Current state on main

- No table in `supabase/migrations/` declares a `deleted_at` column or a soft-delete trigger.
- `src/api/customers/index.js`, `src/api/orders/index.js`, `src/api/documents/[id].js` and similar handlers issue `.delete()` directly via service role.
- The audit chain (F5.23) is the only proof of past existence and the only thing an auditor can reconstruct from.

### Competitor state

- **Salesforce** soft-deletes records to the recycle bin for 15 days by default; restorable via API or UI (https://help.salesforce.com/s/articleView?id=000387210). Restoration is a routine admin task.
- **Stripe** never deletes customer records; it sets `deleted: true` and most fields become null. The id and creation time remain. This is a documented behavior in https://stripe.com/docs/api/customers/delete.
- **HubSpot, Zendesk, Pipedrive, Asana** all run soft-delete with a 30-90 day restore window.

Anvil's hard-delete-by-default is below the SaaS market norm. For a B2B platform targeting regulated industries (BRSR, DPDP, SOC 2), the gap is more pointed: regulators expect retention and verifiable erasure, not silent in-place deletion.

### Adjacent insight

`[inferred]` Finding F5.10 noted 389 `on delete cascade` FKs. Soft-delete intersects this directly: if a parent's `deleted_at` is set, the child rows do not get deleted at the DB layer because nothing fires the cascade. RLS policies become the enforcement surface, evaluating `parent.deleted_at is null AND ...`. The application layer must also filter `deleted_at is null` in every query. This couples soft-delete tightly to RLS unification (finding F5.2): doing both at once is cleaner than retrofitting them sequentially.

### Research insight

`[inferred]` The DPDP Act 2023 Section 13(d) says the data principal has the right to erasure, "subject to applicable law". A reasonable reading is that the data fiduciary must complete the erasure but may retain proof-of-erasure metadata for as long as the underlying lawful basis (audit, accounting) requires. The right shape is:
- Application "delete": set `deleted_at = now()`, scrub PII fields to canonical placeholders, audit-log the action.
- DPDP-erasure pipeline: hard-delete the row but write a tamper-evident `erasure_attestations` row with hashed identifiers, retain the attestation row for 7 years, scrub the underlying audit_events PII fields on the same trigger.

This separates "user clicks Delete in the UI" from "user exercises a statutory erasure right". Today Anvil collapses both into the same hard delete.

### Proposed change

Adopt a three-pillar soft-delete pattern:

1. **`deleted_at timestamptz` column on the high-blast-radius tables**: `customers`, `customer_contacts`, `orders`, `invoices`, `documents`, `quotes`, `shipments`, `service_visits`. (Roughly the top 10 tables.)
2. **Universal RLS predicate**: every SELECT policy on these tables ANDs `deleted_at is null`. A separate `tenant_admin_can_see_deleted` policy permits an admin to see deleted rows for 30 days.
3. **DPDP erasure endpoint** (`POST /api/admin/erasure/:tenantId`): the only path that actually hard-deletes. Writes `erasure_attestations` row before the delete, hashes PII fields into the attestation. The attestation is itself chained via F5.23.

### User-facing behavior

Today: "Delete" removes the row instantly.

After: "Delete" sets `deleted_at`, hides from list views, queues a 30-day permanent-deletion cron. Admin "Trash" view lists deleted rows; one-click restore. A separate "Right to Erasure" flow for end customers leads to hard delete plus attestation.

### Technical implementation

```sql
-- Migration 105_soft_delete.sql (sketch)
alter table customers add column if not exists deleted_at timestamptz;
alter table orders add column if not exists deleted_at timestamptz;
alter table documents add column if not exists deleted_at timestamptz;
-- ...repeat for the 7 other tables...

create or replace function require_not_deleted(tbl regclass, row_id uuid) returns boolean
language sql stable as $$
  select deleted_at is null from <dynamic>
$$;

-- For every SELECT policy on the 10 tables, rewrite to AND deleted_at is null
drop policy if exists tenant_select on customers;
create policy tenant_select on customers
  for select using (
    deleted_at is null
    and tenant_id in (select current_tenant_ids())
  );

-- Cron: hard-delete after 30 days
select cron.schedule('soft_delete_gc_customers', '0 2 * * *',
  $$delete from customers where deleted_at is not null and deleted_at < now() - interval '30 days'$$);

-- Erasure attestation table
create table if not exists erasure_attestations (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  pii_field_hashes jsonb not null,
  erased_at timestamptz not null default now(),
  erased_by uuid references auth.users(id),
  legal_basis text not null
);
alter table erasure_attestations enable row level security;
create policy ea_select on erasure_attestations
  for select using (tenant_id in (select current_tenant_ids()));
```

Application sweep: every `svc.from('<table>').delete()` call site in `src/api/` becomes either `svc.from('<table>').update({ deleted_at: new Date().toISOString() })` (routine) or a call to `softDelete(svc, table, ctx, id)` (helper). Hard delete is gated behind `POST /api/admin/erasure`.

### Integration plan

- Phase 1 (1 week): land migration with `deleted_at` on the top 10 tables; update RLS policies; write helper `softDelete()` in `src/api/_lib/db.js`.
- Phase 2 (1 week): sweep handlers to call the helper. Lint rule against direct `.delete()` calls outside the helper.
- Phase 3 (3 days): build admin "Trash" view in `src/v3-app/views/admin/trash`.
- Phase 4 (1 week): erasure-attestation endpoint and operator runbook.

### Telemetry

- `soft_delete_count{table, tenant_id}` counter on each soft-delete write.
- `soft_delete_restore_count{table}` counter on restore actions.
- `erasure_attestation_count{legal_basis}` counter on DPDP/GDPR erasure.
- Weekly dashboard: "rows soft-deleted last 7 days vs restored last 7 days" per tenant. A high restore rate is a UX signal.

### Non-goals

- Soft-delete on every table. Some tables (audit_events, processing_events, retry queues) are explicitly append-only or transient; soft-delete is wrong for them.
- Cascading soft-delete through every child relationship in the schema. Start with the 10 customer-visible tables; expand as needed.
- UI affordances for end customers to undo their own deletes. Admin-only restore for now.

### Open questions

- Should `deleted_at` be exposed via PostgREST for analytics tools? Probably yes for admin queries, no for routine reads (RLS filters it out).
- How does soft-delete interact with the cascade FK strategy (F5.10)? Decision: hard-cascade child rows when the parent is hard-deleted (30-day GC), but soft-deleted parents leave children visible (the application filters via the RLS predicate).
- Encrypted secrets (F5.12): when a tenant is soft-deleted, should the `_enc` columns be scrubbed immediately or only at hard-delete? Decision: scrub at soft-delete (because the connector is already disabled in practice).

### Effort

`[inferred]` 3-4 engineer-weeks across the four phases. The handler sweep dominates.

### 5-axis score

- Customer pain reduction: 7 (operator-mistake recovery is a frequent ask)
- Engineering complexity: 5 (mechanical sweep; lint rule contains future regressions)
- Reversibility: 6 (the migration adds columns; not dropping them is fine; the RLS rewrite is reversible)
- Time-to-ship: 5 (3-4 weeks)
- Strategic moat: 5 (table stakes for enterprise; not a differentiator)

### Deep-dive prompt

Design Anvil's two-path delete model: routine soft-delete with 30-day restore, statutory hard-delete with tamper-evident attestation. Enumerate every `.delete()` call site in `src/api/` (run `grep -rnE "\.delete\(\)" /Users/kenith.philip/anvil/src/api/`). Classify each as routine or statutory. Draft the helper `softDelete()` in `src/api/_lib/db.js`. Decide whether soft-delete on `documents` triggers Supabase Storage object deletion (a separate WORM consideration: the object should expire after 30 days, matching the row). Reference Salesforce recycle bin semantics and Stripe deletion behavior for comparison.

## 23. Finding F5.25 — `tenant_settings` JSONB indexing strategy is non-existent; 110 columns means full-row reads (P2)

`[verified-on-main]` `grep -nE "create index.*tenant_settings|using gin.*tenant_settings" /Users/kenith.philip/anvil/supabase/migrations/*.sql` returns one hit: `tenant_settings_stripe_idx` in `013_stripe.sql:31`. That index is btree on `(stripe_account_id)`, unrelated to JSONB.

`[verified-on-main]` `tenant_settings` has approximately 110 columns (finding F5.8), of which the vast majority are scalar (booleans, text, numeric thresholds, encrypted bytea blobs). There are JSONB columns: `docai_prompt_overrides jsonb` (migration 029) and a handful of feature-flag-shape blobs in later migrations. None has a GIN index. The table's primary key is `tenant_id uuid primary key`, so per-tenant reads are O(1) index lookup. The cost is in the row size, not the index.

`[verified-on-main]` Supabase's documented row-format limit (Postgres-standard): rows wider than 2KB get TOAST'd to out-of-line storage. A 110-column row with mostly-nullable fields fits in-page for typical tenants (many columns null), but the row write path still re-writes the entire heap tuple. A single `update tenant_settings set inventory_conformal_enabled = true where tenant_id = $1` rewrites the full row (Postgres MVCC).

### Problem

The risk is not query performance (per-tenant reads are fast). The risks are:

1. **Write contention.** Every feature-flag flip rewrites the full row. With 110 columns averaging 30 bytes including nullable overhead, a row is roughly 1-2KB plus TOAST pointers for the encrypted columns. Hot tenants flipping flags during a release window can produce visible write amplification.
2. **Backup and replication bandwidth.** Every row update logs to WAL with full row before/after. PITR storage grows proportional to row size times update rate.
3. **JSONB columns are uncomposable.** `docai_prompt_overrides` holds prompt strings; if the application wants to look up "all tenants with a custom OCR prompt for invoices", it must scan every row and parse JSONB. No GIN, no `jsonb_path_ops`, no expression index.
4. **Discoverability decays as columns grow.** Engineers add columns reactively; nobody knows the full shape of the row.

### Current state on main

- `supabase/migrations/013_stripe.sql:6-30` defines the initial 11 columns.
- `supabase/migrations/100_inventory_conformal_intervals.sql:84-88` adds `inventory_conformal_enabled`, `inventory_conformal_default_coverage`, `inventory_conformal_method`. Bet 3 alone added 3 columns.
- `supabase/migrations/101_brsr_value_chain.sql` adds BRSR feature flags.
- `supabase/migrations/102_aa_treds_sandbox.sql` adds AA / TReDS feature flags.
- `supabase/migrations/103_template_marketplace.sql` adds marketplace feature flags.

The growth rate of `tenant_settings` columns across bets 3-7 (the most recent merged ones) is roughly +3 to +5 columns per bet. At that rate, the table doubles in width every 30 merged bets.

### Competitor state

- **LaunchDarkly, Statsig, Unleash** store feature flags as a separate per-flag table: `(tenant_id, flag_key, enabled, rollout_percent, conditions jsonb)`. Looking up "is flag X enabled for tenant Y" is a primary-key lookup. Flag definition lives in a separate table.
- **Stripe** keeps account-level settings in a single document, retrieved together by primary key. They have many fields but they are a narrow consumer of those fields per call site.
- **Vercel** stores tenant settings in a key-value document store under the hood, not a relational row.

Anvil's pattern is closer to Stripe than to LaunchDarkly, which is a defensible choice; but Anvil also wants the LaunchDarkly behavior (rollout flags, per-flag toggles) without the LaunchDarkly table shape.

### Adjacent insight

`[inferred]` Finding F5.8 noted the 110-column issue and proposed splitting into `tenant_connector_settings` (per-connector) and `tenant_feature_flags` (per-flag). This finding sharpens the JSONB angle: the eventual split should also relocate JSONB columns into a `tenant_settings_documents (tenant_id, document_kind, payload jsonb)` table with a partial GIN index on `payload`. The split is then four tables:

- `tenant_settings`: 10-20 small scalars that every tenant needs (region, timezone, billing plan).
- `tenant_connector_settings`: one row per (tenant, connector) with encrypted secrets.
- `tenant_feature_flags`: one row per (tenant, flag_key) with rollout state.
- `tenant_settings_documents`: one row per (tenant, document_kind) for any JSONB blob.

### Research insight

`[inferred]` Postgres `jsonb_path_ops` GIN indexes are dramatically smaller than `jsonb_ops` (https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING) and answer `@>` containment queries fast. For Anvil's JSONB usage pattern (mostly look-up-by-tenant-then-read-whole-blob), GIN is wasted. The right index for the small percentage of cross-tenant JSONB queries (e.g., "all tenants with feature X enabled") is an expression index on the predicate: `create index ... on tenant_settings ((docai_prompt_overrides->>'enabled'))`.

### Proposed change

1. **Adopt the F5.8 split.** Move connector secrets to `tenant_connector_settings`. Move feature flags to `tenant_feature_flags`. Migrate JSONB blobs to `tenant_settings_documents`.
2. **Add a CI guard** in `src/scripts/audit-tenant-settings.mjs` that fails the build when a new migration adds more than 2 columns to `tenant_settings`.
3. **Document the shape.** `comment on table tenant_settings` plus per-column comments. Auto-generate `docs/SCHEMA_TENANT_SETTINGS.md`.

### User-facing behavior

Transparent. The split is implementation detail; the existing `getTenantSettings(ctx)` helper continues to return the merged shape.

### Technical implementation

```sql
-- Migration 106_tenant_settings_split.sql
create table if not exists tenant_feature_flags (
  tenant_id uuid not null references tenants(id) on delete cascade,
  flag_key text not null,
  enabled boolean not null default false,
  rollout_percent numeric(5,2) check (rollout_percent >= 0 and rollout_percent <= 100),
  conditions jsonb,
  set_at timestamptz not null default now(),
  set_by uuid references auth.users(id),
  primary key (tenant_id, flag_key)
);
alter table tenant_feature_flags enable row level security;
create policy tff_select on tenant_feature_flags
  for select using (tenant_id in (select current_tenant_ids()));

-- Backfill from existing tenant_settings boolean columns
insert into tenant_feature_flags (tenant_id, flag_key, enabled)
  select tenant_id, 'inventory_conformal_enabled', inventory_conformal_enabled
    from tenant_settings where inventory_conformal_enabled is not null
  on conflict do nothing;
-- Repeat for every boolean feature flag column.

-- Drop the migrated columns from tenant_settings (later migration after handlers are updated)
```

Application sweep: every `tenant_settings.<flag_name>` read becomes `getFeatureFlag(ctx, 'flag_name')`. Helper handles both shapes during transition.

### Integration plan

- Phase 1 (1 week): land the three new tables. Backfill.
- Phase 2 (2 weeks): handler sweep. Lint rule against direct `tenant_settings.<flag_name>` access for the migrated flags.
- Phase 3 (1 week): drop the migrated columns from `tenant_settings`.
- Phase 4: ongoing. Future feature flags use the new table by default.

### Telemetry

- `tenant_settings_column_count` gauge, reported daily; alert when > 80 columns.
- `feature_flag_read_total{flag_key, tenant_id}` counter to identify dead flags.
- `tenant_feature_flag_set_total{flag_key}` counter for flag flip audits.

### Non-goals

- Building a full LaunchDarkly clone. Anvil's flag needs are simpler.
- Moving every column out of `tenant_settings`. The 10-20 truly per-tenant scalars stay.
- Retroactively re-encrypting secrets during the split (separate migration, see F5.12).

### Open questions

- How does the application bind multi-flag reads in one transaction? Helper `getFeatureFlags(ctx, ['flag_a', 'flag_b'])` runs one query with `IN`.
- Where do tenant-default feature flags live (the "global rollout" state)? Either a `global_feature_flags` table or a NULL `tenant_id` row in `tenant_feature_flags` (cleaner: separate table to avoid the F5.3 null-tenant write pattern).

### Effort

`[inferred]` 3-4 engineer-weeks across the four phases.

### 5-axis score

- Customer pain reduction: 3 (no visible UX change; internal dev velocity gain)
- Engineering complexity: 4 (mechanical migration plus handler sweep)
- Reversibility: 7 (each phase is independently reversible)
- Time-to-ship: 4 (3-4 weeks)
- Strategic moat: 2 (table stakes architecture cleanup; not a sales story)

### Deep-dive prompt

Audit every column on `tenant_settings` today: enumerate via `psql -c "\d+ tenant_settings"` on a fresh Supabase project after running all 103 migrations. For each column, classify as (a) scalar tenant-wide setting that stays, (b) connector secret that moves to `tenant_connector_settings`, (c) boolean feature flag that moves to `tenant_feature_flags`, (d) JSONB document that moves to `tenant_settings_documents`. Estimate the migration row count: how many `tenant_settings` rows exist today (likely small, maybe 50-200 tenants in dev/staging), and how big the backfill is. Plan the rollout to avoid any flag-flip blackout window during phase 3 column drops.

## 24. Finding F5.26 — Cross-tenant secondary-key reuse risk: 277 tables reference `tenants(id)`, IDOR risk via UUID reuse (P2)

`[verified-on-main]` `grep -rnE "uuid not null references tenants" /Users/kenith.philip/anvil/supabase/migrations/*.sql | wc -l` returns **277** declarations. That is the spine of Anvil's multi-tenancy: 277 tables nail a `tenant_id` column to `tenants(id)`. Almost every business table has it.

`[verified-on-main]` Cross-tenant FK references (one row points to two tenants) exist exactly once on main: `value_chain_relationships` in `supabase/migrations/101_brsr_value_chain.sql:158-175` has both `supplier_tenant_id` and `buyer_tenant_id`. This is finding F5.19; the design is deliberate.

`[verified-on-main]` Anvil uses `uuid_generate_v4()` for almost all surrogate keys (`grep -rnE "default uuid_generate_v4" /Users/kenith.philip/anvil/supabase/migrations/*.sql | wc -l` returns approximately 230 occurrences). UUIDv4 is 122 bits of randomness, collision probability negligible across tenants.

### Problem

The risk surface is not literal collision (122 bits is fine). The risk is IDOR via guessable or leaked id:

1. **The application layer assumes a UUID is tenant-scoped because `(tenant_id, id)` is the practical primary key.** If a handler omits `.eq("tenant_id", ctx.tenantId)` and trusts `.eq("id", body.id)` alone, the row from another tenant is returned. Tested in F5.4 sampling: handlers do scope, but the invariant is per-query.
2. **IDs leak via foreign keys and audit logs.** `audit_events.object_id` is a `uuid` column; an export to one tenant contains UUIDs that, when guessed across tenants, may match another tenant's row. Today the FK constraint does not enforce "object_id belongs to my tenant" because audit_events references many object types polymorphically.
3. **The `tenants(id)` UUID itself is exposed in URLs and JWT headers.** A tenant's UUID is not a secret. An attacker who knows tenant B's UUID could craft `x-obara-tenant: <B's UUID>` and rely on the handler's tenant check. The auth gate (F5.4 references `_lib/auth.js:90-94`) returns 403 on tenant-header mismatch, so this is mitigated.

The interesting risk is (1) for `update` and `delete` paths where the row's existing `tenant_id` is not changed by the operation. If a handler does:

```js
await svc.from("orders").update({ status: "shipped" }).eq("id", body.id);
```

without `.eq("tenant_id", ctx.tenantId)`, an attacker who can submit any UUID gets cross-tenant write capability. The id is not secret; it can be found via order-listing pagination, leaks from email subject lines, prior screenshot in a support ticket.

### Current state on main

- 359 handlers under `src/api/` (F5.4 verified).
- 889 `.eq("tenant_id", ...)` calls (F5.4 verified).
- Average 3 tenant-scopes per handler. Variance is unknown without per-handler audit.
- Sample audit in F5.4 §6 found 8 handlers scoped correctly. Sample size is small; absence of a leak in the sample is not evidence of safety across all 359.
- Postgres backstop: `tenant_id` columns are typically `not null`, but no `CHECK (tenant_id = current_tenant_ids())` is installed (that would require a SECURITY DEFINER function call from a CHECK, which Postgres allows but is awkward).
- RLS backstop (F5.2): policies on the JWT-claim dialect are dead-on-arrival under user JWT; the service role bypasses all of them. So the only enforcement layer is the JavaScript `.eq()` call.

### Competitor state

- **Auth0** uses scoped IDs (`org_xxx`, `client_xxx`) with the org as a prefix; collisions are impossible and IDOR is harder.
- **Stripe** uses prefixed IDs (`cus_`, `ch_`, `acct_`) but the value after the prefix is opaque random; the prefix gives type-safety, not tenant-safety. Tenant-safety is enforced at the API layer with idempotent account-scoping.
- **Linear** uses workspace-prefixed slugs in URLs (`linear.app/<workspace>/issue/PROJ-123`) so cross-workspace links surface the workspace upfront; the API still authorizes per-workspace.

Anvil's design (raw UUIDs everywhere) is closer to Stripe's; the absence of prefixes is a missed type-safety opportunity but not a security flaw on its own.

### Adjacent insight

`[inferred]` The eight-handler sample in F5.4 §6 covered `orders`, `customers`, `audit_events`, `tally_voucher_records`, `tenant_members`. None of those is a write path that an unauthenticated attacker can reach with an arbitrary `id`. The high-risk handlers are the ones that take a UUID from a URL path and trust it without re-checking tenancy. Audit candidates:
- `src/api/documents/[id].js` (path parameter is a document UUID)
- `src/api/orders/[id].js` (path parameter is an order UUID)
- `src/api/customers/[id].js`
- Any `/api/.../[id]` handler

A static-analysis sweep that flags every `req.query.id` or `req.params.id` reaching a `svc.from(...)` call without an intervening `.eq("tenant_id", ...)` would find the regressions early.

### Research insight

`[inferred]` Two complementary defenses:

1. **Composite primary keys.** Migrate to `(tenant_id, id)` composite primary keys where the schema allows. PostgREST's auto-routing would then require both, eliminating single-id leaks. The cost is rewriting every FK reference and every join condition.
2. **Tenant-prefixed external IDs.** Generate `XXXX-<uuid>` where `XXXX` is the tenant's 4-letter slug. URLs become self-describing. Cross-tenant calls are visually obvious.

Both are big changes. The cheaper short-term defense is the static-analysis sweep.

### Proposed change

1. **Static analysis script** `src/scripts/audit-id-handlers.mjs`: walk every `src/api/**/*.js`, look for `req.query.id`, `req.params.id`, `body.id` (and common variants) flowing into a `svc.from(...)` chain. Flag chains missing `.eq("tenant_id", ...)`. Run in CI; fail build on new regressions.
2. **Tenant-scoped query helper** `tenantScoped(svc, table, ctx)`: returns a builder pre-filtered by `tenant_id`. Migrate the highest-traffic handlers first.
3. **Composite primary key pilot** on `audit_events`: switch primary key from `id bigserial` to `(tenant_id, id)`. Measure write throughput, observe whether downstream code breaks (probably yes; audit_events.id is referenced in export endpoints).

### User-facing behavior

Transparent.

### Technical implementation

The static-analysis script is the immediate ship:

```js
// src/scripts/audit-id-handlers.mjs (sketch)
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

const ROOT = path.resolve('src/api');
const issues = [];

function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.js')) check(p);
  }
}

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parse(src, { sourceType: 'module' });
  traverse.default(ast, {
    CallExpression(p) {
      // Detect svc.from('<table>').(select|update|delete)(...) chains
      // that do NOT include .eq("tenant_id", ...).
      // Emit issue with file:line if id from request flows in.
    },
  });
}

walk(ROOT);
if (issues.length) { console.error(issues.map(i => `${i.file}:${i.line} ${i.msg}`).join('\n')); process.exit(1); }
```

### Integration plan

- Phase 1 (3 days): write the script; run against today's tree; classify findings; file fixes.
- Phase 2 (1 week): land the `tenantScoped()` helper; migrate top 20 handlers.
- Phase 3 (ongoing): every PR runs the script in CI.

### Telemetry

- CI failure count when the script lights up.
- Per-handler "tenant-scoped" boolean tracked in a generated `docs/handlers-status.md`.

### Non-goals

- Composite primary keys everywhere immediately. Pilot on `audit_events` only.
- Tenant-prefixed external IDs. Defer until the team has bandwidth.
- Replacing PostgREST with a custom API gateway. Anvil already uses Vercel handlers, not PostgREST, for business logic; PostgREST exposure (F5.13) is a separate concern.

### Open questions

- How well does the AST-walker handle dynamic table names (`svc.from(tableName).select()` with `tableName` computed)? Likely needs to fall back to taint analysis or grep heuristics.
- What about `rpc()` calls (Postgres function invocations)? Those need a different audit because the tenant scope is inside the function body, not in the JavaScript chain.

### Effort

`[inferred]` 1-2 engineer-weeks for the script + initial fix sweep. Ongoing: low cost in CI.

### 5-axis score

- Customer pain reduction: 6 (prevents the next cross-tenant leak)
- Engineering complexity: 5 (AST analysis is non-trivial but bounded)
- Reversibility: 8 (script is a CI guard; can be disabled)
- Time-to-ship: 7 (1-2 weeks)
- Strategic moat: 4 (defensive infrastructure; not differentiated)

### Deep-dive prompt

Build the `audit-id-handlers.mjs` static-analysis tool: AST-walk `src/api/**/*.js`, identify every `req.query.id`, `req.params.id`, `body.id` (and aliases) flowing into a Supabase `from(...)` chain. Flag chains lacking `.eq("tenant_id", ...)`. Compare findings against the existing `src/scripts/audit-write-paths.mjs` (if it exists) to avoid duplication. Run against today's tree; classify findings by severity (`update`, `delete`, `select` in decreasing priority). Output a PR sweep plan. Reference Babel parser docs (https://babeljs.io/docs/babel-parser) and prior art in `eslint-plugin-security` for IDOR-style detectors.

## 25. Finding F5.27 — Migration 100 (conformal_intervals) uses JWT-claim dialect; RLS dead-on-arrival like the other 62 (P2)

`[verified-on-main]` `supabase/migrations/100_inventory_conformal_intervals.sql:126-133`:
```sql
alter table conformal_calibration_residuals enable row level security;
drop policy if exists "ccr_select" on conformal_calibration_residuals;
drop policy if exists "ccr_modify" on conformal_calibration_residuals;
create policy "ccr_select" on conformal_calibration_residuals
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
create policy "ccr_modify" on conformal_calibration_residuals
  for all using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid)
  with check (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
```

This is the JWT-claim dialect from F5.2. The `request.jwt.claims->>'tenant_id'` value is never populated in Anvil's JWTs. Under user-JWT calls via PostgREST, both policies evaluate `null::uuid = tenant_id` which is false. The RLS surface is dead-on-arrival.

`[verified-on-main]` `supabase/migrations/101_brsr_value_chain.sql` and `supabase/migrations/102_aa_treds_sandbox.sql` and `supabase/migrations/103_template_marketplace.sql` continue the same pattern. The four most recent business-feature migrations all install JWT-claim RLS without any matching auth hook.

### Problem

This is the same problem as F5.2, but the finding is worth restating in the v2 report because:

1. **The pattern continues to ship.** F5.2 documented 63 migrations using JWT-claim. As of migration 100 (post-audit), the team continues to add new migrations in the same shape. Without an architectural decision to unify, every future bet migration extends the dead surface.
2. **Conformal intervals contains forecast residuals**, which are statistical fingerprints of a tenant's demand pattern. Leakage via PostgREST direct call would expose forecasting accuracy, demand volatility, and indirectly the tenant's customer base size. Today no leakage occurs because the service-role bypass intermediates everything; the moment a future engineer adds a "tenant analytics dashboard" that calls PostgREST directly, the RLS doesn't catch the bug.
3. **The conformal cron is service-role** (`src/api/cron/conformal-calibration-weekly` or similar; not directly verified in this pass, but follows the project convention). The cron writes residuals via service role with explicit `.eq("tenant_id", ...)`. The RLS layer would not catch a bug there.

### Current state on main

- Migration 100 installs the policies as above.
- No subsequent migration patches them.
- No auth hook ever populates the JWT claim `tenant_id`.
- `current_tenant_ids()` exists (migration 001) and would work; migration 100 chose not to use it.

### Competitor state

Same as F5.2. Supabase's documented best practice (https://supabase.com/docs/guides/auth/auth-hooks#hook-custom-access-token) is to register a `custom_access_token` hook that injects the tenant id at sign-in. Anvil installs no such hook.

### Adjacent insight

`[inferred]` The migration team is following a template. Every new bet migration copy-pastes the JWT-claim policy shape from an earlier migration. This is fine if the dialect were correct; it amplifies the bug because there is no single source of truth to fix.

The fix surface for this finding is small:
- Pick the dialect (either `current_tenant_ids()` or JWT-claim with an auth hook).
- Update the bet template doc in `docs/STRATEGIC_BETS_TEMPLATE.md` (or whatever file the bet authors copy from).
- Optionally install a CI guard that grep-fails the build when a new migration uses the wrong dialect.

### Research insight

`[inferred]` The JWT-claim dialect has one advantage worth naming: it avoids the `current_tenant_ids()` function call cost on every RLS evaluation. Supabase's RLS performance guide (https://supabase.com/docs/guides/database/postgres/row-level-security#performance) benchmarks a similar pattern: `auth.uid()` cached vs. uncached, where the wrapped-in-select form (`(select auth.uid())`) is 1000x faster than the bare form. The equivalent for Anvil is `(select current_tenant_ids())` vs. bare `current_tenant_ids()`. The bare form gets re-evaluated per row; the select-wrapped form gets cached for the statement. So if the team picks `current_tenant_ids()`, the template should always wrap it in `(select ...)`.

### Proposed change

1. **Migration `104_rls_dialect_decision.sql`** (or whichever number): a single migration that converts every JWT-claim policy to `(select current_tenant_ids())`. Use a DO block with `pg_policy` enumeration so the conversion is idempotent. Approximate size: 500-800 SQL lines.
2. **Bet template doc update**: the canonical RLS shape for new tables becomes:
   ```sql
   alter table <new_table> enable row level security;
   create policy <new_table>_select on <new_table>
     for select using (tenant_id in (select current_tenant_ids()));
   create policy <new_table>_modify on <new_table>
     for all using (tenant_id in (select current_tenant_ids()))
     with check (tenant_id is not null and tenant_id in (select current_tenant_ids()));
   ```
3. **CI guard**: `src/scripts/audit-rls-dialect.mjs` walks `supabase/migrations/*.sql` and fails if it finds `current_setting('request.jwt.claims', true)` outside the conversion migration.

### User-facing behavior

Transparent. The application never exercises RLS at the user-JWT layer today; nothing breaks. The change is preventive.

### Technical implementation

The conversion migration uses `pg_policies` to walk every existing policy:

```sql
-- Migration 104_rls_dialect_unify.sql (sketch)
do $$
declare
  r record;
  new_using text;
  new_check text;
begin
  for r in
    select schemaname, tablename, policyname, cmd, qual, with_check
      from pg_policies
     where qual like '%current_setting(''request.jwt.claims''%'
        or with_check like '%current_setting(''request.jwt.claims''%'
  loop
    new_using := replace(r.qual,
      '(current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid',
      '(select current_tenant_ids())');
    new_check := replace(r.with_check,
      '(current_setting(''request.jwt.claims'', true)::json->>''tenant_id'')::uuid',
      '(select current_tenant_ids())');
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if r.cmd = 'SELECT' then
      execute format('create policy %I on %I.%I for select using (%s)',
        r.policyname, r.schemaname, r.tablename, new_using);
    elsif r.cmd = 'ALL' then
      execute format('create policy %I on %I.%I for all using (%s) with check (%s)',
        r.policyname, r.schemaname, r.tablename, new_using, new_check);
    end if;
  end loop;
end $$;
```

This is sketch quality; the production version needs careful handling of `tenant_id = ...` vs `tenant_id in ...` and the eight `tenant_id is null OR` policies from F5.3.

### Integration plan

- Phase 1 (3 days): write the conversion migration and the CI guard.
- Phase 2 (1 day): smoke-test on a fresh Supabase project (run migrations 001-100 plus the conversion, then run the Anvil test suite).
- Phase 3 (1 day): land in main, update the bet template doc.

### Telemetry

- `rls_dialect_mismatch_count` gauge: walks `pg_policies` daily and reports any leftover policies using the JWT-claim dialect. Alert when > 0.
- CI green/red signal.

### Non-goals

- Installing the Supabase auth hook to populate `tenant_id` in JWTs. That is the alternative dialect choice; this finding picks `current_tenant_ids()`.
- Migrating the eight `tenant_id is null OR` policies (F5.3). Separate finding.
- Switching to RESTRICTIVE policies (F5.2 §4 last bullet). Separate finding.

### Open questions

- Does `current_tenant_ids()` returning a set play correctly with `(select ...)` caching? Supabase's perf doc benchmarks `(select auth.uid())` where the function returns a scalar; for a set-returning function, the wrapping is `(select array_agg(t) from current_tenant_ids() t)` or `IN (select current_tenant_ids())`. The latter is what the bet template uses; confirm the planner caches it.
- What is the impact on Supabase's own internal queries (storage, auth)? Those use their own schemas (`storage`, `auth`) which Anvil's policies don't touch.

### Effort

`[inferred]` 1 engineer-week including the migration, the CI guard, the doc, and the smoke test.

### 5-axis score

- Customer pain reduction: 5 (preventive; current symptoms zero because of service-role bypass)
- Engineering complexity: 4 (one big migration, mechanical conversion)
- Reversibility: 6 (the conversion is one-way in spirit; reverting means re-running the original migrations)
- Time-to-ship: 7 (1 week)
- Strategic moat: 3 (defensive architecture cleanup)

### Deep-dive prompt

Execute the dialect-unification migration end-to-end: enumerate every policy using `current_setting('request.jwt.claims', true)::json->>'tenant_id'` (run `grep -rnE "current_setting.*request\.jwt\.claims" /Users/kenith.philip/anvil/supabase/migrations/*.sql`). For each, decide whether the policy applies to a tenant-scoped table, a global-shared table (like `customer_format_templates_global`), or a special case. Draft the conversion migration in `supabase/migrations/104_rls_dialect_unify.sql`. Run on a fresh Supabase project; verify `pg_policies` shows zero JWT-claim references afterward. Document why `current_tenant_ids()` was picked over the alternative (the alternative requires installing a Supabase auth hook plus a key rotation on every JWT issuer; the picked path requires no infrastructure change). Reference Supabase RLS perf guide (https://supabase.com/docs/guides/database/postgres/row-level-security#performance).

## 26. Additional deep-dive prompts for the v2 pass

21. **Audit chain HMAC end-to-end design.** Stage the per-tenant chain trigger (F5.23). Build the `audit_chain_heads` table, the SECURITY DEFINER trigger, the verify endpoint, the S3 Object Lock mirror, and the rotation tooling. Benchmark write latency under 1k inserts/sec/tenant. Document the failure modes (head-row contention, secret rotation, partial chain after migration). Reference AWS QLDB (https://docs.aws.amazon.com/qldb/latest/developerguide/verification.html) and the Trillian transparency log design (https://transparency.dev/) for comparison.

22. **Soft-delete sweep plan.** Run `grep -rnE "\.delete\(\)" /Users/kenith.philip/anvil/src/api/` to enumerate every hard-delete call site. Classify each as routine (move to soft-delete) or statutory (gate behind erasure endpoint). Draft the migration for `deleted_at` on the top 10 tables. Write the `softDelete()` helper. Write the lint rule that blocks raw `.delete()` outside the helper. Build the admin "Trash" view in `src/v3-app/views/admin/trash`. Test the 30-day GC cron under load.

23. **Static-analysis tenant-scope auditor.** Build `src/scripts/audit-id-handlers.mjs` (F5.26 spec). AST-walk every `src/api/**/*.js`, flag every Supabase chain that takes a request id without an intervening `.eq("tenant_id", ...)`. Run against today's tree, classify findings, file fixes. Wire into CI. Document tolerable false-positive rate.

24. **RLS dialect unification migration.** Execute F5.27. Walk `pg_policies`, rewrite every JWT-claim policy to `(select current_tenant_ids())`. Smoke-test on a fresh Supabase project. Land in main. Update the bet template doc and add the CI guard. Re-verify the eight `tenant_id is null OR` write policies (F5.3) are still hardened after the rewrite.

25. **`tenant_settings` JSONB and column-sprawl split.** Land the four-table split: `tenant_settings` (small scalars), `tenant_connector_settings` (per-connector with secrets), `tenant_feature_flags` (per-flag rollout state), `tenant_settings_documents` (JSONB blobs). Backfill from the current 110-column shape. Migrate handlers to use the new helpers. Drop the migrated columns. Add the CI guard against re-growing `tenant_settings`.
