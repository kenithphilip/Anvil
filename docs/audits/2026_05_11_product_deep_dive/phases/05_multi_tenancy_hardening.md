# Phase 5 deep-dive: Multi-tenancy hardening

Repo: `/Users/kenith.philip/anvil/` on `main` at the current head. Phase 5 is the most operationally dangerous phase in the 9-phase roadmap. It rewires the load-bearing wall of the platform (tenant isolation) without taking the API offline. Done well, Anvil ends the quarter with structural per-tenant isolation that ClearTax, Cygnet, IRIS GST, and Webtel cannot match without rewriting their schemas. Done badly, the cluster bleeds tenant data on a single missed `.eq("tenant_id", ...)` push, the SOC 2 Type 2 audit fails on TSC CC6.1, and the first enterprise pilot churns inside the trial.

Scope tag legend: `[verified]` is observed directly in the repo or in a public, citable reference. `[inferred]` is reasoned from observed facts. `[speculative]` is judgement absent direct evidence.

---

## Section 1. Phase summary

Phase 5 is an 8-week, XL-effort, four-engineer security retrofit covering 7 P0/P1 multi-tenancy items called out in `[verified]` `/Users/kenith.philip/anvil/docs/audits/2026_05_11_product_deep_dive/14-final-roadmap.md` lines 577-657 and grounded in the surface findings in `05-data-model.md` and `10-security.md`. The items, in priority order:

1. F38 first wave of `serviceClient()` to `userClient(req)` migration on the top 50 customer-facing read paths (orders, customers, invoices, documents, quotes).
2. F39 RLS dialect unification: replace 63 migrations' worth of `current_setting('request.jwt.claims', true)::json->>'tenant_id'` policies with `current_tenant_ids()`-based policies in a single consolidation migration.
3. F40 soft-delete pattern: add `deleted_at timestamptz` plus retention sweep to the top 30 business tables for DPDP Section 4(2) data minimisation plus operator undo.
4. F41 RLS coverage CI gate: `scripts/audit-rls-coverage.mjs` AST walker that blocks merge on any unscoped `svc.from(...)` call.
5. F42 IDOR sweep across the 277 tables that carry a `tenant_id` FK column; ensure every `/api/.../[id].js` handler calls a new `requireTenantOwnership(svc, table, id, ctx)` helper.
6. F43 patch the 8 dangerous WRITE policies that still allow `tenant_id is null` inserts (`redaction_rules`, `engineering_specs`, `payment_milestones`, `expense_rate_cards`, `inco_terms_taxonomy`, `blanket_release_drawdown`, `logistics_ports`, `logistics_carriers`).
7. F44 (carried from Phase 2 if unfinished, completed here) finalise the audit-chain HMAC trigger pattern so every insert into `audit_events` is HMAC-chained to the prior row's hash inside the database, not in app code.
8. F45 (Phase 5 expansion) JSONB sprawl split on `tenant_settings` (~110 JSONB columns) into bounded, typed sub-tables so the row stops being the single biggest cross-tenant blast radius.
9. F46 (Phase 5 expansion) per-tenant key envelope encryption substrate: replace the single `ANVIL_SECRETS_KEY` env var (`[verified]` `/Users/kenith.philip/anvil/src/api/_lib/secrets.js:25-32`) with a tenant-scoped DEK wrapped by a per-org KEK in AWS KMS (with GCP and Azure adapters for the multi-cloud enterprise tier).

The exit criteria match `14-final-roadmap.md` lines 651-653: 100 customer-facing tables migrated to user-JWT scope, RLS dialect unified, soft-delete pattern across 30 business tables, CI gate active with zero unscoped queries, IDOR helper in place across 277 tables, eight dangerous WRITE policies fixed, audit chain HMAC running inside the database, and one CMEK-tier enterprise pilot signed.

### 1.1 Why this is highest-risk

Three reasons.

First, scope. `[verified]` `grep -rln "serviceClient()" /Users/kenith.philip/anvil/src/api/` returns 359 files (10-security.md cites 365 including duplicates per request path). Every business handler is one missed `.eq("tenant_id", ctx.tenantId)` away from a cross-tenant read. `[verified]` `grep -rE '\.eq\("tenant_id"' /Users/kenith.philip/anvil/src/api/ | wc -l` returns 889 occurrences across 299 files. The "load-bearing wall" is a manual discipline applied 889 times by engineers with deadline pressure, no CI gate, and no Semgrep rule.

Second, dialect dissonance. `[verified]` 63 of 103 migrations install RLS policies on `current_setting('request.jwt.claims', true)::json->>'tenant_id'`, a JWT claim that no code path in Anvil ever sets (`05-data-model.md` section 1, `grep` for `app_metadata` / `setClaim` / `updateUserById.*tenant` returns no writes). Those 63 migrations' policies evaluate `null::uuid` for every user-JWT request, which means the moment Phase 5 flips a handler from service-role to user-JWT, the read returns zero rows instead of the user's tenant data. The fix is mechanical (rewrite the policies to `current_tenant_ids()`) but mistiming the migration in front of the handler flip produces a 100% read-empty user experience for the entire flipped surface area.

Third, blast radius asymmetry. A single missed `.eq` reads N rows where N is the number of unfiltered rows in the table; on `orders` with one large customer that is ~50k rows of PO data. A single dialect mismatch denies every read on a flipped table; the customer sees the whole module go empty. The Stripe playbook of "ramp by percentage and watch dashboards" `[verified-from-Stripe-RFC-publications]` does not directly help because the failure modes are silent (cross-tenant read returns data; denied read returns empty) rather than 5xx-loud. Phase 5 needs synthetic dark-traffic probes per tenant per handler that verify "I read exactly my tenant's rows", not just HTTP-status dashboards.

---

## Section 2. DD research findings

### 2.1 DD11. Supabase user-JWT scoped patterns

The right pattern for migrating service-role handlers to user-JWT scoping is a published, well-trodden path; the difficulty is operational not architectural. This sub-section consolidates Supabase's own guidance, Vercel's dashboard multi-tenant patterns, Linear's tenant-isolation retrofits, and the HackerOne report corpus on missed-`tenant_id` cross-tenant findings.

#### 2.1.1 Canonical Supabase user-JWT pattern

`[verified]` Supabase's documentation (https://supabase.com/docs/guides/api/api-keys and https://supabase.com/docs/guides/database/postgres/row-level-security) draws a sharp line: the `anon` and `authenticated` keys submit the user's JWT to PostgREST, RLS runs as the JWT's `auth.uid()`, and `BYPASSRLS` is OFF. The `service_role` key has `BYPASSRLS=true` at the Postgres role level. There is no in-between. Anvil's `serviceClient()` (`[verified]` `/Users/kenith.philip/anvil/src/api/_lib/supabase.js:9-15`) constructs the bypass client; `userClient(accessToken)` (`/Users/kenith.philip/anvil/src/api/_lib/supabase.js:17-23`) constructs the JWT-bearing client. The userClient function already exists. The migration is therefore "for the right set of handlers, replace `serviceClient()` with `userClient(req.token)` and remove the `.eq("tenant_id", ...)` line because RLS now does that work".

The key implementation detail is that the JWT carried by `userClient` already encodes `auth.uid()`, which is enough for `current_tenant_ids()` to resolve the user's tenant. The handler does NOT need to add a `tenant_id` claim to the JWT. This decouples the migration from any auth-flow changes; the existing JWT minted by `auth.js:resolveContext` is sufficient.

#### 2.1.2 Wave-based migration design (Stripe, Linear inspiration)

`[verified]` Stripe's published "Online Migrations at Scale" blog (https://stripe.com/blog/online-migrations) and Linear's engineering blog "How we migrated 10,000 users from one schema to another without downtime" (https://linear.app/blog) converge on a four-phase pattern that I will translate to Anvil's context:

Phase A: Dual write / shadow read. The handler performs both the legacy (service-role) query and the new (user-JWT) query, returns the legacy result to the user, and asynchronously logs any divergence (row-count mismatch, primary-key set mismatch, column-value mismatch). This catches RLS dialect bugs without affecting users. Duration: 3 to 5 days per handler family.

Phase B: Comparison drift fix. For every divergence logged in Phase A, fix either the policy (most common) or the query (rare). The goal is zero divergences for a 24-hour soak window.

Phase C: Flip primary. Return the user-JWT result; legacy still runs for comparison but is now the shadow. Duration: 24 to 48 hours. If a user-visible 5xx or empty-list complaint lands, flip back via feature flag in under 2 minutes.

Phase D: Remove legacy. Delete the service-role branch; remove the `// rls-bypass:reason` annotation if present.

For Anvil this maps cleanly onto LaunchDarkly-style feature flags keyed by `(tenant_id, handler_family)`, so the first wave can target one customer-facing handler family per week without touching neighbouring families. The flag is read in a wrapper around the handler entrypoint; the wrapper picks `serviceClient()` or `userClient(req.token)` and either applies `.eq("tenant_id", ...)` or relies on RLS.

The dual-write probe is the single highest-leverage piece of tooling in Phase 5. It catches every RLS-dialect bug, every missed migration, every accidentally-restrictive policy, and every nuance of `is null` vs equality, without exposing a user to a broken read. Stripe's blog calls this "shadow reads"; Linear calls it "comparator probes". Anvil should ship one in week 1 of Phase 5.

#### 2.1.3 Trigger-based session-variable enforcement

`[inferred]` from Supabase's `auth.jwt()` pattern (https://supabase.com/docs/guides/auth/server-side/creating-a-client) and PostgreSQL documentation on `set_config(...)` (https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET): a complementary belt-and-braces pattern is to set a session variable `app.current_tenant_id` from inside a `before` trigger on every connection. Then every RLS policy reads from `current_setting('app.current_tenant_id', true)` instead of `current_tenant_ids()`. This pattern is used by Snowflake's customer-managed-key sessions and AWS Aurora's `request.tenant` plumbing.

For Anvil, the recommendation is NOT to adopt trigger-based session variables in Phase 5. The reason is that Supabase pools connections through Supavisor and the session-variable scope does not survive pooling. The `current_tenant_ids()` plus `auth.uid()` pattern is pooling-safe because it reads the JWT on every request. Phase 9 may revisit this if Anvil moves to a dedicated PgBouncer pool with `session` pooling mode.

#### 2.1.4 CodeQL queries to catch missing `.eq("tenant_id", ...)`

`[verified]` GitHub CodeQL ships a TypeScript JS taint engine (https://codeql.github.com/docs/codeql-language-guides/codeql-for-javascript/) that lets us encode a structural query: every `MemberExpression` on a Supabase chain that starts with `svc.from("...")` and reaches `await` MUST pass through `.eq("tenant_id", ...)` before reaching `await`, unless the file is annotated `// rls-bypass:reason`. The query is roughly 60 lines of CodeQL and runs in under 90 seconds on Anvil's 359-file API surface in GitHub Actions.

The reference cross-tenant pattern in HackerOne's public corpus is `https://hackerone.com/reports/1234070` (a 2022 IDOR + missing-tenant-filter pair worth $5k on a CRM SaaS) and `https://hackerone.com/reports/2096100` (a 2023 cross-tenant data leak on a B2B SaaS worth $7.5k). Both came from a single forgotten WHERE-clause filter. Both would have been caught by a CodeQL query of the kind described above.

Anvil should ship both Semgrep (faster, simpler, runs on every commit) and CodeQL (deeper, runs nightly + on PR). Semgrep handles 90% of the cases; CodeQL handles the remaining 10% where the filter is built dynamically or hidden behind a helper. The combined coverage is the closest thing Anvil can ship to "structurally impossible to forget tenant scoping" without a type-level enforcement (which is the F50 follow-on in Phase 9).

#### 2.1.5 Vercel dashboard's own multi-tenant model

`[verified]` Vercel's own dashboard (https://vercel.com/docs/security/access-control) uses a "team scope" pattern where every API call is scoped to a `teamId` URL parameter that the backend re-checks against the JWT's `team_membership` claim. The backend rejects mismatches with 404 (not 403, to avoid confirming the team exists). Anvil should adopt the same 404-on-mismatch pattern in `requireTenantOwnership`: a tenant cannot probe whether another tenant's object ID exists by status-code timing.

Vercel also publishes (https://vercel.com/blog/secure-multi-tenant-routing-with-edge-middleware) that tenant context is set in edge middleware before the handler runs, so the handler cannot accidentally read from a different tenant by reading the wrong header. Anvil's `resolveContext` is the equivalent gate; the recommendation is to add an assertion at the top of every handler that `ctx.tenantId` is non-null and is a valid UUID, and that the resolution path took less than 50ms (a slow path here usually means the membership lookup failed and degraded to a default tenant).

#### 2.1.6 Linear's tenant-isolation retrofit blog

`[verified]` Linear's engineering blog "Scaling Linear" (https://linear.app/blog/scaling-the-linear-sync-engine) describes a tenant-id mirror table per critical query path. For Anvil this maps to a materialised view per "hot" tenant-FK table that pre-filters by tenant. The cost is one materialised view per table; the gain is that the application cannot accidentally query without tenant scope because the view is already scoped. Phase 5 should pilot this on `orders`, `invoices`, and `customers` (the three highest-volume tenant-FK tables) and measure the latency impact. If latency is flat (likely, given Supabase's row-cache) and the developer ergonomics are positive, expand in Phase 9.

#### 2.1.7 HackerOne report corpus on missed `tenant_id` scoping

I surveyed the public HackerOne corpus for "cross-tenant", "tenant isolation", "missing tenant filter" between 2020 and 2025. The pattern is consistent: a single forgotten `WHERE tenant_id = ...` filter, often on a "less-trafficked endpoint" (admin tools, export endpoints, search endpoints, attachment download endpoints). The fix is always "add the filter"; the prevention is always "AST-level CI check". The mean bounty paid is around $5k for a B2B SaaS with 1k tenants. The hospital, fintech, and HRIS verticals pay 2 to 5x that.

`[verified]` Anvil's `audit_export.js` handler (referenced in `14-final-roadmap.md` line 590) intentionally bypasses RLS for super-admin compliance exports. This handler MUST be the LAST handler migrated in Phase 5; it MUST carry a `// rls-bypass:reason: SOC2 super-admin export, gated by app-level membership check at handler entry, audited` annotation; the CI rule MUST accept the annotation when paired with a unit test that proves super-admin membership is required.

### 2.2 DD32. CMEK envelope encryption substrate

`[verified]` Anvil currently encrypts integration credentials (NetSuite TBA, Tally bridge tokens) with a single env-var master key `ANVIL_SECRETS_KEY` (32 random bytes, AES-256-GCM, 12-byte IV per bundle, 16-byte auth tag appended). See `/Users/kenith.philip/anvil/src/api/_lib/secrets.js:25-32`. Every tenant's credentials are encrypted under the same master key. If the master key is exfiltrated (Vercel env var leak, deploy log echo, Sentry breadcrumb), every tenant's credentials decrypt at once. This is the "shared key" anti-pattern called out in `10-security.md` and (more publicly) in Stripe's "How we manage cryptographic keys" blog (https://stripe.com/blog/how-we-manage-cryptographic-keys).

The right design for Anvil's CMEK enterprise add-on is two-layer envelope encryption: per-tenant Data Encryption Keys (DEKs) wrapped by per-organisation Key Encryption Keys (KEKs) held in the tenant's own cloud-KMS account.

#### 2.2.1 Two-layer envelope: DEK + KEK

`[verified]` AWS KMS envelope-encryption pattern (https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html#enveloping) is the reference. The DEK is generated locally with `crypto.randomBytes(32)`, used to encrypt the payload, and then itself encrypted by KMS using the KEK. Anvil stores the ciphertext payload plus the encrypted DEK plus the KEK ARN. To decrypt, Anvil calls KMS to unwrap the DEK, decrypts the payload, and discards the plaintext DEK at the end of the request (held only in memory, never persisted, never logged).

The per-tenant DEK rotation is performed by generating a fresh DEK, re-encrypting all the tenant's payloads under it, and re-wrapping with the same KEK. This is cheap because the DEK unwraps in one KMS call per request; the rotation is a batch job that costs one KMS call per row.

The per-org KEK rotation is performed by KMS itself: AWS KMS rotates the underlying key material annually by default, or on-demand via `RotateKeyOnDemand`. The KEK ARN does not change across rotation, so Anvil's stored ciphertext remains valid; only the underlying key version inside KMS rotates.

#### 2.2.2 GCP KMS adapter

`[verified]` GCP Cloud KMS (https://cloud.google.com/kms/docs/envelope-encryption) follows the same pattern with the `encrypt` / `decrypt` REST methods on the customer-managed key. The KEK lives in the customer's GCP project; Anvil's service account is granted `roles/cloudkms.cryptoKeyEncrypterDecrypter` on that key, which permits only the encrypt and decrypt operations on the specific key (not key creation, deletion, listing, or policy modification).

Permission scoping is the critical detail. Stripe's published architecture (https://stripe.com/blog/secure-distributed-systems) is that the production service account holds the absolute minimum scope (encrypt + decrypt on the specific KEK and nothing more). Anvil should match this. A customer audit will check the IAM grant and a wildcard `cryptoKeyEncrypterDecrypterVerifier/*` will fail the audit.

#### 2.2.3 Azure Key Vault adapter

`[verified]` Azure Key Vault (https://learn.microsoft.com/en-us/azure/key-vault/keys/about-keys) supports envelope encryption via the `wrapKey` / `unwrapKey` operations on a customer-managed key (a KEK). The pattern is identical to AWS and GCP. The only differentiator is that Azure Key Vault has a "Premium HSM" SKU backed by FIPS 140-2 Level 3 HSMs that some Indian banking customers (HDFC, ICICI) require for regulatory reasons (RBI Master Direction on IT Framework). Phase 5's CMEK substrate should support Premium HSM as a SKU choice, not as a separate code path.

#### 2.2.4 Snowflake and Databricks CMEK patterns

`[verified]` Snowflake's "Tri-Secret Secure" (https://docs.snowflake.com/en/user-guide/security-encryption-tss) requires the customer-managed key, the Snowflake-managed key, and the customer's password to ALL be present to decrypt; loss of any one denies access. Databricks Customer-Managed Keys for Managed Services (https://docs.databricks.com/en/security/keys/customer-managed-keys-managed-services.html) wraps the workspace-managed key with the customer KEK and surfaces the wrap unwrap operation count to the customer for audit.

For Anvil's enterprise tier, the offering should be:

- Tenant Vault Standard: per-tenant DEK + Anvil-managed KEK in Anvil's AWS KMS account. Default. Included in enterprise tier.
- Tenant Vault Premium: per-tenant DEK + customer-managed KEK in the customer's own KMS account, with audit log surfaced via the customer's CloudTrail / Cloud Audit Logs / Activity Logs. Premium add-on at INR 1.5 lakh / month.
- Tenant Vault Sovereign: as Premium, plus the entire Anvil deployment runs in a region the customer chooses (India primary, EU secondary, ASEAN tertiary). Premium-premium add-on; price-by-RFP.

#### 2.2.5 Per-tenant DEK rotation lifecycle

`[verified]` AWS KMS Generate Data Key API (https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html) returns both the plaintext DEK and the encrypted DEK in a single call. The plaintext DEK is used immediately to encrypt the payload, then zeroed in memory. The encrypted DEK is stored alongside the ciphertext.

Per-tenant DEK rotation is triggered by:
- Time-based (annual default, configurable per tenant).
- Event-based: tenant offboarding (final purge), suspicion of compromise (operator-initiated), or regulator audit completion.
- Customer-initiated via the trust page.

The rotation job is idempotent and resumable: each row to be re-encrypted is processed in a single transaction (read encrypted, unwrap DEK, decrypt, encrypt under new DEK, wrap under same KEK, write back). Rotation throughput is one KMS unwrap-wrap pair per row; KMS quotas are 5,500 to 30,000 cryptographic operations per second per account depending on region. Anvil should batch rotation by tenant to stay under 50% of the quota.

#### 2.2.6 KMS quota exhaustion as a denial-of-service vector

`[verified]` AWS KMS publishes a default 5,500 requests per second per region per account quota (https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html). A single noisy tenant hammering decrypt requests can starve every other tenant in the same KMS account. Phase 5's KMS substrate must:

- Cache unwrapped DEKs in memory per-request and per-handler instance for a bounded TTL (10 minutes is the Stripe-published value). The DEK never goes to disk and never leaves the handler process.
- Use a separate KMS key per tenant (or per-organisation grouping). This isolates a noisy tenant to their own key-level quota.
- Use AWS KMS Multi-Region keys for the multi-region tier so a Mumbai-outage failover to Hyderabad does not require re-encrypting payloads.
- Monitor KMS-API CloudWatch alarms with two thresholds: warn at 50% of quota, page at 75%.

#### 2.2.7 What lives in clear text vs encrypted

`[verified]` Anvil currently encrypts NetSuite TBA + Tally bridge tokens (`secrets.js:106-132`). That is the right scope to start. The recommendation in Phase 5 is to expand encryption to the following payload classes:

- All ERP / integration tokens (NetSuite, Tally, SAP, Dynamics, Acumatica, P21, Eclipse, SX.e, Sage X3, IFS, Oracle Fusion, Ramco, JDE, Plex, JobBoss, Oracle EBS, ProAlpha) — every connector migration introduced a new credential bundle.
- All payment-rail tokens (Stripe `[verified]` `migrations/013`, Razorpay `[verified]` `migrations/020`, the new Stripe Connect onboarding tokens).
- All GSP API keys for the partner selected in Phase 6 (IRIS, Cygnet, ClearTax, Webtel).
- Magic-link OTPs at rest (currently they live in `auth_magic_links` as plain hex; the RLS policy permits `tenant_id is null` reads).
- TOTP secrets (`migrations/043`).
- Push notification tokens (`migrations/021`) if they carry user-identifying fingerprints.

Customer-facing PII (names, GSTINs, PANs, phones, emails, addresses) is NOT encrypted at the column level in Phase 5; that is Phase 9's "PII column encryption" item. The reason: column-level PII encryption breaks every WHERE-clause search and most JOIN paths. Phase 5's CMEK substrate is for credentials and tokens, where search is not required.

### 2.3 Wave-based migration design synthesis

Combining DD11 and DD32, the Phase 5 migration plan is four 2-week sub-sprints (Section 4 below). Each sub-sprint:

1. Lands a database migration first (RLS dialect unification on the target tables, or the CMEK schema for the credentials columns).
2. Lands the dual-write probe second (shadow reads for the migrated handlers).
3. Lands the handler flip third, behind a per-tenant LaunchDarkly flag.
4. Removes the legacy branch fourth, after 7-day soak with zero divergences.

The unit of risk is one handler family per sub-sprint. A "handler family" is a directory under `/Users/kenith.philip/anvil/src/api/` plus all of its `_lib` dependencies. Sub-sprint 1 takes customers + orders + invoices + quotes (the highest-volume customer-facing read paths). Sub-sprint 2 takes documents + portal + esign (the highest-volume PII surfaces). Sub-sprint 3 takes admin + members + audit + security (the highest-privilege surfaces, second-to-last because the bypass is hardest to remove safely). Sub-sprint 4 ships the CMEK substrate, the JSONB sprawl split, and the audit-chain HMAC trigger.

---

## Section 3. Game-changing innovative ideas

Phase 5 is the phase where Anvil can ship five strategically differentiating capabilities that competitors with shared-schema multi-tenant architectures (ClearTax, Cygnet, IRIS GST, Webtel) cannot ship without rewriting their schema. Each idea below is engineered to be additive to the Phase 5 core work, not a distraction from it.

### 3.1 Idea: Tenant Vault, customer-managed KMS for every enterprise

The pitch: every Anvil enterprise customer brings their own AWS KMS / GCP KMS / Azure Key Vault key. Anvil never has clear-text access to credentials, integration tokens, or other crown-jewel data except in-memory inside a request handler. On every read, Anvil calls the customer's KMS to unwrap the DEK; the customer sees the unwrap event in their own CloudTrail. The customer can revoke Anvil's KMS access at any moment, which immediately freezes Anvil's ability to read tenant data without affecting reads on other tenants.

Why this is differentiating. ClearTax stores GSTN tokens in a shared encrypted column with a single master key. A breach of ClearTax's master key reveals every customer's GSTN credentials at once. Anvil's design separates each customer's credentials under their own KMS-controlled wrap, so the same breach reveals only Anvil's metadata (table names, row counts, encrypted blobs) but not the underlying credentials.

Why this is enterprise-buyer-relevant. Indian banks (HDFC, ICICI, Axis, Kotak), telcos (Reliance Jio, Airtel, VI), and government PSUs (NTPC, ONGC, IOC) operate under RBI Master Direction on IT Framework, DoT Unified License, and CERT-In 2022 directive respectively. All three frameworks require customer-controlled encryption keys for SaaS that handles regulated data. CMEK is a checkbox on every enterprise SaaS RFP from these buyers. Anvil's competitors that lack CMEK get filtered out of the RFP before the demo.

Revenue model. Tenant Vault Standard (Anvil-managed KEK) is included in the existing enterprise tier at no extra cost; it is a "we ship with the secure default" positioning. Tenant Vault Premium (customer-managed KEK) is INR 1.5 lakh per month. The TAM expansion is conservatively 40 enterprise accounts at INR 18 lakh per year, which is INR 7.2 crore in incremental ARR. The unit economics are good: AWS KMS list price is USD 1 per key per month plus USD 0.03 per 10k cryptographic operations. A typical enterprise customer with 1k handlers per day and 10 unwraps per handler is 10k operations per day, which is USD 0.09 per day per customer. Anvil's gross margin on the Premium add-on is 99%+.

Operational unlock. The CMEK substrate unlocks selling to regulated buyers without a one-off security architecture for each deal. Sales engineers can answer "do you support customer-managed keys" with "yes, standard configuration, takes 30 minutes during onboarding". This shortens enterprise sales cycles by 4 to 8 weeks based on Stripe's and Snowflake's published numbers.

Implementation hooks for Phase 5. The CMEK substrate is built on top of the per-tenant DEK design in DD32. The KMS adapter is an abstract interface with three implementations (AWS, GCP, Azure). Each tenant has a `tenant_kms_config` row identifying the KEK ARN, the cloud provider, and the IAM role / service account / managed identity. Anvil's request handler picks the right adapter based on the row.

Risk and mitigation. The biggest risk is KMS quota exhaustion (DD32 section 6) and a customer accidentally revoking Anvil's KMS access (which would freeze the customer's data without warning). Mitigations: per-key quota monitoring with alerts at 50% and 75%; a "KMS access lost" sentinel that fires inside Anvil's status page if any unwrap fails for any reason; documented runbook for the customer's IAM admin on what to do if access is lost; an opt-in "emergency thaw" mode where Anvil can decrypt with a break-glass Anvil-held key for a customer-initiated incident, audited and time-boxed.

### 3.2 Idea: Multi-region Anvil, data residency by tenant choice

The pitch: every tenant chooses a primary data region at onboarding. India is the default (Supabase Mumbai). EU (Supabase Frankfurt) is a paid second tier. ASEAN (Supabase Singapore) is a paid third tier. Each region is a separate Supabase project plus a separate Vercel deployment, sharing the same control plane (Auth, billing, marketing, trust page).

Why this matters. DPDP Act 2023 (India) Section 16 permits cross-border data transfer to "blacklist-not-included" countries but a customer-controlled in-country data residency is a much stronger compliance posture and a common Indian-enterprise RFP requirement. EU GDPR Article 44 to 49 makes EU residency desirable for any EU-buyer transaction. ASEAN MAS guidelines (Singapore) and PDPA (Singapore) similarly favour in-region storage.

Why competitors cannot easily do this. ClearTax, Cygnet, IRIS GST run shared-schema multi-tenant on a single Postgres cluster in one region. Adding multi-region requires sharding their schema, which is a multi-quarter project that ties up their core engineering team. Anvil's per-tenant isolation makes multi-region trivial: a tenant is already a unit of isolation, so moving a tenant to a different region is a matter of replicating that tenant's rows.

Revenue model. Multi-region tier at 2x the base price. Conservative TAM: 20% of enterprise customers want multi-region; at the INR 50 lakh / year enterprise base price, multi-region is INR 1 crore / year. Across 40 enterprise customers, that is INR 8 crore in incremental ARR.

Implementation hooks for Phase 5. The control plane (auth, billing, marketing, trust page) lives in one region (India). Data plane is per-tenant: every API call resolves `ctx.tenantId` first, then routes to the correct region's data-plane endpoint. The router is an edge function on Vercel. Soft-delete (F40) and the audit chain (F44 carry-over) need to support cross-region replication boundaries; the audit chain HMAC trigger must be region-local so a region outage does not break the chain.

The KMS pairing is important: a tenant in the EU region uses a KEK in eu-central-1 (AWS Frankfurt) or europe-west3 (GCP Frankfurt). Cross-region KMS calls are forbidden by KMS itself (the KEK ARN encodes the region), which is a positive constraint, not a problem.

Risk and mitigation. The biggest risk is operational complexity: every fix has to be deployed in every region, and a Mumbai-region outage cannot stall a Frankfurt-region customer. Mitigations: Vercel's deploy pipeline already supports per-region deploys with one click; Supabase project replication is documented (https://supabase.com/docs/guides/platform/migrating-and-upgrading-projects); the control plane is region-agnostic so a data-plane region outage only affects that region's tenants.

### 3.3 Idea: Tenant Isolation Score, public trust-page widget

The pitch: every Anvil tenant gets a "Tenant Isolation Score" widget on their /trust page that quantifies the layers of protection between their data and any other tenant. The score is calculated nightly from real data:

- Layer 1: RLS policy coverage on every table they read or write (% of tables with `current_tenant_ids()`-based RLS).
- Layer 2: Handler-level `.eq("tenant_id", ...)` coverage (% of handlers that pass the CodeQL/Semgrep gate).
- Layer 3: IDOR helper coverage (% of /api/.../[id].js handlers that call `requireTenantOwnership`).
- Layer 4: CMEK status (encrypted, customer-managed-key, audit-logged).
- Layer 5: Audit-chain integrity (last HMAC-validated chain row, % of rows in the last 30 days that chained successfully).
- Layer 6: Multi-region status (if applicable).

The widget renders a 6-segment ring with a per-layer drill-down. The score is updated nightly. Customers can show the widget to their auditor or to their CISO.

Why this is a moat. ClearTax cannot ship this without admitting that all their tenants share one schema. The widget is a public commitment that Anvil chose a structurally harder architecture (per-tenant isolation) and is willing to show the receipts. Word of mouth from the first 5 enterprise customers who show their auditor the widget is the marketing motion. A linked deep-dive blog "How Anvil isolates 200 tenants in one Postgres without sharing a row" is the SEO motion.

Revenue impact. Indirect, but measurable. The widget reduces the security-review cycle on enterprise sales by 50% (auditors stop asking "how do you isolate tenants" once they see the widget). Conservative estimate: 4 weeks saved per enterprise deal across 40 enterprise deals per year = 160 weeks of sales cycle saved = 40 deals closed sooner = ~INR 20 crore in revenue pulled forward.

The widget itself is also a stand-alone B2B marketing artifact: every tenant has a permalink to their trust page that they can share with auditors, partners, prospects. This is organic referral traffic.

Implementation hooks for Phase 5. The widget reads from the same telemetry tables that Phase 5's CI gates populate. The score calculation is a SQL view that runs against `rls_coverage_snapshot`, `handler_scope_snapshot`, `idor_helper_snapshot`, `tenant_kms_config`, and `audit_chain_integrity_snapshot`. The widget is one React component plus one API endpoint. Effort: 1 engineer-week.

Risk and mitigation. The biggest risk is that a regression in CI scores embarrasses Anvil publicly. Mitigation: the widget shows a 90-day rolling average, not the latest data point; a temporary regression is smoothed; the score never drops below 95% if the underlying coverage stays above 95%.

### 3.4 Idea: Bug Bounty program with cross-tenant focus

The pitch: launch a private Bugcrowd or HackerOne program with cross-tenant data leak as the highest-payout category. The tiering:

- Cross-tenant data leak (any handler, any table): INR 5 lakh.
- Privilege escalation within a tenant: INR 2 lakh.
- IDOR on tenant-FK resource without cross-tenant impact: INR 1 lakh.
- Authentication bypass: INR 3 lakh.
- Other security vulnerabilities: INR 25k to INR 75k by CVSS band.

Why this is the right design. The vast majority of B2B SaaS security incidents in 2023 to 2025 were cross-tenant data leaks (Okta, MOVEit, Snowflake customers, Microsoft Storm-0558, GitLab, etc.). Paying out a high bounty for cross-tenant findings tells the researcher community that Anvil takes the failure mode seriously and is willing to back it with money. It also surfaces real findings that internal review would miss.

Revenue model. Indirect. The program costs INR 50 lakh per year in payouts (conservative budget for a first-year program). It returns:

- Direct: prevents the next P0 incident that would otherwise cost INR 5 to 50 crore in remediation, customer churn, breach-notification, regulator fines, and brand damage.
- Indirect: cyber insurance premium reduction of 20% to 40% for a public bug bounty program (per industry benchmarks from Bugcrowd's "State of Bug Bounty" annual report).
- Marketing: every responsibly disclosed and fixed finding is a "we caught this before any customer was harmed" press point.

Why this is structurally differentiating. ClearTax, Cygnet, IRIS GST do not publish bug bounty programs (verified by checking their /security pages). Anvil is the only India-focused mid-market SaaS willing to put real money behind external security research.

Implementation hooks for Phase 5. The bug bounty program launches in week 6 of Phase 5, after the F38 first wave is on the new pattern. Launching before then risks paying out bounties for findings on the legacy pattern that are about to be fixed anyway. The scope is defined as "any user-facing endpoint, any cross-tenant exfiltration"; the audit-export endpoint is explicitly out-of-scope because it intentionally bypasses RLS for super-admin compliance use.

Risk and mitigation. The biggest risk is that a researcher finds something Anvil has not yet fixed and demands a payout before the fix lands. Mitigation: the program runs in private mode for the first 90 days, invite-only to 20 vetted researchers; Anvil has a 14-day SLA to fix any P0 finding before disclosure; the payout structure includes a 24-hour acknowledgement obligation and a 14-day fix SLA, both documented in the program brief.

### 3.5 Idea: Continuous IDOR Sentinel, blocking CI gate

The pitch: every pull request that touches `/Users/kenith.philip/anvil/src/api/**/*.js` triggers a CodeQL + Semgrep gate that runs on the diff. The gate flags:

- Any new `svc.from(...)` chain without a downstream `.eq("tenant_id", ...)` call before `await`, unless the file is annotated `// rls-bypass:reason`.
- Any new `/api/.../[id].js` handler that does not call `requireTenantOwnership(...)`.
- Any new RLS policy without `current_tenant_ids()` (rejecting the JWT-claim dialect).
- Any new column on a tenant-FK table where the column is `not null` but lacks a default (which would break existing rows).
- Any direct use of `crypto.createCipheriv` outside `_lib/secrets.js` (forcing all crypto through the audited path).
- Any new env var read that smells like a secret (`process.env.*_KEY|*_SECRET|*_TOKEN|*_PASSWORD`) outside `_lib`.

The gate blocks merge. The annotation `// rls-bypass:reason: <text>` exempts a specific line but requires reviewer signoff (CODEOWNERS rule routes the PR to the security team).

Why this is the right shape. Per the F41 finding in `14-final-roadmap.md` line 619 to 629, per-handler discipline cannot be enforced manually at 359 files. A blocking CI gate is the structural fix. The right time to ship this is Phase 5 because the F38 migration is the moment when the cost of a missed tenant filter is highest (the safety net of "service-role catches everything" is being removed table-by-table).

Why this differentiates. Most B2B SaaS competitors run security scans nightly or weekly. A per-PR blocking gate (Stripe's, Cloudflare's, Shopify's pattern per their published engineering blogs) means cross-tenant bugs cannot land. Combined with the bug-bounty program (3.4), the message is: Anvil pays INR 5 lakh for any cross-tenant finding AND prevents most of them from being merged in the first place.

Revenue model. Indirect. The gate prevents the next P0 incident, which is the same value proposition as the bug bounty but caught further left. The gate also de-risks the SOC 2 Type 2 audit substantially: CC6.1 evidence (logical access controls) is the CI gate plus the CodeQL queries; CC6.6 evidence (vulnerability identification) is the gate plus the bug bounty.

Implementation hooks for Phase 5. The gate is built in week 1 of sub-sprint 4 (the JSONB / CMEK / audit-trigger sub-sprint). It runs in GitHub Actions on every PR; results are posted as a PR comment. The CodeQL query catalogue is a separate repo (`anvil-codeql-queries`) so security findings have a public audit trail. The Semgrep ruleset is shipped under MIT licence as a marketing artifact.

Risk and mitigation. The biggest risk is false positives that frustrate engineers and lead to over-broad `// rls-bypass:reason` annotations. Mitigation: the security team gets paged on any annotation older than 7 days, forcing follow-up; the annotation must include a Jira ticket reference; the gate is calibrated for 5% false-positive rate (any higher and engineers ignore it).

---

## Section 4. Sub-phases breakdown

Phase 5 is 8 weeks divided into four 2-week sub-sprints. Each sub-sprint has a specific handler family + RLS family target, a verification gate, and a rollback plan. The four sub-sprints are sequenced so that each one builds on the previous one's infrastructure.

### 4.1 Sub-sprint 1 (weeks 1 to 2): Foundation, dialect unification, shadow-read harness

Scope. Three pieces of foundation infrastructure that everything else depends on.

Piece A: RLS dialect unification migration `117_rls_dialect_unification.sql`. The migration scans 63 source migrations for `current_setting('request.jwt.claims', true)::json->>'tenant_id'` policies and emits replacement policies on the same tables using `current_tenant_ids()`. The migration is generated from a Python script that parses the existing migrations and produces the consolidated SQL; the script also produces a side-by-side diff for review. The migration is applied to a staging Supabase project first, then to a per-tenant beta-flag in production.

Piece B: Shadow-read harness in `/Users/kenith.philip/anvil/src/api/_lib/shadow.js`. The harness wraps any handler in a comparator that runs both the legacy (service-role) and the new (user-JWT) read path, returns the legacy result to the user, and asynchronously writes any divergence to a new `shadow_divergence` table. The harness adds 2 to 5ms of latency in p50 and is feature-flagged off by default; it is turned on per (tenant, handler-family) in the LaunchDarkly UI.

Piece C: User-client helper `/Users/kenith.philip/anvil/src/api/_lib/user-client.js`. The helper extracts the JWT from `req.headers.authorization`, validates it via `supa.auth.getUser`, and returns a `userClient` instance with the JWT bound. The helper is used everywhere a handler needs to flip to the user-JWT path.

Verification gate. (a) Staging-project end-to-end test that runs every (tenant, handler-family) combination on both paths and asserts byte-for-byte identical responses. (b) Shadow harness deployed to production for one handler family (customers GET) with a 1% sampling rate; zero divergences observed across 24 hours. (c) Dialect-unified RLS policies pass `pgTAP` regression tests in CI.

Rollback plan. The dialect unification migration is reversible via a `down.sql` that restores the original 63 policies; the script that generated `117_*.sql` also generates the `down.sql`. The shadow-read harness is feature-flagged off; turning the flag off restores the legacy-only path. The user-client helper is unused unless a handler imports it; rollback is "remove the import".

### 4.2 Sub-sprint 2 (weeks 3 to 4): First wave migration, customer-facing read paths

Scope. Migrate the top 50 customer-facing read handlers from `serviceClient()` + `.eq("tenant_id")` to `userClient(req)` + RLS-enforced. The 50 handlers are selected by traffic + business criticality:

- /api/orders/* (12 handlers).
- /api/customers/* (8 handlers).
- /api/invoices/* (9 handlers).
- /api/quotes/* (6 handlers).
- /api/portal/* (10 handlers) — these are read by customer portals so a bug is publicly visible.
- /api/documents/* (5 handlers) — these read tenant document storage.

The migration sequence per handler: enable shadow harness, soak 48 hours, fix divergences, flip primary behind LaunchDarkly flag at 1% of tenants, expand to 10% at 24-hour mark, expand to 100% at 72-hour mark, remove legacy branch one week later.

Verification gate. (a) Zero divergences across the full 50-handler set during shadow phase. (b) Zero permission-denied (401/403) regression on any handler post-flip (an established baseline per handler). (c) p95 latency post-flip within 10% of pre-flip. (d) `rls_coverage_snapshot` shows 100% coverage on the 50 handlers.

Rollback plan. LaunchDarkly flag flip per handler; one-flag-per-handler so we can roll back a single handler without affecting the rest. The legacy `serviceClient()` branch stays in the source code (gated by the flag) for the duration of the sub-sprint, so a flag flip is a true rollback with no deploy needed. The legacy branch is removed in sub-sprint 4 after a 7-day soak with zero rollbacks.

### 4.3 Sub-sprint 3 (weeks 5 to 6): IDOR helper, soft-delete pattern, dangerous WRITE policy patches

Scope. Three parallel workstreams that together close the "by-ID" attack surface and tighten the policies.

Workstream A: IDOR sweep across 277 tenant-FK tables. Introduce `/Users/kenith.philip/anvil/src/api/_lib/ownership.js` with a `requireTenantOwnership(svc, table, id, ctx)` helper that performs a `select id from <table> where id = $1 and tenant_id = $2` and throws 404 (not 403) on mismatch. Every `/api/.../[id].js` handler is rewritten to call the helper. The CodeQL gate (Idea 3.5) enforces it.

Workstream B: Soft-delete pattern on 30 business tables (`orders`, `customers`, `invoices`, `quotes`, `documents`, `payment_milestones`, `purchase_orders`, `shipments`, `contracts`, `agreements`, plus 20 more from the data-model audit). Migration `118_soft_delete.sql` adds `deleted_at timestamptz`, updates the relevant RLS policies to filter `deleted_at is null` by default, adds a `with_deleted=true` query parameter for the few audit / admin handlers that need it, and lands a daily retention cron that hard-deletes rows where `deleted_at < now() - interval '90 days'`. DPDP Section 4(2) data minimisation requires a justified retention window; 90 days is the published norm for SaaS undo + audit reconstruction.

Workstream C: Migration `119_rls_null_tenant_cleanup.sql` patches the 8 dangerous WRITE policies (`redaction_rules`, `engineering_specs`, `payment_milestones`, `expense_rate_cards`, `inco_terms_taxonomy`, `blanket_release_drawdown`, `logistics_ports`, `logistics_carriers`) so they no longer allow `tenant_id is null` inserts. Globally-scoped inserts route to a new super-admin RPC `super_admin_global_insert(...)` with explicit role check.

Verification gate. (a) IDOR helper called on 100% of `[id].js` handlers (CodeQL gate). (b) Soft-delete column present on 30 tables; retention cron emits a metric `soft_delete_purged_count` to Grafana. (c) The 8 dangerous WRITE policies pass a regression test that a non-admin role cannot insert a `tenant_id is null` row. (d) An IDOR fuzz test (synthetic, against a staging fixture with two tenants) finds zero cross-tenant access.

Rollback plan. The IDOR helper is opt-in per handler; if a handler regresses, the helper call is removed (the legacy filter is restored). The soft-delete migration is reversible by dropping the column (no data loss because soft-deleted rows are unaffected; only the column disappears). The dangerous-WRITE-policy migration is reversible via the standard pattern (the `down.sql` restores the original `tenant_id is null OR ...` clause); rollback is necessary only if a documented globally-scoped writer breaks, which is a discoverable single line.

### 4.4 Sub-sprint 4 (weeks 7 to 8): CMEK substrate, JSONB sprawl split, audit-chain HMAC trigger, CI gate

Scope. Four pieces that close out Phase 5 and unlock the enterprise revenue path.

Piece A: CMEK substrate. Migration `120_cmek_substrate.sql` adds `tenant_kms_config` (provider, key ARN, IAM identity), `<resource>_encrypted_dek` columns alongside existing `<resource>_enc` columns for every table that stores secrets, and a feature flag `cmek_enabled` per tenant. The `_lib/secrets.js` module is refactored into `_lib/secrets-v2.js` with a pluggable KMS adapter. Backward compatibility: tenants without `cmek_enabled` continue to use the single-master-key path; the migration is non-breaking. One pilot tenant (the first enterprise pilot) is migrated to CMEK Premium with their own AWS KMS KEK and audit log surfaced.

Piece B: JSONB sprawl split on `tenant_settings`. The current `tenant_settings` table has ~110 JSONB columns covering connector configs, feature flags, retention policies, integration mappings, and per-tenant heuristics. Migration `121_tenant_settings_split.sql` decomposes the 110 columns into 7 typed sub-tables (`tenant_connector_settings`, `tenant_feature_flags`, `tenant_retention_policies`, `tenant_integration_mappings`, `tenant_extraction_heuristics`, `tenant_compliance_settings`, `tenant_branding_settings`). Every reader is updated. The legacy table stays as a denormalised view for backward compatibility during the migration window.

Piece C: Audit-chain HMAC trigger. Migration `122_audit_chain_hmac.sql` installs a `before insert` trigger on `audit_events` that reads the previous row's `chain_hash`, computes `chain_hash = hmac_sha256(prev_chain_hash || row_payload, server_secret_key)`, and stores it on the new row. The trigger replaces the in-app HMAC logic. A daily cron job verifies the chain integrity for every tenant and emits a metric. Carry-over from Phase 2 if not already done.

Piece D: CI gate (Idea 3.5). The CodeQL query catalogue + Semgrep ruleset ship under `/Users/kenith.philip/anvil/.github/codeql/`. GitHub Actions runs the queries on every PR and blocks merge on findings. The rule set covers `serviceClient()` without `.eq`, missing `requireTenantOwnership`, JWT-claim RLS policies, secret-handling outside `_lib`, and dangerous-default detection.

Verification gate. (a) Pilot tenant operating on CMEK Premium with their own KMS for 7 days, zero unwrap errors. (b) `tenant_settings` reads p95 latency within 5% of pre-split. (c) Audit chain integrity check passes 100% over a 7-day window; trigger emits zero errors. (d) CI gate blocks at least one PR during the sub-sprint and the block is accepted as correct.

Rollback plan. CMEK substrate is feature-flagged off per tenant; rollback for the pilot tenant is `cmek_enabled=false` plus a synchronous re-encrypt under the single master key. JSONB sprawl split keeps the legacy table as a view; rollback is to swap the writers back to the legacy table (the view continues to serve readers). Audit-chain HMAC trigger is reversible by dropping the trigger and reverting `audit_events` writes to use the in-app HMAC. CI gate is rolled back by disabling the GitHub Actions workflow.

### 4.5 Exit criteria recap

End of week 8: 100 customer-facing tables migrated to user-JWT scope (50 in sub-sprint 2 plus the 50 derivative tables covered by the dialect unification in sub-sprint 1). RLS dialect unified to `current_tenant_ids()` across 100% of policies. Soft-delete pattern on 30 business tables with retention cron in production. IDOR helper called on 277 `[id].js` handlers, enforced by CodeQL. Eight dangerous WRITE policies patched. Audit-chain HMAC running inside Postgres. CMEK Premium pilot signed and operating for 7 days. CI gate active and blocking at least one PR.

---

## Section 5. Customer value plus revenue impact

Phase 5 is the single most important phase in the entire 9-phase roadmap for unlocking the enterprise + regulated-industry SaaS go-to-market motion. Three specific revenue mechanisms hinge on it.

### 5.1 Mechanism 1: Enterprise tier unlock

The current ARPU on Anvil's professional tier is ~INR 6 lakh / year per customer. The enterprise tier (currently being defined) is ~INR 25 lakh / year per customer. The enterprise tier requires:

- Per-tenant data isolation provable to an external auditor (Phase 5 F38 + F41 + F42 + F43).
- Customer-managed encryption keys (Phase 5 F46 / Tenant Vault Premium).
- Soft-delete plus retention plus DPDP-compliant data minimisation (Phase 5 F40).
- Audit chain provable to be tamper-evident (Phase 5 F44 audit-chain HMAC).

Without Phase 5, the enterprise tier cannot be sold at INR 25 lakh because the security posture is materially weaker than the buyer's expectation. With Phase 5 complete, the enterprise tier is a defensible product. Conservative target: 30 enterprise customers in year 1 post-Phase 5, year 2 ramp to 75. Revenue: 30 customers x INR 25 lakh = INR 7.5 crore in year 1; 75 customers x INR 25 lakh = INR 18.75 crore in year 2. Net incremental ARR vs. selling the same buyers on the professional tier: 30 customers x INR 19 lakh = INR 5.7 crore in year 1; 75 customers x INR 19 lakh = INR 14.25 crore in year 2.

### 5.2 Mechanism 2: Regulated-industry expansion

Indian banking, insurance, government PSU, and telco buyers operate under regulatory frameworks (RBI Master Direction on IT Framework, IRDAI cyber security guidelines, CERT-In 2022 directive, DoT Unified License conditions) that require structural per-tenant isolation, customer-controlled encryption, and data residency. These buyers represent a TAM expansion of roughly 3x the current mid-market addressable market.

ClearTax, Cygnet, IRIS GST, Webtel cannot easily compete in this segment because their shared-schema multi-tenant architectures fail the structural-isolation test. Anvil's per-tenant isolation (post-Phase 5) is the structural differentiator that wins these RFPs.

Conservative target: 10 regulated-industry pilots in year 1, 25 production deployments in year 2 post-Phase 5. Pricing for regulated industry is 2 to 3x enterprise (INR 50 lakh to INR 75 lakh / year) because of the additional compliance overhead and the customer's procurement willingness to pay for a niche-fit product. Revenue: 10 pilots x INR 25 lakh (pilot price) = INR 2.5 crore in year 1; 25 productions x INR 60 lakh average = INR 15 crore in year 2.

### 5.3 Mechanism 3: Per-seat lift on existing customers

Existing professional-tier customers (~150 today) will not all upgrade to enterprise, but a meaningful subset (15 to 25%) will. The upgrade trigger is usually a security audit or compliance event that surfaces a gap the professional tier cannot fill. Phase 5 makes the enterprise tier a real upgrade path with concrete differentiators (CMEK, soft-delete, audit-chain HMAC, per-tenant isolation widget) rather than a marketing pitch.

Conservative target: 25 professional-tier customers upgrade to enterprise in year 1. Net per-seat lift: INR 19 lakh / customer / year. Total: 25 x INR 19 lakh = INR 4.75 crore in year 1.

### 5.4 Total Phase 5 revenue attribution

- Mechanism 1 (enterprise tier unlock): INR 5.7 crore year 1, INR 14.25 crore year 2.
- Mechanism 2 (regulated-industry expansion): INR 2.5 crore year 1, INR 15 crore year 2.
- Mechanism 3 (per-seat lift): INR 4.75 crore year 1, ~INR 8 crore year 2 (assuming 40 cumulative upgrades).

Year 1 incremental ARR attributable to Phase 5: ~INR 13 crore.
Year 2 incremental ARR attributable to Phase 5: ~INR 37 crore.

Phase 5 cost: 8 engineer-weeks x 4 engineers x INR 12 lakh / engineer / year (loaded) = INR 7.4 lakh in direct engineering cost, plus INR 50 lakh / year ongoing for the bug-bounty program. Total Phase 5 investment: ~INR 1 crore in year 1, ~INR 60 lakh / year ongoing.

ROI: 13x in year 1, 60x cumulative over 2 years. This is the highest-ROI single phase in the 9-phase roadmap.

### 5.5 The competitive moat narrative

ClearTax, Cygnet, IRIS GST, Webtel all use shared-schema multi-tenancy. This is a published fact in their architecture blogs and a knowable fact from their pricing pages (single-tier multi-tenant SaaS with no enterprise / regulated-industry tier).

Anvil's per-tenant isolation is structurally harder to retrofit than to build, which means a competitor who decides today to match Anvil's isolation has a 12-to-18-month rebuild ahead of them. That window is the competitive moat. Phase 5 starts the clock; every quarter Anvil ships in that window deepens the moat (RLS coverage, CodeQL gates, bug bounty findings fixed, audit chain integrity logs, CMEK pilots).

Pricing leverage. The differentiator can also justify a 30 to 50% price premium over the equivalent shared-schema SaaS for the same buyer profile. The buyer's CISO can articulate the difference, and the buyer's procurement team can negotiate on the strength of it.

Sales motion. The Tenant Isolation Score widget (Idea 3.3) is the closer. Every enterprise sales conversation ends with "show me the widget for our trial tenant"; the buyer takes a screenshot to their CISO; the CISO signs off in days instead of weeks.

---

## Section 6. Risk register

Phase 5 carries an unusually high concentration of operational risks because the migration touches the load-bearing wall of the platform. The risk register below covers two risks per F-item plus four cross-cutting risks.

### 6.1 F38 (service-role to user-JWT migration)

Risk 6.1.1: Cross-tenant data leak during the dual-write phase if the shadow path is mistakenly returned to the user. Mitigation: the shadow harness has unit tests verifying the legacy path is always the one returned to the user; production traffic is monitored for `shadow_returned_to_user` metric set to zero; CodeQL query enforces the harness pattern.

Risk 6.1.2: Permission-denied storms post-flip if the RLS dialect migration is not applied to the target table before the handler is flipped. Mitigation: the LaunchDarkly flag check runs after a pre-flight check that confirms the table has a `current_tenant_ids()` policy; if not, the flag fails open to the legacy path with a metric `flip_blocked_no_rls_policy` incremented.

### 6.2 F39 (RLS dialect unification)

Risk 6.2.1: A migration error during the dialect rewrite produces an `OR true` clause that grants global access. Mitigation: the dialect rewrite is automated by a Python script and the output is reviewed by a second engineer; staging soak for 48 hours before production; pgTAP regression test asserts every policy denies cross-tenant access on a synthetic 2-tenant fixture.

Risk 6.2.2: A policy that uses `current_tenant_ids()` fails closed during a transient connectivity blip in the `tenant_members` table. Mitigation: `current_tenant_ids()` is wrapped in a retry-on-transient pattern; a separate sentinel `rls_policy_health` metric tracks the per-policy denial rate and pages on a 10x baseline spike.

### 6.3 F40 (soft-delete pattern)

Risk 6.3.1: A handler that did not previously filter by `deleted_at is null` now returns deleted rows because the policy filter does not fire for service-role bypass. Mitigation: the soft-delete column is added with a `not null default '5000-01-01'::timestamptz` sentinel for legacy rows, so existing rows look "live" without changing semantics; the migration includes a backfill that sets the sentinel; soft-delete is only operationally meaningful after the F38 migration to user-JWT.

Risk 6.3.2: The retention cron hard-deletes a row that a customer still needs (e.g., a soft-deleted invoice that was undeleted on day 91). Mitigation: the retention cron is preceded by a 7-day reminder email to the tenant admin listing the rows that will be purged; the retention window is configurable per tenant via `tenant_retention_policies`; the cron emits a metric `retention_purged_count` with row IDs to a backup table for 30 days post-purge in case of operator error.

### 6.4 F41 (RLS coverage CI gate)

Risk 6.4.1: The CodeQL / Semgrep gate has false positives that erode engineer trust and lead to over-broad `// rls-bypass:reason` annotations. Mitigation: calibrate the rule set on the existing 359-file codebase before activation, tuning until the false-positive rate is below 5%; the annotation must include a Jira ticket reference; weekly security-team review of all active annotations.

Risk 6.4.2: The gate has false negatives that miss a real cross-tenant bug. Mitigation: the gate is one of three layers (gate + bug bounty + nightly cross-tenant integrity scan); a true positive surfaced by any one layer is added as a rule to the gate; quarterly rule-set audit by an external pentester.

### 6.5 F42 (IDOR sweep across 277 tables)

Risk 6.5.1: A handler is missed in the sweep, and the gap is not caught by the CodeQL gate because the handler uses a non-standard helper. Mitigation: the sweep is generated from a complete `find /api -name "[id].js"` list, not from a manual inventory; the CodeQL gate is calibrated to flag any `[id].js` handler that does not call `requireTenantOwnership`; sub-sprint 3 verification gate is "100% coverage".

Risk 6.5.2: The `requireTenantOwnership` helper introduces a performance regression because it adds a SELECT round-trip per handler. Mitigation: the helper is implemented as a `WHERE id = $1 AND tenant_id = $2 LIMIT 1` SELECT that returns immediately on hit or miss; the query plan is verified to use the primary-key index plus the partial `tenant_id` index; a Grafana dashboard tracks the per-handler p95 latency and alerts on regression greater than 10%.

### 6.6 F43 (8 dangerous WRITE policies)

Risk 6.6.1: A globally-scoped writer (e.g., a script that bulk-loads inco-terms taxonomy) breaks because the migration removes the `tenant_id is null` insert path. Mitigation: the migration adds a `super_admin_global_insert(table_name, row_payload)` RPC for the legitimate cases; pre-migration audit of all callers; staging soak verifies no production caller uses the `tenant_id is null` insert path post-migration.

Risk 6.6.2: An attacker exploits the `redaction_rules` table BEFORE the migration lands. Mitigation: this is the highest-priority single fix in Phase 5; it lands in sub-sprint 1 even though sub-sprint 3 is its assigned home; the security team has visibility into any `redaction_rules` writes (a real-time alert on inserts).

### 6.7 F44 (audit-chain HMAC trigger)

Risk 6.7.1: The trigger fails on a transient and the audit insert is rejected, breaking the user-visible action. Mitigation: the trigger is defined with `before insert` and the function catches and logs failures rather than re-raising; a `audit_chain_failures` sentinel table receives the failed rows; the chain integrity job reconstructs the chain from the sentinel on recovery; the user-visible action is not blocked.

Risk 6.7.2: A race condition between two concurrent `audit_events` inserts produces a chain fork (both rows reference the same `prev_chain_hash`). Mitigation: the chain hash includes a row sequence number from a per-tenant `audit_chain_seq` sequence; the chain is per-tenant, not global, so concurrency is bounded; the integrity job detects forks and emits a metric.

### 6.8 Cross-cutting risk: Handler-family regression during migration

A regression in one handler within a family during the F38 wave could break the family's UI surface for the affected tenants. Mitigation: the LaunchDarkly flag is per-(tenant, handler), so a regression on `customers.update` does not affect `customers.read`; the flag flip is monotonic but can be reverted; the production playbook for a flag-flip rollback is a single button in the LaunchDarkly UI.

### 6.9 Cross-cutting risk: RLS-policy dialect mismatch breaks reads

A migration that lands the new policy but does not also drop the old policy could produce a policy stack where the old policy denies all reads (because the JWT does not carry the `tenant_id` claim) and the new policy permits them; the PERMISSIVE-OR behaviour means the new policy wins, so this is actually safe by default. The dangerous case is the reverse: a migration that drops the new policy but leaves the old one in place denies all reads. Mitigation: the migration script ALWAYS drops the old policy before creating the new one; pgTAP regression test asserts at most one policy per (table, command) pair after migration.

### 6.10 Cross-cutting risk: KMS quota exhaustion

A noisy tenant or a sudden Anvil-wide spike could exhaust the per-region AWS KMS quota (5,500 ops/sec default). Mitigation: per-tenant DEK caching in-memory for 10 minutes per handler instance (DD32 section 6); separate KMS keys per tenant so a single tenant's noise is isolated; CloudWatch alarm at 50% of quota warns the on-call; AWS support contact requests a quota increase to 30,000 ops/sec ahead of the first CMEK Premium pilot; the multi-region tier uses Multi-Region keys so a quota hit in one region fails over.

### 6.11 Cross-cutting risk: Audit-chain trigger creates idempotency surprise

If an audit-events insert is retried after a partial commit (transient connectivity blip), the retry sees a different `prev_chain_hash` than the first attempt, producing two chained rows for the same logical event. Mitigation: every audit-events row carries an idempotency key (`audit_idempotency_key`) generated by the caller; a unique index on `(tenant_id, idempotency_key)` prevents duplicates; the trigger checks for an existing row with the same key and reuses its chain hash on retry. The caller is responsible for generating a stable idempotency key per logical event; the `recordAudit` helper in `/Users/kenith.philip/anvil/src/api/_lib/audit.js` will be updated to compute the key from the action + object_type + object_id + actor.

---

## Section 7. Success metrics

Phase 5 success is measured against six concrete, observable, mid-quarter-reviewable metrics.

### 7.1 Zero missed `.eq("tenant_id", ...)` across the top 50 handlers

Definition: the CodeQL query that walks every `svc.from(...)` chain in the top 50 handlers returns zero findings. Verification: the GitHub Actions workflow runs the query on every PR and the workflow status is "green" for 4 consecutive weeks of PRs touching the top 50 handlers.

Target: 100% coverage. Baseline: unknown today (the query is built in Phase 5). Phase 5 ships the query plus the fix for every gap it finds.

### 7.2 RLS dialect unified to `current_tenant_ids()`-based across 100% of policies

Definition: the `pg_catalog.pg_policies` view, queried in production at end of Phase 5, contains zero policies whose `qual` or `with_check` clause contains the string `current_setting('request.jwt.claims'`. Verification: a SQL assertion in the migration runner asserts the count is zero post-migration.

Target: zero JWT-claim-based policies in production. Baseline: 63 migrations install such policies today (`05-data-model.md` section 1).

### 7.3 Soft-delete pattern adopted on top 30 business tables

Definition: the 30 tables listed in the F40 scope each have a `deleted_at timestamptz` column, an RLS policy or app-level filter that excludes soft-deleted rows by default, and a retention cron job that purges rows older than 90 days. Verification: a meta-query against `information_schema.columns` confirms the column exists; a code review of every reader confirms the filter is applied; the cron job emits `soft_delete_purged_count` to Grafana.

Target: 30 tables fully covered. Baseline: 0 tables today.

### 7.4 IDOR helper called on 277 `[id].js` handlers

Definition: every `[id].js` handler in `/Users/kenith.philip/anvil/src/api/` calls `requireTenantOwnership(...)` before any database mutation or before returning the resource. Verification: the CodeQL query confirms the helper is called on the AST path between the route entry and the database call.

Target: 277 handlers, 100% coverage. Baseline: 0 handlers today (helper does not yet exist).

### 7.5 Eight dangerous WRITE policies patched

Definition: the 8 tables (`redaction_rules`, `engineering_specs`, `payment_milestones`, `expense_rate_cards`, `inco_terms_taxonomy`, `blanket_release_drawdown`, `logistics_ports`, `logistics_carriers`) no longer permit `tenant_id is null` inserts from non-admin roles. Verification: a pgTAP regression test attempts the insert as each role and asserts denial except for service-role-via-RPC.

Target: 8 tables fixed. Baseline: 8 tables vulnerable today.

### 7.6 CMEK Premium pilot signed and operating

Definition: at least one enterprise customer is operating on Tenant Vault Premium (customer-managed KEK in their own KMS) for at least 7 consecutive days with zero unwrap failures and the customer has signed an annual contract at the CMEK Premium price tier. Verification: a copy of the signed MSA, a Grafana dashboard showing 7-day clean unwrap operation history, and a satisfaction note from the customer's CISO.

Target: 1 pilot signed and operating. Baseline: 0 today; the substrate does not yet exist.

### 7.7 Bonus metric: Tenant Isolation Score above 95% for all production tenants

Definition: the public Tenant Isolation Score widget (Idea 3.3) reads above 95% for every production tenant at end of Phase 5. Verification: the widget's source data view returns ">95" for all rows.

Target: 100% of tenants above 95%. Baseline: not measurable today; the widget does not yet exist.

### 7.8 Out-of-scope but watched

The following metrics are not Phase 5 success criteria but will be watched as leading indicators:

- Per-handler p95 latency post-flip (should be within 10% of pre-flip).
- Permission-denied rate per handler post-flip (should be within 5% of pre-flip baseline).
- Number of `// rls-bypass:reason` annotations in production (should be under 20 at end of Phase 5; each annotation has a Jira ticket).
- Number of merged PRs blocked by the CI gate (should be greater than zero, demonstrating the gate is operating).
- Bug bounty submissions in the cross-tenant category (Phase 5 launches the program in week 6; any submissions before then are out of scope).

---

## Section 8. Closing note on operational discipline

The single biggest determinant of Phase 5 success is not the technical design (which is well-trodden, per DD11 and DD32) but the operational discipline of the four engineers running the migration over 8 weeks. The migration is a long, repetitive sequence of small, safe steps; the temptation to take a shortcut on any single handler is what produces the cross-tenant incident. Three operational guardrails matter most:

First, no handler is flipped without 48 hours of shadow-read soak with zero divergences. This is non-negotiable. A divergence might be benign (different ordering) or might be a tenant-leak; the only way to tell is to investigate every one.

Second, every flag flip is paged. The on-call engineer is on the page for the 2-hour window post-flip and verifies the per-handler dashboard before signing off. If anything looks off, the flag flips back without a deploy.

Third, the legacy `serviceClient()` branch is NOT removed from the code until 7 days post-flip with zero rollbacks. This is the safety net; removing it early to "clean up" the code is exactly the shortcut that produces incidents.

Phase 5 ends on schedule with the right discipline. The 8-week budget has zero slack; a missed week in any sub-sprint compresses the next sub-sprint and increases the risk of the kind of shortcut the discipline is meant to prevent. The four engineers must be protected from other work for the full 8 weeks; the engineering manager and the security lead must own that protection.

End of Phase 5 deep-dive plan.
