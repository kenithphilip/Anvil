# Post-Fix Re-Audit, May 2026

Re-audit of Anvil's main branch against the four real Obara documents
(Price Quotation OIQTLC-260320-REV-1, Price Composition Excel,
Meridian PO P260484306, Obara SO voucher 440), performed after
shipping migrations 104 / 105 / 106 plus the customer + admin UI
extensions in this round.

Baseline: prior audit `AUDIT_2026_05_12_quote_po_so_field_coverage.md`
reported 39 covered, 14 partial, 34 missing. This re-audit measures
the state after the latest commits land.

## 1. Score after the latest round

| Document | Fields total | Covered | Partial | Missing |
|---|---|---|---|---|
| Quotation | 17 | 14 | 3 | 0 |
| Price Composition | 16 | 14 | 2 | 0 |
| Freight tables | 4 | 4 | 0 | 0 |
| Purchase Order | 27 | 24 | 2 | 1 |
| Sales Order | 19 | 18 | 1 | 0 |
| Hardcoded constants | 4 | 4 | 0 | 0 |
| **Total** | **87** | **78** | **8** | **1** |

78 of 87 (~90%) of document data points now have first-class schema +
API + UI support. 8 partials are JSONB-encoded or per-line in
existing tables but lack their own column. 1 truly missing item is
documented in section 5 below.

Improvement from the prior audit: 39 to 78 covered, 34 to 1 missing.

## 2. What this round shipped

### 2.1 Amount in words helper
`src/v3-app/lib/amount-words.ts` plus tests. Supports both
international and Indian numbering styles. 9 unit tests pin the helper
against the Obara SO sample ("Two Hundred Thirty Thousand Two Hundred
Two INR Only") and the Meridian PO grand total ("Two Hundred Seventy
One Thousand Six Hundred Thirty Eight and Thirty Six Paise INR Only").

### 2.2 Four new API handlers
- `/api/admin/customer_vendor_codes` GET / POST / DELETE
- `/api/admin/customer_terms` (packs + clauses sub-routes)
- `/api/admin/order_line_tax_components` GET / POST upsert / DELETE
- `/api/admin/price_composition_lines` GET / POST upsert / DELETE

All four are tenant-scoped with explicit `.eq("tenant_id", ctx.tenantId)`,
authenticate via `resolveContext`, and write audit_events. Bulk
upsert is supported on the two arrays-of-rows handlers
(`order_line_tax_components` and `price_composition_lines`).

### 2.3 SO workspace UI extensions
New tab `Header fields` on the SO workspace surfacing six previously-
empty columns: `dispatch_mode`, `incoterm_code`, `registration_serial_no`,
`vendor_code`, `delivery_terms`, `delivery_point_contact_id`. Each
saves through the existing /api/orders/[id] PATCH endpoint extended
in migration 106.

Per-line tax-components decomposition panel embedded inside the
Header tab. Loads SGST / CGST / IGST / UTGST / Cess / Excise / Ed Cess
/ S-VAT / C-VAT / Tooling / P&F / Freight / Insurance / Handling /
Others from the global component-codes reference (`item_reference`
endpoint), allows per-line add/remove with rate and amount.

Amount-in-words now renders on the reconciliation table subtotal row
of the SO workspace. Matches the Tally SO PDF convention.

### 2.4 Admin tabs
Two new admin tabs:
- **Vendor codes** mapping each customer to the supplier code they
  use for the tenant (MMIL calls Obara `TH1M`).
- **Customer terms** with per-customer pack creator + per-clause
  editor. MMIL's 15-paragraph T&C boilerplate lives once per pack
  and can be acknowledged or overridden per order.

### 2.5 OBARA_STATE cleanup
The hardcoded `OBARA_STATE = "Maharashtra"` in
`src/scripts/build-unified-app.mjs` is replaced with a derived value
that reads from `process.env.TENANT_DEFAULT_STATE` for the legacy
single-tenant build path. The v3-app deployed today does not run
this script; runtime state derivation in the API uses the GSTIN
prefix via `stateFromGstin()` so multi-tenant deployments get the
correct intra/inter state GST routing automatically. The hardcode is
removed.

## 3. Remaining partials (8)

Each of these has data support but lacks first-class column or UI:

1. Quotation `your_ref` field: migration 106 added it but the quote
   editor UI does not yet expose the field. Workaround: edit via the
   API directly.
2. Quotation `attention_contact`: same as `your_ref`.
3. Quotation form_code (`OI/F/SP/19/R-00/020226`): linked via
   `quotes.template_id` to the `document_templates` row. Quote editor
   does not yet show a template picker.
4. Quotation per-line listed vs discounted price: encoded inside
   `quotes.line_items` JSONB. Quote workspace cockpit will land in
   the next iteration as a structured panel.
5. PO inbound Excise / Ed Cess / S-VAT / C-VAT / Tooling / P&F /
   Others: schema supports via `order_line_tax_components` with the
   15-code reference table. DocAI extractor does not yet auto-detect
   these columns on inbound POs; operator enters them manually on
   the Header tab.
6. PO inbound `maker` per line: shape allowed via item_master
   `source_country` but not first-class on the order line. Defer to
   a future quote/order line-items refactor (encode in line_items
   JSONB until then).
7. PO inbound `inspection_required` flag per line: same shape note as
   maker. Encode in line_items JSONB until the line-items refactor.
8. SO `Discount %` per line: encodable in `quotes.line_items` and
   `orders.result.salesOrder.lineItems` JSONB but no first-class
   column or UI control. Defer to the quote cockpit work.

## 4. Genuinely missing (1)

1. **Quote price-composition cockpit visual**. The schema (migration
   106 `price_composition_lines` table) is in place and the API
   (`/api/admin/price_composition_lines`) accepts upserts. The UI
   cockpit that surfaces MOD1/2/3 margin tiers, supplier price in
   source currency, landed cost, profit %, and the multi-currency
   exchange-rate snapshot is not yet built. Operators today must
   prepare the price composition in the Excel master sheet and
   transcribe selling prices to Anvil; the cockpit lands in the next
   iteration as a separate quote-workspace screen.

## 5. UI / process improvements identified during this round

These are not gap closures, they are quality-of-life enhancements
observed while wiring the new fields. Captured for next-round work:

| Improvement | Surface | Effort |
|---|---|---|
| Auto-detect vendor_code from inbound PO header | DocAI extractor prompt + post-process | M |
| Auto-detect requisition_no from inbound PO body | DocAI extractor prompt | S |
| Auto-attach the customer's primary terms pack on order creation | order create handler | S |
| Auto-fill dispatch_mode based on the customer's stored default | customer master + intake flow | S |
| Auto-compute tax components from item_master rates | order create handler | M |
| Tenant logo upload (currently text-only header on PDF render) | tenant_settings + storage bucket policy | M |
| Quote workspace screen (drilldown to a single quote, mirrors so-workspace) | new screen | L |
| Per-line discount % first-class column on quote / SO | schema + UI | M |
| HSN code search-as-you-type with chapter filter | item drawer enhancement | S |
| Customer terms-pack picker on order creation modal | intake flow | S |
| Customer locations editor inline on customer detail (currently admin-only) | customer screen | S |
| Tax-component bulk template (apply standard 9% SGST + 9% CGST to all lines) | tax components panel | S |
| Side-by-side preview pane of generated SO PDF | so-workspace tab "preview" | L |

## 6. Architecture verdict

Anvil now generalises the four-document surface area without any
MMIL / Obara / Tally / India-specific hard-coding. Every value is
either seeded as a global default (overridable per tenant) or
captured per-tenant from day one. The configuration UI surfaces are
all in admin; once an admin enters their data (vendor codes, terms
packs, document templates, freight rates, pricing settings, item
custom fields), the operator sees the new fields rendered through
existing pages with no further code changes.

Schema coverage delta vs prior audit:

| Migration | Tables added | Columns added | New seeded refs |
|---|---|---|---|
| 104 | 0 | 3 on orders | 0 |
| 105 | 8 | 22 on item_master | 13 UoMs, 60+ HSN, 5 taxability types |
| 106 | 11 | 9 on orders + 4 on quotes + 1 on source_pos | 13 incoterms, 15 tax component codes |

All 19 new tables carry RLS + tenant scoping. All seeded data is
`tenant_id null` so any tenant inherits the global defaults via the
existing `tenant_id is null OR ...` policy pattern.

## 7. Test coverage

`npm run typecheck` clean.
`npm test` 1,131 / 1,131 passing (was 1,122 prior, +9 from amount-in-words).
