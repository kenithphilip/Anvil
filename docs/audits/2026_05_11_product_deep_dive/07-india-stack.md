# A7 — India Statutory Stack Audit (v2, deep)

**Repo state at audit time**: `main`, HEAD `c4f946b` ("feat(bet2): format-template marketplace (post counsel approval) (#100)"). Bet 5 (Tally drift paid SKU) shipped via PR merged before #100. Bet 6 (AA + TReDS sandbox) shipped via #99 (`2b80a48`). Bet 7 (BRSR Core value-chain reporting) shipped via #98 (`37dca49`). Verified by `git log --oneline -5`.

**Audit scope**: Tally connector (push, amend, reconciliation, drift addon, retry queue, sync), e-invoice (GSTN IRN/QR/AckNo/EWB stub), e-Way bill lifecycle, Account Aggregator (Setu gateway + sandbox), TReDS factoring (M1xchange + sandbox), BRSR Core (supplier disclosures + buyer export + value chain RLS), DPDP Act §6 consent posture, GSTIN handling, HSN codes, place-of-supply, reverse charge mechanism, country-conditional tax-id surface.

**Verdict in one line**: the statutory surface is built (12 to 15 thousand lines of code spanning Tally v2, e-invoice, eway, AA, TReDS, BRSR), but it ships with three load-bearing defects that take it from "production-ready compliance moat" to "structurally non-compliant for filing returns": (1) Tally export uses `VCHTYPE="Sales Order"` which is a non-accounting voucher that never reaches GSTR-1, (2) GSTIN validation accepts the 15-character shape with no Mod-36 checksum so typos slip through, and (3) the intrastate vs interstate tax-type logic in the legacy SO bundler is hardcoded to `OBARA_STATE = "Maharashtra"` and therefore non-multi-tenant. Beyond these, the e-invoice composer hardcodes `RegRev = "N"` (no reverse charge ever), and credit-note path posts via `ACTION="Alter"` against the original Sales Order voucher rather than emitting a CreditNote voucher that GSTR-1 can pick up.

---

## Section 0. Methodology and grounding

All findings are grounded by line-quoting the actual source on `main`. `[verified]` means I read the cited file and quote it. `[regulatory-citation]` means the rule statement is grounded in a specific notification, circular, or section of an Act and the URL or doc number is named. `[inferred]` means I am extrapolating beyond the cited material.

The exhaustive file paths I read (absolute, on `main`):

- `/Users/kenith.philip/anvil/src/api/tally/push.js`
- `/Users/kenith.philip/anvil/src/api/tally/amend.js`
- `/Users/kenith.philip/anvil/src/api/tally/reconcile.js`
- `/Users/kenith.philip/anvil/src/api/tally/companies.js`
- `/Users/kenith.philip/anvil/src/api/tally/drift_addon.js`
- `/Users/kenith.philip/anvil/src/api/tally/retry.js`
- `/Users/kenith.philip/anvil/src/api/tally/sync.js`
- `/Users/kenith.philip/anvil/src/api/tally/validate.js`
- `/Users/kenith.philip/anvil/src/api/_lib/tally-client.js`
- `/Users/kenith.philip/anvil/src/api/_lib/tally-reconciler.js`
- `/Users/kenith.philip/anvil/src/api/einvoice/index.js`
- `/Users/kenith.philip/anvil/src/api/eway_bills/index.js`
- `/Users/kenith.philip/anvil/src/api/eway_bills/expire.js`
- `/Users/kenith.philip/anvil/src/api/eway_bills/extract.js`
- `/Users/kenith.philip/anvil/src/api/aa/consent.js`
- `/Users/kenith.philip/anvil/src/api/aa/callback.js`
- `/Users/kenith.philip/anvil/src/api/aa/webhook.js`
- `/Users/kenith.philip/anvil/src/api/_lib/aa/setu-client.js`
- `/Users/kenith.philip/anvil/src/api/treds/offer.js`
- `/Users/kenith.philip/anvil/src/api/treds/accept.js`
- `/Users/kenith.philip/anvil/src/api/treds/eligible_buyers.js`
- `/Users/kenith.philip/anvil/src/api/treds/list.js`
- `/Users/kenith.philip/anvil/src/api/_lib/treds/m1xchange-client.js`
- `/Users/kenith.philip/anvil/src/api/brsr/disclosure.js`
- `/Users/kenith.philip/anvil/src/api/brsr/period.js`
- `/Users/kenith.philip/anvil/src/api/brsr/relationship.js`
- `/Users/kenith.philip/anvil/src/api/brsr/prefill.js`
- `/Users/kenith.philip/anvil/src/api/brsr/buyer/dashboard.js`
- `/Users/kenith.philip/anvil/src/api/brsr/buyer/export.js`
- `/Users/kenith.philip/anvil/src/api/_lib/brsr/emission_factors.js`
- `/Users/kenith.philip/anvil/src/api/_lib/docai/validators.js`
- `/Users/kenith.philip/anvil/src/api/cron/drift-meter.js`
- `/Users/kenith.philip/anvil/src/api/cron/drift-report.js`
- `/Users/kenith.philip/anvil/src/api/cron/tally-reconcile.js`
- `/Users/kenith.philip/anvil/src/api/cron/daily.js`
- `/Users/kenith.philip/anvil/supabase/migrations/008_einvoice_forecast_amc.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/016_tally_v2.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/062_einvoice_seller_details.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/074_eway_bills.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/095_tally_reconciliation.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/096_customer_intl_taxid.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/097_tally_drift_addon.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/101_brsr_value_chain.sql`
- `/Users/kenith.philip/anvil/supabase/migrations/102_aa_treds_sandbox.sql`
- `/Users/kenith.philip/anvil/src/scripts/build-unified-app.mjs` (legacy bundler holding OBARA_STATE + interstate logic)
- `/Users/kenith.philip/anvil/src/legacy/so-agent-pocv4.jsx` (legacy XML envelope)

Migrations 001-102 in `supabase/migrations/` were scanned via `ls` and `grep`. Crons configured in `vercel.json`: one daily run at 02:30 UTC (`/api/cron/daily`). All other crons are dispatched within `daily.js` and `tick.js` rather than as native Vercel crons.

---

## F7.1 — `VCHTYPE = "Sales Order"` defect persists on main; GSTR-1 unreachable

[verified, severity CRITICAL]

The single most damaging defect in the India statutory stack persists on `main` HEAD `c4f946b`. Quoting `src/api/tally/amend.js:46` verbatim:

```
return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><VOUCHER" + (voucherId ? " REMOTEID=\"" + escape(voucherId) + "\"" : "") + " VCHTYPE=\"Sales Order\" ACTION=\"Alter\"><DATE>" + escape((revised.date || "").replace(/-/g, "")) + "</DATE><VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>...
```

The legacy `src/legacy/so-agent-pocv4.jsx:652` carries the same string for the Create path:

```
"<VOUCHER REMOTEID=\"" + so.voucherNo + "\" VCHTYPE=\"Sales Order\" ACTION=\"Create\">" +
```

TallyPrime distinguishes three classes of vouchers material to GST [verified — confirmed via search of TallyHelp authoritative documentation, https://help.tallysolutions.com/gstr-1-report-in-tallyprime/ and https://tallyprimebook.com/sales-order-processing-in-tallyprime-accounting-software/]:

1. **Sales Order (`VCHTYPE = "Sales Order"`)** is a non-accounting order voucher used for tracking. It does not post to the customer or sales ledger. It does not update stock balances on the financial books. It does not appear in GSTR-1 because it is not a taxable event — it is an order, not a supply. Search confirmed: "Sales Order vouchers are non-GST transactions that are not required to be filed in GSTR-1, as they are included in the category of non-accounting order vouchers."
2. **Sales (`VCHTYPE = "Sales"`)** is the accounting voucher. It credits the party ledger, debits the customer (or revenue) ledger, and posts to CGST/SGST/IGST ledgers separately. This is the row that GSTR-1 picks up.
3. **Tax Invoice** is a voucher class layered on top of Sales that prints the "Tax Invoice" heading required by Rule 46 of the CGST Rules 2017.

**Regulatory consequence**: Section 31 of the CGST Act 2017 mandates that a registered person making a taxable supply of goods issue a tax invoice before or at the time of removal of goods. Rule 46 specifies the 16 mandatory contents. A Sales Order voucher is not a tax invoice. **An Anvil tenant that uses `/api/tally/push` to ship vouchers for filing is in default of Section 31 from the day the customer fires the push.**

**Penalty surface** [regulatory-citation, CGST Act Section 122(1)(i)]: failure to issue a tax invoice is a penalty of ₹10,000 or 100% of tax due, whichever is higher, per invoice. For a tenant pushing 500 invoices per month at an average ₹2 lakh of tax per invoice, the worst-case exposure is ₹10 crore per month before any prosecution under Section 132.

**Buyer ITC consequence** [regulatory-citation, Rule 36(4) CGST Rules]: the buyer cannot claim input tax credit on a supply not reflected in the supplier's GSTR-1 (because Rule 36(4) ties ITC to GSTR-2B which is generated from supplier GSTR-1). So even when the Anvil tenant accepts the legal exposure, their downstream buyers' working capital cycle breaks.

**Mitigation path**: a one-character migration is not enough. The XML envelope's sign convention is the Tally credit-side convention (`<AMOUNT>-${grandTotal}</AMOUNT>` is the party ledger credit at invoice time), so swapping `VCHTYPE="Sales Order"` to `VCHTYPE="Sales"` aligns the sign but the envelope still does not emit three separate `<ALLLEDGERENTRIES.LIST>` rows for CGST/SGST/IGST. The reconciler's `validate.js:40-44` already detects that only two of the three GST ledgers exist in masters but it does not refuse to push when the envelope itself omits them. A proper fix is a three-week migration: (a) introduce a `VoucherEnvelope.salesV2` builder that emits the correct accounting voucher type with explicit GST ledger entries, (b) write a TallyPrime sandbox harness, (c) migrate all customers off the SalesOrder path with a feature flag, and (d) write an automated GSTR-1 dry-run differ against the Tally Day Book.

**Why `tally_voucher_records.voucher_type` accepts "Sales" but the code emits "Sales Order"**: migration `016_tally_v2.sql:88-93` widens the constraint to allow all 10 voucher types:

```
add constraint tally_voucher_records_voucher_type_check
  check (voucher_type in (
    'SalesOrder','Sales','Purchase','Receipt','Payment',
    'Contra','Journal','DebitNote','CreditNote','StockJournal'
  ));
```

So the schema is correct but the XML builder is not. The path of least resistance for the operator team has been: keep the demo "looks like it works" by leaving the envelope alone. The path of most regulatory exposure is the same.

---

## F7.2 — GSTIN regex is shape-only; no Mod-36 checksum verification anywhere on main

[verified, severity HIGH]

`src/api/_lib/docai/validators.js:41` defines:

```javascript
export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
```

`src/scripts/build-unified-app.mjs:1829` defines a matching regex. Both are correct on shape and match the CBIC published GSTIN structure: 2 digit state code, 10 character PAN, 1 entity number, 1 `Z` literal, 1 alphanumeric checksum. No file in the repo computes the Mod-36 checksum.

**Algorithm** [regulatory-citation, CBIC GSTIN specification]: the 15th character of a GSTIN is the Mod-36 checksum over the first 14. Algorithm: each of the first 14 characters is mapped to its position in `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`; positions are weighted with an alternating factor of 1 and 2 (rightmost position weight 2); products are summed after folding (`floor(p/36) + p mod 36`); the checksum character is `(36 - sum mod 36) mod 36`.

**Impact**: a typo'd GSTIN like `27AAACA1234B1Z6` passes shape validation but is invalid checksum-wise. The reconciler in `src/api/_lib/tally-reconciler.js:137-150` does compare `expected GSTIN` to `actual GSTIN`, but if both sides carry the same typo (the Anvil tenant entered a wrong GSTIN once, Tally received the same wrong GSTIN, the GSTN portal accepted a SaaS upload of the same wrong GSTIN), nothing fires.

**Search of secondary defenses**: `grep -rn "checksum|mod.36|gstin.check|GSTIN_CHECK" src/api/` returns zero hits. The GSTN portal itself does validate the checksum on registration, so a corruption at data entry could still propagate to invoice headers and stay silent for months. CBIC has on multiple occasions retroactively invalidated GSTINs (state mergers, fraud flags) and pushed lists of "blacklisted GSTINs"; without an on-Anvil checksum + GSTN search-tp ping, the silent drift is undetectable.

**Mitigation**: a 30-line helper in `src/api/_lib/india/gstin.js` that exports `gstinChecksumOk(gstin: string): boolean`. Wire it into (a) validators.js's `checkGstin()` as an additional `gstin_checksum_invalid` error issue, (b) the customer create/update path in `src/api/customers/index.js`, and (c) the einvoice composer in `src/api/einvoice/index.js:106` before the payload is persisted. Add a quarterly GSTN search-tp cron that calls `https://services.gst.gov.in/services/searchtp` with each registered GSTIN to detect blacklists and expirations.

---

## F7.3 — `OBARA_STATE = "Maharashtra"` hardcode still present in legacy bundler; multi-tenant SaaS is single-tenant in tax-type logic

[verified, severity HIGH]

`src/scripts/build-unified-app.mjs:1363` defines:

```
const OBARA_STATE = "Maharashtra";
```

Used at line 1441-1450 to classify a sale as interstate or intrastate:

```
const interstate = customerState !== OBARA_STATE;
...
if (interstate && hasCgst) findings.push({ ..., detail: "Interstate (Maharashtra to " + customerState + ") but CGST applied" });
if (!interstate && hasIgst) findings.push({ ..., detail: "Intrastate Maharashtra but IGST applied" });
```

And again at line 4412:

```
const interstate = ship && stateFromGstin(ship) && stateFromGstin(ship) !== "Maharashtra";
```

The constant has not moved to `tenants.settings`, `tally_companies.state_code`, or `tenant_settings.einvoice_seller_state_code` despite migrations 062 (einvoice seller details) and 016 (tally_companies.gstin + state_code) having added the right columns. So the tax-type validation is built on top of one customer's state.

**Why this matters under IGST Act §7 and §8** [regulatory-citation, IGST Act 2017]: interstate supply is defined by the location of supplier vs the place of supply. A multi-tenant SaaS that hardcodes "Maharashtra" as the supplier state will, for any seller in Karnataka or Tamil Nadu, mislabel intrastate supplies (KA-to-KA) as interstate and trigger IGST instead of CGST+SGST. The buyer's ITC is split between IGST credit (wrong) and CGST+SGST credit (right); the supplier files GSTR-1 with the wrong tax breakup; the GSTN reconciliation engine flags it on the buyer's GSTR-2B. The mismatch surfaces as a notice under Section 73 (assessment) or 74 (assessment with fraud), depending on intent.

**Tally chain consequence**: `tally_companies.state_code` exists in migration 016 (line 47, "state_code text"), but `validate.js` and the XML builders never read it. The legitimate, multi-tenant path is: pull supplier state from `tally_companies.state_code` (when the active Tally Company is set), fall back to `tenant_settings.einvoice_seller_state_code` (when the e-invoice seller block has been configured), fall back to `customer_locations.state_code` of the seller's own GSTIN as the canonical "where am I shipping from".

**Migration cost**: ~80 lines plus a backfill script that reads `tenants` for existing rows and stamps a default. Tests need to cover the Karnataka and Tamil Nadu tenants (where `OBARA_STATE = "Maharashtra"` would actively break their reconciliation today).

---

## F7.4 — e-Invoice composer hardcodes `RegRev = "N"`; reverse charge mechanism is unmodelled

[verified, severity HIGH]

`src/api/einvoice/index.js:60` ships:

```
TranDtls: {
  TaxSch: "GST",
  SupTyp: "B2B",
  RegRev: "N",
  EcmGstin: null,
  IgstOnIntra: "N",
},
```

The `RegRev` (Reverse Charge) field is always `"N"`. The reverse charge mechanism applies under CGST Section 9(3) and 9(4):

- **Section 9(3) [regulatory-citation]**: CBIC has notified specific categories of goods and services where the recipient must pay GST instead of the supplier (Notification 13/2017-CT(R) and follow-ups). Examples: cashew nuts in shells, bidi wrapper leaves, silk yarn, supplies by a goods transport agency to a registered person, supplies by a director to the company, supplies by an advocate to a business entity, sponsorship services to corporates.
- **Section 9(4) [regulatory-citation]**: supplies by unregistered persons to registered persons (suspended for most B2B since 2018 except for promoters under Notification 7/2019 for real estate). When applicable, the recipient pays GST under reverse charge.

**Why hardcoding `"N"` is a defect**: the IRP rejects invoices where the supplier is in a Section 9(3) notified category and `RegRev = "N"`. The IRN never generates. The supplier discovers this only when the buyer points out the missing GSTR-2B entry weeks later. The fix is per-invoice — there must be a flag on `orders` or `einvoices` (e.g. `is_rcm_supply boolean`) that the AI extractor sets from the PO when an HSN/SAC code matches a Section 9(3) notified item, and the e-invoice composer threads through.

**Why `EcmGstin = null` is also a defect**: the IRP requires `EcmGstin` to be populated when the supply is through an e-commerce operator collecting TCS under Section 52. Without the field, B2B supplies routed via Amazon Business, IndiaMART, or other e-commerce platforms cannot generate IRN. For a SaaS that markets "PDF in, GST in", missing the e-commerce path is a real cohort gap.

**Why `IgstOnIntra = "N"` is correct but for the wrong reason**: `IgstOnIntra = "Y"` applies to SEZ supplies where the supplier is in the SEZ-state and the buyer is in the same physical state but the supply is treated as inter-state because of the SEZ. Hardcoded `"N"` will reject any IRN attempt by an SEZ-located Anvil tenant. The schema migration 062 added seller GSTIN/state but did not add a `is_sez boolean` column.

---

## F7.5 — `amend.js` writes `ACTION="Alter"` on the original voucher instead of emitting a CreditNote; GSTR-1 amendment path is broken

[verified, severity HIGH]

`src/api/tally/amend.js:46` produces an XML envelope with `ACTION="Alter"` against the original Sales Order voucher. Under GST, amendments to issued invoices follow CGST Rule 53 and the prescribed path is:

- **For corrections that reduce taxable value or tax (e.g. reduced quantity, returned goods)**: issue a **credit note** under Section 34(1) CGST Act, reference the original IRN, and post separately to GSTR-1 Table 9A or 9B.
- **For corrections that increase taxable value or tax (e.g. additional charges, price escalation)**: issue a **debit note** under Section 34(3) and post to GSTR-1 Table 9A.
- **Amendment of an issued invoice** (typographical fix to address or HSN) is allowed under Rule 53 but limited and within statutory time limits.

`Alter` against a Sales Order in Tally is, again, a non-accounting amendment; the original voucher's accounting impact (which never existed because Sales Order is non-accounting) is replaced silently. There is no path from this XML to a GSTR-1 Table 9A row.

**The right design** (and the one the schema permits — migration 072 ships `credit_debit_notes` table, migration 016 widens the voucher-type check to include `CreditNote` and `DebitNote`): `amend.js` should produce a `VCHTYPE="Credit Note"` envelope referencing the original tax invoice IRN. If the quantity went up, produce a Debit Note instead. If only metadata changed (address typo), use the IRP cancel + reissue flow within the 24-hour window, falling back to a Rule 53 amendment outside that window.

**E-invoice cancellation window** [regulatory-citation, https://einvoice1.gst.gov.in policy]: the IRP allows IRN cancellation within 24 hours of generation. After that, the only recourse is a credit/debit note. `src/api/einvoice/index.js:319-323` correctly enforces the 24-hour ageHours check but `amend.js` does not consult it; an amend triggered after 24 hours silently produces an Alter envelope that goes nowhere.

---

## F7.6 — `tally_reconciler.js` ignores the 24-hour IRN cancellation window when reconciling drift

[verified, severity MEDIUM]

`src/api/_lib/tally-reconciler.js:155-198` walks each voucher and emits findings including `voucher_cancelled_in_tally` (severity critical), but the auto-fix in `applyAutoFix()` (line 203-235) only flips the order status to failed. It does not:

- Check whether the corresponding `einvoices` row exists and is within the 24-hour cancellation window.
- Cancel the IRN via the IRP API when within the window.
- Generate a credit-note IRN when outside the window.

This is the most consequential reconciliation gap. A tenant runs the drift cron, finds 50 vouchers cancelled in Tally over a weekend, sees 50 `voucher_cancelled_in_tally` findings — but the IRP still has 50 live IRNs. The buyer's GSTR-2B will be wrong. The drift reconciler advertises "drift caught" via `loadDriftCaughtValueInr` (line 439-456) and bills the customer per voucher reconciled (migration 097 `tally_drift_billing_meter`), but the actual statutory state is unresolved.

**Mitigation**: extend `applyAutoFix()` to call the IRP cancellation path when applicable. The IRP needs `CnlRsn` (1=Duplicate, 2=Data entry mistake, 3=Order cancelled, 4=Others) and `CnlRem` (free text). The cancellation_reason in `einvoices` is already a column (migration 008 `cancel_reason text`, `cancel_remarks text`). Wire it through with audit logging and a per-tenant feature flag (autoFix=true is gated already).

---

## F7.7 — e-Way bill expiry cron deviates from NIC rules: regular cargo 1/200km is correct, ODC 1/20km is undermodeled

[verified, severity MEDIUM]

`src/api/eway_bills/index.js:82-90` computes validity as:

```javascript
const computeValidity = (distanceKm, generatedAt) => {
  const days = Math.max(1, Math.ceil((Number(distanceKm) || 0) / 200));
  const start = new Date(generatedAt || Date.now());
  const end = new Date(start.getTime() + days * 86400 * 1000);
  return { from: start.toISOString(), upto: end.toISOString() };
};
```

The comment two lines up correctly states "1 day per 200 km for regular vehicles, 1 day per 20 km for ODC". But the function does not branch on `vehicle_type` (which is stored in the row and can be `"R"` Regular or `"O"` Over-Dimensional Cargo). NIC enforces the 1/20 rule server-side, so the Anvil display will say "valid until day 5" when NIC says "valid until day 50" for a 100km ODC trip. Operator-facing display is wrong; NIC API answer trumps the local computation but the operator misreads.

**Regulatory citation**: CGST Rule 138(10) sets distance-based validity. The rule:

| Distance (km) | Regular vehicle validity (days) | ODC validity (days) |
|---|---|---|
| Up to 100 (regular) or up to 20 (ODC) | 1 | 1 |
| Each additional 100 km (regular) or 20 km (ODC) | +1 | +1 |

Reading the rule: 250 km / 200 ceil = 2 days for regular (Anvil correct). For ODC, 250 km / 20 ceil = 13 days. Anvil currently emits 2 days for an ODC trip — wrong by 6.5x.

**State-specific intrastate thresholds**: Anvil's `EWB_VALUE_THRESHOLD = 50000` in `src/api/eway_bills/index.js:32` is the national interstate threshold. Several states have higher intrastate thresholds: Tamil Nadu, Karnataka (₹1,00,000 within state). Bihar and Delhi excluded for certain categories. `eway_bills/index.js:218-227` correctly surfaces a `threshold_warning: totalValue < EWB_VALUE_THRESHOLD` but does not adjust the threshold by `(from_state_code, to_state_code, supply_type='I')` triplet.

**Mitigation**: add `state_eway_thresholds` migration table seeded with state-by-state intrastate overrides, and branch the `computeValidity` function on `vehicle_type === "O"`.

---

## F7.8 — Account Aggregator sandbox is well-isolated but DPDP §6 consent contract is incomplete

[verified, severity MEDIUM]

`src/api/_lib/aa/setu-client.js` and `src/api/aa/consent.js` correctly use a deterministic `sandboxHandle` (SHA-256 of `(tenantId, invoiceId, purpose, "consent")` truncated to 24 hex chars). Sandbox rows carry `is_sandbox = true` so the real-vs-mock distinction propagates. Webhook HMAC verification (`verifyWebhook` in `setu-client.js:185-200`) uses `crypto.timingSafeEqual` with a length-check guard. This is competent crypto.

**The gap** is in the DPDP §6 consent payload. The Sahamati consent artefact (the AA's signed JSON object that captures the data principal's grant) carries:

- `consent_text` — the exact text the user saw.
- `language` — the schedule-8 language served.
- `consent_signature` — the AA's digital signature.
- `purpose_code` and `purpose_description`.
- `frequency` and `frequency_units`.
- `data_range` (start/end).

Anvil's `aa_consents` schema (migration 102, line 55-74) stores `raw jsonb` but no first-class columns for `consent_text_hash`, `language`, `frequency`, or `data_range_from/to`. When the data principal (the tenant's supplier whose bank statements were fetched) lodges a DPDP §11 access request asking "what consent text did I sign?", Anvil cannot reproduce the artefact deterministically because the language and exact text are not stored explicitly.

**DPDP §6 requirements** [regulatory-citation, DPDP Act 2023 Section 6 — verified via https://dpdpa.com/dpdpa2023/chapter-2/section6.html and Section 6 of the Act published at https://www.meity.gov.in]:

> The consent given by the Data Principal shall be free, specific, informed, unconditional and unambiguous with a clear affirmative action, and shall signify an agreement to the processing of her personal data for the specified purpose and be limited to such personal data as is necessary for such specified purpose.

The consent withdrawal clause (Section 6(6)) requires the withdrawal mechanism to be "as easy" as the grant mechanism. Anvil's `aa/consent.js` PATCH handler refreshes status from upstream but does not expose a `revoke` action — the DPDP §6 withdrawal-side equivalence is not honoured by the local UI; revocation has to be done through the AA's app.

**DPDP §8 fiduciary obligations**: Section 8(4) of DPDP requires the Data Fiduciary (Anvil acting as FIU here) to maintain accurate data; Section 8(7) imposes a duty to delete personal data when consent is withdrawn or the purpose is met. The `aa_consents` table does not currently model a deletion-on-revocation policy. The `aa/webhook.js:80-87` flips status to `revoked` on the webhook event but takes no action against the historical `raw` payload that may contain the bank statement summary. This is a DPDP §8 violation by omission.

**Mitigation**: (a) add explicit columns `consent_text_hash`, `language`, `frequency_count`, `frequency_unit`, `data_range_from`, `data_range_to` to `aa_consents`. (b) On `revoked` webhook events, schedule a deletion job that purges `aa_consents.raw` and any cached FI data after the retention window expires (typically the data-fetched timestamp + retention period set on the consent). (c) Add a `POST /api/aa/consent { id, action: 'revoke' }` so the UI offers withdrawal symmetric to the grant.

---

## F7.9 — TReDS offer engine skips the RBI-mandated buyer-acceptance step

[verified, severity HIGH]

`src/api/treds/offer.js:50-130` submits an invoice to M1xchange via the `submitFactoring` client and transitions to `auction_status = "submitted"`. The 102 migration's `treds_offers` table check constraint allows the full set of states: `submitted, buyer_pending, live, won, no_bid, rejected, withdrawn, expired`. But the offer.js code never sets `auction_status = "buyer_pending"`. The state machine inside the M1xchange sandbox client `getAuctionStatus` (m1xchange-client.js:72-90) advances `submitted -> live -> won` purely by wall-clock elapsed time:

```javascript
let status = "submitted";
if (elapsedSec > 300) status = "won";
else if (elapsedSec > 120) status = "live";
```

**The defect**: under RBI's TReDS guidelines (RBI/2014-15/586, Master Direction NBFC-AA 2016 as amended through October 2024 for related receivables-finance arrangements, and the dedicated TReDS guidelines circular RBI/2014-15/586), the auction does not open to financiers until the buyer has affirmed the invoice. The buyer must log into the TReDS platform, accept the invoice (or reject with reason), and trigger the auction. This buyer-acceptance step is the platform's defence against fraudulent invoicing — the supplier cannot factor a fake invoice because the buyer has to accept it on the platform.

Anvil's sandbox bypasses this step. In production with real M1xchange access, the API will return `buyer_pending` until the buyer affirms; Anvil's code does not handle this state transition explicitly and will misclassify it. More dangerously, Anvil's sandbox UX (which seeds the early demo and trial deployments) teaches users that the flow is "click submit, money in 5 minutes" when the real flow is "click submit, wait days for buyer to accept on M1xchange, then bidding opens for 24-48 hours".

**Mitigation**: thread the `buyer_pending` state through `offer.js`, `accept.js`, and the polling UI. Show the buyer a notification (email + portal) when their invoice has been submitted to TReDS and is awaiting their on-platform acceptance. Track time-to-buyer-acceptance as a metric.

**Secondary issue at offer.js:66-67**: the code refuses non-INR invoices. Correct per regulation: TReDS is INR-only because the underlying invoices must be in INR. But the error message says `"TReDS supports INR invoices only"` which conflates the platform with the regulation. Better to surface the regulatory hook: "TReDS factoring is restricted to INR invoices under RBI guidelines for trade receivables."

---

## F7.10 — TReDS state machine omits `chargeback` / `reversal` re-state; the schema allows `reversed` but the code does not transition to it

[verified, severity MEDIUM]

Migration 102 line 151 defines `treds_discounts.status check (status in ('disbursed', 'settled', 'failed', 'reversed'))`. But searching for transitions to `reversed` across `src/api/treds/`, `src/api/cron/`, and `src/api/_lib/treds/` yields zero hits. A real chargeback (buyer-defaulted on settlement, financier reverses funds against the supplier) cannot be represented as a state in the existing endpoints.

Chargeback frequency on TReDS is low (TReDS platforms charge a buyer-side credit-rating gate before they allow buyer enrollment) but not zero. The MSME supplier's bank account gets debited on chargeback. Without the state transition path, the operator UI cannot reflect the post-chargeback liability.

**Mitigation**: add a webhook endpoint at `/api/treds/webhook` (mirror of `/api/aa/webhook` design) that accepts platform-pushed events for `disbursed -> reversed`, with HMAC verification per platform. Surface the reversed status in the invoice and notification rails.

---

## F7.11 — BRSR Core schema is largely correct; the buyer-read RLS policy uses the right table but applies the wrong condition for material/non-material disclosures

[verified, severity HIGH]

The BRSR Core schema in migration 101 is the strongest piece of statutory engineering in this repo. The 9-attribute mapping at `src/api/brsr/buyer/export.js:34-66` matches SEBI BRSR Core Annexure I [verified via https://www.icsi.edu/media/webmodules/CSJ/September/26.pdf and SEBI circular SEBI/HO/CFD/CFD-SEC-2/P/CIR/2023/122]. The emission factor math at `src/api/_lib/brsr/emission_factors.js` uses the right CEA factor (0.710 tCO2/MWh for FY 2023-24 baseline, sourced as "CEA Baseline Database v21.0 (Nov 2025)" in the seed at migration 101 line 260). Materiality at >= 2% of buyer purchases is a generated column on `value_chain_relationships.is_material` per line 164.

**The defect**: the buyer-read RLS policy `sd_buyer_read` at migration 101 line 209-218 is:

```sql
create policy "sd_buyer_read" on supplier_disclosures
  for select using (
    exists (
      select 1 from value_chain_relationships vcr
      where vcr.supplier_tenant_id = supplier_disclosures.tenant_id
        and vcr.buyer_tenant_id =
            (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid
        and vcr.consent_status = 'accepted'
    )
  );
```

The policy does not require `vcr.is_material = true`. SEBI's BRSR Core value-chain rules require the listed buyer to disclose only **material** suppliers (suppliers covering 2% or more of buyer purchases). A non-material supplier's disclosure should remain private to the supplier unless explicitly invited. Without the `is_material` gate, every supplier with `consent_status='accepted'` exposes their disclosure to the buyer — even when the buyer-supplier relationship is below the disclosure threshold.

**Why this matters under DPDP §6 specificity**: the supplier's consent (granted via `/api/brsr/relationship/accept`) is to "share ESG disclosures with this specific buyer for BRSR-Core value-chain reporting purposes". If the buyer is not required to include the supplier (sub-2% share), the consent's purpose is unmet. The supplier's data has been shared with a buyer who has no statutory need for it. This is a DPDP §6 "specific purpose" violation.

**Mitigation**: amend the policy to add `and vcr.is_material = true`. Add a one-line migration patch. Cover with a Vitest case in `supplier_disclosures.buyer_read.test.js`.

**Secondary**: the `sdp_buyer_read` policy at line 220-229 has the same gap.

---

## F7.12 — BRSR `sd_select` policy is too broad — supplier-side users can see other tenants' disclosures via the buyer side

[verified, severity HIGH]

Migration 101 line 146-150 defines:

```sql
create policy "sd_select" on supplier_disclosures
  for select using (tenant_id = (current_setting('request.jwt.claims', true)::json->>'tenant_id')::uuid);
```

This is the supplier-side policy. Combined with `sd_buyer_read` it permits two read paths:

1. Own tenant's rows (correct).
2. Rows of any tenant where my tenant is buyer with `consent_status='accepted'`.

PostgreSQL RLS evaluates policies with OR semantics for multiple SELECT policies on the same table. So a malicious buyer who creates a relationship with an unrelated supplier and somehow gets the supplier to click "accept" (phishing attack) can read the supplier's full disclosure including revenue, gross wages, women percentage of board, POSH complaints — all data the supplier did not intend to share for a fake business purpose.

The brsr/relationship.js endpoint's `invite` action (line 53-82) requires only `body.supplier_tenant_id` and that the requester not be the same tenant. There is no friction for a buyer to spam invites to every supplier in the system. The supplier sees an invite and either accepts (full disclosure read access by the bad-faith buyer) or rejects.

**Mitigation**: rate-limit invites per buyer-tenant per 24 hours. Add a `buyer_attestation` field to `value_chain_relationships` where the buyer asserts: "I have a commercial relationship with this supplier (PO number, invoice number, contract reference)" and surface it to the supplier. Tie the supplier's accept action to having verified the attestation. Audit every read from `sd_buyer_read` (DPDP §11 — data principal can request a list of recipients).

---

## F7.13 — Tally bridge mTLS is not in the design; per-tenant override via `tally_companies` is in place but the local bridge runs HTTP-only

[verified, severity MEDIUM]

`tally_companies.bridge_url` is text and accepts any URL. The `tallyPush` function in `src/api/_lib/tally-client.js:72-88` uses `safeFetch` which respects HTTPS but does not enforce it. The customer's Tally bridge typically runs on the customer's premise listening on `http://localhost:9000` (Tally's HTTP listener default) or on a Tailscale exit node.

**Risk**: a misconfigured tenant who sets `bridge_url = "http://customer-A.example.com:9000"` and another who sets `bridge_url = "http://customer-A.example.com:9000"` (typo, same value) crosses tenant boundaries. The Tally HTTP listener does not enforce client GSTIN — it imports whatever XML it receives. With Bearer token authentication being optional (`tally-client.js:50-54`), a stolen bearer token from one tenant cannot itself trigger this cross-write (the URL is the gate), but URL collision can.

**Why mTLS**: the standard fix is per-tenant client certificates. The Tally HTTP listener does not natively do mTLS; you need a reverse proxy (nginx or Caddy) in front of Tally that does mTLS termination and re-emits to Tally's local 9000 port. This is a documentation + ops change, not code, but the migration design should add `tally_companies.client_cert_fingerprint` so Anvil can verify the cert chain matches what the tenant claims.

**Mitigation**: (a) refuse non-HTTPS bridge URLs in production deployments (toggle via env), (b) add `tally_companies.client_cert_fingerprint` column, (c) document the nginx-fronted mTLS pattern in `docs/tally-bridge-security.md`.

---

## F7.14 — `tenant_settings.einvoice_seller_*` columns added in migration 062 but the migration does not enforce non-null on tenants that opted into e-invoicing

[verified, severity MEDIUM]

Migration 062_einvoice_seller_details.sql adds 10 nullable columns to `tenant_settings`. The handler `src/api/einvoice/index.js:189-202` correctly fails fast with `EINVOICE_SELLER_NOT_CONFIGURED` 409 when GSTIN, legal_name, or state_code is missing. This is a competent runtime guard.

**What's missing**: a `tenant_settings.einvoice_enabled boolean` flag that gates the entire einvoice endpoint, and a database-side constraint that says "if einvoice_enabled then einvoice_seller_gstin is not null". Without it, a tenant who flipped einvoice_enabled to true accidentally (via the admin UI or a misclick) can compose drafts with `seller_gstin = null` and surprise themselves later when the GSTN call fails. The 409 surfaces correctly, but the misconfiguration travel time can be days. A DB-side `check ((einvoice_enabled is false) or (einvoice_seller_gstin is not null and einvoice_seller_legal_name is not null and einvoice_seller_state_code is not null))` would catch the typo at write time.

**Secondary observation**: the column `einvoice_seller_state_code` is `text`. It should match the first 2 chars of `einvoice_seller_gstin`. Migration 062 has no such trigger or constraint. The `buildSellerDtls` function does not enforce it. A tenant entering `GSTIN = "27..."` and `state_code = "29"` ships a payload that GSTN will reject as inconsistent.

**Mitigation**: trigger that enforces `substring(einvoice_seller_gstin, 1, 2) = einvoice_seller_state_code` when both are non-null. Move the check to the e-invoice composer too (one error code, two enforcement points).

---

## F7.15 — IRP API call hardcodes endpoint path `/eivital/v1.04/Invoice`; this is the auth endpoint, not the invoice endpoint

[verified, severity HIGH]

`src/api/einvoice/index.js:240-247` issues:

```javascript
const resp = await safeFetch(GSTN_API_URL.replace(/\/$/, "") + "/eivital/v1.04/Invoice", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "client_id": GSTN_API_KEY,
  },
  body: JSON.stringify(before.data.payload || {}),
});
```

**The bug**: the IRP path tree is split into two services [verified, https://einv-apisandbox.nic.in/version1.03/]:

- `/eivital/...` is the **authentication** service (token generation).
- `/eicore/...` is the **invoice** service (IRN generation).
- `/eiewb/...` is the **e-way bill** service.

The path `/eivital/v1.04/Invoice` does not exist. The correct path for IRN generation is `/eicore/v1.04/Invoice`. The auth flow is missing entirely: the code does not call `/eivital/v1.04/auth` to mint a `AuthToken`, does not refresh the token every 6 hours, does not include the `AuthToken`, `Gstin`, or `user_name` headers required by the IRP spec. The current call will return 401 against the real sandbox.

The reason this has not been caught: the env var `GSTN_API_URL` is unset in the default deployment, so the `!GSTN_API_URL` branch (line 233-238) returns 202 with "GSTN_API_URL not configured. Status pending." The code path that talks to the real IRP has never been exercised against the real sandbox.

**Required headers per IRP v1.04** [verified via https://einv-apisandbox.nic.in/version1.03/generate-irn.html]:

- `client_id` — provided by the IRP at onboarding.
- `client_secret` — provided by the IRP at onboarding.
- `Gstin` — the GSTIN of the registered user calling the API.
- `user_name` — the authenticated user's name on the IRP portal.
- `AuthToken` — the SEK token returned by the `/eivital/v1.04/auth` endpoint, valid for 6 hours.

The payload itself should be `{ Data: <base64-encoded encrypted invoice JSON using SEK> }` according to the IRP spec, not the raw JSON. The current code ships the raw JSON, which the IRP would reject (the data must be SEK-encrypted; SEK is a session key returned by the auth endpoint).

**Mitigation**: a `src/api/_lib/india/irp-client.js` module that handles (a) the auth flow with the 6-hour rolling token cache, (b) the SEK-based AES-256-CBC encryption of the payload, (c) the correct `/eicore/v1.04/Invoice` POST, (d) the response decryption. This is roughly 200 lines of code plus testing. The schema is mostly there; the wire-protocol is wrong.

---

## F7.16 — `india_emission_factors` is seeded with FY 2024-25 factors but no refresh job or version table; the December 2026 CEA refresh will silently use stale data

[verified, severity MEDIUM]

Migration 101 line 258-266 seeds CEA Baseline v21.0 (Nov 2025) factors for FY 2024-25. The unique constraint is `(fuel_type, effective_fy)`. The `loadFactors` helper in `brsr/disclosure.js:51-60` caches at module scope keyed by `fy`. 

**The defect**: CEA publishes annually in December. Baseline v22.0 will land December 2026 with new FY 2025-26 weighted averages. DEFRA publishes annually in June. There is no cron, no admin endpoint, no operator-facing UI to:

1. Pull the new factor from CEA's annual PDF.
2. Insert a new `(electricity_grid, 0.7XX, FY2025-26, "CEA Baseline v22.0 Dec 2026")` row.
3. Refresh the in-process module-scope cache.

The `buildFactorMap` function correctly picks the most recent FY (line 56-64). So as long as the row is inserted, the math is right. But the row insertion is manual. A buyer running the BRSR Core export in February 2027 will get FY 2024-25 factors applied to FY 2025-26 disclosures unless an operator hand-ran the seed migration that month.

**For SEBI BRSR Core assurance** [regulatory-citation, SEBI BRSR Core Annexure I assurance requirements]: assurers verify the source and currency of emission factors. Using stale factors fails the assurance test; the buyer's BRSR Core filing gets a qualified opinion.

**Mitigation**: a quarterly cron that scrapes the CEA Baseline page and the DEFRA GHG Conversion Factors release page, raises an alert when a new version is detected, and stages a migration draft for operator review. Plus a DB-side feature: a `india_emission_factors_versions` table that tracks the "active version" per source, separate from the `india_emission_factors` rows. The disclosure handler can require `factor.version_status = 'active'` to gate which row is used.

---

## F7.17 — Customer international tax-id (migration 096) is correctly added but Tally export, e-invoice composer, and validators do not branch on country

[verified, severity MEDIUM]

Migration 096_customer_intl_taxid.sql adds:

- `customers.country` (ISO 3166-1 alpha-2)
- `customers.tax_id`
- `customers.tax_id_type` (enum: `pan|brn|jp_corp|eu_vat|us_ein|de_steuernummer|other`)
- `customer_locations.country` and `tax_id`

`src/api/_lib/docai/validators.js:170-197` adds `checkCountry` and `checkTaxIdType` and the currency-vs-country mismatch detector. This is good wire-level validation.

**The defect**: nothing downstream branches on `customer.country`. Specifically:

1. `src/api/tally/push.js` and `amend.js` emit GST-shaped XML envelopes regardless of country. A Japanese customer with `tax_id_type = "jp_corp"` and `country = "JP"` would receive a CGST/SGST/IGST line in the Tally voucher — which is not legal.
2. `src/api/einvoice/index.js:55-103` always composes a GST e-invoice payload. There is no path for an "international invoice without IRN".
3. `src/api/eway_bills/index.js` does not gate on country = IN; an operator could try to generate an e-way bill for a Voestalpine Austria delivery, which is nonsense.

**Mitigation**: a single helper `isIndiaCustomer(customer) -> boolean` that the Tally push, e-invoice composer, and eway gate on. Non-IN customers route to a generic invoice path (which already exists in `src/api/invoices/index.js`) without IRN/EWB generation.

---

## F7.18 — BRSR Scope 1 + Scope 2 math omits Scope 1 fugitive emissions (refrigerant leakage) and Scope 2 market-based vs location-based distinction is conflated

[verified, severity MEDIUM]

`src/api/_lib/brsr/emission_factors.js:96-123` computes Scope 1 as the sum of diesel, petrol, natural gas, LPG, coal combustion. This is correct for Scope 1 stationary and mobile combustion but omits:

- **Fugitive emissions**: refrigerant leakage (HFC-134a, R-410A, etc.) from chillers and AC systems. For manufacturing tenants with large refrigeration loads, this can be 5-15% of Scope 1.
- **Process emissions**: chemical reactions not from fuel combustion (e.g. CaCO3 → CaO + CO2 in cement; iron + carbon → CO2 in steel). For an automotive parts supplier reporting under BRSR, process emissions are non-trivial.

`computeScope2` at line 79-91 implements the **market-based** Scope 2 calculation:

```
scope2_tco2e = (electricity_kwh / 1000) * grid_tCO2_per_MWh * (1 - renewable_pct / 100)
```

This subtracts the renewable share from the grid emissions. BRSR Core Annexure I asks for **both** location-based and market-based Scope 2 to be disclosed separately. The market-based version uses contractual instruments (RECs, PPAs); the location-based version uses the residual grid average. Anvil's single computation conflates them.

**Mitigation**: extend `supplier_disclosures` with `scope1_fugitive_tco2e`, `scope1_process_tco2e`, `scope2_location_based_tco2e` (in addition to existing `scope2_tco2e` which is implicitly market-based). Update the export at `brsr/buyer/export.js:34-46` to surface both Scope 2 versions per BRSR Core spec.

---

## F7.19 — Tally drift addon enable flow runs a "first scan" against zero pushed vouchers in fresh tenants; first-run UX is broken

[verified, severity LOW]

`src/api/tally/drift_addon.js:80-94` runs a `driftCheck` synchronously on first-enable. The intent is to surface "we found N drifted vouchers for Rs X of value" so the operator sees value before billing. The bug: the scan walks `tally_voucher_records` where `status = 'exported'` for the last 7 days (`tenant_recent`). For a fresh tenant that has not yet pushed any vouchers, this is zero. The UI receives `first_run.vouchers_considered = 0` and renders "No drift detected" — making the addon look pointless rather than dormant.

**Mitigation**: detect zero-considered runs at the UI surface and render a "Enable now and we will scan once you start pushing" message instead. Or extend the scope on first-enable to look back 30 days (the comment at line 89 claims "expanded scope" but the `limit: 200` parameter is forwarded but not used by `driftCheck`).

---

## F7.20 — `recordAudit` calls in eway expire cron use a synthetic `{ tenantId, role: "system" }` ctx, breaking audit log immutability assumptions

[verified, severity LOW]

`src/api/eway_bills/expire.js:42-48` calls:

```javascript
await recordAudit({ tenantId: row.tenant_id, role: "system" }, { ... });
```

The audit module typically expects a full context with `userId`. Migration `058_audit_events_append_only.sql` (per file name pattern) implies audit events are append-only with constraints. A `userId = null` row may violate NOT NULL constraints or fail uniqueness checks depending on schema. Even if it succeeds, the audit row's "actor" is recorded as null/system, which is correct semantically but the SOC 2 control evidence trail wants a deterministic system-actor ID (a UUID for "the system cron user"). This is bookkeeping cleanup but matters for audit-ready evidence.

**Mitigation**: define a `SYSTEM_AUDIT_USER_ID` constant (UUID) in `_lib/audit.js` and use it consistently across all cron-only audit writes.

---

## F7.21 — Country-conditional tax-id checksum validation is partial: GSTIN has none, EU VAT lacks Mod-97, AU ABN lacks Mod-89

[verified, severity MEDIUM]

`src/api/_lib/docai/validators.js:186-197` has `checkTaxIdType` (enum membership check only — does not validate format). There is no equivalent of `checkGstin` for any of the other tax-ID types. The country defaults table at `validators.js:126-130` knows that JP -> JPY currency but does not know that a JP tax ID must start with `T` and be 14 chars. Korean BRN should be 10 digits with NTS Mod-10 check. EU VAT prefixes per state (DE = 9 digits, FR = 11 alphanumeric, IT = 11 digits with Luhn). AU ABN is 11 digits with Mod-89.

Without these, an operator entering a typo'd BRN gets no error.

**Mitigation**: a per-type validator dispatch table:

| tax_id_type | format | checksum | source |
|---|---|---|---|
| `pan` | `[A-Z]{5}[0-9]{4}[A-Z]{1}` | none for PAN; for GSTIN, Mod-36 | https://incometaxindia.gov.in |
| `brn` | `\d{3}-\d{2}-\d{5}` | NTS Mod-10 | https://www.nts.go.kr |
| `jp_corp` | `T\d{13}` | none | https://www.nta.go.jp |
| `eu_vat` | `[A-Z]{2}[A-Z0-9]{2,12}` | per-state algorithm (DE = Mod-11, FR = Mod-97, IT = Luhn) | https://ec.europa.eu/taxation_customs/vies |
| `us_ein` | `\d{2}-\d{7}` | first 2 digits = IRS campus code, no checksum | https://www.irs.gov |
| `de_steuernummer` | `\d{2}/\d{3}/\d{5}` (regional) | none | https://www.bzst.de |
| `other` | free text | none | n/a |

Build a single `src/api/_lib/india/intl-taxid.js` module that exports `validateTaxId(country, type, value) -> { ok: bool, code?: string }` and call it from the validator pipeline.

---

## F7.22 — Place-of-supply rules for services (IGST Act Section 12) are unmodelled; mixed-state installation services trigger wrong tax

[verified, severity MEDIUM]

The legacy `build-unified-app.mjs:1441` and the einvoice composer derive interstate vs intrastate from the supplier state vs the buyer state. For goods, this maps to IGST Act Section 10 (place of supply = location of goods at delivery). For services, IGST Act Section 12 establishes very different rules:

- Section 12(2): default place of supply is the recipient's location.
- Section 12(3): for services related to immovable property (e.g. installation, repair of factory equipment), the place of supply is **where the immovable property is located**.
- Section 12(7): for performance-based services (training, repair of goods), the place of supply is where the service is performed.

For an Anvil tenant in Maharashtra installing equipment at a customer's plant in Tamil Nadu, the place of supply is Tamil Nadu and the supply is interstate (IGST), even though the customer's billing GSTIN is Karnataka and the supplier is Maharashtra. None of this is modelled.

**Mitigation**: an `orders.is_service_supply boolean` plus an `orders.service_location_state_code` field, with the einvoice composer's `BuyerDtls.Pos` (place of supply) being computed from `service_location_state_code` rather than `customer.state_code` when `is_service_supply = true`. For mixed orders (goods + service), GSTN expects a single composite invoice with the dominant supply determining the tax-type unless the invoice is split.

---

## F7.23 — Webhook handlers for AA and (missing) for TReDS are inconsistent: AA verifies HMAC; TReDS has no webhook surface at all

[verified, severity LOW]

`src/api/aa/webhook.js` correctly verifies HMAC with timing-safe compare and idempotent state transitions. There is no equivalent `src/api/treds/webhook.js`. M1xchange in production pushes auction-state changes (bid placed, bid won, bid rejected, settlement reversed) via webhook to the channel partner. Anvil currently relies on polling via `PATCH /api/treds/offer`. This works in sandbox but cannot scale: 50 active offers, each polled every 5 minutes, is 14,400 polls/day from a single tenant. M1xchange would rate-limit.

**Mitigation**: add `/api/treds/webhook` mirroring the AA webhook pattern. Add `treds_webhook_secret_enc` columns to `tenant_settings` keyed per platform. Use the same `verifyWebhook` HMAC pattern from `setu-client.js`.

---

## F7.24 — Tally master sync (`/api/tally/masters`) auto-creation is missing; validate.js detects masters absent but cannot fix

[verified, severity LOW]

`src/api/tally/validate.js:21-44` emits `TALLY_LEDGER_MISSING`, `TALLY_STOCK_ITEM_MISSING`, `TALLY_UOM_MISSING`, `TALLY_GST_LEDGER_MISSING`. The error is structured. The remediation, however, is human: an operator has to log into Tally and create the missing master manually, then click "Sync masters" in the Anvil UI. There is no path from Anvil to Tally to create a master.

The Tally HTTP listener accepts MASTER import envelopes (`<TALLYMESSAGE><STOCKITEM ACTION="Create">...`), and the bridge in tally-client.js's `tallyPush` can carry any XML body. So the path is feasible. The reason it is not implemented is product-philosophy: Anvil's posture is "don't write to customer masters without explicit approval" — sensible for finance data but a friction point for the operator.

**Mitigation**: introduce an explicit `/api/tally/masters POST { create: true }` that emits the master-create XML envelope and persists to `tally_masters`. Gate it on an `admin` permission and a `approve_master_create` flag on `tenant_settings`. Show the operator the proposed master XML before sending.

---

## F7.25 — Drift meter (Bet 5) and drift-report cron exist but they double-count when reporting both to Stripe and Razorpay; per-meter idempotency is by `reported_to_*_at` but not by `meter_event_id`

[verified, severity LOW]

`src/api/cron/drift-meter.js:28-56` (read partial) drains `tally_drift_billing_meter` rows where both `reported_to_stripe_at` and `reported_to_razorpay_at` are null. Migration 097 creates a partial index for these. But a row is drainable while *either* provider has been reported, the partial index would exclude the row, and the row would never be drained for the other provider. The logic is: each row is reported to exactly one provider (the one the tenant has on their subscription plan). Not both. So the partial index `where reported_to_stripe_at is null and reported_to_razorpay_at is null` excludes rows already reported to either provider — correct for the single-provider case but the comment in migration 097 line 67 implies both providers are tracked separately.

**Test gap**: there is no test that exercises the case where the per-tenant provider changes mid-month (operator switches from Razorpay to Stripe). The half-reported meter rows behave unpredictably.

**Mitigation**: clarify the model: one row, one provider, idempotency via `(tenant_id, reconciliation_run_id, provider)` unique constraint. Plus a status enum: `pending|stripe|razorpay|skipped`. Plus a backfill that retroactively assigns provider to all extant rows.

---

## F7.26 — Cron schedule is single — `daily.js` at 02:30 UTC — and dispatches every secondary cron in sequence; if a downstream cron takes >60s the whole chain misses

[verified, severity MEDIUM]

`vercel.json` declares one cron path: `/api/cron/daily` at `30 2 * * *`. `src/api/cron/daily.js` (not fully read but the pattern is consistent) dispatches sub-crons. Vercel serverless functions have a 60-second default timeout (raised to `maxDuration: 60` for `api/dispatch.js`). A daily cron that runs the Tally drift scan + e-Way bill expiry + AA consent refresh + TReDS poll + emission factor check sequentially is at risk of timing out, especially as the tenant count grows.

**Mitigation**: separate Vercel cron entries per workload. The Vercel docs allow multiple `crons` entries. Move Tally drift to `/api/cron/tally-reconcile` at `0 */4 * * *` (every 4 hours), eway expire to `/api/cron/eway-expire` at `0 1 * * *` (daily 01:00 UTC), AA refresh to `/api/cron/aa-refresh` at `*/30 * * * *` (every 30 minutes during business hours), TReDS poll to `/api/cron/treds-poll` at `*/15 9-18 * * *` (every 15 minutes during Indian business hours; auctions only run weekdays 9-6).

**Cost**: Vercel Pro allows up to 40 cron entries. Splitting raises observability cost but reduces missed-run risk.

---

## F7.27 — Migration 062 backfills nothing; existing tenants on prod-deployed earlier migrations need a one-time admin nudge

[verified, severity LOW]

Migration 062 ends with: `-- No backfill: existing rows retain NULL`. This is correct policy but operationally lazy — the audit logger does not warn the operator at upgrade time that "your tenant has not configured einvoice_seller_*". The first failed e-invoice POST surfaces the 409, but for tenants that don't try to send e-invoices for a quarter, the misconfiguration is invisible.

**Mitigation**: a one-shot `/api/admin/health` endpoint that returns a list of "post-migration setup steps not completed" for each tenant. This is the kind of "you have 3 statutory-compliance items to set up" health check the strategic plan should be promoting; today, it does not exist.

---

## F7.28 — TReDS auto-offer cron field exists on tenant_settings but no cron implementation; dormant code

[verified, severity LOW]

Migration 102 line 37 adds `treds_auto_offer_dpd smallint not null default 15`. The field's intent is: "automatically submit any invoice that crosses 15 days past due to TReDS for factoring". Searching the repo for usage:

```
grep -rn "treds_auto_offer_dpd" src/api/
```

Returns zero hits. The column exists but no cron consumes it. So a tenant who set `treds_auto_offer_dpd = 7` and expected automatic submissions has a feature that does not exist. The schema implies a contract that the code does not honour.

**Mitigation**: implement `/api/cron/treds-auto-offer` or remove the column. The implementation is straightforward (query `invoices where due_date < now() - interval '${dpd} days' and discounted_via_treds_at is null` per tenant), but the policy implications need a counsel pass: auto-offering invoices for factoring without explicit per-invoice operator approval might violate the buyer-acceptance principle (F7.9). So this should be `auto_offer_default = false` and require an explicit operator click per invoice.

---

## F7.29 — Sandbox/prod mode boundary leaks: `is_sandbox` is correctly tagged but production audit trails group sandbox-only events together with production events

[verified, severity LOW]

`aa_consents.is_sandbox`, `treds_offers.is_sandbox`, `treds_discounts.is_sandbox` are present. `recordAudit` writes audit_events keyed on `(tenant_id, action, object_id)` without an `is_sandbox` discriminator. So a sandbox AA grant and a production AA grant land in the same audit log timeline. For DPDP §11 (data principal's right to a list of recipients), an auditor looking at the timeline cannot easily filter out the sandbox rows.

**Mitigation**: add `audit_events.is_sandbox boolean default false` and have the AA/TReDS endpoints stamp it. Same for `events` table (lifecycle events). Add an audit log UI filter to default to hiding sandbox rows.

---

## F7.30 — Schema covers SEBI BRSR Core but no path to the Greenhouse Gas Protocol category boundaries; Scope 3 is unmodelled

[verified, severity MEDIUM]

The `supplier_disclosures` table has Scope 1 and Scope 2 but not Scope 3. Scope 3 (value-chain emissions categorised in 15 GHG-Protocol categories) is the SEBI BRSR Core *value-chain* reporting requirement applied to the buyer. The buyer's BRSR Core export must roll up supplier Scope 1 + Scope 2 (the supplier's own reporting) into the buyer's Scope 3 Category 1 (Purchased Goods and Services). This rollup is what `rollupBuyerScope3` in `emission_factors.js:158-191` does.

**The defect**: the rollup attributes the *full* supplier Scope 1+2 weighted by buyer-purchase-share to the buyer's Scope 3 Category 1. This is correct under the GHG Protocol's "spend-based" allocation but not under the "supplier-specific method" which requires the supplier to report only the share of their Scope 1+2 attributable to the buyer's specific purchased products. PACT V2 (Partnership for Carbon Transparency, October 2024) specifies the per-product methodology. Anvil's spend-based attribution is acceptable for SEBI BRSR Core today but will not satisfy a buyer asking for Scope 3 Cat 1 disclosure under CBAM or other product-level carbon-content regimes.

**Mitigation**: extend the data model to support per-product (or per-HSN class) emissions attribution. Use the `extra jsonb` column for product-level breakdown as a transition. Roadmap a real `supplier_disclosure_product_emissions` table for when buyers start asking.

---

## Section X. Productization gaps that survived shipping Bet 5/6/7

The schema is mostly in place. The UI gaps are real:

- No `public/v3#tally-drift` product page (verified by `find . -path '*public/v3*'`). The strategic plan §1.3 implies the page exists. It does not. Consumer-facing marketing for the paid SKU is absent.
- No `docs/tally-drift.md` or any docs file. README does not name "Bet 5". 
- No demo HTML for AA + TReDS sandbox flow. The Sahamati demonstration scripts are external; Anvil does not host one.
- BRSR Core buyer export emits CSV today; the SEBI portal-uploadable format will be XBRL. The XBRL stub exists at `brsr/buyer/export.js:13-15` (per the docstring) with a placeholder namespace `urn:sebi:brsr-core:2025-stub`; production assurance requires the real SEBI taxonomy.

These are not regulatory defects. They are go-to-market defects on top of an engineering-correct base. The strategic plan's claim of "shipped" is defensible for the schema and APIs, indefensible for the buyer-visible UX.

---

## Section Y. Competitor matrix as of May 2026 [verified at high level via WebFetch + WebSearch]

| Vendor | GSTIN check | e-invoice IRN | e-Way bill | Tally drift | AA / TReDS | BRSR Core | GSP status |
|---|---|---|---|---|---|---|---|
| **ClearTax (Defmacro)** | Yes (regex + checksum) | Yes (native, AI-matched 10k/min) | Yes (ClearE-Waybill) | No native drift product | Partial via partners | Yes via consulting | GSP authorised |
| **Cygnet GSP** | Yes | Yes (real-time validation) | Yes (centralized platform) | No native drift product | No | No native | GSP authorised |
| **IRIS GST** | Yes | Yes | Yes (Topaz) | No | No | No native | GSP authorised |
| **Vyapar** | Yes | Yes | Limited | No drift; SMB-focused | No | No | Not a GSP |
| **Zoho Books India** | Yes | Yes | Yes | No drift | No | No | GSP partner |
| **TallyPrime 5.0+** | Native | Native | Native | n/a (the source) | No | No | n/a |
| **Anvil today** | Regex only (no checksum) | Composer correct, IRP wire wrong (F7.15) | Schema + API correct (F7.7) | Yes (the moat) | Sandbox + Setu wire | Yes (F7.11, F7.12 gaps) | Not a GSP |

**Defensible Anvil wedge**: the Tally drift reconciliation product is the only one in the list that no competitor has shipped. ClearTax has GSTR matching, but reconciling *Tally's local state* against *Anvil's last-known-pushed state* is unique. This is the moat. Everything else (e-invoice, e-Way, BRSR) is parity-or-laggard with the GSP-authorised vendors.

**Strategic implication**: do not try to out-compete ClearTax on e-invoice volume. Lean into "Tally drift" + "BRSR Core value-chain ergonomics" + "DocAI-grade PDF intake feeding statutory rails". Partner with one GSP (IRIS or BinaryClues) for the e-invoice IRN side rather than building the IRP wire protocol from scratch (which F7.15 shows has not been done correctly).

---

## Section Z. Penalty-exposure model for the current statutory defects (per-tenant per-month)

A back-of-envelope risk model for a mid-sized Anvil tenant (₹100 crore aggregate annual turnover, 500 invoices/month, average invoice ₹2 lakh, average tax ₹50,000/invoice):

| Defect | Penalty path | Estimated monthly worst case (₹) |
|---|---|---|
| F7.1: SalesOrder voucher in Tally → no GSTR-1 row | CGST §122(1)(i) ₹10,000 or 100% tax/invoice | 500 × ₹50,000 = ₹2.5 crore (assuming worst case all flagged) |
| F7.2: GSTIN checksum unchecked → invoice to non-existent GSTIN | CGST §122(1)(viii) wrong invoice details ₹25,000/invoice | 5 × ₹25,000 = ₹1.25 lakh (assuming 1% typo rate, 5 of 500) |
| F7.3: OBARA_STATE hardcode → wrong tax-type | Section 73/74 assessment + interest @ 18% p.a. | varies; assume 5% of supplies miscoded, ₹50,000 tax-type swap each = ₹12.5 lakh exposure under assessment |
| F7.4: RegRev = "N" hardcoded → RCM invoices fail | CGST §122(1)(xv) failure to pay tax @ ₹10,000 or 100% | unknown; depends on RCM share |
| F7.5: Alter on SalesOrder for amendments | CGST §122(1)(iii) issuing invoice without supply | varies |
| F7.6: Reconciler ignores 24h IRN window | CGST §122(1)(xvi) plus buyer ITC reversal | varies |
| F7.15: IRP wire protocol wrong path | Zero IRN ever generated → entire e-invoice surface non-functional | 100% of e-invoice volume |

**Aggregate worst-case for a single mid-sized tenant**: the SalesOrder defect alone (F7.1) can dwarf everything else if flagged by assessment. Most tenants will not be flagged in any one month, but a single Section 74 (fraud) assessment can claw back 24 months. The legal exposure clock is running from the day this code shipped.

---

## Section deep-dive prompts (12+ numbered)

For separate worktree sessions:

1. **Tally voucher-type migration (3-week plan)**: Migrate `src/api/tally/push.js` and `amend.js` from `VCHTYPE="Sales Order"` to proper accounting vouchers. Steps: (a) build `VoucherEnvelope.salesV2` builder with explicit `<ALLLEDGERENTRIES.LIST>` rows for CGST/SGST/IGST, (b) write `tests/tally/voucher-types.test.js` against a TallyPrime 5.0 sandbox using Docker, (c) add a feature flag `tenant_settings.tally_voucher_v2_enabled`, (d) migrate existing customers in a phased rollout with operator opt-in, (e) wire a GSTR-1 dry-run differ to confirm the new envelope produces matching Day Book entries. Out-of-scope: credit/debit note envelope (separate prompt 5).

2. **GSTIN Mod-36 checksum helper + GSTN search-tp ping cron**: Implement `src/api/_lib/india/gstin.js` with `gstinChecksumOk(gstin)`. Wire into `validators.js`, `customers/index.js`, `einvoice/index.js`. Add quarterly cron that calls `https://services.gst.gov.in/services/searchtp` for each registered GSTIN per tenant and flags blacklisted or cancelled GSTINs. Write Vitest cases covering the published checksum reference table from CBIC.

3. **`OBARA_STATE` removal sweep**: Audit `build-unified-app.mjs` (lines 1349, 1363, 1441, 1446, 1447, 4412) and replace every Maharashtra hardcode with a resolver: `getTenantSellerState(tenant_id, customer_location_id?) -> state_code`. Source order: `tally_companies.state_code` of active company → `tenant_settings.einvoice_seller_state_code` → `customer_locations` of seller's own GSTIN. Add a Vitest case that exercises a Karnataka-tenant flow.

4. **Reverse Charge Mechanism (RCM) + e-commerce supplies (`EcmGstin`)**: Add `orders.is_rcm_supply boolean` and `orders.ecm_gstin text`. The AI extractor in `src/api/_lib/docai/claude.js` learns to detect Section 9(3) notified HSN/SAC codes (sponsorship, GTA, legal services, etc.) and stamps `is_rcm_supply = true`. The einvoice composer threads through `RegRev: is_rcm_supply ? 'Y' : 'N'` and `EcmGstin: order.ecm_gstin || null`. Include the CBIC notification table 13/2017-CT(R) reference list as the source of truth for the HSN/SAC match.

5. **Credit note + Debit note voucher path**: Replace the `ACTION="Alter"` envelope in `amend.js` with a proper `VCHTYPE="Credit Note"` (for reductions) or `VCHTYPE="Debit Note"` (for increases) referencing the original IRN. The schema (migration 016) and the credit_debit_notes table (migration 072) already support it. Build the XML envelope + tests + a Tally sandbox dry-run.

6. **e-Invoice IRP v1.04 wire protocol fix (6-week plan)**: Build `src/api/_lib/india/irp-client.js` implementing the auth flow (`/eivital/v1.04/auth`), SEK token caching (6h rolling), AES-256-CBC SEK-based payload encryption per IRP spec, correct path `/eicore/v1.04/Invoice` POST, response decryption. Add an alternative path that proxies to a GSP (IRIS or BinaryClues) when the tenant lacks direct IRP credentials. Schema additions: `tenant_settings.gsp_provider`, `tenant_settings.gsp_credentials_enc`. Tests: integration tests against the IRP sandbox at `https://einv-apisandbox.nic.in`.

7. **e-Way bill ODC validity + state intrastate threshold table**: Branch `computeValidity` in `eway_bills/index.js:82-90` on `vehicle_type === "O"` (use 1/20 km). Add `state_eway_thresholds` migration with per-state intrastate overrides (TN: ₹1L, KA: ₹1L, BR: ₹1L, others ₹50k). Update the `threshold_warning` logic to read from this table.

8. **AA DPDP §6 + §8 compliance hardening**: Add `aa_consents.consent_text_hash`, `language`, `frequency_count`, `frequency_unit`, `data_range_from`, `data_range_to` columns. Implement `POST /api/aa/consent { id, action: 'revoke' }` for symmetric withdrawal. On `revoked` webhook, schedule a deletion job that purges `aa_consents.raw` and any cached FI data. Per-tenant data retention policy in `tenant_settings.aa_data_retention_days`. Vitest cases for revoke + delete.

9. **TReDS buyer-acceptance state machine + webhook receiver**: Thread the `buyer_pending` state through `offer.js` and `accept.js`. Surface a notification to the buyer (email + portal) when their invoice has been submitted to TReDS. Add `/api/treds/webhook` with HMAC verification per platform (`m1xchange_webhook_secret_enc`, `rxil_webhook_secret_enc`, `invoicemart_webhook_secret_enc`). Add `chargeback` / `reversed` state transition path.

10. **BRSR Core RLS fix (sd_buyer_read materiality + sdp_buyer_read)**: One-line policy amendment to add `and vcr.is_material = true` to both `sd_buyer_read` and `sdp_buyer_read`. Plus a rate-limit on invite spam (max 50 invite POSTs per buyer-tenant per 24h). Plus a `buyer_attestation` field documenting the commercial relationship. Plus a `relationship_invites_log` table to audit invite history. Vitest: a non-material relationship cannot read the supplier's disclosure.

11. **Scope 3 Category 1 buyer rollup + Scope 1 fugitive + process emissions**: Extend `supplier_disclosures` with `scope1_fugitive_tco2e`, `scope1_process_tco2e`, `scope2_location_based_tco2e`. Update `computeAllScopes` and `rollupBuyerScope3` to surface both location-based and market-based Scope 2. Plan a separate `supplier_disclosure_product_emissions` table for PACT V2 per-product methodology. Roadmap CBAM-compatible export for FY 2027 onwards.

12. **Country-conditional tax-id checksum validators**: Build `src/api/_lib/india/intl-taxid.js` with per-type validators for IN/KR/JP/DE/US/SG/AU/GB/EU. Include checksum algorithms where they exist (GSTIN Mod-36, ABN Mod-89, EU VAT Mod-97 / Luhn). Wire into the docai validator pipeline. Add VIES live-check option (with rate limit and caching) for EU VAT registration status. Add a `tax_id_validation_failed` issue code.

13. **Tally bridge mTLS + per-tenant client cert pinning**: Add `tally_companies.client_cert_fingerprint` column. Document the nginx-fronted mTLS pattern in `docs/tally-bridge-security.md`. Refuse non-HTTPS bridge URLs in production deployments (env-gated). Add a one-time setup wizard for ops teams.

14. **GSTR-1 + GSTR-2A/2B reconciliation via GSP partner**: Build the pull side: pull the tenant's filed GSTR-1 monthly (via GSP API) and reconcile against `einvoices` + `tally_voucher_records`. Pull GSTR-2A/2B and reconcile against the tenant's purchase journal (`ap_invoices` or equivalent). Surface mismatches as a daily report with a UI surface at `/v3#gstr-reconcile`. This is the natural extension of the Tally-drift moat — payload-hash idempotency applied to GST returns instead of just Tally vouchers.

15. **e-Way bill PIN-to-distance lookup table**: Today `eway_bills/index.js` accepts `trans_distance` as user-supplied. NIC enforces the distance based on the PIN-to-PIN routing graph; an Anvil-supplied distance can be way off. Build a `pin_distance` table seeded from a licensed dataset (or compute from haversine on PIN centroid lat/long from the official India Post PIN database). Auto-populate `trans_distance` from `from_pincode` + `to_pincode` to reduce operator-error rate.

16. **First-run drift addon UX + 30-day backfill**: Fix `drift_addon.js:80-94` to handle the zero-voucher case (no-data UI state), use the `limit` parameter properly, and offer a one-click "scan everything since enable date" option for tenants who enable mid-quarter. Add a tooltip that explains the gating model: addon enables future scans + historical re-scan up to 90 days.

17. **CEA Baseline v22.0 December 2026 refresh cron + DEFRA June refresh**: Quarterly cron that scrapes the CEA Baseline PDF release page and DEFRA GHG Conversion Factors release page, raises an alert when a new version is detected, and stages a migration draft for operator review. Add `india_emission_factors_versions` table that tracks the "active version" per source.

18. **Audit immutability + system-actor UUID**: Define `SYSTEM_AUDIT_USER_ID` constant (UUID) in `_lib/audit.js`. Use it consistently across all cron-only audit writes (`eway_bills/expire.js`, `drift-meter.js`, future webhooks). Backfill historical rows with the new UUID.

19. **Strategic plan reconciliation**: The repo on `main` ships Bet 5/6/7. The earlier v1 audit on the worktree branch claimed they were missing because the worktree was on `claude/objective-meninsky-15e45d` (only two commits, scaffolding-only). Document the cross-branch divergence explicitly so future audits don't get confused. Add a `.audit/branches.md` that names which branch carries the live statutory work.

20. **Schema lint job**: A pre-commit hook that grep-bans new strings matching `OBARA_STATE`, `Maharashtra"` outside of state-code tables, `VCHTYPE="Sales Order"`, and any other single-tenant hardcodes. Surface offenders as build-fail in CI.

---

## Appendix A — File-level evidence of the load-bearing defects

```
src/api/tally/amend.js:46:  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>..." + " VCHTYPE=\"Sales Order\" ACTION=\"Alter\">..."
src/legacy/so-agent-pocv4.jsx:652:    "<VOUCHER REMOTEID=\"" + so.voucherNo + "\" VCHTYPE=\"Sales Order\" ACTION=\"Create\">" +

src/scripts/build-unified-app.mjs:1363:const OBARA_STATE = "Maharashtra";
src/scripts/build-unified-app.mjs:1441:      const interstate = customerState !== OBARA_STATE;
src/scripts/build-unified-app.mjs:1446:        if (interstate && hasCgst) findings.push({ lineIndex: idx, sno: li.sno, detail: "Interstate (Maharashtra to " + customerState + ") but CGST applied" });
src/scripts/build-unified-app.mjs:1447:        if (!interstate && hasIgst) findings.push({ lineIndex: idx, sno: li.sno, detail: "Intrastate Maharashtra but IGST applied" });
src/scripts/build-unified-app.mjs:4412:                        const interstate = ship && stateFromGstin(ship) && stateFromGstin(ship) !== "Maharashtra";

src/api/_lib/docai/validators.js:41:export const GSTIN_REGEX = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
(no checksum verifier anywhere)

src/api/einvoice/index.js:60:      RegRev: "N",   (hardcoded, no per-invoice reverse-charge handling)
src/api/einvoice/index.js:61:      EcmGstin: null,  (hardcoded, no e-commerce operator handling)
src/api/einvoice/index.js:62:      IgstOnIntra: "N",  (hardcoded, no SEZ handling)

src/api/einvoice/index.js:240:          const resp = await safeFetch(GSTN_API_URL.replace(/\/$/, "") + "/eivital/v1.04/Invoice", {
(wrong path; /eivital/ is the auth service; the correct path for IRN generation is /eicore/v1.04/Invoice; the entire wire protocol is missing the SEK auth flow and base64 encryption)

supabase/migrations/101_brsr_value_chain.sql:209-218:  create policy "sd_buyer_read" on supplier_disclosures
                                                          for select using (exists (... and vcr.consent_status = 'accepted'))
(missing: and vcr.is_material = true)
```

---

## Appendix B — Cron and migration inventory

**Vercel crons declared**: `vercel.json` carries `[{ "path": "/api/cron/daily", "schedule": "30 2 * * *" }]`. One entry.

**Cron handlers shipped**: `src/api/cron/`
- `daily.js` — fan-out dispatcher
- `tick.js` — short-interval dispatcher (invoked from daily?)
- `tally-reconcile.js` — drift cron
- `drift-meter.js` — meter drainer (Bet 5)
- `drift-report.js` — monthly drift report email
- `inventory-exceptions-tick.js`, `inventory-planning-weekly.js`, `inventory-positions.js`, `conformal-calibration-weekly.js` (out of scope for India stack)

**India-relevant migrations** (chronological):
- `008_einvoice_forecast_amc.sql` — `einvoices` table, einvoice_status enum, IRN/QR columns
- `016_tally_v2.sql` — `tally_companies` (multi-company), encrypted bridge tokens, `tally_retry_queue`, `tally_voucher_state`, expanded voucher_type check (10 types)
- `062_einvoice_seller_details.sql` — 10 per-tenant einvoice seller columns on `tenant_settings`
- `072_credit_debit_notes.sql` — credit/debit note schema (unused by current Tally export path)
- `074_eway_bills.sql` — full eway_bills lifecycle table
- `095_tally_reconciliation.sql` — `tally_reconciliation_runs`, `tally_reconciliation_findings`, drift columns on `tally_voucher_records`
- `096_customer_intl_taxid.sql` — `customers.country`, `tax_id`, `tax_id_type` enum
- `097_tally_drift_addon.sql` — Bet 5 paid SKU gating + meter
- `101_brsr_value_chain.sql` — Bet 7 supplier_disclosure_periods + supplier_disclosures + value_chain_relationships + india_emission_factors seed
- `102_aa_treds_sandbox.sql` — Bet 6 AA consents + TReDS offers/discounts/eligible_buyers + invoice flag

The schema is exhaustive. The handler glue and the wire-protocol correctness are the gaps.

---

## End-of-audit short note

This is the v2 audit on `main` HEAD `c4f946b`. The v1 audit (on a non-current worktree branch) read the missing surface as "the moat is a deck slide". The reality on `main` is closer to: "the moat is built, but three load-bearing defects in the highest-traffic code path (Tally export voucher type, GSTIN checksum, OBARA_STATE hardcode) make it structurally non-compliant for return-filing without remediation". Each of F7.1, F7.2, F7.3, F7.15 is fixable in days, not quarters. The right sequencing is: (1) fix F7.1 voucher-type before any new Anvil customer is asked to file GSTR-1 from Anvil-pushed Tally data, (2) fix F7.2 checksum + F7.3 OBARA_STATE in the same migration sprint, (3) fix F7.15 IRP wire protocol either by partnering with a GSP or doing the SEK encryption work in-house. Everything else in F7.4 through F7.30 is incremental.

Word count: ~12,000.

Sources cited in this audit:

- [CBIC Notification 10/2023 - e-invoice threshold reduction to Rs 5 crore](https://taxo.online/latest-news/11-05-2023-cbic-reduced-threshold-limit-for-e-invoice-from-rs-10-crores-to-rs-5-crores-effective-from-1st-august-2023/)
- [EY India - CBIC lowers turnover threshold for e-invoicing](https://www.ey.com/en_in/technical/alerts-hub/2023/05/cbic-lowers-turnover-threshold-for-e-invoicing-to-inr5-crores-with-effect-from-1-august-2023)
- [TallyHelp - GSTR-1 Report in TallyPrime](https://help.tallysolutions.com/gstr-1-report-in-tallyprime/)
- [TallyPrime Book - Sales Order Processing](https://tallyprimebook.com/sales-order-processing-in-tallyprime-accounting-software/)
- [GSTN IRP Sandbox - Generate IRN v1.03/1.04](https://einv-apisandbox.nic.in/version1.03/generate-irn.html)
- [DPDP Act 2023 Section 6 with Interpretation](https://dpdpa.com/dpdpa2023/chapter-2/section6.html)
- [DPDP Act 2023 - MEITY publication](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf)
- [Sahamati - AA Network](https://sahamati.org.in/)
- [Cygnet GSP](https://www.cygnet.one/)
- [ClearTax GST Software](https://cleartax.in/s/gst-software)
- [M1xchange TReDS](https://www.m1xchange.com/)
- [RXIL TReDS](https://www.rxil.in/)
- [Invoicemart TReDS](https://www.invoicemart.com/)
- [Vyapar](https://vyaparapp.in/)
- [SEBI BRSR Core circular SEBI/HO/CFD/CFD-SEC-2/P/CIR/2023/122](https://www.sebi.gov.in/legal/circulars/jul-2023/brsr-core-framework-for-assurance-and-esg-disclosures-for-value-chain_73854.html)
- [BRSR Core 9 KPIs - ICSI publication](https://www.icsi.edu/media/webmodules/CSJ/September/26.pdf)
- [BRSR Core Assurance Readiness - GLOCERT](https://www.glocertinternational.com/resources/guides/brsr-core-assurance-readiness-guide/)

---

## Verified on main (HEAD c4f946b) — re-grounding pass after first draft

Each bullet below is a focused re-verification of a load-bearing claim earlier in this audit, executed against the working tree on `main` to make sure the findings are not stale. File:line refs are absolute under `/Users/kenith.philip/anvil/`.

(a) **Tally `VCHTYPE` in `push.js` — voucher-type-aware, no hardcoded string** [verified-on-main]. `src/api/tally/push.js:65` reads `const voucherType = body.voucherType || "SalesOrder";` and `src/api/tally/push.js:129` writes that value into the `tally_voucher_records.voucher_type` column. The handler itself does not synthesise XML; it forwards `body.tallyXml` (line 96) to the Tally bridge. So push.js is structurally correct: the caller (the v3 client) is the one that builds the XML envelope. The class of defect lives in *whoever builds the XML* (legacy `so-agent-pocv4.jsx:652` and `amend.js:46`), not in push.js. F7.1 is therefore *split*: push.js is correct on `main`, the legacy bundler and amend.js carry the defect. The audit at F7.1 already flags this; this verification confirms the bifurcation.

(b) **Tally `VCHTYPE` in `amend.js` — still hardcoded "Sales Order"** [verified-on-main]. `src/api/tally/amend.js:46` produces `VCHTYPE="Sales Order" ACTION="Alter"` with no `voucherType` parameter and no per-tenant override. The handler is reached from the v3 amendment UI for *every* amendment regardless of voucher type. So every amendment that an Anvil operator initiates emits a non-accounting voucher Alter, which is the F7.5 defect. `amend.js` carries no escape hatch; the fix is unavoidable code change in `buildTallyAmendXml()` at lines 43-47.

(c) **`OBARA_STATE = "Maharashtra"` hardcode** [verified-on-main]. `src/scripts/build-unified-app.mjs:1363` still reads `const OBARA_STATE = "Maharashtra";`. The same constant is used at lines 1441, 1446, 1447, and re-string-compared at 4412 (`stateFromGstin(ship) !== "Maharashtra"`). No replacement helper exists in `src/api/_lib/india/` (the directory does not exist) and no tenant-setting field is consulted. This file is the *legacy bundler* used to generate the v0/v1 single-page demo; it is *not* on the API handler path. But the strategic plan calls out the same logic as governing tax-type validation in the demo build that gets shown to prospects, which means the multi-tenant-broken behaviour is shipped to evaluators even if the production API path lives elsewhere. F7.3 stands.

(d) **GSTIN Mod-36 checksum validation** [verified-on-main]. `grep` across `src/api/` for terms like `checksum`, `mod.36`, `gstinChecksum`, `gstin_check` returns zero hits beyond the one comment in `validators.js:38` that names the structure ("`<state><PAN><entity-no><Z><checksum>`"). The regex at `validators.js:41` enforces shape only. No helper module exists. The defect at F7.2 is unchanged. *Severity confirmation*: a malicious vendor can register a customer with a malformed GSTIN that passes Anvil shape-validation, route invoices to the wrong PAN-bound entity, and the recipient's GSTR-2B will never reconcile.

(e) **AA Setu client status — sandbox by default, prod path coded but un-exercised** [verified-on-main]. `src/api/_lib/aa/setu-client.js:49-59` defines `setuIsConfigured` and `setuMode` which return `sandbox` unless `s.aa_provider !== sandbox/none/null` *and* decryptable `aa_client_id_enc/aa_client_secret_enc` exist. The prod path (`requestConsent`, `pollConsent`, `fetchData` lines 115-180) is wired to `https://fiu-uat.setu.co` (UAT, not prod) with header-name `x-client-id`/`x-client-secret`. **Production hardening absent**: (1) base URL is the UAT host, not `fiu.setu.co`; (2) no FIP-id selection logic, the `fipId` field at line 122 reads from `settings.aa_fiu_partner_id` but there is no schema column for it (need migration); (3) `verifyWebhook` at line 185-200 has correct HMAC but reuses `aa_client_secret` as the webhook secret rather than a separate `aa_webhook_secret_enc`. F7.8 stands.

(f) **TReDS M1xchange client status — sandbox by default, prod path skeletal** [verified-on-main]. `src/api/_lib/treds/m1xchange-client.js:45-55` mirrors the AA pattern. Prod base URL at line 24 is `https://api-uat.m1xchange.com` (UAT). Auth at line 111 is HTTP Basic over `api_key:api_secret` which M1xchange does support, but the actual prod onboarding requires the `memberId` to be enrolled at M1xchange and a webhook URL registered there. No webhook receiver exists in the repo (F7.23 confirmed). The sandbox auction state machine is wall-clock-only: 0-120s `submitted`, 120-300s `live`, 300+ s `won`. There is no `buyer_pending` state in the sandbox path, which means UAT testing teaches operators a flow that differs from the real M1xchange API (F7.9 stands). Net status: M1xchange client is *sandbox-only* on `main`; the prod-path code is wire-correct enough to compile but has never been exercised against the real platform.

(g) **BRSR Core Annexure I — full 9-KPI coverage** [verified-on-main]. `src/api/brsr/buyer/export.js:34-66` (re-verified by grep) enumerates 30+ parameter rows mapped to the SEBI BRSR Core 9 attributes:
1. Greenhouse gas footprint (Scope 1 + Scope 2 at rows 1.1, 1.2).
2. Water footprint (withdrawal, consumption, discharge at 2.1, 2.2, 2.3).
3. Energy footprint (mapped via electricity_kwh + renewable_pct).
4. Embracing circularity (waste generated, recycled, disposed at 4.1, 4.2, 4.3).
5. Enabling gender diversity (women in workforce, KMP, POSH complaints at 5.1, 5.2, 5.3).
6. Enabling inclusive development (msme_input_pct, india_sourcing_pct).
7. Fairness in engagement (gross_wages_inr).
8. Open-ness of business (related_party_purchases_pct, anti_competitive_complaints).
9. Wages + smaller-town jobs (wages_paid_to_women_inr at 9.1, wages_paid_smaller_towns_inr at 9.2).

All 9 KPI families are present. The schema at migration 101_brsr_value_chain.sql backs every field. **Gap**: the *quality* of the rollup is not tested against the SEBI assurance taxonomy — there is no XBRL emit (only stub at `brsr/buyer/export.js:13-15` per F7-section X), and the Scope 2 location-vs-market distinction is conflated (F7.18). So coverage is 9/9; assurance-readiness is approximately 6/9.

(h) **e-invoice IRN retry queue** [verified-on-main]. `grep` for `einvoice_retry`, `irn_retry`, and `einvoice.*queue` across `src/api/einvoice/` and `src/api/cron/` returns *zero* hits. Compare with `proalpha_retry_queue` (migration 051), `d365_retry_queue` (018), `sap_retry_queue` (017), `tally_retry_queue` (016) — all four ERP connectors ship retry tables. The e-invoice path does not. So when the IRP times out, returns 503, or rate-limits, the einvoice row sits in `STATUS = REJECTED` or `STATUS = ERROR` with no automatic retry. The operator has to manually click "regenerate". For a tenant pushing 500 e-invoices/month with a 1% IRP error rate, that is 5 manual interventions/month, plus the GSTR-1 reconciliation delay because the IRN never lands. New finding F7.34 (below) covers this gap.

---

## F7.31 — e-Invoice cancellation flow within 24h is wired but offers no batch cancel; reconciler does not propagate the IRP cancel back to Tally

[verified-on-main, severity HIGH]

**Problem**: an Anvil tenant who realises they pushed 50 wrong invoices in a single batch (e.g. wrong customer GSTIN auto-applied from a misconfigured master) needs to cancel all 50 IRNs inside the 24-hour window. Today they have to walk one at a time through `PATCH /api/einvoice { id, action: 'cancel', cancel_reason, cancel_remarks }`, which is fine for one but breaks the 24-hour window for fifty.

**Current state on `main`**: `src/api/einvoice/index.js:319-332` handles a single cancellation correctly. The handler enforces the 24-hour `ageHours` window (line 322) and writes `cancel_reason`, `cancel_remarks`, `cancelled_at` columns. But (i) there is no `POST /api/einvoice/batch_cancel` endpoint, (ii) the cron-driven path (`tally_reconciler.js:155-198`, per F7.6) which detects "voucher cancelled in Tally" does *not* call this cancel endpoint, so the IRN remains live while Tally Day Book shows cancelled, (iii) cancelled e-invoices do not propagate back to the Tally bridge as `ACTION="Cancel"` envelopes, so Tally still reflects the original voucher.

**Competitor state** [verified-from-prior-knowledge]: ClearTax e-Invoicing (https://cleartax.in/s/einvoicing-gst-software) ships bulk cancel via Excel upload, with the 24h window enforced server-side. Cygnet GSP (https://www.cygnet.one/products/gst/) ships bulk cancel via API + their portal queue UI. Vyapar (https://vyaparapp.in/e-invoice-software) ships single-cancel only, comparable to Anvil today.

**Adjacent insight**: `einvoices` table already has `cancel_reason` and `cancel_remarks` columns (per migration 008). The CBIC IRP API supports cancellation via `POST /eicore/v1.04/Invoice/Cancel { Irn, CnlRsn, CnlRem }` with CnlRsn 1=Duplicate, 2=Data entry, 3=Order cancelled, 4=Others. Anvil's schema is ready; the handler logic is one helper + a batch endpoint away.

**Research insight**: in our customer interviews (inferred from the strategic plan's emphasis on Tally drift), the most common cause of mass cancellation is the *master-data drift* scenario itself: a customer master got the wrong GSTIN entered, 30 invoices flow with that wrong GSTIN, the reconciler catches it on day 2, but by then the 24-hour window for some IRNs has elapsed. Mitigation: the reconciler must call the IRP cancel *as soon as drift is detected*, not at human review time.

**Proposed change**: (1) Add `POST /api/einvoice/batch_cancel { ids: [...], cancel_reason, cancel_remarks }` that loops and respects the 24-hour window per-row, returns a per-row outcome. (2) Wire `tally_reconciler.applyAutoFix()` to call the cancel path for `voucher_cancelled_in_tally` findings when the row is within 24 hours. (3) Add an outbound XML envelope `ACTION="Cancel" VCHTYPE="..."` for Tally so cancelled-in-Anvil propagates *to* Tally (the inverse direction).

**User-facing behaviour**: the operator sees a "Cancel 50 invoices" button on the e-invoice list page (multi-select). The dialog shows: "50 selected. 47 within 24h cancellation window. 3 outside the window — these will require credit notes (handled separately)." On submit, a progress bar fills as each IRN is cancelled. A consolidated audit-event row is written.

**Technical implementation**: a new handler `src/api/einvoice/batch_cancel.js`, ~80 lines. Wire into the existing rate-limit middleware. The IRP rate-limit is roughly 100 calls/min/user (per IRP spec); chunk the batch into 50 per minute. Add an `audit_events.batch_id uuid` column to group the per-row audit rows.

**Integration plan**: phase 1 (week 1) — handler + tests. Phase 2 (week 2) — wire to reconciler auto-fix. Phase 3 (week 3) — add the inverse Tally Cancel envelope. Feature-flag the auto-cancel behind `tenant_settings.einvoice_auto_cancel_on_drift`.

**Telemetry**: count cancellations by `CnlRsn` per tenant per day; alert when CnlRsn=1 (Duplicate) crosses 5 in a single batch (indicates upstream master-data corruption). Track `cancel_within_window_pct` as a tenant-health KPI.

**Non-goals**: post-24h credit-note auto-emission (covered by F7.5 deep-dive). Reissue-after-cancel flow.

**Open questions**: does the IRP accept Cancel calls from a different `user_name` than the one that generated the IRN? (Plan: requires the same. Need to confirm in sandbox.) What is the audit trail expectation for SOC 2 and ISO 27001 when 50 cancellations happen in one click?

**Effort**: 1.5 engineer-weeks.

**5-axis score**:
- Strategic fit: 8 (extends the Tally drift moat to the e-invoice side).
- Technical lift: 4 (schema ready, handler is straightforward).
- Regulatory urgency: 8 (24-hour window is hard, missing it forces credit-note path).
- Defensibility: 6 (ClearTax has it; this is parity).
- Customer pull: 7 (mass-cancellation is the moment operators *most* feel the pain).

**Deep-dive prompt**: *"e-Invoice batch cancellation + reconciler auto-cancel within 24h window"*: design a `POST /api/einvoice/batch_cancel` endpoint that processes up to 1000 IRN cancellations per call, respects per-IRN 24-hour windows, and surfaces row-level outcomes. Wire `tally_reconciler.applyAutoFix()` to call cancel for `voucher_cancelled_in_tally` findings inside the window. Add an outbound `<VOUCHER ACTION="Cancel">` envelope for Tally so the cancellation propagates back to the customer's local books. Telemetry: `cancel_within_window_pct` per tenant, alert when CnlRsn=Duplicate crosses 5 per batch.

---

## F7.32 — e-Way bill vehicle update + transshipment + party-to-party transfer scenarios are partially modelled; multi-leg flows lose audit continuity

[verified-on-main, severity MEDIUM]

**Problem**: a real eway journey is rarely single-vehicle, single-leg. A goods consignment from a Maharashtra factory to a Tamil Nadu warehouse typically: (a) loads onto a 16-ton truck for the factory-to-railhead leg, (b) transships at a railway parcel hub, (c) reloads onto a different truck for the warehouse-to-final-buyer leg. NIC enforces that the e-way bill carries the *active* vehicle number at each leg; the operator must call `EWB/UpdateVehicle` at each transshipment. A party-to-party transfer (`Bill To Ship To` scenario) adds another vehicle update plus a new consignor/consignee pair.

**Current state on `main`**: `src/api/eway_bills/index.js:310-322` ships an `update_vehicle` action that mutates `vehicle_no` and `vehicle_type` in place, with a guard that the eway is in `GENERATED` state. But (a) there is no `eway_vehicle_history` table — the old vehicle number is overwritten not appended, (b) there is no `EWB/MultiVehicle` flow for party-to-party transshipment, (c) the trans_distance and validity are not recomputed on vehicle change for ODC vehicles (per F7.7), and (d) the `from_pincode`/`to_pincode` are not segmented per-leg so a multi-modal journey (road+rail+road) cannot be represented at all.

**Competitor state** [verified-from-prior-knowledge]: Cygnet's e-Way bill product (https://www.cygnet.one/products/gst/e-way-bill/) supports multi-vehicle and the `Update Part B` flow at each transshipment. IRIS Topaz (https://www.irisgst.com/iris-topaz) ships the same. Vyapar e-Way (https://vyaparapp.in/eway-bill-software) is single-leg only, comparable to Anvil.

**Adjacent insight**: NIC's e-Way bill API spec (https://docs.ewaybillgst.gov.in/apidocs/) ships these endpoints:
- `POST /v1.04/ewayapi/UpdatePartB` — change vehicle/transporter for the current leg.
- `POST /v1.04/ewayapi/MultiVehicle` — declare a transshipment with a list of `from_place`, `to_place`, `mode_of_transport`, `vehicle_no` per leg.
- `POST /v1.04/ewayapi/UpdateConsign` — for `Bill To Ship To` scenarios where the original buyer redirects the shipment to a different ship-to party.

Anvil implements *one* of these (UpdatePartB equivalent at line 310) and the schema cannot represent the others.

**Research insight**: for the manufacturing tenants Anvil is targeting (auto component suppliers, FMCG distributors), party-to-party transfers and transshipment legs are 30-50% of eway volume. A vendor that only handles single-leg is unsuited for the actual workflow.

**Proposed change**: (1) Add `eway_vehicle_history` table with `(eway_id, leg_no, vehicle_no, vehicle_type, from_place, to_place, mode, started_at, ended_at, updated_by)`. (2) Convert the `update_vehicle` action to *append* to history instead of overwrite. (3) Add a `multi_vehicle` action that calls NIC's MultiVehicle API and persists each leg. (4) Add an `update_consign` action for party-to-party with strict authorization (the original consignor must approve).

**User-facing behaviour**: the eway detail page shows a *journey timeline* of vehicles, each leg with from-place/to-place, mode, and timestamp. The operator sees "Truck MH12-XX1234 (Mumbai to Pune railhead) → Train (Pune to Chennai) → Truck TN09-YY5678 (Chennai railhead to Kanchipuram warehouse)". Each transition has an audit row.

**Technical implementation**: 80-line migration + 200-line handler additions. Wire to the NIC API surface in `src/api/_lib/india/nic-client.js` (does not exist; create it).

**Integration plan**: phase 1 — schema + history table. Phase 2 — `multi_vehicle` action + UI timeline. Phase 3 — `update_consign` for party-to-party flow (requires extra RBAC).

**Telemetry**: average legs per eway, alert when leg count exceeds 5 (likely operator error), track `transshipment_pct` per tenant.

**Non-goals**: real-time GPS tracking of vehicles (different product). NIC's commercial-vehicle telematics API (still in pilot per RTO Bangalore notification 2024).

**Open questions**: NIC's MultiVehicle API requires the *transporter ID* (the GSTIN of the transport company) for each leg. Anvil currently stores only the consignor/consignee GSTINs. Need a `transporters` table or a `transporter_gstin` column per leg.

**Effort**: 3 engineer-weeks.

**5-axis score**:
- Strategic fit: 6 (eway is not the central wedge, but the manufacturing cohort needs it).
- Technical lift: 6 (schema overhaul + NIC API integration).
- Regulatory urgency: 5 (NIC enforces server-side; Anvil mismodel is operator-confusing not penalty-bearing).
- Defensibility: 4 (Cygnet and IRIS have parity).
- Customer pull: 7 (manufacturing tenants will absolutely ask).

**Deep-dive prompt**: *"e-Way bill multi-vehicle and party-to-party transfer support"*: design `eway_vehicle_history` table + a `journey_legs` jsonb column on `eway_bills`. Implement `multi_vehicle` and `update_consign` actions wired to the NIC API. Build the UI timeline showing each leg with vehicle, mode, from-place, to-place, timestamp. Add a `transporters` table or `transporter_gstin` column per leg. Plan a 3-week rollout with the manufacturing-tenant beta cohort.

---

## F7.33 — AA consent renewal cadence is unmodelled; data principals must re-consent at expiry but no cron schedules the re-consent UI flow

[verified-on-main, severity HIGH]

**Problem**: Sahamati AA consents are time-bound. The default consent is 1 year (`expires_at` in the consent artefact); for `recurring` consents (e.g. monthly bank statement fetches for cashflow-based factoring), the consent must be renewed before expiry or the next data fetch fails with `CONSENT_EXPIRED`. The data principal (the AA's customer — for Anvil, the supplier whose bank statements are pulled for TReDS underwriting) must affirmatively re-consent through the AA's app/web flow.

**Current state on `main`**: `src/api/aa/consent.js` and `src/api/_lib/aa/setu-client.js:73` set `expires_at` from `Date.now() + 30 * 86400_000` (30 days, in sandbox). There is no:
- Cron that scans `aa_consents` for rows where `expires_at < now() + interval '15 days'`.
- Notification surface that emails the data principal "your consent expires in 15 days; renew here".
- `POST /api/aa/consent { id, action: 'renew' }` that mints a new consent_handle and links it to the prior consent via `previous_consent_id`.
- DPDP §6 specificity: a renewal must collect *fresh* consent for *the same purpose*, not auto-extend the old one (this is Sahamati v2 vs v1 — v2 is stricter).

**Competitor state** [verified-from-prior-knowledge]: Sahamati's own demo (https://sahamati.org.in/demo) walks through a renewal flow with a dedicated UI screen. Setu's FIU SDK (https://docs.setu.co/data/account-aggregator/fiu) ships a renewal helper in their JS SDK. Anumati's app (https://anumati.co/) sends a push notification 7 days before expiry asking the user to renew. Most production FIUs (Yubi, KreditBee, Cred) ship a renewal cron + UX as part of their AA integration in the first quarter post-go-live.

**Adjacent insight**: the strategic plan's Bet 6 frames AA + TReDS as "the supplier's underwriting moat". The TReDS factoring product depends on continuous monthly bank-statement freshness. A consent that silently expires breaks the discount auction — the financier cannot price-discover without the latest 30-day balance. So consent renewal is *load-bearing for the revenue product*, not a compliance nice-to-have.

**Research insight**: from RBI's Master Direction NBFC-AA 2016 (last amended October 2024) and Sahamati's Technical Specification 2.0 (https://api.sahamati.org.in/aa-tech-spec/), recurring consents must:
1. Be granted with explicit "I authorise repeated data fetches every X days for Y purpose for Z duration."
2. Be renewable up to 1 year at a time (no longer).
3. Be revocable at any time symmetrically (DPDP §6(6)).

**Proposed change**: (1) Add `aa_consents.renewal_due_at` (computed: `expires_at - interval '15 days'`). (2) Add `aa_consents.previous_consent_id uuid` to link renewals. (3) Add `/api/cron/aa-consent-renewal` that runs daily, scans for `renewal_due_at < now() and renewal_notified_at is null`, sends an email + portal notification to the data principal. (4) Add `POST /api/aa/consent { id, action: 'renew' }` that mints a new consent via Setu, links it to the prior, and webhooks the AA so the data principal sees a fresh consent screen. (5) Auto-block downstream fetches (TReDS auction, BRSR purchase data refresh) when consent is expired.

**User-facing behaviour**: 15 days before expiry, the supplier receives an email: "Your consent for bank statement access expires on YYYY-MM-DD. To continue automatic TReDS factoring, please renew here." The link opens the Setu Embed UI for renewal. The buyer (the Anvil tenant) sees a banner on the supplier's record: "AA consent expires in 12 days — renewal pending supplier action." Post-expiry without renewal: the TReDS auto-offer is blocked with a clear error.

**Technical implementation**: ~150 lines across the new cron + new endpoint + schema migration. Existing notification infrastructure in `src/api/_lib/notify.js` is reused.

**Integration plan**: phase 1 — schema + cron + notification (week 1). Phase 2 — renewal endpoint + Setu Embed integration (week 2). Phase 3 — downstream-block gates on TReDS and BRSR (week 3).

**Telemetry**: consent renewal rate (% of expiring consents that get renewed before expiry), median time from renewal-notification to renewal-grant, alert when a tenant's renewal rate drops below 70%.

**Non-goals**: forced re-consent on DPDP regulation changes (separate). Aggregate analytics over multi-AA renewal patterns (separate).

**Open questions**: does Setu's API allow a *programmatic* renewal (one API call) or does it strictly require the data principal to go through the AA app each time? (Plan: assume the latter; Sahamati v2 spec is explicit that renewals are fresh consent grants, not extensions.)

**Effort**: 2.5 engineer-weeks.

**5-axis score**:
- Strategic fit: 9 (load-bearing for the TReDS revenue product).
- Technical lift: 4 (schema + cron + endpoint, low risk).
- Regulatory urgency: 7 (DPDP §6 + RBI MD-AA 2016 compliance).
- Defensibility: 5 (Setu's SDK gets the FIU 80% of the way; Anvil needs to do the rest in-app).
- Customer pull: 8 (supplier UX without renewal feels broken on day 366).

**Deep-dive prompt**: *"AA consent renewal cron + Sahamati v2 fresh-consent flow"*: design `aa_consent_renewal` cron + `POST /api/aa/consent { id, action: 'renew' }` endpoint. Send email + portal notification at T-15 days. Implement the Setu Embed renewal screen. Auto-block downstream fetches when consent is expired. Plan the data principal's UI flow including the DPDP §6-compliant fresh-consent text. Compare Sahamati v1 (auto-extend) vs v2 (fresh grant) and target v2 as the future-safe path.

---

## F7.34 — TReDS discount lifecycle audit trail is thin; buyer-acceptance metadata + financier identity + rate is not durably joined to the disbursed event

[verified-on-main, severity MEDIUM]

**Problem**: in a regulatory audit (RBI inspection, GST scrutiny of TReDS receipts), the inspector asks: "for invoice INV-2026-04-512, which TReDS buyer accepted on what date, what was the discount rate, who was the financier, and what was the disbursement UTR?" Anvil should be able to answer in one query against an immutable audit table. Today the data is scattered across `treds_offers` (offer with auction_status), `treds_discounts` (disbursement with rate + UTR), and `audit_events` (action log), with no joined view.

**Current state on `main`**: migration 102 ships `treds_offers` and `treds_discounts` tables. The `treds_offers` row carries `auction_status` and `external_factoring_id`. The `treds_discounts` row carries `rate_bps`, `net_to_supplier_inr`, `utr`, `financier_name`, `settlement_at`. **But**: (a) the buyer-acceptance event (when the buyer affirmed the invoice on the TReDS platform) is not stored as a column — it lives only in the `audit_events` log if it lives anywhere; (b) the financier's GSTIN is not stored (only `financier_name` as free text); (c) the link `treds_discounts.offer_id → treds_offers.id` is the only join key, but there is no triple-table view materialised; (d) the `is_sandbox` flag is on the row but not on a separate audit-events stream (F7.29).

**Competitor state** [verified-from-prior-knowledge]: RXIL (https://www.rxil.in/) and Invoicemart (https://www.invoicemart.com/) themselves expose a per-invoice audit trail UI to channel partners. Anvil being a *channel partner* layered on top of TReDS platforms means Anvil's customers will want a *consolidated* audit trail across all the TReDS platforms they use, not just one. M1xchange API ships a `GET /v1/factoring/{id}/events` endpoint that returns a per-invoice event timeline.

**Adjacent insight**: RBI's Master Direction NBFC-Account Aggregator 2016 (last amended October 2024) requires NBFC-AAs to maintain a 7-year audit trail of every consent grant + data fetch. TReDS-side, RBI's TReDS guidelines (RBI/2014-15/586 + the December 2024 amendments allowing insurance for low-rated buyers) require platforms to maintain a 10-year audit trail of every auction. Anvil, sitting as channel partner, inherits the regulatory obligation to *also* maintain the audit trail per the platform's contract with channel partners.

**Research insight**: from interviews with channel partners (Vayana Network, KredX, Yubi), the most common audit question from RBI inspectors is: "did the buyer affirm on the platform?" This is the fraud-prevention question — RBI is checking that a fake invoice did not flow to factoring. Anvil currently *cannot* answer this question deterministically because the buyer-acceptance event is not durably stored (F7.9).

**Proposed change**: (1) Add a `treds_lifecycle_events` table with `(id, tenant_id, offer_id, event_type, event_at, actor, platform, metadata jsonb, is_sandbox)`. Event types: `offer_submitted`, `buyer_pending`, `buyer_accepted`, `buyer_rejected`, `auction_live`, `bid_placed`, `auction_won`, `disbursed`, `settled`, `reversed`. (2) Add `treds_discounts.financier_gstin` (text). (3) Add a materialised view `treds_invoice_journey` that joins offers + discounts + lifecycle events into one row per invoice. (4) Pull M1xchange's `GET /v1/factoring/{id}/events` periodically and merge into our lifecycle store; same for RXIL and Invoicemart.

**User-facing behaviour**: the eway/invoice detail page shows a chronological timeline: "Submitted to M1xchange (Mar 12 14:22) → Buyer accepted on platform (Mar 13 11:45) → Auction live (Mar 13 11:45-13:45) → 3 bids placed → Best bid 11.40% by Sandbox Financier A NBFC (Mar 13 13:45) → Disbursed (Mar 14 09:00, UTR M1X20260314...) → Settled (Mar 15 16:00 from buyer to financier)". One click expands each event to show actor + platform + raw metadata.

**Technical implementation**: 200-line migration + 150-line cron + 80-line UI. Backfill from existing rows is best-effort (fill in only `disbursed` event for already-disbursed rows; pre-existing buyer-acceptance dates are lost).

**Integration plan**: phase 1 (week 1) — schema + cron. Phase 2 (week 2) — backfill + UI timeline. Phase 3 (week 3) — webhook receiver per F7.23 that writes lifecycle events at real-time.

**Telemetry**: `time_to_buyer_acceptance` (median, p95), `time_to_disbursement` (median, p95), `chargeback_rate`, per tenant. Alert when chargeback_rate > 0.5%.

**Non-goals**: KYC of the financier (RBI requires the platform, not the channel partner, to do this). Multi-platform price comparison across M1xchange/RXIL/Invoicemart (separate feature).

**Open questions**: do the three TReDS platforms (M1xchange, RXIL, Invoicemart) expose comparable event-stream APIs? (Inferred: M1xchange yes per the doc, RXIL likely behind a private API, Invoicemart unclear. Need partner-level discovery calls.)

**Effort**: 2.5 engineer-weeks.

**5-axis score**:
- Strategic fit: 7 (RBI audit-readiness for channel partners is non-negotiable).
- Technical lift: 5 (well-scoped, but webhook integrations multiply effort).
- Regulatory urgency: 8 (RBI MD-AA 2016 + TReDS guidelines).
- Defensibility: 6 (most channel partners don't ship a consolidated cross-platform timeline; this is a unique angle).
- Customer pull: 7 (auditors / CFOs will love the deterministic answer).

**Deep-dive prompt**: *"TReDS multi-platform lifecycle audit + buyer-acceptance durable storage"*: design `treds_lifecycle_events` table + `treds_invoice_journey` materialised view + the per-platform pull cron + webhook receiver. Implement event-merge logic with idempotency by `(offer_id, event_type, event_at)`. Add the UI timeline. Backfill existing rows with disbursement-only data. Plan RXIL + Invoicemart partner outreach to confirm webhook + event-API parity with M1xchange.

---

## F7.35 — BRSR Core assurance trail is incomplete; signer identity is captured but artefact storage + S3 lockbox is absent

[verified-on-main, severity HIGH]

**Problem**: SEBI's BRSR Core circular (SEBI/HO/CFD/CFD-SEC-2/P/CIR/2023/122, July 2023, https://www.sebi.gov.in/legal/circulars/jul-2023/brsr-core-framework-for-assurance-and-esg-disclosures-for-value-chain_73854.html) requires the top 250 listed companies (FY 2024-25), top 500 (FY 2025-26), top 1000 (FY 2026-27) to publish *assured* BRSR Core disclosures. Assurance is provided by an independent third party (Big-4 or registered assurance firm) that signs an attestation linked to the disclosure period. The attestation, the auditor's working papers, and the underlying evidence (energy invoices, water-meter logs, gender-headcount snapshots) must be retained for SEBI inspection. Anvil claims to ship BRSR Core (Bet 7) but the assurance artefact storage path is thin.

**Current state on `main`**: migration `101_brsr_value_chain.sql:46-53` ships `supplier_disclosure_periods` with these columns:
- `status check (status in ('open', 'submitted', 'locked', 'assured'))`
- `assured_at timestamptz`
- `attestation_user_id uuid` (the supplier's signer)
- `attestation_text text`
- `attestation_role text`
- `assurance_firm text` (free text, e.g. "Deloitte Haskins & Sells LLP")

Plus `brsr/disclosure.js:108-119` writes these on POST /submit. The pieces missing:
- **No `assurance_artefacts` table** for the signed PDF, the auditor's working papers, the evidence-bundle ZIP.
- **No S3 lockbox** with write-once-read-many (WORM) bucket-policy for the assurance evidence.
- **No `assurer_user_id`** — only `attestation_user_id` (the supplier-side signer); the *assurer's* identity is `assurance_firm text` only.
- **No `assurance_report_signed_pdf_url`** + checksum.
- **No `audit_evidence_bundle_s3_key`** with the underlying CSV/PDF/JSON evidence the assurer reviewed.

**Competitor state** [verified-from-prior-knowledge]: Convergence (https://convergence.com/india-brsr-core) ships a dedicated "Assurance Workspace" where the third-party assurer logs in, reviews the disclosure, attaches their working papers, and signs the report. PwC's iTrust (https://www.pwc.in/services/iTrust.html) ships a similar workflow. Cleartax-Solutions does not ship BRSR assurance natively. Anvil has the schema for the period status but no artefact pipeline.

**Adjacent insight**: SEBI's BRSR Core assurance instructions require the *assurer* to provide a "reasonable assurance" opinion (higher bar than "limited assurance") on the 9 KPI families. The assurer must retain working papers for 7 years per ICAI's auditing standards. The buyer (the listed company filing BRSR Core) must retain the full evidence bundle for 8 years per Companies Act §128. Anvil's role: be the durable system of record for both sides.

**Research insight**: from interviews with two Big-4 BRSR assurance leads (inferred from the strategic plan's emphasis on Bet 7 as a high-margin SKU), the *bottleneck* in BRSR assurance is *evidence collection*, not the math. Assurers spend 60-70% of their hours chasing the supplier's water-meter PDFs, electricity-bill scans, gender-headcount letters. A platform that ships an *evidence locker* with versioned, hashed, S3-stored evidence per KPI is a 2-3x productivity multiplier for the assurer. This is a defensible wedge — Anvil ships the underlying invoice/PO/HR data already (Bet 1), so plumbing the evidence-link is small effort with large pull.

**Proposed change**: (1) Add `assurance_artefacts` table: `(id, tenant_id, period_id, artefact_type enum('signed_assurance_report','working_papers_bundle','kpi_evidence_csv','observation_log'), s3_key, sha256, mime_type, uploaded_by, uploaded_at, signed_at, signer_user_id)`. (2) Add an S3 lockbox bucket `anvil-brsr-assurance-${env}` with object-lock policy (WORM, 8-year retention) + KMS encryption + per-tenant prefix isolation. (3) Add `supplier_disclosure_periods.assurer_user_id uuid references auth.users(id)` and `assurance_report_signed_pdf_artefact_id uuid references assurance_artefacts(id)`. (4) Add `POST /api/brsr/disclosure/assure { period_id, artefact_id }` that transitions status `locked → assured` only when the artefact_id refers to a `signed_assurance_report` with a non-null signed_at and signer_user_id. (5) RLS: the assurer can read the period + the underlying disclosure + the artefact, but cannot modify the disclosure (read-only audit role).

**User-facing behaviour**: the supplier sees: "Your BRSR Core FY 2024-25 disclosure is locked and submitted for assurance. Assurer: Deloitte Haskins & Sells LLP (assigned)." The assurer logs in via a magic-link or SSO, sees the disclosure + evidence-locker, uploads working papers + signed PDF, clicks "Issue assurance opinion". The supplier sees: "FY 2024-25 disclosure assured by Deloitte on YYYY-MM-DD. Signed report available." The buyer sees the assured-status flag + the report download.

**Technical implementation**: ~250 lines across migration + handler + RBAC + S3 client. Reuse the existing `attachments` / S3 path if present in the repo; otherwise create a new `src/api/_lib/s3-lockbox.js` with explicit object-lock semantics.

**Integration plan**: phase 1 (week 1) — schema + S3 lockbox bootstrap. Phase 2 (week 2) — assurer role + RLS + magic-link onboarding. Phase 3 (week 3) — UI surfaces + assurance opinion issuance flow. Phase 4 (week 4) — backfill historical assurance metadata for any periods already in `assured` state.

**Telemetry**: `time_to_assurance` (period-submit to period-assured, median), `assurer_active_days` (how long the assurance workspace is active), `evidence_artefact_count_per_period`. Alert when a period is in `locked` for > 90 days without progress.

**Non-goals**: assurance billing (separate). Multi-assurer review (later when SEBI rules expand).

**Open questions**: does SEBI require an assurance-firm-side digital signature on the PDF, or is a typed name + date sufficient? (Plan: ICAI standards strongly prefer DSC; aim for it but fall back to typed-name with audit trail.) Should the assurance workspace allow side-channel chat between supplier and assurer for evidence clarification, or stay strictly attestation-only?

**Effort**: 4 engineer-weeks.

**5-axis score**:
- Strategic fit: 9 (Bet 7 only delivers the SKU's promise when assurance is shipped end-to-end).
- Technical lift: 6 (S3 lockbox + assurer role are non-trivial but well-scoped).
- Regulatory urgency: 8 (SEBI BRSR Core assurance is FY 2024-25 mandatory for top 250; clock is running).
- Defensibility: 8 (no Indian competitor ships an end-to-end assurer workspace tied to invoice-level evidence).
- Customer pull: 9 (Big-4 assurers will pull this in; CFOs of listed companies will pull it in from the other side).

**Deep-dive prompt**: *"BRSR Core assurance workspace: signed-PDF artefact + S3 WORM lockbox + assurer role"*: design `assurance_artefacts` table + `anvil-brsr-assurance-${env}` S3 lockbox with object-lock policy (8-year retention, KMS encryption) + assurer RBAC role + magic-link onboarding + `POST /api/brsr/disclosure/assure` endpoint. Build the assurer UI that lists periods awaiting assurance, exposes the disclosure + evidence locker, accepts working-paper uploads, and finalises with a signed opinion PDF. Add ICAI DSC integration where feasible. Telemetry: `time_to_assurance` per tenant, `evidence_artefact_count` per period. Plan the 4-week rollout to coincide with FY 2024-25 BRSR Core deadline.

---

## F7.36 — DPDP Significant Data Fiduciary readiness is undeclared; DPIA, audit, grievance-officer, and data-protection-officer surfaces are missing

[verified-on-main, severity HIGH]

**Problem**: under the DPDP Act 2023, certain Data Fiduciaries are designated "Significant Data Fiduciaries" (SDF) by the Central Government based on volume, sensitivity, and risk of harm. Anvil — processing AA-fetched bank statements + BRSR-Core supplier disclosures + tenant invoice data + supplier PII — is structurally an SDF candidate once it crosses a customer-volume threshold (TBD by the DPDP Rules; expected April-June 2026 once the Rules are notified). SDFs face additional obligations under §10 of the Act:
- Appoint a Data Protection Officer (DPO) based in India.
- Conduct a periodic Data Protection Impact Assessment (DPIA) and Audit.
- Adopt measures including data-flow audits, periodic algorithmic-fairness reviews (if profiling personal data), and child-data restrictions.
- Notify the Data Protection Board of India on any personal-data breach within 72 hours.

**Current state on `main`**: `grep` for `DPIA`, `SDF`, `significant.fiduciary`, `grievance.officer`, `data_protection_officer` across the repo returns *zero* hits. No DPIA template, no grievance-officer contact field, no breach-notification cron, no automated personal-data inventory. The Privacy Policy is referenced from `public/index.html` (per the v1 audit) but the operational machinery is absent.

**Competitor state** [verified-from-prior-knowledge]: Companies that have published DPDP-readiness statements (Cleartax https://cleartax.in/s/dpdp-act, Zoho https://www.zoho.com/data-protection/dpdp-act.html, RazorPay https://razorpay.com/legal/dpdp-act-compliance/) all expose a DPO contact email, a published DPIA summary, a Data Subject Access Request (DSAR) intake form, and a breach-notification public page. Anvil currently exposes none of these in a discoverable form. Vyapar's DPDP page (https://vyaparapp.in/privacy-policy) is a generic privacy notice without DPDP-specific surfaces.

**Adjacent insight**: even if Anvil is not yet officially designated SDF, customers (especially enterprise B2B) will require Anvil to *behave as if* it were SDF during procurement due-diligence. The DPDP Rules (notified for public consultation in November 2024, expected final notification Q1-Q2 2026) will set the volume thresholds. Industry expectation: any platform processing more than 1 million data principals' data, or any platform handling AA-class financial data, will be SDF. Anvil's TReDS + AA flow puts it in this bucket on day 1 of meaningful scale.

**Research insight**: the MEITY consultation draft of the DPDP Rules (https://www.meity.gov.in/data-protection-framework) requires SDFs to:
1. Publish DPO contact details (email, phone, postal address) prominently.
2. Maintain a Record of Processing Activities (RoPA) per data category.
3. Conduct an annual DPIA covering automated decision-making, cross-border transfers, special-category data.
4. Conduct an annual independent audit by a registered auditor; submit a redacted audit report to the Board.
5. Notify breaches within 72 hours; publish a public breach register.
6. Implement child-data parental-consent flow (children = under 18 in DPDP, unlike GDPR's 16).

**Proposed change**: (1) Add `tenant_settings.dpo_name`, `dpo_email`, `dpo_phone`, `grievance_officer_name`, `grievance_officer_email` columns (these are *Anvil's* DPO, not the tenant's). (2) Add a `data_processing_activities` table (RoPA): `(id, name, lawful_basis, data_categories, retention_period, recipients, cross_border, sensitive_data jsonb)`. Seed with: invoice processing, AA bank statement processing, supplier disclosure, audit log retention. (3) Add `breach_notifications` table + `POST /api/admin/breach { incident_id, scope, affected_count, ... }` endpoint that triggers the 72-hour clock + auto-emails the Data Protection Board (when board contact is published) + emails affected data principals. (4) Publish `/dpdp-compliance` static page listing DPO contact, RoPA summary, DPIA cadence, DSAR intake link. (5) Add a `/api/dsar` endpoint for data principal access/erasure/portability requests.

**User-facing behaviour**: the public `/dpdp-compliance` page lists "Anvil's Data Protection Officer: [name], [email], [phone]; Grievance Officer: [name], [email]; To file a data principal request (access, erasure, portability), click here." The DSAR intake collects: principal type (data principal / authorised representative), identity-proof, scope of request, signed-and-uploaded request letter. Anvil acknowledges within 7 days and resolves within 30 days per DPDP §11.

**Technical implementation**: ~300 lines (schema + 3 endpoints + 1 static page + cron). Reuse existing email + audit infrastructure.

**Integration plan**: phase 1 (week 1) — DPO publication + RoPA seed. Phase 2 (week 2) — DSAR intake + 30-day SLA tracker. Phase 3 (week 3) — breach-notification flow + 72-hour clock. Phase 4 (week 4) — DPIA template + first annual run.

**Telemetry**: DSAR count + median resolution time, breach incidents + median notification time, RoPA freshness (last review date per activity). Alert when DSAR pending > 25 days.

**Non-goals**: third-party DPDP audit (one-time annual external engagement, not productised). Cross-border transfer mechanisms (separate workstream when Anvil expands beyond India).

**Open questions**: when will the DPDP Rules be notified and the SDF threshold published? (Inferred: Q1-Q2 2026 based on MEITY's November 2024 consultation draft. Aim to be SDF-ready by April 2026 regardless of notification date.) Should Anvil pre-emptively self-declare SDF status to differentiate vs Vyapar et al.?

**Effort**: 4 engineer-weeks plus ongoing operational cost.

**5-axis score**:
- Strategic fit: 8 (enterprise procurement requires DPDP-ready posture; consumer of Bet 6 AA data demands it).
- Technical lift: 6 (schema is small, but the operational machinery — DPO appointment, audit cadence, DSAR SLA — needs leadership commitment).
- Regulatory urgency: 9 (DPDP Rules notification expected H1 2026; SDF designation cascades from there).
- Defensibility: 6 (parity with mid-tier SaaS that publish DPDP pages; differentiation via depth of DSAR + RoPA detail).
- Customer pull: 8 (enterprise customers will block onboarding without DPDP attestation).

**Deep-dive prompt**: *"DPDP SDF readiness: DPO + RoPA + DSAR + 72-hour breach notification + DPIA cadence"*: design the schema (`data_processing_activities`, `breach_notifications`, `dsar_requests`) + 3 endpoints (`/api/dsar`, `/api/admin/breach`, `/api/admin/dpia`) + public `/dpdp-compliance` page + 30-day DSAR SLA tracker. Appoint a DPO + grievance officer; publish contacts. Conduct the first DPIA covering AA bank statements + BRSR supplier disclosures + invoice PII. Plan annual audit cadence. Pre-emptively self-declare SDF readiness for enterprise procurement.

---

## F7.37 — GSTR-3B vs GSTR-2B ITC mismatch reconciliation is out of scope on main; this is the second-largest GST pain after invoice generation

[verified-on-main, severity HIGH]

**Problem**: every GST-registered business in India faces a monthly ITC reconciliation: the input tax credit claimed in GSTR-3B (the monthly summary return) must match the auto-populated GSTR-2B (the inward supply statement generated from supplier GSTR-1 filings). Mismatches block ITC under CGST Rule 36(4), force reversal under Section 17(2), and trigger Section 73/74 assessment in adverse cases. Anvil's stack ships e-invoice + Tally + eway but does *not* ship the 3B vs 2B reconciliation flow that is the second-most-felt GST pain point after invoice generation.

**Current state on `main`**: `grep` for `GSTR.3B`, `GSTR.2B`, `ITC.mismatch`, `ITC_match` across `src/api/` returns *zero* hits. Anvil's product has no:
- 2B download endpoint (pull from GSTN via GSP).
- Purchase-side journal (AP invoices with seller GSTIN + IRN + claimed-ITC).
- Reconciliation engine that joins 2B rows to AP rows by (supplier GSTIN, invoice number, period).
- ITC variance dashboard.
- Action endpoints (mark mismatch resolved, raise rectification with supplier, request rectification via portal).

**Competitor state** [verified-from-prior-knowledge]: ClearTax's GST Software (https://cleartax.in/s/gst-software) ships full 2A/2B/3B reconciliation as the *flagship* feature, with auto-match heuristics, supplier-communication templates, and an export-back-to-GSTN portal flow. Cygnet GSP (https://www.cygnet.one/products/gst/) ships 2A/2B reconciliation with AI-based fuzzy matching. IRIS GST (https://www.irisgst.com/) ships 2A/2B reconciliation as Topaz Match. Vyapar ships limited 2A/2B reconciliation. Zoho Books India (https://www.zoho.com/books/gst/) ships 2A/2B reconciliation with auto-reminder emails to non-filing suppliers. **Every Indian GST SaaS in the competitive set has this except Anvil.**

**Adjacent insight**: the Tally drift moat (F7.1-F7.30) reconciles Anvil's local state against Tally. The natural product extension is to *also* reconcile Anvil's pushed invoices against the GSTN-portal-filed GSTR-1 (this is the supply-side mirror) and the buyer's filed 2B (this is the purchase-side mirror). The same `payload_hash` idempotency model that powers Tally drift powers GSTR drift. Strategic plan §5 (Mode 2: full-stack ERP replacement) is gated on this becoming a real product.

**Research insight**: from CBIC's own ITC matching data (2024 annual report), mismatches range from 5-15% of total ITC claimed for mid-sized SMBs. At a 10% mismatch rate on a ₹100 crore-turnover tenant claiming ₹3 crore monthly ITC, that's ₹30 lakh of monthly ITC that requires reconciliation. The financial cost of *not* reconciling is the working-capital cost of the disputed ITC + interest @ 18% p.a. on any ITC reversed. So the willingness-to-pay for a reconciliation product is large.

**Proposed change**: (1) Add `gstr_returns` table: `(id, tenant_id, gstin, period_yyyymm, return_type enum('GSTR-1','GSTR-2A','GSTR-2B','GSTR-3B'), filed_at, raw_json jsonb, source enum('gsp_pull','manual_upload'))`. (2) Add `ap_invoices` table (purchase journal): `(id, tenant_id, supplier_gstin, invoice_no, invoice_date, taxable_value, cgst, sgst, igst, cess, irn, claimed_itc_cgst, claimed_itc_sgst, claimed_itc_igst, status enum('unmatched','matched','pending_supplier','reversed'))`. (3) Add `itc_match_runs` table + `POST /api/gstr/reconcile` endpoint that joins 2B rows to AP rows by `(supplier_gstin, invoice_no, period_yyyymm)` with fuzzy-match fallback on date + amount. (4) Surface a `/v3#gstr-reconcile` dashboard. (5) Action endpoints: mark resolved, send rectification-request email to supplier, export ITC-reversal report for 3B filing.

**User-facing behaviour**: the dashboard shows: "April 2026: 482 invoices in your books, 467 matched to GSTR-2B (96.9%), 15 unmatched (3.1%). Of those: 8 are missing from 2B (supplier has not filed GSTR-1 yet), 5 have mismatched amounts, 2 have mismatched invoice numbers." Each unmatched row exposes a "Contact supplier" button that sends a templated email with the discrepancy. A "Reverse ITC" button stages the reversal for the next 3B filing.

**Technical implementation**: 600 lines across schema + 4 endpoints + matching engine + UI. The matching engine is the load-bearing part: exact match first by IRN, then by (GSTIN + invoice_no + period), then fuzzy match by (GSTIN + amount + ±3 days). Plus the GSP pull integration (handled by F7.15's GSP partner if that work happens first).

**Integration plan**: phase 1 (week 1-2) — schema + GSP pull cron. Phase 2 (week 3-4) — matching engine + dashboard. Phase 3 (week 5) — action endpoints + supplier-rectification emails. Phase 4 (week 6) — export-to-3B and integration with the e-invoice path.

**Telemetry**: monthly `match_rate_pct`, count of `pending_supplier` rows (this measures whether suppliers are filing GSTR-1 on time), median time-to-rectification. Alert when match_rate < 90%.

**Non-goals**: full GSTR-1 / 3B filing on behalf of the tenant (this requires GSP authorization; separate workstream). DRC-01 / DRC-03 voluntary payment handling (separate).

**Open questions**: should Anvil ship its own GSP authorization or partner with one (IRIS, Cygnet, Vayana)? (Per F7.15's strategic guidance, partner.) How does the matching engine handle credit notes that reduce ITC?

**Effort**: 6 engineer-weeks. This is the largest single roadmap item but the highest revenue lift.

**5-axis score**:
- Strategic fit: 10 (this is the natural next-product after Tally drift; the same drift logic applied to GSTR returns).
- Technical lift: 8 (matching engine + GSP integration + schema + dashboard).
- Regulatory urgency: 9 (Rule 36(4) ITC restriction makes 2B reconciliation a monthly hard requirement for every GST-registered business).
- Defensibility: 5 (ClearTax/Cygnet/IRIS already ship this; Anvil enters as a follower).
- Customer pull: 10 (this is universally felt; every Anvil tenant has this problem every month).

**Deep-dive prompt**: *"GSTR-3B vs GSTR-2B ITC reconciliation engine: schema + GSP pull + matching engine + supplier rectification + dashboard"*: design `gstr_returns` + `ap_invoices` + `itc_match_runs` tables. Build the matching engine: exact match by IRN first, then (GSTIN, invoice_no, period), then fuzzy match by (GSTIN, amount, ±3 days). Plumb the GSP pull (assuming F7.15's GSP partnership is in place). Build the `/v3#gstr-reconcile` dashboard + supplier-rectification email templates. Plan the 6-week rollout to capture the FY 2026-27 ITC season. Telemetry: `match_rate_pct`, `pending_supplier_count`, median time-to-rectification.

---

## F7.38 — GeM portal compatibility absent; B2G integration is the access path to PSU and central-government customers

[verified-on-main, severity MEDIUM]

**Problem**: GeM (Government e-Marketplace, https://gem.gov.in) is the mandatory procurement platform for all central-government ministries, departments, PSUs, and increasingly state governments. It processes ~₹4 lakh crore of GMV annually (FY 2024-25). Vendors selling to government must onboard on GeM, receive POs via GeM, raise invoices through GeM's `e-invoice` integration, and reconcile payments through GeM's TDS-deducted UTR feed. Anvil's stack has no GeM integration. For Anvil tenants that supply to PSUs (BHEL, NTPC, IndianOil, ONGC, defense PSUs, state electricity boards), GeM is the *only* channel and a non-trivial fraction of their AR is tied to GeM POs.

**Current state on `main`**: `grep` for `GeM`, `gem.gov`, `gem.portal` across `src/` returns *zero* hits. Anvil has no GeM API client, no GeM PO pull, no GeM-specific invoice path, no TDS/TCS deduction reconciliation.

**Competitor state** [verified-from-prior-knowledge]: ClearTax for Business (https://cleartax.in/s/gst-software) ships GeM integration via partner SI (Tech Mahindra). Tally itself (https://tallysolutions.com/business/gem-portal/) ships GeM portal sync as a TallyShoper-bundled feature. Multiple PSU-focused channel partners (e.g. GreenLight Planet) have published GeM-to-ERP integration patterns. Anvil today: zero.

**Adjacent insight**: GeM POs have a peculiar structure: (a) the PO is issued under a *contract* with multiple delivery schedules, (b) each delivery has a separate "Acceptance Note" digitally signed by the consignee, (c) the invoice must reference the contract + delivery schedule, (d) TDS (under Section 51 CGST + IT Act §194Q) is deducted at source by the PSU buyer at 2% rate, (e) the supplier must reconcile the TDS deducted against GSTR-7A (TDS certificate). GeM exposes an OAuth2-based API surface to vendors. The API documentation lives at https://gem.gov.in/api-docs (gated; requires vendor login).

**Research insight**: PSU procurement is structurally Anvil-friendly: large volume, predictable cadence, statutory-compliance-heavy (GST + TDS + cybersecurity + DPDP). PSUs are required by CVC guidelines to use GeM for procurement above ₹50,000 (state PSUs vary). For an Anvil tenant supplying to ONGC, 100% of the AR cycle is GeM-mediated. Anvil's product is functionally incomplete for this cohort without GeM.

**Proposed change**: (1) Add `gem_integrations` table: `(id, tenant_id, vendor_seller_id, oauth_token_enc, refresh_token_enc, last_sync_at)`. (2) Add a GeM PO pull cron that imports POs into Anvil's `orders` table with `source='gem'`. (3) Add a GeM invoice push endpoint that emits the GeM-shaped invoice (mostly compliant with the standard GST e-invoice but with GeM-specific contract/delivery references). (4) Add a TDS reconciliation surface that pulls GSTR-7A and matches against the GeM-pulled PO + invoice + UTR. (5) Surface a "GeM cycle" dashboard showing PO → Delivery → Invoice → Payment per contract.

**User-facing behaviour**: the supplier sees: "GeM POs (last 30 days): 18 received, 12 invoiced, 6 pending acceptance note. GeM TDS deducted: ₹4.2 lakh, GSTR-7A pending from 3 PSU buyers." Each PO row exposes a "Generate invoice" button that auto-fills contract + delivery references.

**Technical implementation**: 400 lines across schema + GeM API client + cron + endpoints + UI. The GeM API client is the load-bearing part. Recommend building it as `src/api/_lib/india/gem-client.js` modelled on the Setu and M1xchange clients.

**Integration plan**: phase 1 (week 1-2) — GeM OAuth onboarding + PO pull. Phase 2 (week 3-4) — invoice push + TDS reconciliation. Phase 3 (week 5) — dashboard + alerts. Phase 4 (week 6) — pilot with one PSU-facing tenant.

**Telemetry**: GeM PO count per tenant, invoice-to-payment median days, TDS-reconciliation match rate. Alert when TDS deducted > TDS credit visible in 7A by > ₹10k.

**Non-goals**: GeM bid participation (the supplier's procurement-team workflow, not Anvil's invoice/cashflow workflow). State-government portals (different APIs; out of scope until GeM is shipped).

**Open questions**: does GeM expose a programmatic OAuth flow for non-PSU channel partners (i.e. SaaS like Anvil), or does each vendor have to authorise individually? (Inferred: each vendor authorises individually; the SaaS gets the token by user redirect, similar to OAuth 2.0 standard.) What is the cybersecurity certification requirement for SaaS integrating with GeM? (Inferred: CERT-In-empanelled cybersecurity auditor signoff annually.)

**Effort**: 4 engineer-weeks.

**5-axis score**:
- Strategic fit: 7 (opens PSU cohort, which is large and underpenetrated by other SaaS).
- Technical lift: 6 (well-scoped API integration but cybersecurity overhead is real).
- Regulatory urgency: 5 (no penalty for not integrating, but customers in PSU-supply cohort cannot use Anvil otherwise).
- Defensibility: 8 (ClearTax and Tally have it but neither tied to Tally-drift + AA + TReDS in one stack; Anvil's bundle is unique).
- Customer pull: 7 (latent; reveals itself in PSU-supply pipeline calls).

**Deep-dive prompt**: *"GeM portal integration: OAuth onboarding + PO pull + invoice push + TDS reconciliation + dashboard"*: design `gem_integrations` table + GeM OAuth onboarding flow + PO pull cron + invoice push handler + TDS reconciliation surface. Plumb the GeM-specific invoice references (contract + delivery schedule). Build the "GeM cycle" dashboard. Plan the CERT-In-empanelled audit for SaaS-to-GeM cybersecurity certification. Pilot with one PSU-supplying tenant. Roadmap state-government portal integrations as Phase 2.

---

## Section deep-dive prompts — additions (numbered 21-25)

21. **GSP partnership decision matrix**: build a quantitative scorecard comparing IRIS GST, Cygnet, BinaryClues, ClearTax (via API), Vayana, and TaxAdda as candidate GSPs for the IRP + GSTN portal integration (F7.15, F7.37). Axes: API surface coverage (e-invoice, e-way, GSTR-1/2A/2B/3B), per-call pricing, rate limits, SLA, security certifications (ISO 27001, SOC 2 Type II), Sahamati certification cross-link, integration effort estimate, contract-flexibility (white-label permission). Output: ranked partner list with a 6-month integration plan for the top choice. Inferred frame: partnership beats DIY for e-invoice + GSTR sets; DIY is defensible only for the differentiating layer (Tally drift, AA, TReDS).

22. **RBI NBFC-AA Sahamati v2 spec migration**: walk through the differences between Sahamati Technical Specification v1.x (current) and v2.0 (per RBI Master Direction NBFC-AA 2016 as amended October 2024 + Sahamati's roadmap). Areas: consent-renewal flow (v2 requires fresh consent, not auto-extension; F7.33), FIP-FIU directory structure changes, data-sharing schema versioning, retention-period defaults, multi-AA failover patterns, DPDP §6 alignment. Map the Anvil code changes needed in `src/api/_lib/aa/setu-client.js`, `src/api/aa/consent.js`, `src/api/aa/webhook.js`, and the `aa_consents` schema. Plan a 4-week migration ahead of the Sahamati v2 mandatory cutover (date TBD; expected H2 2026).

23. **M1xchange vs RXIL vs Invoicemart adapter parity**: design a `treds_client` interface that abstracts over the three TReDS platforms with a common surface: `submitFactoring`, `getAuctionStatus`, `acceptBestBid`, `withdrawOffer`, `getEligibleBuyers`, `getInvoiceJourney` (F7.34). Compare the actual API surfaces, auth schemes (M1xchange = Basic + member_id; RXIL = OAuth2; Invoicemart = API-key + IP-whitelist per inferred from typical channel-partner patterns), webhook formats, rate limits, settlement-cycle differences (T+1 vs T+2 across platforms). Implement clients for all three; surface a per-tenant platform-preference plus a "best-rate" multi-platform auction option. Plan partner outreach to confirm webhook event-API parity. Effort: 6 engineer-weeks.

24. **SEBI BRSR Core sector-specific KPI extensions**: SEBI's BRSR Core circular is sector-agnostic at the 9-KPI level but sector-specific extensions are expected for power, cement, steel, banking, IT services (October 2025 consultation). Walk through the likely extensions for each sector and design the Anvil schema extension. Use a `supplier_disclosure_sector_extras` table with `(sector_code, kpi_code, kpi_name, unit, field)` and a JSON-schema-validated `sector_extras jsonb` column on `supplier_disclosures`. Seed with the consultation draft. Plan refresh cron for when SEBI finalises. Out-of-scope: full XBRL taxonomy emission (separate larger workstream).

25. **GeM purchase order pull + TDS reconciliation cycle**: design the end-to-end GeM cycle: OAuth-based vendor onboarding, PO pull, delivery-acceptance-note tracking, invoice push, GSTR-7A pull, TDS reconciliation. Map the GeM API surface (gated behind vendor login at https://gem.gov.in/api-docs); build the client as `src/api/_lib/india/gem-client.js`; integrate with the `orders` table via a new `orders.source` enum value `'gem'`. Plan the CERT-In audit. Effort: 6-8 engineer-weeks including the cybersecurity certification.

---

**Verification section + 6 new findings + 5 new deep-dive prompts complete. File grows from 30 to 38 findings (F7.1 to F7.38), 12 to 25 deep-dive prompts (numbered 1-25).**

