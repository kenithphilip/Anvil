# Customer creation by GSTIN fetch — Design (PARKED, backlog)

Status: **Parked backlog item.** No code. Create a customer by entering only
its **GSTIN**; the legal/trade name, address, state, PAN and registration
status auto-populate and are verified against the GST registry. Operator
reviews the pre-filled form and saves. Embodies the "zero data entry — the
keystroke is the enemy" principle (see [[backlog-parked-prs]] zero-data-entry
roadmap).

## Why this matters
Customers are OEMs (see [[project-payment-reality]]); their GSTIN is on every
PO. Today a new customer is typed by hand (name, address, state code, GSTIN,
PAN) — slow and error-prone, and a wrong state code breaks CGST/SGST vs IGST
tax logic downstream. One GSTIN deterministically yields all of it.

## What a GSTIN already encodes (free, no API)
`22AAAAA0000A1Z5` → digits 1-2 = **state code**, chars 3-12 = **PAN**,
char 13 = entity count, char 15 = checksum. So before any network call we can
derive + validate state_code and PAN and run a checksum. Anvil already has the
GSTIN regex + Indian state-code list in `src/api/_lib/docai/validators.js` —
reuse it.

## What the GST registry returns (via a provider)
The official GSTN "Search Taxpayer" data (legal name `lgnm`, trade name
`tradeNam`, principal place of business `pradr`, state jurisdiction,
registration date `rgdt`, taxpayer type `dty` Regular/Composition, **status**
Active/Cancelled/Suspended, constitution of business, nature of activities).
GSTN itself requires a **GSP licence**, so in practice we call a wrapper
provider (e.g. Sandbox/api.sandbox.co.in, Masters India, Surepass, Signzy,
KnowYourGST). The connector must be provider-pluggable and default-deny.

## Design

### Data model
- **`gst_registry`** (cache; RLS tenant-scoped or shared-read): `gstin` (pk
  per tenant), `legal_name`, `trade_name`, `pan`, `state_code`, `address`
  (jsonb: building/street/city/district/pincode), `taxpayer_type`, `status`,
  `registration_date`, `nature_of_business`, `provider`, `raw` (jsonb),
  `fetched_at`. Caches paid lookups — the same OEM GSTIN recurs across orders,
  so this keeps cost near-zero (lean-on-cost, like the email rail).
- `customers` already stores gstin/state_code/PAN; the fetch pre-fills those.

### Endpoint
`POST /api/customers/gst_lookup` — body `{ gstin }`:
1. Normalize + **validate format/checksum** (reuse validators.js); reject early.
2. Cache hit in `gst_registry` and fresh (within TTL) → return it (no provider
   call).
3. Else call the configured provider via a new `src/api/_lib/gst-provider.js`
   (pluggable; creds from env or encrypted per-tenant `tenant_settings`, reuse
   the `inbound-chat.js` AES-256-GCM pattern). Cost-guard + rate-limit like the
   DocAI pipeline.
4. Normalize the response, upsert `gst_registry`, return the normalized object
   + a `verification` block (status, name-match, PAN-derived-from-GSTIN match,
   state-code match).
RBAC: `write` (same as creating a customer). Audit the lookup.

### Client / UX
New-customer form ([customers.tsx](src/v3-app/screens/customers.tsx)) gets a
**"Fetch from GSTIN"** action: type GSTIN → fetch → fields pre-fill (editable)
→ a **status badge** (Active=green, Cancelled/Suspended=red) + name/PAN/state
verification ticks → operator confirms → create through the **existing
customer create / change-request approval flow** (admin applies; writer submits
for approval — see the customer change-request flow). Keep the fully-manual
path for foreign customers (no GSTIN).

### Verification surfaced
- GSTIN **status** (block or warn on Cancelled/Suspended).
- Typed-name vs registry legal/trade name (fuzzy) — flag mismatch.
- PAN derived from GSTIN == registry PAN; state_code matches.

## Phasing (each = shippable PR + migration + gates)
- **P1 — Lookup + prefill:** `gst_registry` migration, `gst-provider.js`
  (one provider + default-deny), `POST /api/customers/gst_lookup` with
  format/checksum validation + cache, "Fetch from GSTIN" in the new-customer
  form, status badge.
- **P2 — Dedup + approval:** before create, dedup against existing customers by
  GSTIN/PAN (avoid duplicate masters); route through the change-request flow.
- **P3 — Re-verification cron:** periodically re-check GSTIN status; flag
  customers whose registration went Cancelled/Suspended.
- **P4 — Reuse everywhere:** same fetch for **suppliers/vendors**, and
  auto-enrich the **GSTIN extracted from a PO** (DocAI) so inbound orders
  resolve/create the customer automatically — ties into autonomous SO intake.

## Reuse map
| Need | Reuse |
|---|---|
| GSTIN format + state-code validation | `src/api/_lib/docai/validators.js` |
| Encrypted per-tenant provider creds | `inbound-chat.js` AES-256-GCM pattern |
| Cost guard + provider default-deny | DocAI pipeline cost-guard pattern |
| Create-with-approval | customer change-request flow |
| Cost-lean caching | `gst_registry` (recurring OEM GSTINs) |

## Watch-outs
- GSTN access needs a GSP/provider; pick provider + budget before P1. Provider
  outage → graceful fallback to manual entry, never block.
- Foreign / unregistered customers have no GSTIN — keep manual path.
- Cache staleness: registration status changes; P3 cron + a "re-fetch" button.

## Addendum — provider: Sandbox.co.in (by Quicko) [verified 2026-07]

Assessed as the concrete provider behind `_lib/gst-provider.js`. GSP-certified
REST layer whose JSON matches what Anvil composes; slots in with almost no
field-shaping. **Verdict: adopt for P1, pilot for e-invoice/e-way-bill.**

**Auth (2 tiers):**
- **Public** GSTIN endpoints need only Anvil's own key: `POST /authenticate`
  with `x-api-key` + `x-api-secret` → 24h JWT (passed in `authorization`,
  **no** `Bearer` prefix). No per-taxpayer consent, no onboarding. Hosts:
  `api.sandbox.co.in` (prod, 500 rpm) / `test-api.sandbox.co.in` (test, 25 rpm).
- **e-invoice / e-way-bill / returns** additionally need ASP onboarding with
  Quicko GSP + per-tenant government-portal creds + (for taxpayer APIs) an OTP
  session — real per-tenant setup, hence "pilot" not "adopt".

**P1 endpoint (this design's provider):**
`POST /gst/compliance/public/gstin/search` → legal name (`lgnm`), trade name
(`tradeNam`), principal + additional address (`pradr`/`adadr`), status (`sts`),
taxpayer type (`dty`), constitution (`ctb`), reg date (`rgdt`), jurisdiction.
Maps ~1:1 onto `FIELD_CATALOG` in `customer-registration.js`
(statutory_identity). Derive `state_code` + `pan` from the GSTIN itself
(`gstinStateCode`/`panFromGstin`), **not** from the response `stcd` (a state
NAME string). Also `/public/gstin/verify` (status only) and `/public/pan/search`
(reverse GSTIN-by-PAN). Write back through `/api/customers/registration` with
`source='gst', verified=true` (the panel already renders the `gst` badge).

**Pricing:** subscription + metered, NOT rate-carded per call. Plans Startup
₹899/mo · Growth ₹8,399/mo · Unicorn ₹16,699/mo (+ Enterprise); 14-day trial;
only 2xx consume quota/wallet; per-call ~₹1–90 (premium ~₹500) visible only in
their cost calculator. **Confirm the per-Search-GSTIN rate before P1 budgeting.**
The `gst_registry` cache (recurring OEM GSTINs → mostly cache hits) blunts it.

**Wins beyond P1 (pilot):** e-invoice IRN (issue #239 — takes Anvil's NIC JSON,
returns IRN + signed QR; needs the SupTyp/RegRev/split fixes any IRP requires);
e-way-bill (`eway_bills/index.js` — today cancel/extend are fake local flips);
GSTR-2A/2B ITC reconciliation (defer). The single biggest missing plumbing both
e-invoice + e-way-bill lack is a **cached auth-token module** (they send a bare
`client_id`); build once, reuse.

**Risks:** third-party in the critical path of every invoice/EWB → keep the
manual fallback, never block; P2/P3 send full invoice JSON to Quicko → DPA
review. See tracking issue #186.

Related: [[backlog-parked-prs]] (zero-data-entry #1 win), [[project-payment-reality]],
`docs/ZERO_DATA_ENTRY_AUDIT.md`, `docs/GST_COVERAGE_ROADMAP.md` (#239).
