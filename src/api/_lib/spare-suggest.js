// Spare-column suggestion: scan a set of BOM lines (across every gun in a matrix)
// and propose candidate spare-column headers, grouped by category. See
// spare_matrix/suggest_columns.js. Pure + testable.

import { classifyItemType } from "./spare-minmax.js";

// A word that starts a size / spec / quantity token -> stop the header there.
const SIZE_TOKEN = /\d|^(mm|cm|m|inch|")$/i;

// Leading level/seq numbering ("2 ", "2.1 ", "1) ", "-", "(3)") and any leading
// non-ASCII (CJK/Hangul/Kana) prefix, stripped so a hierarchical or localized
// assembly name — "2.齿轮箱 GEAR CASE ASSY", "① GEAR CASE ASSY", "기어 GEAR CASE
// ASSY" — groups as "GEAR CASE ASSY". Mirrors the client nameMatchCandidates so
// the "Suggest columns" scan detects the same spares the picker/auto-fill do.
const LEAD_NUMBERING = /^[\s\d.()\-_]+/;
const LEAD_NONASCII = /^[^\x20-\x7E]+/;
const stripLeadNoise = (s) =>
  String(s || "").replace(LEAD_NUMBERING, "").replace(LEAD_NONASCII, "").replace(LEAD_NUMBERING, "").trim();

// Derive a candidate column header from a BOM line: prefer the imported
// std_category (unless it is just a level number); else the leading (non-size)
// words of part_name, after stripping leading numbering / non-ASCII noise.
export const categoryOf = (line) => {
  const std = String((line && line.std_category) || "").trim();
  // A pure-numeric std_category ("2", "2.1") is a BOM LEVEL, not a category —
  // ignore it and derive from the name instead.
  if (std && !/^\d+(\.\d+)*$/.test(std)) return std.toUpperCase();
  const raw = String((line && line.part_name) || "").trim();
  if (!raw) return "";
  const name = stripLeadNoise(raw) || raw;   // if stripping empties it, keep raw
  const kept = [];
  for (const w of name.toUpperCase().split(/\s+/)) {
    if (SIZE_TOKEN.test(w)) break;   // stop at the first size/spec token
    kept.push(w);
    if (kept.length >= 3) break;
  }
  return kept.join(" ").trim();
};

// lines: [{ asset_id, part_no, part_name, std_category, is_spare }] across all guns.
// existingColNames: current spare_matrix_columns.col_name (case-insensitively suppressed).
export const suggestColumnsFromLines = (lines, existingColNames = []) => {
  const existing = new Set((existingColNames || []).map((c) => String(c || "").trim().toUpperCase()));
  const buckets = new Map(); // colName -> { colName, parts:Set, guns:Set, samples:[] }
  for (const l of (lines || [])) {
    const col = categoryOf(l);
    if (!col || existing.has(col)) continue;
    const b = buckets.get(col) || { colName: col, parts: new Set(), guns: new Set(), samples: [] };
    const pn = String((l && l.part_no) || "").trim();
    if (pn) b.parts.add(pn);
    if (l && l.asset_id) b.guns.add(l.asset_id);
    if (b.samples.length < 6) {
      const s = String((l && (l.part_name || l.part_no)) || "").trim();
      if (s && !b.samples.includes(s)) b.samples.push(s);
    }
    buckets.set(col, b);
  }
  return Array.from(buckets.values())
    .map((b) => ({
      col_name: b.colName,
      col_type: classifyItemType({ description: b.colName }) === "Consumable" ? "consumable" : "spare",
      gun_count: b.guns.size,
      part_count: b.parts.size,
      sample_parts: b.samples,
    }))
    .sort((a, b) => b.gun_count - a.gun_count || b.part_count - a.part_count)
    .slice(0, 40);
};
