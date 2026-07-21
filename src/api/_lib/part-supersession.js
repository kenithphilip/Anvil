// CM PDM P0b: obsolete-part supersession.
//
// obsolete_parts(part_no -> replacement_part_no) records that a part has been
// superseded. Today nothing consults it, so a spare that was rerouted by the
// manufacturer to a newer part still gets quoted/ordered as the OBSOLETE part.
// resolveReplacement follows the supersession chain to the terminal ACTIVE part
// so an order never lands on a discontinued one. Cycle- and depth-guarded.

const MAX_HOPS = 8;

// Load a tenant's part_no -> replacement_part_no map (only rows that actually
// name a replacement). We load the whole (small) table so transitive hops
// (A superseded by B superseded by C) resolve. Best-effort: any error yields an
// empty map so supersession simply no-ops rather than breaking a quote.
export const loadSupersessionMap = async (svc, tenantId) => {
  const map = new Map();
  try {
    const q = await svc.from("obsolete_parts")
      .select("part_no, replacement_part_no")
      .eq("tenant_id", tenantId)
      .not("replacement_part_no", "is", null);
    if (!q.error && Array.isArray(q.data)) {
      for (const r of q.data) {
        const from = String(r.part_no == null ? "" : r.part_no).trim();
        const to = String(r.replacement_part_no == null ? "" : r.replacement_part_no).trim();
        if (from && to && from !== to) map.set(from, to);
      }
    }
  } catch (_) { /* best-effort */ }
  return map;
};

// Follow the supersession chain from partNo to the terminal active part.
// Returns { part_no (active), superseded, from?, chain }.
export const resolveReplacement = (map, partNo) => {
  const start = partNo == null ? null : String(partNo).trim();
  if (!start || !(map instanceof Map) || !map.size) {
    return { part_no: start, superseded: false, chain: start ? [start] : [] };
  }
  const chain = [start];
  const seen = new Set([start]);
  let cur = start;
  for (let i = 0; i < MAX_HOPS; i++) {
    const next = map.get(cur);
    if (!next || seen.has(next)) break;   // no further replacement, or a cycle
    chain.push(next);
    seen.add(next);
    cur = next;
  }
  const active = chain[chain.length - 1];
  return active === start
    ? { part_no: start, superseded: false, chain }
    : { part_no: active, superseded: true, from: start, chain };
};

// Resolve each { part_no } row to its active replacement, aligned by index.
export const applySupersession = (rows, map) =>
  (Array.isArray(rows) ? rows : []).map((r) => resolveReplacement(map, r && r.part_no));
