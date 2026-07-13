# Customer matching on SO/PO upload — GST checks

Tracks the checks that guard the "match the extracted customer to an existing
one, else offer to create a new one" flow, so an OCR-misread GSTIN never
mints a duplicate customer. Matcher: `matchCustomerFromExtraction` in
`src/v3-app/screens/so-intake.tsx`.

## The failure this prevents
A customer PO is extracted; OCR misreads one character of the GSTIN (state
code, a check digit, or an O/0 · I/1 · S/5 · B/8 confusion). The extracted
GSTIN then differs from the stored one, the exact-string match misses, and —
if the name/corroboration also miss — the flow drops to "create new customer",
prefilled with the misread GSTIN, even though the customer already exists.

## Checks in place (this PR)
| # | Check | Status | Where |
|---|---|---|---|
| 1 | **GSTIN Mod-36 checksum** on the extracted value (not just 15-char shape) — a garbled string is never trusted as a match/create key | ✅ | `isValidGstin` (`_lib/gstin.js`) wired into Tier 1 |
| 2 | **GSTIN exact match** (checksum-valid only), before name | ✅ | so-intake Tier 1 |
| 3 | **PAN-derived match** — GSTIN chars 3-12 are the PAN; when exactly one existing customer shares it, resolve to them even if state code / check digit was misread. This is the primary guard against false "new customer" | ✅ | `panFromGstin` (`_lib/gstin.js`) → so-intake Tier 1a |
| 4 | **Vendor-code match** (customer_vendor_codes) | ✅ (pre-existing) | so-intake Tier 1b |
| 5 | **Name + corroboration** (bill-to token / state / country-unique), never name alone | ✅ (pre-existing) | so-intake Tier 2 |
| 6 | **Confidence gate** — no auto-match below 0.85 extraction confidence | ✅ (pre-existing) | so-intake:408 |
| 7 | **Write-time GSTIN checksum** on customer create/update | ✅ (pre-existing) | `customers/index.js` |

## Checks still to add (future tracking)
| Check | Why | Note |
|---|---|---|
| **OCR-confusable normalization** before exact GSTIN compare (O/0, I/1, S/5, B/8, Z/2) | catches misreads the PAN fallback can't (e.g. a confusable inside the PAN) | matcher |
| **Extraction-time GSTIN checksum flag** — `validators.js checkGstin` is shape-only; downgrade confidence / flag when the extracted GSTIN fails checksum | surfaces bad OCR earlier | `_lib/docai/validators.js` |
| **Pre-create dedupe by GSTIN + PAN** on the server create path | `POST /api/customers` doesn't dedupe; `customer-canonicalizer.js findByGstin` exists but isn't called on the intake create path — wire it in | `customers/index.js` |
| **"Name matches but GSTIN differs" warning on the create-new dialog** | today the mismatch banner only shows when a customer is already selected, not in the false-new case | so-intake dialog |
| **State-code ↔ GSTIN consistency** re-check at customer save | save validates the GSTIN but not the separately-entered state_code against it | `customers/index.js` |

## Related
- `src/api/_lib/gstin.js` — GSTIN shape + Mod-36 checksum + `panFromGstin`.
- `src/api/_lib/customer-canonicalizer.js` — GSTIN-then-name dedupe-before-insert (used on ERP/email paths; not yet on intake create).
- `docs/GST_COVERAGE_ROADMAP.md` — the broader GST computation coverage.
