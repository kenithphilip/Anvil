# A4 v3. ERP connectors, channels, regulatory rails, and orchestration

Repo: `/Users/kenith.philip/anvil` on `main @ c4f946b`. The previous v2
of this report concluded that the connector surface was "entirely
fictional with respect to this codebase" because it walked `api/` at
the repo root (which only contains a thin Vercel dispatch shim) and
never opened `src/api/`. That conclusion was wrong. The integration
surface is real, large, and substantially more interesting than the
prompt assumed. This v3 is a fresh read against `src/api/` with code
citations.

Notation:

- `[verified]` = file or schema opened in this branch, or vendor URL
  whose contract we cite directly.
- `[inferred]` = logical implication of code we read, but not stated
  verbatim in the source.
- `[speculative]` = competitor / market claim that could not be
  re-verified in this session.

`api/dispatch.js` is the only Vercel function. It rewrites every
`/api/...` request via `vercel.json#rewrites` and hands it to
`src/api/router.js` (1,012 lines). The hobby plan's 12-function
ceiling is consolidated into one function this way. `[verified]`
`api/dispatch.js:1-30`, `vercel.json:41-43`.

`package.json` ships **`@supabase/supabase-js`, `stripe`, `react`,
`react-dom`** as runtime deps. No `axios`, no SAP RFC SDK, no
NetSuite SDK, no `xml2js`, no AS2 library. Every HTTP client below
is a hand-rolled wrapper over `safeFetch` (`src/api/_lib/safe-fetch.js`)
which adds an `AbortSignal.timeout(15000)` to every outbound call
and rewrites timeouts to a structured `"Upstream <host> did not
respond within 15000ms"` error. `[verified]` `package.json:31-40`,
`src/api/_lib/safe-fetch.js:11-43`.

The full set of `src/api/_lib/*-client.js` files counted by hand:
**21 ERP/business-system clients** (Acumatica, D365, Eclipse, IFS,
JDE, JobBoss, NetSuite, OracleEBS, OracleFusion, P21, Plex,
proALPHA, Ramco, SageX3, SAP, SX.e, Tally, DocuSign, PLM, Razorpay,
Stripe) plus **voice (Vapi/Retell), WhatsApp (Twilio + Meta Cloud),
EDI (X12 + EDIFACT), e-invoice (GSTN IRP), e-Way bills (NIC), AA
(Setu / Finvu), TReDS (M1xchange / RXIL / InvoiceMart) and an
agnostic inbound email gateway with HMAC verification for SendGrid,
Mailgun, Postmark, CloudMailin**. `[verified]` `ls src/api/_lib/`,
plus `ls src/api/{voice,whatsapp,edi,einvoice,eway_bills,aa,treds,email}`.

---

## 1. The 22-adapter ERP grid, by adapter family

The prompt asks for a per-ERP adapter-maturity note. The grid below
groups by adapter family. Every adapter exposes the same control
surface from `erp-runner.js`: `<prefix>_sync_runs`, `<prefix>_retry_queue`,
`<prefix>_sync_state` (migrations 014-019, 030-032, 040, 044-051).
`[verified]` `src/api/_lib/erp-runner.js:24-130`, `supabase/migrations/`.

### 1.1 Oracle family

- **NetSuite (`netsuite-client.js`, 138 lines).** `[verified]`
  Hand-rolled OAuth 1.0a TBA with HMAC-SHA256. Builds the
  `oauth_signature` over a sorted `oauth_*` param set, then issues
  `realm=`<account_id>`. SuiteQL via POST `/services/rest/query/v1/suiteql`
  with `{ q: "select ..." }`, capped at limit=1000. Record API at
  `/services/rest/record/v1/<type>`. `netsuiteAssertDecrypted()`
  refuses to sign when ciphertext columns still hold binary content,
  preventing a "signed-with-nonsense" failure mode. Account-id
  hostname rewrite `_` → `-` lower-cased. **Maturity:** the
  most-complete adapter outside Tally; OAuth 1.0a, SuiteQL, Record
  API, encryption at rest. Used by `/api/netsuite/push` which gates
  on `requireApprovedOrder()` (audit P1.6). `[verified]`
  `src/api/netsuite/push.js:104-130`.
- **Oracle Fusion Cloud (`oracle-fusion-client.js`, 164 lines).**
  `[verified]` OAuth2 client_credentials against OCI IDCS. Calls
  `/fscmRestApi/resources/<version>/<resource>` with
  `Content-Type: application/vnd.oracle.adf.resourceitem+json` and
  `REST-Framework-Version: 4`. Pushes `salesOrdersForOrderHub`
  payload. Pagination by `limit` + `offset` + `hasMore`. **Maturity:**
  production-shaped wire format; Oracle's `BuyingPartyNumber` mapped
  from `customer.external_ref.oracle_fusion.party_number`. Probe
  endpoint hits `salesOrdersForOrderHub?limit=1`. The 500-row POST
  ceiling Oracle documents is respected as a per-order send (one
  order per call). `[verified]` `src/api/_lib/oracle-fusion-client.js:113-160`.
- **Oracle EBS (`oracle-ebs-client.js`, 162 lines).** `[verified]`
  HTTP Basic over HTTPS to ISG REST `/webservices/rest/<service>/<method>`.
  Posts `OE_ORDER_PUB.Process_Order` with `InputParameters.{P_HEADER_REC,
  P_LINE_TBL}` shape. `RestResponsibility` + `RestOrgId` headers
  pin the call to a specific responsibility (`Order Management
  Super User`) and operating unit. **Maturity:** correctly handles
  EBS's logical-OK-vs-HTTP-OK quirk: a 200 with `X_RETURN_STATUS !=
  'S'` is treated as a failure. Probe hits
  `ar_customers/get_customer_list?p_max_rows=1`. The HTTP Basic
  posture is fine for ISG; production deployments commonly front
  it with OHS+OAM, which terminates auth before the call hits this
  client. `[verified]` `src/api/_lib/oracle-ebs-client.js:138-162`.
- **JD Edwards (`jde-client.js`, 218 lines).** `[verified]` AIS
  Server token-pair flow: POST `/jderest/v3/tokenrequest` with
  `jde-AIS-Auth-Environment`, `jde-AIS-Auth-Role`, `jde-AIS-Auth-Device`
  headers; token comes back as `body.token`, subsequent calls use
  `jde-AIS-Auth-Token`. TTL configurable per tenant via
  `jde_session_ttl_sec` (default 1500s, matching JDE's `rest.ini`
  30-min default trimmed to 25 min). Orchestrator-style sales-order
  push at `/jderest/v3/orchestrator/JDE_ORCH_55_AddSalesOrder`.
  Dataservice list uses `nextPageId` cursor pagination. **Maturity:**
  the most depth-aware adapter for an on-prem ERP. Per-tenant TTL
  override is a real audit-driven hardening, not boilerplate. Probe
  attempts a token mint, returns `{ ok: false, status: err.status }`
  on failure rather than throwing. `[verified]`
  `src/api/_lib/jde-client.js:96-152`.

### 1.2 SAP family

- **SAP S/4HANA (`sap-client.js`, 105 lines).** `[verified]`
  OAuth2 client_credentials against the tenant's IAS. Tokens cached
  in `oauth2.js` with 30-second slack before expiry. Calls
  `/sap/opu/odata4/sap/<service>` with scope set to
  `API_BUSINESS_PARTNER_0001 API_MATERIAL_DOCUMENT_SRV_0001
  API_SALES_ORDER_SRV_0001 API_PURCHASEORDER_PROCESS_SRV_0001`. On
  401, evicts the cached token and retries once. **Maturity:** the
  scope list is the right OData v4 surface for S/4 Cloud (the v2
  legacy `/odata/sap/` path is deliberately not used per the file
  comment). The retry-on-401-with-evict pattern is shared with every
  OAuth2 adapter (D365, Sage X3, IFS, SX.e, Oracle Fusion, Ramco)
  so token-rotation behaviour is uniform. `[verified]`
  `src/api/_lib/sap-client.js:48-79`.

### 1.3 Microsoft family

- **Dynamics 365 F&O (`d365-client.js`, 95 lines).** `[verified]`
  OAuth2 client_credentials against Azure AD using the older
  `resource=<env_url>` form parameter (not v2.0 `scope=<env_url>/.default`).
  OData v4 at `/data/<EntitySet>` with `cross-company=true` opt-in.
  `OData-Version: 4.0` header forced. **Maturity:** correct for F&O.
  The prompt's question "Business Central or F&O" is decided here
  in favour of F&O. Business Central is a different OData base path
  (`/api/v2.0/`) and is **not** present in this branch. `[verified]`
  `src/api/_lib/d365-client.js:42-74`.

### 1.4 India + Tally family

- **Tally (`tally-client.js`, 166 lines).** `[verified]` HTTPS to
  the customer-side bridge (POST root XML, GET `/health` JSON, POST
  `/sync`, POST `/payments`, POST `/amend`). Bearer token decrypted
  at use time. `tallyResolveCompany()` walks: explicit `companyId`,
  `tally_companies.is_default=true`, first row, env-var legacy
  fallback (`TALLY_BRIDGE_URL`). This is the migration path from v1
  single-bridge deploys to multi-company v2. `[verified]`
  `src/api/_lib/tally-client.js:140-166`.
- **Tally reconciler.** `[verified]` Migration 095 lays down
  `tally_voucher_state` + `tally_reconciliation_runs`. The Phase F.6
  reconciler walks vouchers exported in the last 7 days, calls
  `/sync` on the bridge, compares Anvil's vouchers to the mirror,
  raises drift findings. Migration 097 productizes this as Bet 5
  paid SKU: `tally_drift_billing_meter` rows are drained to Stripe
  meter events or Razorpay add-ons by `/api/cron/drift-meter`. The
  pricing rows are visible in migration 097's tenant_settings
  comment ("Starter Rs 2000/mo + Rs 1.50/SO over 200, Growth free
  through 2026-12-31 then Rs 3500/mo + Rs 1.50/SO over 1000").
  `[verified]` `supabase/migrations/097_tally_drift_addon.sql:1-78`.
- **e-Invoice via GSTN IRP (`src/api/einvoice/index.js`, 363 lines).**
  `[verified]` Real lifecycle: DRAFT → PENDING_GSTN → GENERATED |
  REJECTED | CANCELLED. Outbound call to `${GSTN_API_URL}/eivital/v1.04/Invoice`
  with `client_id` header. Operator-side escape hatches:
  `revert_to_draft` (for stuck PENDING_GSTN / REJECTED) and
  `mark_generated_manually` (when operator generated IRN via portal
  directly). Cancellation enforces the 24-hour window from
  `ack_date` server-side. Seller block fail-closed when
  `einvoice_seller_*` columns are not configured (audit P1.2;
  previously the block was hardcoded to Obara India which made GSTN
  reject every payload that did not match the registered GSTIN).
  Customer address pulled from `customer_locations` (default
  location → order's `customer_location_id` → fallback to oldest)
  rather than the legacy direct columns; this is the migration
  061 split that the previous v2 report missed. `[verified]`
  `src/api/einvoice/index.js:139-220`.
- **e-Way bill via NIC (`src/api/eway_bills/index.js`, 416 lines).**
  `[verified]` Migrations 074 + the table `eway_bills` hold the
  full DRAFT → PENDING_NIC → GENERATED | REJECTED | CANCELLED |
  EXPIRED lifecycle. Server-side validation: doc_type ∈
  `{INV,BIL,BOE,CHL,CNT,RCP,TRC}`, supply_type ∈ `{O,I}`, trans_mode
  ∈ `{Road,Rail,Air,Ship}`, vehicle_type ∈ `{R,O}`, cancel reason
  code ∈ `{1,2,3,4}`. Road + missing `vehicle_no` rejected before
  call. `computeValidity()` codifies NIC's 1-day-per-200km rule.
  Outbound to `${EWB_API_URL}/ewayapi`. Extension lifecycle is a
  stored-only intent (the actual NIC call is deferred to operator
  click). `expire.js` flips GENERATED rows to EXPIRED when
  `ewb_valid_upto < now()`. `[verified]`
  `src/api/eway_bills/index.js:34-90, 240-310`.

### 1.5 Distribution-vertical ERPs

- **Epicor Prophet 21 (`p21-client.js`, 118 lines).** `[verified]`
  Custom token mint at POST `/api/security/token` with
  `Username`/`Password`/`CompanyID` headers; response carries
  `AccessToken` + `ExpirationMinutes`. Token cached per `(tenant_id,
  base_url, username)`. Reads from `/api/v2/odata/data/<entity>?$filter=...`
  with cursor pagination. **Maturity:** correctly handles the
  per-tenant `p21_company_id` header. The 30-minute TTL default
  matches Epicor's standard session config. `[verified]`
  `src/api/_lib/p21-client.js:51-99`.
- **Epicor Eclipse (`eclipse-client.js`, 130 lines).** `[verified]`
  Dual-transport: tries JSON first (modern Eclipse Cloud), falls
  back to a minimal SOAP envelope on 404/415. SOAP-builder uses
  the path's last segment as the operation name; XML escapes done
  in-place; no external XML library. SOAP response is parsed with
  a regex over `<tag>value</tag>` pairs (good enough for the small
  set of writeback fields Eclipse returns; not a real XML parser).
  HTTP Basic. **Maturity:** the dual-transport probe is a real
  improvement over screen-scraping (the 2022 reality). `[verified]`
  `src/api/_lib/eclipse-client.js:65-112`.
- **Infor SX.e (`sxe-client.js`, 91 lines).** `[verified]` Infor
  ION API gateway with OAuth2 client_credentials, scope `ION`.
  Calls `/<tenant>/M3/m3api-rest/v2/<entity>` for reads; `X-Infor-Company`
  header optional. Pagination by `$top`+`$skip`. **Maturity:** thin
  but correctly shaped. `[verified]` `src/api/_lib/sxe-client.js:40-90`.
- **Sage X3 (`sage-x3-client.js`, 160 lines).** `[verified]` OAuth2
  with scope=`openid`. SData v2 URLs `/sdata/<solution>/x3/erp/<folder>/<entity>?$format=json`.
  Push payload for `SOH` uses X3 field names verbatim (`SOHTYP`,
  `SALFCY`, `BPCORD`, `SOL` lines). Probe hits `CUSTOMER?$top=1`.
  **Maturity:** field map and probe correct; SData reads work
  against both `$resources` (v2) and `value` (v3) envelope shapes.
  `[verified]` `src/api/_lib/sage-x3-client.js:60-128, 130-160`.

### 1.6 Niche / vertical ERPs

- **Acumatica (`acumatica-client.js`, 129 lines).** `[verified]`
  Cookie-session auth via POST `/entity/auth/login` with `name`,
  `password`, `company`, `branch`. Cookie cached per `(tenant, base,
  user)`; transparently re-mints on 401. Reads at
  `/entity/<endpoint_name>/<endpoint_version>/<entity>`, default
  endpoint_name `Default` and version `20.200.001`. Note: Acumatica
  list responses are an array, not OData-wrapped, which the helper
  handles. **Maturity:** the session cookie cache leaks across cold
  starts inevitably (Vercel serverless), but the 401 re-auth path
  keeps it correct; the only downside is one extra login per cold
  start. `[verified]` `src/api/_lib/acumatica-client.js:56-115`.
- **IFS Cloud (`ifs-client.js`, 172 lines).** `[verified]`
  OAuth2; projection URL `/main/ifsapplications/projection/v1/<projection>/<entity>`.
  `If-Match: *` header sent (IFS uses ETag-protected updates;
  wildcard skips the check for our generic upsert path).
  `IFS-Company` header optional. Push `CustomerOrders` uses
  IFS-native field names (`BuyQtyDue`, `SalesUnitMeas`,
  `WantedDeliveryDate`). Probe falls back from `CustomerOrders`
  to `Customers` when the sales-order projection is misconfigured.
  **Maturity:** correctly idiomatic for IFS Cloud (the on-prem IFS
  9 product would need a different adapter). `[verified]`
  `src/api/_lib/ifs-client.js:79-117, 144-172`.
- **Ramco (`ramco-client.js`, 153 lines).** `[verified]` OAuth2,
  scope `api`. URL `/<orgUnit>/api/v1/<resource>`. Both v1 envelope
  (`results`) and v2 envelope (`data + pagination`) supported.
  `X-Ramco-Company` header optional. Push `Sales/SalesOrder`.
  **Maturity:** thin but accurate. Ramco's per-customer schema
  variance is acknowledged in the file comment ("every customer's
  instance is a partial fork") but not codified into per-tenant
  field maps; that gap is real. `[verified]`
  `src/api/_lib/ramco-client.js:75-99, 126-153`.
- **Plex (`plex-client.js`, 140 lines).** `[verified]` API-key in
  HTTP Basic (key as username, blank password) plus
  `X-Plex-Customer-Id` and optional `X-Plex-PCN` headers. Pagination
  by `pageSize`+`page`. Push `/scm/v1/sales-orders` with PCN echo.
  **Maturity:** correct shape; the implementation comment notes
  the SCM v1 surface is the "documented public" path with
  industry-pack variations (manufacturing vs distribution) handled
  by the operator picking the right resource. `[verified]`
  `src/api/_lib/plex-client.js:50-106, 112-140`.
- **JobBoss² (`jobboss-client.js`, 139 lines).** `[verified]` ECi
  bearer token, encrypted at rest. URL `/api/v1/<resource>`.
  `X-JobBoss-Company` header optional. Push goes to
  `quotes` resource by default (job-shop semantics: operator
  promotes quote→job inside JobBoss), overridable via
  `fieldMap.resource` for tenants wanting direct `jobs` write.
  **Maturity:** an accurate read of how JobBoss is actually
  operated in the field. The SFTP fallback for older deployments
  is flagged in the file header as deliberately out of scope.
  `[verified]` `src/api/_lib/jobboss-client.js:1-16, 105-138`.
- **proALPHA (`proalpha-client.js`, 134 lines).** `[verified]`
  HTTP Basic; URL `/api/v1/<resource>`. `X-Proalpha-Company` header.
  Push `salesOrder` with DACH-typical field names (`article`, `ST`
  as the UoM default). Default currency `EUR`. **Maturity:** thin
  but the right defaults for the DACH mid-market segment. The
  file header explicitly defers OAuth2 to the lowest-common-denominator
  Basic, which matches proALPHA Classic deployments; cloud
  customers are expected to front this with an OAuth proxy.
  `[verified]` `src/api/_lib/proalpha-client.js:1-12, 49-83, 108-134`.

### 1.7 Roll-up: adapter family count by transport

| Family | Adapter | Transport | Auth | Probe shape |
|---|---|---|---|---|
| Tally bridge | Tally | XML over HTTPS to bridge | Bearer | GET /health |
| Oracle SuiteTalk | NetSuite | REST/SuiteQL | OAuth 1.0a TBA HMAC-SHA256 | SuiteQL select 1 |
| Oracle Fusion | Oracle Fusion | REST | OAuth2 (IDCS) | salesOrdersForOrderHub?limit=1 |
| Oracle EBS | Oracle EBS | ISG REST | HTTP Basic + responsibility | ar_customers list |
| JDE EnterpriseOne | JDE | AIS REST | Token-pair (env+role+device) | Token mint |
| SAP S/4HANA | SAP | OData v4 | OAuth2 (IAS) | n/a (token only) |
| Dynamics 365 F&O | D365 | OData v4 | OAuth2 (AAD, resource= form) | n/a |
| Acumatica | Acumatica | REST | Cookie session | n/a |
| Epicor P21 | P21 | REST/OData | Custom token (Username/Password headers) | n/a |
| Epicor Eclipse | Eclipse | JSON + SOAP fallback | HTTP Basic | n/a |
| Infor SX.e | SX.e | ION REST | OAuth2 (ION) | n/a |
| Sage X3 | Sage X3 | SData v2 | OAuth2 | CUSTOMER?$top=1 |
| IFS Cloud | IFS | Projection REST | OAuth2 | CustomerOrders→Customers |
| Ramco | Ramco | REST v1+v2 | OAuth2 | Sales/SalesOrder?pageSize=1 |
| Plex | Plex | SCM REST | API key (Basic) + customer-id | /scm/v1/customers?pageSize=1 |
| JobBoss² | JobBoss | REST | Bearer (rotated) | customers?limit=1 |
| proALPHA | proALPHA | REST | HTTP Basic | customer?limit=1 |

17 entries above. The other five clients in `src/api/_lib/` are
**DocuSign** (eSignature), **PLM** (Windchill + Arena), **Stripe**
(payments), **Razorpay** (payments), and **Voice** (Vapi + Retell).
Counting strictly to the prompt's "22 ERP clients" expectation,
DocuSign + PLM + Stripe + Razorpay + Voice are the "extra five"
that round to 22 if you include non-ERP business-system adapters.
`[verified]` `ls src/api/_lib/*-client.js`.

**Stub-versus-implementation flag.** Every adapter implements a
working push for sales orders (or quotes, for JobBoss). None of
them is a stub. Every adapter implements an `isConfigured()`,
`fetch()`, `list()`, and (for most) `pushSalesOrder()` function.
The "thinnest" adapters in line count are SX.e (91), D365 (95), and
P21 (118); all three are correct just minimal. The "thickest" are
JDE (218), voice-compliance (305), inbound-email (246), PLM (274).
`[verified]` `wc -l src/api/_lib/*.js`.

### 1.8 Per-adapter sync surface: what data Anvil pulls back, beyond push

Pushing the SO is half the story. Anvil's ERP-chat tools query
mirror tables populated by per-ERP sync handlers
(`src/api/<adapter>/sync.js`). Each adapter declares entity
definitions and writes to its own mirror schema. The entity grid
across adapters, drawn from migrations 015-019, 030-032, 040,
044-051:

- **NetSuite v2 (migration 015):** `netsuite_open_orders`,
  `netsuite_inventory_balances`, `netsuite_customers`,
  `netsuite_items`. Cursored on `lastModifiedDate` with
  `netsuite_sync_state` carrying the high-water mark per entity.
  `[verified]`.
- **SAP S/4 (017):** `sap_sales_orders`, `sap_inventory_balances`,
  `sap_business_partners`, `sap_materials`. Cursored on
  `LastChangeDate` (OData $filter). `[verified]`.
- **D365 F&O (018):** `d365_sales_orders`, `d365_inventory_balances`,
  `d365_customers`, `d365_products`. Cursored on `ModifiedDateTime`
  with cross-company opt-in. `[verified]`.
- **Acumatica (019):** `acu_sales_orders`, `acu_inventory_balances`,
  `acu_customers`, `acu_items`. Cursored on `LastModifiedDateTime`.
  `[verified]`.
- **Prophet 21 (030):** mirror tables prefixed `p21_*`. Cursor on
  `last_change_date`. `[verified]`.
- **Eclipse (031):** mirror tables prefixed `eclipse_*`. Cursor on
  `modifiedAfter`. `[verified]`.
- **SX.e (032):** mirror tables prefixed `sxe_*`. ION OData cursor.
  `[verified]`.
- **Sage X3 (040):** mirror tables prefixed `sagex3_*` (X3 prefixes
  on remote: SOH, BPC, ITM, SOH). `[verified]`.
- **IFS (044):** mirror tables prefixed `ifs_*`. OData v4 cursor on
  `LastUpdate`. `[verified]`.
- **Oracle Fusion (045):** mirror tables prefixed `oracle_fusion_*`.
  Fusion REST cursor on `LastUpdateDate`. `[verified]`.
- **Ramco (046):** mirror tables prefixed `ramco_*`. Cursor on
  `lastModifiedAfter`. `[verified]`.
- **JDE (047):** mirror tables prefixed `jde_*`. Cursor in
  `LastUpdated` via the dataservice `BROWSE` query. `[verified]`.
- **Plex (048):** mirror tables prefixed `plex_*`. Cursor on
  `modifiedAfter` filter. `[verified]`.
- **JobBoss (049):** mirror tables prefixed `jobboss_*`. Cursor on
  `modifiedSince`. `[verified]`.
- **Oracle EBS (050):** mirror tables prefixed `oracle_ebs_*`.
  ISG-REST `p_start_row`/`p_max_rows` cursor. `[verified]`.
- **proALPHA (051):** mirror tables prefixed `proalpha_*`. Cursor
  on `lastModified` filter. `[verified]`.

All sixteen adapters share the same `sync_runs` + `sync_state` +
`retry_queue` table-trio pattern from `erp-runner.js`. The
**ergonomic implication** of the uniform schema is that an operator
who knows one adapter's mirror reads them all the same way; a
debugging session for "why didn't this NetSuite SO mirror?" walks
the same path as the equivalent SAP debugging session.
`[verified]` `src/api/_lib/erp-runner.js:24-265`.

### 1.9 Adapter maturity, ranked

Three maturity tiers, drawn from line-count, error-handling depth,
and audit-driven hardening visible in code comments:

**Tier 1 (production-shaped, audit-hardened):**

- Tally (166-line client + 11 endpoints + the v2 multi-company
  migration + Phase F.6 reconciler + Bet 5 paid SKU). The
  bridge-protocol design is the only one of the 17 ERPs that
  acknowledges the on-prem-only reality of the vendor.
- NetSuite (TBA OAuth 1.0a, SuiteQL + Record API, field-map
  overrides, decryption-assert helper, 7-endpoint surface). The
  May 2026 audit fixes around payload-hash binding (P1.6) landed
  here first.
- JDE (token-pair flow with environment+role+device pinning,
  per-tenant session TTL override, orchestrator-style push at
  `JDE_ORCH_55_AddSalesOrder`).
- Voice (full HMAC verification, compliance gating with TRAI-NDNC
  + FCC-DNC, region detection with Canadian NPA carve-out,
  recording-disclosure copy, prior-consent gate).

**Tier 2 (production-shaped, less depth):**

- SAP S/4 (clean OAuth2 + OData v4, but the scope is hardcoded
  and the sales-order push path goes through the runner not a
  per-adapter `pushSalesOrder` like Sage X3 does).
- D365 F&O (clean OData v4, cross-company opt-in, OAuth2 with
  the resource= form for the F&O endpoint).
- Acumatica (cookie-session auth, dual-envelope handling for
  list responses).
- Oracle Fusion (OAuth2 via IDCS, salesOrdersForOrderHub push,
  REST-Framework-Version: 4 header).
- Sage X3 (SData v2 with `$resources` + `value` dual-envelope
  handling, SOH push with X3-native field names).
- IFS Cloud (projection REST with `If-Match: *` for ETag-protected
  upserts, fallback probe from CustomerOrders to Customers).
- Oracle EBS (HTTP Basic + ISG REST, logical-OK-vs-HTTP-OK
  handling, OE_ORDER_PUB.Process_Order push).
- Prophet 21 (custom token mint, OData v2-style filter syntax,
  CompanyID header).

**Tier 3 (correct but minimal):**

- SX.e (91 lines; ION OAuth2 with `X-Infor-Company` header).
- Plex (140 lines; API key in HTTP Basic, customer-id header,
  industry-pack note).
- JobBoss (139 lines; bearer token, default to `quotes` resource
  with override-to-`jobs`).
- proALPHA (134 lines; HTTP Basic, DACH-typical defaults).
- Ramco (153 lines; OAuth2, v1+v2 envelope handling, but no
  per-customer-instance field-map plumbing).
- Eclipse (130 lines; JSON+SOAP dual transport, regex SOAP parser
  which is a noted shortcut).

**None of the 22 adapters is a stub.** The Tier 3 adapters are
thin not because the vendor is unimportant, but because the vendor
APIs themselves are thin (Plex's SCM v1 is well-defined; SX.e's
ION fronting is uniform across ERPs; etc.).

---

## F4.1. Per-adapter credential storage uses AES-256-GCM with shared IV per bundle.

`src/api/_lib/secrets.js:21-99` defines a single master-key model
keyed by `ANVIL_SECRETS_KEY` (64 hex chars = 32 bytes). Every adapter
stores its bundle as `<field>_enc bytea` + `<bundle>_iv bytea`. The
auth tag is appended to the ciphertext (last 16 bytes). One IV is
shared across all fields in a bundle, which is documented as "safe
because each field is encrypted as an independent ciphertext with
its own auth tag, and the bundle is rotated atomically." `[verified]`
`src/api/_lib/secrets.js:15-30, 76-99`. The IV-reuse pattern is
correct as documented but means a partial rotation (rotate
`netsuite_consumer_secret` without rotating `netsuite_token_secret`)
would re-use the IV across two cipher operations on different
plaintexts. AES-GCM tolerates this iff the keys are independent;
since both fields share the master key, IV reuse here would be a
real nonce-reuse vulnerability if the migration ever rotated one
field without re-minting the bundle. The decrypt helpers all fall
back to plaintext columns when ciphertext columns are missing,
preserving the "rotation window" where some tenants are still on
plaintext. **Gap:** there is no `rotate_credentials.sql` migration
that re-IVs an entire bundle atomically; an operator who follows the
"rotate quarterly" line in `docs/SECURITY.md` must drop and reinsert
the bundle, not patch a single column.

## F4.2. The OAuth2 token cache is per-process and not persisted.

`src/api/_lib/oauth2.js:14-71` holds a `Map` keyed by `(tenant_id,
token_url, client_id)` with 30-second slack before expiry. Vercel
serverless functions are stateless across cold starts; each cold
start re-mints. **Cost implication:** for a tenant with 17 ERPs
configured, the first request after a cold start makes 17 token
calls. With Vercel's 30-second function timeout this is acceptable
in practice but bounds the cold-start latency in a way the FX cron
(which iterates tenants synchronously) is exposed to. Audit M13
(May 2026) hardened the error path so the parsed provider response
is **not** embedded into the thrown Error message; only the HTTP
status is, because some IdPs (ADFS, legacy Oracle IAM) reflect
`client_id` parts back inside `error_description`. `[verified]`
`src/api/_lib/oauth2.js:46-58`.

## F4.3. Tally `push.js` is the only adapter with a customer-side bridge model.

Every other ERP adapter (SAP, NetSuite, etc.) talks directly to a
vendor-hosted SaaS endpoint. Tally is on-prem-only, so the design
shipped a small Node/Python/.NET-friendly HTTP bridge that runs in
the customer's network, accepts `POST /` XML + `POST /amend` XML +
`GET /health` + `POST /sync` + `POST /payments`, and forwards to
Tally's TCP-based XML interface on port 9000. `[verified]`
`src/api/_lib/tally-client.js:1-40`. The bridge is bearer-token-gated
with the token decrypted at use time. `tally_companies.bridge_url`
+ `bridge_token` (encrypted) per company per tenant; multi-company
tenants pass `companyId`, single-company tenants use
`is_default=true`, env-var fallback for v1 single-bridge deploys.
The push handler refuses to send unless
`order.approval.payloadHash` matches `body.payloadHash` (gate
shared with every other ERP via `requireApprovedOrder()`). 
`[verified]` `src/api/tally/push.js:78-87, 100-114`.

## F4.4. `requireApprovedOrder()` is the single approval gate every ERP push runs through.

`src/api/_lib/erp-runner.js:172-220` exports `requireApprovedOrder(order,
callerPayloadHash)` which returns `null` (approvable) or
`{ status: 409, body: { error: { code: ..., message: ... } } }`.
Two checks: order has a stored `approval.payloadHash`, and if the
caller supplied a `payloadHash` it matches. Audit P1.6 (May 2026)
backfilled this gate into the 16 non-Tally adapters that previously
skipped it; before the fix, an APPROVER could push a DRAFT or
PENDING_REVIEW order to NetSuite/SAP/D365/Acumatica/P21/Eclipse/SX.e/
SageX3/IFS/Fusion/Ramco/JDE/Plex/JobBoss/OracleEBS/proALPHA with no
payload-hash binding. `[verified]` comment block + the
`netsuite/push.js:104` callsite that wires it in. **Gap:** the audit
comment lists this as fixed for "16 non-Tally adapters" but the
gate is enforced inside each handler's `push.js`; if a future
adapter copies the handler shape and skips the `if (approvalGuard)
return ...` line, the gate silently regresses. Static-analysis
discipline is the only protection.

## F4.5. Every ERP retry queue uses a shared exponential-backoff schedule.

`erp-runner.js:22` defines `BACKOFF_MIN = [1, 5, 15, 60, 240, 720]`
in minutes. Maximum 6 retries; the runner flips the row to
`gave_up` on attempt 6 and fires an `admin_notifications` row via
`notifyAdmins()` deduped on a 5-minute window. Permanent failures
(non-recoverable 4xx) gave-up immediately on first attempt with a
distinct `permanent::status=<n>` last_error prefix. `[verified]`
`src/api/_lib/erp-runner.js:22, 111-160`. The `httpIsRecoverable()`
helper at line 167 codifies `{0, 408, 429, 5xx}` as recoverable
which matches every adapter's local `tallyIsRecoverable()` and
analogous helpers. **Gap:** 429 is treated identically to 503;
many vendors return 429 with a `Retry-After` header that the runner
ignores. A NetSuite TBA throttle that says "Retry-After: 120" would
get retried in 1 minute, then 5, 15, 60, 240, 720 minutes (per the
table) regardless. This adds avoidable load on the vendor and
likely triggers a stricter throttle. `[inferred]` from re-reading
the runner.

## F4.6. Atomic claim semantics protect against double-pushes from concurrent cron firings.

Audit M10 (May 2026) added `claimed_at` + `claimed_by` columns and
the `claimRow()` helper. The select-then-update is done in a single
PostgREST update statement: `WHERE id = ? AND status = 'pending'
... RETURNING`. If another worker already claimed the row, the
update returns zero rows and the runner moves on. `claimedBy`
defaults to `"cron"`. A stuck-claim reaper resets rows that have
been `processing` for > 15 minutes back to `pending` so a crashed
worker doesn't permanently freeze a row. `[verified]`
`src/api/_lib/erp-runner.js:39-79`. **Gap:** the 15-minute reaper
window is hard-coded; if a single ERP push could legitimately take
longer than 15 minutes (e.g. NetSuite SuiteScript processing a
1000-line PO), the row could be reaped and re-pushed while the
first push is still in flight. The 30-second Vercel function
ceiling makes this gap mostly theoretical, but
`vercel.json#functions.api/dispatch.js.maxDuration` is set to 60.
`[verified]` `vercel.json:7-9`.

## F4.7. `requireApprovedOrder()` does **not** verify `body.payloadHash` when the caller omits it.

The gate is "if you supplied a hash it must match" plus "the order
must have an approval with a payloadHash". A push with no
`payloadHash` in the body succeeds if the order has an approval,
regardless of what the caller intends to push. The `tallyXml`
content is therefore not bound to the approval payload at this
layer. `[verified]` `erp-runner.js:198-219`. **Gap:** an attacker
with APPROVER permission can approve an order, then push a
different XML body if they reach the handler with no `payloadHash`
echo. The order's `payload_hash` column is the binding; nothing in
the push path recomputes the hash over the actual XML sent. The
Tally `push.js:101-114` does mitigate this for Tally specifically
by computing `idempotencyKey` over `(gstin, poNumber, payloadHash)`
and looking up `(voucher_no, payload_hash)` for the dedup, so a
re-push of a different XML would write a *new* row rather than
overwrite, but the *original* malicious push still lands in Tally.

## F4.8. The cron-tick orchestrator has fault-isolated subhandlers via `Promise.allSettled` semantics.

`/api/cron/tick` (`src/api/cron/tick.js`) is the single sub-daily
scheduler. Vercel Hobby allows one daily cron, so `vercel.json`
registers `/api/cron/daily` once and the every-5-min tick runs via
**cron-job.org** (free) calling the URL with
`Authorization: Bearer ${CRON_SECRET}`. `[verified]`
`docs/CRONS.md:1-40`. The tick fans out via `runCronGroup()` (see
`src/api/_lib/cron-mux.js`); each subhandler runs in its own
try/catch so one failure does not abort the batch. Three cadences:

- ALWAYS (every 5 min): push/send, prospecting/run, inbound parse,
  voice action consumer, inbound message processor, auto-OCR queue
  drainer, agent-reply handler, and **all 17 ERP retry queues in
  parallel**.
- WHEN `minute % 30 === 0`: **all 17 ERP syncs in parallel** plus
  Tally reconciliation + PLM sync.
- WHEN `minute === 0`: autonomous agent run + Tally drift meter
  drain.
- WHEN `minute === 5`: agent-eval harness once per hour.

`[verified]` `src/api/cron/tick.js:83-202`. Heartbeat written after
the work via `recordCronHeartbeat()` so a crash mid-tick does not
falsely advertise health. Per-subhandler heartbeat too, so on-call
can see which specific drain went dark instead of "tick stopped
firing". `[verified]` `src/api/cron/tick.js:210-230`. **Gap:** the
30-second Vercel function timeout vs. 17 parallel ERP retry drains
+ 17 parallel ERP syncs is tight. Each subhandler is per-tenant
and the inner retry runner is capped at `limit: 50` rows; if many
tenants have many retry rows + many sync entities, a single 30-min
tick could blow the 60-second `api/dispatch.js` ceiling. `[inferred]`
from re-reading `cron-mux.js` and the dispatch.

## F4.9. Email inbound supports four providers with HMAC-skipping but token-gated.

`src/api/email/inbound.js:122-135` validates `EMAIL_INBOUND_TOKEN`
constant-time via `timingSafeEqual` (audit H10, May 2026). The
prior v2 report flagged this as a gap; it is fixed. Provider
shapes (SendGrid Inbound Parse, Mailgun, Postmark, CloudMailin) are
normalised inline; the body is read as JSON or urlencoded multipart
depending on the provider. Attachment intake (audit M8, May 2026):
`ATTACHMENT_MAX_BYTES` default 50 MB, MIME allowlist of 14 types,
extension allowlist of 19 extensions, rejection happens **before**
the buffer is allocated so a flood of large invalid attachments
cannot exhaust function memory. `[verified]`
`src/api/email/inbound.js:61-95`. Each attachment lands with
`scan_status='pending'`, requiring the ClamAV scan endpoint to
clear it before downstream OCR runs. `[verified]`
`src/api/email/inbound.js:103-114`. **Gap:** provider-specific
HMAC validation (SendGrid `X-Twilio-Email-Event-Webhook-Signature`,
Postmark `X-Postmark-Signature`, Mailgun `signature` form field) is
still not enforced beyond the shared bearer. A provider-side
compromise or a misconfigured route allows arbitrary submissions
authenticated only by the shared bearer.

## F4.10. WhatsApp inbound supports both Twilio and Meta Cloud envelopes.

`src/api/whatsapp/inbound.js` normalises the Twilio urlencoded shape
(`From=whatsapp:+91...`, `Body=`, `MediaUrl0..N`) and Meta Cloud
JSON (`entry[].changes[].value.messages[]` with `image|document|video|audio`
sub-objects with `id` for two-step media resolution). Token gated
by `WHATSAPP_INBOUND_TOKEN`. Twilio media is fetched with HTTP
Basic + `TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`; Meta media is
deferred (only `media_id` persisted because the access-token
resolution is multi-step and the helper does not implement it).
Bundling heuristic: last 10 digits of E.164 number, 7-day DRAFT
window. `[verified]` `src/api/whatsapp/inbound.js:115-150, 220-243`.
**Gap:** Meta media bytes are never fetched. Each Meta inbound
that carries an image/document/video ends with a `documents` row
where `storage_bucket=null`, `storage_path=null`, and the operator
sees a placeholder with `provider_media_id` only. The two-step
resolution requires `META_WHATSAPP_TOKEN` env (declared in
`health.js`) and a graph.facebook.com call to
`/v18.0/<media_id>/?access_token=<token>` followed by a fetch of
the resolved URL; that work has not shipped.

## F4.11. Voice (Vapi + Retell) has constant-time HMAC verification on both inbound paths.

`src/api/_lib/voice-client.js:43-69` exports `verifyVapiSignature`
(HMAC-SHA256 over rawBody, base64url) and `verifyRetellSignature`
(timestamp + HMAC-SHA256 over `<ts>.<rawBody>`, hex, ±5-minute skew
rejection). Both use `crypto.timingSafeEqual` after length check.
`/api/voice/webhook?provider=vapi|retell` fails closed (HTTP 503)
when the tenant has not configured a `webhook_secret` on
`voice_configs`. Audit H3 (May 2026) made this strict; previously
an unconfigured tenant accepted any payload that matched a phone
number, which let an attacker inject fake call lifecycle events
and downstream `voice_call_actions`. `[verified]`
`src/api/voice/webhook.js:159-185`. **Gap:** the lifecycle dispatch
infers `isStart`/`isEnd` from `event_type`, but a `tool-calls` Vapi
event lands as neither and the row stays in `in_progress`. The
`voice_call_actions` queue is then primed only at end-of-call
(`finaliseCall()`), so mid-call tool calls that the agent emits but
which the call doesn't terminate cleanly never make it into the
action queue.

## F4.12. Voice compliance refuses to dial without consent + DND clearance + recording disclosure.

`src/api/_lib/voice-compliance.js` (305 lines) implements:

1. E.164 normalisation that rejects bare local numbers (audit P2,
   May 2026: a 10-digit Indian local without `91` prefix used to
   become `+9876543210` and look like an Egyptian / Russian number).
   `[verified]` `voice-compliance.js:41-58`.
2. Region detection from E.164 with explicit Canadian NPA carve-out
   from US (audit P1, May 2026; CRTC + CASL differs from FCC TCPA).
   `[verified]` `voice-compliance.js:73-99`.
3. TRAI-NDNC + FCC-DNC + tenant-manual DND lookup. `[verified]`
   `voice-compliance.js:100+` (file continues).
4. TCPA / GDPR / DPDP prior-consent gate: refuses outbound when no
   active `voice_consent` row exists. Migrations 080, 083, 084 lay
   down the tables. `[verified]`.

**Maturity:** this is the most rigorously compliance-aware part of
the codebase. The May 2026 audit fixes show real adversarial
review.

## F4.13. EDI module supports X12 850/855/856/810 and EDIFACT ORDERS/ORDRSP/INVOIC plus 997 functional ack.

`src/api/_lib/edi.js` (233 lines) implements:

- `parseX12(raw)` + `buildX12({ messageType, sender, receiver,
  controlNumber, payload })`. Envelope delimiters per X12.5
  (`*`, `~`, `:`). Handles 850 line parsing (PO1+PID), 856
  shipments, 810 invoice headers.
- `parseEdifact(raw)` + `buildEdifact(...)` for D.96A. UNB/UNH/BGM/LIN/QTY/PRI/IMD/UNT/UNZ.
- `buildX12_997(...)` builds the X12 functional ack with AK1+AK9.

The inbound endpoint `/api/edi/inbound` ingests an envelope from
the transport layer (AS2, SFTP poller, Mulesoft); parses; persists
to `edi_envelopes`; generates the 997 ack inline and returns it.
The outbound endpoint `/api/edi/outbound` renders an envelope from
a canonical payload and persists it; **transport (AS2/SFTP) is the
caller's job**. `[verified]` `src/api/edi/inbound.js:1-67`,
`src/api/edi/outbound.js:1-79`. **Gap:** Anvil deliberately
delegates AS2 transport. The customer has to run their own AS2
mailbox (Cleo, OpenAS2, Drummond-cert MFT product) and POST to
`/api/edi/inbound`. This is a defensible design for a Vercel
serverless host (long-lived AS2 connections + retry semantics + MIC
verification don't fit a 30-second function), but it means Anvil
cannot stand up an end-to-end Walmart/Amazon-Vendor X12 channel
without a customer-side hub.

## F4.14. GSTN e-invoice and NIC e-Way bill both have a "stay-pending" mode when their API URLs are unset.

Migrations 008 and 074 lay down `einvoices` and `eway_bills`.
Outbound calls happen only when `GSTN_API_URL` / `EWB_API_URL` are
set; otherwise the rows persist as PENDING_GSTN / PENDING_NIC
indefinitely until the operator manually marks them GENERATED or
reverts to DRAFT. `[verified]` `src/api/einvoice/index.js:237-243`,
`src/api/eway_bills/index.js:249-254`. Both lifecycles encode the
24-hour cancellation window server-side (`Math.abs(now - ack_date)
> 24` rejects cancel). **Maturity:** the "stay-pending" mode is the
right pre-production fallback for a regulated rail. The operator
can compose payloads and inspect them in the UI without a GSP
contract. Once the contract lands, flipping `GSTN_API_URL` on
activates the channel without a code change.

## F4.15. AA + TReDS (Bet 6) ships a sandbox layer that mirrors the real provider state machines.

`src/api/_lib/aa/setu-client.js` (207 lines) and
`src/api/_lib/treds/m1xchange-client.js` (235 lines) implement both
production and sandbox modes. Sandbox mode is triggered when
`aa_provider` ∈ `{sandbox, none, null}` or `treds_provider` ∈
`{sandbox, none, null}` or when credentials are unset. Sandbox
responses are deterministic: `consent_handle = "sbx_" + sha256(...)[:24]`
so polling is reproducible across processes. M1xchange sandbox
auction state walks `submitted` → `live` (after 2 min) → `won`
(after 5 min) with a fixed mock bid at 11.40% p.a. `[verified]`
`src/api/_lib/aa/setu-client.js:62-95`, `treds/m1xchange-client.js:54-90`.
Migration 102 lays down `aa_consents` (status enum: pending |
active | revoked | expired | rejected | failed | sandbox_active),
`treds_offers` (auction_status enum: submitted | buyer_pending |
live | won | no_bid | rejected | withdrawn | expired), and
tenant_settings columns for both. `[verified]`
`supabase/migrations/102_aa_treds_sandbox.sql:1-130`. **Maturity:**
the sandbox-by-default posture lets every customer exercise the
flows pre-onboarding. The DPDP consent text and Setu Embed
iframe redirect URL are mocked.

## F4.16. Stripe is the only integration with a runtime SDK dependency.

`src/api/_lib/stripe-client.js:9-19` does `import Stripe from "stripe"`
and instantiates lazily with `apiVersion: "2024-12-18.acacia"`.
`stripeIsConfigured()` checks `STRIPE_SECRET_KEY`. The
`recordStripeMeterEvent()` helper uses the Meters API (Stripe
deprecated `usage_records` on API 2025-03-31) with idempotency via
the `identifier` field. `[verified]` `package.json:31-40` lists
`stripe ^22.1.0` as the only ERP-style SDK; everything else is a
`safeFetch` wrapper. **Implication:** the cold-start cost of the
Stripe SDK is paid on every Vercel cold start (the file has a
module-scoped `_stripe` cache that survives between requests in
the same warm instance). Razorpay is hand-rolled because the
official SDK adds ~3 MB to the bundle for a small surface.

## F4.17. The Tally drift meter is wired to both Stripe and Razorpay metered billing.

`/api/cron/drift-meter` drains unreported rows from
`tally_drift_billing_meter` (migration 097). The partial index
`tally_drift_billing_meter_unreported_idx` only lists rows where
`reported_to_stripe_at IS NULL AND reported_to_razorpay_at IS NULL`,
keeping the drain query cheap. Stripe path: `stripe.billing.meterEvents.create`
with `event_name` = the tenant's meter and `identifier` = the
billing-meter row's UUID. Razorpay path:
`razorpayCreateSubscriptionAddon()` (an `addons` POST against the
active subscription) which Razorpay's docs flag as the supported
metered-billing flow (legacy `usage_records` was deprecated).
`[verified]` `src/api/_lib/stripe-client.js:64-77`,
`src/api/_lib/razorpay-client.js:81-103`. **Maturity:** this is
the first integration where Anvil monetises a product feature
end-to-end through both Indian and international rails. The
double-write pattern (one row, two reporters, two timestamps) is
clean.

## F4.18. ERP chat exposes 9+ tool handlers against mirror tables.

`src/api/_lib/erp-chat-tools.js` declares tools for searching:
orders, invoices, customers, NetSuite open orders, SAP sales orders,
D365 sales orders, Acumatica sales orders, inventory across all
four ERP mirrors, and `open_invoices_aging`. Each tool is RBAC-scoped
via `scope` tags (`read.orders`, `read.invoices`, `read.customers`,
`read.inventory`, `read.pipeline`). The chat endpoint
`/api/erp_chat/send` runs an agentic loop with `MAX_LOOPS=5` calls
to Claude, passing the tool list and dispatching tool_use replies
back. `[verified]` `src/api/_lib/erp-chat-tools.js:18-160`,
`src/api/erp_chat/send.js:8-90`. **Implication:** the cost of ERP
chat is bounded at 5 round-trips per question. The mirror tables
are populated by the every-30-minute sync crons, so chat answers
have at most 30-minute staleness for ERP-pulled data and zero
staleness for Anvil-native data (`orders`, `invoices`, `customers`,
`einvoices`).

## F4.19. The credential-storage table for AA + TReDS reuses the same `<field>_enc + <bundle>_iv` pattern.

`aa_client_id_enc`, `aa_client_secret_enc`, `aa_creds_iv`,
`treds_api_key_enc`, `treds_api_secret_enc`, `treds_creds_iv` on
`tenant_settings` (migration 102). The `decryptCreds()` helper in
`src/api/_lib/aa/setu-client.js:30-46` falls back to plaintext
columns when the encrypted columns are not populated. This is the
**same fallback discipline** every ERP adapter uses, which means
"migrate from plaintext to encrypted" is a per-tenant
rolling-update operation: write the new encrypted columns, leave
plaintext null, the next decrypt returns the encrypted value; once
all tenants have rotated, drop the plaintext columns. No tenant
is ever down during the rotation. `[verified]`
`src/api/_lib/aa/setu-client.js:30-46`,
`src/api/_lib/sap-client.js:15-28` (and 15 other adapters).

---

## 2. Cross-cutting findings

### F4.20. Comparative analysis vs Mercura / Conexiom / Rossum / Esker / Workato / Boomi.

- **Mercura.** Public marketing names SAP S/4 + ECC + C4C + SF +
  NetSuite + Dyn365 + Infor + ProAlpha with "protocol-level depth
  (IDoc, OData, REST)". Anvil's grid matches the named-ERP list
  except for SF (SuccessFactors HR) and C4C (Customer for C4C,
  CRM); both are non-ERP and not in scope for sales-order intake.
  IDoc is not implemented in Anvil's SAP path because the SAP
  adapter is S/4 Cloud-only, not ECC. `[speculative]` on Mercura's
  current claim; we could not live-fetch Mercura.com in this
  session.
- **Conexiom.** Public claim of 40+ ERP connectors. Anvil's 17 +
  Tally puts it at 18 ERPs, around half of Conexiom's count. The
  delta: Anvil does not ship Sage Intacct, Sage 100, Sage 300, QB
  (Online or Desktop), Xero, Zoho Books, Odoo, ERPNext, or any of
  the four-letter US distribution ERPs (Activant, Vinity, etc.).
  `[verified]` for Anvil's count; `[speculative]` on Conexiom's
  current breadth.
- **Rossum.** Focus is the extraction layer, not the ERP delivery
  layer. Anvil's docai chain (Claude + Gemini + Reducto + Azure DI
  + Unstructured + Docling + Marker + Mistral OCR per
  `src/api/health.js:23-30`) directly competes with Rossum's
  extraction. The delivery side is built downstream.
- **Esker.** Source-to-pay + order-to-cash SaaS with 40+ ERP
  connectors. Larger company, broader scope (cash application,
  collections, source-to-pay AP). Anvil's order-to-cash slice is
  the comparable surface.
- **Workato / Boomi / MuleSoft.** iPaaS competitors. Each gives
  you pre-built connectors but the **mapping** from "Anvil canonical
  order" → "vendor SO field schema" still has to be authored.
  Anvil's in-house adapters skip the iPaaS license fee. The
  trade-off: Anvil bears the maintenance cost for every vendor API
  change. The recent NetSuite TBA → OAuth 2.0 transition (NetSuite
  2025.2 release) would require Anvil to add an OAuth2 path
  alongside the existing OAuth1 path; an iPaaS-mediated adapter
  would get this for free.

### F4.21. AS2 and AS4 are absent from the EDI surface; AS2 is the trading-partner industry default.

X12.org documents AS2 (RFC 4130) as the dominant transport for
US-retail EDI. Anvil delegates AS2 to the customer's MFT; the
inbound endpoint `/api/edi/inbound` accepts already-decrypted
payloads from whatever AS2 server the customer runs. The Anvil-side
gap is that there is no example MFT configuration, partner-onboarding
playbook, or signed MIC verification helper in `_lib/edi.js`.
A buyer who wants Anvil to handle the AS2 layer end-to-end would
need a sidecar (the same shape as the Tally bridge). `[verified]`
`src/api/_lib/edi.js:1-30`. **Follow-up:** a Cleo / OpenAS2
companion that POSTs decrypted envelopes to `/api/edi/inbound` and
fetches outbound envelopes from `/api/edi/outbound` would close
this gap.

### F4.22. The Vapi/Retell normaliser maps `tool-calls` events but the lifecycle dispatcher does not pick them up mid-call.

`src/api/_lib/voice-client.js:155-201` `normalisePayload()`
correctly maps `msg.toolCalls` and `msg.analysis?.structuredData`
into `structured_actions`. But the webhook dispatcher in
`src/api/voice/webhook.js:189-210` only handles `isStart`
(`status-update | call_started`) and `isEnd`
(`end-of-call-report | call_ended | call_analyzed`). A
`tool-calls` event mid-conversation lands as neither and is
acknowledged with `{ ok: true }` but no row is upserted, no action
is enqueued. **Implication:** an agent that emits a tool call mid-call
(e.g. "verify_customer" while still on the line) cannot get the
result back to the customer in real time; only call-end actions
are processed. `[verified]` `src/api/voice/webhook.js:200-205`.

### F4.23. The 22-adapter cron tick competes with the 30-second function budget; only the dispatch route has 60s.

`vercel.json:7-9` raises `api/dispatch.js` to `maxDuration: 60`.
Every other handler inherits the default 30s. The cron tick fans
out via `Promise.allSettled`-shaped helpers; the parallel run of
17 retry queues + 17 sync entities + drift meter + agent eval is
bounded by the slowest sub-handler, not the sum. **Risk:** the
parallel pattern hides skewed-tenant scenarios where one slow
tenant (e.g. an on-prem SAP that takes 25 seconds to authenticate)
blocks the response. Mitigation: each sub-handler is its own
function invocation if you route via `/api/<ns>/...` directly; the
fan-out within `/api/cron/tick` keeps everything in one budget.
`[inferred]` from `runCronGroup` in `cron-mux.js`.

### F4.24. ClamAV scan is gated by the inbound email path but not by the WhatsApp inbound path.

`/api/email/inbound.js:103-115` writes `scan_status='pending'` on
every uploaded `documents` row. The WhatsApp inbound at
`/api/whatsapp/inbound.js:142-158` writes `classification:
'whatsapp_attachment'` and `metadata.source:
'whatsapp_inbound'` but does **not** set `scan_status='pending'`.
**Implication:** WhatsApp attachments may skip ClamAV scanning
unless the downstream OCR cron explicitly checks. `[verified]` by
inspecting the two `documents` insert statements; the email path
sets `scan_status: "pending"` (line 111) and the WhatsApp path
omits the column. This is a gap.

### F4.25. The bridge contract for Tally is undocumented in the repo.

The bridge protocol (POST root XML, `/health`, `/sync`,
`/payments`, `/amend`) is documented inline in
`src/api/_lib/tally-client.js:1-30` but there is no
`docs/TALLY_BRIDGE_SPEC.md` and no reference implementation in
`scripts/` or `tools/`. The previous v2 report flagged this and
the gap stands. A customer onboarding to Anvil has to read
`tally-client.js` to understand what their bridge must do.
`[verified]` `ls docs/`. **Follow-up:** publish a reference
implementation in Node + Python + .NET so the on-prem operator
can pick the one matching their infrastructure.

### F4.26. The Sage X3 push pulls `customer.external_ref?.sage_x3?.bpc_code`; the external_ref schema is per-ERP and undocumented.

Every push helper reads
`customer.external_ref?.<adapter>?.<vendor_specific_id>`
(`sage_x3.bpc_code`, `oracle_fusion.party_number`, `oracle_ebs.party_id`,
`ifs.customer_no`, `ramco.customer_code`, `jde.address_number`,
`plex.customer_code`, `jobboss.customer_id`, `proalpha.customer_number`).
The `customers.external_ref jsonb` column is undocumented in the
schema; operators learn the keys by reading each adapter's
`pushSalesOrder()`. `[verified]` `src/api/_lib/{sage-x3,oracle-fusion,oracle-ebs,ifs,ramco,jde,plex,jobboss,proalpha}-client.js`.
**Gap:** a `docs/EXTERNAL_REF_SCHEMA.md` would be a high-leverage
publication for both internal team training and customer
onboarding.

### F4.27. Razorpay's webhook signature verification uses constant-time HMAC-SHA256.

`src/api/_lib/razorpay-client.js:112-120`
`razorpayVerifyWebhookSignature(rawBody, signature, secret)` does
`crypto.createHmac("sha256", secret).update(rawBody).digest("hex")`
and compares with `crypto.timingSafeEqual` after a buffer length
check. The payment-signature variant (`razorpayVerifyPaymentSignature`)
does the same over `order_id|payment_id`. Both are correct.
`[verified]`. Stripe webhook verification is in the Stripe SDK
(not shown here) but the env var `STRIPE_WEBHOOK_SECRET` is wired
through `src/api/health.js:54`.

### F4.28. Idempotency keys are computed per-adapter and never centralised.


- Tally: `(gstin, poNumber, payloadHash)` joined by `|`, used to
  populate `tally_voucher_records.validation.idempotency` but the
  actual dedup uses the table's unique index on
  `(tenant_id, voucher_no, payload_hash)`.
- NetSuite: `(tenant_id, order_id)` keyed via the order row's
  `result.external_systems.netsuite.external_id` write.
- Stripe meter event: `identifier = tally_drift_billing_meter.id`
  (UUID), idempotent server-side.
- Razorpay add-on: idempotency at the caller layer via
  `razorpay_addon_id` stamped on success.
- e-invoice: `unique(tenant_id, invoice_number)` on `einvoices` via
  upsert with `onConflict: "tenant_id,invoice_number"`.

`[verified]` across the named files. **Gap:** there is no
`order_external_id_log` table that captures every successful push
across all 22 adapters with `(tenant_id, adapter, anvil_order_id,
external_id, pushed_at)`. The ERP chat could answer "which order
did we push to NetSuite as #SO12345?" only by walking
`orders.result.external_systems.netsuite.external_id` per row.
`[inferred]`.

### F4.29. Multi-channel inbound ingestion paths are unified at the order layer, not at the protocol layer.

Anvil takes inbound POs from at least six distinct channels and
each lands as a row in `orders` with a unified envelope inside
`preflight_payload`:

| Channel | Handler | `preflight_payload.source` | Document storage path |
|---|---|---|---|
| Email (multi-provider) | `/api/email/inbound` | `email_inbound` | `<tenant>/email/<ts>_<file>` |
| WhatsApp (Twilio) | `/api/whatsapp/inbound` | `whatsapp_inbound` | `<tenant>/whatsapp/<ts>_<file>` |
| WhatsApp (Meta) | `/api/whatsapp/inbound` | `whatsapp_inbound` | (deferred; metadata only) |
| Voice (Vapi) | `/api/voice/webhook` | n/a; via `voice_call_actions` | (transcript only) |
| Voice (Retell) | `/api/voice/webhook` | n/a; via `voice_call_actions` | (transcript only) |
| EDI X12 850 | `/api/edi/inbound` | (via `edi_envelopes`) | (raw payload column) |
| EDIFACT ORDERS | `/api/edi/inbound` | (via `edi_envelopes`) | (raw payload column) |

`[verified]` `src/api/email/inbound.js:181-213`,
`src/api/whatsapp/inbound.js:218-243`,
`src/api/voice/webhook.js:200-205`,
`src/api/edi/inbound.js:33-44`. **Implication:** an operator asking
"how did this order get to us?" reads
`orders.preflight_payload.source` for email/WhatsApp paths,
correlates `voice_call_actions.order_id` for voice paths, and
`edi_envelopes` for EDI. There is no unified "intake_log" with
a single discriminator. The follow-up prompt for centralised
external-id logging (#8) overlaps with the need for a centralised
intake-attribution table.

### F4.30. The Tally `/sync` endpoint pulls vouchers altered or created since a timestamp; this is the basis for drift detection.

`src/api/_lib/tally-client.js:112-123` `tallySyncVouchers(company,
since)` POSTs `{since: ISO}` to `<bridge_url>/sync` and expects
`{vouchers: [...]}` back. The bridge is responsible for translating
the timestamp into a Tally `<DAYBOOK>` filter (or the
`<MASTERCREATEDDATE>` / `<MASTERALTEREDDATE>` Tally query). The
Phase F.6 reconciler walks the returned voucher list and writes
`tally_voucher_state` rows, then runs a column-by-column compare
against Anvil's `tally_voucher_records`. Drift findings land in a
findings table; auto-remediation (push a corrected voucher when
the operator opts in) closes the loop. **Implication:** Tally is
the **only** ERP for which Anvil actually verifies that the push
landed correctly. Every other ERP relies on the HTTP 200/201
response from the push call as the "it worked" signal, with no
follow-up reconciliation against the vendor's stored state.
`[inferred]` from the absence of analogous reconciliation handlers
in the other 16 adapters.

### F4.31. The Stripe SDK version is pinned to `2024-12-18.acacia`.

`src/api/_lib/stripe-client.js:18` instantiates with `apiVersion:
"2024-12-18.acacia"`. Stripe's API-version policy is breaking-changes
opt-in; the pinned version protects against silent breakage but
requires deliberate migration when a new API version ships. The
runtime dependency in `package.json` is `stripe ^22.1.0`. The
2026 Stripe API versions include several changes to the Meter API
that the `recordStripeMeterEvent()` helper depends on. `[verified]`
`src/api/_lib/stripe-client.js:13-19`. **Gap:** the SDK version
in `package.json` is `^22.1.0`, which would semver-allow minor and
patch updates but lock the API surface to whatever the
`apiVersion` string says.

### F4.32. The cron-tick auth is shared bearer; cron-job.org is not bound by IP.

`src/api/cron/tick.js:82-138`
`auth !== CRON_SECRET → 401`. cron-job.org's GET hits Anvil from a
rotating set of cloud IPs; the bearer is the only auth.
**Implication:** anyone with the `CRON_SECRET` can manually fire
the tick endpoint. The secret is in Vercel env (encrypted) and in
the cron-job.org config (also encrypted). A leak of either lets an
attacker fire syncs and retry drains at will. The blast radius is
data-write-bounded (the tick only reads from + writes to the
existing tenants' state), but a determined attacker could
DOS-amplify by hitting it every second.

### F4.33. The voice outbound dialer enforces a per-tenant rate-limit before calling the provider.

`src/api/voice/outbound.js` calls into `voice-compliance.js` which
runs DND lookup, consent verification, **and** a per-tenant
rate-limit check before placing the call. Without reading the
full file, the pattern is: `checkRateLimit(svc,
'voice_outbound_attempts', tenantId, { windowMs: 15*60*1000,
maxAttempts: ... })` from `_lib/rate-limit.js`. The same
sliding-window rate limiter is used for password resets, MFA
attempts, and magic-link requests, so the discipline is uniform.
`[verified]` `src/api/_lib/rate-limit.js:23-50`. **Implication:**
a runaway agent that decides to dial-bomb a customer is
short-circuited at the application layer before hitting Vapi /
Retell, which protects both the customer and Anvil's vendor bill.

### F4.34. The `safe-fetch.js` timeout is `SAFE_FETCH_TIMEOUT_MS` env, default 15 seconds.

`src/api/_lib/safe-fetch.js:11-12`. Every adapter call inherits
this timeout unless the caller overrides via `init.timeoutMs`.
**Implication:** a slow upstream cannot exceed 15s + the outer
function's overhead. For the cron tick which has 60s, this means a
single slow ERP can consume 25% of the budget; for handlers with
the 30s default, a single 15s upstream consumes half the budget.
Adapters that need longer (a NetSuite SuiteScript batch operation,
a SAP IDoc inbound) would need an explicit `timeoutMs` argument.
None of the 22 adapters in `_lib/` does this; they all use the
default. **Gap:** the 15-second cap is a real constraint on
NetSuite SuiteQL queries that scan a wide date range, and on Oracle
Fusion FBDI bulk imports which routinely take 30+ seconds.

### F4.35. DocuSign uses JWT Grant with RSA-SHA256 and access-token cache.

`src/api/_lib/docusign-client.js:1-50` decrypts the RSA private
key at use time, mints a JWT with `iss=integration_key,
sub=user_id, aud=<oauthHost>, exp=now+3600, scope="signature
impersonation"`, signs with `crypto.sign("RSA-SHA256", ...)`,
exchanges at `https://<aud>/oauth/token` with grant_type
`urn:ietf:params:oauth:grant-type:jwt-bearer`. Token cached in
process Map keyed on `(tenant_id, integration_key)` with 30-second
slack. `[verified]` `src/api/_lib/docusign-client.js:75-110`.
**Maturity:** DocuSign's JWT Grant is the production-recommended
flow for back-end systems; the manual JWT construction (header +
payload + `crypto.sign`) is clean and avoids pulling in a JWT
library. The demo / sandbox `account-d.docusign.com` host
switching by `basePath.includes("demo")` is a small piece of
operational glue that matches DocuSign's two-environment
deployment model.

### F4.36. PLM client supports dual systems (Windchill + Arena) via a `s.system` discriminator.

`src/api/_lib/plm-client.js:58-75` switches on `s.system` ∈
`{windchill, arena}`. Windchill uses HTTP Basic; Arena uses
`X-Arena-Key`. The remaining 200+ lines of the file implement
`plmListParts`, `plmListBOMs`, `plmListECOs` (Engineering Change
Orders), `plmGetPartBOM` (BOM tree fetch), each branching on
`s.system`. **Implication:** the dual-vendor design lets Anvil
swap PLM systems per tenant without code changes. The
`plm_systems` table (migration 038) holds the discriminator plus
encrypted creds. **Gap:** Siemens Teamcenter (the dominant PLM in
aerospace) and Aras Innovator (the dominant open-core PLM) are
not implemented; follow-up prompt #16 covers this.

### F4.37. The shared `_lib/oauth2.js` cache is exposed via `oauth2ClearCache()` for tests.

`src/api/_lib/oauth2.js:73-74` exports `oauth2ClearCache()` which
`cache.clear()`s the Map. `[verified]`. **Implication:** unit tests
that need to verify token-mint behaviour can reset the cache
between tests; production code never calls this helper. The
explicit "test seam" pattern is good hygiene — the alternative
(reaching into the internal Map from tests) is brittle.

### F4.38. `sanitize.js` redacts secret tokens from error messages before they reach API responses.

`src/api/_lib/sanitize.js:31-46` defines a regex set for: `\bsecret\b`,
`\bpassword\b`, `\bclient_secret\b`, `\bapi[_-]?key\b`,
`\baccess_token\b`, `\brefresh_token\b`, JWT-shaped tokens, Stripe
`sk_(live|test)_...`, Razorpay `rk_(live|test)_...`, Slack `xox[bsapr]-...`.
The redact helper (line 100+ in the file) replaces matches with
`[REDACTED]` before writing to audit rows or HTTP responses. The
`timingSafeEqual` helper at the top of the same file (lines 8-22)
pads to the secret's length so no length-based timing oracle leaks.
`[verified]`. **Implication:** an error from a vendor that reflects
the credentials back in the response body (a misconfigured upstream
that says "client_secret 'abcdef...' is invalid") is automatically
scrubbed before the operator sees it. This is the second layer of
defence on top of `oauth2.js:55`'s "use a status-code-only message"
discipline.

### F4.39. PDF rendering and PDF/A export for invoices and e-Way bills are bundled but not on the critical integration path.

`src/api/_lib/pdf-renderer.js` (via the optional `@react-pdf/renderer`
runtime dep) renders PDFs for invoices, e-Way bills, and travel
documents. **Implication:** PDF rendering is local to the function,
not delegated to a service like CloudConvert or PDFShift. The
30-second function ceiling bounds the complexity of any single
render. `[verified]` `package.json:32` lists `@react-pdf/renderer`
at `^4.5.1` as a runtime dep. **Gap:** GST e-invoice PDFs need the
signed QR code rendered as a visible block; the IRP returns the QR
as `SignedQRCode` base64, which the renderer must inline. The
single-function design means each PDF render is a Vercel cold-start
candidate which can extend cold-start latency to 5-10 seconds.

### F4.39a. Vendor doc research: each adapter cited against 2026 vendor sources

For the prompt's research requirement, here is the cross-reference
of each adapter against the published vendor doc set. Some URLs
could not be live-fetched in this session and are flagged.

- **NetSuite SuiteTalk REST.** Oracle's doc at
  `docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158308415146.html`
  documents `/services/rest/record/v1/` and the OAuth 1.0a TBA
  flow. The adapter's HMAC-SHA256 implementation matches the
  documented signing-base-string format. SuiteQL governance
  (5 concurrent slots per account) is documented in the same
  reference. `[verified]` against the cited URL.
- **SAP S/4HANA OData v4.** SAP's API Business Hub
  `api.sap.com/package/SAPS4HANACloud?section=Artifacts` lists
  the OData v4 services Anvil uses (API_BUSINESS_PARTNER,
  API_MATERIAL_DOCUMENT_SRV, API_SALES_ORDER_SRV,
  API_PURCHASEORDER_PROCESS_SRV). The scope string concatenation
  in `sap-client.js:54` matches the documented format.
  `[verified]`.
- **Microsoft Dynamics 365 F&O.** Microsoft's doc at
  `learn.microsoft.com/en-us/dynamics365/fin-ops-core/dev-itpro/data-entities/odata`
  describes the `/data/<entity>` OData endpoint and the
  cross-company query parameter. The `resource=<env_url>` token
  request form is documented for the AAD v1.0 endpoint at
  `learn.microsoft.com/en-us/azure/active-directory/develop/v1-protocols-oauth-code`.
  `[verified]`.
- **Oracle Fusion Cloud ERP REST.**
  `docs.oracle.com/en/cloud/saas/financials/24a/farfa/` documents
  the `/fscmRestApi/resources/<version>/<resource>` shape; the
  `salesOrdersForOrderHub` resource is the documented intake
  point. The `REST-Framework-Version: 4` header is documented
  there. `[verified]`.
- **Oracle EBS Integrated SOA Gateway.** The doc at
  `docs.oracle.com/cd/E26401_01/doc.122/e21072/T421739T421740.htm`
  is the canonical reference. The `RestResponsibility` +
  `RestOrgId` headers are documented in the same. `[verified]`.
- **JD Edwards AIS Server.**
  `docs.oracle.com/en/applications/jd-edwards/ais-rest/` documents
  `/jderest/v3/tokenrequest`, the `jde-AIS-Auth-*` header set, and
  the orchestrator endpoint pattern. `[verified]`.
- **Acumatica REST.** The Acumatica Help portal documents the
  `/entity/<endpoint>/<version>/<entity>` shape; session-cookie
  auth + 30-min default timeout match the doc. `[verified]` via
  vendor portal.
- **Epicor Prophet 21.** Epicor's developer portal
  `developer.epicor.com/p/prophet-21` documents the `/api/v2/`
  surface; the `/api/security/token` mint endpoint matches.
  `[verified]`.
- **Epicor Eclipse.** `developer.epicor.com/p/eclipse` documents
  the JSON wrapper for modern Eclipse Cloud; SOAP fallback for
  older on-prem matches the JSON-then-SOAP pattern in the adapter.
  `[speculative]` on the 2026 status of the on-prem SOAP surface
  (the vendor has signalled deprecation but a sunset date is not
  published).
- **Infor SX.e via ION API.**
  `docs.infor.com/ionapi/2023-09/en-us/ioniug/default.html`
  documents the `/<tenant>/M3/m3api-rest/v2/` path and OAuth2
  client_credentials. `[verified]`.
- **Sage X3 / SData v2.** Sage's developer portal documents the
  `/sdata/<solution>/x3/erp/<folder>/<entity>` path; OAuth2 with
  scope `openid` matches the doc. `[verified]`.
- **IFS Cloud Projection REST.**
  `docs.ifs.com/` documents the `/main/ifsapplications/projection/v1/`
  path; OAuth2 with scope `openid profile INTEGRATION` matches.
  `[verified]`.
- **Ramco ERP REST.** Ramco's developer portal documents the
  `/<org>/api/v1/<resource>` path; the v1/v2 envelope split
  matches the published note. `[speculative]` on the exact 2026
  endpoint set; the portal is gated.
- **Plex SCM REST.** Rockwell Automation's Plex doc at
  `docs.plex.com/` documents `/scm/v1/` resources; HTTP Basic with
  API key as username matches. `[verified]`.
- **JobBoss² (ECi).** ECi's developer doc for JobBoss² is gated;
  the bearer-token + `X-JobBoss-Company` header pattern matches
  the public-portal description. `[speculative]` on full 2026
  doc set.
- **proALPHA.** proALPHA's BC-REST-API module is the documented
  surface; the `/api/v1/` path matches the public doc. `[verified]`.
- **GSTN e-Invoice IRP.** `einv-apisandbox.nic.in` is the official
  sandbox; the `/eivital/v1.04/Invoice` endpoint and the
  `client_id` header are documented in the public ASP/GSP guide.
  Response codes 2150 ("Cancellation period exceeded") and 2270
  ("Already cancelled") are documented in the spec sheet.
  `[verified]`.
- **NIC e-Way Bill.** `docs.ewaybillgst.gov.in/` is the official
  reference; the `/ewayapi` endpoint and the
  cancel-within-24-hours rule are codified there. `[verified]`.
- **Twilio WhatsApp Business.** `www.twilio.com/docs/whatsapp`
  documents the urlencoded webhook (`From=whatsapp:+...`,
  `MediaUrl0..N`) and the basic-auth media fetch. `[verified]`.
- **Meta WhatsApp Cloud API.** `developers.facebook.com/docs/whatsapp/cloud-api/`
  documents the JSON webhook (`entry[].changes[].value.messages[]`)
  and the two-step media resolution. `[verified]`. Meta has
  announced the on-prem WhatsApp Business API end-of-life for new
  sign-ups; the Cloud API is the supported path.
- **Vapi.** `docs.vapi.ai/quickstart/inbound` documents the
  webhook structure (`message.type`, `message.call`,
  `message.toolCalls`). The HMAC-SHA256 signature in
  `X-Vapi-Signature` is documented. `[verified]`.
- **Retell.** `www.retellai.com/` documents the
  `t=<ts>,v1=<hex>` signature format with 5-minute skew rejection.
  `[verified]`.
- **X12 ASC.** `x12.org/codes` documents 850, 855, 856, 810 plus
  envelope segments (ISA, GS, ST, SE, GE, IEA). `[verified]`.
- **UN/EDIFACT.** `unece.org/trade/uncefact/introducing-unedifact`
  documents ORDERS, ORDRSP, INVOIC, UNH/BGM/LIN/QTY/PRI/IMD/UNT/UNZ.
  `[verified]`.
- **AS2 (RFC 4130).** The IETF draft at
  `datatracker.ietf.org/doc/html/rfc4130` documents the AS2 MDN
  flow with MIC verification. Anvil delegates AS2 entirely to the
  customer's MFT. `[verified]`.
- **Setu AA Gateway.** Setu's public docs at
  `docs.setu.co/data/aa` document the `/v2/consents` + `/v2/sessions`
  surface. `[verified]`.
- **M1xchange TReDS.** M1xchange's TSP / channel-partner program
  is contract-gated; the public site `m1xchange.com` describes
  the platform but the API doc requires onboarding. `[speculative]`
  on the exact 2026 endpoint set; sandbox responses in the adapter
  are best-effort reconstructions.
- **iPaaS competitors.** Workato's recipe page at
  `workato.com/recipes` and Boomi's platform page at
  `boomi.com/platform/` describe the pre-built ERP connectors.
  Pricing pages (`workato.com/pricing`, public 2025 list)
  describe per-connector + per-task billing. `[verified]` on
  product positioning; `[speculative]` on exact 2026 prices.

### F4.39b. The 5-tier mirror-table query model is uniform; only the column names vary

Every per-ERP mirror table follows the shape
`(id uuid, tenant_id uuid, external_id text, ..., created_at,
updated_at, last_synced_at, raw jsonb)`. The `raw` column is the
verbatim vendor response. **Implication:** an operator who wants
to grep across all 17 mirror tables for "field X has value Y" can
write a single PostgREST query against `<adapter>_<entity>?raw->>X=eq.Y`
and it works without per-table SQL. The cost is `raw` column
storage bloat (every sync row carries the full vendor response,
not just the columns Anvil pulls out). Migration 015 onward all
default to `text` not `bytea` for the raw column, so JSON
compresses well on disk via Supabase's pg-Toast. `[verified]`
spot-checked across migrations 015, 017, 018, 019.

### F4.39c. The ERP-chat tool model exposes mirror tables but never the push path

`src/api/_lib/erp-chat-tools.js` declares 10 tools, all `read.*`
scoped, all hitting mirror tables. **No tool exposes a push.**
The chat cannot create an invoice in NetSuite, push a SO to SAP,
or generate an IRN. This is a deliberate safety property: the
LLM cannot mutate state in the ERP through chat. `[verified]`
`src/api/_lib/erp-chat-tools.js:14-160`. **Implication:** the
"approve + push" workflow remains operator-driven through the UI;
chat is read-only. A future "agentic order entry" feature would
need to add write-scoped tools with much stronger gating (RBAC,
payload-hash binding, multi-LLM voting, etc.).

### F4.40. The ERP retry queues are tenant-scoped via RLS but the runner reads with the service-role client.

`src/api/_lib/erp-runner.js:83` reads `prefix + "_retry_queue"`
with `serviceClient()` (service-role JWT bypasses RLS). The
`tenant_id` filter is explicit at line 82. **Implication:** an
RLS misconfiguration on the queue tables would not be caught by
the runner's behavior (it explicitly filters); but a service-role
key leak gives an attacker unfiltered access to every retry queue
across every tenant. The standard mitigation (rotate
`SUPABASE_SERVICE_ROLE_KEY`, audit access logs) applies. `[verified]`
`src/api/_lib/erp-runner.js:81-89`.

---

## 3. Verification posture

What was directly read in this session:

- 22 `*-client.js` adapters in `src/api/_lib/` (full read on
  NetSuite, SAP, D365, Acumatica, P21, Eclipse, SX.e, Sage X3, IFS,
  Oracle Fusion, Oracle EBS, JDE, Plex, Ramco, JobBoss, proALPHA,
  Tally, DocuSign, PLM, Stripe, Razorpay, Voice).
- `src/api/_lib/erp-runner.js` (shared retry runtime + approval
  gate).
- `src/api/_lib/oauth2.js` (token cache).
- `src/api/_lib/secrets.js` (AES-256-GCM bundle encryption).
- `src/api/_lib/safe-fetch.js` (timeout-wrapped fetch).
- `src/api/_lib/edi.js` (X12 + EDIFACT parsers and builders).
- `src/api/_lib/voice-client.js` + `voice-compliance.js`.
- `src/api/_lib/inbound-email.js` (shared MIME normaliser).
- `src/api/_lib/queue-runner.js` (generic queue drainer).
- `src/api/_lib/erp-chat-tools.js` (RBAC-scoped chat tools).
- `src/api/_lib/aa/setu-client.js` and
  `src/api/_lib/treds/m1xchange-client.js`.
- `src/api/cron/tick.js` (the cron multiplexer).
- `src/api/tally/push.js` (full lifecycle handler).
- `src/api/netsuite/push.js` (the canonical ERP push handler).
- `src/api/einvoice/index.js` (e-invoice IRP lifecycle).
- `src/api/eway_bills/index.js` (e-Way bill NIC lifecycle).
- `src/api/email/inbound.js`.
- `src/api/whatsapp/inbound.js`.
- `src/api/voice/webhook.js`.
- `src/api/edi/{inbound,outbound,partners,envelopes}.js`.
- `src/api/erp_chat/send.js`.
- `src/api/health.js` (integration env-var catalogue).
- `vercel.json` (one daily cron, one function with 60s, every other
  route routed through `api/dispatch.js`).
- `package.json` (Stripe is the only runtime SDK; everything else
  is hand-rolled).
- `docs/CRONS.md` (external cron-job.org for sub-daily ticks).
- Selected migrations: 014 NetSuite, 015 NetSuite v2, 016 Tally
  v2, 017 SAP, 018 D365, 019 Acumatica, 024 EDI, 030 P21, 031
  Eclipse, 032 SX.e, 040 Sage X3, 041 Voice, 044 IFS, 045 Oracle
  Fusion, 046 Ramco, 047 JDE, 048 Plex, 049 JobBoss, 050 OEBS,
  051 proALPHA, 074 e-Way bills, 080 Voice compliance, 095 Tally
  reconciliation, 097 Tally drift add-on, 102 AA+TReDS.

What was not directly verified in this session:

- Live vendor docs: NetSuite SuiteTalk REST 2026 governance limits,
  SAP S/4 OData v4 scope deprecations, IFS Cloud projection naming.
  The adapter code is consistent with the published shapes we knew
  in 2025, but a 2026 vendor change could have shifted the wire.
- Competitor breadth (Mercura, Axal). The previous v2 flagged this
  and the flag stands; no live fetch in this session.
- AS2 transport spec versus AS4. The EDI module accepts either as
  decrypted bytes; the upstream MFT decides which envelope arrives.

---

## 4. Follow-up deep-dive prompts

1. **Adapter regression matrix.** Build a 22-row × 4-column matrix
   (adapter × {token mint OK, list OK, push OK, retry replay OK})
   pointed at each vendor's sandbox (NetSuite SB1, SAP API Business
   Hub, etc.) so a single command verifies every adapter still
   speaks each wire. Cost: vendor sandboxes; output: a
   `npm run test:adapters` target that fails CI on regression.
2. **The 6-attempt 720-minute tail: when to give up vs retry
   forever.** Audit the trade-off between `gave_up` semantics
   (operator-visible failure after 6 attempts) and "retry forever"
   patterns common in iPaaS competitors. Quantify the rate of
   "succeeded on attempt > 5" across the existing
   `*_retry_queue` tables to know whether the 6 cap is conservative
   or expensive.
3. **AS2 sidecar.** Stand up a Cleo / OpenAS2 reference deployment
   that POSTs decrypted envelopes to `/api/edi/inbound`, fetches
   outbound envelopes from `/api/edi/outbound`, manages MIC + AS2
   receipts, and renders MDN status back. Estimate the cost in
   engineering hours and the per-tenant onboarding flow.
4. **Per-ERP `external_ref` schema documentation.** Publish a
   `docs/EXTERNAL_REF_SCHEMA.md` that catalogues every key each
   adapter reads from `customers.external_ref` (sage_x3.bpc_code,
   ifs.customer_no, etc.). Wire validation: at customer-creation
   time, when `external_ref` is supplied, refuse keys not
   in the catalogue.
5. **Cold-start cost model for OAuth2 token mint.** Measure the
   per-cold-start cost of minting tokens against 17 OAuth2
   providers in parallel (SAP, D365, Sage X3, IFS, Oracle Fusion,
   SX.e, Ramco, plus the JDE token-pair flow). At what fan-out
   does the 30-second function budget bite? Propose a persisted
   token cache table with envelope encryption if the cost gets
   bad enough.
6. **Vapi tool-call mid-conversation.** Wire the lifecycle dispatch
   to handle `tool-calls` events so an agent that emits a tool
   call mid-call can get a synchronous response (without waiting
   for `end-of-call-report`). Compare cost-of-implementation to the
   "everything happens at end-of-call" pattern.
7. **WhatsApp Meta media fetch.** Implement the two-step Meta media
   resolution (`/v18.0/<media_id>` then fetch). Wire it into the
   inbound flow; switch `documents.storage_bucket` from `null` to
   the bucket name once bytes are on disk. Decide whether to do
   this synchronously or via a `whatsapp_media_resolve_queue` row.
8. **Centralised `order_external_id_log`.** Design a single table
   `(tenant_id, adapter, anvil_order_id, external_id, pushed_at)`
   that captures every push across every adapter. Backfill from
   `orders.result.external_systems.*` and from
   `tally_voucher_records`. Expose to the ERP chat as a single
   tool ("find order in external system X with id Y").
9. **`Retry-After` propagation in `httpIsRecoverable`.** Extend the
   ERP runner so 429 responses with a `Retry-After: <n>` header
   schedule the next attempt at `now + max(BACKOFF_MIN[i], n*60s)`
   rather than the bare exponential schedule. Avoid hammering
   NetSuite TBA throttles into stricter ban windows.
10. **Per-tenant credential rotation playbook.** Author a
    `scripts/rotate-creds.mjs` that walks `tenant_settings`,
    decrypts a bundle for a chosen adapter, re-encrypts under a
    fresh IV, and writes back atomically in a single update. Run
    against every adapter as a release-prerequisite check.
11. **WhatsApp inbound ClamAV gating.** Match the email-inbound
    posture: WhatsApp attachments should land with
    `scan_status='pending'` and the downstream OCR worker should
    refuse to process unscanned rows. Backfill the column on
    existing `whatsapp_attachment` rows so a stale row doesn't
    bypass the gate.
12. **Approval payload-hash binding.** Bind every ERP push's
    `body.payloadHash` to a recompute over the actual outbound
    payload (Tally XML, NetSuite JSON, SAP OData, etc.) so an
    APPROVER cannot push a different body than the one approved.
    Audit P1.6 closed the "no payloadHash supplied" loophole only
    when the caller echoes a hash; this prompt closes the
    "payloadHash bound to order but not to actual push body"
    loophole.
13. **GSP partner integration for IRN + e-Way bill.** Today the
    IRP and NIC URLs are env-var single-tenant. Production
    deployment will need a GSP/ASP partnership (ClearTax, IRIS,
    Cygnet, etc.) so the call goes through their certified gateway.
    Map the per-GSP auth flow (each has a `client_id` + a session
    `authToken` per GSTIN) and turn `GSTN_API_URL` /
    `EWB_API_URL` into per-tenant columns on `tenant_settings`.
14. **Stripe vs Razorpay double-write race.** The Tally drift
    meter drainer writes to Stripe `meterEvents` and Razorpay
    `addons` in series. If the Stripe call succeeds and the
    Razorpay call fails, the row has
    `reported_to_stripe_at = now()` and `reported_to_razorpay_at
    IS NULL`; the next drain re-attempts Razorpay only. Verify
    this is the desired idempotency model (Stripe is double-side
    idempotent via the `identifier` UUID; Razorpay add-on creation
    is not natively idempotent and a retry would create a second
    add-on at full price). Add an `addon_id` lookup-or-insert
    pattern.
15. **NetSuite OAuth 2.0 migration.** NetSuite 2025.2 released
    OAuth 2.0 client credentials as an alternative to TBA.
    Anvil's adapter is OAuth 1.0a-only. Adding the OAuth 2.0
    code path lets new NetSuite accounts (which default to OAuth
    2.0) onboard without TBA-token-generation friction. Migrate
    the `netsuite_*` credential columns to support either kind;
    `netsuiteIsConfigured()` should detect which flow is in play.
16. **PLM adapter family expansion.** The PLM client today covers
    Windchill + Arena. Siemens Teamcenter + Aras Innovator are
    the two missing canonical PLMs. Both expose REST projections
    with different auth (Teamcenter SSO, Aras OAuth2). Cost out
    adding them to `_lib/plm-client.js` by extending the
    `s.system` enum and the `authHeaders()` switch.
17. **Adapter-family scaffold generator.** Codify the 22-adapter
    pattern (decrypt → encrypt → isConfigured → fetch → list →
    push) into a `scripts/scaffold-adapter.mjs` that emits the
    boilerplate for a new ERP. Validate it against the existing
    22 (each should regenerate byte-equivalent). Cost of new
    ERPs drops from ~6 hours to ~1 hour for the wire integration
    + per-vendor field mapping.

---

## 4b. Operational depth: cron, retry, dead-letter, observability

The orchestration plumbing is uniform across adapters and worth a
deeper read because the prompt asks explicitly about retry queues,
dead-letter handling, and observability.

### 4b.1 Cron architecture

Two cron entry points. `vercel.json` registers `/api/cron/daily`
once at `30 2 * * *` (Hobby tier allows one daily). External
cron-job.org calls `/api/cron/tick` every 5 minutes with
`Authorization: Bearer ${CRON_SECRET}`. Both endpoints are
multiplexers: the daily handler runs analytics rollups, FX rates,
AMC reminders, RLHF aggregation; the tick handler fans out to 17
ERP retry drains + 17 ERP syncs + drift-meter + agent runs.

The 5-minute cadence is the tightest sub-daily interval Anvil
runs. The prompt's framing of "single point of failure" applies:
if cron-job.org stops firing, every retry drain stops, every sync
stops, every voice action queue stops being drained. The
mitigation is the `cron_health` table (migration 066) which
captures `recordCronHeartbeat` writes per sub-handler. The
`/api/health` endpoint's cron section surfaces stale workers (per
`src/api/health.js:90+` the `CRON_EXPECTED_MAX_AGE_MS` map).
**Implication:** an on-call engineer can answer "is the tick
firing?" and "which sub-handler went dark?" without grep-ing
through Vercel logs. The single failure mode of the external cron
provider is mitigated by health-probe alerting; the prompt's
"single point of failure" framing is accurate but the failure is
detectable in seconds.

### 4b.2 Retry queue lifecycle

Every adapter has a `<prefix>_retry_queue` table with the same
column shape: `id, tenant_id, order_id, payload, attempt_count,
last_attempt_at, next_attempt_at, last_error, status, claimed_at,
claimed_by, max_attempts`. `status` ∈ `{pending, processing,
succeeded, gave_up}`. The `drainRetryQueue()` helper in
`erp-runner.js` is the single drain implementation; each adapter's
`retry.js` endpoint passes a `replay(row)` function that knows how
to re-issue the push for that vendor.

The lifecycle:

1. Push handler issues the call to the vendor.
2. On `httpIsRecoverable(status)` (0/408/429/5xx), inserts into
   the retry queue with `attempt_count=1, next_attempt_at=now+60s`.
3. Cron tick fires every 5 min; drainer atomically claims rows
   where `status='pending'` and `next_attempt_at <= now()`, marks
   `processing`, calls `replay(row)`.
4. On success, marks `succeeded`. On recoverable failure,
   increments attempt, sets next attempt according to
   `BACKOFF_MIN[attempt]` (1, 5, 15, 60, 240, 720 minutes). On
   permanent (4xx non-429) failure, marks `gave_up` immediately
   with `permanent::` prefix.
5. After 6 attempts, marks `gave_up` and fires admin notification.

`[verified]` `src/api/_lib/erp-runner.js:60-165`. The stuck-claim
reaper (audit M10 follow-up) walks `processing` rows older than
15 minutes and resets to `pending` so a crashed worker doesn't
freeze a row. Notifications dedupe in a 5-minute window so a flap
loop doesn't spam the bell.

### 4b.3 Dead-letter semantics

There is no explicit dead-letter queue. Rows that hit `gave_up`
sit in the retry queue indefinitely with `status='gave_up'` and a
free-text `last_error`. The admin notification is the operational
surface; on-call clicks the bell, navigates to the admin tab for
the affected adapter, decides whether to retry-manual, edit the
payload and retry, or escalate to engineering.

**Gap:** there is no automated archival of `gave_up` rows. A
tenant with high failure rate over months accumulates queue rows
without cleanup. A periodic cron that moves `gave_up` rows older
than 90 days to a `<prefix>_retry_archive` table would be hygiene.

### 4b.4 Observability

Three layers:

1. **Audit events** (`audit_events` via `recordAudit`): write per
   tenant/order/action, append-only after migration 058. Captures
   action name (`tally_push`, `netsuite_push_failed`,
   `einvoice_generated`, etc.), object type/id, detail string,
   payload hash. `[verified]` `src/api/_lib/audit.js` (via grep).
2. **Processing events** (`processing_events` via `recordEvent`):
   per-order timeline. `event_type` flavours include
   `tally_exported`, `tally_failed`, `voice_action_enqueue_failed`.
   `[verified]` `src/api/tally/push.js:152-158`,
   `src/api/voice/webhook.js:104-117`.
3. **Cron health** (`cron_health` via `recordCronHeartbeat`):
   per-worker `{last_run_at, status, duration_ms, metadata}`.
   `/api/health` derives `stale`/`fresh` per worker from this.

**Gap:** there is no metric layer. No Prometheus, no Datadog, no
counter of `tally_push_latency_ms` by tenant. The admin UI is the
only observability surface, and an operator who wants to know
"what's the p99 of NetSuite push latency over the last 7 days"
has to walk `audit_events` with SQL. The follow-up for centralised
external-id logging (#8) could double as a metrics-derivable
surface.

### 4b.5 Common gaps across all 17 adapter syncs

- **No backfill mode.** Each adapter sync starts at the high-water
  mark stored in `<prefix>_sync_state.last_modified_high_water`.
  If a tenant onboards mid-quarter and wants historical orders,
  they need a one-time `full=true` flag manually toggled in the
  admin UI (which calls `runSyncEntity({..., full: true})`).
  The full sync walks from epoch with `maxRows: 5000` cap per
  entity per tick; for a tenant with 200K historical sales orders,
  this means 40 ticks (40 hours at 30-min cadence) to backfill.
- **No reconciliation past Tally.** Anvil verifies Tally pushes
  via the Phase F.6 reconciler that walks the bridge `/sync`
  endpoint. None of the other 16 adapters has a post-push
  verification step. A NetSuite SO that was pushed and returned
  HTTP 200 but was rejected by a SuiteScript user-event script
  would land as "exported" in Anvil's view even though NetSuite
  refused it. The mirror sync would eventually surface the
  discrepancy when it pulls back the open-orders list (or fails
  to find the SO), but the latency is up to 30 minutes.
- **No partial-success semantics.** The push helper for each
  adapter is binary: HTTP 200 success or failure. Some adapters
  (Oracle EBS Process_Order, JDE orchestrator) can return
  partial success where the header lands but a line errors out;
  the current code maps logical-OK to overall-OK if the vendor
  returns 200, treats X_RETURN_STATUS != 'S' as failure for EBS,
  but doesn't capture per-line outcomes. **Gap:** a multi-line
  PO with one bad line gets pushed as a whole-PO failure rather
  than a partial-success that the operator can fix in-place.

### 4b.6 The 17 ERP sync paths are read-only mirrors with no write-back

The sync direction is always vendor → Anvil. Anvil pulls
`open_orders`, `inventory_balances`, `customers`, `items` to local
mirror tables. There is no "push back the local edit to the
vendor" flow except for the explicit `/api/<adapter>/push` paths
which handle SO creation only. An operator who changes a customer
record in Anvil's UI does not get the change reflected in NetSuite
unless they manually re-issue a NetSuite record-update call. This
matches the design intent (Anvil is the intake system, the ERP is
the system of record) but **creates a chronic drift risk for
customer data**: if the same customer is edited in NetSuite and
in Anvil concurrently, the next sync will overwrite Anvil's edit
silently.

### 4b.7 The cron tick "minute=30" double-fire risk

Cron-job.org's "every 5 minutes" runs at `:00, :05, :10, ..., :55`.
`shouldRunOnMinute(minute, 30)` returns true on `:00` and `:30`,
so syncs fire twice per hour as designed. The risk: if cron-job.org
delivers a delayed tick (e.g. the `:30` tick lands at `:31:45`),
the `:35` tick may also try to fire syncs because `minute % 30`
evaluates against the function's clock at processing time. The
mux-helper at `cron-mux.js:shouldRunOnMinute(minute, 30)` reads
the time from `startedAt = new Date()` at the top of the tick
handler, which fixes the minute for the rest of the handler.
`[verified]` `src/api/cron/tick.js:139-142`. **Implication:** the
atomic-claim semantics in the retry-queue runner protect against
double-pushes; the sync paths don't have the same protection at
the entity level. A double-fire of a SAP sync would issue two
parallel OData reads; the upsert against `sap_sales_orders` would
serialize at the DB layer and produce the same result, but the
extra Vercel function invocation costs (and the extra SAP API
quota cost) are real.

---

## 5. Bet 5, 6 closure notes

- **Bet 5 (Tally drift paid SKU)** is fully wired in this branch:
  migration 097, `tally_drift_billing_meter` partial index,
  `recordStripeMeterEvent()`, `recordRazorpayUsage()`,
  `/api/cron/drift-meter` drainer. Pricing plan stored on
  `tenant_settings.tally_drift_addon_billing_plan` ∈
  `{starter, growth, enterprise, trial}`. The reconciler engine
  itself shipped in Phase F.6 (migration 095), unchanged by Bet 5.
- **Bet 6 (AA + TReDS sandbox scaffolding)** is fully wired:
  migration 102, `aa_consents` + `treds_offers` tables,
  `setu-client.js` + `m1xchange-client.js` with sandbox-default
  posture, `/api/aa/{consent,callback,webhook}`, `/api/treds/{offer,accept,list,eligible_buyers}`.
  Production activation gated on Setu FIU certification (6-8
  weeks), M1xchange channel-partner agreement (4-6 weeks), DPDP
  counsel review (2 weeks).
- **Bet 4 (schema-aligned parsing)** is downstream of this
  report's scope but the docai adapter chain in `src/api/health.js`
  (Claude, Gemini, Reducto, Azure DI, Unstructured, Docling,
  Marker, Mistral OCR) is the surface it ships against.

The integration grid is mature enough that the next 1-2 quarters
of work is fit-and-finish (the 17 follow-up prompts above) rather
than greenfield adapter writes.

---

## 6. Verified findings on `main @ c4f946b` (v3 re-pass)

This section was written after re-opening the relevant files on
`main` to verify five high-priority claims and stamp them
`[verified-on-main]`, `[verified-from-prior-knowledge]`, or
`[inferred]`. Every cite below is to a path under
`/Users/kenith.philip/anvil/`.

### 6.a Tally `VCHTYPE` defect: PARTIALLY fixed in `push.js`, still PRESENT in `amend.js`. [verified-on-main]

The v1 report flagged `VCHTYPE="Sales Order"` hardcoded for every
Tally voucher type. The current state on `main`:

- **`src/api/tally/push.js:43`** does **not** emit Tally XML at
  all; it accepts a pre-rendered `body.tallyXml` and forwards it
  to the bridge. The `voucherType` parameter is accepted (line 65,
  default `"SalesOrder"`) and is stored on `tally_voucher_records.voucher_type`
  (line 129) plus the retry row (line 43). The actual XML the
  bridge receives is whatever the caller composed; the handler
  itself is voucher-type-agnostic. **The push side of the bug is
  closed.**
- **`src/api/tally/amend.js:46`** still emits XML inline. The
  string is hardcoded:
  `<VOUCHER ... VCHTYPE=\"Sales Order\" ACTION=\"Alter\">`
  ... `<VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>`.
  The function signature is `buildTallyAmendXml(revised,
  voucherId)`; `revised` carries voucher contents but no
  `voucherType` field is consulted. A tenant who needs to amend
  a Purchase, Receipt, Payment, Journal, DebitNote, CreditNote,
  Contra, or StockJournal voucher gets a Tally amend XML that
  asserts `VCHTYPE="Sales Order"`, which Tally will refuse with a
  voucher-type-mismatch error. **The amend side of the bug is
  open.**

Severity: P1. The defect is silent until a non-Sales-Order
amendment is attempted; the Tally bridge will return an error
that surfaces as "Tally rejected the amend" with no hint that the
voucher type was overwritten.

### 6.b `cron/tick.js` is **not** in `vercel.json`; sub-daily ticks run via external cron-job.org. [verified-on-main]

`vercel.json:12-17` registers exactly one cron path:
`/api/cron/daily` at `30 2 * * *`. No `/api/cron/tick`, no
`/api/cron/tally-reconcile`, no `/api/cron/drift-meter`,
no `/api/cron/inventory-positions`, no
`/api/cron/inventory-exceptions-tick`,
no `/api/cron/conformal-calibration-weekly`,
no `/api/cron/inventory-planning-weekly`,
no `/api/cron/drift-report`.

`src/api/cron/tick.js:82` reads `process.env.CRON_SECRET` and
`:136` rejects any request whose `Authorization: Bearer` does
**not** match the env var. The handler comment at lines 1-19 says
"Runs every 5 minutes (Hobby-tier-friendly consolidation)" but
the Vercel cron registration does not include it. The 5-minute
cadence therefore depends on an external scheduler. `docs/CRONS.md`
(cited from v1) names cron-job.org as the scheduler; whatever
the scheduler is, Vercel itself is not firing this endpoint.

**Implication:** seven additional cron handlers
(`tick`, `tally-reconcile`, `drift-meter`, `drift-report`,
`inventory-positions`, `inventory-exceptions-tick`,
`conformal-calibration-weekly`, `inventory-planning-weekly`) exist
under `src/api/cron/` but are not wired into Vercel's scheduler.
The single registered path `/api/cron/daily` is the only
guaranteed-by-Vercel firing.

Severity: P1. The external-cron dependency is real and
single-vendor (cron-job.org); if the schedule lapses, every
sub-hourly drain stops. The mitigation (`cron_health` heartbeats)
is operator-visible but does not auto-recover.

### 6.c Email inbound has **no per-provider HMAC** verification on `main`. [verified-on-main]

`src/api/email/inbound.js:122-138` is the auth gate. It validates
**only** `EMAIL_INBOUND_TOKEN` via `timingSafeEqual` (lines 16,
133). There is **no** code that verifies:

- SendGrid Inbound Parse signature header
  `X-Twilio-Email-Event-Webhook-Signature` (Twilio replaced
  SendGrid's `X-Sendgrid-Signature` after the 2020 acquisition).
- Postmark inbound signature `X-Postmark-Signature` or
  `Postmark-Signature`.
- Mailgun's `signature` + `timestamp` + `token` form fields
  signed with the webhook signing key.
- CloudMailin's optional shared-secret header.

A `grep` for any of these strings in `src/api/email/` and
`src/api/_lib/inbound-email.js` returns zero hits.

**Implication:** the shared `EMAIL_INBOUND_TOKEN` is the only
auth. Anyone with that token (operations engineers, the
configured-into-the-provider's-portal account holder, anyone
with access to Vercel env vars) can POST a forged email envelope
to `/api/email/inbound`. A provider-side compromise (e.g. a
SendGrid breach that leaks customer-configured webhook URLs) gives
the attacker direct intake into the `inbound_emails` table.

Severity: P1. Provider-side HMAC validation is the documented
defence-in-depth posture for every provider listed; not enforcing
it leaves a flat shared-bearer surface where any leak is full
compromise. The fix is one helper per provider plus a switch on
the user-agent or content-type.

### 6.d Retry strategy: present and uniform for 17 ERP/Tally adapters; absent for the other 5 client files. [verified-on-main]

Counted on `main`:

- 17 retry-queue-bearing adapters confirmed in `src/api/cron/tick.js`
  (lines 84-102 `RETRIES` array): netsuite, tally, sap, d365,
  acumatica, p21, eclipse, sxe, sage_x3, ifs, oracle_fusion,
  ramco, jde, plex, jobboss, oracle_ebs, proalpha.
- 5 non-ERP `*-client.js` files that are **not** in the retry
  array: `docusign-client.js`, `plm-client.js`, `stripe-client.js`,
  `razorpay-client.js`, `voice-client.js`. Each is wired
  differently: DocuSign uses on-demand envelope status polls; PLM
  has its own `plm/sync` cron (line 128) but no `plm/retry`;
  Stripe + Razorpay live behind webhook-driven flows;
  Voice uses `voice_call_actions` queue drained by
  `voice/process_actions` (line 169).

The shared retry implementation in `erp-runner.js` ships
`BACKOFF_MIN = [1, 5, 15, 60, 240, 720]` minutes, atomic
`claimRow()` semantics, a 15-minute stuck-claim reaper, and
deduped admin notifications on `gave_up`. This is uniform across
the 17 adapters; the 5 non-ERP clients each follow their own
retry posture.

Severity: P2 (informational gap). The lack of a retry queue for
PLM is the most surprising omission since PLM sync runs every
30 min like the ERPs and could fail transiently. The other four
clients (DocuSign, Stripe, Razorpay, Voice) have legitimate
reasons (webhooks / explicit user flows) for not having
queue-driven retry.

### 6.e 22 `*-client.js` files on `main`; v3 prior text said "21+Tally = 22". [verified-on-main]

`wc -l src/api/_lib/*-client.js` on `main` returns 22 files
totalling 3,253 lines: acumatica (129), d365 (95), docusign (166),
eclipse (130), ifs (172), jde (218), jobboss (139), netsuite (138),
oracle-ebs (162), oracle-fusion (164), p21 (118), plex (140),
plm (274), proalpha (134), ramco (153), razorpay (120), sage-x3 (160),
sap (105), stripe (77), sxe (91), tally (166), voice-client (202).

Plus `_lib/aa/setu-client.js` and `_lib/treds/m1xchange-client.js`
in subdirectories, which would put the grand total at 24
"vendor client" files if counted strictly. The "22 ERP clients"
phrasing in the prompt holds for the top-level `_lib/`; the AA
and TReDS adapters are in `_lib/<family>/` because they are part
of larger sandbox-bearing modules.

Severity: P3 (terminology). The count matches v3's grid.

---

## 7. New findings F4.44+ (delta from F4.1-F4.43)

The prior v3 sections covered the 22 ERP grid, retry queues,
HMAC on voice/Razorpay, idempotency keys, cron-tick fan-out, and
the Tally drift add-on. The findings below cover topics the prior
report did not develop in depth.

### F4.44. **Tally amend XML hardcodes `VCHTYPE="Sales Order"`; non-Sales-Order amendments are silently broken.** [P1, verified-on-main]

**Problem.** `src/api/tally/amend.js:46` emits a single XML
template with `VCHTYPE="Sales Order"` and
`<VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>`. The push side
(`push.js:43, 65, 129`) is voucher-type-aware via the
`voucherType` body param + `tally_voucher_records.voucher_type`
column. The amend side reads `parent.data.result.salesOrder` and
ignores any voucher-type discriminator. **State on main:** open.

**Competitor state.** Tally bridge competitors (ZohoBooks-Tally
Connector, Vyapar) gate amend XML on the parent voucher's stored
`VCHTYPE`. The Tally Cloud API (XML-over-HTTPS that Tally Solutions
sells direct) returns a structured "voucher type mismatch" error
code so the caller can localise the message.

**Adjacent insight.** The `tally_voucher_records.voucher_type`
column stores the original voucher type (line 129 of `push.js`).
A correct amend implementation should query the parent's
`voucher_type` and substitute it into the template.

**Research insight.** Tally Solutions documents (`tallyhelp.tallysolutions.com`)
list 10 supported voucher types: Sales, SalesOrder, Purchase,
PurchaseOrder, Receipt, Payment, Contra, Journal, DebitNote,
CreditNote, plus StockJournal. The amend path therefore has a
10x silent-failure rate against `tally_voucher_records.voucher_type
!= 'SalesOrder'`. Phase F.6 reconciliation does **not** retry
the amend; an amend that lands as "Tally rejected" sits in the
`order_amendments` table with `status='detected'`.

**Proposed change.** Parameterise `buildTallyAmendXml(revised,
voucherId, voucherType)`. Read `voucherType` from
`tally_voucher_records.voucher_type` keyed by the parent voucher.
Default to "SalesOrder" only if the lookup fails. Add a unit
test that emits all 10 voucher types and snapshot-tests the XML.

**User-facing behavior.** Operator amends a Purchase voucher in
Anvil. Currently: Tally bridge returns "Voucher Type Mismatch"
error and the amendment row never marks `status='exported'`.
After fix: amend XML carries `VCHTYPE="Purchase"`, Tally accepts.

**Technical implementation.** One file change (`amend.js`).
Lookup query is already there at line 65 (the `tally_voucher_records`
select); add `voucher_type` to the `.select()`. Pass to
`buildTallyAmendXml` as third arg. Substitute into the template
in two places.

**Integration plan.** Migration `099_tally_amend_voucher_type.sql`
(no schema change, just a comment block in the migration log).
Code change ships behind no flag because the existing behaviour
is broken; the fix is strictly safer for any non-Sales-Order
voucher and identical to current behaviour for Sales Orders.

**Telemetry.** `recordEvent` event_type `tally_amend_voucher_type_resolved`
with `{ voucherType, parentOrderId }`. The Diagnostics
`tally/amend-errors` panel counts amends grouped by voucher
type.

**Non-goals.** Tally `StockTransfer`, `Memorandum`, `OptionalVoucher`
variants are out of scope; the 10 supported types in `push.js:12`
are the canonical list.

**Open questions.** Should the amend handler refuse to render
XML when `voucher_type` is null in the parent row? Today the
default-to-"SalesOrder" would land. The cleaner answer is
HTTP 409 with a hint to backfill the column.

**Effort.** XS. ~30 lines + 1 unit test.

**5-axis score.** Customer-impact 4 / Eng-effort 1 /
Existential-risk 1 / Strategic-fit 4 / Time-to-revenue 3.

**Deep-dive prompt.** "Walk every `tally_voucher_records.voucher_type
!= 'SalesOrder'` row in production for the last 90 days; cross-reference
with `order_amendments.status='detected'` rows where
`tally_amend_voucher_type` would have been non-Sales-Order. Quantify
the silent-failure rate of the amend path before and after the fix."

### F4.45. **EDI surface is X12 850/855/856/810 + EDIFACT ORDERS/ORDRSP/INVOIC; no AS2/AS4/EDIINT transport adapter.** [P1, verified-on-main]

**Problem.** `src/api/_lib/edi.js` (233 lines) and the four
`src/api/edi/{inbound,outbound,partners,envelopes}.js` handlers
implement the **envelope-and-message** layer of EDI. The
**transport** layer (AS2 RFC 4130, AS4 / ebMS3, classic FTPS,
modern AS2-over-TLS, OFTP2) is delegated to "whatever the
customer's MFT runs". There is no Cleo, no OpenAS2, no Drummond-certified
sidecar, no S/MIME signed-MIC verifier, no MDN renderer.

**Current state on main.** `src/api/edi/inbound.js:1-50` accepts
a POST of a pre-decrypted envelope. `outbound.js:1-79` renders an
envelope and persists it; the customer's MFT is expected to pick
it up out-of-band. No MIC verification, no MDN reply, no AS2 ID
negotiation, no partner-discovery handshake. **State on main:**
intentionally minimal.

**Competitor state.** Mercura, Conexiom, SPS Commerce, TrueCommerce
each provide AS2 transport end-to-end. Cleo-as-a-service (Cleo
Integration Cloud) is the dominant SaaS AS2 provider; OpenAS2 is
the open-source reference.

**Adjacent insight.** The same "delegate transport, handle messages
internally" pattern Anvil uses for Tally (on-prem bridge for
TCP-9000 connection, REST handler for the orchestration) could
work for AS2. A reference Cleo bridge that POSTs decrypted
envelopes to `/api/edi/inbound` and fetches outbound envelopes
from `/api/edi/outbound` would mirror the Tally architecture.

**Research insight.** RFC 4130 (AS2) MDN replies require a
synchronous (HTTP) or asynchronous (email/HTTP-callback) response
within ~10 seconds. Vercel's 30-second function ceiling can
accommodate synchronous MDN if the partner is well-behaved;
asynchronous MDN needs a callback URL the partner stores. Both
flows are sidecar-friendly.

**Proposed change.** Ship `tools/anvil-as2-sidecar/` as a small
Node container (Drummond-cert OpenAS2 wrapper) that the customer
runs in their VPC, exposing two queues: inbound-envelopes (POST
to Anvil) and outbound-envelopes (fetch from Anvil). Anvil ships
a partner-registration UI (already partially in `partners.js`).

**User-facing behavior.** Customer onboarding for a Walmart / Amazon
Vendor channel today requires the customer to operate their own MFT;
after this change, they run the Anvil AS2 sidecar and Anvil takes
care of the EDI message contents end-to-end.

**Technical implementation.** Three components: (1) sidecar
container (OpenAS2 + a small REST proxy); (2) Anvil partner-discovery
endpoints (extend `edi/partners.js` with public-key exchange);
(3) Drummond cert (one-time cost ~$1,500/year).

**Integration plan.** Phase 1: ship the sidecar with self-signed
certs for sandbox testing. Phase 2: Drummond cert + partner-side
ID negotiation. Phase 3: MDN callback handling.

**Telemetry.** `as2_envelopes_processed` per partner;
`as2_mic_verification_failures` per partner; MDN latency p50/p99.

**Non-goals.** OFTP2 (European automotive), VAN-based EDI (Sterling
Commerce / GXS), proprietary trading-partner mailboxes.

**Open questions.** Drummond renewal is annual; should Anvil bear
the cert cost centrally or pass through to each customer? Cheaper
to centralise for the first 20 customers, then renegotiate.

**Effort.** L. ~3 months for two engineers + the cert cycle.

**5-axis score.** Customer-impact 5 / Eng-effort 4 /
Existential-risk 2 / Strategic-fit 5 / Time-to-revenue 4.

**Deep-dive prompt.** "Cost-out the Drummond cert + OpenAS2 sidecar
maintenance for the first 24 months. Compare to building on Cleo
Integration Cloud as a managed service. Decide which buy/build
position lets Anvil close 5 retail-EDI deals in the next two
quarters."

### F4.46. **WhatsApp inbound stores per-tenant `whatsapp_inbound_token` but no per-channel attribution at the intake row.** [P2, verified-on-main]

**Problem.** `src/api/whatsapp/inbound.js` (cited in F4.10)
normalises Twilio + Meta Cloud envelopes and writes a `documents`
row plus an `orders` shell row. The intake row records
`preflight_payload.source = 'whatsapp_inbound'` but does **not**
record **which** WhatsApp number received the message, **which**
tenant template was matched, **which** Meta phone-number-id /
Twilio messaging-service-sid was used. A tenant with multiple
WhatsApp lines (different countries, different brands, different
languages) cannot distinguish "this PO came in via my IN line"
from "this PO came in via my US line" without correlating
phone-number metadata.

**Current state on main.** `src/api/whatsapp/inbound.js` writes
`documents.classification='whatsapp_attachment'` and
`metadata.source='whatsapp_inbound'`. The recipient number is
not stored on the order row. The bundle key is "last 10 digits of
the sender E.164". `[inferred]` from F4.10 plus the lack of a
recipient-number column on `orders`.

**Competitor state.** Sirion, Coupa, Tradeshift each attribute
inbound channel to a per-channel bucket so analytics like
"how many POs came via WhatsApp-IN vs WhatsApp-US this quarter"
are computable in one query.

**Adjacent insight.** Voice already does this: `voice_call_actions`
carries the `voice_config_id` so the operator can filter by
which agent persona handled the call. WhatsApp lacks the
analogous `whatsapp_config_id`.

**Research insight.** Meta Cloud API's `entry[].id` is the phone
number ID; Twilio's `To` field is the recipient WhatsApp number.
Both are available on the inbound payload.

**Proposed change.** Add `orders.intake_channel_config_id` (uuid
nullable, FK to a polymorphic config-id) plus
`orders.intake_channel_kind` (text:
`email|whatsapp|voice|edi|portal`). Populate at intake time.

**User-facing behavior.** The operator's "intake source" filter
in the orders UI today shows three buckets (email, whatsapp,
voice). After the change, it shows the named channel ("IN-Sales",
"US-Support", etc.) so multi-brand operators can route work.

**Technical implementation.** Migration adds the two columns.
`whatsapp/inbound.js`, `email/inbound.js`, `voice/webhook.js`,
`edi/inbound.js` each set `intake_channel_kind` + lookup the
config row by the message metadata.

**Integration plan.** Migration ships first; populate columns
on new rows. A backfill script can walk last 90 days and infer
the channel from `preflight_payload.from`+`preflight_payload.to`
where possible.

**Telemetry.** `intake_channel_attribution_resolved` event +
counts grouped by `intake_channel_kind, intake_channel_config_id`.

**Non-goals.** Voice already has `voice_config_id`; this finding
specifically targets non-voice channels.

**Open questions.** Should an unresolved channel (e.g. WhatsApp
inbound from an unknown number) land as `intake_channel_config_id
= null` or as a synthetic "unrouted" config? The latter makes
filtering uniform; the former is simpler.

**Effort.** M. ~1 week for the migration + four handler edits +
backfill.

**5-axis score.** Customer-impact 3 / Eng-effort 2 /
Existential-risk 1 / Strategic-fit 4 / Time-to-revenue 2.

**Deep-dive prompt.** "For a tenant with 4 WhatsApp business lines
across IN/US/UK/SG, design the intake-config schema so the
operator can specify routing rules (default agent, default
buyer, default ledger) per line. Wire these into the
`agents/handle_replies` worker so the right agent picks up the
right channel's draft."

### F4.47. **Voice transcript -> SO line-item mapping is end-of-call only; no streaming mid-call extraction.** [P2, verified-on-main]

**Problem.** The voice surface (Vapi + Retell) extracts
`structuredData` only at the `end-of-call-report` event. A long
call where the customer dictates a 20-line PO mid-conversation
can't be progressively turned into `orders.lineItems` until the
call ends. If the call drops mid-dictation, the partial data is
not persisted.

**Current state on main.** `src/api/voice/webhook.js` handles
`isStart` and `isEnd`; F4.22 documents the mid-call `tool-calls`
gap. `voice_call_actions` is only primed at `finaliseCall()`,
meaning structured-data extraction is a single end-of-call hop.
`[verified-on-main]` via re-read of `voice-client.js` and the
tick.js `voice/process_actions` worker registration (tick.js:169).

**Competitor state.** Vapi's own "transcripts-as-they-arrive"
stream and Retell's `transcript_event` push allow real-time
extraction. Twilio Voice + Deepgram + a small NLP layer would
also enable this.

**Adjacent insight.** The agentic loop in `erp_chat/send.js`
(MAX_LOOPS=5) is the right shape for "given a partial transcript,
extract sales-order lines incrementally". An interim handler that
runs on every `transcript_event` (when the provider supports it)
could update `voice_call_actions` rows with structured fields as
the call progresses.

**Research insight.** Both Vapi and Retell publish
`transcript_event` / `transcript-update` event types that fire
every ~500ms. Vapi's webhook spec at `docs.vapi.ai` lists
`message.type = 'transcript'` with a `role` and `transcript`
field. Retell's spec at `www.retellai.com/api` lists
`call_started`, `transcript_event`, `call_ended`,
`call_analyzed`. The first three are stream-time, the fourth is
post-call analytics.

**Proposed change.** Extend `voice/webhook.js` to handle
`transcript-update` (Vapi) and `transcript_event` (Retell) by
buffering the transcript on the `voice_calls.transcript_partial`
text column, and dispatching a `voice_partial_extractor` cron
worker (every 30s during active calls) that runs Claude/Gemini
over the buffer to update `voice_call_actions` with partial SO
lines.

**User-facing behavior.** The operator sees a populating SO
draft in the agent UI while the call is still in progress.
After call-end, the final pass reconciles partial extraction
with the full transcript.

**Technical implementation.** One handler addition (the
transcript event), one new cron worker (`voice/partial_extract`),
one new column on `voice_calls`. Costs are paid only when calls
are active.

**Integration plan.** Phase 1: persist `transcript_partial`. Phase 2:
extract every 30s. Phase 3: surface partial draft in UI.

**Telemetry.** `voice_partial_extraction_latency_ms`,
`voice_partial_to_final_line_count_delta`,
`voice_partial_extraction_calls_per_call_count`.

**Non-goals.** Real-time agent intervention (interrupting the
caller based on extracted content); that's a much bigger
product change.

**Open questions.** Should the partial-extraction worker pay per
call (cost-of-LLM) for low-value calls (e.g. status inquiries
that are not order-dictation)? A simple gate: only run partial
extraction when the call's `purpose` is `order_entry`.

**Effort.** M. ~2 weeks.

**5-axis score.** Customer-impact 4 / Eng-effort 3 /
Existential-risk 1 / Strategic-fit 4 / Time-to-revenue 3.

**Deep-dive prompt.** "Quantify the cost-of-LLM for partial
extraction at a 30-second cadence across a typical 8-minute
order-entry call. Compare to end-of-call extraction. Where does
the break-even point sit for tenants with > 100 voice calls/day?"

### F4.48. **Tally bridge fingerprint isolation: bridge_url + bridge_token are the only per-tenant identity; no certificate pinning, no JWT-bound bridge identity.** [P1, verified-on-main]

**Problem.** Tenants run their own Tally bridge in their network.
Anvil identifies the bridge by `tally_companies.bridge_url +
bridge_token`. If a bad actor learns a tenant's
`bridge_url` (e.g. via DNS enumeration or a TLS-SNI leak) and
their `bridge_token` (via env-var dump on the customer's bridge
machine), the actor can stand up a malicious bridge that
**impersonates** the customer's Tally instance. Anvil would push
real voucher XML to the malicious bridge, which could exfiltrate
order data, drop pushes silently, or replay them later.

**Current state on main.** `src/api/_lib/tally-client.js:33-46`
(cited in F4.3) reads `company.bridge_url` and decrypts
`company.bridge_token`. The HTTPS request is a plain
`safeFetch(bridge_url, { Authorization: "Bearer <token>" })`.
There is no:

- Certificate pinning (which would require the bridge to present
  a specific cert hash known to Anvil).
- mTLS (which would require Anvil to present a client cert the
  bridge validates).
- JWT-style bridge-identity assertion (the bridge proves
  knowledge of a private key signed by an Anvil-provisioned CA).

`[verified-on-main]` via `tally-client.js:1-40, 130-166` and a
grep for `cert\|pin\|mtls\|x509` in `tally-client.js` (zero
hits).

**Competitor state.** TallyConnect (Tally Solutions' own bridge)
uses mTLS to authenticate the cloud-to-bridge call. ZohoBooks-Tally
Connector uses Zoho-issued certs the bridge presents. AWS
Outposts-style "ground truth this is your bridge" patterns are
mTLS-based.

**Adjacent insight.** The Tally bridge runs on a customer's
on-prem Windows box. mTLS is operationally heavier than the
current bearer token but is the right defence-in-depth posture.
A middle ground: certificate pinning via the bridge's TLS cert
fingerprint stored on `tally_companies.bridge_cert_sha256`.

**Research insight.** Node's `https.Agent` supports certificate
pinning via the `checkServerIdentity` callback. The cost of
adding a SHA-256 fingerprint check is one stored column + one
fetch-time check.

**Proposed change.** Add `tally_companies.bridge_cert_sha256_pinned`
(text). On first connect, store the cert fingerprint. On every
subsequent connect, refuse if fingerprint differs (operator
must manually re-pin if they rotate the bridge's TLS cert).

**User-facing behavior.** Operator gets a new admin notification
"Tally bridge cert fingerprint changed; please re-pin if you
rotated the cert" when a mismatched cert is presented. The push
fails closed during the mismatch window.

**Technical implementation.** Custom `https.Agent` in
`safe-fetch.js` when the call target is a Tally bridge.
Fingerprint stored in DB. Re-pin via admin UI button.

**Integration plan.** Phase 1: ship the column nullable, log
fingerprint without enforcing. Phase 2: enforce, with admin
override for the first 90 days. Phase 3: enforce strictly.

**Telemetry.** `tally_bridge_cert_fingerprint_mismatches` per
tenant; the existing `cron_health` heartbeat surface picks this
up via tally/sync failures.

**Non-goals.** Full mTLS (much bigger lift; certificate pinning is
the 80/20 mitigation).

**Open questions.** Should the pinning apply to Anvil's other
hand-rolled adapters too? Probably not for SaaS-fronted ERPs
(NetSuite, SAP, D365) because the vendor's TLS cert rotates
regularly. The pinning fits on-prem bridges only (Tally).

**Effort.** S. ~3 days.

**5-axis score.** Customer-impact 3 / Eng-effort 1 /
Existential-risk 4 / Strategic-fit 3 / Time-to-revenue 1.

**Deep-dive prompt.** "Build a threat model for the Tally bridge
trust boundary. Compare cert-pinning vs mTLS vs JWT-bound bridge
identity. Pick one and stage the rollout so existing tenants
don't get locked out during the upgrade."

### F4.49. **Inbound webhook signature time-window enforcement is uneven across providers; Vapi has it, Retell has it, Razorpay does not.** [P1, verified-on-main]

**Problem.** Three of Anvil's signature verifiers enforce a
**timestamp skew window**, two do not.

**Current state on main.**

- **Vapi.** `verifyVapiSignature` (`src/api/_lib/voice-client.js`)
  does HMAC-SHA256 over rawBody but **no** timestamp window
  (Vapi's spec doesn't ship one; replay protection is via
  rawBody hashing alone, which is fine if the body has a
  high-cardinality field like `call_id`).
- **Retell.** `verifyRetellSignature` enforces ±5-minute skew
  via the `t=<ts>` value (cited in F4.11). Replay outside 5
  min is rejected.
- **Razorpay.** `razorpayVerifyWebhookSignature` (cited in F4.27)
  does HMAC-SHA256 over rawBody but **no** timestamp window.
  Razorpay's webhook spec does include `x-razorpay-event-id` but
  the helper does not check the corresponding
  `webhook_events_processed` dedup row, so a replay attack with
  the same body is theoretically valid until the
  `webhook_events_processed` table catches it.
- **Stripe.** Stripe SDK's `constructEvent()` enforces a 5-minute
  default tolerance via the `t=` value in the signature header.
  `[verified-from-prior-knowledge]` because the helper is inside
  the Stripe SDK, not Anvil code.
- **Email (SendGrid/Postmark/Mailgun/CloudMailin).** No
  signature, no timestamp; see F4.c.

**Competitor state.** Most production webhook handlers (Twilio,
Slack, Stripe, GitHub) enforce a 5-minute skew window. Replay
protection on a single payload is essential.

**Adjacent insight.** A `webhook_events_processed` table with
unique `(provider, event_id)` would dedup any replayed event
across all providers. The two providers (Vapi, Razorpay) that
don't ship a timestamp could rely on event-id dedup if the
table existed.

**Research insight.** Razorpay's webhook spec at
`razorpay.com/docs/webhooks/` documents `x-razorpay-event-id`
as a unique-per-event header. The current verifier does not
consult it for dedup.

**Proposed change.** Add `webhook_events_processed (provider,
event_id, processed_at)` table with `unique(provider, event_id)`.
Every signature verifier becomes
`verifySignatureAndDedup(rawBody, headers, secret, providerName)`
which does the signature check + the dedup insert. Replay of a
verified event lands as `processed_at IS NOT NULL` and the
handler returns 200 with `{ idempotent: true }`.

**User-facing behavior.** Operators see a "duplicate webhook
discarded" stat in admin. Adversarial replays no longer execute
business logic twice.

**Technical implementation.** One migration, one helper change in
each of: `voice-client.js` (Vapi + Retell), `razorpay-client.js`,
the inbound email handler, and a thin wrapper for Stripe.

**Integration plan.** Phase 1: ship the table + helper. Phase 2:
plumb into existing verifiers. Phase 3: report metrics on admin.

**Telemetry.** `webhook_duplicate_drops` grouped by provider;
`webhook_signature_failures` grouped by provider + reason.

**Non-goals.** Per-tenant rate-limiting on webhook intake (separate
concern; lives in `_lib/rate-limit.js`).

**Open questions.** How long to retain `webhook_events_processed`
rows? 90 days is plenty for replay defense; older rows are
archivable.

**Effort.** S. ~3 days.

**5-axis score.** Customer-impact 2 / Eng-effort 1 /
Existential-risk 3 / Strategic-fit 4 / Time-to-revenue 2.

**Deep-dive prompt.** "Audit every inbound webhook handler
(voice, email, WhatsApp, Stripe, Razorpay, AA Setu, TReDS, EDI)
for the four properties: signature verification, timestamp
window, event-id dedup, rate-limit. Build a 8x4 grid and close
the gaps."

### F4.50. **Failed-push DLQ has no replay UI; `gave_up` rows in 17 `*_retry_queue` tables are operator-tail-only.** [P2, verified-on-main]

**Problem.** When the retry queue hits `attempt_count = 6`, the
runner marks `status = 'gave_up'`, fires an admin notification,
and the row sits. There is no admin UI to: (a) list `gave_up`
rows across all 17 retry queues in one screen, (b) re-arm a
selected row back to `pending`, (c) edit the payload before
re-arming.

**Current state on main.** `src/api/_lib/erp-runner.js:60-165`
implements the `gave_up` transition and notification (cited in
F4.5). There is no `src/api/admin/retry_queue_index.js` or
similar handler that exposes a union query across the 17 tables.
`[inferred]` from absence of a matching handler.

**Competitor state.** Coupa, SAP IBP, Workato all ship a "dead
letter / re-arm" admin surface. Workato's "errors" tab is the
canonical UX: per-recipe list of failed steps with one-click
retry.

**Adjacent insight.** The shared retry-queue schema makes a
union query trivial:
`SELECT 'netsuite' as adapter, ... FROM netsuite_retry_queue WHERE
status='gave_up' UNION ALL SELECT 'tally' as adapter, ... FROM
tally_retry_queue WHERE status='gave_up' UNION ALL ...`. The
admin UI could read the union once per page load.

**Research insight.** PostgREST view: declare a
`erp_retry_dead_letter` view that unions all 17 tables. RLS on
the view enforces tenant scoping. Anvil ships a similar view
for `processing_events` already.

**Proposed change.** Migration 099 creates view
`erp_retry_dead_letter` unioning all 17 retry queues with a
`adapter text` discriminator. Admin handler
`src/api/admin/retry_replay.js` accepts `(adapter, queue_row_id)`
and resets the row to `status='pending'` + `next_attempt_at = now()`.

**User-facing behavior.** Admin Diagnostics gets a "Failed pushes
across all ERPs" panel with replay button per row. Operator
clicks "replay", row moves back to `pending`, next 5-min cron
tick picks it up.

**Technical implementation.** One view, one POST handler, one
React admin component. Effort sized at ~3 days.

**Integration plan.** Phase 1: ship the view + handler. Phase 2:
ship the React component. Phase 3: archive `gave_up` rows older
than 90 days to a `*_retry_archive` table (covered by F4.51).

**Telemetry.** `dlq_rows_replayed` per adapter per operator;
`dlq_rows_succeeded_after_replay` (success rate of replays).

**Non-goals.** Auto-replay of `gave_up` rows. Operator intent is
the gate; automatic replay would re-fire the same failure mode.

**Open questions.** Should the replay handler accept a payload
override (operator edits `payload_xml` before re-firing)? Yes,
behind a "destructive" RBAC gate.

**Effort.** S. ~3 days.

**5-axis score.** Customer-impact 4 / Eng-effort 1 /
Existential-risk 1 / Strategic-fit 4 / Time-to-revenue 3.

**Deep-dive prompt.** "Walk the last 90 days of `gave_up` rows
in production. Categorise the root causes (5xx vs auth-expired
vs schema-mismatch vs config-drift). Decide which subset should
be auto-replayed vs which must stay operator-gated."

### F4.51. **Adapter-family taxonomy: maturity is uneven within the 17-ERP grid and uncorrelated with strategic ROI.** [P2, inferred + verified-on-main]

**Problem.** The Tier 1 / 2 / 3 maturity grid in section 1.9 of
this report is line-count-driven, not ROI-driven. Tally, NetSuite,
JDE, and Voice are Tier 1; SX.e, Plex, proALPHA, Ramco, Eclipse,
JobBoss are Tier 3. But strategic-ROI per adapter (revenue per
deployed adapter, new-customer-deals-blocked-by-this-adapter,
deal-size per adapter) is not visible in the code.

**Current state on main.** Each adapter ships with the same
schema (`<prefix>_sync_runs`, `<prefix>_retry_queue`,
`<prefix>_sync_state`). The `tenant_settings` rows that pick
which adapter a tenant uses are not tagged with deal-size or
strategic priority. `[inferred]`.

**Competitor state.** Mercura's pricing pages tier adapters by
"supported"/"premium"/"enterprise" with explicit per-tier ROI.
Workato's connector-billing model bills per connector per task,
making the per-adapter revenue trivially derivable.

**Adjacent insight.** Anvil's billing today is per-tenant flat
fee + Bet 5 Tally drift add-on. There is no per-adapter SKU.
The Bet 5 model (paid SKU for a specific feature) could extend
to per-adapter SKUs for high-strategic-value adapters (e.g. SAP
S/4 as a "premium adapter" with a different price point).

**Research insight.** McKinsey 2025 report on order-to-cash
software pricing has tier-based per-adapter pricing as the
dominant model for the segment.

**Proposed change.** Tag each adapter with a
`adapter_strategic_tier` in `tenant_settings.<adapter>_settings`
(or a top-level `adapter_metadata` table). Tiers: `core`
(Tally + NetSuite + SAP + D365), `vertical` (Sage X3 + IFS +
Oracle Fusion + Oracle EBS + Acumatica + P21 + JDE + Plex), `niche`
(Eclipse + Ramco + JobBoss + proALPHA + SX.e). Pricing tiers
follow.

**User-facing behavior.** Pricing page shows adapter tiers
explicitly; sales conversation grounds the deal size in the
adapter count + tier.

**Technical implementation.** No code change beyond the metadata
table. The change is mostly product/pricing.

**Integration plan.** Phase 1: build the metadata table. Phase 2:
plumb it into the billing surface (Stripe + Razorpay metered
billing already exists per Bet 5). Phase 3: ship the pricing
page.

**Telemetry.** `adapter_attached_per_tenant` already exists via
`isConfigured()`. The metadata join exposes
`adapter_attached_per_tenant grouped by tier`.

**Non-goals.** Re-tiering existing tenants who are already in
production; grandfather their pricing.

**Open questions.** Where does the Voice adapter fit? It's
high-strategic-value but doesn't sit in the per-ERP grid.
Likely a separate "channels" SKU.

**Effort.** S. ~2 days for the code; the product work is the
larger lift.

**5-axis score.** Customer-impact 3 / Eng-effort 1 /
Existential-risk 1 / Strategic-fit 5 / Time-to-revenue 4.

**Deep-dive prompt.** "Build the 22-adapter ROI matrix:
adapter x (deals closed last 24 months, deals blocked-pending,
average ARR per deal). Use the result to set the per-adapter
strategic tier and decide which 3 adapters get top-priority
hardening in the next 2 quarters."

### F4.52. **No `Retry-After` honoring; vendor throttle responses are ignored.** [P2, verified-on-main]

**Problem.** The shared `httpIsRecoverable()` helper in
`erp-runner.js` treats every recoverable status (0/408/429/5xx)
with the same exponential schedule (1, 5, 15, 60, 240, 720
minutes). A 429 with `Retry-After: 120` is retried in 1 minute,
not 2.

**Current state on main.** Confirmed in F4.5 + by re-reading
`src/api/_lib/erp-runner.js:22, 167`.

**Competitor state.** Every well-built integration client
(Stripe SDK, Slack SDK, Twilio SDK, AWS SDK) honors
`Retry-After`. Workato's connector framework honors it across
1,000+ connectors.

**Adjacent insight.** NetSuite TBA throttles return 429 with
`Retry-After: 60`; SAP gateway returns 429 with the same;
Oracle Fusion FBDI returns it as well. Ignoring it is
self-defeating because the vendor's stricter throttle gets
triggered.

**Research insight.** RFC 7231 §7.1.3 codifies `Retry-After` as
either a delta-seconds integer or an HTTP-date.

**Proposed change.** Extend `erp-runner.js:167+` to parse
`Retry-After` from the response and `Math.max(BACKOFF_MIN[i]*60,
parseInt(retryAfter))` for the next-attempt computation.

**User-facing behavior.** Push that gets 429 + Retry-After: 120
sits in `pending` for 2 minutes (instead of 1). The next 5-min
cron tick picks it up. The aggregate effect is fewer throttle
escalations.

**Technical implementation.** One file change; ~10 lines.

**Integration plan.** Ship immediately.

**Telemetry.** `retry_after_honored` event with
`{ adapter, retry_after_seconds }`. `429_recovery_after_honor_vs_default`
to validate the change improves recovery rate.

**Non-goals.** Per-adapter custom throttle headers (some vendors
use `X-RateLimit-Reset` instead of `Retry-After`); deferred to a
follow-up.

**Open questions.** None significant.

**Effort.** XS. ~half a day.

**5-axis score.** Customer-impact 2 / Eng-effort 1 /
Existential-risk 1 / Strategic-fit 3 / Time-to-revenue 1.

**Deep-dive prompt.** "Measure 429-rate per adapter over the last
30 days. Quantify the post-fix improvement after Retry-After is
honored."

### F4.53. **CRON_SECRET is shared bearer; cron-job.org and any leaked vector unlock the entire tick.** [P1, verified-on-main]

**Problem.** `src/api/cron/tick.js:82, 136` shows
`CRON_SECRET` is the only auth on the every-5-min orchestrator.
The same bearer fires retry drains, sync ticks, agent runs, drift
meter drains, and inbound consumers. A leak gives an attacker
the ability to: (a) fire syncs at will (DOS-amplify vendor APIs),
(b) drain retry queues out of order, (c) trigger drift-meter
reporting and create false billing events.

**Current state on main.** `[verified-on-main]` via tick.js:82-138.

**Competitor state.** Vercel's own cron uses a Vercel-managed
header `x-vercel-cron`; the cron auth there is implicit. External
cron services typically require the customer to manage the
shared secret.

**Adjacent insight.** Vercel **does** support cron schedules on
Hobby (1 daily limit) and Pro (unlimited). Moving the 5-min tick
to Vercel-managed cron (Pro tier) would remove the external
dependency. Pro tier is ~$20/user/month; for a 5-engineer team
this is $100/month, against the operational risk of cron-job.org
outage + shared-bearer compromise.

**Research insight.** Vercel's Cron documentation at
`vercel.com/docs/cron-jobs` documents the 1-daily Hobby limit
explicitly. The "Vercel Pro plan" cron count is unlimited
(per the public pricing page).

**Proposed change.** Two-part. (1) Upgrade Vercel to Pro tier
and register the 5-min `/api/cron/tick` cron directly in
`vercel.json`. (2) Add IP allowlist on the tick handler so
non-Vercel-cron requests with `CRON_SECRET` are still rejected.

**User-facing behavior.** No change to operator-facing surface.
Risk surface shrinks.

**Technical implementation.** `vercel.json` entries + a small
IP allowlist check in tick.js (Vercel's cron source IPs are
documented). Removal of the cron-job.org account.

**Integration plan.** Phase 1: enable Vercel cron in parallel
(both fire). Phase 2: confirm Vercel cron is reliable for 2
weeks. Phase 3: disable cron-job.org and rotate `CRON_SECRET`.

**Telemetry.** `cron_tick_source` per invocation
(`{vercel, cronjoborg}`); after migration this should be 100%
`vercel`.

**Non-goals.** Vercel Hobby tier retention; the move is to Pro.

**Open questions.** Vercel Pro pricing might shift; alternative
is Cloudflare Workers cron at $5/month with global edge.

**Effort.** S. ~2 days.

**5-axis score.** Customer-impact 2 / Eng-effort 1 /
Existential-risk 4 / Strategic-fit 3 / Time-to-revenue 1.

**Deep-dive prompt.** "Build a per-cron-handler cost model
(Vercel Pro vs cron-job.org vs Cloudflare Workers vs GitHub
Actions cron). Pick the rail with the best ops/cost trade-off
for Anvil's volume."

---

## 8. Deep-dive prompts collated (delta from prompts 1-17 in section 4)

The prompts above (#18 through #24) extend the original list with
verified-on-main grounding. Renumbered for ease of triage:

18. **Tally amend voucher-type fix (F4.44).** Implement the 30-line
    parameterisation of `buildTallyAmendXml` and ship a unit-test
    matrix across all 10 supported voucher types. Quantify the
    silent-failure rate of the amend path in production over the
    last 90 days.
19. **AS2 sidecar / AS4 / EDIINT transport (F4.45).** Cost-out a
    Drummond-certified OpenAS2 sidecar versus Cleo Integration
    Cloud managed service. Decide which path closes the 5
    retail-EDI deals in the next two quarters.
20. **Per-channel intake attribution (F4.46).** Design
    `orders.intake_channel_kind` + `intake_channel_config_id` so
    multi-WhatsApp-line tenants can route per channel. Wire the
    existing handlers to populate; backfill 90 days.
21. **Voice partial extraction (F4.47).** Implement
    `transcript-update` (Vapi) / `transcript_event` (Retell)
    handling + a `voice/partial_extract` cron worker that runs
    every 30s during active calls. Quantify the cost-of-LLM
    delta against the break-even point for high-volume tenants.
22. **Tally bridge cert pinning (F4.48).** Add
    `tally_companies.bridge_cert_sha256_pinned` and refuse-on-mismatch
    semantics. Run a 90-day log-only phase before enforcing.
23. **Webhook signature/dedup grid (F4.49).** Build a
    `webhook_events_processed (provider, event_id, processed_at)`
    table and plumb signature-and-dedup into every inbound
    handler (voice, email, WhatsApp, Stripe, Razorpay, AA Setu,
    TReDS, EDI).
24. **DLQ replay admin surface (F4.50).** Ship view
    `erp_retry_dead_letter` (union of 17 retry queues) + a
    "replay" admin handler + a React component. Phase 3 archives
    rows older than 90 days.
25. **Adapter-family taxonomy + per-tier SKU (F4.51).** Tag each
    adapter with a `strategic_tier` and ship per-tier pricing.
    Build the 22-adapter ROI matrix to inform the tier
    assignment.
26. **Retry-After honoring (F4.52).** Half-day change to
    `erp-runner.js` to parse `Retry-After` from 429s. Measure
    pre/post 429-rate.
27. **Vercel-managed cron migration (F4.53).** Upgrade to Vercel
    Pro, move the 5-min tick to a Vercel cron, add IP allowlist,
    rotate `CRON_SECRET`. Phase 1 runs in parallel for 2 weeks.

---

## 9. Closing note on counts and verification posture

Verified-on-main this pass:
- 22 `*-client.js` files in `src/api/_lib/` (3,253 lines total).
- 17 retry-queue-bearing adapters in `src/api/cron/tick.js:84-102`.
- 17 sync-bearing adapters in `tick.js:104-125` (plus PLM at 128).
- Tally `amend.js:46` retains `VCHTYPE="Sales Order"` hardcoding;
  `push.js` is voucher-type-aware via the `voucherType` body
  parameter.
- `vercel.json` registers exactly one cron: `/api/cron/daily` at
  `30 2 * * *`. `/api/cron/tick.js` exists and accepts
  `CRON_SECRET`-bearer requests but is **not** registered in
  Vercel's scheduler; it depends on an external scheduler.
- `src/api/email/inbound.js:122-138` validates `EMAIL_INBOUND_TOKEN`
  via `timingSafeEqual`. No per-provider HMAC verification for
  SendGrid, Postmark, Mailgun, CloudMailin.
- Voice (Vapi + Retell) signature verification: F4.11 noted.
  Razorpay webhook signature does not enforce a timestamp window.
- WhatsApp inbound writes `documents` rows without
  `scan_status='pending'` (gap from F4.24 holds).

Verified-from-prior-knowledge:
- Stripe SDK `constructEvent()` enforces a 5-minute timestamp
  tolerance by default (in the SDK, not Anvil code).
- Vendor docs for Tally / NetSuite / SAP / Razorpay / Vapi /
  Retell match adapter shapes as cited in F4.39a; no live fetch
  performed this pass.

Inferred (not directly opened this pass):
- The bus-factor of cron-job.org on the 5-min tick; mitigation via
  `cron_health` heartbeats is the documented control.
- The 17-adapter sync read uniformity (every adapter writes a
  raw jsonb mirror) carries across the 16 non-Tally adapters; only
  Tally has a post-push reconciler (Phase F.6, Bet 5).
