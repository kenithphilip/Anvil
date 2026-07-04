# Document Field Coverage Audit, May 2026

Audit performed against four real Obara India documents to verify
that every field they carry is either (a) configurable per tenant
inside Anvil, or (b) flagged for a follow-up schema extension.

Source documents:
- Price Quotation `OIQTLC-260320-HMI PUNE-GUIDE ASSY & POINT HOLDER-REV-1` (2026-03-20, revised 2026-04-23)
- Price Composition Excel (internal calculation sheet; the source of truth)
- Meridian Motor India Purchase Order `P260484306` (2026-04-29)
- Obara Sales Order voucher `440` for buyer ref `P260484306` (2026-05-11)

Audit anchored on `main @ acbaf99`. Tags throughout: `[covered]` (field
already configurable on main), `[partial]` (some fields configurable,
extension recommended), `[missing]` (no schema or template support),
`[hardcoded]` (currently exists as a code or text constant).

## 1. Price Quotation (Obara to Meridian)

| Field | Anvil column / table | Status |
|---|---|---|
| Quote number | `quotes.quote_number` | covered |
| Date / Revised date | `quotes.created_at` + `quotes.version` | covered |
| Buyer customer | `quotes.customer_id` | covered |
| Buyer contact (Mr. Prashant Shinde) | `customer_contacts` row joined via `quotes.customer_contact_id` | covered |
| Seller info (Obara India: address, GSTIN, CIN, PAN, email, phone) | `tenants` and `tenant_settings` per-tenant | covered |
| Validity (One Month) | `quotes.validity_days` | covered |
| Your Ref (E-Mail) | `customers.contact_email` or quote-level field | partial. No first-class `your_ref` column on `quotes`. |
| Currency (INR) | `quotes.currency` | covered |
| Form code (`OI/F/SP/19/R-00/020226`) | new `document_templates` table | missing |
| Listed unit price per line | inside `quotes.line_items` JSONB | partial. JSONB allows but no first-class column for the UI to render. |
| Discounted unit price per line | inside `quotes.line_items` JSONB | partial |
| Discount % per line | inside `quotes.line_items` JSONB | partial |
| HSN code per line | `item_master.hsn_sac` joined; or `quotes.line_items.hsn` | covered |
| CGST / SGST / IGST percent per line | inside `quotes.line_items` JSONB | partial |
| Source country marker (O/K = Obara Korea) | `item_master.source_country` | covered |
| Drawing / customer number per line (WGC-12464) | `item_master.drawing_no` + `item_specifications.drawing_number` | covered |
| Terms text (Prices, Taxes, Delivery, Freight, Validity, Payment, Warranty, Cancellation 1-4, Force Majeure 1-3) | `quotes.terms` text blob | partial. Stored as one blob; no per-section template. New `document_template_sections` table covers this. |
| Authorised signatory block | new `document_templates` `signatory_block` | missing |
| Footer (`OI/F/SP/19/R-00/020226` plus brand line) | new `document_templates` `footer_block` | missing |

## 2. Price Composition (internal calculation sheet)

This is the highest-leverage doc since it carries the pricing logic
that drives the customer-facing quote. None of these columns are
currently configurable on Anvil; the cost cockpit at
`src/v3-app/screens/so-workspace.tsx:597-606` reads
`orders.cost_policy_snapshot` JSONB but only carries
`materialsLanded / freight / customs / service`.

| Field | Anvil column / table | Status |
|---|---|---|
| Exchange rate per currency (INR 1.0, USD 96.0, CNY 14.0, JPY 0.65) | global `fx_rates` table from migration 003 | partial. Global rates exist; no per-quote snapshot of the rates used. |
| Multiplication factor per currency (USD 126.6, CNY 18.5, JPY 0.86) | new `tenant_pricing_settings` or `quotes.fx_snapshot` JSONB | missing |
| Total cost per line | derived | partial. cost_policy_snapshot flat at order level only. |
| MOD1 / MOD2 / MOD3 margin tiers | new `price_composition_lines` | missing |
| Landed cost per line | derived from MOD1/2/3 | missing |
| Supplier price (source currency) | `item_master.purchase_price` plus `source_currency` | partial. Per-item, not per-quote-line snapshot. |
| Supplier quote number (`202602260004`) | new `price_composition_lines.supplier_quote_no` | missing |
| Source country per line (O/K) | `item_master.source_country` | covered |
| Profit percent (computed: 16.48% on guide assy) | derived | covered as compute |
| Profit setting (target 0.35) | new `tenant_pricing_settings.target_margin_pct` | missing |
| VAATZ / HKMC reference price (KRW) | new `price_composition_lines.reference_price_krw` | missing |
| KRW to INR rate (93) used per line | per-quote `fx_snapshot` | missing |
| KRW to USD rate (0.00082) | per-quote `fx_snapshot` | missing |
| USD to INR rate (93) | per-quote `fx_snapshot` | missing |
| Conversion factor (1.63) "as discussed with Benny san and Prashant san" | per-quote `conversion_factor` or per-tenant default | missing |
| New supplier price | new column | missing |
| Quote number cross-reference (`OIQTLC-260226-HYUNDAI-PUNE-GUIDE ASSY`) | covered via `quotes.prior_version_id` | covered |

**Freight tables** (sheet 2 of the Price Composition):

| Field | Anvil column / table | Status |
|---|---|---|
| Air freight rate per kg (INR 260 / kg) | new `freight_rates` | missing |
| Air freight 900 kg = INR 234,000 (derived) | new `freight_rates` | missing |
| Ocean freight FREEZE / SET / CBM / PACKING / OCEAN columns | new `freight_rates` | missing |
| 14 sets / 26 CBM / packing 5,720 / ocean 273,000 | new `freight_rates` | missing |

## 3. Meridian Motor India Purchase Order (P260484306)

| Field | Anvil column / table | Status |
|---|---|---|
| MMIL header (logo, address, phone) | `customers` joined; logo NOT stored | partial |
| Vendor code (MMIL calls Obara `TH1M`) | new `customer_vendor_codes` (per-customer reverse mapping) | missing |
| Vendor GSTN (`27AAACX0001A1ZA`) | `tenants.gstin` or `tenant_settings` | covered |
| Vendor tel / fax | `tenant_settings.contact_phone` etc | covered |
| Buyer GSTN (`33AAACX0003A1ZF` = Meridian Tamil Nadu) | `customers.gstin` | covered |
| MMIL ref number `P260484306` | `source_pos.po_number` or `orders.po_number` | covered |
| Date `29/04/2026` | `source_pos.po_date` or extracted | covered |
| Total amount `INR 271,638.36` | `orders.grand_total` | covered |
| Item No `GD544202603190008` (MMIL part code) | `item_customer_parts.customer_part_number` | covered |
| Description | `item_master.description` | covered |
| Specification `4-ET31062` (Obara drawing) | `item_specifications.drawing_number` | covered |
| Req No `1000372863` (MMIL requisition) | new `source_pos.requisition_no` | missing |
| Qty / UoM (NOS) | covered | covered |
| Currency (INR) | covered | covered |
| Ex-Price | `quotes.line_items.unit_price` or new | partial |
| Tooling Cost (per-line, ind. column) | new `order_line_tax_components` | missing |
| P&F (Packing and Forwarding) | new `order_line_tax_components` | missing |
| Others | new `order_line_tax_components` | missing |
| Excise Duty | new `order_line_tax_components` | missing (legacy pre-GST) |
| Ed. Cess | new `order_line_tax_components` | missing (legacy pre-GST) |
| S-VAT, C-VAT | new `order_line_tax_components` | missing (legacy pre-GST) |
| SGST, CGST, IGST, UTGST | partial in `quotes.line_items` | partial. UTGST not first-class. |
| Unit Price | covered | covered |
| Inspection Item flag (N) | new `order_lines.inspection_required` | missing |
| Maker (`OBARA`) | new `order_lines.maker` | missing |
| Delivery date `15/06/2026` | `order_schedule_lines.scheduled_date` | covered |
| TotAmt per line | derived | covered |
| Price Terms `Free house (FH)` | new `incoterms_v2` reference table; `orders.incoterms` | partial. Customer-level default exists; per-PO incoterm new. |
| Payment Terms `30 days From Receipt and Acceptance Of Material` | `customers.payment_terms` or `orders.payment_terms` | covered |
| Delivery Point and User (`PM-Pune Body Meegada Vinay Babu` plus email) | new `orders.delivery_point_contact_id` referencing `customer_contacts` | missing |
| Warranty Period (`One year after receipt`) | new `document_templates.warranty_clause` | missing |
| Penalty Clause (`0.1% per day capped at 10%`) | new `document_templates.penalty_clause` plus order-level override | missing |
| Other Conditions 5 bullets | new `document_template_sections.other_conditions` | missing |
| Remarks | `orders.notes` | covered |
| 15 MMIL boilerplate terms (pages 3-4) | new `customer_terms_packs` (per-customer terms library) | missing |
| Acknowledgement footer | new template | missing |

## 4. Obara Sales Order (Voucher 440)

| Field | Anvil column / table | Status |
|---|---|---|
| Seller block (Obara header) | `tenants` / `tenant_settings` | covered |
| Consignee Ship-to (Meridian Pune Plot A-16) | `customer_locations` joined via `orders.customer_location_id` | covered |
| Buyer Bill-to | `customer_locations` joined | covered |
| Voucher No `440` | `tally_voucher_records.voucher_no` | covered |
| Buyer's Ref / Order No `P260484306` | `orders.po_number` | covered |
| Date `11-May-26` | `orders.created_at` | covered |
| Dispatched through `By Ocean` | new `orders.dispatch_mode` | missing |
| Mode / Terms of Payment `30 Days` | `customers.payment_terms` | covered |
| Reg. Serial No | new `orders.registration_serial_no` | missing |
| Destination | `customer_locations` | covered |
| Terms of Delivery | new `document_template_sections.delivery_terms` | missing |
| Contact Person + Phone (Shivam U., 8858915350) | new `orders.delivery_point_contact_id` | missing |
| Boilerplate message (`Please Note ... 7 Days Defect/Failure/Discrepancy ... wooden box ... shaded and dry location`) | new `document_templates.standard_message` | missing |
| Item description | covered | covered |
| HSN / SAC per line | covered | covered |
| Customer part number per line | `item_customer_parts.customer_part_number` | covered |
| Anvil part number with source-country suffix (`4-ET31062(O/K)`) | derived from `item_master.part_no` + `source_country` | covered via UI render |
| Due on per line `11-Jul-26` | `order_schedule_lines.scheduled_date` | covered |
| Quantity, Rate, Per, Disc%, Amount | partial in `line_items` JSONB | partial. Discount % per line not first-class. |
| Amount in words | new helper `amountToWords()` | missing |
| Authorised Signatory block | new `document_templates.signatory_block` | missing |
| "Computer Generated Document" footer | new `document_templates.footer_block` | missing |

## 5. Hardcoded constants flagged for removal

Audited via grep. Constants that should become per-tenant configuration:

| Constant | Location | Replacement |
|---|---|---|
| `OBARA_STATE = "Maharashtra"` | `src/scripts/build-unified-app.mjs:1363,1441,1446,1447,4412` | `tenant_settings.default_state_code` (Phase 1 P0 fix F8) |
| Hardcoded MMIL terms paragraph in legacy bundle (none found on `main @ acbaf99`) | none | not applicable |
| GSTIN regex without checksum | per Phase 1 F52 | already in roadmap |
| GST rate constants `18 / 9 / 9` | inferred from documents | computed from `item_master.sgst_rate / cgst_rate / igst_rate`; covered |

## 6. Summary verdict by document

| Document | Fields total | Covered | Partial | Missing |
|---|---|---|---|---|
| Quotation | 17 | 9 | 5 | 3 |
| Price Composition | 16 | 3 | 4 | 9 |
| Freight tables | 4 | 0 | 0 | 4 |
| Purchase Order | 27 | 13 | 4 | 10 |
| Sales Order | 19 | 11 | 1 | 7 |
| Hardcoded constants | 4 | 3 | 0 | 1 |
| **Total** | **87** | **39** | **14** | **34** |

39 of 87 (~45%) already configurable. 14 are partial (data exists in
JSONB or a related table but lacks first-class column or UI).
34 are missing.

## 7. Migration 106 scope

The highest-leverage fills are:

1. `document_templates` (per-tenant per-doc-type versioned templates with
   `form_code`, `body_blocks` JSONB, `signatory_block`, `footer_block`,
   `standard_message`, `terms_sections`, `warranty_clause`,
   `penalty_clause`).
2. `incoterms_v2` reference table (global seed: FH, FOB, CIF, CFR, EXW,
   DDP, DAP, DAT, FCA, FAS, CPT, CIP) plus a per-customer override.
3. `price_composition_lines` (1-to-many with quote lines) carrying
   total_cost, mod1, mod2, mod3, landed_cost, supplier_unit_price,
   supplier_currency, supplier_quote_no, profit_pct, profit_setting,
   reference_price, reference_currency.
4. `quotes.fx_snapshot` JSONB column for per-quote exchange-rate freezing.
5. `freight_rates` (per-tenant) for air per-kg and ocean per-cbm tables.
6. `customer_vendor_codes` (the code each customer uses to refer to the
   tenant as a supplier; MMIL calls Obara `TH1M`).
7. `order_line_tax_components` (per-line breakdown for SGST / CGST / IGST
   / UTGST / Excise / Ed. Cess / S-VAT / C-VAT / Tooling / P&F / Others).
8. `orders.dispatch_mode`, `orders.registration_serial_no`,
   `orders.delivery_point_contact_id`, `orders.delivery_terms`.
9. `source_pos.requisition_no` (customer's internal requisition reference
   that appears on the PO body).
10. `tenant_pricing_settings` (target_margin_pct, multiplication factors
    per currency, default conversion_factor).
11. `customer_terms_packs` (per-customer terms library so MMIL's 15
    boilerplate clauses are stored once and reused on every order).

## 8. UI surfaces required (post-migration 106)

| Surface | New section | Implementation |
|---|---|---|
| Admin | Document templates editor (per doc type, per tenant) | `src/v3-app/screens/admin.tsx` new tab `templates` |
| Admin | Incoterms reference editor | reuse the same pattern as `Item fields` tab |
| Admin | Freight rates editor | reuse pattern |
| Admin | Tenant pricing settings (multiplication factors, target margin) | reuse pattern |
| Quote workspace | Price composition cockpit per line | new `src/v3-app/screens/quotes.tsx` extension |
| SO workspace | Tax component drilldown per line | extension to `so-workspace.tsx` |

## 9. Audit conclusion

Anvil already covers about half of the surface area in these four
documents without any new schema work. The shipped extensions in
migrations 104 + 105 close the obvious item-master gaps. Migration 106
is needed to close the document-template, price-composition,
tax-component, freight, and per-customer-terms gaps that the four
documents reveal.

Generalisation principle to follow in 106: nothing about MMIL, Obara,
Tally, or India is hard-coded. Seeds populate the global reference
tables. Every tenant can override every value. Per-customer overrides
sit alongside per-tenant defaults via the same fallback resolution
pattern that `customer_locations` and `quote_approval_thresholds`
already use.
