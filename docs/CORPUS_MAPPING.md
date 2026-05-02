# Corpus to Schema Mapping

This document records the provenance of every schema entity that came from
the Obara India source corpus (99 documents in the original `Obara.zip`).
Use this when judging whether a column is real-world or speculative.

## Real customer documents

### MG Motor Blanket PO (11 release POs)

| Doc field | Schema column |
| --- | --- |
| Vendor GSTIN 27AAACO8335K1Z5 | `customers.gstin` (Obara as supplier) |
| Customer GSTIN 24AAKCM8110E1ZR (Halol) | `customer_locations.gstin` |
| Customer GSTIN 06AAKCM8110E1ZP (Haryana) | `customer_locations.gstin` (second row) |
| Customer PAN AAKCM8110E | `customers.pan` |
| Vendor code 200261 | not modeled, lives in `orders.preflight_payload` |
| PO number 51XXXXXXX | `orders.po_number` |
| Incoterm "FOR MGI Halol Plant" | `orders.result.salesOrder.incoterms` |
| Footnote "*As per Schedule Lines, to be sent separately" | `order_schedule_lines` table |
| 11 POs against one parent quote | `contracts` (BLANKET_PO) + `orders.contract_id` |

### SRTX

| Doc field | Schema column |
| --- | --- |
| PO number 2C15968L-IND | `orders.po_number` |
| EG SHEET (engineering sheet) | `documents` table with classification |

## Sample workflow corpus (4 modes)

### Mode 1: SPARES (1-SPARES Enquiry sample)

Quote prefix `OIQTLC-240207-ABC-MOTORS-SPARES`, INR pricing, road logistics,
30 percent target margin. Maps to `order_mode = 'SPARES'`.

### Mode 2: SPARES_ASSEMBLY (gun modification)

Quote prefix `OIQTLC-240208-ABC-PUNE-GUN MODIFICATION SPARES`. Maps to
`order_mode = 'SPARES_ASSEMBLY'`.

### Mode 3: PROJECT_FOR

Quote prefix `OIQTLC-240207-ABC-MOTORS-PROJECT-FOR`. Free On Rail. Maps to
`order_mode = 'PROJECT_FOR'`.

### Mode 4: PROJECT_HSS (High Sea Sales)

Quote prefix `OIQTHS-240207-ABC-MOTORS-PROJECT-HIGH SEA SALES-MODE`. USD with
explicit forward FX. CIF Nhava Sheva. Maps to `order_mode = 'PROJECT_HSS'`,
plus `orders.forward_fx_rate` and `orders.forward_contract_ref`.

## Source country prefixes

From the source PO templates (`OIPOOJ`, `OIPOOK`, `OIPOOC`, `WOPOOI`):

| Prefix | Meaning | Country code in `item_master.source_country` |
| --- | --- | --- |
| OJ | Obara Japan | O-JAPAN |
| OK | Obara Korea | O-KOREA |
| OC | Obara China | O-CHINA |
| OI | Obara India (work order) | O-INDIA |

## Item master template

The 35-column `Item Master Template-FEB-2024.xlsx` maps directly to
`item_master`:

| Spreadsheet column | `item_master` column |
| --- | --- |
| Description | description |
| Part No | part_no |
| Drawing No | drawing_no |
| Customer Part No | (not stored on item; lives on `part_aliases`) |
| Unit of Measure | uom |
| Item Group / Sub Group / Category / Sub category | item_group / item_sub_group / category / sub_category |
| Source Country | source_country |
| Currency | source_currency |
| Purchase Price | purchase_price |
| Purchase Quote No | purchase_quote_no |
| Validity start / end | purchase_quote_validity_start / _end |
| HSN/SAC Code | hsn_sac |
| SGST / CGST / IGST | sgst_rate / cgst_rate / igst_rate |

## Project tracker (14 phases)

From `2. Project- Info and activity Rev1.xlsx`:

`INITIAL_INFO`, `STRATEGY`, `PROMOTIONAL`, `RFQ_PREP`, `BUDGETARY_QUOTATION`,
`PRICE_NEGOTIATION`, `LB_FINALIZATION`, `KICKOFF`, `DESIGN`,
`APPROVAL_PROCESSING`, `MANUFACTURING`, `SHIPPING`,
`INSTALLATION_COMMISSIONING`, `PAYMENT_FOLLOWUP`, `CLOSED`.

Maps to `project_phase` enum and `projects.current_phase`.

## Internal Sales Order types

Three template files in `INternal Sales order/`:

- `Internal Sales Order-FOC Supply or Warranty Replacement.xlsx`
  → `iso_type IN ('FOC_SUPPLY', 'WARRANTY_REPLACEMENT')`
- `Internal Sales Order-Product Trials.xlsx`
  → `iso_type = 'PRODUCT_TRIAL'`
- `Internal Sales Order-Expected PO.xlsx`
  → `iso_type = 'EXPECTED_PO'`

Plus a fifth `INTERNAL_TRANSFER` for Chennai/Pune/Halol store transfers
mentioned in the JTBD doc.

## Spare matrix structure (JBM Plant 1)

The 6.5MB matrix has:

- `Plant` → `equipment_hierarchy.plant_name`
- `Line` → `equipment_hierarchy.line_name`
- `ZONE` → `equipment_hierarchy.zone_name`
- `Station Name` → `equipment_hierarchy.station_name`
- `Robot Make` / `Robot No.` → `equipment_hierarchy.robot_make / .robot_no`
- `GUN NO.` (e.g., SRTX-S2C7117L) → `equipment_hierarchy.gun_no`
- `GUN TYPE`, `Timer`, `ATD` → matching columns
- 150+ part columns → exploded into `equipment_installed_parts` rows

## Lost reason taxonomy

Seeded from JTBD ("Quotation Lost Tracking" + "track when a quotation is lost
to a competitor so that I can analyse reasons"):

`PRICE_HIGH`, `LEAD_TIME`, `COMPETITOR_RELATIONSHIP`, `SCOPE_MISMATCH`,
`QUALITY_CONCERN`, `BUDGET_CUT`, `NO_RESPONSE`, `TECHNICAL_GAP`,
`PAYMENT_TERMS`. Tenant admins can add custom codes via Admin Center.
