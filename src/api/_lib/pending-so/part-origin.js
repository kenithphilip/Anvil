// Pending-Sales-Order data layer — Tally part/description split + local-vs-import
// origin classification. Pure + deterministic; no DB, no req/res.
//
// Two facts the "Pending Sales Order" tracker needs that Anvil does not model
// today, both encoded in strings the way Tally / Obara write them:
//
//   1. The line's Description column MUNGES the descriptive noun and the part
//      code the way Tally stores an item-master name, e.g.
//        "Electrode OID1292-I"          -> desc "Electrode",   part "OID1292-I"
//        "Transformer DB6-90-510 (O/C)" -> desc "Transformer",  part "DB6-90-510"
//        "Gear Case Assy C5E0069(O/C)"  -> desc "Gear Case Assy", part "C5E0069"
//      We must carry description and part number SEPARATELY.
//
//   2. The Obara origin convention:
//        - a "-I" suffix on the part  => LOCALLY made / assembled (India); its
//          Source PO is a WORK ORDER (reference prefix WOPOOI-…-OI); no in-transit.
//        - an "(O/x)" marker (O/C, O/J, O/K, O/T, O/F) => IMPORTED from the Obara
//          subsidiary in country x; its Source PO is a procurement PO
//          (OIPOOC/OIPOOJ/OIPOOK-…) with the full in-transit ladder.
//
// Code-shape detection is reused from the extraction splitter so the two paths
// agree on what a part code looks like; this module adds the (O/x) handling and
// the origin reconciliation the extraction path has no need for.

import { splitPartFromDescription, looksLikePartCode } from "../docai/part-split.js";

// Obara subsidiary country letter -> canonical vocabularies. `source_country`
// matches item_master.source_country / bom-format.js ("O-CHINA" etc.); `iso` is
// the ISO-3166-alpha-2 the ItemDetailDrawer / delays.isForeign path expects.
export const OBARA_COUNTRY = {
  C: { iso: "CN", source_country: "O-CHINA", name: "China" },
  J: { iso: "JP", source_country: "O-JAPAN", name: "Japan" },
  K: { iso: "KR", source_country: "O-KOREA", name: "Korea" },
  T: { iso: "TH", source_country: "O-THAILAND", name: "Thailand" },
  F: { iso: "FR", source_country: "O-FRANCE", name: "France" },
  I: { iso: "IN", source_country: "O-INDIA", name: "India" },
};
const INDIA = OBARA_COUNTRY.I;

// (O/C), ( O / K ), (O/c) — tolerant of spacing/case. Captures the letter.
const ORIGIN_MARKER_RE = /\(\s*O\s*\/\s*([CJKTFIcjktfi])\s*\)/;
// A part code carrying the local "-I" suffix (e.g. OID1292-I, TNA-16-04-25-1-I).
const LOCAL_SUFFIX_RE = /-I$/i;

// Source Po No prefix. WOPO = work order (local manufacturing); OIPO = Obara
// India PO. Both are followed by O<country-letter> (WOPOOI, OIPOOC, …).
const REF_RE = /^\s*(WOPO|OIPO)\s*O([CJKTFIcjktfi])/i;

const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
// A real Obara/Tally part code carries at least one digit (OID1292-I, DB6-90-510,
// C5E0069, TNA-16-04-25-1-I). This rejects code-SHAPED abbreviations the shared
// splitter would otherwise grab — notably "W/O" (without) in "Transformer W/O
// Terminal Block", or "C/W", which have no digit.
const hasDigit = (s) => /\d/.test(String(s || ""));

// ── 1. Split a Tally description into { part_no, description, origin_marker } ──
//
// origin_marker is the raw signal we found ("O/C" or "-I"), for provenance /
// reconciliation. Any field may be null (a pure service line like "Installation
// Charges" yields part_no=null and keeps the whole text as the description).
export const splitTallyPartDescription = (raw) => {
  const text = clean(raw);
  if (!text) return { part_no: null, description: null, origin_marker: null };

  // Peel an (O/x) marker first so it can't break code detection — it appears
  // both glued ("…C5E0069(O/C)") and spaced ("… (O/C)").
  let origin_marker = null;
  let cleaned = text;
  const m = text.match(ORIGIN_MARKER_RE);
  if (m) {
    origin_marker = "O/" + m[1].toUpperCase();
    cleaned = clean(text.slice(0, m.index) + " " + text.slice(m.index + m[0].length));
  }

  // Already a bare code (Part No cell that just happens to be munged elsewhere).
  if (looksLikePartCode(cleaned) && hasDigit(cleaned)) {
    return { part_no: cleaned, description: null, origin_marker: origin_marker || suffixMarker(cleaned) };
  }

  const split = splitPartFromDescription(cleaned);
  if (!split || !hasDigit(split.partNumber)) {
    // No real (digit-bearing) code — a service / charge line, a "W/O"-style
    // abbreviation, or a cell whose part number lives elsewhere. Keep the full
    // cleaned text as the description rather than surgically removing a word.
    return { part_no: null, description: cleaned || null, origin_marker };
  }
  return {
    part_no: split.partNumber,
    description: split.description,
    origin_marker: origin_marker || suffixMarker(split.partNumber),
  };
};

const suffixMarker = (partNo) => (LOCAL_SUFFIX_RE.test(String(partNo || "")) ? "-I" : null);

// ── 2. Classify a Source Po No reference ──────────────────────────────────────
// { source_kind, origin, country, source_country, ref_prefix } | null
export const classifySourcePoRef = (ref) => {
  const m = String(ref || "").match(REF_RE);
  if (!m) return null;
  const kind = m[1].toUpperCase();          // WOPO | OIPO
  const c = m[2].toUpperCase();             // country letter
  const country = OBARA_COUNTRY[c] || null;
  const ref_prefix = ("" + m[1] + "O" + m[2]).toUpperCase();
  if (kind === "WOPO") {
    // Work order: always locally manufactured, regardless of the trailing letter.
    return { source_kind: "work_order", origin: "local", country: INDIA.iso, source_country: INDIA.source_country, ref_prefix };
  }
  // OIPO: import from the subsidiary, unless the country is India (domestic buy).
  const domestic = c === "I";
  return {
    source_kind: domestic ? "procurement_po" : "import_po",
    origin: domestic ? "local" : "import",
    country: country ? country.iso : null,
    source_country: country ? country.source_country : null,
    ref_prefix,
  };
};

// Map a part-level marker ("-I" or "O/x") to an origin verdict.
const markerVerdict = (marker) => {
  if (!marker) return null;
  if (marker === "-I") return { origin: "local", country: INDIA.iso, source_country: INDIA.source_country };
  const m = marker.match(/^O\/([CJKTFI])$/i);
  if (!m) return null;
  const c = OBARA_COUNTRY[m[1].toUpperCase()];
  if (!c) return null;
  const local = c.iso === "IN";
  return { origin: local ? "local" : "import", country: c.iso, source_country: c.source_country };
};

// ── 3. Reconcile part-level + source-PO signals into one verdict ──────────────
//
// Inputs (any may be absent): { part_no, description, origin_marker, source_po_ref }.
// The Source PO reference is the operational truth, so it wins a conflict, but a
// disagreement is surfaced (conflict:true, confidence:"low") rather than hidden.
export const classifyOrigin = ({ part_no, description, origin_marker, source_po_ref } = {}) => {
  const marker = origin_marker || suffixMarker(part_no)
    || (description && (description.match(ORIGIN_MARKER_RE) ? "O/" + description.match(ORIGIN_MARKER_RE)[1].toUpperCase() : null));
  const a = markerVerdict(marker);                 // from the part / description
  const b = classifySourcePoRef(source_po_ref);    // from the Source Po No
  const signals = { part_suffix: suffixMarker(part_no), origin_marker: marker || null, ref_prefix: b ? b.ref_prefix : null };

  const base = { origin: "unknown", source_kind: null, country: null, source_country: null, conflict: false, signals };

  if (a && b) {
    const conflict = a.origin !== b.origin || (a.country && b.country && a.country !== b.country);
    // Source PO wins; carry its source_kind either way.
    return { ...base, origin: b.origin, source_kind: b.source_kind, country: b.country || a.country, source_country: b.source_country || a.source_country, conflict, confidence: conflict ? "low" : "high" };
  }
  if (b) return { ...base, origin: b.origin, source_kind: b.source_kind, country: b.country, source_country: b.source_country, confidence: "medium" };
  if (a) {
    // No PO ref: infer the likely source kind from the origin.
    return { ...base, origin: a.origin, source_kind: a.origin === "local" ? "work_order" : "import_po", country: a.country, source_country: a.source_country, confidence: "medium" };
  }
  return { ...base, confidence: "low" };
};

// Convenience: split a raw Tally description AND classify it in one call.
// Returns { part_no, description, origin } where origin is the classifyOrigin verdict.
export const resolveTallyLine = (rawDescription, sourcePoRef) => {
  const s = splitTallyPartDescription(rawDescription);
  const origin = classifyOrigin({ part_no: s.part_no, description: s.description, origin_marker: s.origin_marker, source_po_ref: sourcePoRef });
  return { part_no: s.part_no, description: s.description, origin };
};
