# Spare Matrix Creation Program: Iteration Requirements

## 1. Objective

Improve the existing Spare Matrix Creation Program with four changes:

1. Create separate matrix columns for distinct part numbers that share the same part name.
2. Standardize Excel export metadata headers.
3. Display Consumables before Spares.
4. Fix BOM column discovery so the Material column is available for selection when present and eligible.

Implement these changes incrementally. Inspect the existing codebase and preserve current functionality wherever possible. Do not rewrite the application or perform unrelated refactoring.

## 2. Requirement: Separate columns by unique part number

### Current behavior

Multiple part numbers with the same part name may appear in alternate rows within one matrix column.

### Expected behavior

Each unique part number must map to its own matrix column, even when multiple parts share the same name.

Example:

| ADAPTER-1 | ADAPTER-2 | ADAPTER-3 |
|---|---|---|
| PN-1001 | PN-1002 | PN-1003 |

### Functional requirements

- Use the normalized part name for grouping and the part number as the unique component identifier.
- Create one column per unique part number within the relevant part-name group.
- Repeated occurrences of the same part number must map to the same column throughout the matrix.
- Generate suffixes deterministically and consistently across all rows, stations, robots, guns, and BOM records.
- Do not merge different part numbers solely because their descriptions match.
- Handle missing part numbers explicitly; do not silently merge unidentified parts.
- Preserve quantities, material information, descriptions, and other associated attributes.
- Use the same part-to-column mapping for matrix generation, preview, and Excel export.
- If a part name has only one unique part number, retain the existing naming convention unless the application's standards require a suffix.
- If the same part number has inconsistent descriptions, flag the inconsistency for review rather than creating duplicate columns solely because descriptions differ.

### Design guidance and risks

Establish a global, deterministic mapping before populating the matrix. Do not assign suffixes independently for each row or BOM. Otherwise, a header such as `ADAPTER-1` could refer to different part numbers in different stations.

Use the part number as the identity key, with a clearly defined normalization policy. Avoid over-normalization that could merge genuinely different identifiers. Prefer a stable ordering rule, such as original BOM order or part-number order, and document it.

## 3. Requirement: Standardize Excel export headers

Use these exact metadata headers in this exact order:

1. `GUN NO.`
2. `LINE`
3. `STATION`
4. `ROBOT`
5. `GUN TYPE`
6. `ATDC/ATD`
7. `QTY`

### Functional requirements

- Preserve exact capitalization, spelling, punctuation, and order.
- Apply these labels to all applicable Excel export paths and worksheets.
- Map source fields to the export labels without renaming source BOM fields unnecessarily.
- Do not unintentionally rename generated part-specific headers such as `ADAPTER-1`.
- Keep exported data correctly aligned beneath the relevant headers.
- Preserve existing workbook formatting, formulas, and functionality where applicable.

### Acceptance criteria

- All seven headers match the labels above exactly.
- Headers appear in the specified order.
- No duplicate or unintended blank metadata headers are introduced.
- Data remains aligned with the correct headers.

## 4. Requirement: Sort Consumables before Spares

### Expected order

1. Consumables
2. Spares

### Functional requirements

- Use the existing part-classification logic.
- Place all Consumables columns before all Spare columns.
- Preserve relative order within each category wherever feasible.
- Keep the seven metadata columns fixed at the beginning in the specified order.
- Apply the same ordering to the UI preview and Excel export.
- Define an explicit fallback rule for uncategorized or unknown parts. Do not silently discard them.
- Rebuild or update dependent formulas and references if column order changes.

Conceptual pseudocode (adapt it to the existing codebase):

```python
CATEGORY_ORDER = {
    "CONSUMABLE": 1,
    "CONSUMABLES": 1,
    "SPARE": 2,
    "SPARES": 2,
}

sorted_parts = sorted(
    parts,
    key=lambda part: (
        CATEGORY_ORDER.get(normalize_category(part.category), 99),
        part.original_order,
        part.part_number,
    ),
)
```

This is illustrative only. Reuse the application's existing fields and normalization utilities where possible.

### Acceptance criteria

- Every Consumables column precedes every Spares column.
- Metadata columns remain in the specified order.
- Part data remains associated with the correct column after sorting.
- Preview and export use the same ordering.
- Uncategorized parts follow the documented fallback rule.

## 5. Requirement: Fix “Columns from BOM” selection and Material discovery

### Current issue

The Material column is not visible in the “Columns from BOM” selection interface.

### Investigation required

Trace the full workflow from workbook loading through header detection, filtering, UI rendering, matrix population, and export. Check for:

- Hardcoded column allowlists.
- Header capitalization or whitespace mismatches.
- Filters that remove technical, numeric, or optional fields.
- Incorrect worksheet or header-row detection.
- Duplicate-header handling.
- UI filtering, truncation, or incorrect field mapping.
- Differences between the discovered columns and the columns ultimately used by matrix generation.

### Functional requirements

- Make Material available for selection whenever it exists in the source BOM and meets the program's eligibility rules.
- Ensure that selecting Material maps the correct source values into the matrix.
- Preserve existing default selections and user selections where feasible.
- Handle optional columns without failing matrix generation.
- Provide understandable feedback when a field is missing, unsupported, or intentionally excluded.
- Prefer schema-driven column discovery over a restrictive hardcoded allowlist unless explicit business rules require restrictions.
- Normalize headers for matching while preserving original labels where appropriate.
- Do not assume that `Material`, `Material Number`, `Part Number`, and `Part Description` are interchangeable. Verify the source workbook schema.

### Acceptance criteria

- Material appears in “Columns from BOM” when present and eligible.
- Expected BOM columns appear in the selection list.
- Selecting a column maps to the correct source field.
- Optional or missing columns are handled predictably.
- Excluded columns have a clear explanation where appropriate.
- Existing selection behavior remains backward-compatible.

## 6. Engineering constraints

1. Inspect the repository, architecture, data model, and existing tests before editing.
2. Identify relevant modules and explain the intended changes before making modifications.
3. Reuse existing functions and abstractions wherever practical.
4. Establish one consistent mapping for part identities, generated columns, and column ordering.
5. Avoid unrelated refactoring and dependency changes.
6. Preserve workbook formatting, formulas, and supported functionality.
7. Add or update automated tests for all four requirements.
8. Include regression tests for existing behavior.
9. Do not claim tests passed unless they were actually executed.

## 7. Test scenarios

At minimum, test:

- Multiple distinct part numbers sharing the same part name.
- The same part number appearing in multiple BOM records, stations, robots, or guns.
- Similar names with different part numbers.
- Missing or blank part numbers.
- Inconsistent descriptions for the same part number.
- Stable suffix assignment across repeated runs.
- Exact metadata headers and order in the exported workbook.
- Consumables-first ordering and Spares-second ordering.
- Uncategorized parts and the documented fallback rule.
- Material present and selected in the BOM column interface.
- Material absent from a BOM.
- Header capitalization and whitespace variations.
- Optional columns and duplicate source headers.
- Consistency between UI preview and exported Excel output.
- Existing matrix generation, formatting, formulas, and export behavior.

## 8. Recommended implementation sequence

1. **Inspect existing logic:** Find BOM ingestion, column selection, classification, matrix generation, preview, and export modules. Establish the root cause of the missing Material field.
2. **Fix part identity and mapping:** Build a stable mapping from each unique part number to a generated matrix column.
3. **Apply shared ordering:** Sort part columns by category while keeping metadata columns fixed.
4. **Fix column discovery and headers:** Ensure Material is selectable when eligible and apply the exact seven export headers.
5. **Test and review:** Run focused tests and regression checks; compare preview and export outputs.

## 9. Deliverables

After implementation, provide:

1. A summary of the existing logic and the root cause of the Material column issue.
2. A list of modified files and the purpose of each change.
3. A summary of the part identity, naming, and sorting logic.
4. Tests added and the actual results of running them.
5. Remaining limitations, assumptions, or migration risks.
6. A sample output demonstrating the expected matrix structure.

Do not consider the task complete until the implementation, relevant tests, and regression checks have been reviewed.

## 10. Naming convention decision

The requested convention is sequential suffixes, for example:

- `ADAPTER-1` → PN-1001
- `ADAPTER-2` → PN-1002
- `ADAPTER-3` → PN-1003

Keep this convention if it matches the existing business requirement. To preserve traceability, ensure each column's part number is clearly visible in the matrix, ideally in a dedicated part-number row or header metadata. If the current matrix structure cannot support this safely, document the trade-off before changing the naming convention.

## Final implementation principle

Establish the unique part-to-column mapping first and reuse it everywhere. This is the key to preventing column misalignment, incorrect quantities, and inconsistent results between the matrix preview and Excel export.

---

## Appendix A: Implementation decisions (Anvil)

This appendix records how Anvil implements the requirements above. The requirements themselves are unchanged.

**One shared module.** `src/api/_lib/spare-matrix-columns.js` holds part identity, column naming, column order, the preview/export layout and BOM-field discovery. Matrix generation (Auto-fill), the worksheet grid, every export format and the Recommended-sheet recompute all use it.

**Identity.** Category names are grouped after trim, uppercase and collapsing internal spaces. Part numbers are trimmed only. Case, inner spaces and dashes stay significant. Part numbers that differ only in case or spacing stay separate and are flagged for review.

**Naming.** A category with one part number keeps its name (`ADAPTER`). A category with two or more distinct part numbers is split into `ADAPTER-1`, `ADAPTER-2` ... once, for the whole matrix. A split category stays split, so names stay stable. On a later run, existing columns keep their part number and suffix, and a new part number gets the next unused suffix. New suffixes follow the original BOM order (first matrix row that has the part, then its BOM line), then the part number. Part numbers found only in existing cells come after.

**Visibility.** A `PART NO.` row under the header shows the part number of each column, in the grid and in the export. A column that still holds several part numbers (a matrix saved before this change) shows them all and is marked.

**Missing and inconsistent data.** A BOM line that matches a category but has no part number is never placed in a column and never merged. It is listed in a review panel after Auto-fill. The same part number with different descriptions stays one column and is listed for review.

**Locked columns.** A category that has a locked column is left exactly as it is: no split and no fill.

**Order.** The 7 metadata columns come first, in the order of section 3. Part columns follow: Consumables, then Spares, then everything else. A column is a Consumable when its stored type is Consumable, or when its type is the default (Spare or blank) and its category is a consumable preset (the rule the matcher already uses for its copper filter). Any other type (kit, drawing, hardware, unknown) is the fallback class: it sorts after Spares and is never dropped. The relative order inside each class is kept. In Configure columns, a column can move only inside its class.

**Export.** Every export (XLSX, CSV, TSV) writes the 7 headers exactly, then `L-QTY`, `R-QTY` and `TIMER` (fields the worksheet already carried; kept so no data is lost), then the part columns, then the `PART NO.` row and any selected BOM-field rows. JSON keeps its old shape: one object per gun. The export writes values only; it had no formulas or styles before, so there is nothing to rebuild.

**Material and "Columns from BOM".** The panel now lists BOM fields as well as categories. The fields come from the keys the BOM lines actually carry, not from an allowlist. Original-header cells in `bom_lines.raw` are matched after normalising case, spaces, underscores and trailing punctuation, and the original labels are shown. Duplicate headers are listed; the first non-empty value is used. Part No., Qty and Level are excluded with the reason shown. Material, Material Number, Part Number and Description stay separate fields. A selected field becomes a header row under each part column, filled from the BOM lines of the matrix's guns. When Material is missing, the panel says why and lists the accepted headers. At BOM import, every built-in format now accepts the same material headers.

**Existing matrices.** A saved matrix loads exactly as stored; nothing is rewritten on read. The new model applies when Auto-fill runs. The split is lossless: every part number already in a category's cells moves to its own column, including manual part numbers that are in no BOM. Column order is a view rule; it is saved the next time the matrix is saved.

**Recommended Qty.** The description of a recommended row is the category (`ADAPTER`), not the split column name, so a split matrix produces the same rows as before and human edits and quote links carry over. Installed Qty is still the count of guns.

**Database.** No migration. The BOM-field selection is a per-matrix view setting stored in the browser, like hidden columns.
