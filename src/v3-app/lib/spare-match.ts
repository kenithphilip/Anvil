// Spare-matrix matching engine - faithful port of the standalone
// spare matrix logic (matchSpares + helpers). The "creation
// process" is: rows = guns, columns = named spare categories, and
// auto-fill matches each gun's BOM parts INTO each category column by
// part-name keyword + part-number pattern (+ copper-material filter for
// consumables). A cell holds the matched part number(s), newline-joined.
//
// Pure: feed it bom_lines ({ part_no, part_name, material, size }) +
// the category column names; it returns { colName: "pn1\npn2" }.

export interface SparePreset { name: string; category: string; }

// Named spare categories the user picks as matrix columns.
export const SPARE_PRESETS: SparePreset[] = [
  { name: "BUSH", category: "Spare" },
  { name: "ARM", category: "Spare" },
  { name: "ARM ASSY", category: "Spare" },
  { name: "ATTACH ASSY", category: "Spare" },
  { name: "BRACKET ASSY", category: "Spare" },
  { name: "COUPLER ASSY", category: "Spare" },
  { name: "DUST SEAL", category: "Spare" },
  { name: "FULCRUM PIN ASSY", category: "Spare" },
  { name: "GEAR CASE", category: "Spare" },
  { name: "GUN BODY ASSY", category: "Spare" },
  { name: "HARNESS ASSY", category: "Spare" },
  { name: "HINGE PIN ASSY", category: "Spare" },
  { name: "HOLDER BLOCK", category: "Spare" },
  { name: "INSUL ASSY", category: "Spare" },
  { name: "LINEAR BUSH", category: "Spare" },
  { name: "METAL SCRAPER", category: "Spare" },
  { name: "POINT HOLDER", category: "Spare" },
  { name: "ROBOT BRACKET", category: "Spare" },
  { name: "SCRAPER", category: "Spare" },
  { name: "TERMINAL", category: "Spare" },
  { name: "TR BOX ASSY", category: "Spare" },
  { name: "TRANSFORMER", category: "Spare" },
  { name: "ADAPTER", category: "Consumable" },
  { name: "HOLDER", category: "Consumable" },
  { name: "HOLDER BARREL", category: "Consumable" },
  { name: "SHANK", category: "Consumable" },
  { name: "SHUNT", category: "Consumable" },
  { name: "SHUNT ASSY", category: "Consumable" },
  { name: "TIP BASE", category: "Consumable" },
  { name: "TIP CAP", category: "Consumable" },
  { name: "TIP", category: "Consumable" },
  { name: "ELECTRODE", category: "Consumable" },
  // Reference "Guns Spare Matrix" variants (moving/fixed side). Auto-fill
  // matches these on their base category (see stripVariant); the operator
  // assigns which part is moving vs fixed.
  { name: "CAP TIP", category: "Consumable" },
  { name: "TIP BASE (MOVING)", category: "Consumable" },
  { name: "TIP BASE (FIXED)", category: "Consumable" },
  { name: "SHANK (MOVING)", category: "Consumable" },
  { name: "SHANK (FIXED)", category: "Consumable" },
  { name: "ADAPTER (MOVING)", category: "Consumable" },
  { name: "ADAPTER (FIXED)", category: "Consumable" },
  { name: "HOLDER (MOVING)", category: "Consumable" },
  { name: "HOLDER (FIXED)", category: "Consumable" },
  // Reference assemblies / spares.
  { name: "GUN BODY", category: "Spare" },
  { name: "LM GUIDE", category: "Spare" },
  { name: "MOVABLE YOKE", category: "Spare" },
  { name: "MOVABLE YOKE ASSY", category: "Spare" },
  { name: "GEAR CASE ASSY", category: "Spare" },
  { name: "SPATTER COVER", category: "Spare" },
  { name: "SPATTER COVER ASSY", category: "Spare" },
  { name: "STOPPER ASSY", category: "Spare" },
  { name: "PIPE ADAPTER", category: "Spare" },
  { name: "TEFLON HOSE", category: "Spare" },
  { name: "PLUG SILENCER", category: "Spare" },
  { name: "MANIFOLD ASSY", category: "Spare" },
  { name: "GUIDE ASSY", category: "Spare" },
  { name: "COUPLER", category: "Spare" },
  { name: "BELT", category: "Spare" },
  { name: "ATTACHMENT ASSY", category: "Spare" },
  { name: "BOLT", category: "Hardware" },
  { name: "WASHER", category: "Hardware" },
  { name: "NUT", category: "Hardware" },
  { name: "PIN", category: "Hardware" },
  { name: "KEY", category: "Hardware" },
  { name: "CIRCLIP", category: "Hardware" },
  { name: "O-RING", category: "Sealing" },
  { name: "OIL SEAL", category: "Sealing" },
  { name: "BEARING", category: "Motion" },
  { name: "BACKING PLATE", category: "Spare" },
];

// Part-number conventions that identify a spare type regardless of the
// BOM's language. Run alongside the name matcher.
export const PART_NO_PATTERNS: Record<string, RegExp[]> = {
  "TIP CAP": [/^T-?\d+-?[A-Z]?$/i, /^TC-?\d+/i],
  "TIP": [/^T-?\d+/i],
  "BACKING PLATE": [/^BG-?\d/i, /^BACK-?PLT/i],
  "ELECTRODE": [/^E-?\d/i, /^ELEC-/i],
  "O-RING": [/^OR-?\d/i, /^ORG-?\d/i, /^P-\d+$/i],
  "OIL SEAL": [/^OS-?\d/i],
  "BEARING": [/^B-?\d{4,}/i, /^BRG-/i, /^GB\/T\s*\d/i],
  "BUSH": [/^BU-?\d/i],
  "BOLT": [/^GB\/?T?\s*70-?85/i, /^M\d+\*?\d+$/i, /^HCS/i, /^SCREW/i],
  "WASHER": [/^GB\/?T?\s*9[35]-?85/i, /^WSH/i],
  "NUT": [/^GB\/?T?\s*6170/i, /^NUT/i],
  "PIN": [/^GB\/?T?\s*119/i, /^PN-?\d/i, /^PIN/i],
  "KEY": [/^GB\/?T?\s*1096/i, /^KEY/i],
  "CIRCLIP": [/^GB\/?T?\s*89[34]/i, /^CL-?\d/i],
};

// A part starting with a more-specific term (that has its own column)
// must not be counted in the broader parent column.
const COL_EXCLUSIONS: Record<string, string[]> = {
  "HOLDER": ["HOLDER BLOCK", "HOLDER BARREL", "POINT HOLDER"],
  "SHUNT": ["SHUNT ASSY"],
  "ARM": ["ARM ASSY"],
  "BUSH": ["LINEAR BUSH"],
  "GEAR CASE": ["GEAR CASE ASSY"],
  "GUN BODY": ["GUN BODY ASSY"],
  "MOVABLE YOKE": ["MOVABLE YOKE ASSY"],
  "SPATTER COVER": ["SPATTER COVER ASSY"],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Canonicalize every spelling of the assembly suffix to "ASSY" so a BOM part
// named "GEAR CASE ASSEMBLY", "GEAR CASE ASS'Y" (straight or curly apostrophe),
// or "GEAR CASE ASSY." all match the "GEAR CASE ASSY" column — while a plain
// "GEAR CASE" stays distinct (no suffix to canonicalize). Applied to both the
// part name and the column name before comparison, so the pair lines up.
export const normalizeAssy = (s: string): string =>
  String(s || "").replace(/\bASS(?:['’]?Y|EMBLY)\b\.?/gi, "ASSY");

// A category column may carry a moving/fixed (or LH/RH) qualifier, e.g.
// "SHANK (MOVING)" / "TIP BASE (FIXED)". BOM part names have no such
// qualifier, so strip it to match on the base category.
export const stripVariant = (col: string): string =>
  String(col || "")
    .replace(/\s*[([]\s*(?:MOVING|FIXED|MOV|FIX|LH|RH|LEFT|RIGHT)\s*[)\]]?\s*$/i, "")
    .replace(/\s*[-/]\s*(?:MOVING|FIXED|MOV|FIX|LH|RH|LEFT|RIGHT)\s*$/i, "")
    .trim();

export const isConsumableCol = (colName: string): boolean => {
  const base = stripVariant(colName);
  return SPARE_PRESETS.some((p) => p.category === "Consumable" && (p.name === colName || p.name === base));
};

export const isCopperMaterial = (mat?: string | null): boolean => {
  if (!mat) return false;
  const m = String(mat).toUpperCase().trim();
  if (m.includes("CU")) return true;
  if (/\bC1[01]\d+/.test(m)) return true;
  if (m.includes("BE14") || m.includes("BE25") || m.includes("BECU") || m.includes("BERYLLIUM") || /\bBE\d/.test(m)) return true;
  if (m.includes("CRCU") || m.includes("CR-CU") || m.includes("CHROMIUM COPPER")) return true;
  if (m.includes("COPPER")) return true;
  // Dispersion-strengthened / electrode-class coppers that carry neither "CU"
  // nor "COPPER" in the label.
  if (m.includes("GLIDCOP") || m.includes("RWMA")) return true;
  return false;
};

// Strip leading non-Latin (CJK etc.) + leading numbering so a name like
// "1.枪体Main Body Assy" can be matched as "Main Body Assy".
export const nameMatchCandidates = (rawName?: string | null): string[] => {
  const name = String(rawName || "").trim();
  if (!name) return [];
  const candidates = [name];
  const stripped = name.replace(/^[^\x20-\x7E]+/, "").trim();
  if (stripped && stripped !== name) candidates.push(stripped);
  const stripped2 = name.replace(/^[\d.\s\-_]+/, "").replace(/^[^\x20-\x7E]+/, "").trim();
  if (stripped2 && stripped2 !== stripped && stripped2 !== name) candidates.push(stripped2);
  return candidates;
};

const SPEC_UNIT_WORDS = new Set(["MM", "CM", "M", "DIA", "DEG", "INCH", "IN", "L", "R", "LH", "RH", "U", "D", "UP", "DN", "DOWN", "PCS", "SET"]);
const isSpecToken = (tok: string): boolean => {
  if (!tok) return true;
  if (/\d/.test(tok)) return true;
  if (tok.length === 1) return true;
  if (SPEC_UNIT_WORDS.has(tok.toUpperCase())) return true;
  if (/^[^A-Za-z]+$/.test(tok)) return true;
  return false;
};
const remainderIsSpecOnly = (remainder: string): boolean => {
  const toks = String(remainder || "").trim().split(/[\s\-_,/]+/).filter(Boolean);
  if (!toks.length) return true;
  return toks.every(isSpecToken);
};

// candidate starts with keyword at a word boundary AND the remainder is
// size/spec only (so "SHUNT COVER" does not match the "SHUNT" column).
export const nameIsCleanMatch = (candidate: string, keyword: string): boolean => {
  const c = normalizeAssy(String(candidate || "").trim());
  const kw = normalizeAssy(String(keyword || "").trim());
  if (!c || !kw) return false;
  if (c.length < kw.length) return false;
  if (c.slice(0, kw.length).toUpperCase() !== kw.toUpperCase()) return false;
  const after = c.slice(kw.length);
  if (after && !/^[\s\-_,/]/.test(after)) return false;
  return remainderIsSpecOnly(after);
};

export interface SpareBomItem { part_no?: string | null; part_name?: string | null; material?: string | null; size?: string | null; }

// matchSpares(bomItems, colNames, opts?) -> { colName: "pn1\npn2" }
// opts.skipMaterialFilter: don't require copper material for consumable columns
// (used by the column SCAN so a consumable category surfaces by name even when
// the BOM has no material data; auto-fill leaves it off so the copper filter
// still applies at fill time).
export const matchSpares = (
  bomItems: SpareBomItem[],
  colNames: string[],
  opts: { skipMaterialFilter?: boolean } = {},
): Record<string, string> => {
  const result: Record<string, string> = {};
  (colNames || []).forEach((col) => {
    const base = stripVariant(col);
    const colUp = base.toUpperCase().trim();
    const exclusions = (COL_EXCLUSIONS[colUp] || []).map((ex) => new RegExp("^" + escapeRe(ex) + "(?:\\s|$)", "i"));

    // Path A: clean name match (specificity-guarded, CJK-prefix aware).
    // Match on the BASE category so "SHANK (MOVING)"/"SHANK (FIXED)" both
    // pull shank candidates; the operator assigns which is moving vs fixed.
    let matches = (bomItems || []).filter((p) => {
      if (!p || !p.part_name) return false;
      const cands = nameMatchCandidates(p.part_name);
      if (!cands.some((c) => nameIsCleanMatch(c, base))) return false;
      // Exclusions compare the assembly-normalized candidate so a "GEAR CASE
      // ASSEMBLY"/"...ASS'Y" part is still kept out of the broad "GEAR CASE".
      if (cands.some((c) => exclusions.some((re) => re.test(normalizeAssy(c))))) return false;
      return true;
    });

    // Path B: part-number pattern (origin-agnostic)
    const patterns = PART_NO_PATTERNS[colUp];
    if (patterns && patterns.length) {
      const matchedKeys = new Set(matches.map((m) => m.part_no));
      (bomItems || []).forEach((p) => {
        if (!p || !p.part_no || matchedKeys.has(p.part_no)) return;
        const pn = String(p.part_no).trim();
        const sz = String(p.size || "").trim();
        if (patterns.some((re) => re.test(pn) || re.test(sz))) matches.push(p);
      });
    }

    // Consumable columns: only copper-type material — BUT keep parts whose
    // material is blank (legacy flat BOMs carry no material metadata; filtering
    // them out silently emptied cap-tip/shank/shunt/electrode columns). A
    // present, non-copper material still excludes the part. The column scan opts
    // out of the filter entirely (surfaces the category by name).
    if (!opts.skipMaterialFilter && isConsumableCol(col)) {
      matches = matches.filter((p) => !String(p.material || "").trim() || isCopperMaterial(p.material));
    }

    // dedup by part_no, preserve order
    const seen = new Set<string>();
    const dedup: SpareBomItem[] = [];
    matches.forEach((p) => { const k = String(p.part_no || ""); if (!k || seen.has(k)) return; seen.add(k); dedup.push(p); });

    result[col] = dedup.map((p) => p.part_no).join("\n");
  });
  return result;
};

// ------- Column scan (the "Suggest columns" engine) --------------------------
// Preset-aware discovery of spare columns from a set of guns' BOM lines. Uses
// the SAME matcher as auto-fill (so what's suggested is what auto-fill can
// populate): known presets first (GEAR CASE ASSY, ARM ASSY, TIP, …), then a
// generic category for anything left over. Copper parts are flagged as CRITICAL
// consumables even when their name matches no preset — those are the electrode-
// side wear parts an operator most needs to stock.

export interface SpareSuggestion {
  col_name: string;
  col_type: "spare" | "consumable";
  gun_count: number;
  part_count: number;
  sample_parts: string[];
}

// Generic category for a part that matched no preset: strip leading numbering /
// CJK, canonicalize the assembly suffix, keep the leading non-spec words. Never
// returns "" for a named part — so nothing is silently dropped from the scan.
const genericCategory = (partName?: string | null): string => {
  const cands = nameMatchCandidates(partName);
  const base = normalizeAssy(String((cands.length ? cands[cands.length - 1] : partName) || "").trim()).toUpperCase();
  if (!base) return "";
  const kept: string[] = [];
  for (const w of base.split(/\s+/)) {
    // Skip a leading size/side token (16MM / LH / RH …); stop at a trailing one.
    if (isSpecToken(w)) { if (kept.length) break; else continue; }
    kept.push(w);
    if (kept.length >= 4) break;
  }
  // Fallback: an all-size/side/CJK name still forms a bucket (pickable or
  // ignorable) rather than vanishing from the suggestions.
  return (kept.length ? kept.join(" ") : base.split(/\s+/).slice(0, 3).join(" ")).trim();
};

export const suggestSpareColumns = (
  perGun: Array<{ gun: string; lines: SpareBomItem[] }>,
  existing: string[] = [],
): SpareSuggestion[] => {
  const existingUp = new Set((existing || []).map((c) => stripVariant(String(c || "")).toUpperCase().trim()));
  // Suggest only BASE presets — skip the (MOVING)/(FIXED) side variants. Every
  // variant matches the same parts as its base (via stripVariant), so including
  // them surfaced three columns for one part (e.g. SHANK, SHANK (MOVING), SHANK
  // (FIXED)) — confusing. The operator adds a moving/fixed split by hand when a
  // gun actually needs both sides tracked separately.
  const presetNames = SPARE_PRESETS.filter((p) => stripVariant(p.name) === p.name).map((p) => p.name);
  const presetType = new Map(SPARE_PRESETS.map((p) => [p.name.toUpperCase(), p.category === "Consumable" ? "consumable" : "spare"] as const));

  type Bucket = { col: string; presetType?: "spare" | "consumable"; guns: Set<string>; parts: Set<string>; samples: string[]; anyCopper: boolean };
  const buckets = new Map<string, Bucket>();
  const bump = (col: string, ptype: "spare" | "consumable" | undefined, gun: string, partNo: string, sample: string, copper: boolean) => {
    const key = col.toUpperCase().trim();
    if (!key || existingUp.has(key)) return;
    const b = buckets.get(key) || { col, presetType: undefined, guns: new Set<string>(), parts: new Set<string>(), samples: [], anyCopper: false };
    if (ptype) b.presetType = ptype;
    b.guns.add(gun);
    if (partNo) b.parts.add(partNo);
    if (copper) b.anyCopper = true;
    if (b.samples.length < 6 && sample && !b.samples.includes(sample)) b.samples.push(sample);
    buckets.set(key, b);
  };

  for (const { gun, lines } of (perGun || [])) {
    const items = lines || [];
    const claimed = new Set<string>();
    // 1) preset-aware — match by name (copper filter OFF so consumable presets
    //    surface even without material data).
    const matched = matchSpares(items, presetNames, { skipMaterialFilter: true });
    for (const name of presetNames) {
      const v = matched[name];
      if (!v) continue;
      for (const pn of v.split("\n").filter(Boolean)) {
        claimed.add(pn);
        const ln = items.find((l) => l && l.part_no === pn);
        bump(name, presetType.get(name.toUpperCase()), gun, pn, (ln && ln.part_name) || pn, isCopperMaterial(ln && ln.material));
      }
    }
    // 2) generic + copper-critical for everything a preset didn't claim.
    for (const l of items) {
      if (!l || !l.part_no || claimed.has(l.part_no)) continue;
      const col = genericCategory(l.part_name);
      if (!col) continue;
      bump(col, undefined, gun, String(l.part_no), l.part_name || String(l.part_no), isCopperMaterial(l.material));
    }
  }

  return Array.from(buckets.values())
    .map((b) => {
      // Preset type wins; otherwise a copper part is a consumable (electrode-side
      // wear part), else a spare — so copper parts are never dropped or mistyped.
      const col_type: "spare" | "consumable" = b.presetType || (b.anyCopper ? "consumable" : "spare");
      return { col_name: b.col, col_type, gun_count: b.guns.size, part_count: b.parts.size, sample_parts: b.samples };
    })
    // EVERY category in any gun's BOM is returned — no cap. A rare part on a
    // single gun in a 100-gun matrix must still be selectable, so it can't be
    // dropped by a reach-ranked cutoff. The panel adds a search box to keep the
    // longer list navigable. Common parts first (quick pick), then alphabetical
    // so the long tail of one-off parts is scannable.
    .sort((a, b) => b.gun_count - a.gun_count || b.part_count - a.part_count || a.col_name.localeCompare(b.col_name));
};
