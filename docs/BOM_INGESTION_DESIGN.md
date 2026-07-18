# BOM Ingestion - Design

Status: **proposed** (design-first; schema to be locked in review before code).
Owner: Joel. Next free migration number at time of writing: **147**.

This document specifies a generalized Bill-of-Materials (BOM) ingestion
capability for Anvil: ingest a finished product's parts list from a
supplier/source Excel/CSV in any layout, preserve its assembly hierarchy
and per-part attributes, and make every part accessible to the item
master so it can drive spares sales, re-design/modification, preventive
maintenance, import/export/logistics, and quote preparation.

It is industry-neutral by design (B2B / manufacturing generally), with
the existing Obara "guns" use case as the first built-in profile.

---

## 1. Motivation and current state

### 1.1 The source tool (Obara Ops v13, standalone HTML)

A client-only app (Supabase + SheetJS + Tesseract OCR) whose **Import**
tab is a capable BOM ingester. Salient behavior:

- **Model:** `guns` (the asset) + `bom_items` (a flat, source-ordered
  per-asset parts list). Each line: `seq_no` (source row order), `level`
  (assembly depth 1/2/3+), `part_no`, `part_name`, `size`, `material`,
  `qty` (fractional allowed), `side`, `lr`, `std_category`, `is_spare`,
  `remarks`.
- **Format auto-detection** (`detectOrigin`): India / Korea / China /
  Japan, from header signatures, CJK/Hangul characters, and identifying
  labels (`MESSRS.`, `PRODUCT CODE`, `Structure`, `Drawing No.`), plus
  filename hints.
- **Column aliasing** (`COL_MAP` + `detectBomCols`): maps divergent
  headers to canonical fields and applies per-source quirks - China
  swaps `ITEM No`↔`PARTS CODE` (PARTS CODE is the external supplier part
  number); Japan derives depth from dotted `Structure` (`14 .1.1`→3);
  Korea reads `Lv`.
- **Metadata block** parsed from pre-header rows (product code/name,
  customer/`MESSRS.`, dates, drawn/checked/approved-by, L/R).
- **Re-import = modification:** diffs added/removed/changed vs the
  existing BOM, then delete-and-insert.

### 1.2 What Anvil already has (foundations)

| Concern | Anvil artifact | File |
| --- | --- | --- |
| BOM storage | `bill_of_materials` - normalized parent→child edge graph (`parent_part_no, child_part_no, qty, uom`); `unique(tenant_id, parent_part_no, child_part_no)` | `supabase/migrations/003_*.sql:126` |
| Multi-level explosion | `v_bom_walk_recursive` (depth ≤ 8) | `supabase/migrations/085_*.sql:431` |
| Item catalog | `item_master` (sourcing, tax, planning, lifecycle, `item_type`, `is_assembly`) | `006_*.sql:167`, `085`, `105`, `141` |
| Engineering spec | `item_specifications` (drawing_no, material, gun_number, source_country, …) | `105_*.sql:302` |
| Customer part numbers | `item_customer_parts` (customer ↔ part number) | `105_*.sql:345` |
| Custom fields | `item_field_definitions` / `item_field_values` / `items_full_v` | `105_*.sql:380` |
| Spare matrix | `spare_recommendations`, `/api/spare_matrix/*` | `005_*.sql`, `src/api/spare_matrix/*` |
| BOM API | `/api/bom` GET/POST/DELETE on `bill_of_materials` | `src/api/bom/index.js` |
| Import UI | `src/v3-app/screens/bom-import.tsx` (multi-file XLSX/CSV, origin guess, diff) | `src/v3-app/screens/bom-import.tsx` |

### 1.3 The gap

The existing `bom-import.tsx` is a **lossy stub**:

1. Flattens every part to a single edge `assetNo → part_no` - **no true
   multi-level hierarchy** (`level` is concatenated into a `notes`
   string at `bom-import.tsx:392`).
2. Drops rich attributes (`material`, `size`, `side`, `lr`,
   `std_category`, supplier part code, `seq_no`); `/api/bom` persists
   only `parent/child/qty/uom/notes`.
3. **Never creates `item_master` rows** - BOM parts are invisible to the
   item master (this contradicts the core requirement).
4. No asset/product entity; no first-class supplier part number.
5. Origin detection is filename-based, far shallower than the source
   tool's header-signature + CJK detection.

**Conclusion:** Anvil has the right downstream rails (normalized BOM
graph + rich item master + spare scoring); what's missing is a faithful
*ingestion* that captures the as-imported document, preserves hierarchy
and attributes, generalizes the source-format handling, and feeds the
item master + `bill_of_materials`.

---

## 2. Design overview

Two layers, so we keep both the human-readable engineering document and
the normalized graph the planner needs:

```
 Excel/CSV (any layout)
   │  parse (client) + map via format registry
   ▼
 [Layer A]  bom_assets ── 1:N ── bom_lines        (as-imported document)
   │  derive (server, atomic + audited)
   ├──────────────► item_master (+ item_specifications, supplier/customer part)
   └──────────────► bill_of_materials (parent→child edges from level)
                         │
                         ▼
                 v_bom_walk_recursive → planning, spares, quoting, logistics
```

- **Layer A** is the source of truth for "what the BOM document said":
  source order, hierarchy depth, side/variant, supplier code, material,
  remarks. Used directly by spares/quote/maintenance views.
- **Layer B** is derived, idempotently, from Layer A onto existing
  tables so nothing downstream has to change.

Cross-tenant safety, RLS, `resolveContext`/`requirePermission`,
`recordAudit`, and migration conventions follow the repo invariants
(tenant_id first non-id column; standard policies; idempotent SQL).

---

## 3. Schema (migration 147)

All tables: `tenant_id` first non-id column, FK to `tenants(id) on
delete cascade`, RLS enabled with the standard select/write policies
(`tenant_id in (select current_tenant_ids())`), `created_at`/`updated_at`.

### 3.1 `bom_assets` - the finished product / equipment / assembly

Industry-neutral generalization of the source tool's `guns`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `asset_code` | text not null | the product/drawing/model number (e.g. gun no, machine model, equipment tag) |
| `name` | text | product/project name |
| `asset_type` | text | neutral label: `product` \| `equipment` \| `assembly` \| `machine` … (tenant-defined; no hard enum) |
| `customer_id` | uuid null → customers on delete set null | when the asset is customer-specific (also derivable via linked projects) |
| `source_format` | text | which registry profile ingested it (e.g. `obara_china`) |
| `revision` | text | BOM revision / drawing rev |
| `drawing_no` | text | |
| `source_country` | text | origin (e.g. `O-CHINA`); aligns with `item_master.source_country` |
| `metadata` | jsonb default `{}` | extracted block: drawn_by/checked_by/approved_by/date/lr/messrs… |
| `uploaded_by` | uuid null → auth.users on delete set null | who created the asset / first import (provenance) |
| `last_uploaded_by` | uuid null → auth.users on delete set null | who ran the most recent (re-)import |
| `last_imported_at` | timestamptz | timestamp of the most recent import |
| `approval_status` | text default `'imported'` | governance: `imported` \| `pending_approval` \| `approved` \| `rejected` (future workflow; default keeps current behavior) |
| `approved_by` | uuid null → auth.users on delete set null | **future use** - approver of the BOM revision |
| `approved_at` | timestamptz | **future use** - when approved |
| | | `unique (tenant_id, asset_code, revision)` |

Provenance note: `uploaded_by` / `last_uploaded_by` come from
`ctx.userId` in the import endpoint; every import also writes a
`bom_import_events` row (3.6) so the full who/when/what history survives
re-imports. The `approval_*` columns are laid down now but the approver
workflow is **future scope** - v1 only populates `approval_status =
'imported'` and never gates on it.

### 3.2 `bom_lines` - the as-imported parts list

Mirror of the source tool's `bom_items`, with supplier part as a
first-class column.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `asset_id` | uuid not null → bom_assets on delete cascade | |
| `seq_no` | int | source-file row order |
| `level` | int | assembly depth (1=top, 2=sub-assy, 3+=part); null = flat |
| `parent_line_id` | uuid null → bom_lines | resolved parent within the same asset (from level walk); enables exact tree |
| `part_no` | text not null | canonical/internal part number |
| `part_name` | text | |
| `supplier_part_no` | text | external supplier/source code (e.g. China `PARTS CODE`) |
| `supplier_id` | uuid null → suppliers | when known |
| `material` | text | grade/spec |
| `size` | text | dimension/model |
| `qty` | numeric(18,6) | fractional allowed (cable lengths, glue weight) |
| `uom` | text | |
| `side` / `variant` | text | side / LH-RH / L-R |
| `std_category` | text | standard/category flag |
| `is_spare` | boolean | |
| `remarks` | text | composed per source (hier no, ids, jpn model…) |
| `raw` | jsonb default `{}` | original row cells for audit/repair |
| | | `unique (tenant_id, asset_id, seq_no)` |

Indexes: `(tenant_id, asset_id, seq_no)`, `(tenant_id, part_no)`,
`(tenant_id, supplier_part_no)`.

### 3.3 `bom_source_formats` - tenant-configurable format registry

Generalizes `COL_MAP` + `detectOrigin` into data. Built-in defaults are
seeded per tenant on first use (or read from a shipped default set).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `key` | text not null | e.g. `obara_china`, `acme_supplier_a` |
| `label` | text | human name |
| `column_map` | jsonb not null default `{}` | `{ canonicalField: [header aliases…] }` (e.g. `part_no: ["part no","parts code","item no."]`) |
| `detect` | jsonb not null default `{}` | detection signals: required header labels, regex on first-N-rows, script ranges (`cjk`/`hangul`/`kana`), filename hints, priority |
| `quirks` | jsonb not null default `{}` | per-format transforms: `swap_part_code`, `level_from_dotted:"structure"`, `level_from_col:"lv"`, `lr_yes_no_chars`, metadata-label map |
| `is_builtin` | boolean default false | seeded defaults vs tenant-authored |
| `enabled` | boolean default true | |
| | | `unique (tenant_id, key)` |

Built-in seeds: `obara_india`, `obara_korea`, `obara_china`,
`obara_japan` (lifted verbatim from the source tool's logic) + a
`generic_flat` fallback.

> Design note: this is the same move as PR1's connector `field_map` -
> one engine, many source layouts, configured as data. Reuse the spirit
> (validation, admin-gated writes) but a separate table (BOM source
> formats are richer than a flat key→value map).

### 3.4 `bom_asset_projects` - asset to project linkage (M:N)

An asset (gun / product / equipment) can appear in many projects, and a
project includes many assets. Customer flows naturally from the project
(`projects.customer_id`) or from `bom_assets.customer_id` for
customer-specific assets not yet tied to a project.

| Column | Type | Notes |
| --- | --- | --- |
| `tenant_id` | uuid | |
| `asset_id` | uuid not null → bom_assets on delete cascade | |
| `project_id` | uuid not null → projects on delete cascade | reuses the existing `projects` table (`006_*.sql:480`) |
| `qty` | numeric(18,4) | units of this asset in the project (e.g. 4 guns on a line) |
| `notes` | text | |
| `created_by` | uuid null → auth.users on delete set null | who linked it |
| `created_at` | timestamptz | |
| | | `primary key (tenant_id, asset_id, project_id)` |

### 3.5 `bom_import_events` - upload / modification history (provenance)

One row per import (create or re-import) so "who uploaded which BOM,
when, and what changed" is fully auditable across revisions - beyond the
single `recordAudit` row. Sets up the future approver workflow.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `asset_id` | uuid not null → bom_assets on delete cascade | |
| `uploaded_by` | uuid null → auth.users on delete set null | actor (from `ctx.userId`) |
| `source_format` | text | registry profile used |
| `file_name` | text | original upload filename |
| `line_count` | int | rows imported |
| `diff` | jsonb default `{}` | `{ added, removed, changed, unchanged }` counts (and optionally part lists) |
| `created_at` | timestamptz | |

Index: `(tenant_id, asset_id, created_at desc)`.

### 3.6 Spare-matrix linkage (`spare_matrices` + `bom_asset_spare_matrices`)

The user wants to know which spare matrices an asset is used in. **Today
spare matrices are client-only** (`spares.tsx` persists to localStorage
key `obara:v3_spare_matrices`; only `spare_recommendations` scoring is
server-side). So this linkage has a **prerequisite**: server-persist the
matrices. Proposed minimal header + join, gated to the spare phase:

`spare_matrices` (header):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `tenant_id` | uuid | |
| `name` | text not null | |
| `project_id` | uuid null → projects on delete set null | matrix is usually per-project |
| `customer_id` | uuid null → customers on delete set null | |
| `created_by` | uuid null → auth.users on delete set null | |
| `created_at` / `updated_at` | timestamptz | |

`bom_asset_spare_matrices` (join):

| Column | Type | Notes |
| --- | --- | --- |
| `tenant_id` | uuid | |
| `asset_id` | uuid not null → bom_assets on delete cascade | |
| `spare_matrix_id` | uuid not null → spare_matrices on delete cascade | |
| | | `primary key (tenant_id, asset_id, spare_matrix_id)` |

This is **phased** (see 9): the asset/BOM core ships first; the
spare-matrix server table + localStorage migration is the phase that
also turns on the asset to spare-matrix "where-used" linkage. Until
then, `bom_asset_projects` + `customer_id` already give project +
customer "where-used".

---

## 4. Derivation rules (Layer A → Layer B)

Run server-side in the import endpoint, transactional + audited.
Idempotent: re-importing the same asset replaces its lines and
re-derives, mirroring the source tool's "modification" semantics.

### 4.1 Parent/child edges from level

Within one asset, ordered by `seq_no`:

- Maintain a stack of "current ancestor at each level".
- A line at `level = L` has parent = the most recent prior line with
  `level = L-1`. Set `bom_lines.parent_line_id` accordingly.
- Emit a `bill_of_materials` row `(parent_part_no = parent.part_no,
  child_part_no = line.part_no, qty = line.qty, uom)` for each
  child→parent pair. Top-level lines (level 1, or flat/no-level) get
  `parent_part_no = asset.asset_code` so the asset root explodes.
- Collapse duplicates by summing qty (reuse `recipeToBomRows` collapse
  pattern from `_lib/composition-recipe.js`). Upsert via the existing
  `onConflict: "tenant_id,parent_part_no,child_part_no"`.

Flat BOMs (no level, e.g. Obara India) degrade to the current behavior:
all parts are direct children of the asset root.

### 4.2 Item master upsert (the core requirement)

For each distinct `part_no`:

- Upsert `item_master` (by `tenant_id, part_no`): set `description`
  (part_name), `source_country`, `uom`, `is_assembly = (level is a
  parent)`, `item_type` left to tenant mapping/default, `data_source =
  'imported'`. Never clobber an operator-set field that's already
  populated (merge, don't overwrite). Reuse the `ensureRawMaterial`
  guard pattern from `composition_material_lines.js:50`.
- Upsert `item_specifications` (material, drawing_no, gun_number/asset
  code, source_country) when present.
- When `supplier_part_no` is present, record the supplier mapping
  (supplier external code). Customer-specific part numbers, when the
  asset is customer-scoped, can populate `item_customer_parts`.

Result: every BOM part is now in the item master and reachable by
spares, quoting, maintenance, and logistics - satisfying the brief.

### 4.3 Modification semantics

On re-import of an existing `(asset_code, revision)`: replace `bom_lines`
for that asset, recompute edges, re-upsert item master. Report a diff
(added/removed/changed lines) like the source tool. `bill_of_materials`
edges no longer present are pruned for that asset's roots only (never
cross-asset).

### 4.4 Provenance + linkage on import

- Set `bom_assets.uploaded_by` (first import only) and
  `last_uploaded_by` + `last_imported_at` (every import) from
  `ctx.userId`; leave `approval_status = 'imported'` (approver workflow
  is future scope).
- Write one `bom_import_events` row per import (actor, source_format,
  file_name, line_count, diff) so the who/when/what survives re-imports.
- If the import body carries `project_id`, upsert a `bom_asset_projects`
  link (with `created_by = ctx.userId`). Customer is taken from
  `asset.customer_id` and/or inherited from the linked project.
- `recordAudit` on every import (action `bom_import`).

---

## 5. API surface

- `POST /api/bom/import` - permission `write` (assembly authoring) or
  `admin` per RBAC decision. Body: `{ asset: {...}, lines: [...],
  source_format }` (rows already parsed+mapped client-side). Persists
  Layer A, runs §4 derivation, returns `{ ok, asset_id, lines, derived:
  { items_upserted, edges_upserted }, diff }`. Captures uploader from
  `ctx.userId`, accepts optional `project_id` to link the asset, and
  audits.
- `GET /api/bom/assets` / `GET /api/bom/assets/[id]` - list/detail an
  asset with its `bom_lines` tree, `uploaded_by`/`approval_status`, and
  its project/customer/spare-matrix links (the "where-used" view).
- `POST|DELETE /api/bom/assets/[id]/projects` - link/unlink an asset to
  a project (`write`); customer flows from the project.
- `GET /api/bom/assets/[id]/history` - the `bom_import_events` feed
  (who uploaded/modified, when, diff).
- `GET|PUT /api/bom/source_formats` - registry read (`read`) / write
  (`admin`), validated; built-ins seeded.
- (Spare phase) `POST|DELETE /api/bom/assets/[id]/spare_matrices` once
  `spare_matrices` is server-persisted (3.6).
- Existing `/api/bom` (flat edges) stays for back-compat; the importer
  now routes through `/api/bom/import` instead of the flat upsert.

Parsing stays client-side (as both the source tool and current screen
do) - the server receives mapped rows. (A future server-side parse +
OCR path is out of scope for v1.)

---

## 6. RBAC

- View asset/BOM/lines/history/where-used: `read`.
- Import BOM / edit source-format registry: `admin` (authoring a
  product structure is an admin-grade action; matches how
  `item_master` writes are `admin`). Final call to confirm in review.
- Link asset to project: `write`.
- **Approve a BOM revision (future):** `approve` - reserved now via the
  `approval_*` columns; no endpoint or gate ships in v1.
- New routes added to `docs/RBAC.md` + RBAC audit coverage; new tables
  covered by the RLS audit.

---

## 7. Backward compatibility

- Additive only: new tables + new routes. No change to
  `bill_of_materials`, `item_master`, `/api/bom`, or migration history.
- `bom-import.tsx` is repointed from `ObaraBackend.bom.upsert` (flat) to
  the new import path; its parse/preview UI is extended (level tree,
  material, supplier part) but the screen id/route is unchanged.
- Downstream (`v_bom_walk_recursive`, inventory planning, spare matrix)
  is unaffected - it just sees richer, correctly-leveled edges.
- Flag-gate the new import path if we want a staged rollout; the old
  flat upsert remains until parity is confirmed.

---

## 8. Cross-industry generalization

- No "gun"-specific column in the schema; `bom_assets.asset_type` is a
  free label and the registry carries all format-specific logic as data.
- A new industry/tenant adds a `bom_source_formats` row (column map +
  detection signals) and imports immediately - no code change.
- Built-in Obara profiles are just seeded registry rows, not hardcoded
  branches.

---

## 9. Phasing

1. **Schema + ingestion core** (migration 147: `bom_assets`,
   `bom_lines`, `bom_asset_projects`, `bom_import_events`;
   `/api/bom/import` with §4 derivation + provenance; project link +
   history endpoints; tests for level→edge walk, item_master upsert,
   idempotent re-import, uploader/event capture). No UI change.
2. **Format registry** (`bom_source_formats` + `GET|PUT
   /api/bom/source_formats`; built-in seeds; a shared
   `_lib/bom-format.js` detect+map engine generalized from the source
   tool).
3. **Wire `bom-import.tsx`** to `/api/bom/import`; richer preview (level
   tree, material, supplier part, uploader); asset/BOM browser with the
   where-used panel (projects, customer) reusing the recursive view.
4. **Spare-matrix server persistence** (`spare_matrices` +
   `bom_asset_spare_matrices`; migrate `spares.tsx` off localStorage)
   - this turns on the asset to spare-matrix "where-used" linkage.
5. **Downstream hooks**: BOM parts in item master surfaces, spare-matrix
   auto-fill from `bom_lines`, quote "pick from BOM".

Each phase is independently shippable and gate-clean (`npm run check /
build / verify / lint / test`).

---

## 10. Acceptance criteria (v1 = phases 1-2)

- [ ] Importing a multi-level source BOM creates one `bom_assets` row +
      N `bom_lines` preserving `seq_no`, `level`, `material`, `size`,
      `supplier_part_no`, `side`, `qty` (fractional).
- [ ] Every distinct part appears in `item_master` (`data_source =
      imported`) without clobbering operator-set fields; supplier part
      codes captured.
- [ ] `bill_of_materials` edges reflect the true level hierarchy;
      `v_bom_walk_recursive` explodes the asset correctly.
- [ ] Re-import replaces the asset's lines + re-derives, returns an
      added/removed/changed diff, and does not duplicate.
- [ ] Each import records the uploader (`uploaded_by`/`last_uploaded_by`)
      and writes a `bom_import_events` row; `approval_*` columns exist
      and default to `imported` (no gate).
- [ ] An asset can be linked to a project (`bom_asset_projects`) and the
      asset detail returns its project + customer where-used.
- [ ] At least the 4 Obara source layouts ingest correctly via built-in
      registry profiles; a tenant can add a new format as data.
- [ ] All §-repo gates green; new tables RLS-covered; new routes in
      RBAC matrix + audit.

---

## 11. Out of scope (v1)

- Server-side Excel/CSV parsing and OCR of drawings (parsing stays
  client-side; OCR is a later add).
- Spare-matrix scoring changes (it already consumes BOM + sales);
  only auto-fill sourcing from `bom_lines` is in phase 4.
- ERP-side BOM sync (push/pull BOMs to ERPs).
- Costing/where-used analytics beyond what `v_bom_walk_recursive`
  already provides.

---

## 12. Open questions for review

1. RBAC: is BOM import `admin`, or a softer `write` so engineers can
   author structures without full admin?
2. `item_type` default for imported parts - leave null, or map from
   level (top→`assembly`/`GUN`, leaf→`SPARE`/`COMPONENT`)? Tenant
   override via registry?
3. ~~Should `bom_assets` link to `installed_base.gun_model`?~~ Moot —
   `installed_base` was dropped (mig 177, not derivable); `bom_assets` stays independent.
4. Revision strategy: keep every revision as a distinct asset row
   (history), or overwrite in place? (Default proposed: keep, unique on
   `(asset_code, revision)`.)
5. Supplier part numbers: dedicated column on `bom_lines` (proposed) is
   enough for v1; do we also need a reusable `item_supplier_parts`
   mapping table parallel to `item_customer_parts`?
6. Approver workflow (future): confirm the `approval_status` states
   (`imported`/`pending_approval`/`approved`/`rejected`) and that v1
   only lays down the columns + `approve` scope without any gate.
7. Spare-matrix linkage requires server-persisting matrices (currently
   localStorage in `spares.tsx`). Confirm we do that as phase 4 (with a
   one-time localStorage to `spare_matrices` migration), gating the
   asset to spare-matrix where-used until then.
8. Project linkage cardinality: many-to-many via `bom_asset_projects`
   (proposed) vs a single `project_id` on the asset. M:N chosen so one
   gun model reused across projects is representable - confirm.
