// Pure filename -> gun matching for the bulk drawing-upload flow (gun_drawings,
// migration 197). No IO. The endpoint supplies the matrix's gun numbers + the
// declared batch kind; this classifies each file and decides how (or whether)
// it binds to a gun, leaving anything non-clean for the reviewer to correct.
//
// Kinds/formats:
//   eg_sheet   -> pdf            (filename is the gun number, sometimes + a suffix)
//   drawing_2d -> pdf | dwg
//   drawing_3d -> step           (a STEP file, or the endpoint may store a link)

// Extension -> normalised format.
const EXT_FORMAT = { pdf: "pdf", dwg: "dwg", dxf: "dwg", step: "step", stp: "step", stpz: "step" };

// Which formats a given artifact kind accepts.
export const KIND_FORMATS = {
  eg_sheet:   new Set(["pdf"]),
  drawing_2d: new Set(["pdf", "dwg"]),
  drawing_3d: new Set(["step"]),
};

export const extensionOf = (filename) => {
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(String(filename || "").trim());
  return m ? m[1].toLowerCase() : "";
};
export const formatOf = (filename) => EXT_FORMAT[extensionOf(filename)] || null;

const stripExt = (filename) => String(filename || "").trim().replace(/\.[A-Za-z0-9]+\s*$/, "").trim();

// Normalise a gun number for comparison: uppercase, trim, collapse internal
// whitespace. Deliberately CONSERVATIVE — gun ids can contain '-' / '.' / '_'
// that are significant, so those are NOT stripped here.
export const normGun = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
// Loose form for a last-resort fuzzy tier: also drop separators + spaces.
const looseGun = (s) => normGun(s).replace(/[\s._-]+/g, "");

// Trailing suffixes we try to peel off a filename stem to recover the gun no.
// Examples: "GUN12_EG", "GUN12-R1", "GUN12 (2)", "GUN12_2D", "GUN12 copy".
const SUFFIX_RE = /[\s._-]*(?:\(\d+\)|copy|final|rev\s*\d*|r\d+|v\d+|eg|ga|2d|3d|model|drawing|dwg|step)\s*$/i;

// Peel trailing suffix segments one at a time (bounded) so we can report which
// candidate stem actually matched. Index 0 is the full stem (no peel).
export const gunCandidates = (filename) => {
  const stem = stripExt(filename);
  const out = [stem];
  let cur = stem;
  for (let i = 0; i < 4; i++) {
    const next = cur.replace(SUFFIX_RE, "").trim();
    if (!next || next === cur) break;
    out.push(next);
    cur = next;
  }
  return out;
};

const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };

// Build a lookup from a list of gun rows ({ id, gun_no }).
export const buildGunIndex = (gunRows) => {
  const exact = new Map();   // normGun  -> [rows]
  const loose = new Map();   // looseGun -> [rows]
  for (const r of gunRows || []) {
    if (!r || !r.gun_no) continue;
    const k = normGun(r.gun_no);
    if (!k) continue;
    push(exact, k, r);
    push(loose, looseGun(r.gun_no), r);
  }
  return { exact, loose };
};

// Match ONE file to a gun. Returns { status, format, gun_no, row_id, detail }.
export const matchFile = (filename, kind, gunIndex) => {
  const format = formatOf(filename);
  const base = { format, gun_no: null, row_id: null };
  const detail = { parsed_stem: stripExt(filename), format };
  // 1. Format vs the declared batch kind.
  if (!format) return { ...base, status: "wrong_type", detail: { ...detail, reason: "unknown_extension" } };
  const allowed = KIND_FORMATS[kind];
  if (allowed && !allowed.has(format)) {
    return { ...base, status: "wrong_type", detail: { ...detail, reason: format + " not valid for " + kind } };
  }
  // 2. Gun match across suffix-peeled candidates (full stem first).
  const cands = gunCandidates(filename);
  for (let i = 0; i < cands.length; i++) {
    const hit = gunIndex.exact.get(normGun(cands[i]));
    if (hit && hit.length === 1) {
      return { format, status: i === 0 ? "matched" : "matched_suffix", gun_no: hit[0].gun_no, row_id: hit[0].id,
        detail: { ...detail, matched_stem: cands[i], suffix_stripped: i > 0 } };
    }
    if (hit && hit.length > 1) {
      return { ...base, status: "ambiguous", detail: { ...detail, candidates: hit.map((r) => r.gun_no) } };
    }
  }
  // 3. Loose fuzzy tier on the full stem only (avoid over-matching).
  const lhit = gunIndex.loose.get(looseGun(cands[0]));
  if (lhit && lhit.length === 1) {
    return { format, status: "matched_suffix", gun_no: lhit[0].gun_no, row_id: lhit[0].id,
      detail: { ...detail, matched_stem: cands[0], fuzzy: true } };
  }
  if (lhit && lhit.length > 1) {
    return { ...base, status: "ambiguous", detail: { ...detail, candidates: lhit.map((r) => r.gun_no) } };
  }
  return { ...base, status: "unmatched", detail: { ...detail, reason: "no gun matched" } };
};

// Match a whole batch, additionally flagging WITHIN-batch duplicate targets
// (two files landing on the same gun for this kind). Existing-COMMITTED
// duplicates are detected by the endpoint against the DB.
export const matchBatch = (files, kind, gunRows) => {
  const idx = buildGunIndex(gunRows);
  const results = (files || []).map((f) => ({ file: f, ...matchFile(f.filename || f.original_filename || "", kind, idx) }));
  const seen = new Map(); // normGun -> first index
  results.forEach((r, i) => {
    if ((r.status === "matched" || r.status === "matched_suffix") && r.gun_no) {
      const key = normGun(r.gun_no);
      if (seen.has(key)) {
        r.status = "duplicate";
        r.detail = { ...r.detail, duplicate_of_index: seen.get(key) };
      } else {
        seen.set(key, i);
      }
    }
  });
  return results;
};
