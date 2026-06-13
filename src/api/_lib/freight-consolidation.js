// Freight consolidation engine (P4 logistics LCL/FCL bidding).
//
// Turns probability-driven procurement plans into shippable freight:
// group plans by origin lane + arrival week, sum weight/volume, and
// estimate the ocean container fill (how many 40ft / 20ft FCLs, plus an
// LCL remainder). Pure — no I/O; the endpoint supplies annotated plans.

// Usable ocean-container capacity (conservative working limits, not the
// theoretical max). Tune per tenant later if needed.
export const CONTAINER_CAP = {
  fcl_40: { kg: 26000, cbm: 67 },
  fcl_20: { kg: 21000, cbm: 33 },
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Estimate the container fill for a total weight + volume. Greedy: fill
// whole 40ft by the binding dimension, then decide the remainder — a
// 20ft if it would be >=60% full by either dimension, else LCL.
// Returns { fcl_40, fcl_20, lcl_cbm, lcl_kg, recommended_mode }.
export const estimateContainers = (weightKg, volumeCbm) => {
  const w = Math.max(0, Number(weightKg) || 0);
  const v = Math.max(0, Number(volumeCbm) || 0);
  if (w === 0 && v === 0) {
    return { fcl_40: 0, fcl_20: 0, lcl_cbm: 0, lcl_kg: 0, recommended_mode: "none" };
  }
  const fill40 = Math.max(w / CONTAINER_CAP.fcl_40.kg, v / CONTAINER_CAP.fcl_40.cbm);
  const fcl_40 = Math.floor(fill40);
  const leftW = Math.max(0, w - fcl_40 * CONTAINER_CAP.fcl_40.kg);
  const leftV = Math.max(0, v - fcl_40 * CONTAINER_CAP.fcl_40.cbm);
  const left20 = Math.max(leftW / CONTAINER_CAP.fcl_20.kg, leftV / CONTAINER_CAP.fcl_20.cbm);

  let fcl_20 = 0, lcl_cbm = 0, lcl_kg = 0;
  if (left20 >= 0.6) {
    fcl_20 = 1;
  } else if (left20 > 0) {
    lcl_cbm = round2(leftV);
    lcl_kg = round2(leftW);
  }
  const fcl = fcl_40 + fcl_20;
  const recommended_mode = fcl > 0 ? (lcl_cbm > 0 ? "mixed" : "FCL") : (lcl_cbm > 0 || lcl_kg > 0 ? "LCL" : "none");
  return { fcl_40, fcl_20, lcl_cbm, lcl_kg, recommended_mode };
};

// Group annotated procurement plans into consolidation candidates.
//
// plans: [{ id, part_no, qty, origin, window_week, weight_kg, volume_cbm }]
//   weight_kg / volume_cbm are PER-UNIT; the engine multiplies by qty.
// opts.destination: default destination lane (ISO-2 / port).
//
// Returns [{ origin, destination, window_week, weight_kg, volume_cbm,
//   containers, plan_ids, parts, missing_dims }] — one per
// (origin, window_week). missing_dims lists parts with no weight+volume.
export const consolidatePlans = (plans, opts = {}) => {
  const destination = opts.destination || "IN";
  const groups = new Map();
  for (const p of (plans || [])) {
    if (!p) continue;
    const origin = p.origin || "UNKNOWN";
    const week = p.window_week || null;
    if (!week) continue;
    const key = origin + "|" + week;
    let g = groups.get(key);
    if (!g) {
      g = { origin, destination, window_week: week, weight_kg: 0, volume_cbm: 0, plan_ids: [], parts: [], missing_dims: [] };
      groups.set(key, g);
    }
    const qty = Number(p.qty) || 0;
    const unitW = Number(p.weight_kg) || 0;
    const unitV = Number(p.volume_cbm) || 0;
    g.weight_kg += qty * unitW;
    g.volume_cbm += qty * unitV;
    if (p.id) g.plan_ids.push(p.id);
    g.parts.push({ part_no: p.part_no, qty });
    if (unitW === 0 && unitV === 0) g.missing_dims.push(p.part_no);
  }
  return Array.from(groups.values()).map((g) => ({
    ...g,
    weight_kg: round2(g.weight_kg),
    volume_cbm: round2(g.volume_cbm),
    containers: estimateContainers(g.weight_kg, g.volume_cbm),
  }));
};
