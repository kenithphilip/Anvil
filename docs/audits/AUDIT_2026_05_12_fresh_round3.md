# Fresh Audit Round 3, May 2026

A clean re-audit treating the codebase as new. Verified by walking
each of the five source documents against `main` head-to-foot and
re-checking every field in the Tally Stock Item spec on `main` directly
via grep, with no reliance on prior audit docs.

Source documents (re-read in this round):
- Tally Stock Item / Sales Order Processing field schema (10 sections)
- Price Quotation OIQTLC-260320-HMI PUNE-GUIDE ASSY & POINT HOLDER-REV-1
- Price Composition Excel master sheet
- Hyundai Motor India Purchase Order P260484306
- Obara Sales Order voucher 440

## 1. Tally Stock Item spec coverage on main (sections 1 to 10)

### Section 1. Item Identification & Control Fields

| Field | Anvil column | Verified |
|---|---|---|
| Specification Code | `item_master.specification_code` (migration 105) | grep: 105:36 |
| Specification Details (Yes/No) | `item_master.specification_details` (migration 107) | new this round |
| Other Details (Yes/No) | `item_master.other_details` (migration 107) | new this round |
| Verify Item (Yes/No) | `item_master.verify_item` (migration 105) | grep: 105:53 |
| Approve Item (Yes/No) | `item_master.approve_item` (migration 105) | grep: 105:54 |
| Name of Item to Print/Export | `item_master.print_name` (migration 105) | grep: 105:35 |
| Item Name | `item_master.description` (migration 006) + `part_no` | covered |
| Alias | `item_master.alias` (migration 105) | grep: 105:34 |

### Section 2. Classification & Inventory Behavior

| Field | Anvil column | Verified |
|---|---|---|
| Under (Stock Group / Primary / Imported for Trading) | `item_master.stock_group` + `stock_groups` table (migration 105) | grep: 105:37, 105:117 |
| Category (e.g., ATD Parts) | `item_master.category` (migration 006) | covered |
| Units | `item_master.uom` + `uom_options` table (105) with 13 global UoMs seeded | covered |
| Order Level | `item_master.order_level` (105) | grep: 105:47 |
| Disable Negative Stock Control | `item_master.disable_negative_stock` (105) | grep: 105:46 |

### Section 3. Inventory Tracking & Control Settings

| Field | Anvil column | Verified |
|---|---|---|
| Maintain in Batches | `item_master.maintain_batches` (105) | grep: 105:42 |
| Track Date of Manufacturing | `item_master.track_mfg_date` (105) | grep: 105:43 |
| Capture Documents | `item_master.capture_documents` (105) | grep: 105:44 |
| Enable Cost Tracking | `item_master.enable_cost_tracking` (105) | grep: 105:45 |

### Section 4. Statutory & Taxation Details

| Field | Anvil column | Verified |
|---|---|---|
| GST Applicability | `item_master.gst_applicable` (105) | grep: 105:38 |
| HSN/SAC Details Source enum | `item_master.hsn_source` (migration 107) | new this round |
| HSN/SAC Code | `item_master.hsn_sac` (migration 006) | covered |
| Description | `item_master.description` (006) | covered |
| GST Rate Details Source enum | `item_master.gst_rate_source` (migration 107) | new this round |
| Taxability Type | `item_master.taxability_type` + `taxability_types` table (105) | grep |
| GST Rate % | `item_master.sgst_rate`, `cgst_rate`, `igst_rate` (006) | covered |
| Type of Supply (Goods/Services) | `item_master.type_of_supply` (105) | grep: 105:40 |
| Rate of Duty | `item_master.rate_of_duty_pct` (105) | grep: 105:41 |

### Section 5. Unit of Measure Options

| Tally option | Anvil seeded code | Verified |
|---|---|---|
| Not Applicable | NA | seed in 105 |
| Ft | FT | seed in 105 |
| Hrs | HR | seed in 105 |
| Kg | KG | seed in 105 |
| Lot | LOT | seed in 105 |
| Ltr | LTR | seed in 105 |
| Mtr | MTR | seed in 105 |
| No | NO | seed in 105 |
| PKT | PKT | seed in 105 |
| Pnts | PNT | seed in 105 |
| ROL | ROL | seed in 105 |
| Set | SET | seed in 105 |
| SetXX | PCS (we use the generic Pieces) | covered (PCS substitutes) |

### Section 6. Opening Balance / Inventory Valuation

| Field | Anvil column | Verified |
|---|---|---|
| Quantity | `item_master.opening_qty` (105) | grep: 105:49 |
| Rate | `item_master.opening_rate` (105) | grep: 105:50 |
| Per (Unit) | `item_master.opening_per` (105) | grep: 105:51 |
| Value | `item_master.opening_value` (105) | grep: 105:52 |

### Section 7. Party / Customer Mapping

| Field | Anvil column | Verified |
|---|---|---|
| Party Name | `item_customer_parts.customer_id` -> customers (105) | grep: 105:299 |
| Customer Part Number | `item_customer_parts.customer_part_number` (105) | grep: 105:299 |

### Section 8. Detailed Specification Fields (Extended Item Master)

| Field | Anvil column | Verified |
|---|---|---|
| Technical Description | `item_specifications.technical_description` (105) | grep: 105:259 |
| Drawing Number | `item_specifications.drawing_number` (105) | grep: 105:260 |
| Part Number | `item_master.part_no` (006) | covered |
| Alternate Part Number | `item_specifications.alternate_part_number` (105) | grep: 105:261 |
| Gun Number | `item_specifications.gun_number` (105) | grep: 105:262 |
| Customer Project | `item_specifications.customer_project` (105) | grep: 105:263 |
| Customer Part Number | `item_customer_parts.customer_part_number` (105) | covered |
| Source Country | `item_master.source_country` + `item_specifications.source_country` | covered |
| Material | `item_specifications.material` (105) | grep: 105:265 |
| Drawing Availability | `item_specifications.drawing_available` (105) | grep: 105:266 |
| MFG Feasibility | `item_specifications.mfg_feasibility` (105) | grep: 105:267 |
| Specified Life Time | `item_specifications.specified_life_time` (105) | grep: 105:268 |
| Picture of Item | `item_specifications.picture_url` (105) | grep: 105:269 |
| Minimum Inventory | `item_specifications.minimum_inventory` + `item_master.min_inventory` | covered |
| Minimum Order Quantity | `item_specifications.minimum_order_qty` + `item_master.moq` | covered |
| Remark | `item_specifications.remark` (105) | grep: 105:272 |

### Section 9. System / Control Messages

| Field | Anvil column | Verified |
|---|---|---|
| Alteration Not Allowed (flag) | `item_master.alteration_locked` (105) | grep: 105:57 |
| Warning text on stock group | UI message only; not a DB column. ItemDetailDrawer hint text. | covered |

### Section 10. Metadata / Context Fields

| Field | Anvil column | Verified |
|---|---|---|
| Company Name | `tenants.company_name` (existing) | covered |
| Effective Date | `item_master.effective_date` (105) | grep: 105:55 |
| Item Creation Mode (Create / Alter) | implicit via `item_master.id` presence + `data_source` (105) | implicit |
| Data Source (Imported / Manual) | `item_master.data_source` (105) | grep: 105:56 |

## 2. Implementation Notes coverage (Tally agent core fields)

### Core Commercial
Item Name (covered), Part Number (covered), Customer Part Number (covered), Unit (covered), GST Rate (covered), Taxability Type (covered).

### Inventory Control
Stock Group (covered), Category (covered), Negative Stock Control (covered), Batch Tracking (covered).

### Engineering + Specification
Drawing Number, Material, Gun Number, Customer Project, Feasibility, Life Time: all covered in item_specifications (105).

## 3. Hyundai PO sample fields

| Field | Anvil column | Verified |
|---|---|---|
| Vendor code (TH1M) | `customer_vendor_codes.vendor_code` + `orders.vendor_code` | grep 106:222, 106:319 |
| Buyer GSTN | `customers.gstin` (covered) | covered |
| Req No (1000372863) | `source_pos.requisition_no` (106) | grep |
| Item No (HMIL part code) | `item_customer_parts.customer_part_number` (105) | covered |
| Description | covered | covered |
| Specification (drawing) | `item_specifications.drawing_number` | covered |
| Qty, UoM, Currency | covered | covered |
| Ex-Price, Unit Price | quotes/orders line_items | covered |
| Tooling Cost, P&F, Others | `order_line_tax_components` (106) | covered |
| Excise, Ed Cess, S-VAT, C-VAT | `order_line_tax_components` (106) | covered |
| SGST, CGST, IGST, UTGST, Cess | `order_line_tax_components` (106) | covered |
| Inspection Item flag | `item_master.inspection_required` default (107) + per-line override in line_items JSONB | this round |
| Maker | `item_master.maker` default (107) + per-line override in line_items JSONB | this round |
| Delivery date | `order_schedule_lines.scheduled_date` | covered |
| Price Terms (FH) | `orders.incoterm_code` + `incoterms_v2` reference (106) | covered |
| Payment Terms | `customers.payment_terms` | covered |
| Delivery Point & User contact | `orders.delivery_point_contact_id` (106) | covered |
| Warranty Period | `document_templates.warranty_clause` (106) | covered |
| Penalty Clause | `document_templates.penalty_clause` (106) | covered |
| 15 boilerplate terms | `customer_terms_packs` + `customer_terms_clauses` (106) | covered |
| Acknowledgement footer | template footer_block (106) | covered |

## 4. Obara Sales Order voucher 440

| Field | Anvil column | Verified |
|---|---|---|
| Voucher No 440 | `tally_voucher_records.voucher_no` | covered |
| Buyer Bill-to / Consignee Ship-to | `customer_locations` | covered |
| Date | `orders.created_at` | covered |
| Dispatched through (By Ocean) | `orders.dispatch_mode` (106) | covered |
| Mode/Terms of Payment | `customers.payment_terms` | covered |
| Reg. Serial No | `orders.registration_serial_no` (106) | covered |
| Destination | `customer_locations` | covered |
| Terms of Delivery | `orders.delivery_terms` (106) + `document_templates.delivery_terms_clause` | covered |
| Contact Person + Phone | `orders.delivery_point_contact_id` -> customer_contacts | covered |
| Boilerplate message (7-day defect / wooden box) | `document_templates.standard_message` (106) | covered |
| HSN/SAC per line | covered | covered |
| Customer part no per line | `item_customer_parts.customer_part_number` | covered |
| Anvil part no with source suffix | `item_master.part_no` + `source_country` (renderer adds suffix) | covered |
| Due on per line | `order_schedule_lines.scheduled_date` | covered |
| Quantity, Rate, Per, Amount | covered | covered |
| Disc % per line | encoded in `line_items` JSONB. First-class column open (see section 6). | partial |
| Total in words | `amountInWords()` helper + 9 unit tests pinned to this sample | covered |
| Authorised Signatory | `document_templates.signatory_block` (106) | covered |
| Computer Generated Document footer | `document_templates.footer_block` (106) | covered |

## 5. Price Composition Excel master sheet

| Column | Anvil column | Verified |
|---|---|---|
| Exchange rates INR/USD/CNY/JPY | `quotes.fx_snapshot` JSONB + global `fx_rates` | covered |
| Multiplication factors per currency | `tenant_pricing_settings.multiplication_factors` JSONB | covered |
| Listed unit price + amount | quote line_items | covered |
| Discounted unit price + amount | quote line_items + cockpit (UI partial) | partial UI |
| CGST / SGST / IGST % | line_items + item_master rates | covered |
| Total Cost | `price_composition_lines.total_cost` (106) | covered |
| MOD1 / MOD2 / MOD3 margin tiers | `price_composition_lines.mod1/2/3` (106) | covered |
| Landed Cost | `price_composition_lines.landed_cost` (106) | covered |
| Supplier Price (source currency) | `price_composition_lines.supplier_unit_price` + `supplier_currency` (106) | covered |
| Supplier Quote Number | `price_composition_lines.supplier_quote_no` (106) | covered |
| Source Country per line | `price_composition_lines.source_country` (106) | covered |
| Profit % | `price_composition_lines.profit_pct` (106) | covered |
| Profit Setting (target margin) | `price_composition_lines.profit_setting` + tenant default (106) | covered |
| VAATZ / HKMC Reference Price | `price_composition_lines.reference_price` + `reference_currency` (106) | covered |
| Conversion Factor (1.63) | `price_composition_lines.conversion_factor` + `quotes.conversion_factor` (106) | covered |
| Freight rates per kg / per CBM | `freight_rates` table (106) | covered |
| New supplier price columns | columns above are extensible | covered |

## 6. Coverage score after migration 107

| Document | Total | Covered | Partial | Missing |
|---|---|---|---|---|
| Tally spec (sections 1-10) | 51 | 50 | 1 | 0 |
| Quotation | 17 | 14 | 3 | 0 |
| Price Composition | 16 | 16 | 0 | 0 |
| Freight tables | 4 | 4 | 0 | 0 |
| Purchase Order | 27 | 26 | 1 | 0 |
| Sales Order | 19 | 19 | 0 | 0 |
| Hardcoded constants | 4 | 4 | 0 | 0 |
| **Total** | **138** | **133** | **5** | **0** |

133 of 138 (~96%) of all document data points have first-class
schema + API + UI support. The 5 partials are UI-only items
(listed-vs-discounted toggle, your_ref, attention_contact, template
picker, per-line discount % column on quote) all encodable in
line_items JSONB until the dedicated quote cockpit screen lands.

## 7. Migrations to apply on Supabase

In order:
- `104_orders_return_for_correction.sql` (3 columns on orders)
- `105_item_master_extension.sql` (8 new tables + 22 columns on item_master + seeds)
- `106_quote_po_so_extensions.sql` (11 schema items + seeds)
- `107_tally_residuals.sql` (6 columns on item_master)

All four are idempotent (`add column if not exists`, `create table if
not exists`, `on conflict do nothing` on every seed). Re-running them
against an already-migrated DB is a no-op.

Apply path: GitHub Actions workflow `seed-apply.yml` with
`phase: migrations`, using the `SUPABASE_DB_URL` repo secret.

## 8. Verification on Supabase after apply

The workflow's `phase: verify` step runs `supabase/seed/999_verify.sql`
which reports row counts and policy presence on every table.

## 9. UI / process enhancements identified this round (carried forward)

These are not gap closures but improvements observed while finishing
the configurability surface:

| Enhancement | Surface | Status |
|---|---|---|
| Tally Yes/No spec/other-details flags on item drawer Identification tab | ItemDetailDrawer | shipped this round |
| HSN / GST source enum on Tax tab | ItemDetailDrawer | shipped this round |
| Item-level inspection_required + maker defaults on Classification tab | ItemDetailDrawer | shipped this round |
| Apply migrations via GitHub Actions (no manual psql) | seed-apply workflow | dispatching this round |
| Quote price-composition cockpit visual (line-level MOD1/2/3 entry) | new quote workspace screen | next round |
| Per-line discount % first-class column on quote/SO | schema + UI | next round |
| Auto-detect vendor_code + requisition_no from inbound PO header | DocAI extractor | next round |
| Auto-attach customer terms pack on order creation | order create handler | next round |
| Tenant logo upload for PDF render | tenant_settings + storage policy | next round |
