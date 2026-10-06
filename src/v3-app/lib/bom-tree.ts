// Turn a flat, seq-ordered list of BOM lines (bom_lines) into an expandable
// assembly tree using the `level` column (1 = top; null/0 treated as 1). A line
// at level N is a child of the nearest preceding line at level < N, and has
// children when the next line (by seq order) is deeper. Flat BOMs (no depth
// changes) yield no children and render as a plain list.

export interface BomNode {
  line: any;
  idx: number;
  level: number;
  hasChildren: boolean;
}

const lvlOf = (l: any): number => (Number(l?.level) > 0 ? Number(l.level) : 1);

export const buildBomNodes = (lines: any[]): BomNode[] =>
  (lines || []).map((l, i) => {
    const level = lvlOf(l);
    const nextLevel = i + 1 < lines.length ? lvlOf(lines[i + 1]) : 0;
    return { line: l, idx: i, level, hasChildren: nextLevel > level };
  });

export const isHierarchicalBom = (nodes: BomNode[]): boolean => nodes.some((n) => n.hasChildren);

// Indices of every sub-assembly (a node that has children) — the default
// collapsed set, so the tree opens at its top level and the operator drills in.
export const collapsedAssemblies = (nodes: BomNode[]): Set<number> =>
  new Set(nodes.filter((n) => n.hasChildren).map((n) => n.idx));

// The nodes to render given a set of collapsed indices: hide any node deeper
// than an active collapsed ancestor. Single pass over the seq-ordered nodes — a
// collapsed ancestor hides its whole subtree (including nested assemblies).
export const visibleBomNodes = (nodes: BomNode[], collapsed: Set<number>): BomNode[] => {
  const out: BomNode[] = [];
  let hideBelow = Infinity;
  for (const n of nodes) {
    if (n.level > hideBelow) continue;   // deeper than a collapsed ancestor → hidden
    hideBelow = Infinity;                 // back at/above the collapse point
    out.push(n);
    if (collapsed.has(n.idx) && n.hasChildren) hideBelow = n.level;
  }
  return out;
};
