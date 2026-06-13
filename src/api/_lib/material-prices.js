// Resolve the current market reference price for a raw material
// (P3 raw-material price reference).
//
// Tries the raw_material_part_no first, then the grade/spec, returning
// the latest as_of reference for the requested uom (falling back to any
// uom if no exact match). Returns { unit_price, currency, source, as_of,
// uom } or null. Pure I/O helper — caller supplies the service client.

const latest = (rows) => {
  if (!rows || !rows.length) return null;
  return rows.slice().sort((a, b) => String(b.as_of).localeCompare(String(a.as_of)))[0];
};

export const resolveMaterialPrice = async (svc, tenantId, { partNo = null, grade = null, uom = null } = {}) => {
  if (!svc || !tenantId) return null;
  const tryKey = async (key) => {
    if (!key) return null;
    const r = await svc.from("material_price_references")
      .select("unit_price, currency, source, as_of, uom")
      .eq("tenant_id", tenantId)
      .eq("material_key", key);
    if (!r || r.error || !Array.isArray(r.data) || !r.data.length) return null;
    const rows = r.data;
    // Prefer the requested uom; otherwise take the latest of any uom.
    const matchUom = uom ? rows.filter((x) => x.uom === uom) : [];
    return latest(matchUom.length ? matchUom : rows);
  };
  return (await tryKey(partNo)) || (await tryKey(grade)) || null;
};
