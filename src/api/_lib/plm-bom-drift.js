// Where the supplier's bill of materials stopped matching ours.
//
// plm_boms is the second write-only table in the PLM mirror: the sync builds a
// canonical tree for every assembly Windchill or Arena knows about, writes it
// on every cron tick, and nothing has ever read it. #501 gave plm_changes a
// consequence; this is the other half, and it is the more consequential one.
// An ECO is an announcement. A BOM revision is the structure itself changing —
// a child dropped upstream is a part we may still be buying, and a child added
// upstream is one we are not.
//
// Compares DIRECT CHILDREN only, deliberately.
//
// bill_of_materials is flat: one row per (parent, child), unique on that pair.
// The supplier's structure is nested. Comparing one level against the other is
// apples to apples; walking the supplier's whole tree against a table that
// does not store depth would either invent a hierarchy we do not have or
// report a sub-assembly's contents as missing from its grandparent. Deeper
// levels are their own parents, and get compared on their own terms when we
// hold a BOM for them.
//
// Pure. No I/O.

import { partKey } from "./plm-impact.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The supplier tree's immediate children, keyed and de-duplicated.
//
// A tree that lists the same child twice is one line with a summed quantity in
// every BOM convention worth honouring, and treating it as two would report a
// phantom qty mismatch against our single row.
export const directChildren = (structure) => {
  const kids = Array.isArray(structure?.children) ? structure.children : [];
  const byKey = new Map();
  for (const c of kids) {
    const key = partKey(c?.part_no);
    if (!key) continue;
    const qty = num(c?.qty);
    const prior = byKey.get(key);
    if (prior) {
      prior.qty = prior.qty == null || qty == null ? null : prior.qty + qty;
      continue;
    }
    byKey.set(key, { key, part_no: c.part_no, qty, uom: c?.uom ?? null, revision: c?.revision ?? null });
  }
  return [...byKey.values()];
};

// Our own rows for the same parent, in the same shape.
export const ourChildren = (rows) => {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = partKey(r?.child_part_no);
    if (!key || byKey.has(key)) continue;   // the unique index already forbids duplicates
    byKey.set(key, { key, part_no: r.child_part_no, qty: num(r?.qty), uom: r?.uom ?? null });
  }
  return [...byKey.values()];
};

// Is this supplier tree safe to compare at all?
//
// The pull is incremental: parts are filtered by LastModified while usage
// links are not, so a parent that was just revised arrives with its UNCHANGED
// children missing from the page. buildTree now counts what it could not
// resolve; a tree with any unresolved link, or one with no children at all
// while we hold some, is TRUNCATED rather than emptied — and reading it as
// authoritative turns "we were not sent this" into "the supplier deleted it".
//
// That distinction is the whole safety property here. A false "they dropped 12
// parts you are still buying" is worse than no alert: it is expensive, it is
// wrong, and it teaches the operator to ignore the next one.
export const comparable = (structure, ourKidsCount) => {
  const unresolved = Number(structure?.unresolved_children) || 0;
  if (unresolved > 0) return { ok: false, reason: "incomplete_structure", unresolved };
  const kids = Array.isArray(structure?.children) ? structure.children.length : 0;
  if (kids === 0 && ourKidsCount > 0) return { ok: false, reason: "empty_structure" };
  return { ok: true };
};

// The three ways a BOM drifts.
//
// Named from OUR side, because that is who reads it: `missing_from_ours` is a
// child the supplier has and we do not. Direction matters more than it looks —
// "added" and "removed" are ambiguous about whose BOM changed, and an operator
// reading an alert needs to know which list to go and edit.
export const compareBom = (supplierKids, ourKids, opts = {}) => {
  const tol = opts.qtyTolerance == null ? 0 : Number(opts.qtyTolerance);
  const ours = new Map((ourKids || []).map((c) => [c.key, c]));
  const theirs = new Map((supplierKids || []).map((c) => [c.key, c]));

  const missing_from_ours = [];
  const not_in_supplier = [];
  const qty_differs = [];

  for (const [key, t] of theirs) {
    const o = ours.get(key);
    if (!o) { missing_from_ours.push(t); continue; }
    // A quantity nobody stated is not a disagreement. Reporting one would put
    // a drift alert on every assembly whose bridge omitted a qty.
    if (t.qty == null || o.qty == null) continue;
    if (Math.abs(t.qty - o.qty) > tol) qty_differs.push({ ...t, our_qty: o.qty, supplier_qty: t.qty });
  }
  for (const [key, o] of ours) {
    if (!theirs.has(key)) not_in_supplier.push(o);
  }

  return {
    missing_from_ours,
    not_in_supplier,
    qty_differs,
    drifted: !!(missing_from_ours.length || not_in_supplier.length || qty_differs.length),
  };
};

// One line an operator can act on.
//
// Leads with the counts because that is the triage, then names parts — capped,
// because a notification is not a report and an assembly can have hundreds.
export const describeBomDrift = (parentPartNo, revision, drift, opts = {}) => {
  const cap = Math.max(1, Number(opts.maxParts) || 5);
  const list = (arr) => {
    const shown = arr.slice(0, cap).map((c) => c.part_no);
    const rest = arr.length - shown.length;
    return shown.join(", ") + (rest > 0 ? " and " + rest + " more" : "");
  };
  const bits = [];
  if (drift.missing_from_ours.length) bits.push(drift.missing_from_ours.length + " they have that we do not (" + list(drift.missing_from_ours) + ")");
  if (drift.not_in_supplier.length) bits.push(drift.not_in_supplier.length + " we have that they do not (" + list(drift.not_in_supplier) + ")");
  if (drift.qty_differs.length) {
    const q = drift.qty_differs.slice(0, cap).map((c) => c.part_no + " " + c.our_qty + "→" + c.supplier_qty);
    const rest = drift.qty_differs.length - q.length;
    bits.push(drift.qty_differs.length + " with a different quantity (" + q.join(", ") + (rest > 0 ? " and " + rest + " more" : "") + ")");
  }
  return parentPartNo + (revision ? " rev " + revision : "") + " — " + bits.join("; ");
};
