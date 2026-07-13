# GST coverage — roadmap (PARKED backlog)

Status: **Parked.** The shared resolver (`src/api/_lib/gst.js`) + the no-GST-PO
fix shipped (rate resolution + item-master default + place-of-supply + split).
This doc tracks the remaining GST situations to cover. Findings below are from
a verified multi-agent audit (file:line accurate as of 2026-07).

## Where GST is computed today
- **Authoritative split:** `src/api/_lib/tally-build-voucher.js` (`placeOfSupplyKind` + `computeLineTax`, now delegating to `_lib/gst.js`). Consumed by the Tally push + the SO voucher PDF.
- **Rate resolution:** `_lib/gst.js resolveGstRate`, applied in `_lib/item-mapper.js` (line → exempt → item-master default → unresolved/flag).
- **Display/aggregation only:** `src/v3-app/lib/line-totals.ts` (sums components, does not decide the split).
- **Consolidated tax only (no split):** invoices (`_lib/invoicing.js`), quotes (`quotes/_lib/quote-build.js`), credit_notes.
- **GSTN payload (reads never-populated split fields):** `src/api/einvoice/index.js`.
- **NO GST in the pricing engine** (`pricing.ts/js`) — by design; layered on later.

## Coverage matrix
| Situation | Status | Gap detail |
|---|---|---|
| Intra-state CGST+SGST | 🟢 | ok end-to-end |
| Inter-state IGST | 🟢 | ok; also the safe default when a state is unknown |
| No GST on PO | 🟢 (now) | fixed: item-mapper applies the item-master rate; `gst_rate_source=null` flags the still-unresolved case |
| UTGST (union territories) | 🟡 | `gst.js splitTax` supports it, but the Tally XML ledger routing + e-invoice still emit CGST+SGST for intra-UT supplies. Wire UTGST ledgers. |
| Cess | 🟡 | computed for the voucher/PDF; **dropped from the e-invoice** ItemList (no `CesAmt`). Add it. |
| Exports / zero-rated (LUT) | 🔴 | e-invoice hardcodes `SupTyp:"B2B"`; need EXPWP/EXPWOP + shipping-bill/LUT fields |
| SEZ supply | 🔴 | no SEZ concept; need SEZWP/SEZWOP + an SEZ flag on the customer |
| Reverse charge (RCM) | 🔴 | hardcoded `RegRev:"N"`; need a reverse-charge flag |
| Composition-scheme buyer | 🔴 | no bill-of-supply path |
| Exempt / nil-rated | 🔴 | `item_master.taxability_type` (EXEMPT/NIL_RATED/NON_GST) is stored + propagated but **no tax code enforces it** (resolveGstRate now honors it for the rate, but downstream labelling/e-invoice don't) |
| Unregistered / foreign buyer | 🟡 | computes plausibly; e-invoice still labels B2B, GSTIN defaults `''` not `URP`; no B2C branch |
| Multiple rates in one order | 🟡 | per-line math correct; Tally ledger aggregation collapses mixed rates into one "dominant"-rate ledger |
| Rate/HSN validation | 🟡 | GSTIN checksum robust; HSN is format-only (no existence / HSN↔rate consistency); rate-slab membership is warn-only |

## Load-bearing defects to fix (highest impact first)
1. **e-invoice split is empty:** `einvoice/index.js` reads `so.igstTotal/cgstTotal/sgstTotal` + `li.igstAmt/...` that **no upstream code writes** → all zeros. Populate from `_lib/gst.js` at order/e-invoice build.
2. **e-invoice hardcodes** `SupTyp:"B2B"`, `RegRev:"N"`, `IgstOnIntra:"N"` → export/SEZ/RCM/unregistered all serialize as domestic B2B. Derive from customer/order flags.
3. **`line-totals.ts` Path 3** can silently set `tax = lineTotal − taxable` for a no-GST line → a fabricated tax-inclusive total. Guard it.
4. **UTGST ledger routing** in the Tally XML + e-invoice.
5. **Cess in the e-invoice** ItemList.
6. **taxability_type enforcement** end-to-end (label exempt/nil on voucher + e-invoice).

## Phasing (each = shippable PR)
- **P1 (done):** `_lib/gst.js` resolver + item-mapper rate application + Tally split delegation.
- **P2:** invoice + e-invoice consume `_lib/gst.js` (real CGST/SGST/IGST split, cess, UTGST); fix the hardcoded SupTyp/RegRev; guard line-totals Path 3.
- **P3:** special regimes — export/SEZ/RCM/composition + exempt/nil enforcement + customer-level flags (new columns) to drive them.
- **P4:** mixed-rate Tally ledgers per rate; HSN↔rate consistency + new-customer GST validation surfacing.

Related: `docs/CUSTOMER_MATCH_GST_CHECKS.md`, `src/api/_lib/gst.js`, `src/api/_lib/tally-build-voucher.js`, `src/api/einvoice/index.js`.
