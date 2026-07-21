// CM PDM P0c: authoritative gun -> BOM asset link.
//
// A spare_matrix row identifies its gun by gun_no (free text) and carries a
// bom_asset_id FK (migration 159) that was never populated — every spare
// lookup resolved gun_no -> bom_assets.asset_code by STRING each time, a
// fragile join. This resolves gun_no to the canonical bom_assets.id once, at
// save, so the FK becomes the durable, authoritative link for spare resolution.

// Build asset_code(upper) -> bom_assets.id, preferring the BASE revision (''
// or null) so a gun with several drawing revisions resolves deterministically.
// Pure — exported for tests.
export const buildGunAssetMap = (assetRows) => {
  const chosen = new Map(); // code(upper) -> row
  for (const a of (Array.isArray(assetRows) ? assetRows : [])) {
    if (!a || !a.id) continue;
    const code = String(a.asset_code == null ? "" : a.asset_code).trim();
    if (!code) continue;
    const k = code.toUpperCase();
    const prev = chosen.get(k);
    const isBase = a.revision == null || a.revision === "";
    const prevIsBase = prev && (prev.revision == null || prev.revision === "");
    if (!prev || (isBase && !prevIsBase)) chosen.set(k, a);
  }
  const out = new Map();
  for (const [k, a] of chosen) out.set(k, a.id);
  return out;
};

// Resolve a set of gun_no strings to bom_asset ids. Best-effort: returns an
// empty map on any error so a save never fails on the enrichment.
export const resolveGunAssets = async (svc, tenantId, gunNos) => {
  const codes = [...new Set((gunNos || []).map((g) => String(g == null ? "" : g).trim()).filter(Boolean))];
  if (!codes.length) return new Map();
  try {
    const q = await svc.from("bom_assets")
      .select("id, asset_code, revision")
      .eq("tenant_id", tenantId)
      .in("asset_code", codes);
    if (q.error || !Array.isArray(q.data)) return new Map();
    return buildGunAssetMap(q.data);
  } catch (_) {
    return new Map();
  }
};
