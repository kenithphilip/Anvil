# Capital-items catalog: a configurator, not a product list

Scoping note for the sales-team product catalog, from the workbook
*Capital Items Ordering - Sales Team (rev).xlsx* (12 sheets, 1,913 non-empty
cells). Backlog item — nothing here is built.

---

## 0. The one-paragraph answer

The spreadsheet is not a catalog. It is a **configurator**, hand-built in Excel
five separate times, once per product family. Every sheet is groping at the
same shape: *family + option values → a specific identifier*. The right move is
to model that shape once, resolve it to a `part_no`, and let the existing
lifecycle carry it — because **every line table in Anvil already joins on
`part_no`**, so a catalog that resolves to one works at every stage for free.

Anvil also already has more of the lifecycle than it looks: `projects` with a
15-value `project_phase` enum covers **12 of the 13 stages** listed in the
request. The genuinely missing pieces are the configurator itself, engineering
change control, and the aftersales tail.

---

## 1. What the workbook actually is

| Sheet | Family | Option dimensions | Resolves to |
|---|---|---|---|
| ATD (16 variants) | Auto Tip Dresser | cap-tip size (T-13-D / T-16-D), rotation sensor (PNP / NPN), stand height, with-vacuum | assembly part no **+ 9 component part nos** |
| SIV32 / SIV22 / SIV21 / STN21 | four timer families | SWAQ, secondary feedback, display pendant, comms protocol, source, customer | part no |
| Colour Sensor | colour sensor | ATD type × diode × wire configuration | assembly part no |
| PWR & CNTRL CABLE (90 rows) | cable | type, make, cross-section × core, robot side, timer side | **drawing no** |
| Manual Tip Dresser Remover | remover | 16 DIA / 13 DIA | part no |
| RFQ Info | — | *dropdowns: Type, Sourcing, comms protocol* | — |
| Compiled List / STOCK / STOCK Budget | — | *derived views over the above* | — |

Two things worth saying out loud.

**`RFQ Info` is not a data sheet — it is the configurator UI.** A form with
dropdowns where sales picks a description, a type, a sourcing origin and a
quantity, and for timers picks a comms protocol which selects the part number.
The team has already specified the feature in their own hand.

**The ATD sheet is an option matrix and a bill of materials in the same rows.**
Choosing (16 DIA, PNP, 850 mm, vacuum) determines cutter assembly, cutter
holder, cutter blade, cover assembly, chip tray, stand assembly, motor and
proximity sensor. That is *configure → explode to BOM*, and it is the single
most valuable thing in the workbook.

### Normalisation defects, with counts

| # | Defect | Evidence |
|---|---|---|
| D1 | Family encoded as a **sheet name** — four timer sheets differ only in family | SIV32/SIV22/SIV21/STN21 |
| D2 | Option names as **column headers**, no registry. "Rotation Sensor PNP/NPN" and "DIODE (NPN)" are the same physical concept and cannot be joined | ~40 headers across 8 sheets |
| D3 | **Two identifiers comma-joined in one cell** — a part number and a model code, sometimes with sourcing jammed in (`SIV22C-6-M.(O/C)`) | **81 cells**, 20 distinct pairs |
| D4 | **Locations as columns** — Stock OBARA / IN TRANSIT / PSO-China / PSO / Virtual | STOCK sheet |
| D5 | A **date frozen into a column header** ("Excess stock @ 22 Jan 24") | STOCK Budget |
| D6 | **Identifier-class collision** — cable resolves to a *drawing no*, everything else to a *part no* | PWR & CNTRL CABLE |
| D7 | **1,048,556 phantom rows** from whole-column formatting; 56 have content | RFQ Info |
| D8 | `#VALUE!` from broken embedded-image formulas | 4 cells |
| D9 | **Customer as a product attribute** — variants gated to one buyer | timer sheets |
| D10 | No stable key, no revision, no effectivity. "Sr. No" renumbers on sort | every sheet |

D3, D4, D5 and D9 already have a normalised home in Anvil (`item_master`
aliases, `inventory_positions` with `as_of` in its unique key and a real
`in_transit_qty`, `item_customer_parts`). **Only D1, D2, D6 and D10 — the
configuration model itself — have nowhere to go.**

---

## 2. The finding that decides the design

`opportunity_line_items` (migration 086) requires a `product_family` on every
forecast line, and its own comment says:

> *NULL means "we know the family/category but not the SKU yet"; the engine
> falls back to the (family, category) → part_no map maintained on item_master.*

**That map was never built.** `item_master` has no `product_family` column, and
nothing in `src/api` resolves a family to a part number — `product_family` is
stored, validated as required, and then sits as free text forever.

So this is not a new requirement. It is a hole the schema has been carrying an
explicit note about since migration 086, and the workbook is the map that note
promises.

---

## 3. The model

**Governing constraint (verified):** `quote_lines`, `shipment_lines`,
`bill_of_materials`, `source_po_lines`, `inventory_positions`,
`equipment_installed_parts` and the rest all join on **`part_no text`**, not on
an item id. A catalog that resolves to a `part_no` therefore reaches every
stage without re-keying anything.

Three new tables:

- **`product_families`** — `(tenant_id, family_code, name)`. ~8 rows. Fixes D1.
- **`product_options`** — `(tenant_id, family_id, option_key, label, data_type,
  position, allowed_values jsonb)`. The registry that makes "Rotation Sensor"
  and "DIODE" reconcilable. Fixes D2.
- **`product_variants`** — `(tenant_id, family_id, option_values jsonb,
  identity_kind, part_no, drawing_no, status, effective_from, superseded_by)`,
  unique on `(tenant_id, family_id, option_values)`, GIN on `option_values`.
  Fixes D6 via `identity_kind` and D10 via `effective_from`/`superseded_by`.

`option_values` is jsonb so ATD's six options and the remover's one coexist
without a schema change. That is not a novel choice here —
`spare_matrix_rows.spare_values` and `equipment_hierarchy.attributes` already
do exactly this.

Everything else **extends** what exists: variants land in `item_master`;
sourcing → `source_country`; landed cost → `item_field_values` (no migration);
stock → `inventory_positions` + `locations`; customer-gating →
`item_customer_parts`; the component breakdown → `bill_of_materials`.

---

## 4. What each stage already has

| Stage | Today | What the catalog adds |
|---|---|---|
| Lead / enquiry | leads, opportunities, channel intake | family + options captured at first contact instead of free text |
| Project forecasting | `opportunity_line_items.product_family` **(required, unresolved)** | resolves family → part_no; §2's missing map |
| Quote | quotes, quote_lines, pricing, reconciliation | configure-to-quote; valid option combinations only |
| Sales order processing | orders, extraction, approval, Tally push | PO line → variant match, not just fuzzy part match |
| **Project management for design** | `projects` + `project_phase_log`, phases `DESIGN` and `APPROVAL_PROCESSING`, budgeted design mandays | **the sign-off workflow underneath those phases — missing** |
| Logistics planning | shipments, freight bids/rates, ETA monitoring | weight/volume per variant for real freight basis |
| Delivery | shipment lines, dispatch register | — |
| Last-mile dispatch | dispatch register only; **no vehicle/driver/route model** | — |
| Field installation | phase `INSTALLATION_COMMISSIONING` | as-built variant → installed base |
| Breakdown service | complaint classifier labels then **drops** them; no ticket/SLA layer | variant → correct spare first time |
| In-warranty service | `equipment_installed_parts`; **no warranty entitlement table** | warranty per variant |
| Health checkup | `amc_schedules` | checklist per variant |
| Aftersales opportunity | Spare Intelligence bridge | installed variants → replacement demand |

**The `project_phase` enum already covers 12 of the 13 stages.** It stops at
`PAYMENT_FOLLOWUP` / `CLOSED` — the aftersales tail has no phase.

---

## 5. The genuinely missing pieces, ranked

1. **The configurator** (§3). Nothing in the repo models an option.
2. **Engineering change control.** No ECR, no ECO, no effectivity, no revision
   supersede chain on any engineering object. `customer_change_requests` is
   *customer master data*, not engineering — but its propose → decide → apply
   loop is the right template. `plm_changes` mirrors external ECOs into a table
   **nothing reads**.
3. **Design sign-off.** `gun_drawings.approval_status` exists and its own
   migration calls it a "provision (workflow not enforced yet)": `commit.js`
   never reads it, no UI ever sets it, and an uploader can approve their own
   drawing. `bom_assets.approval_status`/`approved_by`/`approved_at` are
   touched by **zero lines of application code**. The 3D-after-simulation then
   2D-final sign-off the request describes has no home — and note there is no
   STEP viewer and no simulation of any kind, so "after simulation" means
   *recording an outcome decided elsewhere*, not running one.
4. **Project execution.** No tasks, no schedule milestones, no resource
   actuals, and **`orders` has no `project_id`** — a project cannot enumerate
   its own orders, quotes or shipments.
5. **The aftersales tail** — warranty entitlement, ticket/SLA, health-check
   checklist. Largest scope, weakest current foundation.

---

## 6. Ingestion — once, not by hand

The workbook is **1,913 cells**. This is a one-time import, not a migration
project. Reuse `bom-import-core.js` and the DocAI reader rather than typing:

1. A `catalog` document kind whose extractor reads a *sheet* into
   `{family, options[], variants[]}` — the sheet layouts are regular enough
   that the option columns are inferable from low cardinality.
2. Preview → commit, exactly as `/bom/from-drawing` already does. Never
   auto-commit.
3. Split the 81 comma-joined cells into `part_no` + alias on the way in.
4. Golden fixtures per family shape, so a re-import that loses the ATD
   component columns fails the build.

---

## 7. Agentic + analytics layer

Wire into what exists rather than building a parallel stack:

- **A `configure_product` copilot tool** in `erp-chat-tools.js` — natural
  language ("MFDC timer, ethernet, with pendant, for a tier-1") → variant +
  part_no + price + stock. Same registration pattern as `catalog_lookup`.
- **Governed metrics** in `_lib/metrics/catalog.js` (`domain: "catalog"`):
  option-combination frequency, unresolved-family rate on forecast lines
  (§2's hole, made measurable), variant coverage of quoted lines, stock
  position by variant.
- **An agent** that watches quoted-but-unconfigured lines and proposes the
  variant, using the `action_proposals` confirm-token gate already built for
  copilot writes.
- **Reuse the extraction-quality apparatus** shipped in #486–#493: prompt
  versioning, per-kind golden fixtures, the corrected-run harvest. A catalog
  extractor gets the same measurement for free.

---

## 8. Phased PRs

| # | PR | Ships |
|---|---|---|
| 1 | `product_families` / `product_options` / `product_variants` + pure resolver | the model, tested, unwired |
| 2 | Sheet importer + preview/commit + golden fixtures | **the workbook is in Anvil** ← first visible value |
| 3 | Resolve `opportunity_line_items.product_family` → `part_no` | closes the migration-086 hole |
| 4 | Configure-to-quote on the quote screen | sales configures instead of hunting |
| 5 | Variant → BOM explode (the ATD component columns) | the component list falls out of the configuration |
| 6 | `configure_product` copilot tool + catalog metrics | agentic + measurable |
| 7 | `engineering_changes` + `change_signoffs`, 3D-then-2D gates, enforced on commit | design sign-off actually gates |
| 8 | `orders.project_id` + project rollup | a project can see its own orders |

PRs 1–3 are the spine and are worth doing regardless of what follows.

---

## 9. What not to build

- **A CAD/simulation engine.** No STEP viewer, no FEA, nothing. Record the
  sign-off decision and link the artefact; the simulation happens in the tool
  that owns it.
- **A PLM.** `plm_changes` already mirrors Windchill/Arena read-only. If the
  ECOs live there, sync them — don't re-author them.
- **A fleet/last-mile system.** No vehicles, drivers or routes exist. That is
  a separate product decision, not a catalog feature.
- **A ticketing system.** Buy it, or build the single-table version only if the
  inbound-complaint volume justifies it.

---

## 10. Open questions

1. Is a variant's identity the part number, the model code, or the pair? 81
   cells carry both and the pairing is inconsistent.
2. Are customer-gated variants a *restriction* (may not be sold to others) or a
   *default* (usually sold to this one)? It changes whether the configurator
   hides or merely deprioritises them.
3. Do the cable rows resolve to a manufactured part at all, or is the drawing
   the deliverable?
4. "Sign-off on 3D after simulation" — who runs the simulation, and is its
   output a file Anvil stores or a verdict Anvil records?
5. Does the aftersales tail want new `project_phase` values, or is it a
   separate lifecycle keyed on installed base rather than project?
