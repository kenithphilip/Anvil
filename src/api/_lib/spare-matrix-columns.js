// Spare matrix column model. ONE module for part identity, column naming,
// column order, the preview/export sheet layout and BOM-field discovery, so
// matrix generation, the worksheet preview, the Excel/CSV export and the
// Recommended-sheet recompute cannot disagree. Pure: no I/O, no React.
//
// Used by:
//   src/v3-app/lib/spare-match.ts          generateSpareMatrix (Auto-fill)
//   src/v3-app/screens/spares.tsx          preview grid, export, import
//   src/api/spare_matrix/recompute_recommended.js   Recommended grouping
//
// Spec: docs/SPARE_MATRIX_ITERATION.md (owner requirements + Appendix A).
//
// ── Identity policy ─────────────────────────────────────────────────────
// Group (category) names: trim, uppercase, collapse internal whitespace.
//   Used only to decide whether two names are the same group. A column keeps
//   its own spelling for display.
// Part numbers: trimmed only. Case, inner spaces and dashes are significant,
//   so "PN-1001" and "pn-1001" are two parts. Look-alikes are FLAGGED
//   (similar_part_no), never merged.
//
// ── Naming ──────────────────────────────────────────────────────────────
// A group with one part number keeps its name (ADAPTER). A group with two or
// more distinct part numbers is split into BASE-1, BASE-2 ... one column per
// part number, for the whole matrix (one global mapping, not per row). Once a
// group is split it stays split, so names stay stable. Existing members keep
// their part number and suffix; a new part number gets the next unused suffix
// (highest existing + 1). Order for NEW suffixes: original BOM order first
// (first matrix row that has it, then its BOM line), then part number. Part
// numbers found only in existing cells come after, in matrix row order.
//
// ── Missing / inconsistent data ─────────────────────────────────────────
// A BOM line that matches a group by name but has no part number is never
// placed in a column and never merged: it is returned as a no_part_no flag.
// The same part number with different descriptions stays ONE column and is
// returned as an inconsistent_description flag.
//
// ── Order ───────────────────────────────────────────────────────────────
// The 7 metadata columns are always first, in the owner's order. Part columns
// follow: Consumables, then Spares, then everything else (kit, drawing, any
// unknown type) as the explicit fallback. Nothing is dropped; the relative
// order inside each class is kept.

// The 7 export metadata headers, exact text and order (spec section 3).
export const META_COLUMNS = Object.freeze([
  Object.freeze({ key: "gun_no", header: "GUN NO." }),
  Object.freeze({ key: "line", header: "LINE" }),
  Object.freeze({ key: "station_no", header: "STATION" }),
  Object.freeze({ key: "robot_no", header: "ROBOT" }),
  Object.freeze({ key: "gun_type", header: "GUN TYPE" }),
  Object.freeze({ key: "atd", header: "ATDC/ATD" }),
  Object.freeze({ key: "qty", header: "QTY" }),
]);

// Row fields the worksheet already carried that are NOT in the owner's 7.
// Kept (never silently deleted) immediately after the 7 and before the part
// columns. Whether to keep them is an open owner question.
export const EXTRA_META_COLUMNS = Object.freeze([
  Object.freeze({ key: "l_qty", header: "L-QTY" }),
  Object.freeze({ key: "r_qty", header: "R-QTY" }),
  Object.freeze({ key: "timer", header: "TIMER" }),
]);

// Label of the header-metadata row that shows each column's part number.
export const PART_NO_ROW_LABEL = "PART NO.";

// ── identity ─────────────────────────────────────────────────────────────
const str = (v) => (v == null ? "" : String(v));

export const normGroupName = (s) => str(s).trim().replace(/\s+/g, " ").toUpperCase();
export const normPartNo = (s) => str(s).trim();

// Distinct part numbers in one cell. Cells are newline-separated (the
// matchSpares and recompute storage format). Trimmed, first-seen order.
export const cellPartNos = (value) => {
  const out = [];
  const seen = new Set();
  for (const raw of str(value).split(/\r?\n/)) {
    const pn = normPartNo(raw);
    if (!pn || seen.has(pn)) continue;
    seen.add(pn);
    out.push(pn);
  }
  return out;
};

// Distinct part numbers a column holds across all rows, in row order.
export const columnPartNos = (rows, colName) => {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const vals = (r && r.values && typeof r.values === "object") ? r.values : {};
    for (const pn of cellPartNos(vals[colName])) {
      if (seen.has(pn)) continue;
      seen.add(pn);
      out.push(pn);
    }
  }
  return out;
};

// ── naming ───────────────────────────────────────────────────────────────
const SPLIT_RX = /^(.*\S)-([1-9]\d*)$/;

export const splitColumnName = (base, n) => `${str(base).trim()}-${n}`;

// "ADAPTER-2" -> { base: "ADAPTER", n: 2 }. Shape only; whether the column is
// really a split member depends on its siblings (see columnGroupOf).
export const parseSplitName = (name) => {
  const m = SPLIT_RX.exec(str(name).trim());
  return m ? { base: m[1], n: Number(m[2]) } : null;
};

// The group (category) a column belongs to. "ADAPTER-2" is a member of
// "ADAPTER" only when the matrix also has a sibling ("ADAPTER-1") or the plain
// "ADAPTER" column, so a hand-made column that merely ends in "-<digits>" is
// never cut down. Any other column is its own group (its exact name).
export const columnGroupOf = (colName, allColNames) => {
  const p = parseSplitName(colName);
  if (!p) return colName;
  const key = normGroupName(p.base);
  const member = (allColNames || []).some((other) => {
    if (other === colName) return false;
    if (normGroupName(other) === key) return true;
    const q = parseSplitName(other);
    return !!q && normGroupName(q.base) === key && q.n !== p.n;
  });
  return member ? p.base : colName;
};

// Columns grouped by category, in first-appearance order.
//   [{ key, name, col_type, locked, members: [{ col, n }] }]
// name = the plain column's spelling when present, else the split base. It is
// what the matcher matches and what new split columns are named after.
export const spareColumnGroups = (cols) => {
  const list = Array.isArray(cols) ? cols.filter(Boolean) : [];
  const names = list.map((c) => c.col_name);
  const groups = new Map();
  list.forEach((c) => {
    const g = columnGroupOf(c.col_name, names);
    const p = parseSplitName(c.col_name);
    const n = (p && g !== c.col_name) ? p.n : null;
    const key = normGroupName(g);
    let grp = groups.get(key);
    if (!grp) {
      grp = { key, name: str(g).trim(), col_type: null, locked: false, members: [] };
      groups.set(key, grp);
    }
    grp.members.push({ col: c, n });
    if (c.locked) grp.locked = true;
  });
  for (const grp of groups.values()) {
    const plain = grp.members.find((m) => m.n == null);
    if (plain) grp.name = str(plain.col.col_name).trim();
    grp.col_type = (plain || grp.members[0]).col.col_type || null;
  }
  return Array.from(groups.values());
};

// ── order ────────────────────────────────────────────────────────────────
// Spec section 4. The stored column type is the existing classification
// (Configure columns / Columns from BOM). A column left at the default type
// (spare, or blank, which the worksheet treats as spare) whose category is a
// consumable preset counts as a Consumable, the same name rule the matcher
// uses for its copper filter (isConsumableCol, injected by the caller). Any
// other stored type is "other": it sorts after Spares and is never dropped.
export const CATEGORY_ORDER = Object.freeze({ CONSUMABLE: 1, CONSUMABLES: 1, SPARE: 2, SPARES: 2 });
export const FALLBACK_RANK = 3;
const CLASS_RANK = { consumable: 1, spare: 2, other: FALLBACK_RANK };

export const columnClass = (col, allColNames, isConsumableName) => {
  const t = normGroupName(col && (col.col_type != null ? col.col_type : col.category));
  if (CATEGORY_ORDER[t] === 1) return "consumable";
  if (t === "" || CATEGORY_ORDER[t] === 2) {
    const group = columnGroupOf(col && col.col_name, allColNames || []);
    if (typeof isConsumableName === "function" && isConsumableName(group)) return "consumable";
    return "spare";
  }
  return "other";
};

// Stable: Consumables, then Spares, then the fallback class; the current order
// is kept inside each class.
export const orderColumns = (cols, isConsumableName) => {
  const list = Array.isArray(cols) ? cols.filter(Boolean) : [];
  const names = list.map((c) => c.col_name);
  return list
    .map((c, i) => ({ c, i, r: CLASS_RANK[columnClass(c, names, isConsumableName)] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
};

// ── generation planner ───────────────────────────────────────────────────
// planSpareColumns({ cols, rows, matchesByRow, makeId })
//   cols          current matrix columns [{ id, col_name, col_type, locked }]
//   rows          current matrix rows [{ gun_no, values }] in matrix order
//   matchesByRow  per row (same index): null when the gun's BOM did not load,
//                 else { [groupKey]: [{ part_no, part_name, material, line }] }
//                 where line is the BOM line index. Build it with
//                 spareColumnGroups(cols) keys.
//   makeId        () => id for a new column
// Returns { cols, rows, filled, matchedGuns, emptyGuns, flags, splits }.
//
// Lossless: every part number already in a group's cells is re-homed into
// its own column, never dropped. A group with any locked column is frozen
// (no split, no fill), which extends "locked columns are skipped" to the
// whole category.
export const planSpareColumns = ({ cols, rows, matchesByRow, makeId } = {}) => {
  const colList = Array.isArray(cols) ? cols.filter(Boolean) : [];
  const rowList = Array.isArray(rows) ? rows : [];
  const groups = spareColumnGroups(colList);
  const flags = [];
  const splits = [];
  let filled = 0;
  let emptyGuns = 0;
  const matchedRows = new Set();

  rowList.forEach((_, i) => { if (!matchesByRow || !matchesByRow[i]) emptyGuns += 1; });

  // Copy-on-write row values, so an untouched row keeps its identity.
  const work = rowList.map((r) => ((r && r.values && typeof r.values === "object") ? r.values : {}));
  const copied = new Array(rowList.length).fill(false);
  const own = (i) => { if (!copied[i]) { work[i] = { ...work[i] }; copied[i] = true; } return work[i]; };
  const setCell = (i, name, value) => {
    const cur = work[i][name];
    if (value) {
      if (cur !== value) {
        own(i)[name] = value;
        filled += 1;
        if (matchesByRow && matchesByRow[i]) matchedRows.add(i);
      }
    } else if (Object.prototype.hasOwnProperty.call(work[i], name)) {
      delete own(i)[name];
    }
  };

  const usedNames = new Set(colList.map((c) => normGroupName(c.col_name)));
  const replanned = new Map();

  for (const g of groups) {
    if (g.locked) continue;

    // Universe: every part number the group has, from BOM matches and from
    // the cells it already holds.
    const uni = new Map();
    const at = (pn) => {
      let u = uni.get(pn);
      if (!u) {
        u = { pn, bom: null, cellRow: null, bomRows: new Set(), cellRows: new Set(), descs: new Map() };
        uni.set(pn, u);
      }
      return u;
    };
    rowList.forEach((r, i) => {
      for (const m of g.members) {
        for (const pn of cellPartNos(work[i][m.col.col_name])) {
          const u = at(pn);
          u.cellRows.add(i);
          if (u.cellRow == null) u.cellRow = i;
        }
      }
      const items = (matchesByRow && matchesByRow[i] && matchesByRow[i][g.key]) || [];
      items.forEach((it, j) => {
        const line = it && Number.isFinite(it.line) ? it.line : j;
        const pn = normPartNo(it && it.part_no);
        if (!pn) {
          flags.push({ kind: "no_part_no", group: g.name, gun_no: str(r && r.gun_no), description: str(it && it.part_name).trim(), line: line + 1 });
          return;
        }
        const u = at(pn);
        u.bomRows.add(i);
        if (!u.bom || i < u.bom[0] || (i === u.bom[0] && line < u.bom[1])) u.bom = [i, line];
        const d = str(it && it.part_name).trim();
        if (d && !u.descs.has(normGroupName(d))) u.descs.set(normGroupName(d), d);
      });
    });

    for (const u of uni.values()) {
      if (u.descs.size >= 2) flags.push({ kind: "inconsistent_description", group: g.name, part_no: u.pn, descriptions: Array.from(u.descs.values()) });
    }
    const lookAlike = new Map();
    for (const pn of uni.keys()) {
      const k = pn.toUpperCase().replace(/\s+/g, "");
      lookAlike.set(k, [...(lookAlike.get(k) || []), pn]);
    }
    for (const pns of lookAlike.values()) {
      if (pns.length >= 2) flags.push({ kind: "similar_part_no", group: g.name, part_nos: pns });
    }

    const splitMembers = g.members.filter((m) => m.n != null).sort((a, b) => a.n - b.n);
    const plainMembers = g.members.filter((m) => m.n == null);

    // One part number and never split: today's behaviour, unchanged.
    if (!splitMembers.length && uni.size <= 1) {
      const only = uni.size ? Array.from(uni.values())[0] : null;
      if (only) only.bomRows.forEach((i) => plainMembers.forEach((m) => setCell(i, m.col.col_name, only.pn)));
      continue;
    }
    // Nothing to place (no BOM data and empty cells): leave the columns alone
    // rather than treat them as orphans.
    if (!uni.size) continue;

    // Split: existing members keep the part number they hold most (ties go to
    // the earliest row); every other part number gets a new suffix.
    const claim = new Map();
    for (const m of splitMembers) {
      const counts = new Map();
      rowList.forEach((_, i) => {
        for (const pn of cellPartNos(work[i][m.col.col_name])) counts.set(pn, (counts.get(pn) || 0) + 1);
      });
      let best = null;
      let bestN = 0;
      for (const [pn, n] of counts) if (!claim.has(pn) && n > bestN) { best = pn; bestN = n; }
      if (best) claim.set(best, { col: m.col, n: m.n });
    }
    const rank = (u) => (u.bom ? [0, u.bom[0], u.bom[1]] : [1, u.cellRow == null ? Infinity : u.cellRow, 0]);
    const unclaimed = Array.from(uni.values()).filter((u) => !claim.has(u.pn)).sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      for (let k = 0; k < 3; k += 1) if (x[k] !== y[k]) return x[k] - y[k];
      return a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : 0;
    });
    let next = splitMembers.reduce((mx, m) => Math.max(mx, m.n), 0) + 1;
    const created = [];
    for (const u of unclaimed) {
      let name = splitColumnName(g.name, next);
      while (usedNames.has(normGroupName(name))) { next += 1; name = splitColumnName(g.name, next); }
      usedNames.add(normGroupName(name));
      const col = { id: typeof makeId === "function" ? makeId() : undefined, col_name: name, col_type: g.col_type || "spare", locked: false };
      claim.set(u.pn, { col, n: next });
      created.push(name);
      next += 1;
    }

    const finals = Array.from(claim.entries()).map(([pn, c]) => ({ pn, col: c.col, n: c.n })).sort((a, b) => a.n - b.n);
    const kept = new Set(finals.map((f) => f.col));
    const removed = g.members.map((m) => m.col).filter((c) => !kept.has(c));
    rowList.forEach((_, i) => {
      for (const f of finals) {
        const u = uni.get(f.pn);
        setCell(i, f.col.col_name, (u.bomRows.has(i) || u.cellRows.has(i)) ? f.pn : "");
      }
      for (const c of removed) setCell(i, c.col_name, "");
    });
    replanned.set(g.key, finals.map((f) => f.col));
    if (created.length || removed.length) {
      splits.push({ group: g.name, from: removed.map((c) => c.col_name), to: finals.map((f) => f.col.col_name), created });
    }
  }

  // Emit each replanned group at the position of its first column.
  const keyOf = new Map();
  for (const g of groups) for (const m of g.members) keyOf.set(m.col, g.key);
  const outCols = [];
  const emitted = new Set();
  for (const c of colList) {
    const key = keyOf.get(c);
    const plan = replanned.get(key);
    if (!plan) { outCols.push(c); continue; }
    if (emitted.has(key)) continue;
    emitted.add(key);
    outCols.push(...plan);
  }

  const outRows = rowList.map((r, i) => (copied[i] ? { ...(r || {}), values: work[i] } : r));
  return { cols: outCols, rows: outRows, filled, matchedGuns: matchedRows.size, emptyGuns, flags, splits };
};

// ── preview / export layout ──────────────────────────────────────────────
// buildSheetLayout({ cols, rows, isConsumableName, attributes })
//   attributes  selected BOM fields shown as header rows under each part
//               column: [{ key, label, byPart: Map(part_no -> string[]) }]
// The worksheet grid renders this layout and the export writes
// layoutToAoa(layout, rows), so the preview and the file cannot disagree.
export const buildSheetLayout = ({ cols, rows, isConsumableName, attributes } = {}) => {
  const rowList = Array.isArray(rows) ? rows : [];
  const ordered = orderColumns(cols, isConsumableName);
  const names = ordered.map((c) => c.col_name);
  const attrs = (attributes || []).filter((a) => a && a.key);
  const partColumns = ordered.map((col) => {
    const part_nos = columnPartNos(rowList, col.col_name);
    const attrValues = {};
    for (const a of attrs) {
      const vals = [];
      const seen = new Set();
      for (const pn of part_nos) {
        for (const v of (a.byPart && a.byPart.get(pn)) || []) {
          if (!seen.has(v)) { seen.add(v); vals.push(v); }
        }
      }
      attrValues[a.key] = vals.join(" / ");
    }
    return {
      col,
      header: col.col_name,
      group: columnGroupOf(col.col_name, names),
      cls: columnClass(col, names, isConsumableName),
      part_nos,
      part_no_label: part_nos.join("\n"),
      attrs: attrValues,
    };
  });
  return {
    metaColumns: [...META_COLUMNS, ...EXTRA_META_COLUMNS],
    metaRows: [{ key: "part_no", label: PART_NO_ROW_LABEL }, ...attrs.map((a) => ({ key: a.key, label: normGroupName(a.label || a.key) }))],
    partColumns,
  };
};

const metaCell = (r, key) => (r && r[key] != null ? r[key] : "");

// Array-of-arrays: header row, header-metadata rows (PART NO., then any
// selected BOM fields), then one row per gun. The metadata-row label sits in
// the GUN NO. column. metaRows:false drops them (JSON export).
export const layoutToAoa = (layout, rows, { metaRows = true } = {}) => {
  const metaCols = layout.metaColumns;
  const headers = [...metaCols.map((m) => m.header), ...layout.partColumns.map((p) => p.header)];
  const meta = metaRows
    ? layout.metaRows.map((mr) => [
      mr.label,
      ...metaCols.slice(1).map(() => ""),
      ...layout.partColumns.map((p) => (mr.key === "part_no" ? p.part_no_label : (p.attrs[mr.key] || ""))),
    ])
    : [];
  const body = (Array.isArray(rows) ? rows : []).map((r) => {
    const vals = (r && r.values && typeof r.values === "object") ? r.values : {};
    return [...metaCols.map((m) => metaCell(r, m.key)), ...layout.partColumns.map((p) => (vals[p.header] != null ? vals[p.header] : ""))];
  });
  return [headers, ...meta, ...body];
};

// ── BOM field discovery ("Columns from BOM") ─────────────────────────────
// Schema-driven: the fields come from the keys the BOM lines actually carry
// (bom_lines columns, plus the original-header cells in line.raw when the
// import stored them), not from a fixed allowlist. Headers are matched after
// normHeader (case, spaces, underscores, trailing ":" or "."), and the
// original labels are kept for display. Material, Material Number, Part
// Number and Description are different fields and are never merged.
export const normHeader = (s) => str(s).replace(/[\s_]+/g, " ").trim().toLowerCase().replace(/[:.]+$/, "").trim();

// Known part attributes. aliases match normalised source headers.
export const BOM_FIELD_RULES = Object.freeze([
  { key: "material", label: "Material", aliases: ["material", "mat", "mat'l", "mat’l", "matl", "material grade", "material spec", "material specification"] },
  { key: "part_name", label: "Description", aliases: ["part name", "description", "part description", "item name", "desc"] },
  { key: "size", label: "Size", aliases: ["size", "dimension"] },
  { key: "supplier_part_no", label: "Supplier P/N", aliases: ["supplier part no", "supplier part", "vendor part", "mpn"] },
  { key: "uom", label: "UOM", aliases: ["uom", "unit"] },
  { key: "std_category", label: "Category", aliases: ["std category", "category", "std"] },
  { key: "side", label: "Side", aliases: ["side", "lh/rh"] },
  { key: "is_spare", label: "Spare?", aliases: ["is spare", "spare"] },
  { key: "remarks", label: "Remarks", aliases: ["remarks", "remark", "note", "notes"] },
  { key: "balloon_no", label: "Balloon No.", aliases: ["balloon no", "balloon"] },
  { key: "find_no", label: "Find No.", aliases: ["find no", "find number"] },
]);

// Excluded on purpose, with the reason shown to the operator. internal ones
// are database bookkeeping and are not listed in the UI.
const EXCLUDED_RULES = [
  { label: "Part No.", reason: "Part numbers are already the matrix cells and the PART NO. row.", keys: ["part no", "part number", "child part no", "child item", "child"] },
  { label: "Qty", reason: "BOM quantity is per gun. Matrix cells hold part numbers, never quantities.", keys: ["qty", "quantity", "q'ty"] },
  { label: "Level", reason: "Assembly structure, not a part attribute.", keys: ["level", "hierarchy level", "parent line id", "parent part no", "parent"] },
  { label: "Internal", reason: "Internal record field.", internal: true, keys: ["id", "tenant id", "asset id", "supplier id", "seq no", "created at", "updated at"] },
];

const RULE_BY_HEADER = new Map();
for (const r of BOM_FIELD_RULES) for (const a of [r.key, ...r.aliases]) RULE_BY_HEADER.set(normHeader(a), r);
const EXCLUDED_BY_HEADER = new Map();
for (const r of EXCLUDED_RULES) for (const k of r.keys) EXCLUDED_BY_HEADER.set(normHeader(k), r);

const scalarText = (v) => {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Y" : "N";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v.trim();
  return null; // object / array: not a simple value
};

const prettyLabel = (key) => str(key).replace(/[_\s]+/g, " ").trim().replace(/\b\w/g, (ch) => ch.toUpperCase());

// Every (field, value) one BOM line offers, canonical keys first, then the
// original-header cells in line.raw. Shared by discovery and value lookup so
// the list and the values cannot disagree.
const lineEntries = (line) => {
  const out = [];
  if (!line || typeof line !== "object") return out;
  for (const [k, v] of Object.entries(line)) {
    if (k === "raw") continue;
    out.push({ header: k, value: v, fromRaw: false });
  }
  if (line.raw && typeof line.raw === "object" && !Array.isArray(line.raw)) {
    for (const [k, v] of Object.entries(line.raw)) out.push({ header: k, value: v, fromRaw: true });
  }
  return out.map((e) => {
    const n = normHeader(e.header);
    const ex = EXCLUDED_BY_HEADER.get(n);
    const rule = RULE_BY_HEADER.get(n);
    const key = rule ? rule.key : (e.fromRaw ? "raw:" + n : e.header);
    return { ...e, n, ex, rule, key };
  });
};

// discoverBomFields(lines) -> { fields, unavailable, excluded }
//   fields       eligible, present (at least one value): [{ key, label,
//                source_labels, count, samples, duplicate_headers }]
//   unavailable  known attributes with no value in these lines: [{ key, label, reason }]
//   excluded     fields left out on purpose: [{ key, label, reason }]
export const discoverBomFields = (lines) => {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const fields = new Map();
  const excluded = new Map();
  const nonScalar = new Map();
  for (const line of list) {
    const firstLabel = new Map(); // normalised header -> first original label in THIS line
    for (const e of lineEntries(line)) {
      if (!e.n) continue;
      if (e.ex) {
        if (!e.ex.internal && !excluded.has(e.ex.label)) excluded.set(e.ex.label, { key: e.header, label: e.ex.label, reason: e.ex.reason });
        continue;
      }
      const text = scalarText(e.value);
      if (text === null) {
        if (!nonScalar.has(e.key)) nonScalar.set(e.key, { key: e.key, label: prettyLabel(e.header), reason: "Not a simple value, so it cannot be shown in one cell." });
        continue;
      }
      let f = fields.get(e.key);
      if (!f) {
        f = { key: e.key, label: e.rule ? e.rule.label : (e.fromRaw ? str(e.header).trim() : prettyLabel(e.header)), source_labels: [], count: 0, samples: [], duplicate_headers: false, order: e.rule ? BOM_FIELD_RULES.indexOf(e.rule) : 1000 + fields.size, _lines: new Set() };
        fields.set(e.key, f);
      }
      const label = e.fromRaw ? str(e.header).trim() : e.header;
      if (!f.source_labels.includes(label)) f.source_labels.push(label);
      const seenKey = e.key;
      if (e.fromRaw && firstLabel.has(seenKey) && firstLabel.get(seenKey) !== e.header) f.duplicate_headers = true;
      if (e.fromRaw && !firstLabel.has(seenKey)) firstLabel.set(seenKey, e.header);
      if (text && !f._lines.has(line)) {
        f._lines.add(line);
        f.count += 1;
        if (f.samples.length < 4 && !f.samples.includes(text)) f.samples.push(text);
      }
    }
  }
  const all = Array.from(fields.values()).sort((a, b) => a.order - b.order);
  const present = all.filter((f) => f.count > 0).map(({ _lines, order: _order, ...rest }) => rest);
  const presentKeys = new Set(present.map((f) => f.key));
  const unavailable = BOM_FIELD_RULES
    .filter((r) => !presentKeys.has(r.key))
    .map((r) => ({ key: r.key, label: r.label, reason: list.length ? "No line in these BOMs carries a value for it." : "No BOM lines loaded." }));
  return { fields: present, unavailable, excluded: [...excluded.values(), ...nonScalar.values()] };
};

// The value of one discovered field on one line: the canonical column first,
// then the first non-empty original-header cell that maps to it.
export const bomFieldValue = (line, fieldKey) => {
  for (const e of lineEntries(line)) {
    if (e.ex || e.key !== fieldKey) continue;
    const text = scalarText(e.value);
    if (text) return text;
  }
  return "";
};

// { [fieldKey]: Map(part_no -> distinct values) } over many BOM lines.
export const bomFieldIndex = (lines, fieldKeys) => {
  const out = {};
  for (const key of fieldKeys || []) out[key] = new Map();
  for (const line of lines || []) {
    const pn = normPartNo(line && line.part_no);
    if (!pn) continue;
    for (const key of fieldKeys || []) {
      const v = bomFieldValue(line, key);
      if (!v) continue;
      const arr = out[key].get(pn) || [];
      if (!arr.includes(v)) arr.push(v);
      out[key].set(pn, arr);
    }
  }
  return out;
};
