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

Related: [[backlog-parked-prs]] (zero-data-entry #1 win), [[project-payment-reality]],
`docs/ZERO_DATA_ENTRY_AUDIT.md`.
