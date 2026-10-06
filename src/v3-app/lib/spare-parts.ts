// Helpers for a spare-matrix cell's part numbers. A cell holds one or more part
// numbers (auto-filled from the gun's BOM by matchSpares, newline-separated).
// The picker constrains entry to the gun's actual BOM parts; these functions
// parse/join the cell value and flag any part that isn't in the gun's BOM (an
// integrity signal for values typed before the picker existed).

export const normPart = (s: any): string => String(s == null ? "" : s).trim().toUpperCase();

// Split a cell value into distinct part numbers (tolerates newline OR comma).
export const parseParts = (value: any): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(value == null ? "" : value).split(/[\n,]/)) {
    const p = raw.trim();
    if (!p) continue;
    const k = normPart(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
};

// Cell storage format: newline-separated (matches matchSpares auto-fill output).
export const joinParts = (parts: string[]): string => (parts || []).map((p) => String(p).trim()).filter(Boolean).join("\n");

// Build the set of valid part numbers for a gun from its BOM lines.
export const bomPartSet = (lines: any[]): Set<string> => {
  const s = new Set<string>();
  for (const l of lines || []) {
    if (l?.part_no) s.add(normPart(l.part_no));
    if (l?.supplier_part_no) s.add(normPart(l.supplier_part_no));
  }
  return s;
};

// Which of a cell's parts are NOT in the gun's BOM (off-BOM → flag). An empty
// validSet (BOM not loaded / gun has no BOM) flags nothing, to avoid false alarms.
export const unknownParts = (parts: string[], validSet: Set<string>): string[] => {
  if (!validSet || validSet.size === 0) return [];
  return (parts || []).filter((p) => !validSet.has(normPart(p)));
};
