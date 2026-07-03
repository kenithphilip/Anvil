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
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isConsumableCol = (colName: string): boolean =>
  SPARE_PRESETS.some((p) => p.category === "Consumable" && p.name === colName);

export const isCopperMaterial = (mat?: string | null): boolean => {
  if (!mat) return false;
  const m = String(mat).toUpperCase().trim();
  if (m.includes("CU")) return true;
  if (/\bC1[01]\d+/.test(m)) return true;
  if (m.includes("BE14") || m.includes("BE25") || m.includes("BECU") || m.includes("BERYLLIUM") || /\bBE\d/.test(m)) return true;
  if (m.includes("CRCU") || m.includes("CR-CU") || m.includes("CHROMIUM COPPER")) return true;
  if (m.includes("COPPER")) return true;
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
  const c = String(candidate || "").trim();
  const kw = String(keyword || "").trim();
  if (!c || !kw) return false;
  if (c.length < kw.length) return false;
  if (c.slice(0, kw.length).toUpperCase() !== kw.toUpperCase()) return false;
  const after = c.slice(kw.length);
  if (after && !/^[\s\-_,/]/.test(after)) return false;
  return remainderIsSpecOnly(after);
};

export interface SpareBomItem { part_no?: string | null; part_name?: string | null; material?: string | null; size?: string | null; }

// matchSpares(bomItems, colNames) -> { colName: "pn1\npn2" }
export const matchSpares = (bomItems: SpareBomItem[], colNames: string[]): Record<string, string> => {
  const result: Record<string, string> = {};
  (colNames || []).forEach((col) => {
    const colUp = String(col).toUpperCase().trim();
    const exclusions = (COL_EXCLUSIONS[colUp] || []).map((ex) => new RegExp("^" + escapeRe(ex) + "(?:\\s|$)", "i"));

    // Path A: clean name match (specificity-guarded, CJK-prefix aware)
    let matches = (bomItems || []).filter((p) => {
      if (!p || !p.part_name) return false;
      const cands = nameMatchCandidates(p.part_name);
      if (!cands.some((c) => nameIsCleanMatch(c, col))) return false;
      if (cands.some((c) => exclusions.some((re) => re.test(c)))) return false;
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

    // Consumable columns: only copper-type material
    if (isConsumableCol(col)) matches = matches.filter((p) => isCopperMaterial(p.material));

    // dedup by part_no, preserve order
    const seen = new Set<string>();
    const dedup: SpareBomItem[] = [];
    matches.forEach((p) => { const k = String(p.part_no || ""); if (!k || seen.has(k)) return; seen.add(k); dedup.push(p); });

    result[col] = dedup.map((p) => p.part_no).join("\n");
  });
  return result;
};
